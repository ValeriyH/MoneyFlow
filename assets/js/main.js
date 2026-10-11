/**
 * main.js — точка входу й диспетчер.
 *
 * Єдине місце, де зустрічаються шар даних (budgetStore) і шар подання
 * (панелі форми). Тут же living цикл: розгортання при відкритті вкладки,
 * повторна спроба при поверненні мережі та при фокусі на вкладці.
 */

import { SYNC_STATE, isEnvironmentConfigured } from "./config.js";
import { AUTH_FAILURE_CODES, openSession } from "./core/apiClient.js";
import { budgetStore } from "./core/budgetStore.js";
import {
  currentServerAlignedTime,
  forgetSession,
  loadSession,
  loadActivePeriod,
  saveClockOffset,
  saveSession,
  saveActivePeriod,
} from "./core/localStore.js";
import { buildLoginProof, isCryptoAvailable } from "./domain/crypto.js";
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
const periodLoadingElement = findById("periodLoading");
const overviewPanelElement = findById("overviewPanel");
const budgetPanelElement = findById("budgetPanel");
const historyPanelElement = findById("historyPanel");

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
} else if (!isCryptoAvailable()) {
  setVisibility(findById("insecureContextGate"), true);
} else if (loadSession()) {
  budgetStore.hydrateFromCache();
  budgetStore.setSession(loadSession());
  revealApplication();
  requestSync();
} else {
  accessGate.render(false);
}

/* ── Синхронізація ──────────────────────────────────────────────────────── */

/** @returns {Promise<void>} */
async function requestSync() {
  const hasSucceeded = await budgetStore.synchronize();

  // Сервер віддає тільки запитані місяці, тож синхронізація
  // закриває лише ті, що були в пам'яті. Обраний місяць міг бути
  // іншим (його видно одразу після перезавантаження) — діванемо
  // його окремим запитом. Якщо він уже є, це нібий виклик.
  await budgetStore.loadPeriod(sessionState.activePeriodKey);

  if (!hasSucceeded) {
    const { syncState, syncMessage, syncErrorCode } = budgetStore.getState();

    if (AUTH_FAILURE_CODES.includes(syncErrorCode)) {
      // Будь-яка відмова в авторизації означає одне: треба увійти
      // знову. Токен прибираємо, інакше наступне відкриття знову
      // піде в той самий відмовий запит.
      //
      // Чергу це не торкається - нею опікується budgetStore:
      // на SESSION_EXPIRED записи лишаються, на UNAUTHORIZED
      // (вимкнули акаунт, змінили пароль) - видаляються.
      budgetStore.setSession(null);
      forgetSession();

      // Застосунок ховаємо разом із gate: інакше під формою
      // лишилися б старі витрати, які вже не синхронізуються.
      setVisibility(appElement, false);
      sessionState.isAppVisible = false;
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
 * Обмін логіну й пароля на сесійний токен.
 *
 * Пароль не відправляється: браузер сам рахує доказ і лише його
 * передає. Сервер відповідає підписаним токеном і своїм часом —
 * останній потрібен, щоб наступний вхід правильно прив'язаний
 * до часу, навіть якщо годинник пристрою кривий.
 *
 * @param {{ login: string, password: string }} credentials
 * @returns {Promise<void>}
 */
async function unlockApplication({ login, password }) {
  const requestTimestamp = currentServerAlignedTime();
  const proof = await buildLoginProof(password, requestTimestamp);

  const response = await openSession({ login, proof, timestamp: requestTimestamp });

  saveClockOffset(response.serverTime - Date.now());
  saveSession(response.token, login);

  budgetStore.setSession({ token: response.token, login });

  const hasSucceeded = await budgetStore.synchronize();
  if (!hasSucceeded) {
    budgetStore.setSession(null);
    forgetSession();

    // Прокидаємо саму помилку, а не її текст: екран входу має
    // відрізнити «невірний пароль» від «забагато спроб».
    throw budgetStore.getState().lastSyncError
      ?? new Error("Не вдалося підключитися до таблиці. Спробуйте пізніше.");
  }

  revealApplication();
  showToast("Готово, бюджет підключено", "success");
}

function handleUnlockFailure() {
  budgetStore.setSession(null);
  forgetSession();
}

function revealApplication() {
  setVisibility(appElement, true);
  sessionState.isAppVisible = true;
  accessGate.render(true);

  // Відкритий місяць не можна викинути з пам'яті — інакше панелі
  // залишаться на «Завантаження місяця…» назавжди.
  budgetStore.setActivePeriod(sessionState.activePeriodKey);

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

  // Поки місяць не прийшов із сервера, панелі ховаємо. Показувати
  // замість них нулі було б брехнею: виглядало б так, наче в цьому
  // місяці ніхто нічого не витратив.
  const isPeriodReady = budgetStore.isPeriodLoaded(sessionState.activePeriodKey);
  setVisibility(periodLoadingElement, !isPeriodReady);
  setVisibility(overviewPanelElement, isPeriodReady);
  setVisibility(budgetPanelElement, isPeriodReady);
  setVisibility(historyPanelElement, isPeriodReady);

  // Форма працює завжди: введення видатків не має чекати на панелі.
  entryForm.render(state);

  if (isPeriodReady) {
    overviewPanel.render(state, sessionState.activePeriodKey, referenceDate);
    budgetPanel.render(state, sessionState.activePeriodKey, referenceDate);
    transactionList.render(state, sessionState.activePeriodKey);
  }

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

/* ── Вихід із системи ────────────────────────────────────────────────────── */

/**
 * «1 запис у черзі залишиться», «2 записи ... залишаться»,
 * «5 записів ... залишаться».
 *
 * Українські числівники вимагають узгодження і з дієсловом:
 * «1 запис залишаться» — граматично неправильно. Тому рахуємо
 * разом із формою дієслова, а не лише іменник.
 *
 * @param {number} count
 * @returns {string}
 */
function describeQueuedEntries(count) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastDigit === 1 && lastTwoDigits !== 11) {
    return `${count} запис у черзі залишиться й дійде`;
  }

  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) {
    return `${count} записи в черзі залишаться й дійдуть`;
  }

  return `${count} записів у черзі залишаться й дійдуть`;
}

/**
 * Виходить із системи на цьому пристрої.
 *
 * Один вихід на два кнопки (профіль у шапці й підвал) — щоб текст
 * і поведінка не розходилися. Нічого не губиться: черга належить
 * людині й дійде, коли вона знову увійде; стирається лише кеш
 * знімка, щоб наступний не бачив чужих витрат.
 */
function confirmAndExit() {
  const { pendingEntries } = budgetStore.getState();

  const message = pendingEntries.length > 0
    ? `Вийти з системи? ${describeQueuedEntries(pendingEntries.length)}, ` +
      `коли ви знову увійдете.`
    : "Вийти з системи?";

  if (!window.confirm(message)) return;

  forgetSession();
  budgetStore.reset();
  window.location.reload();
}

/* ── Навігація місяцями ─────────────────────────────────────────────────── */

function initPeriodSwitcher() {
  on(periodPrevButtonElement, "click", () => {
    moveActivePeriodBy(-1);
  });

  on(periodNextButtonElement, "click", () => {
    moveActivePeriodBy(1);
  });

  on(logoutButtonElement, "click", confirmAndExit);
}

/**
 * @param {number} offsetInMonths
 */
function moveActivePeriodBy(offsetInMonths) {
  const nextPeriodKey = shiftPeriodKey(sessionState.activePeriodKey, offsetInMonths);

  sessionState.activePeriodKey = nextPeriodKey;
  saveActivePeriod(nextPeriodKey);
  budgetStore.setActivePeriod(nextPeriodKey);
  renderApplicationState(budgetStore.getState());

  // Місяць, якого ще немає в пам'яті, треба запитати окремо: сервер
  // віддає тільки те, що попросили. Уже завантажений — миттєво,
  // без запиту: цього разу він лишається в пам'яті до кінця сесії.
  budgetStore.loadPeriod(nextPeriodKey);
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
 * Профіль у шапці — це той самий вихід із системи.
 */
function confirmUserSwitch() {
  confirmAndExit();
}
