/**
 * viewSwitcher.js — таби розділів на вузьких екранах.
 *
 * На широких екранах таби приховані стилями, а `.app-main` показує
 * обидві колонки. Тому модуль просто виставляє `data-active-view`
 * на контейнер — розкручування вже описано одним CSS-правилом.
 */

import { APP_VIEWS, DEFAULT_APP_VIEW } from "../config.js";
import { loadActiveView, saveActiveView } from "../core/localStore.js";
import { findById, on } from "./dom.js";

const VALID_VIEW_NAMES = Object.values(APP_VIEWS);

/** @returns {{ activateView: (viewName: string) => void }} */
export function initViewSwitcher() {
  const appMainElement = findById("appMain");
  const viewTabsElement = findById("viewTabs");
  const tabElements = [...viewTabsElement.querySelectorAll(".view-tabs__tab")];

  /** Розділ, який показується зараз. */
  let activeViewName = readRememberedView();

  /** Застосовує стан до контейнера й табів. */
  function applyActiveView() {
    appMainElement.dataset.activeView = activeViewName;

    for (const tabElement of tabElements) {
      const isActive = tabElement.dataset.view === activeViewName;
      tabElement.classList.toggle("is-active", isActive);
      tabElement.setAttribute("aria-selected", String(isActive));
    }
  }

  /**
   * @param {string} viewName
   */
  function activateView(viewName) {
    if (!VALID_VIEW_NAMES.includes(viewName)) return;

    activeViewName = viewName;
    saveActiveView(viewName);
    applyActiveView();
  }

  for (const tabElement of tabElements) {
    on(tabElement, "click", () => activateView(tabElement.dataset.view));
  }

  applyActiveView();

  return { activateView };
}

/** @returns {string} */
function readRememberedView() {
  const rememberedView = loadActiveView();
  return VALID_VIEW_NAMES.includes(rememberedView) ? rememberedView : DEFAULT_APP_VIEW;
}