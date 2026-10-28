/**
 * syncIndicator.js — synchronization status indicator in the header.
 *
 * This responds to the requirement "the user must know if everything is synced":
 * the status is visible via color and text constantly, and clicking triggers
 * a manual re-synchronization.
 *
 * Two independent sources make up the status: delivery of the transaction
 * queue and loading of the budget snapshot. The indicator combines them;
 * neither source knows about the other.
 *
 *
 */

import { SYNC_STATE, SYNC_STATE_LABELS } from "../config.js";
import { findById, on } from "./dom.js";

/**
 * @typedef {object} SyncSources
 * @property {{ isLoading: boolean, loadError: Error | null }} budget — snapshot loading
 * @property {{ pendingCount: number, isSending: boolean, lastError: Error | null }} queue — delivery
 */

/**
 * Without a connection any failure is, for the person, just "no network":
 * the indicator does not need to know error codes to say that.
 *
 * @returns {string} SYNC_STATE.offline or SYNC_STATE.error
 */
function stateForError() {
  return navigator.onLine ? SYNC_STATE.error : SYNC_STATE.offline;
}

/**
 * Priority: work in progress, then a delivery failure (records are at
 * stake), then a load failure, then waiting records, then all clear.
 *
 * @param {SyncSources} sources
 * @returns {{ state: string, error: Error | null }}
 */
function resolveSyncState({ budget, queue }) {
  if (queue.isSending || budget.isLoading) return { state: SYNC_STATE.loading, error: null };
  if (queue.lastError && queue.pendingCount > 0) return { state: stateForError(queue.lastError), error: queue.lastError };
  if (budget.loadError) return { state: stateForError(budget.loadError), error: budget.loadError };
  if (queue.pendingCount > 0) {
    return { state: navigator.onLine ? SYNC_STATE.pending : SYNC_STATE.offline, error: null };
  }
  return { state: SYNC_STATE.synced, error: null };
}

/**
 * @param {object} dependencies
 * @param {() => void} dependencies.onManualSync
 * @returns {{ render: (sources: SyncSources) => void }}
 *
 *
 */
export function initSyncIndicator({ onManualSync }) {
  const syncIndicatorElement = findById("syncIndicator");
  const syncTextElement = syncIndicatorElement.querySelector(".sync-indicator__text");
  let currentState = SYNC_STATE.loading;

  on(syncIndicatorElement, "click", () => {
    if (currentState === SYNC_STATE.loading) return;
    onManualSync();
  });

  /**
   * @param {SyncSources} sources
   * @returns {void}
   */
  function render(sources) {
    const { state, error } = resolveSyncState(sources);
    currentState = state;

    syncIndicatorElement.dataset.state = state;
    syncTextElement.textContent = buildShortLabel(state, sources.queue.pendingCount);
    syncIndicatorElement.title = buildTooltip(state, error, sources.queue.pendingCount);
  }

  /**
   * In the header, it should be short: a long explanation makes the line
   * too wide. The full text lives in the tooltip and in the pop-up message.
   *
   * @param {string} state
   * @param {number} pendingCount
   * @returns {string}
   *
   */
  function buildShortLabel(state, pendingCount) {
    const label = SYNC_STATE_LABELS[state] ?? "";
    return label.replace("{count}", String(pendingCount));
  }

  /**
   * @param {string} state
   * @param {Error | null} error
   * @param {number} pendingCount
   * @returns {string}
   *
   */
  function buildTooltip(state, error, pendingCount) {
    if (pendingCount > 0) {
      return `${pendingCount} записів чекають на відправку. Натисніть, щоб спробувати ще раз.`;
    }

    if (state === SYNC_STATE.error || state === SYNC_STATE.offline) {
      return error?.message || "Натисніть, щоб спробувати синхронізувати ще раз";
    }

    return "Натисніть, щоб синхронізувати з Google Таблицею";
  }

  return { render };
}
