# Core Objects (Data Models)

### Transaction
- `id` (string)
- `date` (string) - `YYYY-MM-DDHH:mm`
- `category` (string) - Name of the category.
- `amount` (number)
- `user` (string) - Login of the person who entered it.
- `note` (string)
- `recordedAt` (string) - UTC timestamp of creation.
- `lastSyncedAt` (string) - UTC timestamp of last server sync.
- `pending` (boolean) - True if still in the local queue.

### BudgetSnapshot
- `periods` (Array<string>) - List of months.
- `limitPeriod` (string) - The month of the currently open view.
- `transactions` (Array<Transaction>) - Transactions for the requested months.

### Goal
- `name` (string)
- `targetAmount` (number)
- `currentAmount` (number)
- `deadline` (string)
- `beginDate` (string)
- `type` (string) - `Savings` or `Project`.
- `active` (boolean)
- `progress` (number) - 0-100.
- `monthlyRequired` (number) - Amount that needs to be saved/spent per month.

### BudgetLimit
- `month` (string) - `YYYY-MM`.
- `category` (string)
- `limit` (number)