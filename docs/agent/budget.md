# Budgeting Engine
 
## Data Source
- `BudgetLimits` is a separate sheet from `Categories`.
- Schema: `Місяць | Категорія | Ліміт, ₴`.
- Linkage: Categories are joined by their name (exact string match).
- If a category name in `BudgetLimits` doesn't exist in `Categories`, the server returns a `RequestError`.
 
## Calculations
- **Monthly Budget** = Sum of all `Ліміт` for the current month in `BudgetLimits`.
- **Daily Limit** = `Monthly Budget` / days in the month.
- **Balance** = `Monthly Budget` - `Total Expenses` (sum of `Сума` in the `Expenses` sheet for that month).
- **Progress** = `Total Expenses` / `Monthly Budget`.
 
## Date Handling
- The system uses strings for dates in the format `YYYY-MM-DDHH:mm` (e.g., `2026-10-01T00:00`).
- `period` is represented as `YYYY-MM`.
- `periodKey` is the monthly identifier (e.g., `2026-10`).
- `limitPeriod` is the specific month for which limits are being displayed.
 
## Snapshot Logic
- Transactions are fetched for `periods` (a list of months).
- The `limitPeriod` (the currently open month) is treated specially.
- The `periods` list is merged with the input to ensure the `limitPeriod` is always included.
- Requests for transactions include a `limitPeriod` filter to keep response sizes manageable even if the user has many months in their `periods` list.
 
## UI State
- **Active Flag**: A category is "Active" (visible in the form) if its `Активна` flag is true.
- **Limit Check**: If a category has no row in `BudgetLimits`, it is still "Active" and visible, but it won't be included in the budget calculation (it will behave as an un-limited category).