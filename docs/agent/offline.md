# Offline & Service Worker

## Service Worker Logic
- `sw.js` is located in the root to ensure it covers the entire site.
- Registered via `registerOfflineShell` in `main.js`.
- Uses Network-first strategy
- If the network returns a non-OK response (e.g., 5xx, or offline), the Service Worker serves the version from the `moneyflow-shell-v1` cache.

## Caching Rules
- The cache includes the main shell (HTML, JS, CSS, Icons).
- A specific issue: If `sw.js` is in a subfolder, the scope is broken. It **must** be in the root.
- Cache is ignored for the `/apps-script/` path.

## Snapshot Caching
- `moneyflow.cached-snapshot` in `localStorage` stores history for currently open months.
- Records are kept for a maximum of 3 months (`CACHED_MONTHS_LIMIT`).
- Snapshots are "trimmed" to the last 3 months during both `saveCachedSnapshot` and before being sent to the server.
- Logic: A partial month counts as a full month for the limit, but is not included in the sum to avoid skewing the "Balance".

## Transaction Queue
One Login-scoped queue in `localStorage` (owner: Login): `moneyflow.transaction-queue.<login>`, managed by `core/transactionQueue.js`. It carries every user Transaction: `expense` (queued by `budgetStore`) and `goalChange` (queued by `goalStore`).
- `enqueue(operation)` wraps the operation into `{ id: UUID, recordedAt, operation }`.
- `flush()` sends the whole queue in one `submitTransactions` request (max 50 per request, `MAX_TRANSACTIONS_PER_REQUEST` on both sides), loops until empty; a second call joins the running one.
- The request carries `periods` / `limitPeriod` from `budgetStore` (`setRequestContext`); the response carries `results`, a budget `snapshot` and `goals`, built once per request.
- Server (`applyTransactions`) applies in order under one `LockService` lock, per transaction:
  1. ID already in the `Transactions` log → `duplicate` (client treats as applied);
  2. validate and apply to the entity sheet (handler by `operation.type`);
  3. append the log row **last** (commit marker); a crash before it → the retry re-applies harmlessly, handlers are idempotent by `targetId`.
  - Validation failure (`BAD_REQUEST`) → `rejected` with message, nothing written. Any other error fails the whole request.
- Client: `applied` / `duplicate` / `rejected` are removed from the queue. Every rejection goes to `onRejected` listeners; `main.js` shows one toast per rejection. Network / timeout / 5xx / rate limit / `SESSION_EXPIRED` keep the queue intact. `UNAUTHORIZED` (account disabled, password changed, token forged — e.g. a lost phone) clears the whole queue; `main.js` then also clears the snapshot and goals caches (`budgetStore.reset`, `goalStore.reset`). They are reloaded after the next successful login. Any other whole-request rejection drops the sent batch (it would block the queue forever).
- Sent transactions are "in flight" and never rewritten. `findUnsentAdd(type, targetId)` finds a queued add that may still be rewritten (not sent, nothing after it for the same target): editing such a record rewrites the add, deleting it drops it from the queue; otherwise an `update` / `delete` is queued.
- Views: `budgetStore` and `goalStore` keep the server data and fold queued operations on top (`pending: true`). A rejected or dropped operation disappears from the queue, so the view returns to the server values by itself — no rollback copies.
- The snapshot cache holds server data only; queued records are folded in again after a reload.
- `onResponse`: `budgetStore` applies the snapshot, `goalStore` the goals.
## Responsibilities
Each part answers only for itself (single responsibility):
- `transactionQueue` — delivery: the queue, `getStatus()` → `{ pendingCount, isSending, lastError }`.
- `budgetStore` — the budget: snapshot, expenses view, `isLoading` / `loadError` of snapshot requests, `reload()`.
- `goalStore` — goals and their history.
- `main.js` (Dispatcher) — orders them: `synchronizeAll()` = `transactionQueue.flush()`, then `budgetStore.reload()` only if nothing was delivered (a delivery already brings the snapshot). Used on start, manual sync, `online` event, tab return after 3 min, login. Auth failures, toasts and the login screen are handled here.
- `syncIndicator` — combines the two sources (`budget`, `queue`) into one state: sending with queued records → pending («Черга: N», yellow) → budget loading (grey) → delivery failure with queued records → load failure → pending → synced; any failure while `navigator.onLine` is false shows as offline.

Also flushed on every expense / goal action and on opening the Goals tab.

## Goals Cache
- `moneyflow.cached-goals` holds the last goals from the server; cleared on logout.

## Known Issues
- Network errors (like "Page not found" or "Gateway timeout") return 5xx codes. These must be caught by checking `response.ok` rather than just catching `fetch` errors, otherwise the app might show the "error page" instead of the cached content.
