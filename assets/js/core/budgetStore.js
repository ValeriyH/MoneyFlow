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

import { SYNC_STATE } from "../config.js";
import {
  ApiError,
  API_ERROR_CODE,
  AUTH_FAILURE_CODES,
  deleteTransaction,
  fetchBudgetSnapshot,
  submitTransaction,
  updateTransaction,
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
 * Місяць, який дивимось, і попередній до нього.
 *
 * Попередній потрібен не тільки для показника «у порівнянні з
 * минулим», а й для розподілу та лімітів. Тому це не два незалежні
 * запити, а завжди пара: показати місяць без попереднього означає
 * показати половину панелі й мовчки відсутнє порівняння.
 *
 * @param {string} periodKey — «2026-10»
 * @returns {Array<string>} `['2026-10', '2026-09']`
 */
function withPreviousPeriod(periodKey) {
  return [periodKey, shiftPeriodKey(periodKey, -1)];
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

/**
 * Скільки місяців знімка лишається на диску.
 *
 * Офлайн потрібен для «що я витратив вчора», а не за архів за два
 * роки. Три місяці — це трохи більше за 100 КБ, і цифри на екрані
 * лишаються правильними: місяць у кеші завжди цілий.
 */
const CACHED_MONTHS_LIMIT = 3;

/**
 * Відкидає місяці, які старші за останні.
 *
 * Межа — по місяцях, а не по днях: частковий місяць дав би
 * правильне на око, але неправильне за сумою «Залишок». Краще
 * не показувати місяць узагалі, ніж показати його половину.
 *
 * @param {{ transactions: Array<object>, loadedPeriods: Array<string> }} snapshot
 * @param {string} activePeriodKey — його не відкидаємо навіть якщо він найстаріший
 * @returns {{ transactions: Array<object>, loadedPeriods: Array<string> }}
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
/** Незмінний початковий стан — до нього повертаємось при помилці. */
function createInitialState() {
  return {
    /** @type {{ name: string, color: string }} хто увійшов */
    viewer: ANONYMOUS_VIEWER,
    /** @type {Array<object>} */
    categories: [],
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
   * @type {Map<string, Array<object>>} ліміти, вже бачені за цю сесію
   *
   * Ліміти належать місяцю, тому «повернутися на жовтень» означає
   * побачити жовтневий бюджет, а не той, що був на екрані мить тому.
   * Тримаємо їх окремо від місяців, щоб повторне перемикання не
   * вимагало запиту.
   */
  #categoriesByLimitPeriod = new Map();
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
      categories: cachedSnapshot.categories ?? [],
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
 * Надсилає один запис черги відповідною дією.
 *
 * Дії три, але спільне в них одне: усі повертають оновлений знімок,
 * тому `#sendQueuedEntries` не знає, яку саме дію надіслано.
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
        const limitPeriod = this.#limitPeriod();

        const response = await this.#sendQueuedEntry(nextQueuedEntry, periods, limitPeriod);

        this.#applySnapshot(response.snapshot, limitPeriod);
        this.#removeFromQueue(nextQueuedEntry.id);
      } catch (error) {
        // Прострочена сесія - не відмова. Запис лишається в
        // черзі й дійде одразу після повторного входу.
        if (isSessionExpired(error)) throw error;

        if (!isWorthRetrying(error)) {
          this.#discardPendingEntry(nextQueuedEntry.id);
          continue;
        }
        throw error;
      }
    }
  }

  /** @returns {Promise<void>} */
  async #reloadSnapshot() {
    this.#applySnapshot(
      await fetchBudgetSnapshot(this.#sessionToken, this.#requestedPeriods(), this.#limitPeriod()),
      this.#limitPeriod(),
    );
  }

  /**
   * Місяці, які хочемо отримати від сервера: уже завантажені плюс
   * відкритий і той, що йому передуває.
   *
   * Запит лише цих місяців — інакше серверний знімок витер би те,
   * що ми вже завантажили. Відкритий місяць додається окремо: він мусить
   * бути на екрані, навіть якщо його витіснив з пам'яті власний запит.
   *
   * Завжди повертає повний набір, тож одного виклику synchronize()
   * вистачає й на перший вхід із довільним місяцем — окремий запит
   * за відкритим місяцем уже не потрібен.
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
   * Місяць, для якого показуємо бюджет: той, що відкритий на екрані.
   *
   * Ліміти надсилаються окремо від операцій саме тому, що операції
   * потрібні за два місяці, а бюджет — лише за один. Узяти ліміти з
   * усіх запитаних місяців означало б бачити жовтневий бюджет і в
   * вересні, де його не задавали.
   *
   * @returns {string}
   */
  #limitPeriod() {
    return this.#activePeriodKey ?? currentPeriodKey();
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
   * Береться місяць **і попередній**: попередній потрібен для
   * «динаміки до минулого місяця». Тому місяць вважається готовим
   * лише тоді, коли готовий і попередній — інакше порівняння просто
   * не з'явиться, хоча дані для нього є.
   *
   * @param {string} periodKey — «2026-10»
   * @returns {Promise<void>}
   */
  async loadPeriod(periodKey) {
    if (!this.#sessionToken) return;

    const neededPeriods = withPreviousPeriod(periodKey);
    const areMonthsLoaded = neededPeriods.every((needed) => this.isPeriodLoaded(needed));
    const knownCategories = this.#categoriesByLimitPeriod.get(periodKey);

    // Місяць уже в пам'яті й його ліміти ми вже бачили — повертаємося
    // миттєво, без запиту. Ліміти тримаємо окремо від місяців, бо
    // вони змінюються разом з тим, який місяць відкритий.
    if (areMonthsLoaded && knownCategories) {
      this.#patch({ categories: knownCategories });
      return;
    }

    // Не дублювати роботу, поки запит із тими самими місяцями ще
    // в дорозі. Швидке перемикання двома кліками не має породжувати
    // два однакові запити.
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
   * @param {string} limitPeriod — місяць, чиї ліміти прийшли у знімку
   */
  #applySnapshot(snapshot, limitPeriod) {
    if (!snapshot) return false;

    const coveredPeriods = readCoveredPeriods(snapshot);
    if (coveredPeriods.length === 0) return false;

    const categories = snapshot.categories ?? [];
    this.#categoriesByLimitPeriod.set(limitPeriod, categories);

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
      categories,
      transactions,
      loadedPeriods,
      lastSyncedAt: new Date().toISOString(),
    };

    saveCachedSnapshot(trimSnapshotToRecentMonths(nextState, this.#activePeriodKey));
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
   * Переписує наявну операцію.
   *
   * Два випадки, і вони принципово різні:
   *
   *   запис уже в таблиці — надсилаємо дію `update`, оптимістично
   *     міняємо його на місці; id лишається серверним, тож злиття зі
   *     знімком замінить копію версією з таблиці;
   *
   *   запис досі в черзі — окремої дії не потрібно. Він ще не дійшов,
   *     тож правимо чернетку прямо в черзі, інакше сервер отримав би
   *     `update` для рядка, якого в таблиці немає.
   *
   * @param {string} transactionId
   * @param {object} changes — сума, категорія, дата, нотатка
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
          // Попередні значення потрібні, щоб відкотити правку, якщо
          // сервер відхилить її остаточно: інакше запис лишився б у
          // списку з новими даними й назавжди «очікував би».
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
   * Править чернетку запису, який ще не дійшов до сервера.
   *
   * Окремої дії в черзі не додається: запис створиться з новими
   * значеннями, коли черга дійде до нього.
   *
   * @param {string} transactionId
   * @param {object} changes
   * @returns {string} id запису черги, який тепер описує цю правку
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
        // id черги стає тимчасовим id запису. Без нього оптимістична
        // копія лишалася б без ідентифікатора, і злиття зі знімком
        // не могло б зрозуміти, що це вже той самий запис.
        transactions: [
          ...this.#state.transactions,
          { ...queuedEntry.transaction, id: queuedEntry.id, pending: true },
        ],
      });
    } else if (queuedEntry.action === "update") {
      // Правка змінює запис на місці: id лишається серверним, тож
      // злиття зі знімком замінить копію тією версією, що прийшла
      // з таблиці. Прапорець pending гасить зліт з оригіналом,
      // доки сервер не підтвердить.
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
   * Перезаписує кеш сторінки.
   *
   * `#applySnapshot` робить це разом із читанням, але оптимістична
   * копія зникає вже після нього — у `#removeFromQueue`. Без
   * повторного запису кеш зберігав би її назавжди: після
   * перезавантаження сторінки злиття не могло б її розпізнати
   * (її id належить черзі, а не таблиці), тож у списку з'явилися
   * б два рядки про одну витрату.
   */
  #saveCache() {
    saveCachedSnapshot(trimSnapshotToRecentMonths({
      viewer: this.#state.viewer,
      categories: this.#state.categories,
      transactions: this.#state.transactions,
      loadedPeriods: this.#state.loadedPeriods,
      lastSyncedAt: this.#state.lastSyncedAt,
    }, this.#activePeriodKey));
  }

  /** @param {string} queuedEntryId */
  #removeFromQueue(queuedEntryId) {
    const remainingEntries = loadPendingEntries(this.#sessionLogin).filter((entry) => entry.id !== queuedEntryId);
    savePendingEntries(this.#sessionLogin, remainingEntries);
    // Запис з сервера вже в знімку, тому оптимістичну копію прибираємо:
    // інакше в списку було б два рядки про одну й ту саму витрату.
    this.#patch({
      pendingEntries: remainingEntries,
      transactions: this.#state.transactions.filter(
        (transaction) => transaction.id !== queuedEntryId,
      ),
    });

    this.#saveCache();
  }

  /**
   * Прибирає дію з черги назавжди — коли сервер відхилив її остаточно.
   * Повторювати такий запит безглуздо: він лише блокував би решту черги.
   *
   * Для правки відкатуємо запис до попередніх значень: інакше він
   * лишився б у списку з новими даними й прапорцем «очікує», хоча
   * його вже ніхто не відправить.
   *
   * @param {string} queuedEntryId
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
