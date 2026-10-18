/**
 * styleToggle.js — перемикання між звичайним і новим виглядом.
 *
 * Новий вигляд живе в assets/css/solid.css і вмикається атрибутом
 * на <html>. Тому перемикання — це один рядок, а не перезавантаження
 * і не перемальовування DOM: браузер просто перечитає каскадні
 * правила.
 *
 * Ставимо атрибут двома способами навмисно: інлайн-скриптом у
 * <head> — щоб не було спалаху світлим на темній темі — і з
 * модуля, щоб працювати після першого малювання.
 */

import { UI_STYLE_CLASSIC, UI_STYLE_SOLID } from "../config.js";
import { loadUiStyle, saveUiStyle } from "../core/localStore.js";
import { findById, on } from "./dom.js";

/**
 * Чи вибраний новий вигляд.
 * @returns {boolean}
 */
function isSolidSelected() {
  return document.documentElement.getAttribute("data-style") === UI_STYLE_SOLID;
}

/**
 * Застосовує вигляд до <html>.
 *
 * @param {string} styleName
 * @returns {void}
 */
function applyStyle(styleName) {
  if (styleName === UI_STYLE_SOLID) {
    document.documentElement.setAttribute("data-style", UI_STYLE_SOLID);
  } else {
    document.documentElement.removeAttribute("data-style");
  }
}

/**
 * Оновлює підпис і стан кнопки.
 *
 * Кнопка показує те, що буде після натискання, а не те, що є
 * зараз: так напис «Стиль: новий» читається як перемикач, а не
 * як стан.
 *
 * @param {HTMLElement} buttonElement
 * @returns {void}
 */
function renderToggle(buttonElement) {
  const solidSelected = isSolidSelected();

  buttonElement.setAttribute("aria-pressed", String(solidSelected));
  buttonElement.title = solidSelected
    ? "Повернути попередній вигляд"
    : "Спробувати новий вигляд";

  const textElement = buttonElement.querySelector(".style-toggle__text");
  if (textElement) {
    textElement.textContent = solidSelected ? "Новий вигляд" : "Старий вигляд";
  }
}

/**
 * @returns {{ render: () => void }}
 */
export function initStyleToggle() {
  const buttonElement = findById("styleToggleButton");

  on(buttonElement, "click", () => {
    const nextStyle = isSolidSelected() ? UI_STYLE_CLASSIC : UI_STYLE_SOLID;

    applyStyle(nextStyle);
    saveUiStyle(nextStyle);
    renderToggle(buttonElement);
  });

  renderToggle(buttonElement);

  return { render: () => renderToggle(buttonElement) };
}