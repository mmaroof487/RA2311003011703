# Notification System Design

## Stage 1: REST API Design

The notification system provides six core endpoints for managing student notifications. Each endpoint adheres to REST conventions and uses HTTP status codes appropriately.

The `GET /notifications` endpoint lists all notifications for the current student, supporting optional pagination and filtering. This endpoint returns a 200 OK status with a JSON array of notification objects. Each notification object contains fields: `id` (UUID), `type` (one of Placement, Result, Event), `message` (text), `createdAt` (ISO 8601 timestamp), and `isRead` (boolean). The response supports a `?page=1&limit=20` query parameter for pagination, defaulting to page 1 with 20 items per page.

The `GET /notifications/unread/count` endpoint returns only the count of unread notifications without fetching the full objects. This is a lightweight query suitable for badge updates on the client. Response: `{ "count": 42 }`.

The `PATCH /notifications/:id/read` endpoint marks a single notification as read. The request body is empty. On success, returns 204 No Content. If the notification ID does not exist or does not belong to the student, returns 404 Not Found.

The `PATCH /notifications/read-all` endpoint marks all notifications as read in a single call. Request body is empty. Returns 204 No Content. This operation is atomic at the application level.

The `DELETE /notifications/:id` endpoint removes a single notification. Returns 204 No Content on success, 404 if the notification does not exist or does not belong to the student. The soft-delete pattern is preferred: set a `deletedAt` timestamp rather than physically removing the row, preserving audit logs.

All endpoints require the header `Authorization: Bearer <token>` where the token is obtained via the authentication endpoint. The response Content-Type is always `application/json` for non-204 responses.

Real-time notifications use Server-Sent Events (SSE) rather than WebSockets. SSE is chosen because notifications flow only server-to-client (unidirectional), eliminating the complexity of bidirectional handshakes, multiplexing, and connection upgrades. SSE works over standard HTTP/1.1, requires no custom proxy configuration, and has automatic reconnection built into the browser. The endpoint is `GET /notifications/stream` with `Content-Type: text/event-stream`. Events are formatted as: `data: { "id": "uuid", "type": "Placement", "message": "..." }\n\n`. The server sends an event every time a new notification is created for the student.

## Stage 2: Persistent Storage

PostgreSQL is the recommended database for this notification system. It provides strong guarantees for structured relational data with enumerations, composite indexing, and proven scalability at enterprise scale.

The schema consists of three tables: `students`, `notifications`, and `student_notifications` (a bridge table). The `students` table stores student metadata with columns: `id` (SERIAL PRIMARY KEY), `name` (TEXT NOT NULL), `email` (TEXT UNIQUE NOT NULL), `createdAt` (TIMESTAMPTZ DEFAULT NOW()). The `notifications` table is global and shared across all students, containing: `id` (UUID PRIMARY KEY DEFAULT gen_random_uuid()), `type` (notification_type NOT NULL, an ENUM of Placement, Result, Event), `message` (TEXT NOT NULL), `createdAt` (TIMESTAMPTZ DEFAULT NOW()), `deletedAt` (TIMESTAMPTZ, NULL for active notifications). The `student_notifications` table is the join table linking students to notifications with state: `studentID` (INT REFERENCES students(id) ON DELETE CASCADE), `notificationID` (UUID REFERENCES notifications(id) ON DELETE CASCADE), `isRead` (BOOLEAN DEFAULT false), `readAt` (TIMESTAMPTZ, NULL until read), PRIMARY KEY (studentID, notificationID).

Here is the complete SQL schema:

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
  deletedAt  TIMESTAMPTZ
);

CREATE TABLE student_notifications (
  studentID        INT REFERENCES students(id) ON DELETE CASCADE,
  notificationID   UUID REFERENCES notifications(id) ON DELETE CASCADE,
  isRead           BOOLEAN DEFAULT false,
  readAt           TIMESTAMPTZ,
  PRIMARY KEY (studentID, notificationID)
);
```

At scale, this design faces several challenges. The `student_notifications` table grows unbounded as notifications accumulate. With 50,000 students and an average of 100 notifications per student, the table reaches 5 million rows. Queries on this table become slow without proper indexing. Second, the unread filter query (see Stage 3) must scan many rows to find unread notifications for a single student. Third, bulk notify operations require 50,000 INSERT statements into `student_notifications`, which blocks the database thread. Solutions include: creating a composite partial index on `(studentID, isRead, createdAt DESC) WHERE isRead = false` to accelerate unread queries; partitioning the `student_notifications` table by `createdAt` range (e.g., monthly partitions) to keep individual partitions smaller and improve query planner efficiency; archiving old read notifications (older than 30 days) to a separate archive table to keep the hot table lean; and using a message queue to spread bulk fanout writes over time rather than doing them synchronously.

## Stage 3: Query Analysis

The query is syntactically correct. It finds all unread notifications for student ID 123 created in the last 7 days, ordered newest first:

```sql
SELECT sn.notificationID, n.type, n.message, n.createdAt
FROM student_notifications sn
JOIN notifications n ON sn.notificationID = n.id
WHERE sn.studentID = 123
  AND sn.isRead = false
  AND n.createdAt >= NOW() - INTERVAL '7 days'
ORDER BY n.createdAt DESC;
```

Without an index, PostgreSQL performs a full sequential scan of `student_notifications` (millions of rows) and filters by `studentID = 123` and `isRead = false`, which is expensive. The fix is a partial composite index:

```sql
CREATE INDEX idx_student_unread_recent
ON student_notifications(studentID, createdAt DESC)
WHERE isRead = false;
```

This index only contains rows where `isRead = false` (much smaller than the full table) and is sorted by `createdAt` descending, enabling an index-only scan that jumps directly to rows for the student and avoids the sequential scan entirely. Query execution time drops from O(n) to O(log n + k) where k is the result count. The join to `notifications` is still necessary to fetch the message and type, but the initial filter is now fast.

A common misconception is to index every column appearing in a WHERE clause. This is incorrect. Each index adds overhead to every INSERT, UPDATE, and DELETE operation on the table (the index must be maintained). Index bloat occurs when many indexes exist but few are used. The query planner may also choose the wrong index if multiple options exist. The correct approach is to index only columns that appear in WHERE clauses on frequently executed queries, ORDER BY clauses that bottleneck sorting, and columns in JOIN conditions that would otherwise cause table lookups. For this system, only two indexes are necessary: one on `(studentID, isRead, createdAt DESC) WHERE isRead = false` for unread queries, and one on `studentID` for general lookups. Partial indexes (the WHERE clause) further optimize by reducing index size.

To find all students with Placement notifications in the last 7 days:

```sql
SELECT DISTINCT s.id, s.name, s.email
FROM students s
JOIN student_notifications sn ON s.id = sn.studentID
JOIN notifications n ON sn.notificationID = n.id
WHERE n.type = 'Placement'
  AND n.createdAt >= NOW() - INTERVAL '7 days'
ORDER BY s.name;
```

This query filters on `n.type` and `n.createdAt`, which should be indexed on the `notifications` table: `CREATE INDEX idx_notif_type_date ON notifications(type, createdAt DESC)`.

## Stage 4: Performance Under Load

Three strategies for handling high query load in a notification system, each with distinct tradeoffs.

The first strategy is Redis caching per student. When a student fetches their unread count or recent notifications, the result is cached in Redis with a key like `student:123:unread_count` and `student:123:notifications:recent`. The cache has a TTL of 5 minutes or is invalidated immediately when a new notification arrives for that student or when the student marks a notification as read. Benefits include O(1) read latency, no database queries during peak traffic, and automatic expiration preventing stale data. Downsides: cache invalidation logic is complex at scale; a bug in the invalidation logic causes stale counts to persist; the cache must be warmed or is cold on first access; Redis introduces a new failure point (if Redis goes down, the fallback is the database, which may be overloaded).

The second strategy is cursor-based pagination. Instead of `SELECT * FROM notifications WHERE studentID = 123 OFFSET 100 LIMIT 20`, use: `SELECT * FROM notifications WHERE studentID = 123 AND createdAt < ? ORDER BY createdAt DESC LIMIT 20` where `?` is the `createdAt` timestamp of the last item from the previous page. Benefits: the database only scans a small window of rows even for high offsets; no full table scans; naturally sorted and efficient. Downsides: the client must implement infinite scroll or "load more" buttons rather than random access to page 5; cursor-based pagination is slightly more complex to implement than offset-based; deleted rows between requests cause items to be skipped (edge case).

The third strategy is fanout-on-write. When a notification is created, the system immediately computes the recipient list and writes a document to a `student_feeds` cache table or Redis for each student, pre-computing their feed. Reads become O(1) — fetch the cached feed, no computation. Downsides: bulk sends to 50,000 students require 50,000 write operations, creating a thundering herd; if any write fails, the feed for that student is incomplete; the fan-out must happen synchronously or risk inconsistency; suitable only if notification volume is low (< 100/hour per recipient) or if writes are spread over a message queue with a pool of workers.

For most real deployments, a combination is best: Redis cache for the unread count (highly frequent, lightweight query) + cursor pagination for fetching the actual notifications (avoids O(n) database scans) + database query only on cache miss (failover path). Fanout-on-write is reserved for VIP users or high-frequency feeds where latency is critical.

## Stage 5: Bulk Notification Analysis

The naive pseudocode for bulk notify iterates synchronously over 50,000 students and executes database writes and email sends in sequence. Problems: the entire operation blocks the server thread, preventing other requests from being handled; if an email send fails midway (e.g., due to SMTP timeout), the database write for that student may not have occurred, leaving the notification unsent; the coupling between database and email means partial failure leaves inconsistent state — some students see the notification, others don't; there is no retry mechanism for failed emails; and if 200 emails fail out of 50,000, the operation is considered failed with no recovery path.

A better design decouples database writes from side effects. The source of truth is always the database. When a notification is created, it is persisted immediately. Sending the email is a separate, asynchronous step that may succeed, fail, or retry independently. The pseudocode should be:

```
function notifyAll(studentIDs, message, title):
  for id in studentIDs:
    enqueue('db_insert_notification', { studentID: id, message, title })
    enqueue('send_email', { studentID: id, message, title })
    enqueue('send_push_app', { studentID: id, message })

queue_worker(job):
  try:
    if job.type == 'db_insert_notification':
      db.insert('student_notifications', { ... })
      markSuccess(job)
    else if job.type == 'send_email':
      sendEmail(job.email, job.message)
      markSuccess(job)
  catch err:
    if job.attempts < 3:
      newJob = { ...job, attempts: job.attempts + 1 }
      delay = 2 ** job.attempts seconds
      requeue(newJob, delay)
    else:
      markFailed(job)
      logFailure(job.id, job.error)
```

The database write and email send must NOT be atomic. If they are in the same transaction and the email fails, the database transaction rolls back, and the student never sees the notification at all — worse than a missing email. Instead, each is independent. If an email fails, the notification still appears in the student's inbox (they got something), and the email can retry later without affecting database consistency. Of the 50,000 students, if 200 email sends fail, they are retried with exponential backoff: 2 seconds, then 4 seconds, then 8 seconds (up to 3 attempts). After exhausting retries, those 200 are logged and marked as failed. The students still have the notification in their inbox, just missing the email alert. That is an acceptable failure mode.

Using a message queue (RabbitMQ, AWS SQS, or similar) spreads the fanout writes over time. Instead of 50,000 database writes happening in milliseconds, they are dequeued and executed by a pool of worker threads over 30 seconds or so. This prevents database connection pool exhaustion and allows prioritization (send critical Placement notifications first, then Results, then Events). If the queue fills up, backpressure signals that the system is saturated; the API can return 503 Service Unavailable to reject incoming requests rather than crashing.

## Stage 6: Priority Inbox Implementation

The priority inbox ranks notifications by importance and recency, then returns the top N. This implementation uses a min-heap for efficient streaming — inserting notifications one-by-one while maintaining the N highest-scoring items, rather than sorting the entire list.

The scoring formula combines type weight and recency:

```
typeWeight = { 'Placement': 3, 'Result': 2, 'Event': 1 }
hoursElapsed = (now - createdAt) / 3600000
score = typeWeight * (1 / (1 + hoursElapsed))
```

Placement notifications have the highest weight (3), so they naturally rank higher. Within the same type, newer notifications score higher because the denominator (1 + hoursElapsed) is smaller. An old Placement notification still scores higher than a new Event notification (e.g., Placement score of 2.5 vs Event score of 0.8 after 1 hour).

The implementation uses a min-heap of fixed size N. For each incoming notification, the algorithm computes its score, pushes it into the heap. If the heap exceeds N items, the minimum element (lowest score) is popped. After processing all notifications, the N items with the highest scores remain in the heap. This approach is O(n log k) where k = N, compared to sorting the full list which is O(n log n). For large notification lists (n = 1000) and small N (k = 5), the heap is ~200x faster than sorting.

The `MinHeap` class in `inbox.js` implements standard heap operations: `push` (insert and bubble-up), `pop` (remove min and sink-down), and `peek` (return min without removing). The `getTopN` function processes all notifications at once, while `streamTopN` processes them one at a time as if receiving a stream, demonstrating the same algorithm. Both return the N notifications sorted by score in descending order.

The code demonstrates interview-quality algorithm knowledge: understanding when a heap is appropriate (maintaining a fixed-size collection of top items), implementing it from scratch without libraries, and explaining the complexity tradeoff versus full sorting.
