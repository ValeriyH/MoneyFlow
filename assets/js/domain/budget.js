/**
 * budget.js — порівняння витрат із плановими лімітами.
 * Ліміти живуть у таблиці (аркуш Categories, стовпець «Ліміт, ₴»),
 * тому код лише рахує, а не зберігає правила.
 */

import { BUDGET_WARNING_THRESHOLD } from "../config.js";
import { isCurrentPeriod, remainingDaysInPeriod } from "./period.js";
import { filterTransactionsByPeriod, normalizeTransactionKind } from "./statistics.js";

/** Стан ліміту відносно витраченого. */
export const BUDGET_STATUS = {
  /** Витрачено менше порогу попередження. */
  safe: "safe",
  /** Витрачено близько ліміту. */
  warning: "warning",
  /** Ліміт перевищено. */
  exceeded: "exceeded",
};

/**
 * Обирає категорії, для яких у таблиці задано ліміт, і рахує поточний стан.
 *
 * @param {Array<object>} categories — увесь каталог катег��рій
 * @param {Array<object>} allTransactions — усі операції бюджету
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {Array<{
 *   name: string, icon: string, color: string,
 *   limit: number, spent: number, remaining: number,
 *   usageRatio: number, status: string,
 *   dailyAllowance: number | null, note: string,
 * }>}
 */
export function buildBudgetReport(categories, allTransactions, periodKey, referenceDate = new Date()) {
  const periodExpenses = filterTransactionsByPeriod(allTransactions, periodKey).filter(
    (transaction) => normalizeTransactionKind(transaction.kind) === "expense",
  );

  const spentByCategory = new Map();
  for (const expense of periodExpenses) {
    spentByCategory.set(
      expense.category,
      (spentByCategory.get(expense.category) ?? 0) + expense.amount,
    );
  }

  return categories
    .filter((category) => category.limit > 0 && normalizeTransactionKind(category.kind) === "expense")
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
 * @param {number} usageRatio — частка використаного ліміту
 * @returns {string} значення BUDGET_STATUS
 */
export function resolveBudgetStatus(usageRatio) {
  if (usageRatio >= 1) return BUDGET_STATUS.exceeded;
  if (usageRatio >= BUDGET_WARNING_THRESHOLD) return BUDGET_STATUS.warning;
  return BUDGET_STATUS.safe;
}

/**
 * Скільки можна витрачати на день, щоб вкластися в ліміт.
 * Для завершених місяців не має сенсу — повертає null.
 *
 * @param {number} remainingAmount
 * @param {string} periodKey
 * @param {Date} referenceDate
 * @returns {number | null}
 */
function computeDailyAllowance(remainingAmount, periodKey, referenceDate) {
  if (!isCurrentPeriod(periodKey, referenceDate)) return null;

  const remainingDays = remainingDaysInPeriod(periodKey, referenceDate);
  return remainingDays > 0 ? remainingAmount / remainingDays : 0;
}

/**
 * Коротке людське пояснення під прогрес-баром.
 * @param {string} status
 * @param {number} remainingAmount
 * @param {number} usageRatio
 * @param {string} periodKey
 * @param {Date} referenceDate
 * @returns {string}
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
 * Загальний стан усіх лімітів для бейджа «3 з 5 перевищено».
 *
 * @param {Array<object>} budgetReport
 * @returns {{ totalCount: number, exceededCount: number, remainingAmount: number }}
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