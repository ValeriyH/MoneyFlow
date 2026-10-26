/**
 * appearance.js — theme management: light or dark.
 *
 * The choice is stored in localStorage (moneyflow.ui-style) and applied
 * via the data-style attribute on <html>: the browser simply re-reads
 * the cascade rules, so switching doesn't repaint the DOM or wait.
 *
 * We set the attribute in two ways intentionally: an inline script in
 * <head> — to prevent a flash of light theme on a dark theme — and from
 * here, to ensure it works after the first render.
 *
 * This module doesn't have a button: the toggle is in the menu, and
 * who shows it the current value is decided by main.js.
 *
 *
 */
 
import { UI_STYLE_CLASSIC, UI_STYLE_SOLID } from "../config.js";
import { saveUiStyle } from "../core/localStore.js";
 
/**
 * Labels for the menu. A person must see the difference ("light", "dark"),
 * not internal style names: "solid" tells them nothing.
 *
 *
 */
const STYLE_LABELS = {
  [UI_STYLE_CLASSIC]: "Світла",
  [UI_STYLE_SOLID]: "Темна",
};
 
/**
 * Browser panel colors — the top address bar and bottom navigation bar.
 * The browser takes these from the meta tag, not from CSS, so a
 * static value in a dark theme would leave these bars white.
 *
 * Values must match the --color-canvas of each style:
 * light #f1f4f8, dark #0d1014.
 *
 *
 */
const THEME_COLOR_CLASSIC = "#f1f4f8";
const THEME_COLOR_SOLID = "#0d1014";
 
/**
 * Is dark style selected?
 *
 * @returns {boolean}
 *
 *
 */
function isDarkSelected() {
  return document.documentElement.getAttribute("data-style") === UI_STYLE_SOLID;
}
 
/**
 * Sets the browser panel color.
 *
 * @param {string} styleName
 * @returns {void}
 *
 *
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
 * Switches the theme and saves the choice.
 *
 * @returns {void}
 *
 *
 */
export function toggleAppearance() {
  const nextStyleName = isDarkSelected() ? UI_STYLE_CLASSIC : UI_STYLE_SOLID;
 
  applyStyle(nextStyleName);
  saveUiStyle(nextStyleName);
}
 
/**
 * Current theme — for the menu.
 *
 * @returns {string}
 *
 *
 */
export function describeAppearance() {
  return isDarkSelected() ? STYLE_LABELS[UI_STYLE_SOLID] : STYLE_LABELS[UI_STYLE_CLASSIC];
}
 
/**
 * Aligns the browser panel color with the style.
 *
 * This is needed separately from the toggle: the tag in <head> might
 * not have worked (private mode, corrupted value in storage), and
 * then the browser would show light bars in a dark theme.
 *
 * @returns {void}
 *
 *
 */
export function syncThemeColor() {
  applyThemeColor(isDarkSelected() ? UI_STYLE_SOLID : UI_STYLE_CLASSIC);
}
 
/**
 * @param {string} styleName
 * @returns {void}
 *
 *
 */
function applyStyle(styleName) {
  if (styleName === UI_STYLE_SOLID) {
    document.documentElement.setAttribute("data-style", UI_STYLE_SOLID);
  } else {
    document.documentElement.removeAttribute("data-style");
  }
 
  applyThemeColor(styleName);
}