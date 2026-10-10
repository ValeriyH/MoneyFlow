/**
 * statistics.js — агрегація операцій за місяць.
 * Чисті функції без побічних ефектів: на вход масив операцій,
 * на виході готовий опис для відтворення в UI.
 */

import { TRANSACTION_KIND } from "../config.js";
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
 * Тип операції у форматі API — «expense» або «income».
 *
 * Сервер уже надсилає саме так, але таблиця може прийти зі старих
 * кешів або з ручного рядка, де тип записано українською.
 * Клієнт не має на цьому ламатися й нульових цифр.
 *
 * @param {unknown} rawKind
 * @returns {'expense' | 'income'}
 */
export function normalizeTransactionKind(rawKind) {
  const normalizedValue = String(rawKind ?? "").trim().toLowerCase();

  const incomeAliases = ["дохід", "доход", "income", "in", "зарплата", "+"];
  return incomeAliases.includes(normalizedValue) ? "income" : "expense";
}

/**
 * Сума всіх операцій певного типу.
 * @param {Array<object>} transactions
 * @param {string} kind
 * @returns {number}
 */
function totalByKind(transactions, kind) {
  return transactions
    .filter((transaction) => normalizeTransactionKind(transaction.kind) === kind)
    .reduce((runningTotal, transaction) => runningTotal + transaction.amount, 0);
}

/**
 * Повний звіт за місяць: баланс, структура витрат, прогноз, динаміка.
 *
 * @param {Array<object>} allTransactions — усі операції бюджету
 * @param {Array<object>} categories — каталог для іконок і кольорів
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {{
 *   periodKey: string,
 *   expenseTotal: number,
 *   incomeTotal: number,
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

  const expenseTotal = totalByKind(periodTransactions, TRANSACTION_KIND.expense);
  const incomeTotal = totalByKind(periodTransactions, TRANSACTION_KIND.income);

  const elapsedDays = Math.max(elapsedDaysInPeriod(periodKey, referenceDate), 1);
  const previousPeriodTotal = totalByKind(
    filterTransactionsByPeriod(allTransactions, shiftPeriodKey(periodKey, -1)),
    TRANSACTION_KIND.expense,
  );

  return {
    periodKey,
    expenseTotal,
    incomeTotal,
    balance: incomeTotal - expenseTotal,
    transactionCount: periodTransactions.length,
    dailyAverageExpense: expenseTotal / elapsedDays,
    projectedExpenseTotal: isCurrentPeriod(periodKey, referenceDate)
      ? (expenseTotal / elapsedDays) * daysInPeriod(periodKey)
      : expenseTotal,
    previousPeriodExpenseTotal: previousPeriodTotal,
    remainingDays: remainingDaysInPeriod(periodKey, referenceDate),
    categoryBreakdown: buildCategoryBreakdown(
      periodTransactions.filter((transaction) => normalizeTransactionKind(transaction.kind) === TRANSACTION_KIND.expense),
      categories,
      expenseTotal,
    ),
  };
}

/**
 * Розподіл витрат по категоріях, відсортований від більшого до меншого.
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