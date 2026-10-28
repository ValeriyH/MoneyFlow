/**
 * goalStore.js — goals and their change history on the client.
 *
 * Holds goals as the server last returned them and shows queued goal
 * changes on top of them, marked as pending. Changes are not sent from
 * here: they go to transactionQueue, which delivers them along with any
 * other transactions.
 *
 * Progress and the monthly requirement stay as the server calculated them:
 * a pending change appears in the history right away, the numbers follow
 * after it is applied — so they are the same on every device.
 *
 *
 */

import { fetchGoals } from "./apiClient.js";
import { clearCachedGoals, loadCachedGoals, saveCachedGoals } from "./localStore.js";
import { transactionQueue } from "./transactionQueue.js";
import { toLocalIso } from "../domain/period.js";

const GOAL_CHANGE = "goalChange";

/**
 * @param {object} transaction
 * @returns {boolean}
 */
function isGoalChange(transaction) {
  return transaction?.operation?.type === GOAL_CHANGE;
}

/**
 * Applies queued goal changes to one goal's server history.
 *
 * @param {object} goal
 * @param {Array<object>} pendingTransactions — goal changes in queue order
 * @returns {Array<object>} history with pending rows, newest first
 */
function foldPendingChanges(goal, pendingTransactions) {
  let history = [...(goal.history ?? [])];

  for (const { operation } of pendingTransactions) {
    const { action, targetId, data = {} } = operation;

    if (action === "add" && data.goalId === goal.id && !history.some((change) => change.id === targetId)) {
      history = [{ id: targetId, amount: data.amount, occurredOn: data.occurredOn, user: "", pending: true }, ...history];
    } else if (action === "update") {
      history = history.map((change) =>
        change.id === targetId ? { ...change, amount: data.amount, pending: true } : change,
      );
    } else if (action === "delete") {
      history = history.filter((change) => change.id !== targetId);
    }
  }

  return history;
}

class GoalStore {
  /** @type {Array<object>} goals as the server last returned them */
  #goals = [];
  /** @type {string | null} */
  #sessionToken = null;
  #listeners = new Set();

  constructor() {
    transactionQueue.subscribe(() => this.#notify());

    // Every queue response carries fresh goals: no second request needed.
    transactionQueue.onResponse((response) => {
      if (Array.isArray(response.goals)) this.#setGoals(response.goals);
    });
  }

  /**
   * @param {{ token: string } | null} session
   * @returns {void}
   */
  setSession(session) {
    this.#sessionToken = session?.token ?? null;
  }

  /** @returns {void} */
  hydrateFromCache() {
    this.#goals = loadCachedGoals();
    this.#notify();
  }

  /**
   * @param {() => void} listener
   * @returns {() => void} unsubscribe function
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * @returns {Array<object>} goals with pending changes folded into history;
   *   `hasPendingChanges` marks goals whose numbers are not final yet
   */
  getGoals() {
    const pendingTransactions = transactionQueue.getPending().filter(isGoalChange);
    if (pendingTransactions.length === 0) return this.#goals;

    return this.#goals.map((goal) => {
      const history = foldPendingChanges(goal, pendingTransactions);
      return { ...goal, history, hasPendingChanges: history.some((change) => change.pending) };
    });
  }

  /**
   * Sends queued transactions; if there were none, reloads goals instead —
   * either way the goals end up fresh. Refusals are reported by the queue.
   *
   * @returns {Promise<void>}
   * @throws {ApiError} on network or session failure
   */
  async synchronize() {
    const outcome = await transactionQueue.flush();
    if (!outcome.delivered) await this.#reload();
  }

  /**
   * @param {string} goalId
   * @param {number} amount — positive adds, negative withdraws
   * @returns {Promise<{ delivered: boolean, error: Error | null }>}
   */
  addChange(goalId, amount) {
    transactionQueue.enqueue({
      type: GOAL_CHANGE,
      action: "add",
      targetId: crypto.randomUUID(),
      data: { goalId, amount, occurredOn: toLocalIso().slice(0, 10) },
    });
    return this.#deliver();
  }

  /**
   * @param {string} changeId
   * @param {number} amount
   * @returns {Promise<{ delivered: boolean, error: Error | null }>}
   */
  updateChange(changeId, amount) {
    const queuedAdd = transactionQueue.findUnsentAdd(GOAL_CHANGE, changeId);
    if (queuedAdd) {
      transactionQueue.rewrite((transaction) =>
        transaction.id === queuedAdd.id
          ? { ...transaction, operation: { ...transaction.operation, data: { ...transaction.operation.data, amount } } }
          : transaction,
      );
    } else {
      transactionQueue.enqueue({ type: GOAL_CHANGE, action: "update", targetId: changeId, data: { amount } });
    }
    return this.#deliver();
  }

  /**
   * @param {string} changeId
   * @returns {Promise<{ delivered: boolean, error: Error | null }>}
   */
  deleteChange(changeId) {
    // Never sent — nothing to delete on the server, only in the queue.
    if (transactionQueue.findUnsentAdd(GOAL_CHANGE, changeId)) {
      transactionQueue.rewrite((transaction) =>
        isGoalChange(transaction) && transaction.operation.targetId === changeId ? null : transaction,
      );
    } else {
      transactionQueue.enqueue({ type: GOAL_CHANGE, action: "delete", targetId: changeId });
    }
    return this.#deliver();
  }

  /** @returns {void} */
  reset() {
    clearCachedGoals();
    this.#goals = [];
    this.#notify();
  }

  /** @returns {Promise<{ delivered: boolean, error: Error | null }>} */
  async #deliver() {
    try {
      await transactionQueue.flush();
      return { delivered: transactionQueue.getPending().length === 0, error: null };
    } catch (error) {
      return { delivered: false, error };
    }
  }

  async #reload() {
    if (!this.#sessionToken) return;
    const response = await fetchGoals(this.#sessionToken);
    this.#setGoals(response.goals ?? []);
  }

  /** @param {Array<object>} goals */
  #setGoals(goals) {
    this.#goals = goals;
    saveCachedGoals(goals);
    this.#notify();
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }
}

export const goalStore = new GoalStore();
