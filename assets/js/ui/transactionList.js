/**
 * transactionList.js — transactions for the selected month: delete or
 * overwrite an existing record with one button.
 *
 *
 */

import { HISTORY_PAGE_SIZE } from "../config.js";
import { formatClockTime, formatCurrency, formatShortDate } from "../domain/formatters.js";
import { filterTransactionsByPeriod, takeRecentTransactions } from "../domain/statistics.js";
import { clearChildren, createElement, findById, on, setVisibility } from "./dom.js";

/**
 * @param {object} dependencies
 * @param {(transaction: object) => void} dependencies.onDeleteRequest
 * @param {(transaction: object) => void} dependencies.onEditRequest
 * @returns {{ render: (state: Readonly<object>, periodKey: string) => void }}
 *
 *
 */
export function initTransactionList({ onDeleteRequest, onEditRequest }) {
  const listElement = findById("transactionList");
  const emptyMessageElement = findById("transactionListEmpty");
  const countBadgeElement = findById("historyCountBadge");

  const categoryMetaByName = new Map();
  let isExpanded = false;

  /**
   * @param {Readonly<object>} state
   * @param {string} periodKey
   *
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

    // Sorting — always, in two states. Otherwise, the expanded list
    // would show records in the order they are in the table: the server does
    // not sort them, and `takeRecentTransactions` is the only place where
    // the order is defined.
    const transactionsToRender = takeRecentTransactions(
      periodTransactions,
      isExpanded ? periodTransactions.length : HISTORY_PAGE_SIZE,
    );

    const hasHiddenRows = periodTransactions.length > HISTORY_PAGE_SIZE;

    setVisibility(emptyMessageElement, transactionsToRender.length === 0);
    clearChildren(listElement);

    for (const transaction of transactionsToRender) {
      listElement.append(createTransactionItem(transaction));
    }

    if (hasHiddenRows) {
      const hiddenCount = periodTransactions.length - HISTORY_PAGE_SIZE;
      const expandButton = createElement("button", {
        className: "expand-link",
        textContent: isExpanded ? "Сховати" : `Показати всі транзакції (${hiddenCount})`,
        attributes: { type: "button" },
      });

      on(expandButton, "click", () => {
        isExpanded = !isExpanded;
        render(state, periodKey);
      });

      // Button is a list element, so we wrap it in <li>: otherwise the button
      // would be directly in <ul>, which is incorrect markup.
      listElement.append(createElement("li", { className: "transaction-list__more", children: [expandButton] }));
    }
  }

  /**
   * @param {object} transaction
   * @returns {HTMLElement}
   *
   */
  function createTransactionItem(transaction) {
    const categoryMeta = categoryMetaByName.get(transaction.category);

    const itemElement = createElement("li", { className: "transaction" });
    itemElement.dataset.pending = String(transaction.pending === true);

    const iconElement = createElement("span", {
      className: "transaction__icon",
      // Category might have been removed from the table — then a neutral
      // dot remains in the history so that the old record doesn't disappear for no reason.
      textContent: categoryMeta?.icon ?? "•",
      attributes: { "aria-hidden": "true" },
    });

    const bodyElement = createElement("span", { className: "transaction__body" });
    bodyElement.append(
      createElement("span", {
        className: "transaction__title",
        textContent: transaction.category,
      }),
    );

    // Comment — as a separate line. Next to the date and category, it
    // used to take up two or three words, and on a phone, it was a line
    // with no content: only the beginning was visible.
    if (transaction.note) {
      bodyElement.append(
        createElement("span", {
          className: "transaction__note",
          textContent: transaction.note,
        }),
      );
    }

    bodyElement.append(
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
      className: "transaction__action",
      textContent: "✕",
      attributes: { type: "button", "aria-label": `Видалити операцію «${transaction.category}»` },
    });
    on(deleteButtonElement, "click", () => onDeleteRequest(transaction));

    // Editing goes into the same form as adding: a separate screen
    // for it would mean a second validation, a second sum expression analysis
    // and a second set of filling rules.
    const editButtonElement = createElement("button", {
      className: "transaction__action",
      textContent: "✎",
      attributes: { type: "button", "aria-label": `Редагувати операцію «${transaction.category}»` },
    });
    on(editButtonElement, "click", () => onEditRequest(transaction));

    const actionsElement = createElement("span", { className: "transaction__actions" });
    actionsElement.append(editButtonElement, deleteButtonElement);

    itemElement.append(iconElement, bodyElement, amountElement, actionsElement);
    return itemElement;
  }

  /**
   * Third line: when the spending occurred and who submitted it.
   *
   * @param {object} transaction
   * @returns {string}
   *
   */
  function buildMetaLine(transaction) {
    const clockTime = formatClockTime(transaction.occurredOn);
    const datePart = formatShortDate(transaction.occurredOn);
    // Time is shown only if it actually exists: in old records
    // it's missing, and an empty string would look like a formatting bug.
    const whenPart = clockTime ? `${datePart}, ${clockTime}` : datePart;

    return `${whenPart} · ${transaction.user || "—"}`;
  }

  return { render };
}