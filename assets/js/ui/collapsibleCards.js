/**
 * collapsibleCards.js — collapsing analytical cards on wide screens.
 *
 * State is remembered on the device: return the next day —
 * cards are collapsed exactly where you left them. On narrow screens,
 * collapsing is not applied (one card is shown at a time there),
 * so buttons are hidden by styles.
 *
 *
 */
 
import { loadCollapsedCards, saveCollapsedCards } from "../core/localStore.js";
import { on } from "./dom.js";
 
/** @param {Element} cardElement */
function findHeaderButton(cardElement) {
  return cardElement.querySelector(".card__header--button");
}
 
/** @returns {void} subscribed to state itself and returns nothing */
export function initCollapsibleCards() {
  const collapsibleCards = [...document.querySelectorAll(".card--collapsible")];
  const collapsedCardKeys = loadCollapsedCards();
 
  for (const cardElement of collapsibleCards) {
    const collapseKey = cardElement.dataset.collapseKey;
    const headerButtonElement = findHeaderButton(cardElement);
 
    /** Apply the "collapsed / expanded" state to the card. */
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