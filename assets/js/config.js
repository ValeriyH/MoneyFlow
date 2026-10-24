/**
 * config.js — налаштування застосунку.
 *
 * Тут лише те, що не залежить від середовища: пороги, пресети,
 * ключі сховища. Адреса бекенда тут немає — вона приходить
 * з assets/js/generated/env.js, який створюється під час розгортання
 * (GitHub Actions) або локально (tools/serve.ps1) і не потрапляє у git.
 */

/**
 * Значення з assets/js/generated/env.js.
 * Файл підключається звичайним <script> до main.js і заповнює
 * глобальну змінну. Якщо його немає — значить, середовище не налаштовано.
 *
 * @type {{ APPS_SCRIPT_ENDPOINT?: string } | undefined}
 */
const injectedEnvironment = window.__MONEYFLOW_ENV__;

/**
 * Адреса розгорнутого Web App (Google Apps Script).
 * @type {string}
 */
export const APPS_SCRIPT_ENDPOINT = injectedEnvironment?.APPS_SCRIPT_ENDPOINT ?? "";

/** @returns {boolean} чи середовище взагалі налаштовано */
export function isEnvironmentConfigured() {
  return APPS_SCRIPT_ENDPOINT.startsWith("https://");
}

/** Ключі, під якими дані лежать у localStorage цього браузера. */
export const STORAGE_KEYS = {
  session: "moneyflow.session",
  clockOffset: "moneyflow.clock-offset",
  activePeriod: "moneyflow.active-period",
  activeView: "moneyflow.active-view",
  collapsedCards: "moneyflow.collapsed-cards",
  cachedSnapshot: "moneyflow.cached-snapshot",
  uiStyle: "moneyflow.ui-style",
};

/**
 * Вигляд застосунку.
 *
 * `classic` — звичайний світлий, буквальний стиль.
 * `solid` — новий: темна тема і суцільна навігація.
 *
 * Тримаємо обидва, поки новий не відточений: родині звичка важливіша
 * за свіжий дизайн, а перемикач коштує одного рядка.
 */
export const UI_STYLE_CLASSIC = "classic";
export const UI_STYLE_SOLID = "solid";

/**
 * Початок ключа черги. Далі дописується логін:
 * `moneyflow.pending-entries.оля`.
 *
 * Черга належить конкретній людині. Один браузер може користуватися
 * друзі й дружина: якщо б черга була спільною, записи одного
 * відправилися б від імені іншого — сервер бере користувача з токена.
 */
export const PENDING_ENTRIES_KEY_PREFIX = "moneyflow.pending-entries.";

/** Стани синхронізації між браузером і Google Таблицею. */
export const SYNC_STATE = {
  loading: "loading",
  synced: "synced",
  pending: "pending",
  offline: "offline",
  error: "error",
};

/** Текст, який бачить користувач для кожного стану синхронізації. */
export const SYNC_STATE_LABELS = {
  [SYNC_STATE.loading]: "Завантаження…",
  [SYNC_STATE.synced]: "Синхронізовано",
  [SYNC_STATE.pending]: "Черга: {count}",
  [SYNC_STATE.offline]: "Немає мережі",
  [SYNC_STATE.error]: "Помилка",
};

/**
 * Таймаут запиту до Google Apps Script, мс.
 *
 * Щойно розгорнутий скрипт «прогрівається» 10-20 секунд, і холодний
 * старт Apps Script легко перевищує 15 секунд. Ставимо з запасом.
 */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * Мінімальна довжина пароля.
 *
 * Дублює MIN_PASSWORD_LENGTH в apps-script/auth.gs: клієнт показує
 * вимогу раніше, ніж людина встигне натиснути «Увійти». Значення
 * має збігатися з серверним.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** Скільки операцій показувати у списку «Останні операції». */
export const HISTORY_PAGE_SIZE = 25;

/** Поріг, за якого ліміт вважається «майже вичерпаним», частка від 1. */
export const BUDGET_WARNING_THRESHOLD = 0.8;

/**
 * Розділи, між якими перемикаються таби.
 * Ключ має збігатися з `data-panel` відповідної картки в index.html.
 *
 * Введення витрати розділом не є: форма присутня на екрані завжди,
 * щоб результат введення був видно без перемикання.
 */
export const APP_VIEWS = {
  dashboard: "dashboard",
  transactions: "transactions",
  goals: "goals",
};

/** Розділ, який показується, коли в пам'яті нічого немає. */
export const DEFAULT_APP_VIEW = APP_VIEWS.dashboard;