/**
 * dom.js — тонкі утиліти над DOM API.
 * Мета: прибрати з UI-шар повторення querySelector, створення елементів,
 * форматування атрибутів та керування видимістю.
 */

/**
 * Знаходить один елемент за ідентифікатором.
 * @param {string} elementId
 * @returns {HTMLElement}
 */
export function findById(elementId) {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Не знайдено елемент з id="${elementId}"`);
  }
  return element;
}

/**
 * Створює елемент із вказаними класом, атрибутами та вмістом.
 * @param {string} tagName
 * @param {{ className?: string, textContent?: string, dataset?: Record<string, string>, attributes?: Record<string, string> }} options
 * @returns {HTMLElement}
 */
export function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) element.className = options.className;
  if (options.textContent !== undefined) element.textContent = options.textContent;

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      element.dataset[key] = value;
    }
  }

  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) {
      element.setAttribute(name, value);
    }
  }

  return element;
}

/**
 * Показує або ховає елемент через атрибут `hidden`.
 * @param {HTMLElement} element
 * @param {boolean} isVisible
 */
export function setVisibility(element, isVisible) {
  element.hidden = !isVisible;
}

/**
 * Прибирає всі нащадки контейнера перед повторним рендером списку.
 * @param {HTMLElement} container
 */
export function clearChildren(container) {
  container.replaceChildren();
}

/**
 * Записує текстовий стан у елемент із семантичним кольором (`data-tone`).
 * @param {HTMLElement} element
 * @param {string} message
 * @param {string} [tone] — success | error | warning | pending
 */
export function setStatusMessage(element, message, tone) {
  element.textContent = message;

  if (tone) {
    element.dataset.tone = tone;
  } else {
    delete element.dataset.tone;
  }
}

/**
 * Підписує обробник на подію та повертає функцію відписки.
 * @param {EventTarget} target
 * @param {string} eventName
 * @param {EventListener} handler
 * @returns {() => void}
 */
export function on(target, eventName, handler) {
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
}