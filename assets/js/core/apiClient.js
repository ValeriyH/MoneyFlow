/**
 * apiClient.js — the only layer that knows about Google Apps Script.
 * Other modules know nothing about the URL, the response format, or any errors.
 *
 * All requests are sent via POST, even reads. The reason is specific:
 * the token in the query string ends up in Google logs, browser history,
 * and Referer headers. In the request body, it is invisible to everyone.
 *
 * Separately on the password: it never leaves the browser in any request.
 * Instead, a proof `SHA-256(SHA-256(password) + time)` is sent — a value
 * tied to the moment in time, which the server accepts only once.
 *
 *
 *  */

import { APPS_SCRIPT_ENDPOINT, REQUEST_TIMEOUT_MS } from "../config.js";

/** Error codes returned by the backend in the response body. */
export const API_ERROR_CODE = {
  unauthorized: "UNAUTHORIZED",
  // Token signed correctly, but expired. The only
  // failure where it is sufficient to log in again.
  sessionExpired: "SESSION_EXPIRED",
  rateLimited: "RATE_LIMITED",
  badRequest: "BAD_REQUEST",
  serverError: "SERVER_ERROR",
  network: "NETWORK",
  timeout: "TIMEOUT",
};

/**
 * @typedef {object} Viewer
 * @property {string} name
 * @property {string} color
 *
 * */

/**
 * Category along with the limit for the requested month.
 *
 * @typedef {object} BudgetCategory
 * @property {string} name
 * @property {string} icon
 * @property {string} color
 * @property {string} isActive — "Yes", "No" or empty (empty = yes)
 * @property {number} order
 * @property {number} limit — limit for limitPeriod, 0 if not set
 *
 *
 *  */

/**
 * Goal — accumulation or project.
 *
 * @typedef {object} Goal
 * @property {string} id
 * @property {string} name
 * @property {number} targetAmount — target amount (hidden in UI)
 * @property {number} currentAmount — current amount (hidden in UI)
 * @property {string} deadline — "2026-12-31" or "2026-12-31T00:00"
 * @property {string} beginDate — "2026-01-01" or "2026-01-01T00:00"
 * @property {string} type — "Savings" or "Project"
 * @property {boolean} active — whether to display the goal in the web interface
 * @property {number} progress — completion percentage (0-100), calculated on the server
 * @property {number} monthlyRequirement — how much needs to be saved/spent monthly, calculated on the server
 *
 *
 *  */

/**
 * A single transaction. pending is not in the snapshot — it is a client copy
 * still in the transmission queue.
 *
 * @typedef {object} Transaction
 * @property {string} id
 * @property {string} occurredOn — "2026-10-17" or "2026-10-17T09:15"
 * @property {string} category
 * @property {number} amount
 * @property {string} user
 * @property {string} note
 * @property {string} recordedAt — ISO with time in UTC
 * @property {boolean} [pending]
 *
 *
 *  */

/**
 * Budget snapshot. periods — the months the server actually
 * read: the client replaces its own with them, leaves others alone.
 *
 * @typedef {object} BudgetSnapshot
 * @property {string} serverTime
 * @property {Viewer} viewer
 * @property {Array<BudgetCategory>} categories
 * @property {Array<string>} periods
 * @property {Array<Transaction>} transactions
 * @property {Array<Goal>} goals
 *
 *
 *  */

/** Codes that require showing the login screen.
 *
 * SESSION_EXPIRED — temporary: log in again and the queue will proceed.
 * UNAUTHORIZED — permanent or until admin action: re-login
 * won't help, so the queue is discarded (see budgetStore).
 *
 * @property {number[]} AUTH_FAILURE_CODES
 *
 *
 *  */
export const AUTH_FAILURE_CODES = [
  API_ERROR_CODE.unauthorized,
  API_ERROR_CODE.sessionExpired,
];

/** Error, understandable by the top layer: has a stable code and human message. */
export class ApiError extends Error {
  /**
   * @param {string} message — what to show the user (from server: displayError)
   * @param {string} code
   * @param {{ retryAfterSeconds?: number, serverTime?: number, technicalMessage?: string }} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  /** @returns {number | null} how many seconds more one cannot try */
  getRetryAfterSeconds() {
    return this.details.retryAfterSeconds ?? null;
  }
}

/**
 * Executes a request to Apps Script with a timeout and normalization of
 * errors into a single ApiError type.
 *
 * **Returns different forms depending on `action`**, so there is no
 * single type here — all are listed below. Subordinates instead of it
 * have a specific `@returns`.
 *
 * ```
 * authenticate         → { ok, token, expiresAt, serverTime }
 * requestRegistration  → { ok, login, isActive }
 * loadSnapshot         → { ok, ...BudgetSnapshot }
 * addTransaction       → { ok, transaction, snapshot }
 * updateTransaction    → { ok, transaction, snapshot }
 * deleteTransaction    → { ok, deletedId, snapshot }
 * fetchGoals           → { ok, goals }
 * adjustGoal            → { ok, goal, snapshot }
 * ```
 *
 * An error never returns — it is thrown as `ApiError`.
 *
 * @param {{ action: string, sessionToken?: string, [key: string]: unknown }} command
 * @returns {Promise<object>} see the list of forms above
 *
 *
 *  */
async function sendCommand({ action, sessionToken, ...payload }) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(APPS_SCRIPT_ENDPOINT, {
      method: "POST",
      // text/plain is mandatory: with application/json, Apps Script responds
      // with a CORS redirect, which the browser blocks.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action,
        sessionToken: sessionToken ?? "",
        ...payload,
      }),
      signal: abortController.signal,
    });

    const rawBody = await response.text();
    let parsedBody;

    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new ApiError(
        "Сервер повернув неочікувану відповідь. Перевірте, чи правильно розгорнуто Web App.",
        API_ERROR_CODE.serverError,
      );
    }

    if (parsedBody.ok === false) {
      // Server sends two texts: error - for logs,
      // displayError - for the page. We show the second on screen,
      // the first remains in the console so that details are not lost.
      const technicalMessage = parsedBody.error ?? "Невідома помилка сервера";
      const displayMessage = parsedBody.displayError ?? technicalMessage;

      if (technicalMessage !== displayMessage) {
        console.error(
          `[MoneyFlow] ${parsedBody.code}: ${technicalMessage}`,
        );
      }

      throw new ApiError(displayMessage, parsedBody.code ?? API_ERROR_CODE.serverError, {
        retryAfterSeconds: parsedBody.retryAfterSeconds,
        serverTime: parsedBody.serverTime,
        technicalMessage,
      });
    }

    return parsedBody;
  } catch (error) {
    throw normalizeTransportError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Converts a low-level browser error into ApiError.
 * @param {unknown} error
 * @returns {ApiError}
 *
 *
 *  */
function normalizeTransportError(error) {
  if (error instanceof ApiError) return error;

  if (error.name === "AbortError") {
    return new ApiError(
      `Сервер не відповів за ${Math.round(REQUEST_TIMEOUT_MS / 1000)} секунд. Спробуйте ще раз.`,
      API_ERROR_CODE.timeout,
    );
  }

  if (!navigator.onLine) {
    return new ApiError("Немає з'єднання з інтернетом.", API_ERROR_CODE.network);
  }

  return new ApiError(
    "Не вдалося зв'язатися з Google Таблицею. Перевірте з'єднання.",
    API_ERROR_CODE.network,
  );
}

/**
 * Exchange of login and password for a session token.
 *
 * @param {{ login: string, proof: string, timestamp: number }} credentials
 * @returns {Promise<{ token: string, expiresAt: number, serverTime: number }>}
 *
 *
*  */
export function openSession({ login, proof, timestamp }) {
  return sendCommand({ action: "authenticate", login, proof, timestamp });
}

/**
 * Sends a request to create a user.
 *
 * The only request without a session — otherwise creating an account would
 * make no sense for anyone. Request count limits are maintained by the server.
 *
 * @param {string} login
 * @param {string} passwordHash — SHA-256 of the password, calculated in the browser
 * @returns {Promise<{ login: string, isActive: false }>} request created,
 * but the account is not yet active — it's enabled by an administrator in the table
 *
 *
*
*  */
export function requestUserRegistration(login, passwordHash) {
  return sendCommand({ action: "requestRegistration", login, passwordHash });
}

/**
 * Loads the budget snapshot along with the logged-in user.
 *
 * `periods` — months with transactions that the client already keeps in memory.
 * The server will return only them: this way a 20KB snapshot doesn't
 * grow to megabytes, and loaded months are not re-requested.
 *
 * `limitPeriod` — separately, and it's not a coincidence. Transactions are
 * needed for two months (open and previous — for comparison), and limits
* should be only for the open one. Otherwise, the October limit would be
* shown in September as well, where it wasn't set.
 *
 * @param {string} sessionToken
 * @param {Array<string>} periods
 * @param {string} limitPeriod
 * @returns {Promise<BudgetSnapshot>} `periods` in the response — those months
* the server actually read
*
*
*
*  */
export function fetchBudgetSnapshot(sessionToken, periods, limitPeriod) {
  return sendCommand({ action: "loadSnapshot", sessionToken, periods, limitPeriod });
}

/**
 * Adds a single transaction to the table. Who spent - is determined by the server
* from the token, the client does not pass this field.
*
* @param {string} sessionToken
* @param {object} transactionPayload
* @param {Array<string>} periods
* @param {string} limitPeriod
* @returns {Promise<{ transaction: Transaction, snapshot: BudgetSnapshot }>}
* the actual record from the server (with its `id`) and updated data — it is
* by them that the record is removed from the queue, not by the queue's `id`
*
*
*
*  */
export function submitTransaction(sessionToken, transactionPayload, periods, limitPeriod) {
  return sendCommand({ action: "addTransaction", sessionToken, transaction: transactionPayload, periods, limitPeriod });
}

/**
 * Deletes a transaction by its stable identifier.
 *
 * @param {string} sessionToken
 * @param {string} transactionId
 * @param {Array<string>} periods
 * @param {string} limitPeriod
* @returns {Promise<{ deletedId: string, snapshot: BudgetSnapshot }>}
*
*
*
*  */
export function deleteTransaction(sessionToken, transactionId, periods, limitPeriod) {
  return sendCommand({ action: "deleteTransaction", sessionToken, transactionId, periods, limitPeriod });
}

/**
 * Overwrites an existing transaction in place.
 *
 * `transaction` must contain `id` — the server finds the row by it.
 * "Who" and "Recorded" are taken by the server from its own data, not from this
* payload: forging the author of the change is impossible, and the time of the last
* record is set by the server itself.
 *
 * @param {string} sessionToken
* @param {object} transactionPayload
* @param {Array<string>} periods
* @param {string} limitPeriod
* @returns {Promise<{ transaction: Transaction, snapshot: BudgetSnapshot }>}
* returns what actually remains in the row, not an echo from the payload.
*
*
*
*  */
export function updateTransaction(sessionToken, transactionPayload, periods, limitPeriod) {
  return sendCommand({ action: "updateTransaction", sessionToken, transaction: transactionPayload, periods, limitPeriod });
}

/** Loads the list of active user goals. */
export function fetchGoals(sessionToken) {
  return sendCommand({ action: "fetchGoals", sessionToken });
}

/** Adjusts the current amount of a goal. Changes only `currentAmount` (`currentAmount` + `amount`). Returns { id, progress, monthlyRequirement }. */
export function adjustGoal(sessionToken, goalId, amount) {
  return sendCommand({ action: "adjustGoal", sessionToken, id: goalId, amount });
}
