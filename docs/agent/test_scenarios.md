# Test Scenarios

These scenarios are designed to be verified during development and testing to ensure core logic and UX patterns remain intact.

## Login & Auth
1. **Login Attempt Exhaustion**: Verify that 5 failed attempts result in a 15-minute lockout.
2. **Cross-User Lockout**: Verify that if one user is locked out, others are also blocked from attempting login.
3. **Time-Based Proof**: Verify that a captured `proof` from a previous session cannot be reused (due to timestamp expiration).
4. **Session Expiration**: Verify that a session token expires after the defined TTL.
5. **Admin Override**: Verify that deleting `moneyflow.loginAttempts` allows immediate login after failures.
 
## Sync & Queue
6. **Offline Persistence**: Verify that entries made while offline persist in `localStorage` and sync automatically once the network is restored.
7. **Queue Isolation**: Verify that a queue for "User A" is never accessible or mergeable with "User B".
8. **Session Expiry Behavior**: Verify that `SESSION_EXPIRED` clears the queue? (Wait, checking deprecated: "SESSION_EXPIRED (не стирає чергу), UNAUTHORIZED (стирає)"). 
9. **Duplicate Prevention**: Verify that repeating the "Save" action on the same entry while in the queue does not create duplicate entries.
10. **Sync Retry**: Verify that clicking the sync indicator "kicks" a stuck sync process.
 
## Budget & Snapshots
11. **Current Month focus**: Verify that the `limitPeriod` is always included in the calculation regardless of other periods.
12. **Three-Month Limit**: Verify that older cached snapshots are automatically trimmed.
13. **Date Precision**: Verify that `2026-10` is correctly identified as the month even if the input is `2026-10-01`.
14. **Budget Calculation**: Verify that `Balance = Budget - Total Expenses` and that `Budget` is the sum of `Limits`.
15. **Active Category Filter**: Verify that categories with `Active = False` are hidden from the entry form but remain in the list.
16. **Limit Miss**: Verify that a category without a row in `BudgetLimits` is shown in the form and allowed to have an entry but isn't included in the budget sum.
 
## UI & UX
17. **Mobile Compact View**: Verify that on screens ≤ 899px, the form is collapsed and expands only when the sum field is focused or has text.
18. **Success Visibility**: Verify that a "Saved" or "Pending" status remains visible for at least 15 seconds.
19. **Scroll to Form**: Verify that clicking "Edit" on a mobile device automatically scrolls the form into view.
20. **Theme Toggle**: Verify that switching from `classic` to `solid` updates the `--color-*` variables without reloading the page.
21. **Form Reset**: Verify that `resetFormFields` clears all inputs but preserves the `autoFilledDate` if it was manual.
22. **Transaction Sorting**: Verify that the list is sorted by `occurredOn` (date of expense) and not by `recordedAt` (time of entry).
23. **Comment Handling**: Verify that comments are rendered on a separate line in the transaction list.
24. **Edit Logic**: Verify that editing a planned/queued entry updates the "draft" in the queue without sending many `update` requests to the server.
25. **Query Merge**: Verify that adding a transaction calls `addTransaction` and returns a new snapshot, which provides the updated "Balance" immediately.
 
## Edge Cases
26. **Timezone Isolation**: Verify that `toISOString()` is avoided for date fields to prevent UTC-shift errors in Kiev time.
27. **Empty Data State**: Verify that an empty month (no limits/transactions) shows "Loading..."/Empty states instead of just zeroes.
28. **Max Users**: Verify that the system honors `MAX_TOTAL_USERS`.
29. **Expression Parsing**: Verify that `120+80+50` is correctly parsed into the total sum before being sent to the server.
30. **Session Token Logout**: Verify that changing `moneyflow.tokenSecret` successfully invalidates all active sessions.