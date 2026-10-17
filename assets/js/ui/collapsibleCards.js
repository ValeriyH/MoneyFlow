/**
 * collapsibleCards.js — згортання аналітичних карток на широких екранах.
 *
 * Стан запам'ятовується на пристрої: повернулись наступного дня —
 * картки згорнуті там само, де ви їх залишили. На вузьких екранах
 * згортання не застосовується (там показується одна картка за раз),
 * тому кнопки там приховані стилями.
 */

import { loadCollapsedCards, saveCollapsedCards } from "../core/localStore.js";
import { on } from "./dom.js";

/** @param {Element} cardElement */
function findHeaderButton(cardElement) {
  return cardElement.querySelector(".card__header--button");
}

/** @returns {void} підписується на стан сам і нікого не повертає */
export function initCollapsibleCards() {
  const collapsibleCards = [...document.querySelectorAll(".card--collapsible")];
  const collapsedCardKeys = loadCollapsedCards();

  for (const cardElement of collapsibleCards) {
    const collapseKey = cardElement.dataset.collapseKey;
    const headerButtonElement = findHeaderButton(cardElement);

    /** Застосувати стан «згорнуто / розгорнуто» до картки. */
    function renderCollapsedState() {
      const isCollapsed = collapsedCardKeys.has(collapseKey);

      cardElement.dataset.collapsed = String(isCollapsed);
      headerButtonElement.setAttribute("aria-expanded", String(!isCollapsed));
      headerButtonElement.title = isCollapsed
        ? "Показати вміст картки"
        : "Сховати вміст картки";
    }

    on(headerButtonElement, "click", () => {
      const wasCollapsed = collapsedCardKeys.has(collapseKey);

      if (wasCollapsed) {
        collapsedCardKeys.delete(collapseKey);
      } else {
        collapsedCardKeys.add(collapseKey);
      }

      saveCollapsedCards(collapsedCardKeys);
      renderCollapsedState();
    });

    renderCollapsedState();
  }
}