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
  AUTH_FAILURE_CODES,
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
import { currentPeriodKey, shiftPeriodKey } from "../domain/period.js";

/** Гість — стан до того, як користувач увійшов. */
const ANONYMOUS_VIEWER = { name: "", color: "#8b95a8" };

/**
 * Помилки, з яких є сенс повторювати запит. Решта — відмова сервера
 * «назавжди»: категорія не існує, сесія прострочена. Такі
 * записи треба викидати, інакше вони вічно блокуватимуть решту черги.
 */
const RETRYABLE_ERROR_CODES = [
  API_ERROR_CODE.network,
  API_ERROR_CODE.timeout,
  API_ERROR_CODE.serverError,
  API_ERROR_CODE.rateLimited,
];

/**
 * Скільки місяців тримаємо в пам'яті одночасно.
 *
 * Це запобіжник, а не план: зазвичай у пам'яті один-два місяці.
 * Рости починається лише тоді, коли хтось перемикається назад по
 * роках. Без межі список місяців перевищив би ліміт сервера, і
 * тоді перестав би працювати сам додаток — будь-який запис
 * падав би з помилкою.
 */
const MAX_LOADED_PERIODS = 12;

/** @param {unknown} error */
function isWorthRetrying(error) {
  return error instanceof ApiError && RETRYABLE_ERROR_CODES.includes(error.code);
}


/**
 * Термін сесії вичерпано: токен підписаний правильно, усі дані
 * в ньому чесні, просто пройшов час.
 *
 * Це єдина відмова, після якої достатньо увійти знову: записи
 * лишаються в черзі й доходять після того, як ви знову ввійдете.
 * Решта відмов (акаунт вимкнено, пароль змінено, токен підроблено)
 * сюди не потрапляють: повторний вхід їх не виправить, і запис
 * блокував би решту черги вічно.
 *
 * @param {unknown} error
 */
function isSessionExpired(error) {
  return error instanceof ApiError && error.code === API_ERROR_CODE.sessionExpired;
}

/**
 * @param {object} transaction
 * @returns {string} ключ місяця операції, «2026-10»
 */
function periodKeyOf(transaction) {
  return String(transaction?.occurredOn ?? "").slice(0, 7);
}

/**
 * Які саме місяці прийшли в знімку.
 *
 * Новий сервер називає їх сам — це точніше за будь-який вивід із
 * дат, бо місяць без операцій інакше виглядав би як «не завантажено».
 * Старший сервер цього поля не має, тоді беремо місяці з дат.
 *
 * @param {object} snapshot
 * @returns {Array<string>}
 */
function readCoveredPeriods(snapshot) {
  if (Array.isArray(snapshot.periods) && snapshot.periods.length > 0) return snapshot.periods;
  return [...new Set((snapshot.transactions ?? []).map(periodKeyOf))];
}

/**
 * Лишаємо не більше ніж `limit` місяців.
 *
 * Обов'язково втримуємо `mustKeep` — інакше панелі могли б назавжди
 * залишитися на «Завантаження місяця…»: запит приніс би потрібний
 * місяць і тут же викинув його за межу, бо в пам'яті вже дванадцять
 * новіших. Решту добираємо найновішими — на них дивляться чаще.
 *
 * Забутий місяць не втрачається назавжди: коли його відкриють
 * знову, звичайний запит принесе його за три секунди.
 *
 * @param {Array<string>} periodKeys
 * @param {Array<string>} mustKeep
 * @param {number} limit
 * @returns {Array<string>}
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
/** Незмінний початковий стан — до нього повертаємось при помилці. */
function createInitialState() {
  return {
    /** @type {{ name: string, color: string }} хто увійшов */
    viewer: ANONYMOUS_VIEWER,
    /** @type {Array<object>} */
    categories: FALLBACK_CATEGORIES,
    /** @type {Array<object>} */
    transactions: [],
    /**
     * @type {Array<string>} місяці «РРРР-ММ», дані яких уже в пам'яті
     *
     * Тримаємо не всю історію, а лише відкриті місяці: на п'ятирічній
     * історії це два десятки кілобайт замість двох мегабайтів.
     */
    loadedPeriods: [],
    /** @type {Array<object>} дії, які ще не дійшли до сервера */
    pendingEntries: loadPendingEntries(null),
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
  #sessionToken = null;
  /** @type {string | null} логін поточної сесії: черга належить йому */
  #sessionLogin = null;
  /** @type {Promise<void> | null} відправка, яка вже триває */
  #flushPromise = null;
  /** @type {Set<string>} місяці, які зараз завантажуються */
  #loadingPeriods = new Set();
  /** @type {string | null} місяць, який користувач дивиться зараз */
  #activePeriodKey = null;
  /**
   * Токен завжди йде з логіном: вони визначають, чию чергу
   * ми читаємо і чиї записи відправляємо.
   *
   * @param {{ token: string, login: string } | null} session
   */
  setSession(session) {
    this.#sessionToken = session?.token ?? null;
    this.#sessionLogin = session?.login ?? null;

    // Черга змінюється разом із входом, тому перечитуємо її з
    // пам'яті: щоб на екрані було видно саме свої записи.
    this.#patch({ pendingEntries: loadPendingEntries(this.#sessionLogin) });
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
      loadedPeriods: Array.isArray(cachedSnapshot.loadedPeriods)
        ? cachedSnapshot.loadedPeriods
        : readCoveredPeriods(cachedSnapshot),
      lastSyncedAt: cachedSnapshot.lastSyncedAt,
      pendingEntries: loadPendingEntries(this.#sessionLogin),
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
      const [nextQueuedEntry] = loadPendingEntries(this.#sessionLogin);
      if (!nextQueuedEntry) return;

      this.#patch({
        syncState: SYNC_STATE.pending,
        pendingEntries: loadPendingEntries(this.#sessionLogin),
      });

      try {
        const periods = this.#requestedPeriods();
        const response =
          nextQueuedEntry.action === "delete"
            ? await deleteTransaction(this.#sessionToken, nextQueuedEntry.transactionId, periods)
            : await submitTransaction(this.#sessionToken, nextQueuedEntry.transaction, periods);

        this.#applySnapshot(response.snapshot);
        this.#removeFromQueue(nextQueuedEntry.id);
      } catch (error) {
        // Прострочена сесія - не відмова. Запис лишається в
        // черзі й дійде одразу після повторного входу.
        if (isSessionExpired(error)) throw error;

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
    this.#applySnapshot(await fetchBudgetSnapshot(this.#sessionToken, this.#requestedPeriods()));
  }

  /**
   * Місяці, які хочемо отримати від сервера: ті, що вже в пам'яті.
   *
   * Запит лише цих місяців — інакше серверний знімок витер би те,
   * що ми вже завантажили. Коли пам'ять порожня (перший вхід у
   * цій сесії), беремо поточний місяць.
   *
   * Обраний місяць додається окремо: він мусить бути на екрані, на
   *вітьмуть тощо — навіть якщо його витіснив з пам'яті власний запит.
   *
   * @returns {Array<string>}
   */
  #requestedPeriods() {
    const loadedPeriods = this.#state.loadedPeriods;
    if (loadedPeriods.length === 0) return [currentPeriodKey()];

    if (!this.#activePeriodKey || loadedPeriods.includes(this.#activePeriodKey)) {
      return loadedPeriods;
    }

    return trimToLimit(
      [...loadedPeriods, this.#activePeriodKey],
      [this.#activePeriodKey],
      MAX_LOADED_PERIODS,
    );
  }

  /**
   * Запам'ятовує, який місяць користувач дивиться.
   *
   * Це единий спосіб, яким сторінка впливає на те, які місяці
   * переживають обмеження пам'яті: відкритий місяць не можна
   * викинути, бо інакше панелі назавжди залишаться порожніми.
   *
   * @param {string} periodKey — «2026-10»
   */
  setActivePeriod(periodKey) {
    this.#activePeriodKey = periodKey;
  }

  /**
   * Чи вже є дані за цей місяць.
   * @param {string} periodKey — «2026-10»
   */
  isPeriodLoaded(periodKey) {
    return this.#state.loadedPeriods.includes(periodKey);
  }

  /**
   * Догружає місяць, якого ще немає в пам'яті.
   *
   * Береться місяць і попередній: попередній потрібен для
   * «динаміки до попереднього місяця». Уже завантажений місяць
   * повторно не запитується — за цю сесію він вже в пам'яті.
   *
   * @param {string} periodKey — «2026-10»
   * @returns {Promise<void>}
   */
  async loadPeriod(periodKey) {
    if (this.isPeriodLoaded(periodKey)) return;
    if (!this.#sessionToken) return;

    // Подвійний клік по «назад» не має породжувати два запити:
    // другий місяць часто вже їде у відповіді на перший.
    if (this.#loadingPeriods.has(periodKey)) return;
    this.#loadingPeriods.add(periodKey);

    this.#patch({ syncState: SYNC_STATE.loading });

    try {
      const snapshot = await fetchBudgetSnapshot(this.#sessionToken, [
        periodKey,
        shiftPeriodKey(periodKey, -1),
      ]);
      this.#applySnapshot(snapshot);
      this.#patchSyncStateFromQueue();
    } catch (error) {
      this.#handleSyncError(error);
    } finally {
      this.#loadingPeriods.delete(periodKey);
    }
  }

  /**
   * Застосовує знімок, надісланий разом із відповіддю на дію —
   * так минає другий запит і близько 3 секунди.
   *
   * Знімок покриває тільки записані в ньому місяці, тому операції
   * за інші місяці залишаються на місці: додали запис у квітні, а
   * відкритий березень не зникає.
   *
   * Якщо сервер знімка не повернув (наприклад, задеплоєна старіша
   * версія скрипта) — перечитуємо окремим запитом, щоб не ламалася.
   *
   * @param {object | undefined} snapshot
   */
  #applySnapshot(snapshot) {
    if (!snapshot) return false;

    const coveredPeriods = readCoveredPeriods(snapshot);
    if (coveredPeriods.length === 0) return false;

    const snapshotTransactions = snapshot.transactions ?? [];
    const knownIds = new Set(snapshotTransactions.map((transaction) => transaction.id));

    // Решта місяців лишається як є. Несинхронізовані записи
    // переживають навіть тоді, коли їхній місяць прийшов у знімку:
    // сервер про них ще не знає, тож замінити їх нічим не можна.
    const keptTransactions = this.#state.transactions.filter((transaction) => {
      if (!coveredPeriods.includes(periodKeyOf(transaction))) return true;
      return transaction.pending === true && !knownIds.has(transaction.id);
    });

    const loadedPeriods = trimToLimit(
      [...new Set([...this.#state.loadedPeriods, ...coveredPeriods])],
      [this.#activePeriodKey, ...coveredPeriods].filter((periodKey) => Boolean(periodKey)),
      MAX_LOADED_PERIODS,
    );

    // Дані місяців, що випали з пам'яті, прибираємо разом із ними:
    // інакше вони лишилися б лежати в кеші без причини, а прапор
    // «завантажений» брехав би.
    const transactions = [...keptTransactions, ...snapshotTransactions].filter(
      (transaction) =>
        transaction.pending === true || loadedPeriods.includes(periodKeyOf(transaction)),
    );

    const nextState = {
      viewer: snapshot.viewer ?? ANONYMOUS_VIEWER,
      categories: snapshot.categories?.length ? snapshot.categories : FALLBACK_CATEGORIES,
      transactions,
      loadedPeriods,
      lastSyncedAt: new Date().toISOString(),
    };

    saveCachedSnapshot(nextState);
    this.#patch(nextState);
    return true;
  }

  /**
   * Розкладає помилку на стан індикатора.
   * Код зберігається окремо від тексту — щоб main.js міг прийняти
   * рішення про повторний запит пароля, не парсячи рядки.
   *
   * @param {unknown} error
   */
  #handleSyncError(error) {
    const errorCode = error instanceof ApiError ? error.code : null;
    const errorMessage = error instanceof Error ? error.message : "Невідома помилка синхронізації";

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
   * Додає операцію: сперку показує її в UI, потім відправляє.
   * Поле `user` тут відсутнє навмисно — його проставляє сервер
   * із сесійного токена, тож підробити ім'я неможливо.
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
      // Прострочена сесія - не відмова: запис лишається в
      // черзі й дійде після повторного входу.
      if (!isWorthRetrying(error) && !isSessionExpired(error)) {
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
      // Прострочена сесія - не відмова: видалення лишається
      // в черзі й дійде після повторного входу.
      if (!isWorthRetrying(error) && !isSessionExpired(error)) {
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

    const updatedEntries = [...loadPendingEntries(this.#sessionLogin), queuedEntry];
    savePendingEntries(this.#sessionLogin, updatedEntries);

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
    const remainingEntries = loadPendingEntries(this.#sessionLogin).filter((entry) => entry.id !== queuedEntryId);
    savePendingEntries(this.#sessionLogin, remainingEntries);
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
    const remainingEntries = loadPendingEntries(this.#sessionLogin).filter((entry) => entry.id !== queuedEntryId);
    savePendingEntries(this.#sessionLogin, remainingEntries);

    this.#patch({
      pendingEntries: remainingEntries,
      transactions: transactionId
        ? this.#state.transactions.filter((candidate) => candidate.id !== transactionId)
        : this.#state.transactions,
    });
  }

  /**
   * Скидає стан на виході («забути пароль»).
   *
   * Чергу НЕ чистить: вона належить людині, а не сесії, і має
   * дійти, коли вона знову увійде. Кеш знімка чистимо — це дані
   * попереднього користувача, і наступному показувати їх не треба.
   */
  reset() {
    clearCachedSnapshot();
    this.#state = createInitialState();
    this.#state = { ...this.#state, pendingEntries: loadPendingEntries(this.#sessionLogin) };
    for (const listener of this.#listeners) listener(this.#state);
  }
}

export const budgetStore = new BudgetStore();
