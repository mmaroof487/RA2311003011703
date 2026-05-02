# Notification System Design

## Stage 1: REST API Design

Six endpoints cover the core notification lifecycle.

`GET /notifications` — returns all notifications for the student as a JSON array. Each object has `id` (UUID), `type` (Placement | Result | Event), `message`, `createdAt` (ISO 8601), and `isRead`. Supports `?page=1&limit=20` pagination; defaults to page 1, 20 per page.

`GET /notifications/unread/count` — returns `{ "count": N }` without loading full notification objects. Useful for badge counts in a UI where you only need the number.

`PATCH /notifications/:id/read` — marks one notification read. Empty body, returns 204. Returns 404 if the ID doesn't exist or belongs to a different student.

`PATCH /notifications/read-all` — bulk mark-all-read in one call. Returns 204. Atomic at the application layer.

`DELETE /notifications/:id` — soft delete by setting `deletedAt` rather than physically removing the row. Returns 204 on success, 404 if not found. Keeping the row allows audit trails and makes accidental deletes recoverable.

All endpoints require `Authorization: Bearer <token>`. Non-204 responses are always `application/json`.

**Real-time delivery:** Server-Sent Events (SSE) via `GET /notifications/stream`. SSE is a better fit here than WebSockets because notifications only flow server → client. SSE uses plain HTTP/1.1, needs no upgrade handshake, and has built-in reconnection — no extra infrastructure or proxy config required. Event format: `data: { "id": "uuid", "type": "Placement", "message": "..." }\n\n`.

---

## Stage 2: Persistent Storage

PostgreSQL fits this problem well — structured relational data, enum types, composite indexing, and it handles the expected write volume without anything exotic.

Three tables:

```sql
CREATE TYPE notification_type AS ENUM ('Placement', 'Result', 'Event');

CREATE TABLE students (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  createdAt  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       notification_type NOT NULL,
  message    TEXT NOT NULL,
  createdAt  TIMESTAMPTZ DEFAULT NOW(),
  deletedAt  TIMESTAMPTZ        -- NULL means active
);

CREATE TABLE student_notifications (
  studentID        INT REFERENCES students(id) ON DELETE CASCADE,
  notificationID   UUID REFERENCES notifications(id) ON DELETE CASCADE,
  isRead           BOOLEAN DEFAULT false,
  readAt           TIMESTAMPTZ,
  PRIMARY KEY (studentID, notificationID)
);
```

`notifications` is shared across all students; `student_notifications` is the per-student state (read/unread). This avoids duplicating notification content 50,000 times when broadcasting.

**Where this breaks down at scale:** At 50k students × 100 notifications each, `student_notifications` hits 5M rows. Unread queries slow down without proper indexes. Bulk inserts during a broadcast block the connection pool. Fixes: partial composite index on `(studentID, isRead, createdAt DESC) WHERE isRead = false` for unread queries; monthly range partitioning on `student_notifications` to keep the hot partition small; archive read rows older than 30 days to a separate table.

---

## Stage 3: Query Analysis

The given query finds unread notifications for student 123 from the last 7 days:

```sql
SELECT sn.notificationID, n.type, n.message, n.createdAt
FROM student_notifications sn
JOIN notifications n ON sn.notificationID = n.id
WHERE sn.studentID = 123
  AND sn.isRead = false
  AND n.createdAt >= NOW() - INTERVAL '7 days'
ORDER BY n.createdAt DESC;
```

Without an index, this is a full sequential scan of `student_notifications`. The fix:

```sql
CREATE INDEX idx_student_unread_recent
ON student_notifications(studentID, createdAt DESC)
WHERE isRead = false;
```

The partial index (`WHERE isRead = false`) is much smaller than a full index on the table — only unread rows are indexed, which is exactly what this query filters on. After adding this, the planner does an index scan directly to the relevant rows instead of scanning the whole table. Execution goes from O(n) to O(log n + k) where k is the result count.

A note on over-indexing: every index added to a table costs write performance (the index is maintained on every INSERT/UPDATE/DELETE). For this system, two indexes are enough — the partial one above for unread queries, and a simple one on `(type, createdAt DESC)` on `notifications` for the placement-filter query below.

To find students with Placement notifications in the last week:

```sql
SELECT DISTINCT s.id, s.name, s.email
FROM students s
JOIN student_notifications sn ON s.id = sn.studentID
JOIN notifications n ON sn.notificationID = n.id
WHERE n.type = 'Placement'
  AND n.createdAt >= NOW() - INTERVAL '7 days'
ORDER BY s.name;
```

Index: `CREATE INDEX idx_notif_type_date ON notifications(type, createdAt DESC);`

---

## Stage 4: Performance Under Load

Three approaches, each with real tradeoffs.

**Redis caching per student.** Cache unread count and recent notifications with keys like `student:123:unread_count`, TTL of 5 minutes or invalidated immediately on write/read events. Read latency drops to O(1) and the database stays idle during peaks. The downside is cache invalidation complexity — a missed invalidation means stale counts persist silently. Redis also adds an infrastructure dependency; if it goes down, all traffic hits the database at once.

**Cursor-based pagination.** Instead of `OFFSET 100 LIMIT 20` (which scans 120 rows to return 20), use the timestamp of the last item as a cursor: `WHERE createdAt < ? ORDER BY createdAt DESC LIMIT 20`. The database only touches the relevant window regardless of how deep into the list the client is. Trade-off: you lose random page access — clients must implement "load more" rather than jumping to page 5. Also, rows deleted between requests can cause items to be skipped.

**Fanout-on-write.** When a notification is created, pre-write it to every recipient's feed in Redis or a `student_feeds` table immediately. Reads become a single lookup. The problem: at 50k students this is 50k write operations hitting at once — a thundering herd if done synchronously. This only makes sense with a background queue spreading writes over time, and even then it's fragile if a worker fails mid-fanout.

In practice: Redis cache for unread count + cursor pagination for the notification list + database fallback on cache miss. Fanout-on-write is only worth the complexity for very high-frequency feeds or VIP users where latency is the top priority.

---

## Stage 5: Bulk Notification Analysis

The naive approach — iterate 50k students, write to DB and send email in a loop — has a few problems. The server thread is blocked the whole time. If an SMTP timeout happens at student 30,000, the students before got the notification, students after didn't. There's no retry. The operation is neither atomic nor recoverable.

The right design separates database writes from side effects. The database is the source of truth and is written first. Email is a separate, async step that can fail and retry independently:

```
function notifyAll(studentIDs, message, title):
  for id in studentIDs:
    enqueue('db_insert_notification', { studentID: id, message, title })
    enqueue('send_email', { studentID: id, message, title })
    enqueue('send_push', { studentID: id, message })

queue_worker(job):
  try:
    execute(job)
    markSuccess(job)
  catch err:
    if job.attempts < 3:
      requeue(job, delay = 2 ** job.attempts seconds)
    else:
      markFailed(job)
      logFailure(job.id, err)
```

Key point: the DB write and email send are **not** in the same transaction. If they were, an email failure would roll back the DB write and the student would see nothing at all — worse than just missing the email. Keeping them independent means a failed email can retry without touching the notification record. If 200 emails out of 50k fail after 3 retries, those 200 are logged; the students still see the notification in their inbox.

A message queue (RabbitMQ, SQS, etc.) also prevents the thundering herd. Instead of 50k DB writes in a burst, a worker pool drains the queue at a controlled rate. Backpressure from a full queue signals saturation; the API can return 503 early rather than letting the database get overwhelmed.

---

## Stage 6: Priority Inbox Implementation

The priority inbox returns the top N notifications by a combined score. The scoring formula used in this implementation:

```
typeWeight = { Placement: 3, Result: 2, Event: 1 }
recencyBonus = 1 / (1 + hoursElapsed + 0.01)   -- always < 1
score = typeWeight + recencyBonus
```

The additive structure is deliberate: `recencyBonus` is capped below 1, so a newer lower-priority notification can never beat an older higher-priority one. A Result from 5 minutes ago still loses to a Placement from yesterday.

For top-N selection, a min-heap of fixed size N is more efficient than sorting the whole list. Each notification is scored and pushed into the heap; once the heap exceeds N items, the minimum is popped. After processing all notifications, what's left in the heap is the top N. This is O(n log k) where k = N, versus O(n log n) for a full sort — noticeably faster when N is small relative to the total count.

The `MinHeap` in `inbox.js` implements `push` (insert + bubble-up), `pop` (remove root + sink-down), `peek`, and `size`. No external library. `getTopN` runs this against all notifications at once and returns the heap contents sorted descending by score.

One edge case: if `Timestamp` is missing or malformed, `new Date(ts).getTime()` returns `NaN`, which propagates through the score computation and corrupts heap ordering. The guard `isNaN(new Date(ts).getTime()) ? 9999 : ...` treats a bad timestamp as "very old", giving it the lowest possible recency bonus rather than letting NaN silently break things.
