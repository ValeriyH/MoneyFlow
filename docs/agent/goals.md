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
- UI handles the rendering of progress bars and achievement states based on these values.