/**
 * transactionList.js — історія операцій за обраний місяць
 * із можливістю видалити запис однією кнопкою.
 */

import { HISTORY_PAGE_SIZE } from "../config.js";
import { formatCurrency, formatFullDate } from "../domain/formatters.js";
import { filterTransactionsByPeriod, takeRecentTransactions } from "../domain/statistics.js";
import { clearChildren, createElement, findById, on, setVisibility } from "./dom.js";

/**
 * @param {object} dependencies
 * @param {(transaction: object) => void} dependencies.onDeleteRequest
 */
export function initTransactionList({ onDeleteRequest }) {
  const listElement = findById("transactionList");
  const emptyMessageElement = findById("transactionListEmpty");
  const countBadgeElement = findById("historyCountBadge");

  const categoryMetaByName = new Map();

  /**
   * @param {Readonly<object>} state
   * @param {string} periodKey
   */
  function render(state, periodKey) {
    categoryMetaByName.clear();
    for (const category of state.categories) {
      categoryMetaByName.set(category.name, category);
    }

    const periodTransactions = filterTransactionsByPeriod(state.transactions, periodKey);

    countBadgeElement.textContent = periodTransactions.length
      ? `${periodTransactions.length} операцій`
      : "—";

    const recentTransactions = takeRecentTransactions(periodTransactions, HISTORY_PAGE_SIZE);
    const hasHiddenRows = periodTransactions.length > recentTransactions.length;

    setVisibility(emptyMessageElement, recentTransactions.length === 0);
    clearChildren(listElement);

    for (const transaction of recentTransactions) {
      listElement.append(createTransactionItem(transaction));
    }

    if (hasHiddenRows) {
      listElement.append(
        createElement("li", {
          className: "card__empty",
          textContent: `…і ще ${periodTransactions.length - recentTransactions.length} операцій цього місяця`,
        }),
      );
    }
  }

  /**
   * @param {object} transaction
   * @returns {HTMLElement}
   */
  function createTransactionItem(transaction) {
    const categoryMeta = categoryMetaByName.get(transaction.category);

    const itemElement = createElement("li", { className: "transaction" });
    itemElement.dataset.pending = String(transaction.pending === true);

    const iconElement = createElement("span", {
      className: "transaction__icon",
      // Категорію могли прибрати з таблиці — тоді в історії лишається
      // нейтральна крапка, щоб старий запис не зник без причини.
      textContent: categoryMeta?.icon ?? "•",
      attributes: { "aria-hidden": "true" },
    });

    const bodyElement = createElement("span", { className: "transaction__body" });
    bodyElement.append(
      createElement("span", {
        className: "transaction__title",
        textContent: transaction.category,
      }),
      createElement("span", {
        className: "transaction__meta",
        textContent: buildMetaLine(transaction),
      }),
    );

    const amountElement = createElement("span", {
      className: "transaction__amount",
      textContent: `−${formatCurrency(transaction.amount)}`,
    });

    const deleteButtonElement = createElement("button", {
      className: "transaction__delete",
      textContent: "✕",
      attributes: { type: "button", "aria-label": `Видалити операцію «${transaction.category}»` },
    });
    on(deleteButtonElement, "click", () => onDeleteRequest(transaction));

    itemElement.append(iconElement, bodyElement, amountElement, deleteButtonElement);
    return itemElement;
  }

  /**
   * @param {object} transaction
   * @returns {string}
   */
  function buildMetaLine(transaction) {
    const noteSuffix = transaction.note ? ` · ${transaction.note}` : "";
    return `${formatFullDate(transaction.occurredOn)} · ${transaction.user || "—"}${noteSuffix}`;
  }

  return { render };
}