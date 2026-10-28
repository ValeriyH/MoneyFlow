/**
 * main.js — entry point and dispatcher.
 *
 * The only place where the data layer (budgetStore) and presentation layer
 * (form panels) meet. The main lifecycle happens here: expansion on tab open,
 * retry on network return, and on tab focus.
 *
 *
 */
 
import { isEnvironmentConfigured } from "./config.js";
import { API_ERROR_CODE, AUTH_FAILURE_CODES, openSession } from "./core/apiClient.js";
import { budgetStore } from "./core/budgetStore.js";
import { goalStore } from "./core/goalStore.js";
import { transactionQueue } from "./core/transactionQueue.js";
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
import { describeAppearance, syncThemeColor, toggleAppearance } from "./ui/appearance.js";
import { initAccessGate } from "./ui/accessGate.js";
import { initBudgetPanel } from "./ui/budgetPanel.js";
import { initCollapsibleCards } from "./ui/collapsibleCards.js";
import { findById, on, setVisibility } from "./ui/dom.js";
import { initEntryForm } from "./ui/entryForm.js";
import { initOverviewPanel } from "./ui/overviewPanel.js";
import { initProfileChip } from "./ui/profileChip.js";
import { initRegistrationPanel } from "./ui/registrationPanel.js";
import { initSyncIndicator } from "./ui/syncIndicator.js";
import { initExpenseList } from "./ui/expenseList.js";
import { showToast } from "./ui/toast.js";
import { initUserMenu } from "./ui/userMenu.js";
import { initViewSwitcher } from "./ui/viewSwitcher.js";
import { showGoalsTab } from "./ui/goals.js";
 
/** Session state, which lives only until page reload. */
const sessionState = {
  /** @type {string} «2026-10» — the month for which the user views the report */
  activePeriodKey: loadActivePeriod() ?? currentPeriodKey(),
  /** @type {boolean} whether the app is already visible */
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
const syncIndicator = initSyncIndicator({ onManualSync: requestSync });
const expenseList = initExpenseList({
  onDeleteRequest: confirmAndRemoveExpense,
  onEditRequest: (expense) => entryForm.loadForEdit(expense),
});
const entryForm = initEntryForm({
  store: budgetStore,
  onSubmit: submitExpenseEntry,
  onUpdateSubmit: updateExpenseEntry,
});
const profileChip = initProfileChip();
 
/**
 * Content of the options menu. Here, not in userMenu.js: the module only knows
 * how to show the list, and what should be in it is the dispatcher's call.
 * Each item is added in a single line.
 *
 *
 */
const userMenu = initUserMenu({
  triggerElement: findById("profileChip"),
  menuElement: findById("userMenu"),
  nameElement: findById("userMenuName"),
  items: [
    { id: "appearance", label: "Тема", getValue: describeAppearance, onSelect: toggleAppearance },
    { id: "logout", label: "Вийти", onSelect: confirmAndExit },
  ],
});
 
initCollapsibleCards();
 
  const viewSwitcher = initViewSwitcher();
 
  // Add handler for "goals" tabs
  const tabElements = document.querySelectorAll('.view-tabs__tab');
  tabElements.forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.view === 'goals') {
        showGoalsTab();
      }
    });
  });
  
  initRegistrationPanel();
 
const accessGate = initAccessGate({
  onUnlock: unlockApplication,
  onUnlockFailed: handleUnlockFailure,
});
 
/* -- State subscriptions --------------------------------------------------------- */
 
budgetStore.subscribe(renderApplicationState);
transactionQueue.subscribe(renderSyncIndicator);
transactionQueue.onRejected(reportRejectedTransaction);

/* -- Lifecycle --------------------------------------------------------- */
 
// The open month must be passed to the store before the first synchronization:
// the request is built based on it, and without it the first login would
// pick the current month, and the screen would stay with "Loading month...".
budgetStore.setActivePeriod(sessionState.activePeriodKey);
 
initPeriodSwitcher();
initLifecycleListeners();
syncThemeColor();
registerOfflineShell();
 
// Without an endpoint, there is nothing to show: better an honest explanation,
// than silent failed requests to undefined.
if (!isEnvironmentConfigured()) {
  setVisibility(findById("unconfiguredGate"), true);
} else if (!isCryptoAvailable()) {
  setVisibility(findById("insecureContextGate"), true);
} else if (loadSession()) {
  budgetStore.hydrateFromCache();
  goalStore.hydrateFromCache();
  applySession(loadSession());
  revealApplication();
  requestSync();
} else {
  accessGate.render(false);
}
 
/* ── Offline Shell ─────────────────────────────────────────────────────── */
 
/**
 * Registers the service worker, which serves the app offline.
 *
 * Registration is intentionally non-blocking and doesn't throw errors:
 * without the service worker, everything works as usual, only without
 * offline support. Rejection of registration
 * is not a reason to hide the budget.
 *
 * @returns {void}
 *
 *
 */
function registerOfflineShell() {
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
 
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("[MoneyFlow] Service worker was not registered:", error);
    });
  });
}
 
/* ── Synchronization ──────────────────────────────────────────────────────── */

/**
 * Every store that talks to the server gets the same session. The queue
 * goes first: the stores read the logged-in person's queue right away.
 *
 * @param {{ token: string, login: string } | null} session
 * @returns {void}
 */
function applySession(session) {
  transactionQueue.setSession(session);
  budgetStore.setSession(session);
  goalStore.setSession(session);
}

/**
 * The one place that tells about refused transactions: a flush may be
 * triggered by any action or by the background sync, and a refusal of
 * a goal change made offline yesterday must not go unnoticed.
 *
 * @param {{ transaction: object, message: string }} rejection
 * @returns {void}
 */
function reportRejectedTransaction({ transaction, message }) {
  const subject = transaction.operation?.type === "goalChange" ? "Зміну цілі" : "Витрату";
  showToast(`${subject} відхилено: ${message}`, "error");
}

/**
 * Synchronization as a whole: send the queue, then refresh the budget.
 *
 * Each store answers only for itself; putting the steps in order is the
 * dispatcher's job. A delivered queue already brings a snapshot, so the
 * budget is reloaded only when nothing was sent.
 *
 * @returns {Promise<void>}
 * @throws {Error} from the queue or the snapshot request
 */
async function synchronizeAll() {
  const { delivered } = await transactionQueue.flush();
  if (!delivered) await budgetStore.reload();
}

/** @returns {Promise<void>} */
async function requestSync() {
  let failure = null;
  try {
    await synchronizeAll();
  } catch (error) {
    failure = error;
  }

  // The server returns only requested months, so synchronization
  // closes only those that were in memory. The selected month might
  // be other (it's visible immediately after reload) — therefore we
  // request it separately. If it's already there, it's a redundant call.
  await budgetStore.loadPeriod(sessionState.activePeriodKey);

  if (failure) {
    const syncErrorCode = failure.code ?? null;
    const syncMessage = failure.message;

    if (AUTH_FAILURE_CODES.includes(syncErrorCode)) {
      // Any authorization failure means one thing: we need to log in
      // again. The token is removed, otherwise the next opening would
      // again go to the same failed request.
      //
      // The queue is handled by transactionQueue: on SESSION_EXPIRED it
      // stays and goes out after the next login, on UNAUTHORIZED (account
      // disabled, password changed, token forged) it is cleared.
      applySession(null);
      forgetSession();

      // UNAUTHORIZED means this token will never work again — typically
      // the owner reset the password of a lost phone. Cached expenses and
      // goals must not stay readable for whoever holds the phone; after
      // a real login they are loaded again.
      if (syncErrorCode === API_ERROR_CODE.unauthorized) {
        budgetStore.reset();
        goalStore.reset();
      }

      // The app is hidden along with the gate: otherwise old ones
      // would remain under the form, which are no longer synchronized.
      setVisibility(appElement, false);
      sessionState.isAppVisible = false;
      accessGate.revealAgain(syncMessage);
      return;
    }
 
    if (!navigator.onLine) {
      showToast("Немає мережі — нові записи чекають у черзі", "warning");
      return;
    }
 
    showToast(syncMessage || "Не вдалося синхронізуватися", "error");
  }
}
 
/**
 * Exchange of login and password for a session token.
 *
 * The password is not sent: the browser calculates the proof itself and only
 * passes it. The server responds with a signed token and its time — the last
 * one is needed to correctly bind the next login to the time, even if the
 * device clock is wrong.
 *
 * @param {{ login: string, password: string }} credentials
 * @returns {Promise<void>}
 *
 *
 */
async function unlockApplication({ login, password }) {
  const requestTimestamp = currentServerAlignedTime();
  const proof = await buildLoginProof(password, requestTimestamp);
 
  const response = await openSession({ login, proof, timestamp: requestTimestamp });
 
  saveClockOffset(response.serverTime - Date.now());
  saveSession(response.token, login);
 
  applySession({ token: response.token, login });

  try {
    await synchronizeAll();
  } catch (error) {
    applySession(null);
    forgetSession();

    // Pass the error itself, not its text: the login screen must
    // distinguish "wrong password" from "too many attempts".
    throw error;
  }
 
  revealApplication();
  showToast("Готово, бюджет підключено", "success");
}

function handleUnlockFailure() {
  applySession(null);
  forgetSession();
}
 
function revealApplication() {
  setVisibility(appElement, true);
  sessionState.isAppVisible = true;
  accessGate.render(true);
 
  // State already contains data (sync worked before showing the app),
  // but the subscription missed it, because the app was invisible.
  // Therefore, one forced render here, and not a prediction in the subscription.
  renderApplicationState(budgetStore.getState());

  // If the last view was "Goals", load goals only now: before this point
  // there is no session, and the request would go out without a token.
  if (document.getElementById("appMain")?.dataset.activeView === "goals") {
    showGoalsTab();
  }
}

/* ── Rendering ────────────────────────────────────────────────────── */
 
/**
 * Single render for the entire application state: first cheap labels,
 * then heavy panels. This way, at each synchronization, it doesn't blink.
 *
 * @param {Readonly<object>} state
 *
 *
 */
function renderApplicationState(state) {
  if (!sessionState.isAppVisible) return;
 
  const referenceDate = new Date();
 
  periodLabelElement.textContent = formatPeriodCaption(sessionState.activePeriodKey);
  lastSyncLabelElement.textContent = describeLastSync(state.lastSyncedAt);
 
  // While the month hasn't arrived from the server, we hide the panels. Showing
  // zeros instead would be a lie: it would look like the user spent nothing
  // in this month.
  const isPeriodReady = budgetStore.isPeriodLoaded(sessionState.activePeriodKey);
  setVisibility(periodLoadingElement, !isPeriodReady);
  setVisibility(overviewPanelElement, isPeriodReady);
  setVisibility(budgetPanelElement, isPeriodReady);
  setVisibility(historyPanelElement, isPeriodReady);
 
  // The form works always: entering expenses doesn't have to wait for the panel.
  entryForm.render(state);
 
  if (isPeriodReady) {
    overviewPanel.render(state, sessionState.activePeriodKey, referenceDate);
    budgetPanel.render(state, sessionState.activePeriodKey, referenceDate);
    expenseList.render(state, sessionState.activePeriodKey);
  }
 
  renderSyncIndicator();
  profileChip.render(state);
  userMenu.setName(state.viewer.name);

  updatePeriodNavigationAvailability(referenceDate);
}

/**
 * The indicator combines budget loading and queue delivery; it is
 * re-rendered on a change of either.
 *
 * @returns {void}
 */
function renderSyncIndicator() {
  if (!sessionState.isAppVisible) return;

  const { isLoading, loadError } = budgetStore.getState();
  syncIndicator.render({
    budget: { isLoading, loadError },
    queue: transactionQueue.getStatus(),
  });
}
 
/**
 * @param {string} periodKey
 * @returns {string}
 *
 *
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
 *
 *
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
 * Prevents going into the future — there is nothing there.
 * @param {Date} referenceDate
 *
 *
 */
function updatePeriodNavigationAvailability(referenceDate) {
  periodNextButtonElement.disabled = sessionState.activePeriodKey >= currentPeriodKey(referenceDate);
}
 
/* ── Logout ────────────────────────────────────────────────────────── */
 
/**
 * "1 record remains in the queue", "2 records ... remain",
 * "5 records ... remain".
 *
 * Ukrainian numbers require agreement with the verb:
 * "1 record remain" — grammatically incorrect. Therefore, we count
 * together with the verb form, and not just the noun.
 *
 * @param {number} count
 * @returns {string}
 *
 *
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
 * Log out on this device.
 *
 * One logout in two places (an option in the options menu and a link in the footer)
 * — so that the text and behavior do not diverge. Nothing is lost:
 * the queue belongs to the person and will arrive when they log in again; only
 * the snapshot cache is cleared — so the next user doesn't see someone else's
 * expenses.
 *
 *
 */
function confirmAndExit() {
  const queuedCount = transactionQueue.getPending().length;

  const message = queuedCount > 0
    ? `Вийти з системи? ${describeQueuedEntries(queuedCount)}, ` +
      `коли ви знову увійдете.`
    : "Вийти з системи?";

  if (!window.confirm(message)) return;

  forgetSession();
  budgetStore.reset();
  goalStore.reset();
  window.location.reload();
}
 
/* ── Month Navigation ────────────────────────────────────────────────── */
 
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
 *
 *
 */
function moveActivePeriodBy(offsetInMonths) {
  const nextPeriodKey = shiftPeriodKey(sessionState.activePeriodKey, offsetInMonths);
 
  sessionState.activePeriodKey = nextPeriodKey;
  saveActivePeriod(nextPeriodKey);
  budgetStore.setActivePeriod(nextPeriodKey);
  renderApplicationState(budgetStore.getState());
 
  // The month that is or was not in memory must be requested separately:
  // the server returns only what was requested. If it's already there,
  // it's instant, no request: this time it stays in memory until the end
  // of the session.
  budgetStore.loadPeriod(nextPeriodKey);
}
 
/* ── Reaction to External Events ──────────────────────────────────────────── */
 
function initLifecycleListeners() {
  window.addEventListener("online", () => {
    if (transactionQueue.getPending().length > 0) requestSync();
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
 
/* ── User Actions ─────────────────────────────────────────────────────── */
 
/**
 * @param {object} expenseDraft
 * @returns {Promise<{ deliveredImmediately: boolean, error: Error | null }>}
 *
 *
 */
async function submitExpenseEntry(expenseDraft) {
  const expenseToSave = {
    ...expenseDraft,
    id: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
  };
 
  const { deliveredImmediately, error } = await budgetStore.addExpense(expenseToSave);
 
  if (deliveredImmediately) {
    showToast(`Збережено: ${expenseDraft.category}`, "success");
  }
 
  return { deliveredImmediately, error };
}
 
/**
 * @param {object} expense
 * @returns {Promise<{ deliveredImmediately: boolean, error: Error | null }>}
 *
 *
 */
async function confirmAndRemoveExpense(expense) {
  const shouldRemove = window.confirm(
    `Видалити витрату «${expense.category}» на ${expense.occurredOn}?`,
  );
  if (!shouldRemove) return;
 
  const { deliveredImmediately, rejected, error } = await budgetStore.removeExpense(expense);

  if (deliveredImmediately) {
    showToast("Витрату видалено", "success");
    return;
  }

  // A refusal has already been shown by reportRejectedTransaction.
  if (rejected) return;
  showToast(error?.message ?? "Видалення в черзі — повторимо за мережі", "warning");
}
 
/**
 * Overwrites an existing record.
 *
 * `changes` does not contain `id` and `user`: the first server finds
 * by the row number, and "Who" it is taken from its own token.
 *
 * @param {string} expenseId
 * @param {{ amount: number, category: string, occurredOn: string, note: string }} changes
 * @returns {Promise<{ deliveredImmediately: boolean, error: Error | null }>}
 *
 *
 */
async function updateExpenseEntry(expenseId, changes) {
  const { deliveredImmediately, rejected, error } = await budgetStore.updateExpense(expenseId, changes);

  if (deliveredImmediately) {
    showToast("Зміни збережено", "success");
    return { deliveredImmediately, error };
  }

  // A refusal has already been shown by reportRejectedTransaction.
  if (!rejected) showToast(error?.message ?? "Правка в черзі — повторимо за мережі", "warning");
  return { deliveredImmediately, error };
}
