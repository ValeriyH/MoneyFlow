/**
 * apiClient.js — єдиний шар, який знає про Google Apps Script.
 * Інші модулі не знають ні про URL, ні про формат відповіді, ні про помилки.
 *
 * Усі запити йдуть методом POST, навіть читання. Причина конкретна:
 * код доступу в query string потрапляє в логи Google, в історію
 * браузера і в заголовок Referer. У тілі запиту він не видно нікому.
 */

import { APPS_SCRIPT_ENDPOINT, REQUEST_TIMEOUT_MS } from "../config.js";

/** Коди помилок, які бекенд повертає в тілі відповіді. */
export const API_ERROR_CODE = {
  unauthorized: "UNAUTHORIZED",
  rateLimited: "RATE_LIMITED",
  badRequest: "BAD_REQUEST",
  serverError: "SERVER_ERROR",
  network: "NETWORK",
  timeout: "TIMEOUT",
};

/** Помилка, зрозуміла до верхнього шару: має стабільний код і людське повідомлення. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ retryAfterSeconds?: number }} [details] — додаткові дані від сервера
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
 * @param {{ action: string, accessToken: string, [key: string]: unknown }} command
 * @returns {Promise<object>}
 */
async function sendCommand({ action, accessToken, ...payload }) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(APPS_SCRIPT_ENDPOINT, {
      method: "POST",
      // text/plain обязателен: з application/json Apps Script відповідає
      // CORS-редиректом, який браузер блокує.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, accessToken, ...payload }),
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
      throw new ApiError(
        parsedBody.error ?? "Невідома помилка сервера",
        parsedBody.code ?? API_ERROR_CODE.serverError,
        { retryAfterSeconds: parsedBody.retryAfterSeconds },
      );
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
    return new ApiError("Сервер не відповів за 15 секунд. Спробуйте ще раз.", API_ERROR_CODE.timeout);
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
 * Надсилає заявку на створення користувача.
 *
 * Єдиний запит без коду доступу - інакше заводити акаунт не мав би
 * сенсу нікому. Обмеження на кількість заявок тримає сервер.
 *
 * @param {string} userName
 * @param {string} password
 */
export function requestUserRegistration(userName, password) {
  return sendCommand({
    action: "requestRegistration",
    accessToken: "",
    name: userName,
    password,
  });
}

/**
 * Завантажує повний знімок бюджету разом з тим, хто увійшов.
 * @param {string} accessToken
 */
export function fetchBudgetSnapshot(accessToken) {
  return sendCommand({ action: "loadSnapshot", accessToken });
}

/**
 * Додає одну операцію до таблиці. Хто витратив — визначає сервер
 * із коду доступу, клієнт це поле не передає.
 *
 * @param {string} accessToken
 * @param {object} transactionPayload
 */
export function submitTransaction(accessToken, transactionPayload) {
  return sendCommand({ action: "addTransaction", accessToken, transaction: transactionPayload });
}

/**
 * Видаляє операцію за її стійким ідентифікатором.
 * @param {string} accessToken
 * @param {string} transactionId
 */
export function deleteTransaction(accessToken, transactionId) {
  return sendCommand({ action: "deleteTransaction", accessToken, transactionId });
}