/**
 * config.js — application configuration.
 *
 * This file contains only environment-independent values: thresholds, presets,
 * and storage keys. The backend address is not here — it arrives from
 * assets/js/generated/env.js, which is created during deployment
 * (GitHub Actions) or locally (tools/serve.ps1) and is not committed to git.
 *  */

/**
 * Values from assets/js/generated/env.js.
 * The file is included via a standard <script> in main.js and populates
 * a global variable. If it is missing, it means the environment is not configured.
 *
 * @type {{ APPS_SCRIPT_ENDPOINT?: string } | undefined}
 *  */
const injectedEnvironment = window.__MONEYFLOW_ENV__;

/**
 * Address of the deployed Web App (Google Apps Script).
 * @type {string}
 *  */
export const APPS_SCRIPT_ENDPOINT = injectedEnvironment?.APPS_SCRIPT_ENDPOINT ?? "";

/** @returns {boolean} whether the environment is configured at all */
export function isEnvironmentConfigured() {
  return APPS_SCRIPT_ENDPOINT.startsWith("https://");
}

/** Keys under which data is stored in this browser's localStorage. */
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
 * Application look.
 *
 * `classic` — standard light, literal style.
 * `solid` — new: dark theme and solid navigation.
 *
 * We keep both until the new one is polished: family habit is more important
 * than fresh design, and the toggle costs only one line.
 *  */
export const UI_STYLE_CLASSIC = "classic";
export const UI_STYLE_SOLID = "solid";

/**
 * Start of the queue key. Suffix is the login:
 * `moneyflow.pending-entries.оля`.
 *
 * The queue belongs to a specific person. One browser can be used by
 * family members: if the queue were shared, entries from one
 * would be sent on behalf of another — the server takes the user from the token.
 *  */
export const PENDING_ENTRIES_KEY_PREFIX = "moneyflow.pending-entries.";

/** Synchronization states between the browser and the Google Sheet. */
export const SYNC_STATE = {
  loading: "loading",
  synced: "synced",
  pending: "pending",
  offline: "offline",
  error: "error",
};

/** Text the user sees for each synchronization state. */
export const SYNC_STATE_LABELS = {
  [SYNC_STATE.loading]: "Завантаження…",
  [SYNC_STATE.synced]: "Синхронізовано",
  [SYNC_STATE.pending]: "Черга: {count}",
  [SYNC_STATE.offline]: "Немає мережі",
  [SYNC_STATE.error]: "Помилка",
};

/** Request timeout to Google Apps Script, ms.
 *
 * A newly deployed script "warms up" for 10-20 seconds, and a cold
 * start of Apps Script can easily exceed 15 seconds. We set it with a margin.
 *  */
export const REQUEST_TIMEOUT_MS = 30000;

/** Minimum password length.
 *
 * Duplicates MIN_PASSWORD_LENGTH in apps-script/auth.gs: the client shows
 * the requirement before the user even hits "Login". The value
 * must match the server one.
 *  */
export const MIN_PASSWORD_LENGTH = 10;

/** Number of transactions to show in the "Latest transactions" list. */
export const HISTORY_PAGE_SIZE = 25;

/** Threshold above which a limit is considered "almost exhausted", fraction of 1. */
export const BUDGET_WARNING_THRESHOLD = 0.8;

/**
 * Sections between which tabs switch.
 * The key must match the `data-panel` of the corresponding card in index.html.
 *
 * Entering an expense by section is not a flow: the form is always on the screen,
 * so the input result is visible without switching.
 *  */
export const APP_VIEWS = {
  dashboard: "dashboard",
  transactions: "transactions",
  goals: "goals",
};

/** Section displayed when there is nothing in memory. */
export const DEFAULT_APP_VIEW = APP_VIEWS.dashboard;
