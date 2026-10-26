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

## Known Issues
- Network errors (like "Page not found" or "Gateway timeout") return 5xx codes. These must be caught by checking `response.ok` rather than just catching `fetch` errors, otherwise the app might show the "error page" instead of the cached content.
