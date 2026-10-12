/**
 * apiClient.js — єдиний шар, який знає про Google Apps Script.
 * Інші модулі не знають ні про URL, ні про формат відповіді, ні про помилки.
 *
 * Усі запити йдуть методом POST, навіть читання. Причина конкретна:
 * токен у query string потрапляє в логи Google, в історію
 * браузера і в заголовок Referer. У тілі запиту він не видно нікому.
 *
 * Окремо про пароль: він не залишає браузер у жодному запиті.
 * Замість нього йде доказ `SHA-256(SHA-256(пароль) + час)` — значення,
 * прив'язане до миттєвого часу, яке сервер приймає лише один раз.
 */

import { APPS_SCRIPT_ENDPOINT, REQUEST_TIMEOUT_MS } from "../config.js";

/** Коди помилок, які бекенд повертає в тілі відповіді. */
export const API_ERROR_CODE = {
  unauthorized: "UNAUTHORIZED",
  // Токен підписаний правильно, але термін вичерпано. Єдина
  // відмова, після якої достатньо увійти знову.
  sessionExpired: "SESSION_EXPIRED",
  rateLimited: "RATE_LIMITED",
  badRequest: "BAD_REQUEST",
  serverError: "SERVER_ERROR",
  network: "NETWORK",
  timeout: "TIMEOUT",
};

/**
 * Коди, за якими треба показати екран входу.
 *
 * SESSION_EXPIRED — тимчасово: ввійдете знову й черга дійде.
 * UNAUTHORIZED — назавжди або до дії адміністратора: повторний
 * вхід не допоможе, тому черга викидається (див. budgetStore).
 */
export const AUTH_FAILURE_CODES = [
  API_ERROR_CODE.unauthorized,
  API_ERROR_CODE.sessionExpired,
];

/** Помилка, зрозуміла до верхнього шару: має стабільний код і людське повідомлення. */
export class ApiError extends Error {
  /**
   * @param {string} message — що показати людині (з сервера: displayError)
   * @param {string} code
   * @param {{ retryAfterSeconds?: number, serverTime?: number, technicalMessage?: string }} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  /** @returns {number | null} скільки секунд ще не можна пробувати */
  getRetryAfterSeconds() {
    return this.details.retryAfterSeconds ?? null;
  }
}

/**
 * Виконує запит до Apps Script із таймаутом і приведенням помилок
 * до єдиного типу ApiError.
 *
 * @param {{ action: string, sessionToken?: string, [key: string]: unknown }} command
 * @returns {Promise<object>}
 */
async function sendCommand({ action, sessionToken, ...payload }) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(APPS_SCRIPT_ENDPOINT, {
      method: "POST",
      // text/plain обязателен: з application/json Apps Script відповідає
      // CORS-редиректом, який браузер блокує.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, sessionToken: sessionToken ?? "", ...payload }),
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
      // Сервер надсилає два тексти: error - для журналу,
      // displayError - для сторінки. На екрані показуємо другий,
      // перший лишається в консолі, щоб не загубити деталі.
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
 * Перетворює низькорівлеву помилку браузера на ApiError.
 * @param {unknown} error
 * @returns {ApiError}
 */
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
 * Обмін логіну й пароля на сесійний токен.
 *
 * @param {{ login: string, proof: string, timestamp: number }} credentials
 * @returns {Promise<{ token: string, expiresAt: number, serverTime: number }>}
 */
export function openSession({ login, proof, timestamp }) {
  return sendCommand({ action: "authenticate", login, proof, timestamp });
}

/**
 * Надсилає заявку на створення користувача.
 *
 * Єдиний запит без сесії — інакше завести акаунт не мав би
 * сенсу нікому. Обмеження на кількість заявок тримає сервер.
 *
 * @param {string} login
 * @param {string} passwordHash — SHA-256 пароля, порахований у браузері
 */
export function requestUserRegistration(login, passwordHash) {
  return sendCommand({ action: "requestRegistration", login, passwordHash });
}

/**
 * Завантажує знімок бюджету разом із тим, хто увійшов.
 *
 * `periods` — місяці з операціями, які клієнт уже тримає в пам'яті.
 * Сервер поверне тільки їх: так знімок на два десятки кілобайт не
 * виростає до мегабайтів, а завантажені місяці не перезапитуються.
 *
 * `limitPeriod` — окремо, і це не випадковість. Операції потрібні
 * за два місяці (відкритий і попередній — для порівняння), а ліміти
 * мають бути лише для відкритого. Інакше жовтневий ліміт показувався
 * б і в вересні, де його не задавали.
 *
 * @param {string} sessionToken
 * @param {Array<string>} periods
 * @param {string} limitPeriod
 */
export function fetchBudgetSnapshot(sessionToken, periods, limitPeriod) {
  return sendCommand({ action: "loadSnapshot", sessionToken, periods, limitPeriod });
}

/**
 * Додає одну операцію до таблиці. Хто витратив — визначає сервер
 * із токена, клієнт це поле не передає.
 *
 * @param {string} sessionToken
 * @param {object} transactionPayload
 * @param {Array<string>} periods
 * @param {string} limitPeriod
 */
export function submitTransaction(sessionToken, transactionPayload, periods, limitPeriod) {
  return sendCommand({ action: "addTransaction", sessionToken, transaction: transactionPayload, periods, limitPeriod });
}

/**
 * Видаляє операцію за її стійким ідентифікатором.
 * @param {string} sessionToken
 * @param {string} transactionId
 * @param {Array<string>} periods
 * @param {string} limitPeriod
 */
export function deleteTransaction(sessionToken, transactionId, periods, limitPeriod) {
  return sendCommand({ action: "deleteTransaction", sessionToken, transactionId, periods, limitPeriod });
}