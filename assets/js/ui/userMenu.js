/**
 * userMenu.js — спливаюче меню опцій під іконкою користувача.
 *
 * Вмісту в себе не має: список пунктів передає main.js. Тому нова
 * можливість додається одним рядком у диспетчері, а не правкою
 * розжки й розсипанням логіки по цьому модулю.
 *
 * Це розкриття, а не меню за стандартом ARIA: `role="menu"` вимагає
 * керування стрілками й окремої стрічки фокуса, чого тут немає й
 * не потрібно — звичайні кнопки вже працюють Tab-ом і Enter-ом.
 * Обіцяти роль, якої немає, гірше, ніж не обіцяти жодної.
 */

import { clearChildren, createElement, on } from "./dom.js";

/**
 * @typedef {object} UserMenuItem
 * @property {string} id
 * @property {string} label - текст ліворуч
 * @property {() => string} [getValue] - поточне значення праворуч
 * @property {() => void} onSelect
 */

/**
 * @param {object} options
 * @param {HTMLElement} options.triggerElement - що відкриває меню
 * @param {HTMLElement} options.menuElement
 * @param {HTMLElement} options.nameElement - рядок «під ким увійшли»
 * @param {UserMenuItem[]} options.items
 * @returns {{ toggle: () => void, close: () => void, isOpen: () => boolean, setName: (name: string) => void }}
 */
export function initUserMenu({ triggerElement, menuElement, nameElement, items }) {
  const listElement = menuElement.querySelector(".user-menu__list");

  /**
   * Меню закривається до виконання дії: після виходу сторінка
   * перезавантажиться, а після зміни теми лишився б відкритим
   * попри те, що його вже не видно.
   */
  function close() {
    if (menuElement.hidden) return;

    menuElement.hidden = true;
    triggerElement.setAttribute("aria-expanded", "false");
  }

  /**
   * Пункти будуємо щоразу: значення праворуч (яка тема зараз)
   * може змінитися, поки меню було закрите.
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

  // Подія делегується списку, а не кожній кнопці: пункти
  // перебудовуються при кожному відкритті, і слухач на них жив би
  // недовго.
  on(listElement, "click", (event) => {
    const itemElement = event.target.closest("[data-item]");
    if (!itemElement) return;

    const item = items.find((candidate) => candidate.id === itemElement.dataset.item);
    if (!item) return;

    close();

    // Кнопка, на якій стояв фокус, щойно зникла. Повертаємо фокус
    // на те, що меню відкриває: інакше Tab продовжив би з місця,
    // якого вже немає, тобто з початку сторінки.
    triggerElement.focus();
    item.onSelect();
  });

  on(triggerElement, "click", toggle);

  // Клік поза меню — це подія на документі, а не на контейнері:
  // меню не може перехопити клік угорі, але й бачити той, що поза ним.
  on(document, "pointerdown", (event) => {
    if (menuElement.hidden) return;
    if (menuElement.contains(event.target) || triggerElement.contains(event.target)) return;

    close();
  });

  on(document, "keydown", (event) => {
    if (menuElement.hidden) return;
    if (event.key !== "Escape") return;

    // Фокус повертаємо лише тут. На кліку поза меншим ми не
    // повертаємо нічого: інакше перехоплювали б фокус у людини,
    // яка щойно поставила галочку деінде на сторінці.
    close();
    triggerElement.focus();
  });

  /**
   * @param {string} name
   * @returns {void}
   */
  function setName(name) {
    nameElement.textContent = name;
  }

  return { toggle, close, isOpen: () => !menuElement.hidden, setName };
}