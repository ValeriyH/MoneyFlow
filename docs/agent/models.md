# Core Objects (Data Models)

### Expense (sheet `Expenses`, snapshot field `expenses`)
- `id` (string)
- `occurredOn` (string) - `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`.
- `category` (string) - Name of the category.
- `amount` (number)
- `user` (string) - Login of the person who entered it.
- `note` (string)
- `recordedAt` (string) - UTC timestamp of the last write.
- `pending` (boolean) - Client only: a queued operation is applied on top of the server value.

### BudgetSnapshot
- `periods` (Array<string>) - List of months.
- `limitPeriod` (string) - The month of the currently open view.
- `transactions` (Array<Transaction>) - Transactions for the requested months.

### Goal
- `id` (string)
- `name` (string)
- `targetAmount` (number)
- `currentAmount` (number) - Sum of `history`, computed on the server.
- `deadline` (string) - `YYYY-MM-DD`.
- `type` (string) - `Savings` or `Project`.
- `active` (boolean)
- `progress` (number) - 0-100.
- `monthlyRequirement` (number) - Amount that needs to be saved/spent per month.
- `history` (Array<GoalChange>) - Newest first.

### GoalChange (sheet `GoalHistory`)
- `id` (string)
- `amount` (number) - Positive adds, negative withdraws.
- `user` (string) - Login of the person who entered it.
- `occurredOn` (string) - `YYYY-MM-DD`.
- `pending` (boolean) - Client only: still in the transaction queue.

### Transaction (user action, sheet `Transactions`)
- `id` (string) - Client UUID; the server applies each ID once.
- `recordedAt` (string) - Client ISO time, informational.
- `operation` (object):
  - `type` (string) - `expense` | `goalChange`.
  - `action` (string) - `add` | `update` | `delete`.
  - `targetId` (string) - ID of the entity row; differs from the transaction ID. For an expense add it is the client-generated expense ID.
  - `data` (object):
    - `expense` add / update: `{ occurredOn, category, amount, note }` (update sends full values); delete: none.
    - `goalChange` add: `{ goalId, amount, occurredOn? }`; update: `{ amount, occurredOn? }`; delete: none.
- Log row: `ID, Користувач, Записано, Тип, Операція` — author and time set by the server, `Тип` copied from the operation for filtering, `Операція` = JSON `{ action, targetId, data }` with the data actually applied.

### TransactionResult
- `id` (string) - Transaction ID.
- `status` (string) - `applied` | `duplicate` | `rejected`.
- `error` (string) - Ukrainian text, only for `rejected`.

### BudgetLimit
- `month` (string) - `YYYY-MM`.
- `category` (string)
- `limit` (number)