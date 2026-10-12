/**
 * budgetPanel.js — список лімітів по категоріях із прогрес-барами.
 * Показує не «відсоток виконання», а живі цифри: скільки витрачено,
 * скільки лишилось і скільки можна витрачати на день.
 */

import { formatCurrency, formatPercentage } from "../domain/formatters.js";
import { BUDGET_STATUS, buildBudgetReport, summarizeBudgetReport } from "../domain/budget.js";
import { clearChildren, createElement, findById, setVisibility } from "./dom.js";

export function initBudgetPanel() {
  const budgetListElement = findById("budgetPanelList");
  const budgetEmptyMessageElement = findById("budgetEmptyMessage");
  const budgetBadgeElement = findById("budgetRemainingBadge");

  /**
   * @param {Readonly<object>} state
   * @param {string} periodKey
   * @param {Date} referenceDate
   */
  function render(state, periodKey, referenceDate) {
    const budgetReport = buildBudgetReport(
      state.categories,
      state.transactions,
      periodKey,
      referenceDate,
    );

    clearChildren(budgetListElement);
    setVisibility(budgetEmptyMessageElement, budgetReport.length === 0);

    // Бейдж скидаємо ЗАВЖДИ, до раннього виходу. Інакше на місяці без
    // бюджету він показував би «Загалом …» із попереднього місяця —
    // цифра, якої на екрані не відповідає ніщо.
    budgetBadgeElement.textContent =
      budgetReport.length === 0 ? "—" : buildBadgeText(budgetReport);

    if (budgetReport.length === 0) return;

    for (const budgetItem of budgetReport) {
      budgetListElement.append(createBudgetItem(budgetItem));
    }
  }

  /**
   * @param {Array<object>} budgetReport
   * @returns {string}
   */
  function buildBadgeText(budgetReport) {
    const summary = summarizeBudgetReport(budgetReport);

    if (summary.exceededCount > 0) {
      return `${summary.exceededCount} із ${summary.totalCount} перевищено`;
    }

    return `Загалом ${formatCurrency(summary.remainingAmount)}`;
  }

  /**
   * @param {object} budgetItem
   * @returns {HTMLElement}
   */
  function createBudgetItem(budgetItem) {
    const itemElement = createElement("div", { className: "budget-item" });
    itemElement.dataset.status = budgetItem.status;

    const headElement = createElement("div", { className: "budget-item__head" });
    headElement.append(
      createElement("span", {
        className: "budget-item__dot",
        attributes: { style: `background-color: ${budgetItem.color}`, "aria-hidden": "true" },
      }),
      createElement("span", {
        className: "budget-item__name",
        textContent: `${budgetItem.icon ?? "•"} ${budgetItem.name}`,
      }),
      createAmountsElement(budgetItem),
    );

    const trackElement = createElement("div", { className: "budget-item__track" });
    const fillElement = createElement("div", { className: "budget-item__fill" });
    fillElement.style.width = `${clampProgressWidth(budgetItem.usageRatio)}%`;
    trackElement.append(fillElement);

    const noteElement = createElement("div", {
      className: "budget-item__note",
      textContent: buildNoteText(budgetItem),
    });
    noteElement.dataset.status = budgetItem.status;

    itemElement.append(headElement, trackElement, noteElement);
    return itemElement;
  }

  /**
   * Ширина смужки залишається в межах 100%, інакше перевищення
   * «з'їдає» сосідні елементи.
   *
   * @param {number} usageRatio
   * @returns {number}
   */
  function clampProgressWidth(usageRatio) {
    return Math.min(Math.max(usageRatio * 100, 2), 100);
  }

  /**
   * @param {object} budgetItem
   * @returns {HTMLElement}
   */
  function createAmountsElement(budgetItem) {
    const amountsElement = createElement("span", { className: "budget-item__amounts" });
    amountsElement.append(
      createElement("strong", { textContent: formatCurrency(budgetItem.spent) }),
      document.createTextNode(` / ${formatCurrency(budgetItem.limit)}`),
    );
    return amountsElement;
  }

  /**
   * @param {object} budgetItem
   * @returns {string}
   */
  function buildNoteText(budgetItem) {
    if (budgetItem.status === BUDGET_STATUS.exceeded) {
      return `Перевищено на ${formatCurrency(Math.abs(budgetItem.remaining))}`;
    }

    if (budgetItem.dailyAllowance !== null) {
      return `${budgetItem.note} · на день можна ${formatCurrency(budgetItem.dailyAllowance)}`;
    }

    return `${budgetItem.note} · ${formatPercentage(budgetItem.usageRatio)}`;
  }

  return { render };
}