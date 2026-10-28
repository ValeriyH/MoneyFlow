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

## Storage
- `Goals` sheet: definitions only (`ID, Назва, Цільова сума, Дедлайн, Початок, Тип, Активна`), edited by hand.
- `GoalHistory` sheet: one row per GoalChange (`ID, Ціль, Сума, Користувач, Дата`). `Сума` is signed: positive adds, negative withdraws.
- `currentAmount` is not stored: it is the sum of the goal's `GoalHistory` rows, computed in `fetchGoals`. The history is the single source.
- Goals do not affect the budget (limits, statistics).

## Changes (Transactions)
- Every add / edit / delete of a GoalChange is a Transaction with operation type `goalChange` (see [offline.md](offline.md) for the queue, [models.md](models.md) for formats).
- `applyGoalChange` (Code.gs) validates and applies:
  - goal must exist and be active;
  - `amount` is a finite non-zero number, `|amount| <= MAX_GOAL_ADJUSTMENT`;
  - the goal balance must stay `>= 0` after the change (applies to withdrawals, edits and deletes);
  - `occurredOn` is optional: default today on add, unchanged on update;
  - update keeps the original author (`Користувач`).
- Idempotent by `targetId`: add of an existing row and delete of a missing row succeed without changes.

## Rule Summary
- `calculateGoalProgress` and `calculateMonthlyRequirement` are executed on the server to ensure consistent numbers across all devices.
- Goals are shared: there is no owner column, every logged-in user sees and changes all goals.
- `calculateMonthlyRequirement` compares `YYYY-MM-DD` strings in the script timezone (`TIMEZONE`), not `Date` objects; months are counted from `Max(beginDate, today)` to `deadline`. Without a valid deadline it returns 0 and the UI shows «Дедлайн не вказано».
- Goals are loaded separately from the budget snapshot (`fetchGoals`, or with every `submitTransactions` response) and cached in `moneyflow.cached-goals`.
- Client (`core/goalStore.js`) shows queued changes in the history immediately, marked «очікує синхронізації»; progress and monthly requirement update only after the server applies them («Оновиться після синхронізації»).
- Editing or deleting a change whose add is still queued and not sent rewrites/drops the queued transaction instead of sending a new one.
- The client parses the amount strictly (`parseAmount`); the modal closes before sending, so a double tap cannot queue a change twice.
