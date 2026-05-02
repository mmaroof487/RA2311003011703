# Backend Assessment Solution

## Installation

Install dependencies across all modules:

```bash
npm run install-all
```

This installs packages in the root, `logging_middleware/`, `vehicle_maintenance_scheduler/`, and `notification_app_be/`.

Copy `.env.example` to `.env` and fill in your `CLIENT_SECRET`:

```bash
cp .env.example .env
# then set CLIENT_SECRET=<your_secret> in .env
```

The server will throw immediately at startup if `CLIENT_SECRET` is missing.

## Structure

- `config.js` — Centralized configuration with API credentials
- `logging_middleware/` — Token caching and structured logging module
  - `tokenStore.js` — Automatic token refresh with in-memory cache
  - `logger.js` — Validated logging with support for stack, level, and package types
- `vehicle_maintenance_scheduler/` — Vehicle task scheduling using knapsack DP
  - `scheduler.js` — Pure knapsack algorithm and API client
  - `routes.js` — REST endpoints for scheduling
  - `index.js` — Express server (port 3001)
- `notification_app_be/` — Priority notification inbox with min-heap
  - `store.js` — In-memory notification cache
  - `inbox.js` — Min-heap and priority scoring
  - `routes.js` — REST endpoints
  - `index.js` — Express server (port 3002)
- `notification_system_design.md` — Complete design document (Stages 1-6)

## Running

### Vehicle Maintenance Scheduler

```bash
npm run start-scheduler
```

Server runs on http://localhost:3001

**Endpoints:**

- `GET /schedule/run` — Execute knapsack for all depots
  ```bash
  curl http://localhost:3001/schedule/run
  ```

- `GET /schedule/depots` — List depot budgets
  ```bash
  curl http://localhost:3001/schedule/depots
  ```

- `GET /schedule/vehicles` — List all vehicle tasks
  ```bash
  curl http://localhost:3001/schedule/vehicles
  ```

### Notification App

```bash
npm run start-notifications
```

Server runs on http://localhost:3002

**Endpoints:**

- `GET /notifications` — List all notifications (supports `?type=Placement` filter)
  ```bash
  curl http://localhost:3002/notifications
  curl http://localhost:3002/notifications?type=Placement
  ```

- `GET /notifications/top/5` — Top 5 by priority score
  ```bash
  curl http://localhost:3002/notifications/top/5
  ```

- `POST /notifications/refresh` — Refresh cache from API
  ```bash
  curl -X POST http://localhost:3002/notifications/refresh
  ```

## Key Implementation Details

### Vehicle Scheduler

- **Algorithm:** 0/1 Knapsack with bottom-up DP
- **Complexity:** O(n × budget) where n = number of tasks, budget = total mechanic-hours
- **Backtracking:** Reconstructs selected tasks from DP table
- **Logging:** All operations logged via centralized `Log()` function

### Notification Inbox

- **Min-Heap:** Implemented from scratch (push/pop/peek/bubble-up/sink-down)
- **Scoring:** `score = typeWeight + recencyBonus` where `recencyBonus = 1/(1 + hoursElapsed + 0.01)` — additive, capped below 1 so a lower-priority type can never outscore a higher-priority one
- **Space:** O(k) for heap of size k, not O(n) for full sort
- **Time:** O(n log k) insertion vs O(n log n) sort
- **Streaming:** Same algorithm applied as notifications arrive one-by-one

### Logging

- **Centralized:** All `console.log` replaced with `Log(stack, level, package, message)`
- **Validation:** Invalid parameters raise errors immediately
- **Token Caching:** Automatic refresh before expiration

## Testing Notes

- Fill `config.js` with valid credentials before running
- Token caching layer ensures efficient API reuse
- All errors logged and propagated to routes with proper HTTP status codes
- Empty lists return `[]`, not null or undefined
# RA2311003011703
