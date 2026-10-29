/**
 * budgetStore.js — the single source of truth for the budget on the client.
 *
 * Holds the current budget snapshot and the synchronization state. The UI
 * subscribes to changes and re-renders. No UI module knows how the network
 * or localStorage is implemented.
 *
 * Core idea: any action first enters the transaction queue and is immediately
 * shown in the UI, and only then is it sent to the server. Thus, the interface
 * doesn't wait for 3 seconds, and the queue guarantees delivery. What the UI
 * sees is the server snapshot with queued expense operations applied on top.
 *
 *
 */

import { fetchBudgetSnapshot } from "./apiClient.js";
import {
  clearCachedSnapshot,
  loadCachedSnapshot,
  saveCachedSnapshot,
} from "./localStore.js";
import { transactionQueue } from "./transactionQueue.js";
import { currentPeriodKey, shiftPeriodKey } from "../domain/period.js";

/** Guest — state before the user logged in. */
const ANONYMOUS_VIEWER = { name: "", color: "#8b95a8" };

const EXPENSE = "expense";

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

/**
 * @param {object} expense
 * @returns {string} month key of the operation, "2026-10"
 *
 */
function periodKeyOf(expense) {
  return String(expense?.occurredOn ?? "").slice(0, 7);
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
 * @param {{ expenses: Array<object>, loadedPeriods: Array<string> }} snapshot
 * @param {string} activePeriodKey — it is not discarded even if it's the oldest
 * @returns {{ expenses: Array<object>, loadedPeriods: Array<string> }}
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
    expenses: (snapshot.expenses ?? []).filter((expense) =>
      keptPeriods.includes(String(expense.occurredOn ?? "").slice(0, 7)),
    ),
  });
}

/**
 * Fields of an expense that the server accepts; `id`, `user` and
 * `recordedAt` are not among them — the server owns those.
 *
 * @param {object} expense
 * @returns {{ occurredOn: string, category: string, amount: number, note: string }}
 */
function pickExpenseFields(expense) {
  return {
    occurredOn: expense.occurredOn,
    category: expense.category,
    amount: expense.amount,
    note: expense.note ?? "",
  };
}

/**
 * Applies queued expense operations to the server list.
 *
 * Queued records are marked `pending`: the list shows them as waiting,
 * and the entry form recognises its just-saved record by this flag.
 *
 * @param {Array<object>} serverExpenses
 * @param {Array<object>} queuedTransactions — the whole queue, in order
 * @param {string} viewerName — author of records the server has not seen yet
 * @returns {Array<object>}
 */
function foldPendingExpenses(serverExpenses, queuedTransactions, viewerName) {
  let expenses = serverExpenses;

  for (const { operation, recordedAt } of queuedTransactions) {
    if (operation?.type !== EXPENSE) continue;
    const { action, targetId, data = {} } = operation;

    if (action === "add") {
      if (!expenses.some((expense) => expense.id === targetId)) {
        expenses = [...expenses, { ...data, id: targetId, user: viewerName, recordedAt, pending: true }];
      }
    } else if (action === "update") {
      expenses = expenses.map((expense) =>
        expense.id === targetId ? { ...expense, ...data, pending: true } : expense,
      );
    } else if (action === "delete") {
      expenses = expenses.filter((expense) => expense.id !== targetId);
    }
  }

  return expenses;
}

/** Not-mutable initial state — we return to it on error. */
function createInitialState() {
  return {
    /** @type {{ name: string, color: string }} who logged in */
    viewer: ANONYMOUS_VIEWER,
    /** @type {Array<object>} */
    categories: [],
    /** @type {Array<object>} server expenses with queued operations applied */
    expenses: [],
    /**
     * @type {Array<string>} months, whose data is already in memory
     *
     * We don't keep the whole history, but only the open months: it's two
     * dozen kilobytes instead of two megabytes.
     */
    loadedPeriods: [],
    /** @type {string} ISO-time of the last snapshot received */
    lastSyncedAt: null,
    /** @type {boolean} a snapshot request is in progress */
    isLoading: false,
    /** @type {Error | null} why the last snapshot request failed; null after a successful one */
    loadError: null,
  };
}

class BudgetStore {
  #state = createInitialState();
  /** @type {Array<object>} expenses exactly as the server returned them */
  #serverExpenses = [];
  #listeners = new Set();
  #sessionToken = null;
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
  /** @type {number} snapshot requests in progress: a month switch may overlap a reload */
  #activeLoads = 0;

  constructor() {
    transactionQueue.subscribe(() => this.#refreshView());

    // Every response to the queue carries a snapshot of the months we asked
    // for: applying it saves a second request of about 3 seconds.
    transactionQueue.setRequestContext(() => ({
      periods: this.#requestedPeriods(),
      limitPeriod: this.#limitPeriod(),
    }));
    transactionQueue.onResponse((response, context) => {
      this.#applySnapshot(response.snapshot, context.limitPeriod);
    });
  }

  /**
   * @param {{ token: string, login: string } | null} session
   * @returns {void}
   */
  setSession(session) {
    this.#sessionToken = session?.token ?? null;
    // The queue belongs to the login: another login sees other pending records.
    this.#refreshView();
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
   * Rebuilds what the UI sees from the server list and the queue.
   * Called on every change of either.
   */
  #refreshView() {
    this.#patch({
      expenses: foldPendingExpenses(this.#serverExpenses, transactionQueue.getPending(), this.#state.viewer.name),
    });
  }

  /**
   * Hydration from cache — so that the page is not empty
   * while the request to Google is going.
   *
   * @returns {void}
   */
  hydrateFromCache() {
    const cachedSnapshot = loadCachedSnapshot();
    if (!cachedSnapshot) return;

    this.#serverExpenses = cachedSnapshot.expenses ?? [];
    this.#patch({
      viewer: cachedSnapshot.viewer ?? ANONYMOUS_VIEWER,
      categories: cachedSnapshot.categories ?? [],
      loadedPeriods: cachedSnapshot.loadedPeriods ?? [],
      lastSyncedAt: cachedSnapshot.lastSyncedAt,
    });
    this.#refreshView();
  }

  /**
   * Reloads all months in memory plus the open one.
   *
   * @returns {Promise<void>}
   * @throws {ApiError} after recording it in `loadError`: the dispatcher
   *   decides what a failure means (login again, offline, toast)
   */
  async reload() {
    const limitPeriod = this.#limitPeriod();
    const snapshot = await this.#trackLoad(
      fetchBudgetSnapshot(this.#sessionToken, this.#requestedPeriods(), limitPeriod),
    );
    this.#applySnapshot(snapshot, limitPeriod);
  }

  /**
   * Keeps `isLoading` and `loadError` in step with a snapshot request.
   *
   * @param {Promise<object>} request
   * @returns {Promise<object>} the snapshot
   * @throws the request's error, after recording it
   */
  async #trackLoad(request) {
    this.#activeLoads += 1;
    this.#patch({ isLoading: true });

    try {
      return await request;
    } catch (error) {
      this.#patch({ loadError: error });
      throw error;
    } finally {
      this.#activeLoads -= 1;
      this.#patch({ isLoading: this.#activeLoads > 0 });
    }
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
   * @returns {void}
   */
  setActivePeriod(periodKey) {
    this.#activePeriodKey = periodKey;
  }

  /**
   * Whether there is data for this month.
   * @param {string} periodKey — "2026-10"
   * @returns {boolean}
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

    try {
      const snapshot = await this.#trackLoad(fetchBudgetSnapshot(this.#sessionToken, neededPeriods, periodKey));
      this.#applySnapshot(snapshot, periodKey);
    } catch {
      // Recorded in loadError by #trackLoad; switching months is not worth a toast.
    } finally {
      neededPeriods.forEach((needed) => this.#loadingPeriods.delete(needed));
    }
  }

  /**
   * Applies a snapshot — from a plain load or from a queue response.
   *
   * The snapshot covers only the months that were entered in it,
   * so expenses from other months remain: added a record in April,
   * and the open month is March, so it doesn't disappear even if it
   * was kicked out from memory.
   *
   * @param {object | undefined} snapshot
   * @param {string} limitPeriod — month whose limits came in the snapshot
   * @returns {boolean} whether anything was applied
   */
  #applySnapshot(snapshot, limitPeriod) {
    if (!snapshot) return false;

    // The server names the months it read: a month without expenses
    // would otherwise be indistinguishable from one not loaded.
    const coveredPeriods = snapshot.periods ?? [];
    if (coveredPeriods.length === 0) return false;

    const categories = snapshot.categories ?? [];
    this.#categoriesByLimitPeriod.set(limitPeriod, categories);

    const keptExpenses = this.#serverExpenses.filter(
      (expense) => !coveredPeriods.includes(periodKeyOf(expense)),
    );

    const loadedPeriods = trimToLimit(
      [...new Set([...this.#state.loadedPeriods, ...coveredPeriods])],
      [this.#activePeriodKey, ...coveredPeriods].filter((periodKey) => Boolean(periodKey)),
      MAX_LOADED_PERIODS,
    );

    // Months that fell out of memory are removed with them:
    // otherwise they would stay in the cache for no reason, and the
    // "loaded" flag would lie.
    this.#serverExpenses = [...keptExpenses, ...(snapshot.expenses ?? [])].filter(
      (expense) => loadedPeriods.includes(periodKeyOf(expense)),
    );

    this.#patch({
      viewer: snapshot.viewer ?? ANONYMOUS_VIEWER,
      categories,
      loadedPeriods,
      lastSyncedAt: new Date().toISOString(),
      loadError: null,
    });
    this.#refreshView();

    // Only the server list is cached: queued records live in the queue
    // and are folded in again after a reload.
    saveCachedSnapshot(trimSnapshotToRecentMonths({
      viewer: this.#state.viewer,
      categories,
      expenses: this.#serverExpenses,
      loadedPeriods,
      lastSyncedAt: this.#state.lastSyncedAt,
    }, this.#activePeriodKey));
    return true;
  }

  /**
   * Adds an expense: first show it in UI, then send it.
   *
   * The `user` field is deliberately missing — the server sets it
   * from the session token, so it's impossible to forge the author.
   *
   * @param {object} expense — with a client `id`; it becomes the row ID
   * @returns {Promise<{ deliveredImmediately: boolean, rejected: boolean, error: Error | null }>}
   */
  addExpense(expense) {
    const queued = transactionQueue.enqueue({
      type: EXPENSE,
      action: "add",
      targetId: expense.id,
      data: pickExpenseFields(expense),
    });
    return this.#deliver(queued.id);
  }

  /**
   * @param {object} expense
   * @returns {Promise<{ deliveredImmediately: boolean, rejected: boolean, error: Error | null }>}
   */
  async removeExpense(expense) {
    // Never sent — nothing to delete on the server, only in the queue.
    if (transactionQueue.findUnsentAdd(EXPENSE, expense.id)) {
      transactionQueue.rewrite((queued) =>
        queued.operation?.type === EXPENSE && queued.operation.targetId === expense.id ? null : queued,
      );
      return { deliveredImmediately: true, rejected: false, error: null };
    }

    const queued = transactionQueue.enqueue({ type: EXPENSE, action: "delete", targetId: expense.id });
    return this.#deliver(queued.id);
  }

  /**
   * Updates an existing record.
   *
   * A record whose add is still queued and not sent is edited in the
   * queue: the server would otherwise get an `update` for a row that
   * doesn't exist yet. Otherwise an `update` with the full new values
   * is queued; if the server rejects it, the view falls back to the
   * server values by itself, because the queued operation is gone.
   *
   * @param {string} expenseId
   * @param {object} changes — sum, category, date, note
   * @returns {Promise<{ deliveredImmediately: boolean, rejected: boolean, error: Error | null }>}
   */
  updateExpense(expenseId, changes) {
    const previous = this.#state.expenses.find((candidate) => candidate.id === expenseId);

    if (!previous) {
      return Promise.resolve({
        deliveredImmediately: false,
        rejected: false,
        error: new Error("Витрату вже не видно у списку"),
      });
    }

    const data = pickExpenseFields({ ...previous, ...changes });
    const queuedAdd = transactionQueue.findUnsentAdd(EXPENSE, expenseId);

    if (queuedAdd) {
      transactionQueue.rewrite((queued) =>
        queued.id === queuedAdd.id ? { ...queued, operation: { ...queued.operation, data } } : queued,
      );
      return this.#deliver(queuedAdd.id);
    }

    const queued = transactionQueue.enqueue({ type: EXPENSE, action: "update", targetId: expenseId, data });
    return this.#deliver(queued.id);
  }

  /**
   * Flushes the queue and reports the fate of one transaction.
   *
   * `rejected` lets the caller skip its own toast: the dispatcher already
   * shows every refusal from the queue.
   *
   * @param {string} queuedId
   * @returns {Promise<{ deliveredImmediately: boolean, rejected: boolean, error: Error | null }>}
   */
  async #deliver(queuedId) {
    try {
      const { rejected } = await transactionQueue.flush();

      const ownRejection = rejected.find((rejection) => rejection.transaction.id === queuedId);
      if (ownRejection) {
        return { deliveredImmediately: false, rejected: true, error: new Error(ownRejection.message) };
      }

      const isStillQueued = transactionQueue.getPending().some((queued) => queued.id === queuedId);
      return { deliveredImmediately: !isStillQueued, rejected: false, error: null };
    } catch (error) {
      return { deliveredImmediately: false, rejected: false, error };
    }
  }

  /**
   * Resets the state on logout ("forget password").
   *
   * The queue is NOT cleared: it belongs to the person, not the session,
   * and should arrive when they log in again. The snapshot cache is
   * cleared — it's the previous user's data, and the next user
   * shouldn't see it.
   *
   * @returns {void}
   */
  reset() {
    clearCachedSnapshot();
    this.#serverExpenses = [];
    this.#state = createInitialState();
    this.#refreshView();
  }
}

export const budgetStore = new BudgetStore();
