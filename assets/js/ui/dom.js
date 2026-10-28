/**
 * dom.js — utility functions wrapped around the DOM API.
 * Goal: remove repetition of querySelector, element creation,
 * attribute formatting, and visibility management from the UI layer.
 *
 *
 */
 
/**
 * Finds a single element by its identifier.
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
 * Creates an element with the specified class, attributes, and content.
 * @param {string} tagName
 * @param {{ className?: string, textContent?: string, dataset?: Record<string, string>, attributes?: Record<string, string>, children?: Array<Node> }} [options]
 * @returns {HTMLElement}
 *
 *
 */
export function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);
 
  if (options.className) element.className = options.className;
  if (options.textContent !== undefined) element.textContent = options.textContent;
 
  if (options.children) {
    element.append(...options.children);
  }
 
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
 * Shows or hides an element via the `hidden` attribute.
 * @param {HTMLElement} element
 * @param {boolean} isVisible
 * @returns {void}
 *
 *
 */
export function setVisibility(element, isVisible) {
  element.hidden = !isVisible;
}
 
/**
 * Removes all children of the container before re-rendering the list.
 * @param {HTMLElement} container
 * @returns {void}
 *
 *
 */
export function clearChildren(container) {
  container.replaceChildren();
}
 
/**
 * Sets a text state into an element with a semantic color (`data-tone`).
 * @param {HTMLElement} element
 * @param {string} message
 * @param {string} [tone] - success | error | warning | pending
 * @returns {void}
 *
 *
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
 * Subscribes a handler to an event and returns an unsubscribe function.
 * @param {EventTarget} target
 * @param {string} eventName
 * @param {EventListener} handler
 * @returns {() => void}
 *
*
 */
export function on(target, eventName, handler) {
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
}