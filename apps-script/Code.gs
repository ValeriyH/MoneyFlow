/**
 * Code.gs — серверна частина MoneyFlow.
 *
 * Відповідає за три речі:
 *   doPost(action=loadSnapshot)     — віддає знімок бюджету;
 *   doPost(action=addTransaction)   — додає операцію;
 *   doPost(action=deleteTransaction)— видаляє операцію.
 *
 * АВТОРИЗАЦІЯ
 * Користувач вводить свій код доступу. Сервер знаходить у аркуші `Users`
 * рядок, у якому хеш цього коду збігається, і бере ім'я звідти.
 * Від цього імені буде заповнюватися таблиця
 *
 * У таблиці зберігається не сам код, а SHA-256(сіль + код).
 * Тому хто має доступ до таблиці — не бачить чужих паролів.
 *
 * ВАЖЛИВО про розгортання:
 *   Execute as:  Me (власник)
 *   Who has access: Anyone
 * Така конфігурація не вимагає OAuth від відвідувача — саме тому
 * запит із браузера проходить без додаткових кроків.
 *
 * Жодних залежностей. Копіюється в редактор Apps Script як є.
 */

/* ── Назви аркушів (мають збігатися з підписами в таблиці) ───────────────── */

const SHEET_TRANSACTIONS = 'Transactions';
const SHEET_CATEGORIES = 'Categories';
const SHEET_USERS = 'Users';

const HEADER_ID = 'ID';
const HEADER_DATE = 'Дата';
const HEADER_KIND = 'Тип';
const HEADER_CATEGORY = 'Категорія';
const HEADER_AMOUNT = 'Сума';
const HEADER_USER = 'Користувач';
const HEADER_NOTE = 'Нотатка';
const HEADER_RECORDED_AT = 'Записано';

const HEADER_CATEGORY_NAME = 'Назва';
const HEADER_CATEGORY_KIND = 'Тип';
const HEADER_CATEGORY_ICON = 'Іконка';
const HEADER_CATEGORY_COLOR = 'Колір';
const HEADER_CATEGORY_LIMIT = 'Ліміт, ₴';

const HEADER_USER_NAME = 'Ім\'я';
const HEADER_USER_COLOR = 'Колір';
const HEADER_USER_SALT = 'Сіль';
const HEADER_USER_ACCESS_HASH = 'Код доступу';
const HEADER_USER_ACTIVE = 'Активний';

const KIND_EXPENSE = 'Витрата';
const KIND_INCOME = 'Дохід';

/* ── Захист від перебору ────────────────────────────────────────────────── */

/**
 * Скільки невдалих спроб поспіль допускаємо до блокування.
 *
 * Лічильник спільний на всіх: до перевірки ще невідомо, чий код
 * намагаються ввести.
 *
 * Блокування перевіряється ДО будь-якого порівняння хешів, тому
 * після спрацювання відсікаються всі запити - включно з правильним
 * кодом. Перебір з ~144 000 спроб на добу падає до 480: у 300 разів.
 * За тиждень автоматичний підбір не встигає нічого.
 *
 * Побічний ефект теж корисний: якщо раптом ніхто з сім'ї не може
 * увійти, значить або хтось систематично помиляється, або до таблиці
 * стукає сторонній.
 */
const MAX_FAILED_ATTEMPTS = 5;

/** На скільки хвилин блокується вхід після цих спроб. */
const LOCKOUT_DURATION_MINUTES = 15;

/** Ключ у PropertiesService, де живе лічильник спроб. */
const ATTEMPT_STATE_KEY = 'moneyflow.loginAttempts';

/* ── Самостійна реєстрація ──────────────────────────────────────────────── */

/**
 * Будь-хто, хто знає адресу Web App, може надіслати заявку.
 * Щоб відкрита реєстрація не перетворилася на сміття, ставимо межі:
 * вони вищі за потреби нормальної сім'ї, але нижі за рівень
 * «скрипт набиває таблицю».
 */
const MAX_TOTAL_USERS = 10;
const MAX_PENDING_USERS = 3;

/** Мінімальна довжина коду, який обрав собі користувач. */
const MIN_ACCESS_TOKEN_LENGTH = 10;

const FLAG_ACTIVE = 'Так';
const FLAG_INACTIVE = 'Ні';

/** Палітра для випадкових аватарок. */
const USER_AVATAR_COLORS = [
  '#2563eb', '#db2777', '#0f9d58', '#d97706',
  '#0891b2', '#7c3aed', '#65a30d', '#4f46e5',
];

/* ── Точка входу ─────────────────────────────────────────────────────────── */

/**
 * Єдиний вхід для всіх дій: маршрутизація за полем `action`.
 * Окремого doGet немає навмисно — код доступу не повинен потрапляти
 * в URL, бо URL потрапляє в логи сервера, історію браузера й Referer.
 *
 * @param {Object} request
 * @returns {TextOutput} JSON
 */
function doPost(request) {
  try {
    const payload = JSON.parse(request.postData.contents);

    // Реєстрація - єдина дія без коду доступу: інакше нікому
    // не було б сенсу заводити акаунт.
    if (payload.action === 'requestRegistration') {
      return respondWithJson(Object.assign({ ok: true }, createPendingUser(payload)));
    }

    const viewer = authenticateUser(payload.accessToken);

    switch (payload.action) {
      case 'loadSnapshot':
        return respondWithJson(Object.assign({ ok: true }, buildSnapshot(viewer)));

      case 'addTransaction':
        return respondWithJson({
          ok: true,
          transaction: appendTransaction(payload.transaction || {}, viewer),
          // Повертаємо оновлені дані одразу: інакше клієнту
          // довелося б робити другий запит і чекати ще ~3 секунди.
          snapshot: buildSnapshot(viewer),
        });

      case 'deleteTransaction':
        deleteTransactionById(payload.transactionId);
        return respondWithJson({
          ok: true,
          deletedId: payload.transactionId,
          snapshot: buildSnapshot(viewer),
        });

      default:
        throw new RequestError('Невідома дія: ' + payload.action, 'BAD_REQUEST');
    }
  } catch (error) {
    return respondWithError(error);
  }
}

/**
 * Повний знімок бюджету для конкретного користувача.
 *
 * @param {BudgetUser} viewer
 * @returns {{ serverTime: string, viewer: object, categories: Array<object>, transactions: Array<object> }}
 */
function buildSnapshot(viewer) {
  return {
    serverTime: new Date().toISOString(),
    viewer: { name: viewer.name, color: viewer.color },
    categories: readCategories(),
    transactions: readTransactions(),
  };
}

/* ── Авторизація ─────────────────────────────────────────────────────────── */

/**
 * @typedef {{ name: string, color: string, salt: string, accessTokenHash: string, isActive: boolean }} BudgetUser
 */

/**
 * Шукає користувача, чий код доступу збігається з поданим.
 *
 * @param {string} providedAccessToken
 * @returns {BudgetUser}
 */
function authenticateUser(providedAccessToken) {
  ensureLoginIsNotBlocked();

  const submittedToken = String(providedAccessToken || '').trim();
  if (submittedToken === '') {
    throw new RequestError('Введіть код доступу', 'UNAUTHORIZED');
  }

  const users = readUsers();
  if (users.length === 0) {
    throw new RequestError('У таблиці не заведено жодного користувача', 'SERVER_ERROR');
  }

  for (const user of users) {
    if (hashAccessToken(submittedToken, user.salt) !== user.accessTokenHash) continue;

    // Код правильний, але акаунт ще не увімкнутий. Кажемо прямо,
    // щоб людина не думала, що ввела неправильний пароль.
    if (!user.isActive) {
      throw new RequestError(
        'Акаунт створено, але ще не активовано. Адміністратор має увімкнути його в таблиці.',
        'UNAUTHORIZED',
      );
    }

    clearFailedAttempts();
    return user;
  }

  registerFailedAttempt();

  console.warn('Спроба входу з невірним кодом доступу о ' + new Date().toISOString());
  throw new RequestError('Код доступу не підходить', 'UNAUTHORIZED');
}

/**
 * Створює заявку на користувача. Пароль ніде не зберігається -
 * лише SHA-256(сіль + пароль). Аккаунт одразу неактивний: увійти
 * може тільки той, хто має доступ до таблиці й увімкнув рядок.
 *
 * @param {{ name: string, password: string }} payload
 * @returns {{ name: string, isActive: boolean }}
 */
function createPendingUser(payload) {
  const userName = String(payload.name || '').trim();
  const userPassword = String(payload.password || '').trim();

  if (userName.length < 2 || userName.length > 40) {
    throw new RequestError('Ім\'я має бути від 2 до 40 символів', 'BAD_REQUEST');
  }

  requireStrongAccessToken(userPassword);

  const existingUsers = readUsers();

  if (existingUsers.length >= MAX_TOTAL_USERS) {
    throw new RequestError('У бюджеті вже достатньо користувачів', 'RATE_LIMITED');
  }

  const pendingUserCount = existingUsers.filter(function (user) {
    return !user.isActive;
  }).length;

  if (pendingUserCount >= MAX_PENDING_USERS) {
    throw new RequestError(
      'Уже є заявки в очікуванні. Адміністратор має їх обробити.',
      'RATE_LIMITED',
    );
  }

  const isNameTaken = existingUsers.some(function (user) {
    return user.name.toLowerCase() === userName.toLowerCase();
  });
  if (isNameTaken) {
    throw new RequestError('Таке ім\'я вже зайняте', 'BAD_REQUEST');
  }

  const salt = generateSalt();

  getRequiredSheet(SHEET_USERS).appendRow([
    userName,
    pickRandomAvatarColor(),
    salt,
    hashAccessToken(userPassword, salt),
    FLAG_INACTIVE,
  ]);

  console.log('Нова заявка на користувача: ' + userName + ' о ' + new Date().toISOString());

  return { name: userName, isActive: false };
}

/**
 * Вмикає або вимикає існуючого користувача.
 *
 * Запускається вручну з редактора, але частіше просто правлять
 * клітинку «Активний» у самій таблиці.
 *
 *   setUserActive('Оля', true);
 *
 * @param {string} userName
 * @param {boolean} isActive
 * @return {string} повідомлення з результатом
 */
function setUserActive(userName, isActive) {
  const trimmedName = String(userName || '').trim();
  if (trimmedName === '') throw new Error('Потрібне ім\'я');

  const usersSheet = getRequiredSheet(SHEET_USERS);
  const activeColumnIndex = findColumnIndex(usersSheet, HEADER_USER_ACTIVE);

  if (activeColumnIndex === -1) {
    throw new Error('В аркуші Users немає стовпця ' + HEADER_USER_ACTIVE);
  }

  const lastRowIndex = usersSheet.getLastRow();
  const nameColumnValues = usersSheet
    .getRange(2, findColumnIndex(usersSheet, HEADER_USER_NAME) + 1, lastRowIndex - 1, 1)
    .getValues();

  for (let offset = 0; offset < nameColumnValues.length; offset += 1) {
    if (String(nameColumnValues[offset][0]).trim() !== trimmedName) continue;

    usersSheet.getRange(offset + 2, activeColumnIndex + 1).setValue(isActive ? FLAG_ACTIVE : FLAG_INACTIVE);
    return 'Користувач «' + trimmedName + '» ' + (isActive ? 'активовано' : 'деактивовано');
  }

  throw new Error('Користувача «' + trimmedName + '» не знайдено');
}

/**
 * @typedef {{ failures: number, blockedUntil: string | null }} AttemptState
 */

/** @returns {AttemptState} */
function readAttemptState() {
  const rawState = PropertiesService.getScriptProperties().getProperty(ATTEMPT_STATE_KEY);
  if (!rawState) return { failures: 0, blockedUntil: null };

  try {
    const parsedState = JSON.parse(rawState);
    return {
      failures: Number(parsedState.failures) || 0,
      blockedUntil: parsedState.blockedUntil || null,
    };
  } catch (error) {
    // Пошкоджений стан не має ламати вхід — починаємо спочатку.
    return { failures: 0, blockedUntil: null };
  }
}

/** @param {AttemptState} attemptState */
function saveAttemptState(attemptState) {
  PropertiesService.getScriptProperties().setProperty(
    ATTEMPT_STATE_KEY,
    JSON.stringify(attemptState),
  );
}

/**
 * Кидає помилку, якщо вхід заблоковано й час ще не минув.
 */
function ensureLoginIsNotBlocked() {
  const attemptState = readAttemptState();
  if (!attemptState.blockedUntil) return;

  const blockedUntilMs = new Date(attemptState.blockedUntil).getTime();
  const remainingMs = blockedUntilMs - Date.now();

  if (remainingMs <= 0) {
    saveAttemptState({ failures: 0, blockedUntil: null });
    return;
  }

  throw new RequestError(
    'Забагато спроб із невірним кодом. Зачекайте ' + Math.ceil(remainingMs / 60000) + ' хв.',
    'RATE_LIMITED',
    { retryAfterSeconds: Math.ceil(remainingMs / 1000) },
  );
}

/** Рахує невдалу спробу й вмикає блокування, коли їх вистачило. */
function registerFailedAttempt() {
  const attemptState = readAttemptState();
  attemptState.failures += 1;

  if (attemptState.failures >= MAX_FAILED_ATTEMPTS) {
    attemptState.failures = 0;
    attemptState.blockedUntil = new Date(
      Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000,
    ).toISOString();

    console.warn('Вхід заблоковано на ' + LOCKOUT_DURATION_MINUTES + ' хв о ' + new Date().toISOString());
  }

  saveAttemptState(attemptState);
}

/** Скидає лічильник після успішного входу. */
function clearFailedAttempts() {
  saveAttemptState({ failures: 0, blockedUntil: null });
}

/**
 * Хеш коду з персональною сіллю. Сіль ускладнює підбір
 * і дозволяє мати однакові коди різним людям.
 *
 * @param {string} accessToken
 * @param {string} salt
 * @returns {string} base64
 */
function hashAccessToken(accessToken, salt) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + accessToken,
    Utilities.Charset.UTF_8,
  );
  return Utilities.base64Encode(digest);
}

/**
 * @returns {Array<BudgetUser>}
 */
function readUsers() {
  const usersSheet = getRequiredSheet(SHEET_USERS);

  // Без колонки «Активний» не можна зрозуміти, хто вже увімкнений,
  // а хто лише зареєструвався. Тихорто падаємо одразу й голосно:
  // краще явна помилка в журналі, ніж пустий вхід у бюджет.
  if (findColumnIndex(usersSheet, HEADER_USER_ACTIVE) === -1) {
    throw new RequestError(
      'В аркуші ' + SHEET_USERS + ' немає стовпця «' + HEADER_USER_ACTIVE +
      '». Перезапустіть bootstrapSheets або додайте колонку вручну.',
      'SERVER_ERROR',
    );
  }

  return readSheetAsRecords(SHEET_USERS)
    .map(function (record) {
      return {
        name: String(record[HEADER_USER_NAME] || '').trim(),
        color: String(record[HEADER_USER_COLOR] || '#2563eb').trim(),
        salt: String(record[HEADER_USER_SALT] || '').trim(),
        accessTokenHash: String(record[HEADER_USER_ACCESS_HASH] || '').trim(),
        isActive: isTruthyFlag(record[HEADER_USER_ACTIVE]),
      };
    })
    .filter(function (user) {
      return user.name !== '' && user.salt !== '' && user.accessTokenHash !== '';
    });
}

/**
 * Вимоги до коду доступу. Застосовуються і до самостійної реєстрації,
 * і до кодів, які заводить адміністратор - секрет один і той же,
 * тому правила мають бути однакові.
 *
 * @param {string} accessToken
 */
function requireStrongAccessToken(accessToken) {
  if (accessToken.length < MIN_ACCESS_TOKEN_LENGTH) {
    throw new RequestError(
      'Пароль має містити щонайменше ' + MIN_ACCESS_TOKEN_LENGTH + ' символів',
      'BAD_REQUEST',
    );
  }

  if (!/[a-z]/.test(accessToken)) {
    throw new RequestError('Пароль має містити хоча б одну малу літеру', 'BAD_REQUEST');
  }
  if (!/[A-Z]/.test(accessToken)) {
    throw new RequestError('Пароль має містити хоча б одну велику літеру', 'BAD_REQUEST');
  }
  if (!/\d/.test(accessToken)) {
    throw new RequestError('Пароль має містити хоча б одну цифру', 'BAD_REQUEST');
  }
}

/**
 * @param {unknown} rawValue
 * @returns {boolean}
 */
function isTruthyFlag(rawValue) {
  const normalizedValue = String(rawValue || '').trim().toLowerCase();
  return ['так', 'yes', 'true', '1', 'y'].indexOf(normalizedValue) !== -1;
}

/** @returns {string} випадковий рядок із сіллю */
function generateSalt() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

/** @returns {string} колір аватарки з палітри */
function pickRandomAvatarColor() {
  const randomIndex = Math.floor(Math.random() * USER_AVATAR_COLORS.length);
  return USER_AVATAR_COLORS[randomIndex];
}

/**
 * Дописує людину в аркуш Users разом із сіллю і хешем коду.
 *
 * Це не серверна логіка — цю функцію запускають вручну з редактора
 * Apps Script, коли в сім'ї з'являється новий користувач:
 *
 *   registerUser('Оля', '#7c3aed', 'oliia-2026');
 *
 * @param {string} userName — ім'я, яким підпишуться операції
 * @param {string} userColor — колір аватарки, hex
 * @param {string} userAccessToken — код, який ця людина вводить на сайті
 * @return {string} повідомлення з результатом (видно у виводі)
 */
function registerUser(userName, userColor, userAccessToken) {
  const trimmedName = String(userName || '').trim();
  const trimmedToken = String(userAccessToken || '').trim();

  if (trimmedName === '') {
    throw new Error('Потрібне ім\'я');
  }

  requireStrongAccessToken(trimmedToken);

  const usersSheet = getRequiredSheet(SHEET_USERS);
  const salt = generateSalt();

  usersSheet.appendRow([
    trimmedName,
    String(userColor || pickRandomAvatarColor()).trim(),
    salt,
    hashAccessToken(trimmedToken, salt),
    FLAG_ACTIVE,
  ]);

  const result = 'Користувач «' + trimmedName + '» доданий. Код доступу: ' + trimmedToken;
  Logger.log(result);
  return result;
}

/**
 * Замінює код доступу вже заведеної людини. Нова сіль генерується
 * заново, тож старий хеш більше не підходить ні за що.
 *
 * Так само запускається вручну з редактора:
 *
 *   resetUserAccessToken('Оля', 'novyi-kod');
 *
 * @param {string} userName
 * @param {string} newAccessToken
 * @return {string} повідомлення з результатом
 */
function resetUserAccessToken(userName, newAccessToken) {
  const trimmedName = String(userName || '').trim();
  const trimmedToken = String(newAccessToken || '').trim();

  if (trimmedName === '') {
    throw new Error('Потрібне ім\'я');
  }

  requireStrongAccessToken(trimmedToken);

  const usersSheet = getRequiredSheet(SHEET_USERS);
  const nameColumnIndex = findColumnIndex(usersSheet, HEADER_USER_NAME);
  const saltColumnIndex = findColumnIndex(usersSheet, HEADER_USER_SALT);
  const hashColumnIndex = findColumnIndex(usersSheet, HEADER_USER_ACCESS_HASH);

  if (nameColumnIndex === -1 || saltColumnIndex === -1 || hashColumnIndex === -1) {
    throw new Error('У аркуші Users бракує потрібних стовпців');
  }

  const lastRowIndex = usersSheet.getLastRow();
  const nameColumnValues = usersSheet
    .getRange(2, nameColumnIndex + 1, lastRowIndex - 1, 1)
    .getValues();

  for (let offset = 0; offset < nameColumnValues.length; offset += 1) {
    if (String(nameColumnValues[offset][0]).trim() !== trimmedName) continue;

    const rowIndex = offset + 2;
    const newSalt = generateSalt();

    usersSheet.getRange(rowIndex, saltColumnIndex + 1).setValue(newSalt);
    usersSheet.getRange(rowIndex, hashColumnIndex + 1).setValue(hashAccessToken(trimmedToken, newSalt));

    const result = 'Код доступу для «' + trimmedName + '» змінено. Новий код: ' + trimmedToken;
    Logger.log(result);
    return result;
  }

  throw new Error('Користувача «' + trimmedName + '» не знайдено. Спершу registerUser.');
}

/**
 * Видаляє людину з аркуша Users. Їй більше не вдасться увійти,
 * а вся її минула історія залишається в Transactions.
 *
 *   removeUser('Оля');
 *
 * @param {string} userName
 * @return {string} повідомлення з результатом
 */
function removeUser(userName) {
  const trimmedName = String(userName || '').trim();
  if (trimmedName === '') throw new Error('Потрібне ім\'я');

  const usersSheet = getRequiredSheet(SHEET_USERS);
  const nameColumnIndex = findColumnIndex(usersSheet, HEADER_USER_NAME);

  if (nameColumnIndex === -1) {
    throw new Error('У аркуші Users немає стовпця ' + HEADER_USER_NAME);
  }

  const lastRowIndex = usersSheet.getLastRow();
  const nameColumnValues = usersSheet
    .getRange(2, nameColumnIndex + 1, lastRowIndex - 1, 1)
    .getValues();

  for (let offset = 0; offset < nameColumnValues.length; offset += 1) {
    if (String(nameColumnValues[offset][0]).trim() === trimmedName) {
      usersSheet.deleteRow(offset + 2);
      return 'Користувача «' + trimmedName + '» видалено.';
    }
  }

  throw new Error('Користувача «' + trimmedName + '» не знайдено.');
}

/* ── Читання даних ──────────────────────────────────────────────────────── */

/** @returns {Array<object>} */
function readCategories() {
  return readSheetAsRecords(SHEET_CATEGORIES)
    .map(function (record, index) {
      return {
        name: String(record[HEADER_CATEGORY_NAME] || '').trim(),
        kind: toApiKind(record[HEADER_CATEGORY_KIND]),
        icon: String(record[HEADER_CATEGORY_ICON] || '•').trim(),
        color: String(record[HEADER_CATEGORY_COLOR] || '#8b95a8').trim(),
        limit: toPositiveNumber(record[HEADER_CATEGORY_LIMIT]),
        order: index,
      };
    })
    .filter(function (category) {
      return category.name !== '';
    })
    .sort(function (left, right) {
      return left.order - right.order;
    });
}

/** @returns {Array<object>} */
function readTransactions() {
  const transactions = [];
  let skippedRowsCount = 0;

  for (const record of readSheetAsRecords(SHEET_TRANSACTIONS)) {
    const amount = toPositiveNumber(record[HEADER_AMOUNT]);
    const occurredOn = toIsoDate(record[HEADER_DATE]);

    if (!amount || !occurredOn) {
      skippedRowsCount += 1;
      continue;
    }

    transactions.push({
      id: String(record[HEADER_ID] || '').trim() || Utilities.getUuid(),
      occurredOn: occurredOn,
      kind: toApiKind(record[HEADER_KIND]),
      category: String(record[HEADER_CATEGORY] || 'Інше').trim(),
      amount: amount,
      user: String(record[HEADER_USER] || '').trim(),
      note: String(record[HEADER_NOTE] || '').trim(),
      recordedAt: toIsoTimestamp(record[HEADER_RECORDED_AT]),
    });
  }

  if (skippedRowsCount > 0) {
    console.warn('Пропущено рядків без суми або дати: ' + skippedRowsCount);
  }

  return transactions;
}

/* ── Запис даних ─────────────────────────────────────────────────────────── */

/**
 * @param {object} payload — дані з форми; поле «Користувач» ігнорується
 * @param {BudgetUser} viewer — автентифікований користувач
 * @returns {object} створена або вже наявна операція
 */
function appendTransaction(payload, viewer) {
  const amount = toPositiveNumber(payload.amount);
  const occurredOn = toIsoDate(payload.occurredOn);

  if (!amount) {
    throw new RequestError('Сума має бути додатним числом', 'BAD_REQUEST');
  }
  if (!occurredOn) {
    throw new RequestError('Не вдалося розпізнати дату: ' + payload.occurredOn, 'BAD_REQUEST');
  }

  const categoryName = String(payload.category || '').trim();
  if (!categoryName) {
    throw new RequestError('Не вказано категорію', 'BAD_REQUEST');
  }

  const transactionId = String(payload.id || '').trim() || Utilities.getUuid();
  const transactionKind = normalizeKind(payload.kind);
  const note = String(payload.note || '').trim().slice(0, 200);

  const transactionsSheet = getRequiredSheet(SHEET_TRANSACTIONS);

  // Обидва записи в таблицю і в відповідь клієнту.
  // У відповіді тип машинний: клієнт порівнює його з 'expense'/'income'.
  const apiKind = toApiKind(transactionKind);
  const createdTransaction = {
    id: transactionId,
    occurredOn: occurredOn,
    kind: apiKind,
    category: categoryName,
    amount: amount,
    user: viewer.name,
    note: note,
    recordedAt: new Date().toISOString(),
  };

  // Клієнт генерує ID заздалегідь. Якщо запит дійшов двічі — після
  // обриву зв'язку та повторної відправки з черги — не дублюємо
  // рядок, а повертаємо те, що вже записано.
  const existingRowIndex = findTransactionRowIndexById(transactionsSheet, transactionId);
  if (existingRowIndex !== -1) {
    return createdTransaction;
  }

  appendRowByColumnNames(transactionsSheet, [
    transactionId,
    occurredOn,
    transactionKind,
    categoryName,
    amount,
    viewer.name,
    note,
    new Date(),
  ]);

  return createdTransaction;
}

/**
 * Шукає рядок операції за її ID.
 *
 * @param {Sheet} transactionsSheet
 * @param {string} transactionId
 * @returns {number} номер рядка з нуля або -1
 */
function findTransactionRowIndexById(transactionsSheet, transactionId) {
  const normalizedId = String(transactionId || '').trim();
  if (normalizedId === '') return -1;

  const idColumnIndex = findColumnIndex(transactionsSheet, HEADER_ID);
  if (idColumnIndex === -1) return -1;

  const lastRowIndex = transactionsSheet.getLastRow();
  if (lastRowIndex < 2) return -1;

  const idColumnValues = transactionsSheet
    .getRange(2, idColumnIndex + 1, lastRowIndex - 1, 1)
    .getValues()
    .map(function (row) {
      return String(row[0]).trim();
    });

  for (let offset = 0; offset < idColumnValues.length; offset += 1) {
    if (idColumnValues[offset] === normalizedId) return offset + 2;
  }

  return -1;
}

/**
 * @param {string} transactionId
 */
function deleteTransactionById(transactionId) {
  const transactionsSheet = getRequiredSheet(SHEET_TRANSACTIONS);
  const rowIndex = findTransactionRowIndexById(transactionsSheet, transactionId);

  if (rowIndex === -1) {
    throw new RequestError('Операцію з таким ID не знайдено', 'BAD_REQUEST');
  }

  transactionsSheet.deleteRow(rowIndex);
}

/* ── Допоміжні функції роботи з таблицею ────────────────────────────────── */

/**
 * Читає аркуш у вигляді масиву об'єктів за підписами колонок.
 * Порядок колонок не важливий — важливі лише їхні назви.
 *
 * @param {string} sheetName
 * @returns {Array<Record<string, unknown>>}
 */
function readSheetAsRecords(sheetName) {
  const optionalSheet = getOptionalSheet(sheetName);
  if (!optionalSheet) return [];

  const lastRowIndex = optionalSheet.getLastRow();
  const lastColumnIndex = optionalSheet.getLastColumn();
  if (lastRowIndex < 2 || lastColumnIndex < 1) return [];

  const sheetValues = optionalSheet.getRange(1, 1, lastRowIndex, lastColumnIndex).getValues();
  const headerRow = sheetValues[0];

  const columnIndexByName = {};
  headerRow.forEach(function (columnName, columnIndex) {
    const normalizedName = String(columnName).trim();
    if (normalizedName !== '' && columnIndexByName[normalizedName] === undefined) {
      columnIndexByName[normalizedName] = columnIndex;
    }
  });

  const dataRows = sheetValues.slice(1).filter(function (row) {
    return row.some(function (cellValue) {
      return String(cellValue).trim() !== '';
    });
  });

  return dataRows.map(function (dataRow) {
    const record = {};

    for (const columnName in columnIndexByName) {
      record[columnName] = dataRow[columnIndexByName[columnName]];
    }

    return record;
  });
}

/**
 * Додає рядок, попередньо переставивши значення відповідно
 * до підписів колонок у шапці.
 *
 * @param {Sheet} sheet
 * @param {Array<unknown>} orderedValues
 */
function appendRowByColumnNames(sheet, orderedValues) {
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const valuesForSheetRow = new Array(headerRow.length).fill('');

  orderedValues.forEach(function (value, columnOffset) {
    const columnName = String(headerRow[columnOffset] || '').trim();
    const targetColumnIndex = columnName ? findColumnIndex(sheet, columnName) : -1;

    if (targetColumnIndex >= 0) {
      valuesForSheetRow[targetColumnIndex] = value;
    }
  });

  sheet.appendRow(valuesForSheetRow);
}

/**
 * @param {Sheet} sheet
 * @param {string} columnName
 * @returns {number} індекс з нуля або -1, якщо колонки немає
 */
function findColumnIndex(sheet, columnName) {
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const targetColumnName = columnName.trim().toLowerCase();

  for (let columnIndex = 0; columnIndex < headerRow.length; columnIndex += 1) {
    if (String(headerRow[columnIndex]).trim().toLowerCase() === targetColumnName) {
      return columnIndex;
    }
  }

  return -1;
}

/**
 * @param {string} sheetName
 * @returns {Sheet | null}
 */
function getOptionalSheet(sheetName) {
  return SpreadsheetApp.getActive().getSheetByName(sheetName);
}

/**
 * @param {string} sheetName
 * @returns {Sheet}
 */
function getRequiredSheet(sheetName) {
  const requiredSheet = getOptionalSheet(sheetName);
  if (!requiredSheet) {
    throw new RequestError('Не знайдено аркуш «' + sheetName + '»', 'SERVER_ERROR');
  }
  return requiredSheet;
}

/* ── Перетворення значень ────────────────────────────────────────────────── */

/**
 * @param {unknown} rawValue
 * @returns {number} 0, якщо значення не є додатковим числом
 */
function toPositiveNumber(rawValue) {
  const parsedValue = Number(rawValue);
  if (!isFinite(parsedValue) || parsedValue <= 0) return 0;
  return Math.round(parsedValue * 100) / 100;
}

/**
 * Приймає «2026-10-05», дату з таблиці або ISO-рядок.
 * @param {unknown} rawValue
 * @returns {string} «2026-10-05» або порожній рядок
 */
function toIsoDate(rawValue) {
  if (Object.prototype.toString.call(rawValue) === '[object Date]') {
    return Utilities.formatDate(rawValue, 'Europe/Kyiv', 'yyyy-MM-dd');
  }

  const textValue = String(rawValue || '').trim();
  if (textValue === '') return '';

  const isoDateMatch = textValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDateMatch) return isoDateMatch[0];

  const parsedDate = new Date(textValue);
  if (isNaN(parsedDate.getTime())) return '';

  return Utilities.formatDate(parsedDate, 'Europe/Kyiv', 'yyyy-MM-dd');
}

/**
 * @param {unknown} rawValue
 * @returns {string} ISO-час або порожній рядок
 */
function toIsoTimestamp(rawValue) {
  if (Object.prototype.toString.call(rawValue) === '[object Date]') {
    return rawValue.toISOString();
  }

  const parsedDate = new Date(String(rawValue || ''));
  return isNaN(parsedDate.getTime()) ? '' : parsedDate.toISOString();
}

/**
 * Приводить будь-яке подане значення до канонічного виду «Витрата»/«Дохід».
 * Це те, що лежить у самій таблиці - так його й видно людині.
 *
 * @param {unknown} rawValue
 * @returns {string}
 */
function normalizeKind(rawValue) {
  const normalizedValue = String(rawValue || '').trim().toLowerCase();

  const incomeAliases = ['дохід', 'доход', 'income', 'in', 'зарплата', '+'];
  if (incomeAliases.indexOf(normalizedValue) !== -1) return KIND_INCOME;

  return KIND_EXPENSE;
}

/**
 * Те саме, але для відповіді клієнту.
 *
 * У таблиці тип зберігається українською - щоб було читабельно очима.
 * У JSON він мусить бути стабільним машинним значенням: клієнт порівнює
 * його з рядками без будь-якого перекладу, і «Витрата» != 'expense'.
 *
 * @param {unknown} rawValue
 * @returns {'expense' | 'income'}
 */
function toApiKind(rawValue) {
  return normalizeKind(rawValue) === KIND_INCOME ? 'income' : 'expense';
}

/* ── Відповіді та помилки ───────────────────────────────────────────────── */

/** Помилка, яку можна показати користувачу без деталей. */
class RequestError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ retryAfterSeconds?: number }} [details] — додаткові поля для клієнта
   */
  constructor(message, code, details) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.details = details || {};
  }
}

/**
 * @param {object} payload
 * @returns {TextOutput}
 */
function respondWithJson(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Apps Script не дозволяє керувати HTTP-кодом, тому код
 * помилки їде в тілі відповіді.
 *
 * @param {Error} error
 * @returns {TextOutput}
 */
function respondWithError(error) {
  const isExpectedError = error instanceof RequestError;

  if (!isExpectedError) {
    console.error(error && error.stack ? error.stack : error);
  }

  return respondWithJson(Object.assign(
    {
      ok: false,
      code: isExpectedError ? error.code : 'SERVER_ERROR',
      error: isExpectedError ? error.message : 'Внутрішня помилка сервера. Спробуйте пізніше.',
    },
    isExpectedError ? error.details : {},
  ));
}
