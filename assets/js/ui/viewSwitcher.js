/**
 * viewSwitcher.js — section tabs on narrow screens.
 *
 * On wide screens, tabs are hidden by styles, and `.app-main` shows
 * both columns. Therefore, this module simply sets `data-active-view`
 * on the container — the expansion is already described by a single CSS rule.
 *
 *
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

  /** Current section being displayed. */
  let activeViewName = readRememberedView();

  /** Applies the state to the container and tabs. */
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
   *
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