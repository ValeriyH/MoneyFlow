/**
 * accessGate.js — login screen.
 *
 * The password is not stored in the browser: it is converted into a hash
 * before the request (see domain/crypto.js), and the browser only stores
 * a server-signed session token. Thus, a public Apps Script address
 * alone is not enough — a password is also required.
 * */

import { ApiError, API_ERROR_CODE } from "../core/apiClient.js";
import { findById, on, setVisibility } from "./dom.js";

/** Frequency of countdown refresh, in ms. */
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

  /** Countdown timer until the server unlocks the login. */
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

  /** Hides the counter and allows form submission again. */
  function clearError() {
    setVisibility(gateErrorElement, false);
    stopCountdown();
  }

  /**
   * Blocks the button and shows the remaining wait time.
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
      // Do not restore the button here intentionally: when the server
      // just blocked the entry, the form should remain blocked.
      // In all other cases, it will be unlocked by handleUnlockError.
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

    // Blocking applies only in the case of rateLimited; in other cases
    // the form should remain usable for the next attempt.
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

  /** Shows gate again when the recent sync failed with unauthorized. */
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
