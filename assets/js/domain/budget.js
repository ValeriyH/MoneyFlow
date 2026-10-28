/**
 * budget.js — comparing expenses with planned limits.
 *
 * A category's limit is set for a specific month and lives in the
 * `BudgetLimits` sheet, so this code only performs calculations, not rule storage.
 *
 * The presence of a limit and the activity of a category are different things:
 * a limit says "how much was planned for it this month", while activity means
 * "it is used at all". A category without a limit remains available for
 * expense entry.
 *
 *
 */
 
import { BUDGET_WARNING_THRESHOLD } from "../config.js";
import { isCurrentPeriod, remainingDaysInPeriod } from "./period.js";
import { filterTransactionsByPeriod } from "./statistics.js";
 
/**
 * Values for the "Active" column that mean "category is displayed".
 *
 * An empty value is also considered "true": to add a category, it is
 * sufficient to fill the name, icon, and color, and "Active" is
 * only used when you want to hide a category.
 *
 *
 */
const ACTIVE_TRUE_VALUES = ["так", "yes", "true", "1", "активна", "активний"];
 
/**
 * @param {object} category
 * @returns {boolean}
 */
export function isCategoryActive(category) {
  const rawValue = String(category?.isActive ?? "").trim().toLowerCase();
  if (rawValue === "") return true;
  return ACTIVE_TRUE_VALUES.includes(rawValue);
}
 
/**
 * @param {Array<object>} categories
 * @returns {Array<object>}
 */
export function filterActiveCategories(categories) {
  return categories.filter(isCategoryActive);
}
 
/** Limit status relative to spent amount. */
export const BUDGET_STATUS = {
  /** Spent less than the warning threshold. */
  safe: "safe",
  /** Spent close to the limit. */
  warning: "warning",
  /** Limit exceeded. */
  exceeded: "exceeded",
};
 
/**
 * Selects categories for which a limit is set for this month and calculates status.
 *
 * @param {Array<object>} categories — the entire category catalog
 * @param {Array<object>} allTransactions — all budget operations
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {Array<{
 *   name: string, icon: string, color: string,
 *   limit: number, spent: number, remaining: number,
 *   usageRatio: number, status: string,
 *   dailyAllowance: number | null, note: string,
 * }>}
 *
 *
 */
export function buildBudgetReport(categories, allTransactions, periodKey, referenceDate = new Date()) {
  const periodExpenses = filterTransactionsByPeriod(allTransactions, periodKey);
 
  const spentByCategory = new Map();
  for (const expense of periodExpenses) {
    spentByCategory.set(
      expense.category,
      (spentByCategory.get(expense.category) ?? 0) + expense.amount,
    );
  }
 
  return categories
    .filter((category) => category.limit > 0)
    .map((category) => {
      const spent = spentByCategory.get(category.name) ?? 0;
      const remaining = category.limit - spent;
      const usageRatio = spent / category.limit;
      const status = resolveBudgetStatus(usageRatio);
 
      return {
        name: category.name,
        icon: category.icon,
        color: category.color,
        limit: category.limit,
        spent,
        remaining,
        usageRatio,
        status,
        dailyAllowance: computeDailyAllowance(remaining, periodKey, referenceDate),
        note: buildBudgetNote(status, remaining, usageRatio, periodKey, referenceDate),
      };
    })
    .sort((left, right) => right.usageRatio - left.usageRatio);
}
 
/**
 * @param {number} usageRatio — fraction of spent limit
 * @returns {string} BUDGET_STATUS value
 *
 *
 */
export function resolveBudgetStatus(usageRatio) {
  if (usageRatio >= 1) return BUDGET_STATUS.exceeded;
  if (usageRatio >= BUDGET_WARNING_THRESHOLD) return BUDGET_STATUS.warning;
  return BUDGET_STATUS.safe;
}
 
/**
 * How much can be spent per day to stay within the amount.
 *
 * Doesn't make sense for completed months — returns null.
 *
 * Used twice: separately for each category and for the total
 * remaining budget. The formula is the same — that is why it is
 * extracted to a single place.
 *
 * @param {number} remainingAmount
 * @param {string} periodKey
 * @param {Date} referenceDate
 * @returns {number | null}
 *
 *
 */
export function computeDailyAllowance(remainingAmount, periodKey, referenceDate) {
  if (!isCurrentPeriod(periodKey, referenceDate)) return null;
 
  const remainingDays = remainingDaysInPeriod(periodKey, referenceDate);
  return remainingDays > 0 ? remainingAmount / remainingDays : 0;
}
 
/**
 * Short human-readable explanation for the progress bar.
 * @param {string} status
 * @param {number} remainingAmount
 * @param {number} usageRatio
 * @param {string} periodKey
 * @param {Date} referenceDate
 * @returns {string}
 *
 *
 */
function buildBudgetNote(status, remainingAmount, usageRatio, periodKey, referenceDate) {
  if (status === BUDGET_STATUS.exceeded) {
    return `Перевищено на ${Math.round((usageRatio - 1) * 100)}%`;
  }
 
  if (!isCurrentPeriod(periodKey, referenceDate)) {
    return status === BUDGET_STATUS.safe ? "В межах ліміту" : "Близько до ліміту";
  }
 
  if (status === BUDGET_STATUS.warning) {
    return `Залишилось ${Math.max(remainingAmount, 0)} ₴ — останні ${Math.round((1 - usageRatio) * 100)}%`;
  }
 
  return `Залишилось ${Math.round(remainingAmount)} ₴`;
}
 
/**
 * Overall status of all limits for the "3 of 5 exceeded" badge.
 *
 * @param {Array<object>} budgetReport
 * @returns {{ totalCount: number, exceededCount: number, remainingAmount: number }}
 *
 *
 */
export function summarizeBudgetReport(budgetReport) {
  return budgetReport.reduce(
    (summary, item) => {
      summary.totalCount += 1;
      if (item.status === BUDGET_STATUS.exceeded) summary.exceededCount += 1;
      if (item.remaining > 0) summary.remainingAmount += item.remaining;
      return summary;
    },
    { totalCount: 0, exceededCount: 0, remainingAmount: 0 },
  );
}