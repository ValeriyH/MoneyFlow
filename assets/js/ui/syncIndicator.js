/**
 * syncIndicator.js — позначка стану синхронізації у шапці.
 *
 * Це відповідь на вимогу «користувач має знати, чи все синхронізовано»:
 * стан кольором і текстом видимий постійно, а натискання запускає
 * повторну синхронізацію вручну.
 */

import { SYNC_STATE, SYNC_STATE_LABELS } from "../config.js";
import { findById, on } from "./dom.js";

/**
 * @param {object} dependencies
 * @param {import('../core/budgetStore.js').budgetStore} dependencies.store
 * @param {() => void} dependencies.onManualSync
 * @returns {{ render: (state: Readonly<object>) => void }}
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
   */
  function render(state) {
    syncIndicatorElement.dataset.state = state.syncState;
    syncTextElement.textContent = buildShortLabel(state);
    syncIndicatorElement.title = buildTooltip(state);
  }

  /**
   * У шапці має бути коротко: довге пояснення робить рядок занадто
   * широким. Повний текст живе в підказці та в спливаючому повідомленні.
   *
   * @param {Readonly<object>} state
   * @returns {string}
   */
  function buildShortLabel(state) {
    const label = SYNC_STATE_LABELS[state.syncState] ?? "";

    // Шаблон із підстановкою не має потрапити в інтерфейс навіть
    // у разі, коли стан раптом не сходиться з чергою.
    if (label.includes("{count}")) {
      return `Черга: ${state.pendingEntries.length}`;
    }

    return label;
  }

  /**
   * @param {Readonly<object>} state
   * @returns {string}
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