/**
 * userMenu.js — collapsible options menu under the user icon.
 *
 * It doesn't contain the items itself: the list is passed by main.js.
 * Therefore, a new option can be added with a single line in the dispatcher,
 * rather than by modifying this module's logic.
 *
 * This is a disclosure, not a standard ARIA menu: `role="menu"` requires
 * arrow key navigation and separate focus management, which is not needed here —
 * standard buttons already work with Tab and Enter.
 * Promising a role that doesn't exist is worse than not promising any.
 *
 *
 */

import { clearChildren, createElement, on } from "./dom.js";

/**
 * @typedef {object} UserMenuItem
 * @property {string} id
 * @property {string} label - text on the left
 * @property {() => string} [getValue] - current value on the right
 * @property {() => void} onSelect
 *
 *
 */

/**
 * @param {object} options
 * @param {HTMLElement} options.triggerElement - what opens the menu
 * @param {HTMLElement} options.menuElement
 * @param {HTMLElement} options.nameElement - "logged in as" line
 * @param {UserMenuItem[]} options.items
 * @returns {{ toggle: () => void, close: () => void, isOpen: () => boolean, setName: (name: string) => void }}
 *
 *
 */
export function initUserMenu({ triggerElement, menuElement, nameElement, items }) {
  const listElement = menuElement.querySelector(".user-menu__list");

  /**
   * Menu closes before taking action: after logout, the page
   * will reload, and after changing the theme, it would remain open
   * even though it's no longer visible.
   *
   *
 */
  function close() {
    if (menuElement.hidden) return;

    menuElement.hidden = true;
    triggerElement.setAttribute("aria-expanded", "false");
  }

  /**
   * Items are built every time: the value on the right (current theme)
   * might change while the menu was closed.
   *
   *
 */
  function renderItems() {
    clearChildren(listElement);

    for (const item of items) {
      const children = [createElement("span", { className: "user-menu__label", textContent: item.label })];

      if (item.getValue) {
        children.push(createElement("span", { className: "user-menu__value", textContent: item.getValue() }));
      }

      listElement.append(createElement("button", {
        className: "user-menu__item",
        attributes: { type: "button", "data-item": item.id },
        children,
      }));
    }
  }

  function open() {
    if (!menuElement.hidden) return;

    renderItems();
    menuElement.hidden = false;
    triggerElement.setAttribute("aria-expanded", "true");

    listElement.querySelector("button")?.focus();
  }

  function toggle() {
    if (menuElement.hidden) open();
    else close();
  }

  // Event is delegated to the list and not to each button: items
  // are rebuilt every time it's opened, and a listener on them would
  // only live for a short time.
  on(listElement, "click", (event) => {
    const itemElement = event.target.closest("[data-item]");
    if (!itemElement) return;

    const item = items.find((candidate) => candidate.id === itemElement.dataset.item);
    if (!item) return;

    close();

    // The button that had focus just disappeared. Return focus
    // to what opens the menu: otherwise Tab would continue from a place
    // that no longer exists, i.e., from the start of the page.
    triggerElement.focus();
    item.onSelect();
  });

  on(triggerElement, "click", toggle);

  // Click outside the menu is a document-level event, not on the container:
  // the menu cannot catch a click above it, but also doesn't see one outside it.
  on(document, "pointerdown", (event) => {
    if (menuElement.hidden) return;
    if (menuElement.contains(event.target) || triggerElement.contains(event.target)) return;

    close();
  });

  on(document, "keydown", (event) => {
    if (menuElement.hidden) return;
    if (event.key !== "Escape") return;

    // Focus is returned only here. On click outside the menu, we
    // return nothing: otherwise we'd steal focus from a user
    // who just clicked a checkbox somewhere on the page.
    close();
    triggerElement.focus();
  });

  /**
   * @param {string} name
   * @returns {void}
   *
   */
  function setName(name) {
    nameElement.textContent = name;
  }

  return { toggle, close, isOpen: () => !menuElement.hidden, setName };
}