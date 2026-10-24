/**
 * goals.js — вкладка «Цілі».
 *
 * Показує список активних цілей з прогрес-баром та щомісячним вимогою.
 * Цілі завантажуються разом із знімком бюджету через budgetStore
 * (fetchBudgetSnapshot → fetchGoals на сервері).
 * Єдина клієнтська дія — коригування поточної суми через модальне вікно.
 */

import { budgetStore } from "../core/budgetStore.js";
import { formatCurrency } from "../domain/formatters.js";
import { currentPeriodKey } from "../domain/period.js";

const TAB_ID = "goals";

const goalsContainer = document.getElementById("goals-container");
const adjustModal = document.getElementById("goal-adjust-modal");

/**
 * Відображає вкладку «Цілі».
 */
export async function showGoalsTab() {
  document.body.dataset.tab = TAB_ID;

  if (!goalsContainer) return;

  // Завантажуємо місяць — цілі приходять разом із знімком бюджету
  const periodKey = currentPeriodKey();
  await budgetStore.loadPeriod(periodKey);
  const snapshot = budgetStore.getState();

  renderGoalsList(goalsContainer, snapshot.goals);
}

/**
 * Зберегти коригування: sign = 1 для додавання, -1 для віднімання.
 */
async function saveAdjust(sign) {
  const amountInput = document.getElementById("adjust-input");
  const amount = parseFloat(amountInput.value);
  if (!isNaN(amount) && amount > 0) {
    const goalId = amountInput.dataset.goalId;
    const goal = budgetStore.getState().goals.find((g) => String(g.id) === goalId);
    if (goal) {
      const result = await budgetStore.adjustGoal({ id: goal.id, amount: sign * amount });
      if (!result.success && result.error) {
        alert("Помилка коригування: " + result.error.message);
      } else {
        renderGoalsList(goalsContainer, budgetStore.getState().goals);
        closeAdjustModal();
      }
    }
  } else {
    alert("Введіть коректну суму.");
  }
}

function renderGoalsList(container, goals) {
  const activeGoals = goals.filter((g) => g.active);

  if (activeGoals.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Ніяких активних цілей.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = activeGoals.map((goal) => {
    const goalId = String(goal.id);
    const progress = Number.isFinite(goal.progress) ? goal.progress : 0;

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
          <strong>Треба ${Number.isFinite(goal.monthlyRequirement) ? formatCurrency(goal.monthlyRequirement).replace('₴', 'грн') : '—'} щомісяця</strong>
          до ${goal.deadline}
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
  // Використовуємо setAttribute для спрощення управління станом
  adjustModal.removeAttribute("hidden");
  adjustModal.classList.add("show");
}

function closeAdjustModal() {
  if (!adjustModal) return;
  adjustModal.classList.remove("show");
  adjustModal.setAttribute("hidden", "");
}

/**
 * Подія на динамічно створеній кнопці «Коригувати» (делегування через контейнер).
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

// Кнопка «Додати» в модальному вікні коригування
const addBtn = document.getElementById("adjust-add-btn");
if (addBtn) {
  addBtn.addEventListener("click", () => saveAdjust(1));
}

// Кнопка «Відняти» в модальному вікні коригування
const subtractBtn = document.getElementById("adjust-subtract-btn");
if (subtractBtn) {
  subtractBtn.addEventListener("click", () => saveAdjust(-1));
}

// Кнопка «Хрестик» закриває поп-ap
const cancelBtn = document.getElementById("cancel-adjust-btn");
if (cancelBtn) {
  cancelBtn.addEventListener("click", closeAdjustModal);
}

// Закриття модального вікна при кліку поза ним
adjustModal?.addEventListener("click", (e) => {
  if (e.target === adjustModal) closeAdjustModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAdjustModal();
});

/**
 * Ескейтує HTML-спеціальні символи.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
