# Goal Logic
 
## Goal Types
1. **Savings Goals (Накопичення)**
   - Used for accumulating funds (e.g., "Vacation").
   - Calculation: Progress is based on `currentAmount` / `targetAmount`.
   - Monthly Requirement: Amount needed to reach target by `deadline` from `beginDate`.

2. **Project Expenses (Проектні витрати)**
   - Used for tracking spending against a budget (e.g., "Home Renovation").
   - Calculation: Progress (or "remaining sum") is based on `targetAmount` - `currentAmount`.
   - Monthly Requirement: Usually 0 or irrelevant, as it's a limit-based tracker.
 
## Rule Summary
- Goals are data-driven from the `SHEET_GOALS` sheet.
- `calculateGoalProgress` and `calculateMonthlyRequirement` are executed on the server to ensure consistent numbers across all devices.
- Goals are shared: there is no owner column, every logged-in user sees and adjusts all goals.
- `calculateMonthlyRequirement` compares `YYYY-MM-DD` strings in the script timezone (`TIMEZONE`), not `Date` objects; months are counted from `Max(beginDate, today)` to `deadline`. Without a valid deadline it returns 0 and the UI shows «Дедлайн не вказано».
- `adjustGoal` validates `amount` (finite, non-zero, `|amount| <= MAX_GOAL_ADJUSTMENT`) and runs under `LockService` to avoid lost updates. It is online-only: it does not use the offline queue.
- The client parses the amount strictly (`parseAmount`), blocks the buttons while the request is in flight, and loads goals only after the session is available (`revealApplication`).
- UI handles the rendering of progress bars and achievement states based on these values.