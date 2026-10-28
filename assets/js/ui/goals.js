/**
 * goals.js — "Goals" tab.
 *
 * Shows a list of active goals with a progress bar and a monthly requirement.
 * Goals are loaded along with the budget snapshot via budgetStore
 * (fetchBudgetSnapshot → fetchGoals on the server).
 * The only client-side action — adjusting the current amount via a modal window.
 *
 *
 */

import { budgetStore } from "../core/budgetStore.js";
import { formatCurrency } from "../domain/formatters.js";
import { currentPeriodKey } from "../domain/period.js";
import { showToast } from "./toast.js";

const TAB_ID = "goals";
const MAX_ADJUST_AMOUNT = 999999;

let isAdjusting = false;

const goalsContainer = document.getElementById("goals-container");
const adjustModal = document.getElementById("goal-adjust-modal");

/**
 * Displays the "Goals" tab.
 *
 *
 */
export async function showGoalsTab() {
  document.body.dataset.tab = TAB_ID;

  if (!goalsContainer) return;

  // Cached goals are shown right away: the network may be slow or absent,
  // and a failed load must not leave the tab empty.
  renderGoalsList(goalsContainer, budgetStore.getState().goals);

  // Load the month — goals come with the budget snapshot
  try {
    await budgetStore.loadPeriod(currentPeriodKey());
  } catch (error) {
    console.warn("[MoneyFlow] Goals were not refreshed:", error);
    return;
  }

  renderGoalsList(goalsContainer, budgetStore.getState().goals);
}

/**
 * Save adjustment: sign = 1 for addition, -1 for subtraction.
 *
 *
 */
async function saveAdjust(sign) {
  // The buttons stay clickable while the request is in flight, so a
  // double tap on a slow connection would apply the adjustment twice.
  if (isAdjusting) return;

  const amountInput = document.getElementById("adjust-input");
  const amount = parseAmount(amountInput.value);
  if (amount === null) {
    showToast("Введіть коректну суму", "warning");
    return;
  }

  const goalId = amountInput.dataset.goalId;
  const goal = budgetStore.getState().goals.find((g) => String(g.id) === goalId);
  if (!goal) return;

  setAdjusting(true);
  try {
    const result = await budgetStore.adjustGoal({ id: goal.id, amount: sign * amount });
    if (!result.success && result.error) {
      showToast("Помилка коригування: " + result.error.message, "error");
      return;
    }
    renderGoalsList(goalsContainer, budgetStore.getState().goals);
    closeAdjustModal();
  } finally {
    setAdjusting(false);
  }
}

/**
 * Strict amount parsing: parseFloat would accept «100abc» as 100.
 * A comma is accepted as the decimal separator.
 *
 * @param {string} rawValue
 * @returns {number | null} positive amount with up to 2 decimals, or null if invalid
 */
function parseAmount(rawValue) {
  const normalized = String(rawValue).trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;

  const amount = Number(normalized);
  return amount > 0 && amount <= MAX_ADJUST_AMOUNT ? amount : null;
}

function setAdjusting(value) {
  isAdjusting = value;
  for (const id of ["adjust-add-btn", "adjust-subtract-btn"]) {
    const button = document.getElementById(id);
    if (button) button.disabled = value;
  }
}

function renderGoalsList(container, goals) {
  const activeGoals = (goals ?? []).filter((g) => g.active);

  if (activeGoals.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Ніяких активних цілей.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = activeGoals.map((goal) => {
    const goalId = escapeHtml(String(goal.id));
    const progress = Number.isFinite(goal.progress) ? Math.min(100, Math.max(0, goal.progress)) : 0;

    // Without a deadline the monthly requirement is 0 — showing «0 грн» would mislead.
    const requirementHtml = goal.deadline
      ? `<strong>Треба ${Number.isFinite(goal.monthlyRequirement) ? formatCurrency(goal.monthlyRequirement).replace('₴', 'грн') : '—'} щомісяця</strong>
          до ${escapeHtml(String(goal.deadline))}`
      : `<strong>Дедлайн не вказано</strong>`;

    return `
      <div class="goal-card" data-goal-id="${goalId}">
        <div class="goal-header">
          <div class="goal-name-wrapper">
            <span class="goal-name">${escapeHtml(goal.name)}</span>
          </div>
          <span class="goal-type">${goal.type === "Savings" ? "Накопичення" : "Проект"}</span>
        </div>

        <div class="progress-bar">
          <div class="progress-fill" style="width: ${progress}%"></div>
        </div>

        <div class="progress-text">
          <span class="progress-percent">Виконано ${progress}%</span>
        </div>

        <div class="monthly-requirement">
          ${requirementHtml}
        </div>

        <div class="goal-actions">
          <button class="adjust-btn btn-tertiary">Коригувати</button>
        </div>
      </div>
    `;
  }).join("");
}

function openAdjustModal(goal) {
  if (!adjustModal) return;
  const adjustInput = document.getElementById("adjust-input");
  if (adjustInput) {
    adjustInput.value = "";
    adjustInput.dataset.goalId = goal.id;
  }
  // Use setAttribute for easier state management
  adjustModal.removeAttribute("hidden");
  adjustModal.classList.add("show");
}

function closeAdjustModal() {
  if (!adjustModal) return;
  adjustModal.classList.remove("show");
  adjustModal.setAttribute("hidden", "");
}

/**
 * Event on the dynamically created "Adjust" button (delegation through the container).
 *
 *
 */
if (goalsContainer) {
  goalsContainer.addEventListener("click", (e) => {
    const adjustBtn = e.target.closest(".adjust-btn");
    if (!adjustBtn) return;

    const goalCard = adjustBtn.closest(".goal-card");
    const goalId = goalCard?.dataset.goalId;
    const goal = budgetStore.getState().goals.find((g) => String(g.id) === goalId);
    if (goal) openAdjustModal(goal);
  });
}

// "Add" button in the adjustment modal
const addBtn = document.getElementById("adjust-add-btn");
if (addBtn) {
  addBtn.addEventListener("click", () => saveAdjust(1));
}

// "Subtract" button in the adjustment modal
const subtractBtn = document.getElementById("adjust-subtract-btn");
if (subtractBtn) {
  subtractBtn.addEventListener("click", () => saveAdjust(-1));
}

// "Cross" button closes the pop-up
const cancelBtn = document.getElementById("cancel-adjust-btn");
if (cancelBtn) {
  cancelBtn.addEventListener("click", closeAdjustModal);
}

// Closing the modal on click outside
adjustModal?.addEventListener("click", (e) => {
  if (e.target === adjustModal) closeAdjustModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAdjustModal();
});

/**
 * Escapes HTML special characters.
 *
 * @param {string} text
 * @returns {string}
 *
 */
function escapeHtml(text) {
  // Quotes are escaped as well: the result is also used inside attributes,
  // where textContent → innerHTML would leave «"» untouched.
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}