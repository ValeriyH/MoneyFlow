/**
 * localStore.js — безпечна обгортка над localStorage.
 *
 * Причина існування: localStorage кидає винятки у приватному режимі Safari
 * і переповнюється. Тому кожна операція проходить через `try/catch`,
 * а приватний режим не ламає весь застосунок.
 */

import { STORAGE_KEYS } from "../config.js";

/**
 * @param {string} storageKey
 * @param {unknown} fallbackValue
 * @returns {unknown}
 */
function readJsonValue(storageKey, fallbackValue) {
  try {
    const rawValue = window.localStorage.getItem(storageKey);
    return rawValue === null ? fallbackValue : JSON.parse(rawValue);
  } catch {
    return fallbackValue;
  }
}

/**
 * @param {string} storageKey
 * @param {unknown} value
 * @returns {boolean} — чи вдалося записати
 */
function writeJsonValue(storageKey, value) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} storageKey
 * @returns {void}
 */
function removeValue(storageKey) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    /* приватний режим — немає чого видаляти */
  }
}

/* ── Сесія ───────────────────────────────────────────────────────────────── */

/**
 * @returns {string | null} підписаний сервером токен
 */
export function loadSessionToken() {
  return readJsonValue(STORAGE_KEYS.sessionToken, null);
}

/** @param {string} sessionToken */
export function saveSessionToken(sessionToken) {
  writeJsonValue(STORAGE_KEYS.sessionToken, sessionToken);
}

export function forgetSessionToken() {
  removeValue(STORAGE_KEYS.sessionToken);
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

/** @param {number} offsetMs */
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
 * @returns {Array<object>} операції, які ще не дійшли до таблиці
 */
export function loadPendingEntries() {
  const storedEntries = readJsonValue(STORAGE_KEYS.pendingEntries, []);
  return Array.isArray(storedEntries) ? storedEntries : [];
}

/** @param {Array<object>} pendingEntries */
export function savePendingEntries(pendingEntries) {
  return writeJsonValue(STORAGE_KEYS.pendingEntries, pendingEntries);
}

/* ── Вигляд застосунку ──────────────────────────────────────────────────── */

/**
 * Активний таб на мобільному. На десктопі табів немає, але вибраний
 * розділ запам'ятовується — щоб не скидати на «Ввід» при кожному
 * відкритті на телефоні.
 *
 * @param {string} viewName
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

/** @param {Set<string>} collapsedCardKeys */
export function saveCollapsedCards(collapsedCardKeys) {
  writeJsonValue(STORAGE_KEYS.collapsedCards, [...collapsedCardKeys]);
}

/* ── Обраний місяць ─────────────────────────────────────────────────────── */

/**
 * @param {string} periodKey — «2026-10»
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
 * одразу при відкритті, не чекаючи на мережу.
 * @returns {{ viewer: object, categories: Array<object>, transactions: Array<object>, lastSyncedAt: string } | null}
 */
export function loadCachedSnapshot() {
  const cachedSnapshot = readJsonValue(STORAGE_KEYS.cachedSnapshot, null);
  return cachedSnapshot && Array.isArray(cachedSnapshot.transactions) ? cachedSnapshot : null;
}

/** @param {object} snapshot */
export function saveCachedSnapshot(snapshot) {
  writeJsonValue(STORAGE_KEYS.cachedSnapshot, snapshot);
}

export function clearCachedSnapshot() {
  removeValue(STORAGE_KEYS.cachedSnapshot);
}