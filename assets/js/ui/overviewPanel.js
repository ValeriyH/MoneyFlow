/**
 * overviewPanel.js — monthly summary: balance remaining from budget, spending,
 * average per day, projection, and dynamics compared to the previous month,
 * as well as a donut distribution of spending by categories.
 *
 *
 */

import { computeDailyAllowance } from "../domain/budget.js";
import {
  describeChangeRate,
  formatCompactCurrency,
  formatCurrency,
  formatPercentage,
} from "../domain/formatters.js";
import { buildPeriodSummary } from "../domain/statistics.js";
import { clearChildren, createElement, findById, setVisibility } from "./dom.js";

/** Number of categories to show in the legend — the rest go into "and other N". */
const LEGEND_CATEGORY_LIMIT = 6;

/** @returns {{ render: (state: Readonly<object>) => void }} */
export function initOverviewPanel() {
  const balanceValueElement = findById("balanceValue");
  const balanceMetaElement = findById("balanceMeta");
  const expenseTotalValueElement = findById("expenseTotalValue");
  const budgetTotalValueElement = findById("budgetTotalValue");
  const dailyAverageValueElement = findById("dailyAverageValue");
  const projectionValueElement = findById("projectionValue");
  const monthOverMonthValueElement = findById("monthOverMonthValue");

  const donutBlockElement = findById("donutBlock");
  const donutElement = findById("categoryDonut");
  const legendElement = findById("categoryLegend");

  /**
   * @param {Readonly<object>} state
   * @param {string} periodKey
   * @param {Date} referenceDate
   */
  function render(state, periodKey, referenceDate) {
    const summary = buildPeriodSummary(
      state.transactions,
      state.categories,
      periodKey,
      referenceDate,
    );

    renderBalance(summary, periodKey, referenceDate);
    renderTotals(summary);
    renderFacts(summary);
    renderCategoryDonut(summary);
  }

  /**
   * Main number — the balance remaining from the budget. Below it is not "how many transactions",
   * but a practical advice: how much you can spend per day to stay within budget.
   * Calculated based on total balance, without distinction by categories.
   *
   * @param {ReturnType<typeof buildPeriodSummary>} summary
   * @param {string} periodKey
   * @param {Date} referenceDate
   */
  function renderBalance(summary, periodKey, referenceDate) {
    balanceValueElement.textContent = formatCurrency(summary.balance);
    balanceValueElement.dataset.tone = summary.balance >= 0 ? "positive" : "negative";

    balanceMetaElement.textContent = buildBalanceMeta(summary, periodKey, referenceDate);
  }

  /**
   * @param {ReturnType<typeof buildPeriodSummary>} summary
   * @param {string} periodKey
   * @param {Date} referenceDate
   * @returns {string}
   */
  function buildBalanceMeta(summary, periodKey, referenceDate) {
    const dailyAllowance = computeDailyAllowance(summary.balance, periodKey, referenceDate);

    // Previous month has already finished — "daily allowance" doesn't make sense here,
    // so we keep what is true about it: how many transactions were in it.
    if (dailyAllowance === null) {
      return summary.transactionCount === 0
        ? "Операцій за цей місяць ще немає"
        : `${summary.transactionCount} операцій за цей місяць`;
    }

    if (summary.balance < 0) {
      return `Витрачено понад бюджет на ${formatCurrency(Math.abs(summary.balance))}`;
    }

    if (summary.balance === 0) return "Витрачено рівно весь бюджет";

    return `Ліміт витрат на день ${formatCurrency(dailyAllowance)}`;
  }

  /** @param {ReturnType<typeof buildPeriodSummary>} summary */
  function renderTotals(summary) {
    expenseTotalValueElement.textContent = formatCurrency(summary.expenseTotal);
    budgetTotalValueElement.textContent = formatCurrency(summary.budgetTotal);
  }

  /** @param {ReturnType<typeof buildPeriodSummary>} summary */
  function renderFacts(summary) {
    dailyAverageValueElement.textContent = formatCurrency(summary.dailyAverageExpense);

    renderProjection(summary);
    renderMonthOverMonth(summary);
  }

  /** @param {ReturnType<typeof buildPeriodSummary>} summary */
  function renderProjection(summary) {
    if (summary.expenseTotal === 0) {
      projectionValueElement.textContent = "—";
      delete projectionValueElement.dataset.tone;
      return;
    }

    projectionValueElement.textContent = formatCurrency(summary.projectedExpenseTotal);

    // These are expenses, not balances, - so they are always red, regardless
    // of the comparison with the previous month.
    projectionValueElement.dataset.tone = "negative";

    // There was a constant complaint about the mismatch between the label and the number,
    // so the tooltip explicitly describes how the number was obtained.
    projectionValueElement.title =
      `Зараз ${formatCurrency(summary.dailyAverageExpense)} на день.\n` +
      `Якщо витрачатимете так само весь місяць — ` +
      `${formatCurrency(summary.projectedExpenseTotal)}.`;
  }

  /** @param {ReturnType<typeof buildPeriodSummary>} summary */
  function renderMonthOverMonth(summary) {
    const expenseChange = describeChangeRate(
      summary.expenseTotal,
      summary.previousPeriodExpenseTotal,
    );

    if (!expenseChange.hasBaseline) {
      monthOverMonthValueElement.textContent = "немає бази для порівняння";
      delete monthOverMonthValueElement.dataset.tone;
      return;
    }

    if (expenseChange.percent === 0) {
      monthOverMonthValueElement.textContent = "без змін";
      delete monthOverMonthValueElement.dataset.tone;
      return;
    }

    monthOverMonthValueElement.textContent =
      `${expenseChange.percent > 0 ? "+" : "−"}${formatPercentage(Math.abs(expenseChange.percent))}`;

    monthOverMonthValueElement.dataset.tone = expenseChange.tone;
    monthOverMonthValueElement.title =
      expenseChange.tone === "negative"
        ? "Витрати вище, ніж минулого місяця"
        : "Витрати нижче, ніж минулого місяця";
  }

  /** @param {ReturnType<typeof buildPeriodSummary>} summary */
  function renderCategoryDonut(summary) {
    const { categoryBreakdown } = summary;

    if (categoryBreakdown.length === 0) {
      setVisibility(donutBlockElement, false);
      return;
    }

    setVisibility(donutBlockElement, true);
    donutElement.style.background = buildDonutGradient(categoryBreakdown);

    clearChildren(legendElement);

    const leadingCategories = categoryBreakdown.slice(0, LEGEND_CATEGORY_LIMIT);
    for (const categoryShare of leadingCategories) {
      legendElement.append(createLegendItem(categoryShare));
    }

    const hiddenShareTotal = categoryBreakdown
      .slice(LEGEND_CATEGORY_LIMIT)
      .reduce((sum, category) => sum + category.share, 0);

    if (hiddenShareTotal > 0) {
      legendElement.append(
        createElement("li", {
          className: "legend__item",
          textContent: `та ще ${categoryBreakdown.length - LEGEND_CATEGORY_LIMIT} · ${formatPercentage(hiddenShareTotal)}`,
        }),
      );
    }
  }

  /**
   * Ring with sectors using conic-gradient — without external libraries.
   * @param {Array<{ color: string, share: number }>} categoryBreakdown
   * @returns {string} value of the CSS property background
   *
   */
  function buildDonutGradient(categoryBreakdown) {
    const gradientStops = [];
    let accumulatedShare = 0;

    for (const categoryShare of categoryBreakdown) {
      const startPercent = accumulatedShare * 100;
      accumulatedShare += categoryShare.share;
      const endPercent = accumulatedShare * 100;
      gradientStops.push(`${categoryShare.color} ${startPercent}% ${endPercent}%`);
    }

    return `conic-gradient(${gradientStops.join(", ")})`;
  }

  /**
   * @param {{ name: string, color: string, total: number, share: number }} categoryShare
   * @returns {HTMLElement}
   *
   */
  function createLegendItem(categoryShare) {
    const legendItemElement = createElement("li", { className: "legend__item" });

    legendItemElement.append(
      createElement("span", {
        className: "legend__swatch",
        attributes: { style: `background-color: ${categoryShare.color}` },
      }),
      createElement("span", { className: "legend__name", textContent: categoryShare.name }),
      createElement("span", {
        className: "legend__value",
        textContent: formatCompactCurrency(categoryShare.total),
      }),
      createElement("span", {
        className: "legend__share",
        textContent: formatPercentage(categoryShare.share),
      }),
    );

    return legendItemElement;
  }

  return { render };
}