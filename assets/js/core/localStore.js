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

/* ── Код доступу ─────────────────────────────────────────────────────────── */

/** @returns {string | null} */
export function loadAccessToken() {
  return readJsonValue(STORAGE_KEYS.accessToken, null);
}

/** @param {string} accessToken */
export function saveAccessToken(accessToken) {
  writeJsonValue(STORAGE_KEYS.accessToken, accessToken);
}

export function forgetAccessToken() {
  try {
    window.localStorage.removeItem(STORAGE_KEYS.accessToken);
  } catch {
    /* приватний режим — немає чого видаляти */
  }
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
  try {
    window.localStorage.removeItem(STORAGE_KEYS.cachedSnapshot);
  } catch {
    /* приватний режим */
  }
}