/**
 * budgetStore.js — the single source of truth on the client.
 *
 * Holds the current budget snapshot, a queue of unsynchronized records,
 * and the synchronization state. The UI subscribes to changes and re-renders.
 * No UI module knows how the network or localStorage is implemented.
 *
 * Core idea: any action first enters a queue and is immediately shown in the UI,
 * and only then is it sent to the server. Thus, the interface doesn't wait
 * for 3 seconds, and the queue guarantees delivery.
 *
 *
 */

import { SYNC_STATE } from "../config.js";
import {
  ApiError,
  API_ERROR_CODE,
  AUTH_FAILURE_CODES,
  deleteTransaction,
  fetchBudgetSnapshot,
  submitTransaction,
  updateTransaction,
  fetchGoals,
  adjustGoal,
} from "./apiClient.js";
import {
  clearCachedSnapshot,
  loadCachedSnapshot,
  loadPendingEntries,
  saveCachedSnapshot,
  savePendingEntries,
} from "./localStore.js";
import { currentPeriodKey, shiftPeriodKey } from "../domain/period.js";

/** Guest — state before the user logged in. */
const ANONYMOUS_VIEWER = { name: "", color: "#8b95a8" };

/**
 * Errors from which it makes sense to retry the request. The others
 * are server rejections "forever": category doesn't exist, session expired.
 * Such records must be discarded, otherwise they will block the rest of the queue.
 *
 *
 */
const RETRYABLE_ERROR_CODES = [
  API_ERROR_CODE.network,
  API_ERROR_CODE.timeout,
  API_ERROR_CODE.serverError,
  API_ERROR_CODE.rateLimited,
];

/**
 * How many months to keep in memory simultaneously.
 *
 * This is a safety net, not a plan: usually one or two months are in memory.
 * Growth starts only when someone switches back to older months.
 * Without a limit, the list of months would exceed the server's limit,
 * and then the app stop working — any request would fail with an error.
 *
 *
 */
const MAX_LOADED_PERIODS = 12;

/** @param {unknown} error */
function isWorthRetrying(error) {
  return error instanceof ApiError && RETRYABLE_ERROR_CODES.includes(error.code);
}

/**
 * Session expired: token signed correctly, all data in it is valid,
 * just time has passed.
 *
 * This is the only rejection after which it is sufficient to log in again:
 * records remain in the queue and will arrive after you log in again.
 * Other rejections (account disabled, password changed, token forged)
 * don't fall here: re-login won't fix them, and the record
 * would block the rest of the queue forever.
 *
 * @param {unknown} error
 *
 */
function isSessionExpired(error) {
  return error instanceof ApiError && error.code === API_ERROR_CODE.sessionExpired;
}

/**
 * @param {object} transaction
 * @returns {string} month key of the operation, "2026-10"
 *
 */
function periodKeyOf(transaction) {
  return String(transaction?.occurredOn ?? "").slice(0, 7);
}

/**
 * Which months came in the snapshot.
 *
 * The new server names them itself — it's more accurate than any derive
 * from dates, because a month without transactions would otherwise look
* like "not loaded". The older server doesn't have this field, then we
* take months from dates.
 *
 * @param {object} snapshot
 * @returns {Array<string>}
 *
 */
function readCoveredPeriods(snapshot) {
  if (Array.isArray(snapshot.periods) && snapshot.periods.length > 0) return snapshot.periods;
  return [...new Set((snapshot.transactions ?? []).map(periodKeyOf))];
}

/**
 * The month we are looking at, and the one preceding it.
 *
 * The previous one is needed not only for the "compared to last month"
* indicator, but also for distribution and limits. That's why it's not
* two independent requests, but always a pair: showing a month without
* its predecessor means showing half the panel and missing the comparison.
 *
 * @param {string} periodKey — "2026-10"
 * @returns {Array<string>} `['2026-10', '2026-09']`
 *
 */
function withPreviousPeriod(periodKey) {
  return [periodKey, shiftPeriodKey(periodKey, -1)];
}

/**
 * Keep no more than `limit` months.
 *
 * It's mandatory to keep `mustKeep` — otherwise the panels could forever
* stay on "Loading month...": the request would bring the required month
* and then immediately kick it out because there were already twelve
* newer ones in memory. The rest are filled with the newest — they are looked
* at more often.
 *
 * Discarded month is not lost forever: when it's opened again,
* a normal request will bring it back in three seconds.
 *
 * @param {Array<string>} periodKeys
 * @param {Array<string>} mustKeep
 * @param {number} limit
 * @returns {Array<string>}
 *
 */
function trimToLimit(periodKeys, mustKeep, limit) {
  if (periodKeys.length <= limit) return periodKeys;

  const kept = new Set(mustKeep);
  const others = periodKeys.filter((periodKey) => !kept.has(periodKey)).sort();

  for (const periodKey of others.slice(-Math.max(0, limit - kept.size))) {
    kept.add(periodKey);
  }

  return [...kept];
}

/**
 * How many months of the snapshot remain on disk.
 *
 * Offline is needed for "what I spent yesterday", not for the
 * history for two years. Three months is a bit more than 100 KB, and the
* numbers on the screen remain correct: a month in the cache is always whole.
 *
 *
 */
const CACHED_MONTHS_LIMIT = 3;

/**
 * Discard months older than the last ones.
 *
 * The limit is by months, not days: a partial month would give
 * a correct-looking, but incorrect sum. Better not to show
* the month at all, than to show half of it.
 *
 * @param {{ transactions: Array<object>, loadedPeriods: Array<string> }} snapshot
 * @param {string} activePeriodKey — it is not discarded even if it's the oldest
 * @returns {{ transactions: Array<object>, loadedPeriods: Array<string> }}
 *
 */
function trimSnapshotToRecentMonths(snapshot, activePeriodKey) {
  const keptPeriods = trimToLimit(
    snapshot.loadedPeriods ?? [],
    [activePeriodKey],
    CACHED_MONTHS_LIMIT,
  );

  if (keptPeriods.length === (snapshot.loadedPeriods ?? []).length) return snapshot;

  return Object.assign({}, snapshot, {
    loadedPeriods: keptPeriods,
    transactions: (snapshot.transactions ?? []).filter((transaction) =>
      keptPeriods.includes(String(transaction.occurredOn ?? "").slice(0, 7)),
    ),
  });
}
/** Not-mutable initial state — we return to it on error. */
function createInitialState() {
  return {
    /** @type {{ name: string, color: string }} who logged in */
    viewer: ANONYMOUS_VIEWER,
    /** @type {Array<object>} */
    categories: [],
    /** @type {Array<object>} */
    transactions: [],
    /**
     * @type {Array<string>} months, whose data is already in memory
     *
     * We don't keep the whole history, but only the open months: it's two
     * dozen kilobytes instead of two megabytes.
     */
    loadedPeriods: [],
    /** @type {Array<object>} actions that haven't reached the server yet */
    pendingEntries: loadPendingEntries(null),
    /** @type {string} ISO-time of the last successful synchronization */
    lastSyncedAt: null,
    /** @type {string} value of SYNC_STATE */
    syncState: SYNC_STATE.loading,
    /** @type {string} short explanation for the indicator */
    syncMessage: "",
    /** @type {string | null} machine code of the last error, if any */
    syncErrorCode: null,
    /**
     * The error itself of the last failure — so the login screen can distinguish
     * "wrong code" from "too many attempts" and show the appropriate one.
     * @type {Error | null}
     */
    lastSyncError: null,
    /** @type {Array<object>} */
    goals: [],
  };
}

class BudgetStore {
  #state = createInitialState();
  #listeners = new Set();
  #sessionToken = null;
  /** @type {string | null} login of the current session: the queue belongs to it */
  #sessionLogin = null;
  /** @type {Promise<void> | null} submission that is already in progress */
  #flushPromise = null;
  /** @type {Set<string>} months that are currently being loaded */
  #loadingPeriods = new Set();
  /** @type {string | null} month that the user is looking at now */
  #activePeriodKey = null;
  /**
   * @type {Map<string, Array<object>>} limits, already seen for this session
   *
   * Limits belong to the month, so "returning to October" means
   * seeing the October budget, and not the one that was on the screen
   * a moment ago. We keep them separately from the months, so that repeated
   * switching doesn't require another request.
   */
  #categoriesByLimitPeriod = new Map();
  /**
   * Token always goes with the login: they define whose queue
   * we read and whose records we send.
   *
   * @param {{ token: string, login: string } | null} session
   */
  setSession(session) {
    this.#sessionToken = session?.token ?? null;
    this.#sessionLogin = session?.login ?? null;

    // The queue changes with login, so we reload it from
    // memory: so that the UI shows only the user's own records.
    this.#patch({ pendingEntries: loadPendingEntries(this.#sessionLogin) });
  }

  /** @returns {Readonly<object>} */
  getState() {
    return this.#state;
  }

  /**
   * @param {(state: Readonly<object>) => void} listener
   * @returns {() => void} unsubscribe function
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @param {Partial<object>} patch */
  #patch(patch) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }

  /**
   * Hydration from cache — so that the page is not empty
   * while the request to Google is going.
   */
  hydrateFromCache() {
    const cachedSnapshot = loadCachedSnapshot();
    if (!cachedSnapshot) return;

    this.#patch({
      viewer: cachedSnapshot.viewer ?? ANONYMOUS_VIEWER,
      categories: cachedSnapshot.categories ?? [],
      transactions: cachedSnapshot.transactions ?? [],
      loadedPeriods: Array.isArray(cachedSnapshot.loadedPeriods)
        ? cachedSnapshot.loadedPeriods
        : readCoveredPeriods(cachedSnapshot),
      lastSyncedAt: cachedSnapshot.lastSyncedAt,
      pendingEntries: loadPendingEntries(this.#sessionLogin),
      goals: cachedSnapshot.goals ?? [],
    });
  }

  /**
   * Main synchronization loop:
   * first sends the queue, then reloads the table.
   * @returns {Promise<boolean>} — whether it succeeded
   */
  async synchronize() {
    this.#patch({ syncState: SYNC_STATE.loading, syncMessage: "", syncErrorCode: null, lastSyncError: null });

    try {
      await this.#flushPendingEntries();
      await this.#reloadSnapshot();

      this.#patch({ syncMessage: "" });
      this.#patchSyncStateFromQueue();
      return true;
    } catch (error) {
      this.#handleSyncError(error);
      return false;
    }
  }

  /**
   * Synchronized if and only when the queue is empty.
   * Extracted separately because the state is defined in several places.
   */
  #patchSyncStateFromQueue() {
    this.#patch({
      syncState: this.#state.pendingEntries.length > 0 ? SYNC_STATE.pending : SYNC_STATE.synced,
    });
  }

  /**
   * Sends the queue entry by entry, so the order is not violated.
   *
   * When an submission is already in progress, the second call joins it
   * and doesn't start a parallel one: otherwise two records could go twice.
   *
   * @returns {Promise<void>}
   */
  async #flushPendingEntries() {
    if (this.#flushPromise) return this.#flushPromise;

    this.#flushPromise = this.#sendQueuedEntries().finally(() => {
      this.#flushPromise = null;
    });

    return this.#flushPromise;
  }

  /**
   * Sends one queue entry with the corresponding action.
   *
   * There are three actions, but they all have one in common: all return
   * an updated snapshot, so `#sendQueuedEntries` doesn't know which
   * action was sent.
   *
   * @param {object} queuedEntry
   * @param {Array<string>} periods
   * @param {string} limitPeriod
   * @returns {Promise<{ snapshot: object }>}
   */
  async #sendQueuedEntry(queuedEntry, periods, limitPeriod) {
    if (queuedEntry.action === "delete") {
      return deleteTransaction(this.#sessionToken, queuedEntry.transactionId, periods, limitPeriod);
    }

    if (queuedEntry.action === "update") {
      return updateTransaction(this.#sessionToken, queuedEntry.transaction, periods, limitPeriod);
    }

    return submitTransaction(this.#sessionToken, queuedEntry.transaction, periods, limitPeriod);
  }

  /**
   * Processes the queue entries one by one — so that the order
   * is kept, and the record, which was added during the submission,
   * is also picked up in the same series, and doesn't remain
   * for later.
   *
   * @returns {Promise<void>}
   */
  async #sendQueuedEntries() {
    while (true) {
      const [nextQueuedEntry] = loadPendingEntries(this.#sessionLogin);
      if (!nextQueuedEntry) return;

      this.#patch({
        syncState: SYNC_STATE.pending,
        pendingEntries: loadPendingEntries(this.#sessionLogin),
      });

      try {
        const periods = this.#requestedPeriods();
        const limitPeriod = this.#limitPeriod();

        const response = await this.#sendQueuedEntry(nextQueuedEntry, periods, limitPeriod);

        this.#applySnapshot(response.snapshot, limitPeriod);
        this.#removeFromQueue(nextQueuedEntry.id);
      } catch (error) {
        // Expired session - not a failure: the record remains
        // in the queue and will arrive after the next login.
        if (isSessionExpired(error)) throw error;

        if (!isWorthRetrying(error)) {
          this.#discardPendingEntry(nextQueuedEntry.id);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Reloads the snapshot.
   *
   * `#applySnapshot` does this along with the reading, but the optimistic
   * copy disappears right after it — because of `#removeFromQueue`. Without
   * re-writing, the cache would keep it forever: when the tab is
   * refreshed, the merge wouldn't recognize it as the same record,
   * so two lines for the same expense would appear in the list.
   */
  async #reloadSnapshot() {
    this.#applySnapshot(
      await fetchBudgetSnapshot(this.#sessionToken, this.#requestedPeriods(), this.#limitPeriod()),
      this.#limitPeriod(),
    );
  }

  /**
   * Months we want to get from the server: already loaded
   * plus the open one and the one preceding it.
   *
   * Request only these months — otherwise the server snapshot
   * would wipe out what we already loaded. The open month is added
   * separately: it must be on the screen, even if it was kicked out
   * of memory by a more recent request.
   *
   * Always returns the full set, so a single request to the open
   * month doesn't require a separate request for the open month.
   *
   * @returns {Array<string>}
   */
  #requestedPeriods() {
    const activePeriod = this.#activePeriodKey ?? currentPeriodKey();
    const missingForActivePeriod = withPreviousPeriod(activePeriod)
      .filter((periodKey) => !this.#state.loadedPeriods.includes(periodKey));

    return [...new Set([...this.#state.loadedPeriods, ...missingForActivePeriod])];
  }

  /**
   * The month we are looking at: the one open on the screen.
   *
   * Limits are sent separately from operations just because
   * operations are needed for two months, while the budget — only for one.
   * Taking limits from all requested months would mean seeing the
   * October budget in September too, where it wasn't set.
   *
   * @returns {string}
   */
  #limitPeriod() {
    return this.#activePeriodKey ?? currentPeriodKey();
  }

  /**
   * Remembers which month the user is looking at.
   *
   * This is the only way the page affects what months
   * stay in memory: the open month cannot be kicked
   * out, because otherwise the panels would forever
   * stay empty: the request would bring the required month
   * and then immediately kick it out because there were already twelve
   * newer ones in memory.
   *
   * @param {string} periodKey — "2026-10"
   */
  setActivePeriod(periodKey) {
    this.#activePeriodKey = periodKey;
  }

  /**
   * Whether there is data for this month.
   * @param {string} periodKey — "2026-10"
   */
  isPeriodLoaded(periodKey) {
    return this.#state.loadedPeriods.includes(periodKey);
  }

  /**
   * Loads the month, if it's not in memory yet.
   *
   * The month and its predecessor are taken: the predecessor is needed
   * for the "comparison to last month" indicator. So the month is
   * only considered ready when its predecessor is also ready — otherwise
   * the comparison just won't appear, even though the data for it is
   * there.
   *
   * @param {string} periodKey — "2026-10"
   * @returns {Promise<void>}
   */
  async loadPeriod(periodKey) {
    if (!this.#sessionToken) return;

    const neededPeriods = withPreviousPeriod(periodKey);
    const areMonthsLoaded = neededPeriods.every((needed) => this.isPeriodLoaded(needed));
    const knownCategories = this.#categoriesByLimitPeriod.get(periodKey);

    // The month is already in memory and we already saw its limits — return
    // instantly, without a request. Limits are kept separately from months,
    // because they change along with which month is open.
    if (areMonthsLoaded && knownCategories) {
      this.#patch({ categories: knownCategories });
      return;
    }

    // Do not duplicate work, while the request with the same months is
    // still in flight. A fast switch between two clicks won't
    // produce two identical requests.
    if (neededPeriods.some((needed) => this.#loadingPeriods.has(needed))) return;
    neededPeriods.forEach((needed) => this.#loadingPeriods.add(needed));

    this.#patch({ syncState: SYNC_STATE.loading });

    try {
      const snapshot = await fetchBudgetSnapshot(this.#sessionToken, neededPeriods, periodKey);
      this.#applySnapshot(snapshot, periodKey);
      this.#patchSyncStateFromQueue();
    } catch (error) {
      this.#handleSyncError(error);
    } finally {
      neededPeriods.forEach((needed) => this.#loadingPeriods.delete(needed));
    }
  }

  /**
   * Applies the snapshot, sent along with the response to the action —
   * we skip the second request and take about 3 seconds.
   *
   * The snapshot covers only the months that were entered in it,
   * so operations from other months remain: added a record in April,
   * and the open month is March, so it doesn't disappear even if it
   * was kicked out from memory.
   *
   * If the server didn't return the snapshot (e.g.,
   * deployed an older version of the script) — reload
   * separately, so the app doesn't break.
   *
   * @param {object | undefined} snapshot
   * @param {string} limitPeriod — month whose limits came in the snapshot
   *
   */
  #applySnapshot(snapshot, limitPeriod) {
    if (!snapshot) return false;

    const coveredPeriods = readCoveredPeriods(snapshot);
    if (coveredPeriods.length === 0) return false;

    const categories = snapshot.categories ?? [];
    this.#categoriesByLimitPeriod.set(limitPeriod, categories);

    const snapshotTransactions = snapshot.transactions ?? [];
    const knownIds = new Set(snapshotTransactions.map((transaction) => transaction.id));

    // Other months remain as they are: unsynchronized records
    // survive even when their month comes into the snapshot:
    // the server doesn't know about them yet, so they can't be
    // replaced by anything, and they won't disappear out of thin air.
    const keptTransactions = this.#state.transactions.filter((transaction) => {
      if (!coveredPeriods.includes(periodKeyOf(transaction))) return true;
      return transaction.pending === true && !knownIds.has(transaction.id);
    });

    const loadedPeriods = trimToLimit(
      [...new Set([...this.#state.loadedPeriods, ...coveredPeriods])],
      [this.#activePeriodKey, ...coveredPeriods].filter((periodKey) => Boolean(periodKey)),
      MAX_LOADED_PERIODS,
    );

    // Months that fell out of memory are removed with them:
    // otherwise they would stay in the cache for no reason, and the
    // "loaded" flag would lie.
    const transactions = [...keptTransactions, ...snapshotTransactions].filter(
      (transaction) =>
        transaction.pending === true || loadedPeriods.includes(periodKeyOf(transaction)),
    );

    const nextState = {
      viewer: snapshot.viewer ?? ANONYMOUS_VIEWER,
      categories,
      transactions,
      loadedPeriods,
      lastSyncedAt: new Date().toISOString(),
      goals: snapshot.goals ?? [],
    };

    saveCachedSnapshot(trimSnapshotToRecentMonths(nextState, this.#activePeriodKey));
    this.#patch(nextState);
    return true;
  }

  /**
   * Extracts the error state.
   *
   * The code is saved separately from the text — so main.js can
   * take a decision about re-trying the password without
   * parsing strings.
   *
   * @param {unknown} error
   *
   */
  #handleSyncError(error) {
    const errorCode = error instanceof ApiError ? error.code : null;
    const errorMessage = error instanceof Error ? error.message : "Unknown synchronization error";

    if (AUTH_FAILURE_CODES.includes(errorCode)) {
      this.#patch({
        syncState: SYNC_STATE.error,
        syncMessage: errorMessage,
        syncErrorCode: errorCode,
        lastSyncError: error,
      });
      return;
    }

    const isOffline = errorCode === API_ERROR_CODE.network && !navigator.onLine;
    this.#patch({
      syncState: isOffline ? SYNC_STATE.offline : SYNC_STATE.error,
      syncMessage: errorMessage,
      syncErrorCode: errorCode,
      lastSyncError: error instanceof Error ? error : null,
    });
  }

  /**
   * Adds a transaction: first show it in UI, then send it.
   *
   * The `user` field is deliberately missing — the server sets it
   * from the session token, so it's impossible to forge the author.
   *
   * @param {object} transaction
   * @returns {Promise<{ deliveredImmediately: boolean, error: Error | null }>}
   */
  async addTransaction(transaction) {
    const queuedEntryId = this.#enqueuePendingEntry({ action: "add", transaction: { ...transaction } });

    try {
      await this.#flushPendingEntries();
      this.#patch({ syncMessage: "" });
      this.#patchSyncStateFromQueue();
      return { deliveredImmediately: true, error: null };
    } catch (error) {
      // Expired session - not a failure: the record remains
      // in the queue and will arrive after the next login.
      if (!isWorthRetrying(error) && !isSessionExpired(error)) {
        this.#discardPendingEntry(queuedEntryId);
        this.#patchSyncStateFromQueue();
      }
      return { deliveredImmediately: false, error };
    }
  }

  /**
   * @param {object} transaction
   * @returns {Promise<{ deliveredImmediately: boolean, error: Error | null }>}
   */
  async removeTransaction(transaction) {
    const queuedEntryId = this.#enqueuePendingEntry({ action: "delete", transactionId: transaction.id });

    try {
      await this.#flushPendingEntries();
      this.#patch({ syncMessage: "" });
      this.#patchSyncStateFromQueue();
      return { deliveredImmediately: true, error: null };
    } catch (error) {
      // Expired session - not a failure: the deletion remains
      // in the queue and will arrive after the next login.
      if (!isWorthRetrying(error) && !isSessionExpired(error)) {
        this.#discardPendingEntry(queuedEntryId);
        this.#patchSyncStateFromQueue();
      }
      return { deliveredImmediately: false, error };
    }
  }

  /**
   * Updates an existing record.
   *
   * Two cases, and they are fundamentally different:
   *
   *   the record is already in the table — send the `update` action,
   *     optimistically change it in place; id remains the server's,
   *     so merging with the snapshot will replace the copy
   *     with the version from the table;
   *
   *   the record is still in the queue — no separate action is needed.
   *     it hasn't reached the server yet, so just update the draft
   *     directly in the queue, otherwise the server would receive
   *     an `update` for a row that doesn't exist.
   *
   * @param {string} transactionId
   * @param {object} changes — sum, category, date, note
   * @returns {Promise<{ deliveredImmediately: boolean, error: Error | null }>}
   */
  async updateTransaction(transactionId, changes) {
    const previous = this.#state.transactions.find((candidate) => candidate.id === transactionId);

    if (!previous) {
      return { deliveredImmediately: false, error: new Error("Операцію вже не видно у списку") };
    }

    const queuedEntryId = previous.pending === true
      ? this.#amendQueuedEntry(transactionId, changes)
      : this.#enqueuePendingEntry({
          action: "update",
          transactionId,
          transaction: { ...previous, ...changes, recordedAt: new Date().toISOString() },
          // Previous values are needed to rollback the edit, if
          // the server ultimately rejects it: otherwise the record
          // would stay in the list with new values and just
          // wait forever.
          previous: { ...previous },
        });

    try {
      await this.#flushPendingEntries();
      this.#patch({ syncMessage: "" });
      this.#patchSyncStateFromQueue();
      return { deliveredImmediately: true, error: null };
    } catch (error) {
      if (!isWorthRetrying(error) && !isSessionExpired(error)) {
        this.#discardPendingEntry(queuedEntryId);
        this.#patchSyncStateFromQueue();
      }
      return { deliveredImmediately: false, error };
    }
  }

  /**
   * Amends a draft record that hasn't reached the server yet.
   *
   * No separate action is added to the queue: the record will be
   * created with the new values when the queue reaches it.
   *
   * @param {string} transactionId
   * @param {object} changes
   * @returns {string} the ID of the queue record now describing this edit
   */
  #amendQueuedEntry(transactionId, changes) {
    const currentEntries = loadPendingEntries(this.#sessionLogin);
    const amendedEntries = currentEntries.map((entry) =>
      entry.id === transactionId
        ? { ...entry, transaction: { ...entry.transaction, ...changes } }
        : entry,
    );

    savePendingEntries(this.#sessionLogin, amendedEntries);

    this.#patch({
      pendingEntries: amendedEntries,
      transactions: this.#state.transactions.map((candidate) =>
        candidate.id === transactionId ? { ...candidate, ...changes } : candidate,
      ),
    });

    return transactionId;
  }

  /**
   * Puts an action into the queue and immediately shows it in UI.
   *
   * The `user` field is deliberately missing — the server sets it
   * from the session token, so it's impossible to forge the author.
   *
   * @param {object} pendingAction
   * @returns {string} the ID of the record in the queue
   */
  #enqueuePendingEntry(pendingAction) {
    const queuedEntry = { ...pendingAction, id: crypto.randomUUID() };

    const updatedEntries = [...loadPendingEntries(this.#sessionLogin), queuedEntry];
    savePendingEntries(this.#sessionLogin, updatedEntries);

    const syncState = navigator.onLine ? SYNC_STATE.pending : SYNC_STATE.offline;

    if (queuedEntry.action === "add") {
      this.#patch({
        pendingEntries: updatedEntries,
        syncState,
        // The queue ID becomes the temporary record ID. Without it,
        // the optimistic copy would lack an identifier, and the
        // merge with the snapshot wouldn't recognize it
        // as the same record.
        transactions: [
          ...this.#state.transactions,
          { ...queuedEntry.transaction, id: queuedEntry.id, pending: true },
        ],
      });
    } else if (queuedEntry.action === "update") {
      // Editing changes the record in place: the id remains the server's,
      // so merging with the snapshot will replace the copy
      // with the version that came from the table.
      // The pending flag clears the merge with the original,
      // until the server eventually confirms it.
      this.#patch({
        pendingEntries: updatedEntries,
        syncState,
        transactions: this.#state.transactions.map((candidate) =>
          candidate.id === queuedEntry.transactionId
            ? { ...queuedEntry.transaction, pending: true }
            : candidate,
        ),
      });
    } else {
      this.#patch({
        pendingEntries: updatedEntries,
        syncState,
        transactions: this.#state.transactions.filter(
          (candidate) => candidate.id !== queuedEntry.transactionId,
        ),
      });
    }

    return queuedEntry.id;
  }

  /**
   * Updates the cache of the page.
   *
   * `#applySnapshot` does this along with the reading, but the
   * optimistic copy disappears right after it — because of `#removeFromQueue`.
   * Without re-writing, the cache would keep it forever: when the tab
   * is refreshed, the merge wouldn't recognize it
   * as the same record, so two lines for the same expense would appear
   * in the list.
   *
   *
   */
  #saveCache() {
    saveCachedSnapshot(trimSnapshotToRecentMonths({
      viewer: this.#state.viewer,
      categories: this.#state.categories,
      transactions: this.#state.transactions,
      loadedPeriods: this.#state.loadedPeriods,
      lastSyncedAt: this.#state.lastSyncedAt,
      goals: this.#state.goals,
    }, this.#activePeriodKey));
  }

  /** @param {string} queuedEntryId */
  #removeFromQueue(queuedEntryId) {
    const remainingEntries = loadPendingEntries(this.#sessionLogin).filter((entry) => entry.id !== queuedEntryId);
    savePendingEntries(this.#sessionLogin, remainingEntries);
    // The record from the server is already in the snapshot, so the
    // optimistic copy is removed: otherwise it would stay
    // in the list as a duplicate of the record already in the table.
    this.#patch({
      pendingEntries: remainingEntries,
      transactions: this.#state.transactions.filter(
        (transaction) => transaction.id !== queuedEntryId,
      ),
    });

    this.#saveCache();
  }

  /**
   * Adjusts the current goal amount (addition or subtraction).
   *
   * @param {object} goal — { id, amount } — amount can be positive (+) or negative (-)
   * @returns {Promise<{ success: boolean, error: ApiError | null }>}
   */
  async adjustGoal(goal) {
    if (!this.#sessionToken) return { success: false, error: new Error("Session not initialized") };

    try {
      const response = await adjustGoal(this.#sessionToken, goal.id, goal.amount);

      // Update the goal in the list (by ID)
      this.#patch({ 
        goals: this.#state.goals.map((g) => g.id === goal.id ? { ...g, progress: response.goal.progress, monthlyRequirement: response.goal.monthlyRequirement } : g) 
      });

      // Save to cache
      this.#saveCache();

      return { success: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === API_ERROR_CODE.sessionExpired) {
        throw error;
      }
      return { success: false, error };
    }
  }

  /**
   * Discards the action from the queue forever — when the server finally rejects it.
   * Retrying such a request is pointless: it would only block the rest of the queue.
   *
   * For editing, we rollback the record to previous values: otherwise
   * it would stay in the list with new values and the
   * flag "waiting", even though
   * it will never be sent.
   *
   * @param {string} queuedEntryId
   *
   */
  #discardPendingEntry(queuedEntryId) {
    const [discardedEntry] = loadPendingEntries(this.#sessionLogin)
      .filter((entry) => entry.id === queuedEntryId);
    const remainingEntries = loadPendingEntries(this.#sessionLogin).filter((entry) => entry.id !== queuedEntryId);
    savePendingEntries(this.#sessionLogin, remainingEntries);

    this.#patch({
      pendingEntries: remainingEntries,
      transactions: this.#state.transactions
        .filter((transaction) => transaction.id !== queuedEntryId)
        .map((transaction) =>
          discardedEntry?.action === "update" && transaction.id === discardedEntry.transactionId
            ? { ...discardedEntry.previous }
            : transaction,
        ),
    });

    this.#saveCache();
  }

  /**
   * Resets the state on logout ("forget password").
   *
   * The queue is NOT cleared: it belongs to the person, not the session,
   * and should arrive when they log in again. The snapshot cache is
   * cleared — it's the previous user's data, and the next user
   * shouldn't see it.
   */
  reset() {
    clearCachedSnapshot();
    this.#state = createInitialState();
    this.#state = { ...this.#state, pendingEntries: loadPendingEntries(this.#sessionLogin) };
    for (const listener of this.#listeners) listener(this.#state);
  }
}

export const budgetStore = new BudgetStore();