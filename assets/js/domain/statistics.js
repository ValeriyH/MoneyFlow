/**
 * statistics.js — агрегація операцій за місяць.
 * Чисті функції без побічних ефектів: на вход масив операцій,
 * на виході готовий опис для відтворення в UI.
 */

import {
  daysInPeriod,
  elapsedDaysInPeriod,
  isCurrentPeriod,
  remainingDaysInPeriod,
  shiftPeriodKey,
} from "./period.js";

/**
 * Відбирає операції, що належать заданому місяцю.
 * @param {Array<object>} transactions
 * @param {string} periodKey — «2026-10»
 * @returns {Array<object>}
 */
export function filterTransactionsByPeriod(transactions, periodKey) {
  return transactions.filter(
    (transaction) => typeof transaction.occurredOn === "string" &&
      transaction.occurredOn.startsWith(periodKey),
  );
}

/**
 * Сума операцій.
 * @param {Array<object>} transactions
 * @returns {number}
 */
function totalAmount(transactions) {
  return transactions.reduce((runningTotal, transaction) => runningTotal + transaction.amount, 0);
}

/**
 * Загальний бюджет на місяць: сума лімітів усіх категорій.
 *
 * Ліміти приходять із сервера вже відфільтрованими за місяцем,
 * тому сума береться проста. Категорії без ліміта в бюджет не
 * входять, але лишаються доступними для введення витрат.
 *
 * @param {Array<object>} categories
 * @returns {number}
 */
export function totalBudgetForPeriod(categories) {
  return categories.reduce((runningTotal, category) => runningTotal + (category.limit ?? 0), 0);
}

/**
 * Повний звіт за місяць: залишок, структура витрат, прогноз, динаміка.
 *
 * @param {Array<object>} allTransactions — усі операції бюджету
 * @param {Array<object>} categories — каталог для іконок, кольорів і лімітів
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {{
 *   periodKey: string,
 *   expenseTotal: number,
 *   budgetTotal: number,
 *   balance: number,
 *   transactionCount: number,
 *   dailyAverageExpense: number,
 *   projectedExpenseTotal: number,
 *   previousPeriodExpenseTotal: number,
 *   categoryBreakdown: Array<object>,
 * }}
 */
export function buildPeriodSummary(allTransactions, categories, periodKey, referenceDate = new Date()) {
  const periodTransactions = filterTransactionsByPeriod(allTransactions, periodKey);

  const expenseTotal = totalAmount(periodTransactions);
  const budgetTotal = totalBudgetForPeriod(categories);

  const elapsedDays = Math.max(elapsedDaysInPeriod(periodKey, referenceDate), 1);
  const previousPeriodTotal = totalAmount(
    filterTransactionsByPeriod(allTransactions, shiftPeriodKey(periodKey, -1)),
  );

  return {
    periodKey,
    expenseTotal,
    budgetTotal,
    balance: budgetTotal - expenseTotal,
    transactionCount: periodTransactions.length,
    dailyAverageExpense: expenseTotal / elapsedDays,
    projectedExpenseTotal: isCurrentPeriod(periodKey, referenceDate)
      ? (expenseTotal / elapsedDays) * daysInPeriod(periodKey)
      : expenseTotal,
    previousPeriodExpenseTotal: previousPeriodTotal,
    remainingDays: remainingDaysInPeriod(periodKey, referenceDate),
    categoryBreakdown: buildCategoryBreakdown(periodTransactions, categories, expenseTotal),
  };
}

/**
 * Розподіл витрат по категоріях, відсортований від більшого до меншого.
 *
 * Категорія, якої вже немає в каталозі, не зникає з історії:
 * вона показується нейтральною крапкою. Тому старі записи лишаються
 * читабельними, навіть якщо категорію прибрали з таблиці.
 *
 * @param {Array<object>} expenseTransactions
 * @param {Array<object>} categories
 * @param {number} expenseTotal — для розрахунку часток
 * @returns {Array<{ name: string, icon: string, color: string, total: number, share: number }>}
 */
export function buildCategoryBreakdown(expenseTransactions, categories, expenseTotal) {
  const categoryMetaByName = new Map(
    categories.map((category) => [category.name, category]),
  );

  const totalByCategoryName = new Map();
  for (const transaction of expenseTransactions) {
    totalByCategoryName.set(
      transaction.category,
      (totalByCategoryName.get(transaction.category) ?? 0) + transaction.amount,
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
 * Останні операції для списку історії: новіші спершу,
 * обрізані до `pageSize`.
 *
 * @param {Array<object>} transactions
 * @param {number} pageSize
 * @returns {Array<object>}
 */
export function takeRecentTransactions(transactions, pageSize) {
  return [...transactions]
    .sort((left, right) =>
      (right.recordedAt ?? "").localeCompare(left.recordedAt ?? "") ||
      (right.occurredOn ?? "").localeCompare(left.occurredOn ?? ""),
    )
    .slice(0, pageSize);
}