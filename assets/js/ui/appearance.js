/**
 * appearance.js — вигляд застосунку: світлий або темний.
 *
 * Вибір живе в localStorage (moneyflow.ui-style), а застосовується
 * атрибутом data-style на <html>: браузер просто перечитує каскадні
 * правила, тож перемикання не перемальовує DOM і нічого не чекає.
 *
 * Ставимо атрибут двома способами навмисно: інлайн-скриптом у
 * <head> — щоб не було спалаху світлим на темній темі — і звідси,
 * щоб працювати після першого малювання.
 *
 * Модуль не має кнопки: перемикачем є пункт меню, а хто саме
 * показує йому поточне значення, вирішує main.js.
 */

import { UI_STYLE_CLASSIC, UI_STYLE_SOLID } from "../config.js";
import { saveUiStyle } from "../core/localStore.js";

/**
 * Підписи для меню. Людина має бачити різницю («світла», «темна»),
 * а не внутрішні імена вигляду: «solid» їй ніщо не каже.
 */
const STYLE_LABELS = {
  [UI_STYLE_CLASSIC]: "Світла",
  [UI_STYLE_SOLID]: "Темна",
};

/**
 * Колір панелей браузера — верхньої адресної смужки й нижньої
 * навігаційної. Браузер бере його з метатега, а не з CSS, тому
 * статичне значення в темній темі лишає ці смужки білими.
 *
 * Значення мусять збігатися з `--color-canvas` кожного вигляду:
 * світлий `#f1f4f8`, темний `#0d1014`.
 */
const THEME_COLOR_CLASSIC = "#f1f4f8";
const THEME_COLOR_SOLID = "#0d1014";

/**
 * Чи ввімкнено темний вигляд.
 *
 * @returns {boolean}
 */
function isDarkSelected() {
  return document.documentElement.getAttribute("data-style") === UI_STYLE_SOLID;
}

/**
 * Ставить колір панелей браузера.
 *
 * @param {string} styleName
 * @returns {void}
 */
function applyThemeColor(styleName) {
  const metaElement = document.querySelector('meta[name="theme-color"]');
  if (!metaElement) return;

  metaElement.setAttribute(
    "content",
    styleName === UI_STYLE_SOLID ? THEME_COLOR_SOLID : THEME_COLOR_CLASSIC,
  );
}

/**
 * Перемикає тему й запам'ятовує вибір.
 *
 * @returns {void}
 */
export function toggleAppearance() {
  const nextStyleName = isDarkSelected() ? UI_STYLE_CLASSIC : UI_STYLE_SOLID;

  applyStyle(nextStyleName);
  saveUiStyle(nextStyleName);
}

/**
 * Яка тема зараз — для меню.
 *
 * @returns {string}
 */
export function describeAppearance() {
  return isDarkSelected() ? STYLE_LABELS[UI_STYLE_SOLID] : STYLE_LABELS[UI_STYLE_CLASSIC];
}

/**
 * Вирівнює колір панелей браузера з виглядом.
 *
 * Потрібне окремо від перемикання: мітка в <head> могла не
 * спрацювати (приватний режим, пошкоджене значення в сховищі), і
 * тоді браузер показав би світлі смужки у темному вигляді.
 *
 * @returns {void}
 */
export function syncThemeColor() {
  applyThemeColor(isDarkSelected() ? UI_STYLE_SOLID : UI_STYLE_CLASSIC);
}

/**
 * @param {string} styleName
 * @returns {void}
 */
function applyStyle(styleName) {
  if (styleName === UI_STYLE_SOLID) {
    document.documentElement.setAttribute("data-style", UI_STYLE_SOLID);
  } else {
    document.documentElement.removeAttribute("data-style");
  }

  applyThemeColor(styleName);
}