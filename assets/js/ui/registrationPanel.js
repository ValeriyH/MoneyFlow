/**
 * registrationPanel.js — форма самостійної реєстрації.
 *
 * Живе на екрані входу поруч із формою входу. Людина обирає логін
 * та пароль, і вони потрапляють у таблицю як неактивний рядок.
 * Увійти можна буде лише після того, як власник таблиці увімкне
 * цей рядок у колонці «Активний».
 */

import { MIN_PASSWORD_LENGTH } from "../config.js";
import { ApiError, API_ERROR_CODE, requestUserRegistration } from "../core/apiClient.js";
import { hashPassword } from "../domain/crypto.js";
import { findById, on, setVisibility } from "./dom.js";

/**
 * Ті самі вимоги, що й на сервері: клієнт показує їх раніше,
 * щоб не витрачати запит на очевидно слабкий пароль.
 * Має збігатися з requireStrongPassword в apps-script/auth.gs.
 */
const PASSWORD_RULES = [
  { key: "length", isMet: (value) => value.length >= MIN_PASSWORD_LENGTH },
  { key: "uppercase", isMet: (value) => /[A-Z]/.test(value) },
  { key: "digit", isMet: (value) => /\d/.test(value) },
];

/** @returns {void} підписується на стан сам і нікого не повертає */
export function initRegistrationPanel() {
  const loginFormElement = findById("accessGateForm");
  const registrationFormElement = findById("registrationForm");
  const loginInputElement = findById("registrationLoginInput");
  const passwordInputElement = findById("registrationPasswordInput");
  const errorElement = findById("registrationError");
  const submitButtonElement = findById("registrationSubmit");

  const requirementItems = new Map(
    [...findById("passwordRequirements").querySelectorAll(".requirements__item")]
      .map((item) => [item.dataset.rule, item]),
  );

  on(passwordInputElement, "input", renderPasswordRequirements);

  function renderPasswordRequirements() {
    const currentPassword = passwordInputElement.value;

    for (const rule of PASSWORD_RULES) {
      requirementItems.get(rule.key)?.classList.toggle("is-met", rule.isMet(currentPassword));
    }
  }

  renderPasswordRequirements();

  /** Перемикання між двома формами живе тут: вони сусідні. */
  function showLoginForm() {
    setVisibility(registrationFormElement, false);
    setVisibility(loginFormElement, true);
    setVisibility(errorElement, false);
    findById("loginInput").focus();
  }

  function showRegistrationForm() {
    setVisibility(loginFormElement, false);
    setVisibility(registrationFormElement, true);
    loginInputElement.focus();
  }

  on(findById("showRegistrationButton"), "click", showRegistrationForm);
  on(findById("showLoginButton"), "click", showLoginForm);

  on(registrationFormElement, "submit", async (event) => {
    event.preventDefault();
    if (submitButtonElement.disabled) return;

    const newLogin = loginInputElement.value.trim();
    const password = passwordInputElement.value;

    if (newLogin.length < 2) {
      showError("Введіть логін — щонайменше 2 символи.");
      return;
    }

    const unmetRule = PASSWORD_RULES.find((rule) => !rule.isMet(password));
    if (unmetRule) {
      showError(describeUnmetRule(unmetRule.key));
      return;
    }

    setVisibility(errorElement, false);
    submitButtonElement.disabled = true;
    submitButtonElement.textContent = "Створюємо…";

    try {
      // На сервер іде хеш, а не сам пароль: так правило
      // «пароль не залишає браузера» діє і для реєстрації.
      await requestUserRegistration(newLogin, await hashPassword(password));

      registrationFormElement.reset();
      renderPasswordRequirements();
      showSuccess(
        `Акаунт «${newLogin}» створено. Він зможе увійти, ` +
        `коли власник таблиці увімкне його.`,
      );
    } catch (error) {
      showError(describeRegistrationError(error));
    } finally {
      submitButtonElement.disabled = false;
      submitButtonElement.textContent = "Створити акаунт";
    }
  });

  /**
   * @param {string} ruleKey
   * @returns {string}
   */
  function describeUnmetRule(ruleKey) {
    const messagesByRule = {
      length: `Пароль має містити щонайменше ${MIN_PASSWORD_LENGTH} символів.`,
      uppercase: "Пароль має містити хоча б одну велику літеру.",
      digit: "Пароль має містити хоча б одну цифру.",
    };
    return messagesByRule[ruleKey] ?? "Пароль не відповідає вимогам.";
  }

  /** @param {string} message */
  function showError(message) {
    errorElement.textContent = message;
    errorElement.dataset.tone = "error";
    setVisibility(errorElement, true);
  }

  /** @param {string} message */
  function showSuccess(message) {
    errorElement.textContent = message;
    errorElement.dataset.tone = "success";
    setVisibility(errorElement, true);
  }

  /**
   * @param {unknown} error
   * @returns {string}
   */
  function describeRegistrationError(error) {
    if (
      error instanceof ApiError
      && (error.code === API_ERROR_CODE.rateLimited || error.code === API_ERROR_CODE.badRequest)
    ) {
      return error.message;
    }

    return "Не вдалося створити акаунт. Спробуйте пізніше.";
  }
}