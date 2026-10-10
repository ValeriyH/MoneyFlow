/**
 * main.js — точка входу й диспетчер.
 *
 * Єдине місце, де зустрічаються шар даних (budgetStore) і шар подання
 * (панелі форми). Тут же living цикл: розгортання при відкритті вкладки,
 * повторна спроба при поверненні мережі та при фокусі на вкладці.
 */

import { SYNC_STATE, isEnvironmentConfigured } from "./config.js";
import { API_ERROR_CODE } from "./core/apiClient.js";
import { budgetStore } from "./core/budgetStore.js";
import {
  forgetAccessToken,
  loadAccessToken,
  loadActivePeriod,
  saveAccessToken,
  saveActivePeriod,
} from "./core/localStore.js";
import { currentPeriodKey, shiftPeriodKey } from "./domain/period.js";
import { initAccessGate } from "./ui/accessGate.js";
import { initBudgetPanel } from "./ui/budgetPanel.js";
import { initCollapsibleCards } from "./ui/collapsibleCards.js";
import { findById, on, setVisibility } from "./ui/dom.js";
import { initEntryForm } from "./ui/entryForm.js";
import { initOverviewPanel } from "./ui/overviewPanel.js";
import { initProfileChip } from "./ui/profileChip.js";
import { initRegistrationPanel } from "./ui/registrationPanel.js";
import { initSyncIndicator } from "./ui/syncIndicator.js";
import { initTransactionList } from "./ui/transactionList.js";
import { showToast } from "./ui/toast.js";
import { initViewSwitcher } from "./ui/viewSwitcher.js";

/** Стан сесії, який живе лише до перезавантаження сторінки. */
const sessionState = {
  /** @type {string} «2026-10» — місяць, за який користувач дивиться звіт */
  activePeriodKey: loadActivePeriod() ?? currentPeriodKey(),
  /** @type {boolean} чи вже показано застосунок */
  isAppVisible: false,
};

const appElement = findById("app");
const periodLabelElement = findById("periodLabel");
const periodPrevButtonElement = findById("periodPrevButton");
const periodNextButtonElement = findById("periodNextButton");
const lastSyncLabelElement = findById("lastSyncLabel");
const logoutButtonElement = findById("logoutButton");

const overviewPanel = initOverviewPanel();
const budgetPanel = initBudgetPanel();
const syncIndicator = initSyncIndicator({ store: budgetStore, onManualSync: requestSync });
const transactionList = initTransactionList({ onDeleteRequest: confirmAndRemoveTransaction });
const entryForm = initEntryForm({ store: budgetStore, onSubmit: submitTransactionEntry });
const profileChip = initProfileChip({ onSwitchUser: confirmUserSwitch });

initCollapsibleCards();
initViewSwitcher();
initRegistrationPanel();

const accessGate = initAccessGate({
  onUnlock: unlockApplication,
  onUnlockFailed: handleUnlockFailure,
});

/* ── Підписки на стан ───────────────────────────────────────────────────── */

budgetStore.subscribe(renderApplicationState);

/* ── Життєвий цикл ──────────────────────────────────────────────────────── */

initPeriodSwitcher();
initLifecycleListeners();

// Без адреси бекенда нема чого показувати: краще чесне пояснення,
// ніж мовчки невдалі запити до undefined.
if (!isEnvironmentConfigured()) {
  setVisibility(findById("unconfiguredGate"), true);
} else if (loadAccessToken()) {
  budgetStore.hydrateFromCache();
  budgetStore.setAccessToken(loadAccessToken());
  revealApplication();
  requestSync();
} else {
  accessGate.render(false);
}

/* ── Синхронізація ──────────────────────────────────────────────────────── */

/** @returns {Promise<void>} */
async function requestSync() {
  const hasSucceeded = await budgetStore.synchronize();

  if (!hasSucceeded) {
    const { syncState, syncMessage, syncErrorCode } = budgetStore.getState();

    if (syncErrorCode === API_ERROR_CODE.unauthorized) {
      accessGate.revealAgain(syncMessage);
      return;
    }

    if (syncState === SYNC_STATE.offline) {
      showToast("Немає мережі — нові записи чекають у черзі", "warning");
      return;
    }

    showToast(syncMessage || "Не вдалося синхронізуватися", "error");
  }
}

/**
 * @param {string} enteredAccessToken
 * @returns {Promise<void>}
 */
async function unlockApplication(enteredAccessToken) {
  budgetStore.setAccessToken(enteredAccessToken);

  const hasSucceeded = await budgetStore.synchronize();
  if (!hasSucceeded) {
    budgetStore.setAccessToken(null);

    // Прокидаємо саму помилку, а не її текст: екран входу має
    // відрізнити «невірний код» від «забагато спроб».
    throw budgetStore.getState().lastSyncError
      ?? new Error("Не вдалося підключитися до таблиці. Спробуйте пізніше.");
  }

  saveAccessToken(enteredAccessToken);
  revealApplication();
  showToast("Готово, бюджет підключено", "success");
}

function handleUnlockFailure() {
  budgetStore.setAccessToken(null);
}

function revealApplication() {
  setVisibility(appElement, true);
  sessionState.isAppVisible = true;
  accessGate.render(true);

  // Стан уже містить дані (sync відпрацював до показу застосунку),
  // але підписка їх пропустила, бо застосунок був невидимий.
  // Тому один примусовий рендер тут, а не передбачення в підписці.
  renderApplicationState(budgetStore.getState());
}

/* ── Відмальовування ────────────────────────────────────────────────────── */

/**
 * Єдиний рендер на весь стан застосунку: спершу дешеві підписи,
 * потім важкі панелі. Так при кожній синхронізації не блимає форма.
 *
 * @param {Readonly<object>} state
 */
function renderApplicationState(state) {
  if (!sessionState.isAppVisible) return;

  const referenceDate = new Date();

  periodLabelElement.textContent = formatPeriodCaption(sessionState.activePeriodKey);
  lastSyncLabelElement.textContent = describeLastSync(state.lastSyncedAt);

  entryForm.render(state);
  overviewPanel.render(state, sessionState.activePeriodKey, referenceDate);
  budgetPanel.render(state, sessionState.activePeriodKey, referenceDate);
  transactionList.render(state, sessionState.activePeriodKey);
  syncIndicator.render(state);
  profileChip.render(state);

  updatePeriodNavigationAvailability(referenceDate);
}

/**
 * @param {string} periodKey
 * @returns {string}
 */
function formatPeriodCaption(periodKey) {
  const monthCaption = new Intl.DateTimeFormat("uk-UA", {
    month: "long",
    year: "numeric",
  });
  const [year, month] = periodKey.split("-").map(Number);
  return monthCaption.format(new Date(year, month - 1, 1));
}

/**
 * @param {string | null} lastSyncedAt
 * @returns {string}
 */
function describeLastSync(lastSyncedAt) {
  if (!lastSyncedAt) return "Ще не синхронізовано";

  const timeCaption = new Intl.DateTimeFormat("uk-UA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `Остання синхронізація: ${timeCaption.format(new Date(lastSyncedAt))}`;
}

/**
 * Не дає зайти в майбутнє — там все одно нічого немає.
 * @param {Date} referenceDate
 */
function updatePeriodNavigationAvailability(referenceDate) {
  periodNextButtonElement.disabled = sessionState.activePeriodKey >= currentPeriodKey(referenceDate);
}

/* ── Навігація місяцями ─────────────────────────────────────────────────── */

function initPeriodSwitcher() {
  on(periodPrevButtonElement, "click", () => {
    moveActivePeriodBy(-1);
  });

  on(periodNextButtonElement, "click", () => {
    moveActivePeriodBy(1);
  });

  on(logoutButtonElement, "click", () => {
    if (!window.confirm("Забути код доступу на цьому пристрої? Записи в черзі залишаться.")) {
      return;
    }

    forgetAccessToken();
    budgetStore.reset();
    window.location.reload();
  });
}

/**
 * @param {number} offsetInMonths
 */
function moveActivePeriodBy(offsetInMonths) {
  sessionState.activePeriodKey = shiftPeriodKey(sessionState.activePeriodKey, offsetInMonths);
  saveActivePeriod(sessionState.activePeriodKey);
  renderApplicationState(budgetStore.getState());
}

/* ── Реакція на зовнішні події ──────────────────────────────────────────── */

function initLifecycleListeners() {
  window.addEventListener("online", () => {
    if (budgetStore.getState().pendingEntries.length > 0) requestSync();
  });

  window.addEventListener("offline", () => {
    renderApplicationState(budgetStore.getState());
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!budgetStore.getState().lastSyncedAt) return;

    const minutesSinceLastSync = (Date.now() - Date.parse(budgetStore.getState().lastSyncedAt)) / 60000;
    if (minutesSinceLastSync > 3) requestSync();
  });
}

/* ── Дії користувача ────────────────────────────────────────────────────── */

/**
 * @param {object} transactionDraft
 * @returns {Promise<{ deliveredImmediately: boolean, error: Error | null }>}
 */
async function submitTransactionEntry(transactionDraft) {
  const transactionToSave = {
    ...transactionDraft,
    id: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
  };

  const { deliveredImmediately, error } = await budgetStore.addTransaction(transactionToSave);

  if (deliveredImmediately) {
    showToast(`Записано: ${transactionDraft.category}`, "success");
  }

  return { deliveredImmediately, error };
}

/**
 * @param {object} transaction
 */
async function confirmAndRemoveTransaction(transaction) {
  const shouldRemove = window.confirm(
    `Видалити операцію «${transaction.category}» на ${transaction.occurredOn}?`,
  );
  if (!shouldRemove) return;

  const { deliveredImmediately, error } = await budgetStore.removeTransaction(transaction);

  if (deliveredImmediately) {
    showToast("Операцію видалено", "success");
    return;
  }

  showToast(error?.message ?? "Видалення в черзі — повторимо за мережі", "warning");
}

/**
 * Профіль у шапці — це єдиний спосіб змінити користувача на пристрої.
 * Код доступу зберігається один, тому «виходу» в ньому немає:
 * щоб записати під іншою людиною, вводиться її код.
 */
function confirmUserSwitch() {
  if (!window.confirm("Перейти на іншого користувача? Введи інший код доступу.")) {
    return;
  }

  forgetAccessToken();
  budgetStore.reset();
  window.location.reload();
}