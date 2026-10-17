/**
 * transactionList.js — транзакції за обраний місяць: видалити або
 * переписати наявний запис однією кнопкою.
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

    // Сортування — завжди, у двох станах. Інакше розгорнутий список
    // показував би записи в порядку таблиці: сервер їх не
    // впорядковує, а `takeRecentTransactions` єдине місце, де
    // визначено порядок.
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

      // Кнопка — елемент списку, тож обгортаємо в <li>: інакше в <ul>
      // лежить кнопка, а це некоректна розмітка.
      listElement.append(createElement("li", { className: "transaction-list__more", children: [expandButton] }));
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
    );

    // Комент — окремим рядком. Поруч із датою й категорією він
    // уміщався на два-три слова, а на телефоні це був рядок
    // без змісту: видно було тільки початок.
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

    // Правка йде у ту саму форму, що й додавання: окремий екран
    // для неї означав би другу валідацію, другий розбір виразу суми
    // й другий набір правил наповнення.
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
   * Третій рядок: коли витрата й хто її вніс.
   *
   * @param {object} transaction
   * @returns {string}
   */
  function buildMetaLine(transaction) {
    const clockTime = formatClockTime(transaction.occurredOn);
    const datePart = formatShortDate(transaction.occurredOn);
    // Час показуємо лише тоді, коли він реально є: у старих записах
    // його немає, і порожній рядок виглядав би як недолік формату.
    const whenPart = clockTime ? `${datePart}, ${clockTime}` : datePart;

    return `${whenPart} · ${transaction.user || "—"}`;
  }

  return { render };
}