/**
 * expenseList.js — expenses for the selected month: delete or
 * overwrite an existing record with one button.
 *
 *
 */

import { HISTORY_PAGE_SIZE } from "../config.js";
import { formatClockTime, formatCurrency, formatShortDate } from "../domain/formatters.js";
import { filterExpensesByPeriod, takeRecentExpenses } from "../domain/statistics.js";
import { clearChildren, createElement, findById, on, setVisibility } from "./dom.js";

/**
 * @param {object} dependencies
 * @param {(expense: object) => void} dependencies.onDeleteRequest
 * @param {(expense: object) => void} dependencies.onEditRequest
 * @returns {{ render: (state: Readonly<object>, periodKey: string) => void }}
 *
 *
 */
export function initExpenseList({ onDeleteRequest, onEditRequest }) {
  const listElement = findById("expenseList");
  const emptyMessageElement = findById("expenseListEmpty");
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

    const periodExpenses = filterExpensesByPeriod(state.expenses, periodKey);

    countBadgeElement.textContent = periodExpenses.length
      ? `${periodExpenses.length} витрат`
      : "—";

    // Sorting — always, in two states. Otherwise, the expanded list
    // would show records in the order they are in the table: the server does
    // not sort them, and `takeRecentExpenses` is the only place where
    // the order is defined.
    const expensesToRender = takeRecentExpenses(
      periodExpenses,
      isExpanded ? periodExpenses.length : HISTORY_PAGE_SIZE,
    );

    const hasHiddenRows = periodExpenses.length > HISTORY_PAGE_SIZE;

    setVisibility(emptyMessageElement, expensesToRender.length === 0);
    clearChildren(listElement);

    for (const expense of expensesToRender) {
      listElement.append(createExpenseItem(expense));
    }

    if (hasHiddenRows) {
      const hiddenCount = periodExpenses.length - HISTORY_PAGE_SIZE;
      const expandButton = createElement("button", {
        className: "expand-link",
        textContent: isExpanded ? "Сховати" : `Показати всі витрати (${hiddenCount})`,
        attributes: { type: "button" },
      });

      on(expandButton, "click", () => {
        isExpanded = !isExpanded;
        render(state, periodKey);
      });

      // Button is a list element, so we wrap it in <li>: otherwise the button
      // would be directly in <ul>, which is incorrect markup.
      listElement.append(createElement("li", { className: "expense-list__more", children: [expandButton] }));
    }
  }

  /**
   * @param {object} expense
   * @returns {HTMLElement}
   *
   */
  function createExpenseItem(expense) {
    const categoryMeta = categoryMetaByName.get(expense.category);

    const itemElement = createElement("li", { className: "expense" });
    itemElement.dataset.pending = String(expense.pending === true);

    const iconElement = createElement("span", {
      className: "expense__icon",
      // Category might have been removed from the table — then a neutral
      // dot remains in the history so that the old record doesn't disappear for no reason.
      textContent: categoryMeta?.icon ?? "•",
      attributes: { "aria-hidden": "true" },
    });

    const bodyElement = createElement("span", { className: "expense__body" });
    bodyElement.append(
      createElement("span", {
        className: "expense__title",
        textContent: expense.category,
      }),
    );

    // Comment — as a separate line. Next to the date and category, it
    // used to take up two or three words, and on a phone, it was a line
    // with no content: only the beginning was visible.
    if (expense.note) {
      bodyElement.append(
        createElement("span", {
          className: "expense__note",
          textContent: expense.note,
        }),
      );
    }

    bodyElement.append(
      createElement("span", {
        className: "expense__meta",
        textContent: buildMetaLine(expense),
      }),
    );

    const amountElement = createElement("span", {
      className: "expense__amount",
      textContent: `−${formatCurrency(expense.amount)}`,
    });

    const deleteButtonElement = createElement("button", {
      className: "icon-action icon-action--danger",
      textContent: "🗑",
      attributes: { type: "button", "aria-label": `Видалити витрату «${expense.category}»` },
    });
    on(deleteButtonElement, "click", () => onDeleteRequest(expense));

    // Editing goes into the same form as adding: a separate screen
    // for it would mean a second validation, a second sum expression analysis
    // and a second set of filling rules.
    const editButtonElement = createElement("button", {
      className: "icon-action",
      textContent: "✎",
      attributes: { type: "button", "aria-label": `Редагувати витрату «${expense.category}»` },
    });
    on(editButtonElement, "click", () => onEditRequest(expense));

    const actionsElement = createElement("span", { className: "expense__actions" });
    actionsElement.append(editButtonElement, deleteButtonElement);

    itemElement.append(iconElement, bodyElement, amountElement, actionsElement);
    return itemElement;
  }

  /**
   * Third line: when the spending occurred and who submitted it.
   *
   * @param {object} expense
   * @returns {string}
   *
   */
  function buildMetaLine(expense) {
    const clockTime = formatClockTime(expense.occurredOn);
    const datePart = formatShortDate(expense.occurredOn);
    // Time is shown only if it actually exists: in old records
    // it's missing, and an empty string would look like a formatting bug.
    const whenPart = clockTime ? `${datePart}, ${clockTime}` : datePart;

    return `${whenPart} · ${expense.user || "—"}`;
  }

  return { render };
}