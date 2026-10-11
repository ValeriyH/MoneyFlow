/**
 * Code.gs — серверна частина MoneyFlow.
 *
 * Відповідає за три речі:
 *   doPost(action=loadSnapshot)     — віддає знімок бюджету;
 *   doPost(action=addTransaction)   — додає операцію;
 *   doPost(action=deleteTransaction)— видаляє операцію.
 *
 * Авторизація та сесії — в auth.gs: там пароль не залишає браузер,
 * а браузер зберігає лише підписаний сервером токен.
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
const HEADER_USER_PASSWORD_HASH = 'Пароль';
const HEADER_USER_ACTIVE = 'Активний';

/*
 * Колонки, без яких аркуш не має сенсу.
 *
 * Проєкт без зворотної сумісності, тому «стара схема» не підтримується.
 * Натомість кожна зміна повинна валитися одразу й голосно: якщо
 * хтось перейменує колонку, краще явна помилка в журналі, ніж
 * бюджет, який тихо показує нулі. Саме на цьому тричі вже
 * ледь не втратили дані.
 */
const REQUIRED_TRANSACTION_COLUMNS = [
  HEADER_ID, HEADER_DATE, HEADER_KIND, HEADER_CATEGORY,
  HEADER_AMOUNT, HEADER_USER, HEADER_NOTE, HEADER_RECORDED_AT,
];

const REQUIRED_CATEGORY_COLUMNS = [
  HEADER_CATEGORY_NAME, HEADER_CATEGORY_KIND, HEADER_CATEGORY_ICON,
  HEADER_CATEGORY_COLOR, HEADER_CATEGORY_LIMIT,
];

/*
 * Скільки місяців дозволяємо просити в одному запиті.
 *
 * Клієнт надсилає рівно ті місяці, які вже тримає в пам'яті, щоб
 * серверний знімок не витер у нього решту. Обмеження ставить межу
 * тому, що клієнт не може витягнути аркуш цілком одним запитом.
 */
const MAX_PERIODS_PER_REQUEST = 12;

/*
 * Запасні рядки з кожного боку потрібної смуги.
 *
 * Дати в таблиці зазвичай ідуть по порядку, але запис можна додати
 * заднім числом — тоді він лежатиме поза смугою. Запас покриває
 * такий випадок; фінальна фільтрація все одно точна, зайві рядки
 * просто відкидаються.
 */
const PERIOD_ROW_WINDOW_PADDING = 60;

const REQUIRED_USER_COLUMNS = [
  HEADER_USER_NAME, HEADER_USER_COLOR, HEADER_USER_PASSWORD_HASH, HEADER_USER_ACTIVE,
];

const KIND_EXPENSE = 'Витрата';
const KIND_INCOME = 'Дохід';

/* ── Самостійна реєстрація ──────────────────────────────────────────────── */

/**
 * Будь-хто, хто знає адресу Web App, може надіслати заявку.
 * Щоб відкрита реєстрація не перетворилася на сміття, ставимо межі:
 * вони вищі за потреби нормальної сім'ї, але нижі за рівень
 * «скрипт набиває таблицю».
 */
const MAX_TOTAL_USERS = 10;
const MAX_PENDING_USERS = 3;

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
 *
 * Окремого doGet немає навмисно — токен не повинен потрапляти в URL,
 * бо URL потрапляє в логи сервера, історію браузера й Referer.
 *
 * @param {Object} request
 * @returns {TextOutput} JSON
 */
function doPost(request) {
  try {
    if (!request.postData || !request.postData.contents) {
      throw new RequestError('Порожній запит', 'BAD_REQUEST');
    }

    let payload;
    try {
      payload = JSON.parse(request.postData.contents);
    } catch {
      throw new RequestError('Тіло запиту — не коректний JSON', 'BAD_REQUEST');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RequestError('Очікувався об’єкт із полем action', 'BAD_REQUEST');
    }

    if (typeof payload.action !== 'string' || payload.action === '') {
      throw new RequestError('Не вказано дію', 'BAD_REQUEST');
    }

    // Дві дії без сесії: вхід за паролем і реєстрація. Інакше
    // завести акаунт або отримати сесію було б неможливо.
    if (payload.action === 'requestRegistration') {
      return respondWithJson(Object.assign({ ok: true }, createPendingUser(payload)));
    }

    if (payload.action === 'authenticate') {
      return respondWithJson(Object.assign({ ok: true }, authenticateByCredentials(payload)));
    }

    const viewer = authenticateSession(payload.sessionToken);
    const periods = parsePeriodsList(payload.periods);

    switch (payload.action) {
      case 'loadSnapshot':
        return respondWithJson(Object.assign({ ok: true }, buildSnapshot(viewer, periods)));

      case 'addTransaction':
        return respondWithJson({
          ok: true,
          transaction: appendTransaction(payload.transaction, viewer),
          // Повертаємо оновлені дані одразу: інакше клієнту
          // довелося б робити другий запит і чекати ще ~3 секунди.
          snapshot: buildSnapshot(viewer, periods),
        });

      case 'deleteTransaction':
        deleteTransactionById(payload.transactionId);
        return respondWithJson({
          ok: true,
          deletedId: String(payload.transactionId || '').trim(),
          snapshot: buildSnapshot(viewer, periods),
        });

      default:
        throw new RequestError('Невідома дія: ' + payload.action, 'BAD_REQUEST');
    }
  } catch (error) {
    return respondWithError(error);
  }
}

/**
 * Ключ поточного місяця «РРРР-ММ» у часовому поясі скрипта.
 * @returns {string}
 */
function currentPeriodKey() {
  const now = new Date();
  const monthNumber = now.getMonth() + 1;
  const month = monthNumber < 10 ? '0' + monthNumber : String(monthNumber);
  return now.getFullYear() + '-' + month;
}

/**
 * Перевіряє список місяців із запиту.
 *
 * Клієнт просить саме ті місяці, які вже тримає в пам'яті: так
 * серверний знімок замінює їх і не зачіпає решту. Якщо список
 * порожній або зовсім не прийшов — беремо поточний місяць, щоб
 * клієнт, який ще не вміє надсилати `periods`, отримав хоча б
 * щось осмислене, а не порожню таблицю.
 *
 * @param {unknown} rawPeriods
 * @returns {Array<string>}
 * @throws {RequestError}
 */
function parsePeriodsList(rawPeriods) {
  if (rawPeriods === undefined || rawPeriods === null) return [currentPeriodKey()];

  if (!Array.isArray(rawPeriods)) {
    throw new RequestError('Поле periods має бути масивом ключів «РРРР-ММ».', 'BAD_REQUEST');
  }

  const periods = [];

  rawPeriods.forEach(function (rawPeriod) {
    const period = String(rawPeriod === undefined || rawPeriod === null ? '' : rawPeriod).trim();

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new RequestError(
        'Невірний ключ місяця: ' + (period || '(порожньо)') + '. Очікується формат «РРРР-ММ».',
        'BAD_REQUEST',
      );
    }

    if (periods.indexOf(period) === -1) periods.push(period);
  });

  if (periods.length === 0) return [currentPeriodKey()];

  if (periods.length > MAX_PERIODS_PER_REQUEST) {
    throw new RequestError(
      'Запит просить ' + periods.length + ' місяців, а дозволено максимум ' + MAX_PERIODS_PER_REQUEST + '.',
      'BAD_REQUEST',
    );
  }

  return periods;
}

/**
 * Знімок бюджету для конкретного користувача й набору місяців.
 *
 * Повертається тільки запитані місяці — на п'ятирічній історії це
 * два десятки кілобайт замість двох мегабайтів. Клієнт знає, які
 * місяці прийшли, і замінює ними свої; решту не чіпає.
 *
 * @param {BudgetUser} viewer
 * @param {Array<string>} periods
 * @returns {{ serverTime: string, viewer: object, categories: Array<object>, periods: Array<string>, transactions: Array<object> }}
 */
function buildSnapshot(viewer, periods) {
  return {
    serverTime: new Date().toISOString(),
    viewer: { name: viewer.name, color: viewer.color },
    categories: readCategories(),
    periods: periods,
    transactions: readTransactions(periods),
  };
}

/* ── Авторизація ─────────────────────────────────────────────────────────── */

/**
 * @typedef {{ name: string, color: string, passwordHash: string, isActive: boolean }} BudgetUser
 */

/**
 * Ядро сесій: перевірка токена й пошук користувача.
 * Сам пароль не приходить на сервер у жодному запиті - тільки токен.
 *
 * @param {string} sessionToken
 * @returns {{ name: string, color: string, passwordHash: string, isActive: boolean }}
 */
function authenticateSession(sessionToken) {
  const tokenPayload = verifySessionToken(sessionToken);
  const user = findUserByLogin(tokenPayload.login);

  if (!user) {
    throw new RequestError('Користувача більше немає в таблиці', 'UNAUTHORIZED');
  }

  // Активність перевіряється щоразу, тому вимкненого користувача
  // відсікає миттєво, а не наприкінці терміну токена.
  if (!user.isActive) {
    throw new RequestError('Акаунт деактивовано', 'UNAUTHORIZED');
  }

  // Токен, виданий до зміни пароля, більше не приймається.
  const loginState = readLoginState()[user.name] || {};
  const credentialsChangedAtMs = loginState.credentialsChangedAtMs || 0;

  if (tokenPayload.issuedAt < credentialsChangedAtMs) {
    throw new RequestError('Пароль змінено. Увійдіть знову.', 'UNAUTHORIZED');
  }

  return user;
}

/**
 * Створює заявку на користувача. Пароль ніде не зберігається -
 * лише його хеш. Аккаунт одразу неактивний: увійти може тільки
 * той, хто має доступ до таблиці й увімкнув рядок.
 *
 * @param {{ login: string, passwordHash: string }} payload
 * @returns {{ login: string, isActive: boolean }}
 */
function createPendingUser(payload) {
  const userLogin = String(payload.login || '').trim();
  const userPasswordHash = String(payload.passwordHash || '').trim();

  if (userLogin.length < 2 || userLogin.length > 40) {
    throw new RequestError('Логін має бути від 2 до 40 символів', 'BAD_REQUEST');
  }

  if (!isSha256Hex(userPasswordHash)) {
    throw new RequestError('Не вдалося прочитати хеш пароля', 'BAD_REQUEST');
  }

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

  if (findUserByLogin(userLogin)) {
    throw new RequestError('Такий логін вже зайнятий', 'BAD_REQUEST');
  }

  insertUserRecord({
    login: userLogin,
    passwordHash: userPasswordHash,
    color: pickRandomAvatarColor(),
    isActive: false,
  });

  console.log('Нова заявка на користувача: ' + userLogin + ' о ' + new Date().toISOString());

  return { login: userLogin, isActive: false };
}

/**
 * Чи це хеш SHA-256 у шістнадцятковому записі.
 *
 * Єдина перевірка, яку сервер може зробити з паролем на реєстрації:
 * сам пароль сюди не доходить — приходить уже хеш.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSha256Hex(value) {
  return /^[0-9a-f]{64}$/.test(value);
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
  const usersHeader = readSheetHeader(usersSheet);
  const indexByName = usersHeader.index;

  requireSheetColumns(SHEET_USERS, indexByName, [HEADER_USER_NAME, HEADER_USER_ACTIVE]);

  const activeColumnIndex = indexByName.get(HEADER_USER_ACTIVE.toLowerCase());
  const nameColumnIndex = indexByName.get(HEADER_USER_NAME.toLowerCase());

  const lastRowIndex = usersSheet.getLastRow();
  const nameColumnValues = usersSheet
    .getRange(2, nameColumnIndex + 1, lastRowIndex - 1, 1)
    .getValues();

  for (let offset = 0; offset < nameColumnValues.length; offset += 1) {
    if (String(nameColumnValues[offset][0]).trim() !== trimmedName) continue;

    usersSheet.getRange(offset + 2, activeColumnIndex + 1).setValue(isActive ? FLAG_ACTIVE : FLAG_INACTIVE);
    return 'Користувач «' + trimmedName + '» ' + (isActive ? 'активовано' : 'деактивовано');
  }

  throw new Error('Користувача «' + trimmedName + '» не знайдено');
}
/**
 * Читає аркуш Users.
 *
 * Без колонки «Активний» не можна зрозуміти, хто вже увімкнений,
 * а хто лише зареєструвався. Без «Пароль» — немає з чим порівняти
 * доказ входу. В обох випадках падаємо одразу й голосно: мовчаливий
 * збій тут виглядав би як «невірний пароль», і людина шукала б
 * проблему в своєму голові.
 *
 * ЩО СТОСУЄТЬСЯ ХЕША — свідомо не перевіряється тут. Раніше кидали
 * помилку з ім’ям користувача, у якого хеш некоректний, і це
 * витікало назовні: спроба увійти під чужим логіном відповідала
 * «у користувача Тест некоректний хеш» і тим самим видавала, що
 * такий користувач є. Тепер битий хеш не зупиняє вхід ні для кого,
 * а дізнатися про нього можна через checkUsersIntegrity().
 *
 * @returns {Array<BudgetUser>}
 */
function readUsers() {
  return readSheetAsRecords(SHEET_USERS, REQUIRED_USER_COLUMNS)
    .map(function (record) {
      return {
        name: String(record[HEADER_USER_NAME] || '').trim(),
        color: String(record[HEADER_USER_COLOR] || '#2563eb').trim(),
        passwordHash: String(record[HEADER_USER_PASSWORD_HASH] || '').trim(),
        isActive: isTruthyFlag(record[HEADER_USER_ACTIVE]),
      };
    })
    .filter(function (user) {
      return user.name !== '' && user.passwordHash !== '';
    });
}

/**
 * Перевіряє цілісність аркуша Users і перелічує все, що зламано.
 *
 *   checkUsersIntegrity();
 *
 * Окрема функція, а не перевірка в readUsers, з міркувань безпеки:
 * деталі про конкретних людей не можна віддавати тому, хто просто
 * намагається вгадати логін.
 *
 * @return {string} звіт, видно у виводі редактора
 */
function checkUsersIntegrity() {
  const users = readUsers();
  const brokenLogins = users
    .filter(function (user) { return !isSha256Hex(user.passwordHash); })
    .map(function (user) { return user.name + ' (' + user.passwordHash.length + ' символів)'; });

  if (brokenLogins.length === 0) {
    const inactiveCount = users.filter(function (user) { return !user.isActive; }).length;
    return 'Users: все справне. Користувачів: ' + users.length + ', з них неактивних: ' + inactiveCount + '.';
  }

  return 'Users: некоректний хеш у ' + brokenLogins.length + ' — ' + brokenLogins.join(', ') +
    '. Виправте так: resetUserPassword(логін, НовийПароль);';
}

/**
 * @param {unknown} rawValue
 * @returns {boolean}
 */
function isTruthyFlag(rawValue) {
  const normalizedValue = String(rawValue || '').trim().toLowerCase();
  return ['так', 'yes', 'true', '1', 'y'].indexOf(normalizedValue) !== -1;
}

/** @returns {string} колір аватарки з палітри */
function pickRandomAvatarColor() {
  const randomIndex = Math.floor(Math.random() * USER_AVATAR_COLORS.length);
  return USER_AVATAR_COLORS[randomIndex];
}

/**
 * Дописує людину в аркуш Users разом із хешем пароля.
 *
 * Це не серверна логіка - цю функцію запускають вручну з редактора
 * Apps Script, коли в сім'ї з'являється новий користувач:
 *
 *   registerUser('Оля', '#7c3aed', 'Grivna-2026');
 *
 * @param {string} userName — логін, за ним і користувач входить
 * @param {string} userColor — колір аватарки, hex
 * @param {string} userPassword — пароль, який ця людина вводить на сайті
 * @return {string} повідомлення з результатом (видно у виводі)
 */
function registerUser(userName, userColor, userPassword) {
  const trimmedName = String(userName || '').trim();
  const plainPassword = String(userPassword || '');

  if (trimmedName === '') {
    throw new Error('Потрібне ім\'я');
  }

  requireStrongPassword(plainPassword);

  if (findUserByLogin(trimmedName)) {
    throw new Error('Користувач «' + trimmedName + '» уже існує.');
  }

  insertUserRecord({
    login: trimmedName,
    passwordHash: hashText(plainPassword),
    color: String(userColor || pickRandomAvatarColor()).trim(),
    isActive: true,
  });

  Logger.log('Користувач «' + trimmedName + '» доданий.');
  return 'Користувач «' + trimmedName + '» доданий.';
}

/**
 * Замінює пароль уже заведеної людини.
 *
 * Старі сесії при цьому перестають діяти: authenticateSession
 * порівнює час видачі токена з часом зміни пароля.
 *
 * Так само запускається вручну з редактора:
 *
 *   resetUserPassword('Оля', 'Nova-Parily-2026');
 *
 * @param {string} userName
 * @param {string} newPassword
 * @return {string} повідомлення з результатом
 */
function resetUserPassword(userName, newPassword) {
  const trimmedName = String(userName || '').trim();
  const plainPassword = String(newPassword || '');

  if (trimmedName === '') {
    throw new Error('Потрібне ім\'я');
  }

  requireStrongPassword(plainPassword);
  replaceUserPassword(trimmedName, plainPassword);

  const result = 'Пароль для «' + trimmedName + '» змінено. Старі сесії завершено.';
  Logger.log(result);
  return result;
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
  const usersHeader = readSheetHeader(usersSheet);
  const indexByName = usersHeader.index;
  requireSheetColumns(SHEET_USERS, indexByName, [HEADER_USER_NAME]);

  const nameColumnIndex = indexByName.get(HEADER_USER_NAME.toLowerCase());

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
  return readSheetAsRecords(SHEET_CATEGORIES, REQUIRED_CATEGORY_COLUMNS)
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

/**
 * Операції лише за вказаними місяцями.
 *
 * Аркуш не читається цілком. Спершу одна колонка з датою — у вісім
 * разів менше клітинок, ніж усі колонки, — щоб знайти межі потрібних
 * місяців. Потім читається тільки смуга рядків між ними.
 *
 * @param {Array<string>} periods — ключі «РРРР-ММ»
 * @returns {Array<object>}
 */
function readTransactions(periods) {
  const sheet = getOptionalSheet(SHEET_TRANSACTIONS);
  if (!sheet) return [];

  const header = readSheetHeader(sheet);
  requireSheetColumns(SHEET_TRANSACTIONS, header.index, REQUIRED_TRANSACTION_COLUMNS);

  const lastRowIndex = sheet.getLastRow();
  const lastColumnIndex = sheet.getLastColumn();
  if (lastRowIndex < 2 || lastColumnIndex < 1) return [];

  const columnIndexByName = buildColumnIndex(header.row);
  const rowRange = findRowRangeByPeriods(
    sheet,
    lastRowIndex,
    columnIndexByName[HEADER_DATE],
    periods,
  );
  if (!rowRange) return [];

  const sliceValues = sheet
    .getRange(rowRange.firstRow, 1, rowRange.lastRow - rowRange.firstRow + 1, lastColumnIndex)
    .getValues();

  const transactions = [];
  let skippedRowsCount = 0;

  sliceValues.forEach(function (dataRow) {
    const record = mapRowToRecord(dataRow, columnIndexByName);
    const occurredOn = toIsoDate(record[HEADER_DATE]);

    // Чужий місяць просто ігноруємо — він у смузі опинився
    // через запас на записи, додані заднім числом.
    if (occurredOn && periods.indexOf(occurredOn.slice(0, 7)) === -1) return;

    const amount = toPositiveNumber(record[HEADER_AMOUNT]);

    if (!amount || !occurredOn) {
      skippedRowsCount += 1;
      return;
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
  });

  if (skippedRowsCount > 0) {
    console.warn('Пропущено рядків без суми або дати: ' + skippedRowsCount);
  }

  return transactions;
}

/**
 * Знаходить смугу рядків, у якій лежать потрібні місяці.
 *
 * Читається тільки колонка з датою. Якщо дати в таблиці йдуть по
 * порядку (а це так для всього, що пише сам застосунок), усі рядки
 * потрібних місяців стоять поруч — і ми читаємо саме їх. Запас
 * з боків покриває записи, додані заднім числом.
 *
 * @param {Sheet} sheet
 * @param {number} lastRowIndex
 * @param {number | undefined} dateColumnIndex — індекс колонки з датою
 * @param {Array<string>} periods
 * @returns {{ firstRow: number, lastRow: number } | null}
 */
function findRowRangeByPeriods(sheet, lastRowIndex, dateColumnIndex, periods) {
  if (dateColumnIndex === undefined) return null;

  const dateValues = sheet.getRange(2, dateColumnIndex + 1, lastRowIndex - 1, 1).getValues();

  let firstMatchedRow = 0;
  let lastMatchedRow = 0;

  dateValues.forEach(function (dateRow, offset) {
    const isoDate = toIsoDate(dateRow[0]);
    if (!isoDate || periods.indexOf(isoDate.slice(0, 7)) === -1) return;

    if (firstMatchedRow === 0) firstMatchedRow = offset + 2;
    lastMatchedRow = offset + 2;
  });

  if (firstMatchedRow === 0) return null;

  return {
    firstRow: Math.max(2, firstMatchedRow - PERIOD_ROW_WINDOW_PADDING),
    lastRow: Math.min(lastRowIndex, lastMatchedRow + PERIOD_ROW_WINDOW_PADDING),
  };
}

/* ── Запис даних ─────────────────────────────────────────────────────────── */

/**
 * @param {object} payload — дані з форми; поле «Користувач» ігнорується
 * @param {BudgetUser} viewer — автентифікований користувач
 * @returns {object} створена або вже наявна операція
 */
function appendTransaction(payload, viewer) {
  if (!payload || typeof payload !== 'object') {
    throw new RequestError('Не передано дані операції', 'BAD_REQUEST');
  }

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

  // Тип приїмаємо лише два машинні значення. normalizeKind уміє
  // багато синонімів для читання з таблиці, але запит від клієнта
  // має бути однозначним: невідомий тип — помилка, а не витрата
  // за замовчуванням.
  const transactionKind = requireKnownKind(payload.kind);
  const transactionId = String(payload.id || '').trim() || Utilities.getUuid();
  const note = String(payload.note || '').trim().slice(0, 200);

  const transactionsSheet = getRequiredSheet(SHEET_TRANSACTIONS);
  const transactionsHeader = readSheetHeader(transactionsSheet);
  const indexByName = transactionsHeader.index;
  requireSheetColumns(SHEET_TRANSACTIONS, indexByName, REQUIRED_TRANSACTION_COLUMNS);

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
  const existingRowIndex = findTransactionRowIndexById(transactionsSheet, transactionId, indexByName);
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
  ], transactionsHeader);

  return createdTransaction;
}

/**
 * Шукає рядок операції за її ID.
 *
 * @param {Sheet} transactionsSheet
 * @param {string} transactionId
 * @param {Map<string, number>} indexByName - індекс шапки, уже прочитаний
 * @returns {number} номер рядка з одиниці або -1
 * @throws {RequestError} якщо немає колонки з ID: мовчки вважати її
 *   відсутньою означало б, що кожен повтор запиту пише дубль.
 */
function findTransactionRowIndexById(transactionsSheet, transactionId, indexByName) {
  const normalizedId = String(transactionId || '').trim();
  if (normalizedId === '') return -1;

  requireSheetColumns(SHEET_TRANSACTIONS, indexByName, [HEADER_ID]);

  const idColumnIndex = indexByName.get(HEADER_ID.toLowerCase());

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
 * Тип операції з запиту клієнта: лише 'expense' або 'income'.
 *
 * normalizeKind навмисно приймає багато синонімів — щоб читати
 * значення з таблиці очима. З клієнта ж приходить одне машинне
 * значення, і невідоме тут означає помилку, а не тихе
 * перетворення будь-чого на витрату.
 *
 * @param {unknown} rawValue
 * @returns {string} KIND_EXPENSE або KIND_INCOME
 * @throws {RequestError}
 */
function requireKnownKind(rawValue) {
  const normalizedValue = String(rawValue || '').trim().toLowerCase();

  if (normalizedValue === 'expense') return KIND_EXPENSE;
  if (normalizedValue === 'income') return KIND_INCOME;

  throw new RequestError(
    'Невідомий тип операції: ' + rawValue + '. Очікується expense або income.',
    'BAD_REQUEST',
  );
}

/**
 * @param {string} transactionId
 */
function deleteTransactionById(transactionId) {
  const normalizedId = String(transactionId || '').trim();
  if (normalizedId === '') {
    throw new RequestError('Не передано ID операції', 'BAD_REQUEST');
  }

  const transactionsSheet = getRequiredSheet(SHEET_TRANSACTIONS);
  const transactionsHeader = readSheetHeader(transactionsSheet);
  const indexByName = transactionsHeader.index;
  requireSheetColumns(SHEET_TRANSACTIONS, indexByName, REQUIRED_TRANSACTION_COLUMNS);
  const rowIndex = findTransactionRowIndexById(transactionsSheet, normalizedId, indexByName);

  if (rowIndex === -1) {
    throw new RequestError('Операцію з таким ID не знайдено', 'BAD_REQUEST');
  }

  transactionsSheet.deleteRow(rowIndex);
}

/* ── Допоміжні функції роботи з таблицею ────────────────────────────────── */

/**
 * Индекс колонок аркуша: підпис (у нижньому регістрі) -> позиція.
 *
 * Читає шапку рівно один раз. Кожен getValues() - це виклик до
 * Google, тому шапку треба брати один раз на аркуш, а не на кожну
 * назву колонки: інакше перевірка восьми колонок коштує восьми
 * однакових запитів.
 *
 * @param {Sheet} sheet
 * @returns {{ row: Array<unknown>, index: Map<string, number> }}
 */
function readSheetHeader(sheet) {
  return indexHeaderRow(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
}

/**
 * Те саме, але з уже прочитаного рядка шапки.
 *
 * @param {Array<unknown>} headerRow
 * @returns {{ row: Array<unknown>, index: Map<string, number> }}
 */
function indexHeaderRow(headerRow) {
  const indexByName = new Map();

  headerRow.forEach(function (columnName, columnIndex) {
    const normalizedName = String(columnName).trim().toLowerCase();
    if (normalizedName !== '' && !indexByName.has(normalizedName)) {
      indexByName.set(normalizedName, columnIndex);
    }
  });

  return { row: headerRow, index: indexByName };
}

/**
 * Падає, якщо в аркуші немає хоча б однієї з перелічених колонок.
 *
 * Нічого не читає: працює з індексом, який уже зібрано.
 * Перевіряє одразу всі відсутні, а не першу нестачу: щоб не
 * доводилося виправляти по одному стовпцю за три заходи.
 *
 * @param {string} sheetName
 * @param {Map<string, number>} indexByName
 * @param {Array<string>} columnNames
 * @throws {RequestError}
 */
function requireSheetColumns(sheetName, indexByName, columnNames) {
  const missingColumnNames = columnNames.filter(function (columnName) {
    return !indexByName.has(columnName.trim().toLowerCase());
  });

  if (missingColumnNames.length > 0) {
    throw new RequestError(
      'В аркуші ' + sheetName + ' немає стовпців: ' + missingColumnNames.join(', ') + '. ' +
      'Перейменуйте їх у шапці як у bootstrapSheets — сервер не читає старі схеми.',
      'SERVER_ERROR',
    );
  }
}

/**
 * Читає аркуш у вигляді масиву об'єктів за підписами колонок.
 * Порядок колонок не важливий — важливі лише їхні назви.
 *
 * @param {string} sheetName
 * @param {Array<string>} requiredColumnNames - перевіряються до читання
 * @returns {Array<Record<string, unknown>>}
 */
function readSheetAsRecords(sheetName, requiredColumnNames) {
  const optionalSheet = getOptionalSheet(sheetName);
  if (!optionalSheet) return [];

  if (requiredColumnNames) {
    // Шапку читаємо один раз і зразу використовуємо і для перевірки,
    // і для розкладання записів далі.
    requireSheetColumns(sheetName, readSheetHeader(optionalSheet).index, requiredColumnNames);
  }

  const lastRowIndex = optionalSheet.getLastRow();
  const lastColumnIndex = optionalSheet.getLastColumn();
  if (lastRowIndex < 2 || lastColumnIndex < 1) return [];

  const sheetValues = optionalSheet.getRange(1, 1, lastRowIndex, lastColumnIndex).getValues();
  const headerRow = sheetValues[0];
  const columnIndexByName = buildColumnIndex(headerRow);

  const dataRows = sheetValues.slice(1).filter(function (row) {
    return row.some(function (cellValue) {
      return String(cellValue).trim() !== '';
    });
  });

  return dataRows.map(function (dataRow) {
    return mapRowToRecord(dataRow, columnIndexByName);
  });
}

/**
 * Підписи колонок у індекси. Порядок стовпців у таблиці неважливий.
 *
 * @param {Array<unknown>} headerRow
 * @returns {Record<string, number>}
 */
function buildColumnIndex(headerRow) {
  const columnIndexByName = {};

  headerRow.forEach(function (columnName, columnIndex) {
    const normalizedName = String(columnName).trim();
    if (normalizedName !== '' && columnIndexByName[normalizedName] === undefined) {
      columnIndexByName[normalizedName] = columnIndex;
    }
  });

  return columnIndexByName;
}

/**
 * Розкладає один рядок за підписами колонок.
 *
 * @param {Array<unknown>} dataRow
 * @param {Record<string, number>} columnIndexByName
 * @returns {Record<string, unknown>}
 */
function mapRowToRecord(dataRow, columnIndexByName) {
  const record = {};

  for (const columnName in columnIndexByName) {
    record[columnName] = dataRow[columnIndexByName[columnName]];
  }

  return record;
}

/**
 * Додає рядок, попередньо переставивши значення відповідно
 * до підписів колонок у шапці.
 *
 * Значення передаються в порядку шапки, а розкладаються за
 * іменами колонок — тому порядок стовпців у таблиці неважливий.
 *
 * @param {Sheet} sheet
 * @param {Array<unknown>} orderedValues
 * @throws {Error} якщо якийсь підпис не знайдено: краще не записати
 *   нічого, ніж записати хеш не в те стовпці, а в сусіднє.
 */
function appendRowByColumnNames(sheet, orderedValues, header) {
  const headerRow = (header || readSheetHeader(sheet)).row;
  const knownColumns = header ? header.index : indexHeaderRow(headerRow).index;
  const valuesForSheetRow = new Array(headerRow.length).fill('');

  orderedValues.forEach(function (value, columnOffset) {
    const columnName = String(headerRow[columnOffset] || '').trim();
    const normalizedName = columnName.toLowerCase();
    const targetColumnIndex = knownColumns.has(normalizedName)
      ? knownColumns.get(normalizedName)
      : -1;

    if (targetColumnIndex < 0) {
      throw new Error(
        'У аркуші ' + sheet.getName() + ' немає стовпця «' + columnName +
        '». Нічого не записано — перевірте шапку.',
      );
    }

    valuesForSheetRow[targetColumnIndex] = value;
  });

  sheet.appendRow(valuesForSheetRow);
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

/**
 * Помилка запиту.
 *
 * Має два тексти:
 *   message       - що пішло не так. Йде в `error` відповіді й у журнал.
 *   displayMessage - що показати людині. Йде в `displayError`.
 *
 * Розділено для одного випадку: сервер може знати, що в таблиці
 * зламаний хеш користувача, але сказати про це тому, хто просто
 * намагається вгадати логін, не можна - інакше відповідь видає
 * перелік тих, хто тут зареєстрований. Деталі лишаються в error,
 * на екрані з'являється нейтральний текст.
 *
 * Якщо displayMessage не задано, показується те саме, що в error.
 */
class RequestError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ [key: string]: unknown }} [details] — додаткові поля відповіді
   * @param {string} [displayMessage]
   */
  constructor(message, code, details, displayMessage) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.details = details || {};
    this.displayMessage = displayMessage || message;
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
 * Формат помилки:
 *   error        - для журналу й розробника
 *   displayError - те, що показує сторінка
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
      displayError: isExpectedError
        ? error.displayMessage
        : 'Сервер не зміг виконати запит. Спробуйте пізніше.',
    },
    isExpectedError ? error.details : {},
  ));
}
