/**
 * toast.js — short pop-up messages.
 * Used to confirm actions that are not located
 * on the page itself: synchronization, deletion, network errors.
 *
 *
 */

import { createElement, findById } from "./dom.js";

const TOAST_LIFETIME_MS = 4200;

/** @returns {HTMLElement} */
function getToastHost() {
  return findById("toastHost");
}

/**
 * @param {string} message
 * @param {'success' | 'error' | 'warning' | 'neutral'} [tone]
 * @returns {void}
 *
 *
 */
export function showToast(message, tone = "neutral") {
  const toastElement = createElement("div", {
    className: "toast",
    textContent: message,
  });
  toastElement.dataset.tone = tone;

  const toastHost = getToastHost();
  toastHost.append(toastElement);

  setTimeout(() => {
    toastElement.style.opacity = "0";
    toastElement.style.transition = "opacity 200ms";
  }, TOAST_LIFETIME_MS - 200);

  setTimeout(() => toastElement.remove(), TOAST_LIFETIME_MS);
}