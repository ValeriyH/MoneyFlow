/**
 * localStore.js — безпечна обгортка над сховищем браузера.
 *
 * Причина існування: сховище кидає винятки у приватному режимі Safari
 * і переповнюється. Тому кожна операція проходить через `try/catch`,
 * а приватний режим не ламає весь застосунок.
 *
 * ── Одне сховище ────────────────────────────────────────────────────────────
 *
 * `localStorage`, і все живе там: сесія, черга несинхронізованих
 * записів і кеш знімка. Кеш обмежено трьома останніми місяцями —
 * див. `CACHED_MONTHS_LIMIT` у `budgetStore`.
 *
 * Раніше кеш лежав у `sessionStorage`, щоб історія не залишалася на
 * диску. Відмовилися від цього разом із офлайном: без кешу на
 * диску застосунок у метро просто не відкривається, а тримати
 * двадцять місяців замість трьох нічого не додає.
 *
 */

import { PENDING_ENTRIES_KEY_PREFIX, STORAGE_KEYS } from "../config.js";

/**
 * @param {Storage} storage
 * @param {string} storageKey
 * @param {unknown} fallbackValue
 * @returns {unknown}
 */
function readFrom(storage, storageKey, fallbackValue) {
  try {
    const rawValue = storage.getItem(storageKey);
    return rawValue === null ? fallbackValue : JSON.parse(rawValue);
  } catch {
    return fallbackValue;
  }
}

/**
 * @param {Storage} storage
 * @param {string} storageKey
 * @param {unknown} value
 * @returns {boolean} — чи вдалося записати
 */
function writeTo(storage, storageKey, value) {
  try {
    storage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Storage} storage
 * @param {string} storageKey
 * @returns {void}
 */
function removeFrom(storage, storageKey) {
  try {
    storage.removeItem(storageKey);
  } catch {
    /* приватний режим — немає чого видаляти */
  }
}

/**
 * @param {string} storageKey
 * @param {unknown} fallbackValue
 * @returns {unknown}
 */
function readJsonValue(storageKey, fallbackValue) {
  return readFrom(window.localStorage, storageKey, fallbackValue);
}

/**
 * @param {string} storageKey
 * @param {unknown} value
 * @returns {boolean}
 */
function writeJsonValue(storageKey, value) {
  return writeTo(window.localStorage, storageKey, value);
}

/**
 * @param {string} storageKey
 * @returns {void}
 */
function removeValue(storageKey) {
  removeFrom(window.localStorage, storageKey);
}

/* ── Сесія ───────────────────────────────────────────────────────────────── */

/**
 * Токен і логин зберігаються разом, а не окремо: так вони не можуть
 * розійтися. Токен сам по собі не каже, чия це черга.
 *
 * @returns {{ token: string, login: string } | null}
 */
export function loadSession() {
  const storedSession = readJsonValue(STORAGE_KEYS.session, null);

  if (!storedSession || typeof storedSession !== "object") return null;
  if (typeof storedSession.token !== "string" || storedSession.token === "") return null;
  if (typeof storedSession.login !== "string" || storedSession.login === "") return null;

  return { token: storedSession.token, login: storedSession.login };
}

/**
 * @param {string} sessionToken
 * @param {string} login
 * @returns {void}
 */
export function saveSession(sessionToken, login) {
  writeJsonValue(STORAGE_KEYS.session, { token: sessionToken, login });
}

/** @returns {void} */
export function forgetSession() {
  removeValue(STORAGE_KEYS.session);
}

/* ── Зсув годинника ─────────────────────────────────────────────────────── */

/**
 * Різниця між серверним і локальним часом у мс.
 *
 * Потрібна для доказу входу: він прив'язаний до часу, і без
 * поправки телефон із хибним годинником не ввійде. Відповідь
 * сервера — єдине джерело, звідки цю різницю можна взяти.
 *
 * @returns {number}
 */
export function loadClockOffset() {
  const storedOffset = readJsonValue(STORAGE_KEYS.clockOffset, 0);
  return typeof storedOffset === "number" && Number.isFinite(storedOffset) ? storedOffset : 0;
}

/**
 * @param {number} offsetMs
 * @returns {void}
 */
export function saveClockOffset(offsetMs) {
  writeJsonValue(STORAGE_KEYS.clockOffset, offsetMs);
}

/**
 * Час «зараз» з урахуванням відомої різниці.
 * @returns {number}
 */
export function currentServerAlignedTime() {
  return Date.now() + loadClockOffset();
}

/* ── Черга несинхронізованих операцій ───────────────────────────────────── */

/**
 * Черга окрема на кожного користувача: записи, зроблені під одним
 * логіном, не можуть потрапити в таблицю від імені іншого.
 *
 * @param {string | null} login
 * @returns {string}
 */
function pendingEntriesKey(login) {
  return PENDING_ENTRIES_KEY_PREFIX + String(login ?? "").trim().toLowerCase();
}

/**
 * @param {string | null} login
 * @returns {Array<object>} операції, які ще не дійшли до таблиці
 */
export function loadPendingEntries(login) {
  const storedEntries = readJsonValue(pendingEntriesKey(login), []);
  return Array.isArray(storedEntries) ? storedEntries : [];
}

/**
 * @param {string | null} login
 * @param {Array<object>} pendingEntries
 * @returns {void}
 */
export function savePendingEntries(login, pendingEntries) {
  return writeJsonValue(pendingEntriesKey(login), pendingEntries);
}

/**
 * @param {string | null} login
 * @returns {boolean} чи є для цього логіна записи в черзі
 */
export function hasPendingEntries(login) {
  return loadPendingEntries(login).length > 0;
}

/* ── Вигляд застосунку ──────────────────────────────────────────────────── */

/**
 * Активний таб на мобільному. На десктопі табів немає, але вибраний
 * розділ запам'ятовується — щоб не скидати на «Ввід» при кожному
 * відкритті на телефоні.
 *
 * @param {string} viewName
 * @returns {void}
 */
export function saveActiveView(viewName) {
  writeJsonValue(STORAGE_KEYS.activeView, viewName);
}

/** @returns {string | null} */
export function loadActiveView() {
  return readJsonValue(STORAGE_KEYS.activeView, null);
}

/**
 * @returns {Set<string>} ключі згорнутих карток
 */
export function loadCollapsedCards() {
  const storedKeys = readJsonValue(STORAGE_KEYS.collapsedCards, []);
  return new Set(Array.isArray(storedKeys) ? storedKeys : []);
}

/**
 * @param {Set<string>} collapsedCardKeys
 * @returns {void}
 */
export function saveCollapsedCards(collapsedCardKeys) {
  writeJsonValue(STORAGE_KEYS.collapsedCards, [...collapsedCardKeys]);
}

/* ── Обраний місяць ─────────────────────────────────────────────────────── */

/**
 * @param {string} periodKey — «2026-10»
 * @returns {void}
 */
export function saveActivePeriod(periodKey) {
  writeJsonValue(STORAGE_KEYS.activePeriod, periodKey);
}

/** @returns {string | null} */
export function loadActivePeriod() {
  return readJsonValue(STORAGE_KEYS.activePeriod, null);
}

/* ── Кеш останнього знімка ─────────────────────────────────────────────── */

/**
 * Останній успішно завантажений знімок потрібен, щоб показати дані
 * одразу при відкритті — і щоб застосунок взагалі відкрився без
 * мережі: оболонка приходить із кешу service worker'а, а дані —
 * звідси.
 *
 * Живе у localStorage, а не у sessionStorage. Раніше це було
 * свідомою відмовою від офлайну: вся історія витрат лежала б на
 * диску відкритим текстом. Зараз тримаємо обмежене вікно — див.
 * `CACHED_MONTHS_LIMIT` — і погоджуємо, що резервна копія телефону
 * його забиратиме.
 *
 * @returns {{ viewer: object, categories: Array<object>, transactions: Array<object>, loadedPeriods: Array<string>, lastSyncedAt: string } | null}
 */
export function loadCachedSnapshot() {
  const cachedSnapshot = readJsonValue(STORAGE_KEYS.cachedSnapshot, null);
  return cachedSnapshot && Array.isArray(cachedSnapshot.transactions) ? cachedSnapshot : null;
}

/**
 * @param {object} snapshot
 * @returns {void}
 */
export function saveCachedSnapshot(snapshot) {
  writeJsonValue(STORAGE_KEYS.cachedSnapshot, snapshot);
}

/** @returns {void} */
export function clearCachedSnapshot() {
  removeValue(STORAGE_KEYS.cachedSnapshot);
}

/* ── Вигляд ──────────────────────────────────────────────────────────────── */

/**
 * @returns {string | null} збережений вигляд або null, якщо ще не вибирали
 */
export function loadUiStyle() {
  return readJsonValue(STORAGE_KEYS.uiStyle, null);
}

/**
 * @param {string} styleName
 * @returns {void}
 */
export function saveUiStyle(styleName) {
  writeJsonValue(STORAGE_KEYS.uiStyle, styleName);
}
