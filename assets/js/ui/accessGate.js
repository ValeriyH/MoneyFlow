/**
 * accessGate.js — екран входу за логіном і паролем.
 *
 * Пароль не залишає браузер: він перетворюється на хеш ще до
 * запиту (див. domain/crypto.js), а браузер зберігає лише підписаний
 * сервером токен сесії. Тому публічна адреса Apps Script сама по
 * собі нічого не дає — треба ще й пароль.
 */

import { ApiError, API_ERROR_CODE } from "../core/apiClient.js";
import { findById, on, setVisibility } from "./dom.js";

/** Як часто оновлювати зворотний відлік, мс. */
const COUNTDOWN_TICK_MS = 1000;

/**
 * @param {object} dependencies
 * @param {(credentials: { login: string, password: string }) => Promise<void>} dependencies.onUnlock
 * @param {() => void} dependencies.onUnlockFailed
 * @returns {{ render: () => void, revealAgain: () => void }}
 */
export function initAccessGate({ onUnlock, onUnlockFailed }) {
  const gateElement = findById("accessGate");
  const gateFormElement = findById("accessGateForm");
  const loginInputElement = findById("loginInput");
  const passwordInputElement = findById("passwordInput");
  const gateErrorElement = findById("accessGateError");
  const gateSubmitButtonElement = findById("accessGateSubmit");
  const gateCountdownElement = findById("accessGateCountdown");

  const registrationFormElement = findById("registrationForm");

  /** Таймер зворотного відліку, доки сервер тримає вхід заблокованим. */
  let countdownTimerHandle = null;

  /** @param {boolean} isUnlocked */
  function render(isUnlocked) {
    setVisibility(gateElement, !isUnlocked);
    if (isUnlocked) {
      stopCountdown();
      return;
    }

    setVisibility(registrationFormElement, false);
    setVisibility(gateFormElement, true);
    loginInputElement.focus();
  }

  /** @param {string} message */
  function showError(message) {
    gateErrorElement.textContent = message;
    setVisibility(gateErrorElement, true);
  }

  /** Ховає лічильник і знову дозволяє надсилати форму. */
  function clearError() {
    setVisibility(gateErrorElement, false);
    stopCountdown();
  }

  /**
   * Блокує кнопку й показує, скільки лишилося чекати.
   * @param {number} totalSeconds
   */
  function startCountdown(totalSeconds) {
    stopCountdown();

    let secondsLeft = Math.max(Math.ceil(totalSeconds), 0);
    passwordInputElement.disabled = true;
    gateSubmitButtonElement.disabled = true;
    setVisibility(gateCountdownElement, true);

    const tick = () => {
      if (secondsLeft <= 0) {
        stopCountdown();
        gateErrorElement.textContent = "Можна спробувати ще раз.";
        return;
      }

      const minutesPart = Math.floor(secondsLeft / 60);
      const secondsPart = String(secondsLeft % 60).padStart(2, "0");
      gateCountdownElement.textContent =
        minutesPart > 0
          ? `Зачекайте ${minutesPart} хв ${secondsPart} с`
          : `Зачекайте ${secondsPart} с`;

      secondsLeft -= 1;
    };

    tick();
    countdownTimerHandle = setInterval(tick, COUNTDOWN_TICK_MS);
  }

  function stopCountdown() {
    if (countdownTimerHandle !== null) {
      clearInterval(countdownTimerHandle);
      countdownTimerHandle = null;
    }

    setVisibility(gateCountdownElement, false);
    gateSubmitButtonElement.disabled = false;
    passwordInputElement.disabled = false;
  }

  on(gateFormElement, "submit", async (event) => {
    event.preventDefault();
    if (gateSubmitButtonElement.disabled) return;

    const enteredLogin = loginInputElement.value.trim();
    const enteredPassword = passwordInputElement.value;

    if (!enteredLogin || !enteredPassword) {
      showError("Введіть логін і пароль.");
      return;
    }

    clearError();
    gateSubmitButtonElement.disabled = true;
    gateSubmitButtonElement.textContent = "Перевіряємо…";

    try {
      await onUnlock({ login: enteredLogin, password: enteredPassword });
      passwordInputElement.value = "";
    } catch (error) {
      handleUnlockError(error);
    } finally {
      // Кнопку не відновлюємо тут навмисно: коли сервер щойно
      // заблокував вхід, форма має лишатися заблокованою.
      // У всіх інших випадках її розблокує handleUnlockError.
      gateSubmitButtonElement.textContent = "Увійти";
    }
  });

  /** @param {unknown} error */
  function handleUnlockError(error) {
    if (error instanceof ApiError && error.code === API_ERROR_CODE.rateLimited) {
      showError("Забагато спроб із невірним паролем.");
      startCountdown(error.getRetryAfterSeconds() ?? 900);
      return;
    }

    // Блокування діє лише у разі rateLimited; в інших випадках
    // форма має лишатися придатною для наступної спроби.
    stopCountdown();

    if (error instanceof ApiError && error.code === API_ERROR_CODE.unauthorized) {
      onUnlockFailed();
      showError("Невірний логін або пароль.");
      passwordInputElement.value = "";
      passwordInputElement.focus();
      return;
    }

    showError(error instanceof Error ? error.message : "Не вдалося увійти. Спробуйте ще раз.");
  }

  /** Показує gate знову, коли чергова синхронізація впала з unauthorized. */
  function revealAgain(message) {
    clearError();
    showError(message);
    loginInputElement.value = "";
    passwordInputElement.value = "";
    loginInputElement.focus();
    render(false);
  }

  return { render, revealAgain };
}