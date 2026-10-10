/**
 * registrationPanel.js — форма самостійної реєстрації.
 *
 * Живе на екрані входу поруч із формою входу. Людина обирає ім'я
 * та пароль, і вони потрапляють у таблицю як неактивний рядок.
 * Увійти можна буде лише після того, як власник таблиці увімкне
 * цей рядок у колонці «Активний».
 */

import { ApiError, API_ERROR_CODE, requestUserRegistration } from "../core/apiClient.js";
import { findById, on, setVisibility } from "./dom.js";

/** Ті самі вимоги, що й на сервері. Клієнт показує їх раніше. */
const PASSWORD_RULES = [
  { key: "length", isMet: (value) => value.length >= 10 },
  { key: "uppercase", isMet: (value) => /[A-Z]/.test(value) },
  { key: "digit", isMet: (value) => /\d/.test(value) },
];

export function initRegistrationPanel() {
  const loginFormElement = findById("accessGateForm");
  const registrationFormElement = findById("registrationForm");
  const nameInputElement = findById("registrationNameInput");
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
    findById("accessTokenInput").focus();
  }

  function showRegistrationForm() {
    setVisibility(loginFormElement, false);
    setVisibility(registrationFormElement, true);
    nameInputElement.focus();
  }

  on(findById("showRegistrationButton"), "click", showRegistrationForm);
  on(findById("showLoginButton"), "click", showLoginForm);

  on(registrationFormElement, "submit", async (event) => {
    event.preventDefault();
    if (submitButtonElement.disabled) return;

    const userName = nameInputElement.value.trim();
    const password = passwordInputElement.value;

    if (userName.length < 2) {
      showError("Введіть ім'я — щонайменше 2 символи.");
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
      await requestUserRegistration(userName, password);

      registrationFormElement.reset();
      renderPasswordRequirements();
      showSuccess(
        `Акаунт «${userName}» створено. Він зможе увійти, ` +
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
      length: "Пароль має містити щонайменше 10 символів.",
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
    if (error instanceof ApiError && error.code === API_ERROR_CODE.rateLimited) {
      return error.message;
    }

    if (error instanceof ApiError && error.code === API_ERROR_CODE.badRequest) {
      return error.message;
    }

    return "Не вдалося створити акаунт. Спробуйте пізніше.";
  }
}