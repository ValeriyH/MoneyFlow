/**
 * goals.js — "Goals" tab.
 *
 * Shows active goals with a progress bar, the monthly requirement and the
 * change history. A user adds a change through the modal window and can
 * edit or delete any history row. Every action goes to the transaction
 * queue first, so it works offline and appears in the history immediately.
 *
 *
 */

import { goalStore } from "../core/goalStore.js";
import { formatCurrency, parseIsoDate } from "../domain/formatters.js";
import { showToast } from "./toast.js";

const TAB_ID = "goals";
const MAX_ADJUST_AMOUNT = 999999;

const goalsContainer = document.getElementById("goals-container");
const adjustModal = document.getElementById("goal-adjust-modal");
const adjustTitle = document.getElementById("goal-adjust-title");

// History is collapsed by default; re-rendering must not close what the user opened.
const expandedHistoryGoalIds = new Set();

/**
 * What the open modal changes: a new change for a goal, or an existing row.
 * @type {{ mode: "add", goalId: string } | { mode: "edit", changeId: string } | null}
 */
let modalTarget = null;

const historyDateFormatter = new Intl.DateTimeFormat("uk-UA", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Displays the "Goals" tab: cached goals first, then the synchronized ones.
 *
 * @returns {Promise<void>}
 */
export async function showGoalsTab() {
  document.body.dataset.tab = TAB_ID;

  if (!goalsContainer) return;

  // Cached goals are shown right away: the network may be slow or absent,
  // and a failed load must not leave the tab empty.
  renderGoals();

  try {
    await goalStore.synchronize();
  } catch (error) {
    console.warn("[MoneyFlow] Goals were not refreshed:", error);
  }
}

/**
 * Refusals are not reported here: the dispatcher shows them for the
 * whole queue, whichever action triggered the flush.
 *
 * @param {{ delivered: boolean, error: Error | null }} result
 * @returns {void}
 */
function reportDelivery({ delivered, error }) {
  if (!delivered && error) {
    showToast("Зміна в черзі — надішлемо, коли з'явиться мережа", "warning");
  }
}

/**
 * Save from the modal: sign = 1 for addition, -1 for subtraction.
 *
 * @param {1 | -1} sign
 * @returns {Promise<void>}
 */
async function saveAdjust(sign) {
  const amountInput = document.getElementById("adjust-input");
  const amount = parseAmount(amountInput.value);
  if (amount === null) {
    showToast("Введіть коректну суму", "warning");
    return;
  }

  // The modal closes before the network: a double tap finds no target
  // and cannot queue the same change twice.
  const target = modalTarget;
  if (!target) return;
  closeAdjustModal();

  const result = target.mode === "edit"
    ? await goalStore.updateChange(target.changeId, sign * amount)
    : await goalStore.addChange(target.goalId, sign * amount);

  reportDelivery(result);
}

/**
 * @param {object} change
 * @returns {Promise<void>}
 */
async function confirmAndDeleteChange(change) {
  const shouldDelete = window.confirm(
    `Видалити запис ${formatSignedAmount(change.amount)} від ${formatHistoryDate(change.occurredOn)}?`,
  );
  if (!shouldDelete) return;

  reportDelivery(await goalStore.deleteChange(change.id));
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

/**
 * @param {number} amount
 * @returns {string} «+500 грн» or «−500 грн»
 */
function formatSignedAmount(amount) {
  const sign = amount < 0 ? "−" : "+";
  return sign + formatCurrency(Math.abs(amount)).replace("₴", "грн");
}

/**
 * @param {string} occurredOn — "2026-10-17"
 * @returns {string}
 */
function formatHistoryDate(occurredOn) {
  const parsedDate = parseIsoDate(occurredOn);
  return parsedDate ? historyDateFormatter.format(parsedDate) : String(occurredOn ?? "");
}

/**
 * @param {string} changeId
 * @returns {object | undefined} history row as currently shown
 */
function findChange(changeId) {
  return goalStore.getGoals()
    .flatMap((goal) => goal.history ?? [])
    .find((change) => change.id === changeId);
}

function renderGoals() {
  if (goalsContainer) renderGoalsList(goalsContainer, goalStore.getGoals());
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

    // Numbers are recalculated on the server, so they lag behind queued changes.
    const pendingHtml = goal.hasPendingChanges
      ? `<span class="goal-pending">Оновиться після синхронізації</span>`
      : "";

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
          ${pendingHtml}
        </div>

        <div class="monthly-requirement">
          ${requirementHtml}
        </div>

        ${renderHistory(goal)}

        <div class="goal-actions">
          <button class="adjust-btn btn-tertiary">Коригувати</button>
        </div>
      </div>
    `;
  }).join("");
}

/**
 * @param {object} goal
 * @returns {string} HTML of the collapsible history block
 */
function renderHistory(goal) {
  const history = goal.history ?? [];
  const isOpen = expandedHistoryGoalIds.has(String(goal.id));

  const itemsHtml = history.length === 0
    ? `<li class="goal-history__empty">Змін ще не було</li>`
    : history.map((change) => `
        <li class="goal-history__item${change.pending ? " is-pending" : ""}" data-change-id="${escapeHtml(String(change.id))}">
          <span class="goal-history__date">${escapeHtml(formatHistoryDate(change.occurredOn))}</span>
          <span class="goal-history__amount${change.amount < 0 ? " is-negative" : ""}">${escapeHtml(formatSignedAmount(change.amount))}</span>
          <span class="goal-history__user">${change.pending ? "очікує синхронізації" : escapeHtml(change.user)}</span>
          <span class="goal-history__actions">
            <button type="button" class="icon-action goal-history__edit" aria-label="Змінити запис">✎</button>
            <button type="button" class="icon-action icon-action--danger goal-history__delete" aria-label="Видалити запис">🗑</button>
          </span>
        </li>
      `).join("");

  return `
    <details class="goal-history" data-goal-id="${escapeHtml(String(goal.id))}"${isOpen ? " open" : ""}>
      <summary>Історія (${history.length})</summary>
      <ul class="goal-history__list">${itemsHtml}</ul>
    </details>
  `;
}

/**
 * @param {{ mode: "add", goalId: string } | { mode: "edit", changeId: string }} target
 * @param {number} [initialAmount] — prefilled for edit
 * @returns {void}
 */
function openAdjustModal(target, initialAmount) {
  if (!adjustModal) return;
  modalTarget = target;

  if (adjustTitle) {
    adjustTitle.textContent = target.mode === "edit" ? "Змінити запис" : "Коригувати ціль";
  }

  const adjustInput = document.getElementById("adjust-input");
  if (adjustInput) {
    adjustInput.value = initialAmount ? String(initialAmount) : "";
  }

  adjustModal.removeAttribute("hidden");
  adjustModal.classList.add("show");
}

function closeAdjustModal() {
  modalTarget = null;
  if (!adjustModal) return;
  adjustModal.classList.remove("show");
  adjustModal.setAttribute("hidden", "");
}

goalStore.subscribe(renderGoals);

if (goalsContainer) {
  // Event delegation: cards are re-rendered on every store change.
  goalsContainer.addEventListener("click", (e) => {
    const adjustBtn = e.target.closest(".adjust-btn");
    if (adjustBtn) {
      const goalId = adjustBtn.closest(".goal-card")?.dataset.goalId;
      if (goalId) openAdjustModal({ mode: "add", goalId });
      return;
    }

    const historyButton = e.target.closest(".goal-history__edit, .goal-history__delete");
    if (!historyButton) return;

    const change = findChange(historyButton.closest(".goal-history__item")?.dataset.changeId);
    if (!change) return;

    if (historyButton.classList.contains("goal-history__edit")) {
      openAdjustModal({ mode: "edit", changeId: change.id }, Math.abs(change.amount));
    } else {
      confirmAndDeleteChange(change);
    }
  });

  // toggle does not bubble, so it is caught on the way down.
  goalsContainer.addEventListener("toggle", (e) => {
    const details = e.target;
    if (!details.classList?.contains("goal-history")) return;

    if (details.open) expandedHistoryGoalIds.add(details.dataset.goalId);
    else expandedHistoryGoalIds.delete(details.dataset.goalId);
  }, true);
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
