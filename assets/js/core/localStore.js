/**
 * localStore.js — a secure wrapper around the browser's storage.
 *
 * Reason for existence: storage throws exceptions in Safari's private mode
 * and overflows. Thus, every operation goes through `try/catch`,
 * and private mode doesn't break the whole app.
 *
 * ── One storage ────────────────────────────────────────────────────────────
 *
 * `localStorage`, and everything lives there: session, a queue of 
* unsynchronized entries, and a snapshot cache. The cache is limited 
* to the last three months — see `CACHED_MONTHS_LIMIT` in `budgetStore`.
 *
 * Previously, the cache was in `sessionStorage` so that history didn't 
* stay on disk. We moved away from this with offline support: without 
* a disk cache, the app simply won't open in the subway, and keeping 
* twenty months instead of three doesn't add anything.
 *
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
 * @returns {boolean} — whether it succeeded
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
    /* private mode — nothing to delete */
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

/* -- Session ------------------------------------------------------------------ */

/**
 * Token and login are stored together, not separately: they cannot
 * diverge. The token alone doesn't tell whose queue it is.
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

/* -- Clock Offset ------------------------------------------------------------ */

/**
 * Difference between server and local time in ms.
 *
 * Needed for the login proof: it's tied to the time, and without
 * correction, a phone with a wrong clock won't log in. The server
 * response is the only source from which this difference can be taken.
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
 * Time "now" with the known difference.
 * @returns {number}
 */
export function currentServerAlignedTime() {
  return Date.now() + loadClockOffset();
}

/* -- Queue of unsynchronized operations --------------------------------------- */

/**
 * The queue is separate for each user: records made under one
 * login cannot end up in the table for another user.
 *
 * @param {string | null} login
 * @returns {string}
 */
function pendingEntriesKey(login) {
  return PENDING_ENTRIES_KEY_PREFIX + String(login ?? "").trim().toLowerCase();
}

/**
 * @param {string | null} login
 * @returns {Array<object>} operations that haven't reached the table yet
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
 * @returns {boolean} whether there are records in the queue for this login
 */
export function hasPendingEntries(login) {
  return loadPendingEntries(login).length > 0;
}

/* -- App View ------------------------------------------------------------------ */

/**
 * Active tab on mobile. On desktop, there are no tabs, but the 
 * selected section is remembered — so it's not reset to "Input"
 * every time on a phone.
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
 * @returns {Set<string>} keys of collapsed cards
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

/* -- Selected Month ---------------------------------------------------------- */

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

/* -- Cache of Last Snapshot --------------------------------------------------- */

/**
 * The last successfully loaded snapshot is needed to show data
 * immediately upon opening — and to ensure the app opens at all
* without a network: the shell comes from the service worker cache,
* and data comes from here.
*
* It lives in localStorage, not in sessionStorage. Previously this was
* a conscious choice against offline: the entire history of expenses
* would stay on disk in plain text. Now we keep a limited window — see
* `CACHED_MONTHS_LIMIT` — and agree that the phone's backup
* will take it.
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

/* -- Appearance --------------------------------------------------------------- */

/**
 * @returns {string | null} saved style or null if not chosen yet
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
