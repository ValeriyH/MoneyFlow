/**
 * toast.js — короткі спливаючі повідомлення.
 * Використовується для підтвердження дій, які не мають місця
 * на самій сторінці: синхронізація, видалення, помилки мережі.
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