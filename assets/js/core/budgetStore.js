/**
 * budgetStore.js — єдине джерело правди на клієнті.
 *
 * Тримає поточний знімок бюджету, чергу несинхронізованих записів
 * і стан синхронізації. UI підписується на зміни й перемальовується.
 * Ніякий UI-модуль не знає, як влаштована мережа чи localStorage.
 *
 * Ключова ідея: будь-яка дія сперша потрапляє в чергу й одразу
 * показується в UI, і лише потім відправляється на сервер. Тому
 * інтерфейс не чекає 3 секунди, а черга гарантує доставку.
 */

import { FALLBACK_CATEGORIES, SYNC_STATE } from "../config.js";
import {
  ApiError,
  API_ERROR_CODE,
  deleteTransaction,
  fetchBudgetSnapshot,
  submitTransaction,
} from "./apiClient.js";
import {
  clearCachedSnapshot,
  loadCachedSnapshot,
  loadPendingEntries,
  saveCachedSnapshot,
  savePendingEntries,
} from "./localStore.js";

/** Гість — стан до того, як користувач ввів код доступу. */
const ANONYMOUS_VIEWER = { name: "", color: "#8b95a8" };

/**
 * Помилки, з яких є сенс повторювати запит. Решта — відмова сервера
 * «назавжди»: категорія не існує, код доступу неправильний. Такі
 * записи треба викидати, інакше вони вічно блокуватимуть решту черги.
 */
const RETRYABLE_ERROR_CODES = [
  API_ERROR_CODE.network,
  API_ERROR_CODE.timeout,
  API_ERROR_CODE.serverError,
  API_ERROR_CODE.rateLimited,
];

/** @param {unknown} error */
function isWorthRetrying(error) {
  return error instanceof ApiError && RETRYABLE_ERROR_CODES.includes(error.code);
}

/** Незмінний початковий стан — до нього повертаємось при помилці. */
function createInitialState() {
  return {
    /** @type {{ name: string, color: string }} хто увійшов */
    viewer: ANONYMOUS_VIEWER,
    /** @type {Array<object>} */
    categories: FALLBACK_CATEGORIES,
    /** @type {Array<object>} */
    transactions: [],
    /** @type {Array<object>} дії, які ще не дійшли до сервера */
    pendingEntries: loadPendingEntries(),
    /** @type {string} ISO-час останньої успішної синхронізації */
    lastSyncedAt: null,
    /** @type {string} значення SYNC_STATE */
    syncState: SYNC_STATE.loading,
    /** @type {string} коротке пояснення для індикатора */
    syncMessage: "",
    /** @type {string | null} машинний код останньої помилки, якщо була */
    syncErrorCode: null,
    /**
     * Сама помилка останньої невдачі — щоб екран входу міг відрізнити
     * «невірний код» від «забагато спроб» і показати потрібне.
     * @type {Error | null}
     */
    lastSyncError: null,
  };
}

class BudgetStore {
  #state = createInitialState();
  #listeners = new Set();
  #accessToken = null;
  /** @type {Promise<void> | null} відправка, яка вже триває */
  #flushPromise = null;

  /** @param {string} accessToken */
  setAccessToken(accessToken) {
    this.#accessToken = accessToken;
  }

  /** @returns {Readonly<object>} */
  getState() {
    return this.#state;
  }

  /**
   * @param {(state: Readonly<object>) => void} listener
   * @returns {() => void} функція відписки
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
   * Гідрація з кешу — щоб сторінка не була порожньою,
   * поки йде запит до Google.
   */
  hydrateFromCache() {
    const cachedSnapshot = loadCachedSnapshot();
    if (!cachedSnapshot) return;

    this.#patch({
      viewer: cachedSnapshot.viewer ?? ANONYMOUS_VIEWER,
      categories: cachedSnapshot.categories?.length ? cachedSnapshot.categories : FALLBACK_CATEGORIES,
      transactions: cachedSnapshot.transactions ?? [],
      lastSyncedAt: cachedSnapshot.lastSyncedAt,
      pendingEntries: loadPendingEntries(),
    });
  }

  /**
   * Основний цикл синхронізації:
   * спершу відправляє чергу, потім перечитує таблицю.
   * @returns {Promise<boolean>} — чи вдалося
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
   * Синхронізовано тоді й лише тоді, коли черга порожня.
   * Винесено окремо, бо стан визначається у кількох місцях.
   */
  #patchSyncStateFromQueue() {
    this.#patch({
      syncState: this.#state.pendingEntries.length > 0 ? SYNC_STATE.pending : SYNC_STATE.synced,
    });
  }

  /**
   * Відправляє чергу по черзі, щоб не порушити порядок.
   *
   * Коли вже йде відправка, другий виклик приєднується до неї, а не
   * починає паралельну: інакше два записи можуть піти двічі.
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
   * Бере по одному запиту з черги й перечитує список щоразу — тоді
   * запис, доданий під час відправки, теж підхопиться в цій самій
   * серії, а не залишиться на потім.
   *
   * @returns {Promise<void>}
   */
  async #sendQueuedEntries() {
    while (true) {
      const [nextQueuedEntry] = loadPendingEntries();
      if (!nextQueuedEntry) return;

      this.#patch({
        syncState: SYNC_STATE.pending,
        pendingEntries: loadPendingEntries(),
      });

      try {
        const response =
          nextQueuedEntry.action === "delete"
            ? await deleteTransaction(this.#accessToken, nextQueuedEntry.transactionId)
            : await submitTransaction(this.#accessToken, nextQueuedEntry.transaction);

        this.#applySnapshot(response.snapshot);
        this.#removeFromQueue(nextQueuedEntry.id);
      } catch (error) {
        if (!isWorthRetrying(error)) {
          this.#discardPendingEntry(nextQueuedEntry.id, nextQueuedEntry.transaction?.id);
          continue;
        }
        throw error;
      }
    }
  }

  /** @returns {Promise<void>} */
  async #reloadSnapshot() {
    this.#applySnapshot(await fetchBudgetSnapshot(this.#accessToken));
  }

  /**
   * Застосовує знімок, надісланий разом із відповіддю на дію —
   * так минає другий запит і близько 3 секунди.
   *
   * Якщо сервер знімка не повернув (наприклад, задеплоєна старіша
   * версія скрипта) — перечитуємо окремим запитом, щоб не ламалася.
   *
   * @param {object | undefined} snapshot
   */
  #applySnapshot(snapshot) {
    if (!snapshot) return false;

    const nextState = {
      viewer: snapshot.viewer ?? ANONYMOUS_VIEWER,
      categories: snapshot.categories?.length ? snapshot.categories : FALLBACK_CATEGORIES,
      transactions: snapshot.transactions ?? [],
      lastSyncedAt: new Date().toISOString(),
    };

    saveCachedSnapshot(nextState);
    this.#patch(nextState);
    return true;
  }

  /**
   * Розкладає помилку на стан індикатора.
   * Код зберігається окремо від тексту — щоб main.js міг прийняти
   * рішення про повторний запит коду доступу, не парсячи рядки.
   *
   * @param {unknown} error
   */
  #handleSyncError(error) {
    const errorCode = error instanceof ApiError ? error.code : null;
    const errorMessage = error instanceof Error ? error.message : "Невідома помилка синхронізації";

    if (errorCode === API_ERROR_CODE.unauthorized) {
      this.#patch({
        syncState: SYNC_STATE.error,
        syncMessage: "Невірний код доступу",
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
   * Додає операцію: сперку показує її в UI, потім відправляє.
   * Поле `user` тут відсутнє навмисно — його проставляє сервер
   * із коду доступу, тож підробити ім'я неможливо.
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
      if (!isWorthRetrying(error)) {
        this.#discardPendingEntry(queuedEntryId, transaction.id);
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
      if (!isWorthRetrying(error)) {
        this.#discardPendingEntry(queuedEntryId);
        this.#patchSyncStateFromQueue();
      }
      return { deliveredImmediately: false, error };
    }
  }

  /**
   * Кладе дію в чергу й одразу показує її в UI.
   *
   * @param {object} pendingAction
   * @returns {string} ідентифікатор запису в черзі
   */
  #enqueuePendingEntry(pendingAction) {
    const queuedEntry = { ...pendingAction, id: crypto.randomUUID() };

    const updatedEntries = [...loadPendingEntries(), queuedEntry];
    savePendingEntries(updatedEntries);

    const syncState = navigator.onLine ? SYNC_STATE.pending : SYNC_STATE.offline;

    if (queuedEntry.action === "add") {
      this.#patch({
        pendingEntries: updatedEntries,
        syncState,
        transactions: [...this.#state.transactions, { ...queuedEntry.transaction, pending: true }],
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

  /** @param {string} queuedEntryId */
  #removeFromQueue(queuedEntryId) {
    const remainingEntries = loadPendingEntries().filter((entry) => entry.id !== queuedEntryId);
    savePendingEntries(remainingEntries);
    this.#patch({ pendingEntries: remainingEntries });
  }

  /**
   * Прибирає дію з черги назавжди — коли сервер відхилив її остаточно.
   * Повторювати такий запит безглуздо: він лише блокував би решту черги.
   *
   * @param {string} queuedEntryId
   * @param {string} [transactionId] — для «add» ще й прибираємо з UI
   */
  #discardPendingEntry(queuedEntryId, transactionId) {
    const remainingEntries = loadPendingEntries().filter((entry) => entry.id !== queuedEntryId);
    savePendingEntries(remainingEntries);

    this.#patch({
      pendingEntries: remainingEntries,
      transactions: transactionId
        ? this.#state.transactions.filter((candidate) => candidate.id !== transactionId)
        : this.#state.transactions,
    });
  }

  /** Повністю скидає стан — використовується при виході («забути код доступу»). */
  reset() {
    savePendingEntries([]);
    clearCachedSnapshot();
    this.#state = createInitialState();
    for (const listener of this.#listeners) listener(this.#state);
  }
}

export const budgetStore = new BudgetStore();