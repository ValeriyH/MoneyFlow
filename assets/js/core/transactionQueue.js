/**
 * transactionQueue.js — one delivery path for user actions.
 *
 * A transaction is one action the user asked for: `{ id, recordedAt, operation }`.
 * The queue does not know what operations mean: it keeps them per login in
 * localStorage, sends all of them in one request and reports what the server
 * decided. Stores fold still-queued transactions into what they show.
 *
 * Operation types today: `expense` (budgetStore) and `goalChange` (goalStore).
 *
 *
 */

import {
  ApiError,
  API_ERROR_CODE,
  submitTransactions,
} from "./apiClient.js";
import { loadQueuedTransactions, saveQueuedTransactions } from "./localStore.js";

/** Must not exceed MAX_TRANSACTIONS_PER_REQUEST on the server. */
const MAX_TRANSACTIONS_PER_REQUEST = 50;

/** Failures where the same request may succeed later: the queue is kept. */
const RETRYABLE_ERROR_CODES = [
  API_ERROR_CODE.network,
  API_ERROR_CODE.timeout,
  API_ERROR_CODE.serverError,
  API_ERROR_CODE.rateLimited,
];

/**
 * @param {unknown} error
 * @returns {boolean} whether the queue must be kept for a later attempt
 */
function isTemporaryFailure(error) {
  if (!(error instanceof ApiError)) return true;
  return RETRYABLE_ERROR_CODES.includes(error.code) || error.code === API_ERROR_CODE.sessionExpired;
}

class TransactionQueue {
  /** @type {string | null} */
  #sessionToken = null;
  /** @type {string | null} login of the current session: the queue belongs to it */
  #sessionLogin = null;
  /** @type {Promise<object> | null} submission that is already in progress */
  #flushPromise = null;
  /** @type {Set<string>} IDs of transactions sent and not yet answered */
  #inFlightIds = new Set();
  #listeners = new Set();
  #responseListeners = new Set();
  #rejectionListeners = new Set();
  /** @type {() => { periods: Array<string>, limitPeriod: string }} */
  #requestContext = () => ({ periods: [], limitPeriod: "" });
  /** @type {boolean} a submission is in progress */
  #isSending = false;
  /** @type {Error | null} why the last submission failed; null after a successful one */
  #lastError = null;

  /**
   * Delivery state for the sync indicator. The queue alone knows it:
   * any store may have queued the transactions and any caller may flush.
   *
   * @returns {{ pendingCount: number, isSending: boolean, lastError: Error | null }}
   */
  getStatus() {
    return {
      pendingCount: this.getPending().length,
      isSending: this.#isSending,
      lastError: this.#lastError,
    };
  }

  /**
   * Which months the response snapshot should cover. The queue does not
   * know about months; budgetStore does, and registers itself here.
   *
   * @param {() => { periods: Array<string>, limitPeriod: string }} provider
   * @returns {void}
   */
  setRequestContext(provider) {
    this.#requestContext = provider;
  }

  /**
   * @param {{ token: string, login: string } | null} session
   * @returns {void}
   */
  setSession(session) {
    this.#sessionToken = session?.token ?? null;
    this.#sessionLogin = session?.login ?? null;
    // The failure belonged to the previous session's queue.
    this.#lastError = null;
    this.#notify();
  }

  /** @returns {Array<object>} transactions not yet accepted by the server, in order */
  getPending() {
    return loadQueuedTransactions(this.#sessionLogin);
  }

  /**
   * A sent transaction must not be rewritten: the server may already
   * have applied it, and the rewrite would be silently lost.
   *
   * @param {string} transactionId
   * @returns {boolean}
   */
  isInFlight(transactionId) {
    return this.#inFlightIds.has(transactionId);
  }

  /**
   * @param {() => void} listener — called when the queue or its status changes
   * @returns {() => void} unsubscribe function
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * @param {(response: object, context: { periods: Array<string>, limitPeriod: string }) => void} listener —
   *   receives every successful server response and the context it was requested with
   * @returns {() => void} unsubscribe function
   */
  onResponse(listener) {
    this.#responseListeners.add(listener);
    return () => this.#responseListeners.delete(listener);
  }

  /**
   * One place to tell the user about refused transactions, whichever
   * store queued them and whoever triggered the flush.
   *
   * @param {(rejection: { transaction: object, message: string }) => void} listener
   * @returns {() => void} unsubscribe function
   */
  onRejected(listener) {
    this.#rejectionListeners.add(listener);
    return () => this.#rejectionListeners.delete(listener);
  }

  /**
   * The queued add of a record, if it may still be rewritten: not sent,
   * and nothing after it targets the same record. Editing or deleting such
   * a record must change the queue, not send an operation for a row the
   * server has not created yet.
   *
   * @param {string} type — operation type
   * @param {string} targetId
   * @returns {object | null}
   */
  findUnsentAdd(type, targetId) {
    const sameTarget = this.getPending().filter(
      (transaction) => transaction.operation?.type === type && transaction.operation.targetId === targetId,
    );
    const [first] = sameTarget;

    if (!first || first.operation.action !== "add") return null;
    if (sameTarget.length > 1 || this.isInFlight(first.id)) return null;
    return first;
  }

  /**
   * @param {{ type: string, action: string, targetId: string, data?: object }} operation
   * @returns {object} the queued transaction
   */
  enqueue(operation) {
    const transaction = {
      id: crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
      operation,
    };

    this.#save([...this.getPending(), transaction]);
    return transaction;
  }

  /**
   * Rewrites queued transactions that have not been sent yet.
   *
   * @param {(transaction: object) => object | null} rewriteTransaction —
   *   returns the transaction to keep (changed or not), or null to drop it
   * @returns {void}
   */
  rewrite(rewriteTransaction) {
    const rewritten = this.getPending()
      .map((transaction) => (this.isInFlight(transaction.id) ? transaction : rewriteTransaction(transaction)))
      .filter(Boolean);

    this.#save(rewritten);
  }

  /**
   * Sends everything queued. A second call while sending joins the first:
   * two parallel submissions could send the same transaction twice.
   *
   * @returns {Promise<{ delivered: boolean, rejected: Array<{ transaction: object, message: string }> }>}
   *   delivered — at least one server response arrived;
   *   rejected — transactions the server refused, already removed from the queue
   * @throws {ApiError} on a temporary failure; the queue stays intact
   */
  flush() {
    if (this.#flushPromise) return this.#flushPromise;

    this.#setStatus({ isSending: true });

    this.#flushPromise = this.#sendAll()
      .then((outcome) => {
        this.#setStatus({ isSending: false, lastError: null });
        return outcome;
      }, (error) => {
        this.#setStatus({ isSending: false, lastError: error });
        throw error;
      })
      .finally(() => {
        this.#flushPromise = null;
      });

    return this.#flushPromise;
  }

  /**
   * Loops until the queue is empty, so transactions added while a request
   * was in flight go in the same series instead of waiting for the next one.
   *
   * @returns {Promise<{ delivered: boolean, rejected: Array<{ transaction: object, message: string }> }>}
   */
  async #sendAll() {
    const outcome = { delivered: false, rejected: [] };

    while (this.#sessionToken) {
      const batch = this.getPending().slice(0, MAX_TRANSACTIONS_PER_REQUEST);
      if (batch.length === 0) break;

      const batchIds = new Set(batch.map((transaction) => transaction.id));
      batchIds.forEach((id) => this.#inFlightIds.add(id));

      try {
        const context = this.#requestContext();
        const response = await submitTransactions(this.#sessionToken, batch, context.periods, context.limitPeriod);

        const rejected = [];
        for (const result of response.results ?? []) {
          if (result.status !== "rejected") continue;
          const transaction = batch.find((candidate) => candidate.id === result.id);
          if (transaction) {
            rejected.push({ transaction, message: result.error ?? "Сервер відхилив зміну" });
          }
        }

        outcome.delivered = true;
        this.#removeIds(batchIds);
        for (const listener of this.#responseListeners) listener(response, context);
        this.#reportRejected(rejected, outcome);
      } catch (error) {
        if (isTemporaryFailure(error)) throw error;

        // Account disabled, password changed, token forged: re-login under
        // this token won't happen — e.g. the phone was lost and the owner
        // reset the password. The queue must not wait for whoever finds it.
        if (error.code === API_ERROR_CODE.unauthorized) {
          this.#save([]);
          throw error;
        }

        // The server refused the request as a whole and will refuse it
        // again: keeping the batch would block everything behind it.
        this.#removeIds(batchIds);
        this.#reportRejected(batch.map((transaction) => ({ transaction, message: error.message })), outcome);
      } finally {
        batchIds.forEach((id) => this.#inFlightIds.delete(id));
      }
    }

    return outcome;
  }

  /** @param {{ isSending?: boolean, lastError?: Error | null }} changes */
  #setStatus(changes) {
    if ("isSending" in changes) this.#isSending = changes.isSending;
    if ("lastError" in changes) this.#lastError = changes.lastError;
    this.#notify();
  }

  /**
   * @param {Array<{ transaction: object, message: string }>} rejected
   * @param {{ rejected: Array<object> }} outcome
   */
  #reportRejected(rejected, outcome) {
    for (const rejection of rejected) {
      outcome.rejected.push(rejection);
      for (const listener of this.#rejectionListeners) listener(rejection);
    }
  }

  /** @param {Set<string>} transactionIds */
  #removeIds(transactionIds) {
    this.#save(this.getPending().filter((transaction) => !transactionIds.has(transaction.id)));
  }

  /** @param {Array<object>} transactions */
  #save(transactions) {
    saveQueuedTransactions(this.#sessionLogin, transactions);
    this.#notify();
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }
}

export const transactionQueue = new TransactionQueue();
