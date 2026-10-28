/**
 * syncIndicator.js — synchronization status indicator in the header.
 *
 * This responds to the requirement "the user must know if everything is synced":
 * the status is visible via color and text constantly, and clicking triggers
 * a manual re-synchronization.
 *
 *
 */

import { SYNC_STATE, SYNC_STATE_LABELS } from "../config.js";
import { findById, on } from "./dom.js";

/**
 * @param {object} dependencies
 * @param {import('../core/budgetStore.js').budgetStore} dependencies.store
 * @param {() => void} dependencies.onManualSync
 * @returns {{ render: (state: Readonly<object>) => void }}
 *
 *
 */
export function initSyncIndicator({ store, onManualSync }) {
  const syncIndicatorElement = findById("syncIndicator");
  const syncTextElement = syncIndicatorElement.querySelector(".sync-indicator__text");

  on(syncIndicatorElement, "click", () => {
    if (store.getState().syncState === SYNC_STATE.loading) return;
    onManualSync();
  });

  /**
   * @param {Readonly<object>} state
   *
   */
  function render(state) {
    syncIndicatorElement.dataset.state = state.syncState;
    syncTextElement.textContent = buildShortLabel(state);
    syncIndicatorElement.title = buildTooltip(state);
  }

  /**
   * In the header, it should be short: a long explanation makes the line
   * too wide. The full text lives in the tooltip and in the pop-up message.
   *
   * @param {Readonly<object>} state
   * @returns {string}
   *
   */
  function buildShortLabel(state) {
    const label = SYNC_STATE_LABELS[state.syncState] ?? "";

    // The template with a placeholder should not end up in the interface
    // even if the state suddenly doesn't match the queue.
    if (label.includes("{count}")) {
      return `Черга: ${state.pendingEntries.length}`;
    }

    return label;
  }

  /**
   * @param {Readonly<object>} state
   * @returns {string}
   *
   */
  function buildTooltip(state) {
    if (state.pendingEntries.length > 0) {
      return `${state.pendingEntries.length} записів чекають на відправку. Натисніть, щоб спробувати ще раз.`;
    }

    if (state.syncState === SYNC_STATE.error || state.syncState === SYNC_STATE.offline) {
      return state.syncMessage || "Натисніть, щоб спробувати синхронізувати ще раз";
    }

    return "Натисніть, щоб синхронізувати з Google Таблицею";
  }

  return { render };
}