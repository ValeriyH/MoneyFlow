/**
 * statistics.js — aggregation of operations by month.
 * Pure functions without side effects: array of operations as input,
 * ready description for UI rendering as output.
 *
 *
 */
 
import {
  daysInPeriod,
  elapsedDaysInPeriod,
  isCurrentPeriod,
  remainingDaysInPeriod,
  shiftPeriodKey,
} from "./period.js";
 
/**
 * Filters operations belonging to the given month.
 * @param {Array<object>} expenses
 * @param {string} periodKey — "2026-10"
 * @returns {Array<object>}
 *
 *
 */
export function filterExpensesByPeriod(expenses, periodKey) {
  return expenses.filter(
    (expense) => typeof expense.occurredOn === "string" &&
      expense.occurredOn.startsWith(periodKey),
  );
}
 
/**
 * Sum of operations.
 * @param {Array<object>} expenses
 * @returns {number}
 *
 *
 */
function totalAmount(expenses) {
  return expenses.reduce((runningTotal, expense) => runningTotal + expense.amount, 0);
}
 
/**
 * Total budget for the month: sum of limits of all categories.
 *
 * Limits come from the server already filtered by month,
 * so the sum is simple. Categories without limits are not
 * part of the budget, but remain available for expense entry.
 *
 * @param {Array<object>} categories
 * @returns {number}
 *
 *
 */
export function totalBudgetForPeriod(categories) {
  return categories.reduce((runningTotal, category) => runningTotal + (category.limit ?? 0), 0);
}
 
/**
 * Full report for the month: balance, spending structure, projection, dynamics.
 *
 * @param {Array<object>} allExpenses — all budget operations
 * @param {Array<object>} categories — catalog for icons, colors, and limits
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {{
 *   periodKey: string,
 *   expenseTotal: number,
 *   budgetTotal: number,
 *   balance: number,
 *   expenseCount: number,
 *   dailyAverageExpense: number,
 *   projectedExpenseTotal: number,
 *   previousPeriodExpenseTotal: number,
 *   categoryBreakdown: Array<object>,
 * }}
 *
 *
 */
export function buildPeriodSummary(allExpenses, categories, periodKey, referenceDate = new Date()) {
  const periodExpenses = filterExpensesByPeriod(allExpenses, periodKey);
 
  const expenseTotal = totalAmount(periodExpenses);
  const budgetTotal = totalBudgetForPeriod(categories);
 
  const elapsedDays = Math.max(elapsedDaysInPeriod(periodKey, referenceDate), 1);
  const previousPeriodTotal = totalAmount(
    filterExpensesByPeriod(allExpenses, shiftPeriodKey(periodKey, -1)),
  );
 
  return {
    periodKey,
    expenseTotal,
    budgetTotal,
    balance: budgetTotal - expenseTotal,
    expenseCount: periodExpenses.length,
    dailyAverageExpense: expenseTotal / elapsedDays,
    projectedExpenseTotal: isCurrentPeriod(periodKey, referenceDate)
      ? (expenseTotal / elapsedDays) * daysInPeriod(periodKey)
      : expenseTotal,
    previousPeriodExpenseTotal: previousPeriodTotal,
    remainingDays: remainingDaysInPeriod(periodKey, referenceDate),
    categoryBreakdown: buildCategoryBreakdown(periodExpenses, categories, expenseTotal),
  };
}
 
/**
 * Breakdown of spending by category, sorted from largest to smallest.
 *
 * Category missing from the catalog doesn't disappear from history:
 * it's shown as a neutral dot. Thus old records remain
 * readable, even if the category was removed from the table.
 *
 * @param {Array<object>} periodExpenses
 * * @param {Array<object>} categories
 * * @param {number} expenseTotal — for share calculation
 * * @returns {Array<{ name: string, icon: string, color: string, total: number, share: number }>}
 * *
 *
 */
export function buildCategoryBreakdown(periodExpenses, categories, expenseTotal) {
  const categoryMetaByName = new Map(
    categories.map((category) => [category.name, category]),
  );
 
  const totalByCategoryName = new Map();
  for (const expense of periodExpenses) {
    totalByCategoryName.set(
      expense.category,
      (totalByCategoryName.get(expense.category) ?? 0) + expense.amount,
    );
  }
 
  return [...totalByCategoryName.entries()]
    .map(([categoryName, categoryTotal]) => {
      const categoryMeta = categoryMetaByName.get(categoryName);
 
      return {
        name: categoryName,
        icon: categoryMeta?.icon ?? "•",
        color: categoryMeta?.color ?? "#8b95a8",
        total: categoryTotal,
        share: expenseTotal > 0 ? categoryTotal / expenseTotal : 0,
      };
    })
    .sort((left, right) => right.total - left.total);
}
 
/**
 * Operations for the list: by expense date, newer first.
 *
 * The main key is `occurredOn`, not the submission time: expenses
 * must be grouped by days, otherwise "what I spent yesterday"
 * would be scattered between what was entered today for yesterday, and what
* was entered yesterday for yesterday.
 *
 * `recordedAt` remains as a backup: it breaks down records
 * submitted within one minute, and gives order for old records without
 * time, where the date is exactly the same.
 *
 * @param {Array<object>} expenses
 * @param {number} pageSize
 * @returns {Array<object>}
 *
 *
 */
export function takeRecentExpenses(expenses, pageSize) {
  return [...expenses]
    .sort(
      (left, right) =>
        expenseTimeKey(right).localeCompare(expenseTimeKey(left)) ||
        (right.recordedAt ?? "").localeCompare(left.recordedAt ?? ""),
    )
    .slice(0, pageSize);
}
 
/**
 * Sorting key by expense date, with normalized time.
 *
 * Time is appended not just so: "2026-10-16" is shorter than
 * "2026-10-16T08:00", so without addition records of the same day
 * would be scattered — first those with time, then those without.
 * `T00:00` puts everyone in the same place, and the day remains whole.
 *
 * Empty date remains empty, not converted into
 * `T00:00`: a record without date must end up at the end, not
 * at the beginning.
 *
 * @param {object} expense
 * @returns {string}
 *
 *
 */
function expenseTimeKey(expense) {
  const occurredOn = expense?.occurredOn ?? "";
  if (!occurredOn) return "";
  return occurredOn.includes("T") ? occurredOn : `${occurredOn}T00:00`;
}