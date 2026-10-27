/*
 * Code.gs — server-side of MoneyFlow.
 *
 * Responsible for three things:
 *   doPost(action=loadSnapshot)     — returns a budget snapshot;
 *   doPost(action=addTransaction)   — adds a transaction;
 *   doPost(action=deleteTransaction)— deletes a transaction.
 *   doPost(action=updateTransaction)— overwrites a transaction in place.
 *
 * Authorization and sessions — in auth.gs: the password doesn't leave the browser,
* and the browser only stores the server-signed token.
*
* IMPORTANT for deployment:
*   Execute as:  Me (owner)
*   Who has access: Anyone
* This configuration doesn't require OAuth from the visitor — that's why
* the request from the browser passes without additional steps.
*
* No dependencies. Copied into the Apps Script editor as is.
 */

/* ── Sheet names (must match the labels in the table) ────────────────── */

const SHEET_TRANSACTIONS = 'Transactions';
const SHEET_CATEGORIES = 'Categories';
const SHEET_BUDGET_LIMITS = 'BudgetLimits';
const SHEET_USERS = 'Users';
const SHEET_GOALS = 'Goals';

/**
 * Timezone for all dates and times.
 *
 * One line instead of three literals: if the zone changes, it changes
* in one place, not three, and some are fixed, while the two others are not.
 */
const TIMEZONE = 'Europe/Kyiv';

const HEADER_ID = 'ID';
const HEADER_DATE = 'Дата';
const HEADER_CATEGORY = 'Категорія';
const HEADER_AMOUNT = 'Сума';
const HEADER_USER = 'Користувач';
const HEADER_NOTE = 'Нотатка';
const HEADER_RECORDED_AT = 'Записано';

const HEADER_CATEGORY_NAME = 'Назва';
const HEADER_CATEGORY_ICON = 'Іконка';
const HEADER_CATEGORY_COLOR = 'Колір';
const HEADER_CATEGORY_ACTIVE = 'Активна';

const HEADER_LIMIT_PERIOD = 'Місяць';
const HEADER_LIMIT_CATEGORY = 'Категорія';
const HEADER_LIMIT_AMOUNT = 'Ліміт, ₴';

const HEADER_USER_NAME = 'Ім\'я';
const HEADER_USER_COLOR = 'Колір';
const HEADER_USER_PASSWORD_HASH = 'Пароль';
const HEADER_USER_ACTIVE = 'Активний';

const HEADER_GOAL_ID = 'ID';
const HEADER_GOAL_NAME = 'Назва';
const HEADER_GOAL_TARGET_AMOUNT = 'Цільова сума';
const HEADER_GOAL_CURRENT_AMOUNT = 'Поточна сума';
const HEADER_GOAL_DEADLINE = 'Дедлайн';
const HEADER_GOAL_BEGIN_DATE = 'Початок';
const HEADER_GOAL_TYPE = 'Тип';
const HEADER_GOAL_ACTIVE = 'Активна';

/*
 * Columns without which the sheet makes no sense.
 *
 * The project has no backward compatibility, so the "old scheme" is not supported.
* Instead, every change must fail immediately and loudly: if
* someone renames a column, it's better to have an explicit error in the log than
* a budget that silently shows zeros. This is how we almost
* lost data three times already.
 */
const REQUIRED_TRANSACTION_COLUMNS = [
  HEADER_ID, HEADER_DATE, HEADER_CATEGORY,
  HEADER_AMOUNT, HEADER_USER, HEADER_NOTE, HEADER_RECORDED_AT,
];

const REQUIRED_CATEGORY_COLUMNS = [
  HEADER_CATEGORY_NAME, HEADER_CATEGORY_ICON, HEADER_CATEGORY_COLOR, HEADER_CATEGORY_ACTIVE,
];

const REQUIRED_LIMIT_COLUMNS = [
  HEADER_LIMIT_PERIOD, HEADER_LIMIT_CATEGORY, HEADER_LIMIT_AMOUNT,
];

/*
 * How many months are allowed to be requested in one request.
 *
 * The client sends exactly the months it already has in memory, so
* the server snapshot doesn't wipe out the rest. The limit prevents
* the client from pulling the entire sheet in one request.
 */
const MAX_PERIODS_PER_REQUEST = 12;

/*
 * Padding rows from each side of the required range.
 *
 * Dates in the table usually go in order (which is true for everything that the app itself writes) -
* all required months' rows stand next to each other — and we read exactly that. Padding covers
* entries added with a backdate.
 */
const PERIOD_ROW_WINDOW_PADDING = 60;

const REQUIRED_USER_COLUMNS = [
  HEADER_USER_NAME, HEADER_USER_COLOR, HEADER_USER_PASSWORD_HASH, HEADER_USER_ACTIVE,
];

const REQUIRED_GOAL_COLUMNS = [
  HEADER_GOAL_ID, HEADER_GOAL_NAME, HEADER_GOAL_TARGET_AMOUNT, HEADER_GOAL_CURRENT_AMOUNT,
  HEADER_GOAL_DEADLINE, HEADER_GOAL_BEGIN_DATE, HEADER_GOAL_TYPE, HEADER_GOAL_ACTIVE,
];

/* ── Independent Registration ──────────────────────────────────────────────── */

/**
 * Anyone who knows the Web App address can send a request.
 * To prevent open registration or spam, we set limits:
* they are higher than necessary for a normal family, but lower than the level
* of "script flooding the table."
 */
const MAX_TOTAL_USERS = 10;
const MAX_PENDING_USERS = 3;

const FLAG_ACTIVE = 'Так';
const FLAG_INACTIVE = 'Ні';

/** Palette for random avatars. */
const USER_AVATAR_COLORS = [
  '#2563eb', '#db2777', '#0f9d58', '#d97706',
  '#0891b2', '#7c3aed', '#65a30d', '#4f46e5',
];

/* ── Entry Point ─────────────────────────────────────────────────────────── */

/**
 * Single entry point for all actions: routing by the `action` field.
 *
 * No separate doGet is intentionally omitted — the token must not end up in the URL,
* because the URL ends up in server logs, browser history, and Referer.
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

    // Two actions without session: password login and registration. Otherwise
    // establishing an account or getting a session would be impossible.
    if (payload.action === 'requestRegistration') {
      return respondWithJson(Object.assign({ ok: true }, createPendingUser(payload)));
    }

    if (payload.action === 'authenticate') {
      return respondWithJson(Object.assign({ ok: true }, authenticateByCredentials(payload)));
    }

    const viewer = authenticateSession(payload.sessionToken);
    const periods = parsePeriodsList(payload.periods);
    const limitPeriod = parseLimitPeriod(payload.limitPeriod);

    switch (payload.action) {
      case 'loadSnapshot':
        return respondWithJson(Object.assign({ ok: true }, buildSnapshot(viewer, periods, limitPeriod)));

      case 'addTransaction':
        return respondWithJson({
          ok: true,
          transaction: appendTransaction(payload.transaction, viewer),
          // Return updated data immediately: otherwise the client
          // would have to make a second request and wait another ~3 seconds.
          snapshot: buildSnapshot(viewer, periods, limitPeriod),
        });

      case 'deleteTransaction':
        deleteTransactionById(payload.transactionId);
        return respondWithJson({
          ok: true,
          deletedId: String(payload.transactionId || '').trim(),
          snapshot: buildSnapshot(viewer, periods, limitPeriod),
        });

      case 'updateTransaction':
        return respondWithJson({
          ok: true,
          transaction: updateTransaction(payload.transaction, viewer),
          snapshot: buildSnapshot(viewer, periods, limitPeriod),
        });

      case 'fetchGoals':
        return respondWithJson({
          ok: true,
          goals: fetchGoals(viewer, periods),
        });

      case 'adjustGoal':
        return respondWithJson({
          ok: true,
          goal: adjustGoal(payload, viewer),
        });

      default:
        throw new RequestError('Невідома дія: ' + payload.action, 'BAD_REQUEST');
    }
  } catch (error) {
    return respondWithError(error);
  }
}

/**
 * Month for which the client wants to see the budget.
 *
 * This is always ONE month — the one open on the screen. Why separately
* from `periods`: the request is sent at least for two months (open and
* previous, for comparison), and the client holds only one array
* of categories. If limits from both months are taken, then the October limit
* would be shown in September, where it was not set.
 *
 * Not valid or missing value — no error: show the current
* month. It's only a number on the screen, not data.
 *
 * @param {unknown} rawValue
 * @returns {string}
 */
function parseLimitPeriod(rawValue) {
  return toPeriodKey(rawValue) || currentPeriodKey();
}

/**
 * Key of the current month in the script's timezone.
 * @returns {string}
 */
function currentPeriodKey() {
  const now = new Date();
  const monthNumber = now.getMonth() + 1;
  const month = monthNumber < 10 ? '0' + monthNumber : String(monthNumber);
  return now.getFullYear() + '-' + month;
}

/**
 * Validates the list of months from the request.
 *
 * The client requests exactly the months it already has in memory: so
* the server snapshot replaces them and doesn't touch the rest. If the list
* is empty or didn't arrive — we take the current month, so that the
* client, which doesn't know how to send `periods` yet, gets at least
* something meaningful, and not an empty table.
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
 * Budget snapshot for a specific user and a set of months.
*
* Returns only the requested months — on five-year history this is
* two dozen kilobytes instead of two megabytes. The client knows which
* months arrived and replaces its own; the rest is not touched.
*
* @param {BudgetUser} viewer
*   @param {Array<string>} periods — transactions for these months
*   @param {string} limitPeriod — limits for exactly this month
*   @returns {{ serverTime: string, viewer: object, categories: Array<object>, periods: Array<string>, transactions: Array<object> }}
 */
function buildSnapshot(viewer, periods, limitPeriod) {
  return {
    serverTime: new Date().toISOString(),
    viewer: { name: viewer.name, color: viewer.color },
    categories: readCategoriesWithLimits([limitPeriod]),
    periods: periods,
    transactions: readTransactions(periods),
    goals: fetchGoals(viewer, periods)
  };
}

/* ── Authorization ─────────────────────────────────────────────────────────── */

/**
 * @typedef {{ name: string, color: string, passwordHash: string, isActive: boolean }} BudgetUser
 */

/**
 * Core of sessions: token verification and user search.
* The password does not arrive on the server in any request - only the token.
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

  // Activity is checked every time, so a disabled user
  // is blocked instantly, and not at the end of the token term.
  if (!user.isActive) {
    throw new RequestError('Акаунт деактивовано', 'UNAUTHORIZED');
  }

  // Token issued before the password change is no longer accepted.
  const loginState = readLoginState()[user.name] || {};
  const credentialsChangedAtMs = loginState.credentialsChangedAtMs || 0;

  if (tokenPayload.issuedAt < credentialsChangedAtMs) {
    throw new RequestError('Пароль змінено. Увійдіть знову.', 'UNAUTHORIZED');
  }

  return user;
}

/**
 * Creates a user application. The password is nowhere stored -
* only its hash. The account is immediately inactive: login can only be
* by the one who has access to the table and enabled the row.
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
 * Is this a SHA-256 hash in hex representation.
*
* The only check the server can do with the password during registration:
* the password itself doesn't arrive here — the hash is already provided.
*
* @param {string} value
* @returns {boolean}
 */
function isSha256Hex(value) {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Enables or disables an existing user.
*
* Often run manually from the editor, but more often simply by changing
* the "Active" cell in the table itself.
*
*   setUserActive('Оля', true);
*
* @param {string} userName
* @param {boolean} isActive
* @return {string} result message
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
 * Reads the Users sheet.
*
* Without the "Active" column, it's impossible to know who is already enabled,
* and who just registered. Without "Password" — there's nothing to compare
* the login proof with. In both cases, we fail immediately and loudly: a silent
* failure here would look like "wrong password", and the person would look for
* the problem in their own head.
*
* What concerns the HASH — consciously not checked here. Earlier it threw
* an error with the name of the user whose hash was incorrect, and it leaked
* out: a login attempt under another's login would return "user Test has incorrect hash"
* and thus reveal that such a user exists. Now a broken hash doesn't stop entry
* for anyone, and one can find out about it through checkUsersIntegrity().
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
 * Checks the integrity of the Users sheet and enumerates everything that's broken.
*
*   checkUsersIntegrity();
*
* A separate function, and not a check in readUsers, for security reasons:
* details about specific people cannot be given to someone who is simply
* trying to guess a login.
*
* @return {string} report, visible in the editor output
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

/** @returns {string} avatar color from the palette */
function pickRandomAvatarColor() {
  const randomIndex = Math.floor(Math.random() * USER_AVATAR_COLORS.length);
  return USER_AVATAR_COLORS[randomIndex];
}

/**
 * Appends a person to the Users sheet along with the password hash.
*
* This is not server-side logic - this function is run manually from the editor
* of Apps Script, when a new user appears in the family:
*
*   registerUser('Оля', '#7c3aed', 'Grivna-2026');
*
* @param {string} userName — the login, by which the user logs in
* @param {string} userColor — avatar color, hex
* @param {string} userPassword — the password this person enters on the site
* @return {string} result message (visible in the output)
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

  return 'Користувач «' + trimmedName + '» доданий.';
}

/**
 * Replaces the password of an already registered person.
*
* Old sessions will stop working: authenticateSession
* compares the issuance time of the token with the time of the password change.
*
* Also run manually from the editor:
*
*   resetUserPassword('Оля', 'Nova-Parily-2026');
*
* @param {string} userName
* @param {string} newPassword
* @return {string} result message
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
  return result;
}

/**
 * Deletes a person from the Users sheet. They will no longer be able to log in,
* and all their past history remains in Transactions.
*
*   removeUser('Оля');
*
* @param {string} userName
* @return {string} result message
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

  throw new Error('Користувача «' + trimmedName + '» не знайдено');
}

/* ── Reading data ──────────────────────────────────────────────────────── */

/**
 * Category limits for the specified months, in the form "category → amount".
*
* The first match for the pair "month + category" is taken: if the row
* was accidentally duplicated, the same category will not enter the budget twice.
*
* @param {Array<string>} periods — keys "YYYY-MM"
* @returns {Map<string, number>}
 */
function readBudgetLimitsByCategory(periods) {
  const limitsByCategoryName = new Map();

  for (const record of readSheetAsRecords(SHEET_BUDGET_LIMITS, REQUIRED_LIMIT_COLUMNS)) {
    const rawPeriod = record[HEADER_LIMIT_PERIOD];
    const rawPeriodText = String(rawPeriod === undefined || rawPeriod === null ? '' : rawPeriod).trim();
    if (rawPeriodText === '') continue;

    const period = toPeriodKey(rawPeriod);

    // Person wrote something in the month, and it failed to be read. Silently
    // skipping such a row would mean "Budget = 0" without any
    // hint — exactly what we avoid here.
    if (!period) {
      throw new RequestError(
        'У аркуші ' + SHEET_BUDGET_LIMITS + ' не вдалося прочитати місяць у значенні ' +
        '«' + rawPeriodText + '». Очікується «2026-10» текстом або дата 01.10.2026.',
        'SERVER_ERROR',
      );
    }

    const categoryName = String(record[HEADER_LIMIT_CATEGORY] || '').trim();
    const limit = toPositiveNumber(record[HEADER_LIMIT_AMOUNT]);

    if (!categoryName || !limit) continue;
    if (periods.indexOf(period) === -1) continue;
    if (limitsByCategoryName.has(categoryName)) continue;

    limitsByCategoryName.set(categoryName, limit);
  }

  return limitsByCategoryName;
}

/**
 * Category catalog with limits for the required months.
*
* A category without a row in `BudgetLimits` remains in the catalog without a limit:
* it is available for entering expenses, but it does not enter the budget.
*
* @param {Array<string>} periods — keys "YYYY-MM"
* @returns {Array<object>}
* @throws {RequestError} if there is a limit for an unknown category
 */
function readCategoriesWithLimits(periods) {
  const categories = readCategories();
  const limitsByCategoryName = readBudgetLimitsByCategory(periods);

  for (const categoryName of limitsByCategoryName.keys()) {
    if (categories.some((category) => category.name === categoryName)) continue;

    throw new RequestError(
      'Є ліміт для категорії «' + categoryName + '», але такої категорії в аркуші ' +
      SHEET_CATEGORIES + ' немає. Перейменуйте її в обох аркушах або видаліть зайвий ' +
      'рядок — інакше бюджет рахуватиметься неправильно.',
      'SERVER_ERROR',
    );
  }

  return categories.map(function (category) {
    return Object.assign({}, category, { limit: limitsByCategoryName.get(category.name) ?? 0 });
  });
}

/**
 * Category catalog — without limits.
*
* Limits live in a separate sheet, because they belong to the month, not the
* category. Therefore, only what doesn't change is here: name, icon,
* color and the activity flag.
*
* @returns {Array<{ name: string, icon: string, color: string, isActive: string }>}
 */
function readCategories() {
  return readSheetAsRecords(SHEET_CATEGORIES, REQUIRED_CATEGORY_COLUMNS)
    .map(function (record, index) {
      return {
        name: String(record[HEADER_CATEGORY_NAME] || '').trim(),
        icon: String(record[HEADER_CATEGORY_ICON] || '•').trim(),
        color: String(record[HEADER_CATEGORY_COLOR] || '#8b95a8').trim(),
        isActive: record[HEADER_CATEGORY_ACTIVE] === undefined
          ? ''
          : String(record[HEADER_CATEGORY_ACTIVE]).trim(),
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
 * Transactions for only the specified months.
*
* The sheet is not read completely. First, one column with the date — in eight
* times fewer cells than all columns, - to find the boundaries of the required
* months. Then only the row range between them is read.
*
* @param {Array<string>} periods — keys "YYYY-MM"
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
    const occurredOn = toIsoDateTime(record[HEADER_DATE]);

    // A transaction from another month is just ignored — it ended up in the range
    // due to the padding for entries added with a backdate.
    if (occurredOn && periods.indexOf(occurredOn.slice(0, 7)) === -1) return;

    const amount = toPositiveNumber(record[HEADER_AMOUNT]);

    if (!amount || !occurredOn) {
      skippedRowsCount += 1;
      return;
    }

    transactions.push({
      id: String(record[HEADER_ID] || '').trim() || Utilities.getUuid(),
      occurredOn: occurredOn,
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
 * Finds the row range where the required months are located.
*
* Only the date column is read. If the dates in the table go in
* order (which is true for everything that the app itself writes), all rows
* of the required months stand next to each other — and we read exactly them. Padding
* from the sides covers entries added with a backdate.
*
 * @param {Sheet} sheet
* @param {number} lastRowIndex
* @param {number | undefined} dateColumnIndex — the index of the date column
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

/* ── Writing data ─────────────────────────────────────────────────────────── */

/**
 * @param {object} payload — form data; the "User" field is ignored
* @param {BudgetUser} viewer — authenticated user
* @returns {object} created or already present transaction
 */
function appendTransaction(payload, viewer) {
  if (!payload || typeof payload !== 'object') {
    throw new RequestError('Не передано дані операції', 'BAD_REQUEST');
  }

  const amount = toPositiveNumber(payload.amount);
  const occurredOn = toIsoDateTime(payload.occurredOn);

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
  const note = String(payload.note || '').trim().slice(0, 200);

  const transactionsSheet = getRequiredSheet(SHEET_TRANSACTIONS);
  const transactionsHeader = readSheetHeader(transactionsSheet);
  const indexByName = transactionsHeader.index;
  requireSheetColumns(SHEET_TRANSACTIONS, indexByName, REQUIRED_TRANSACTION_COLUMNS);

  const createdTransaction = {
    id: transactionId,
    occurredOn: occurredOn,
    category: categoryName,
    amount: amount,
    user: viewer.name,
    note: note,
    recordedAt: new Date().toISOString(),
  };

  // The client generates the ID beforehand. If the request arrives twice — after
  // a connection break and re-sending from the queue — we don't duplicate
  // the row, but return what was already saved.
  const existingRowIndex = findTransactionRowIndexById(transactionsSheet, transactionId, indexByName);
  if (existingRowIndex !== -1) {
    return createdTransaction;
  }

  // The order of values repeats the Transactions header, where there is no
  // longer a "Type" column: income is not entered.
  appendRowByColumnNames(transactionsSheet, [
    transactionId,
    occurredOn,
    categoryName,
    amount,
    viewer.name,
    note,
    new Date(),
  ], transactionsHeader);

  return createdTransaction;
}

/**
 * Finds the transaction row by its ID.
*
* @param {Sheet} transactionsSheet
* @param {string} transactionId
* @param {Map<string, number>} indexByName - header index, already read
* @returns {number} row number from one or -1
* @throws {RequestError} if the ID column is missing: silently assuming it's
*   missing would mean every repeat request writes a duplicate.
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
 * @param {string} transactionId
 * */
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

/**
 * Updates an existing transaction.
*
* Rules that distinguish it from addition:
*
*   ID does not change - by it the entry is already identified in the table;
*   "User" does not change - the transaction was made by the person who
*     made the expense, even if the date was corrected by someone else;
*   "RecordedAt" is overwritten - this is the time of the last entry about the row.
*
* @param {object} payload
* @returns {object} updated transaction
 */
function updateTransaction(payload, viewer) {
  if (!payload || typeof payload !== 'object') {
    throw new RequestError('Не передано дані операції', 'BAD_REQUEST');
  }

  const transactionId = String(payload.id || '').trim();
  if (transactionId === '') {
    throw new RequestError('Не передано ID операції', 'BAD_REQUEST');
  }

  const amount = toPositiveNumber(payload.amount);
  const occurredOn = toIsoDateTime(payload.occurredOn);

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

  const note = String(payload.note || '').trim().slice(0, 200);

  const transactionsSheet = getRequiredSheet(SHEET_TRANSACTIONS);
  const transactionsHeader = readSheetHeader(transactionsSheet);
  const indexByName = transactionsHeader.index;
  requireSheetColumns(SHEET_TRANSACTIONS, indexByName, REQUIRED_TRANSACTION_COLUMNS);

  const rowIndex = findTransactionRowIndexById(transactionsSheet, transactionId, indexByName);
  if (rowIndex === -1) {
    throw new RequestError('Операцію з таким ID не знайдено', 'BAD_REQUEST');
  }

  const occurredOnColumnIndex = indexByName.get(HEADER_DATE.toLowerCase());
  const categoryColumnIndex = indexByName.get(HEADER_CATEGORY.toLowerCase());
  const amountColumnIndex = indexByName.get(HEADER_AMOUNT.toLowerCase());
  const userColumnIndex = indexByName.get(HEADER_USER.toLowerCase());
  const noteColumnIndex = indexByName.get(HEADER_NOTE.toLowerCase());
  const recordedAtColumnIndex = indexByName.get(HEADER_RECORDED_AT.toLowerCase());

  transactionsSheet.getRange(rowIndex, occurredOnColumnIndex + 1, 1, 1).setValue(occurredOn);
  transactionsSheet.getRange(rowIndex, categoryColumnIndex + 1, 1, 1).setValue(categoryName);
  transactionsSheet.getRange(rowIndex, amountColumnIndex + 1, 1, 1).setValue(amount);
  transactionsSheet.getRange(rowIndex, noteColumnIndex + 1, 1, 1).setValue(note);
  transactionsSheet.getRange(rowIndex, recordedAtColumnIndex + 1, 1, 1).setValue(new Date());

  // User is not overwritten, so in the response we return what
  // actually remained in the row. Echo from payload would be a lie: the client
  // could have sent any name, and the server ignored it anyway.
  const storedUser = String(
    transactionsSheet.getRange(rowIndex, userColumnIndex + 1, 1, 1).getValue() ?? '',
  ).trim();

  return {
    id: transactionId,
    occurredOn: occurredOn,
    category: categoryName,
    amount: amount,
    user: storedUser,
    note: note,
    recordedAt: new Date().toISOString(),
  };
}

/* ── Helper functions for table work ────────────────────────────────────────── */

/**
 * Column index of the sheet: label (in lowercase) -> position.
*
* Reads the header exactly once. Every getValues() - is a call to
* Google, so the header should be taken once per sheet, and not for
* every column name: otherwise checking eight columns would cost eight
* identical requests.
*
* @param {Sheet} sheet
* @returns {{ row: Array<unknown>, index: Map<string, number> }}
 */
function readSheetHeader(sheet) {
  return indexHeaderRow(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
}

/**
 * The same, but from an already read header row.
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
 * Fails if the sheet is missing at least one of the listed columns.
*
* Does not read anything: works with the index that is already collected.
* Checks all missing ones at once, and not the first deficiency: so that it
* doesn't have to correct one column at a time for three turns.
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
 * Reads a sheet as an array of objects by column names.
* Order of columns does not matter — only their names matter.
*
* @param {string} sheetName
* @param {Array<string>} requiredColumnNames - checked before reading
* @returns {Array<Record<string, unknown>>}
 */
function readSheetAsRecords(sheetName, requiredColumnNames) {
  const optionalSheet = getOptionalSheet(sheetName);
  if (!optionalSheet) return [];

  if (requiredColumnNames) {
    // Header is read once and immediately used both for checking,
    // and for parsing records further.
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
 * Column names to indices. Order of columns in the table is not important.
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
 * Parses one row by column names.
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
 * Appends a row, pre-reordering values according to
* the column names in the header.
*
* Values are passed in header order, and are parsed by
* column names — so the order of columns in the table is not important.
*
* @param {Sheet} sheet
* @param {Array<unknown>} orderedValues
* @throws {Error} if some label is not found: better not write
*   anything, than write a hash not in the column, but in the neighboring.
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

/* ── Value Conversion ────────────────────────────────────────────────── */

/**
 * @param {unknown} rawValue
 * @returns {number} 0, if the value is not a positive number
 */
function toPositiveNumber(rawValue) {
  const parsedValue = Number(rawValue);
  if (!isFinite(parsedValue) || parsedValue <= 0) return 0;
  return Math.round(parsedValue * 100) / 100;
}

/**
 * Month key «YYYY-MM» from any format it might have been entered in.
 *
 * Google Sheets turns «2026-10» into a date if the column is not
 * відформатована як текст. Тоді в таблицю приходить об'єкт Date, а
 * String() з нього дає «Mon Oct 01 2026…» — ключ не збігається
 * ні з чим, і рядок непомітно випадає з бюджету.
 *
 * Тому приймаємо три вигляди: об'єкт Date, «2026-10» і «2026-10-01».
 *
 * @param {unknown} rawValue
 * @returns {string} «2026-10» або порожній рядок, якщо розібрати не вдалося
 */
function toPeriodKey(rawValue) {
  if (Object.prototype.toString.call(rawValue) === '[object Date]') {
    return Utilities.formatDate(rawValue, TIMEZONE, 'yyyy-MM');
  }

  const textValue = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim();
  const periodMatch = textValue.match(/^(\d{4})-(\d{2})(?:-\d{2})?/);
  if (!periodMatch) return '';

  const monthNumber = Number(periodMatch[2]);
  if (monthNumber < 1 || monthNumber > 12) return '';

  return periodMatch[1] + '-' + periodMatch[2];
}

/**
 * Приймає «2026-10-05», «2026-10-05T14:30», дату з таблиці або
 * ISO-рядок — і повертає той самий вигляд.
 *
 * Час не вигадується: якщо його немає, результат лишається без
 * часу. Запис, внесений тиждень тому без часу, інакше показував би
 * час того тижня, коли його читали, — і виглядав би щойно доданим.
 *
 * @param {unknown} rawValue
 * @returns {string} «2026-10-05T14:30», «2026-10-05» або порожній рядок
 */
function toIsoDateTime(rawValue) {
  // Об'єкт Date зустрічається лише в клітинках, куди хтось вписав
  // дату руками: Sheets розпізнав її як справжню дату, а не текст.
  if (Object.prototype.toString.call(rawValue) === '[object Date]') {
    return Utilities.formatDate(rawValue, TIMEZONE, "yyyy-MM-dd'T'HH:mm");
  }

  const datePart = toIsoDate(rawValue);
  if (!datePart) return '';

  const timeMatch = String(rawValue || '').trim()
    .match(/\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);

  return timeMatch ? datePart + 'T' + timeMatch[1] + ':' + timeMatch[2] : datePart;
}

/**
 * Приймає «2026-10-05», дату з таблиці або ISO-рядок.
 * @param {unknown} rawValue
 * @returns {string} «2026-10-05» або порожній рядок
 */
function toIsoDate(rawValue) {
  if (Object.prototype.toString.call(rawValue) === '[object Date]') {
    return Utilities.formatDate(rawValue, TIMEZONE, 'yyyy-MM-dd');
  }

  const textValue = String(rawValue || '').trim();
  if (textValue === '') return '';

  const isoDateMatch = textValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDateMatch) return isoDateMatch[0];

  const parsedDate = new Date(textValue);
  if (isNaN(parsedDate.getTime())) return '';

  return Utilities.formatDate(parsedDate, TIMEZONE, 'yyyy-MM-dd');
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
      error: error instanceof Error ? error.message : String(error),
      displayError: isExpectedError
        ? error.displayMessage
        : 'Сервер не зміг виконати запит. Спробуйте пізніше.',
    },
    isExpectedError ? error.details : {},
  ));
}

/* ── Helper functions for goal calculations ────────────────────────────────────────── */

/**
 * Calculates the progress percentage of a goal.
 *
 * @param {number} currentAmount — поточна сума
 * @param {number} targetAmount — цільова сума
 * @returns {number} відсоток від 0 до 100
 */
function calculateGoalProgress(currentAmount, targetAmount) {
  if (targetAmount <= 0) return 100;
  const progress = (currentAmount / targetAmount) * 100;
  return Math.min(100, Math.max(0, Math.round(progress)));
}

/**
 * Calculates the monthly amount to be saved to reach a goal by the deadline.
 * 
 * Logic:
 * 1. Start of accumulation = Max(begindate, now) — if the start date has passed, we start now
 * 2. Count months from the start of accumulation to the deadline (not from beginDate)
 * 3. If the deadline has already passed — return 0
 *
 * @param {number} currentAmount — поточна сума
 * @param {number} targetAmount — цільова сума
 * @param {string} beginDate — дата початку (РРРР-ММ-ДД)
 * @param {string} deadline — дата дедлайну (РРРР-ММ-ДД)
 * @returns {number} monthly amount, or 0 if the deadline has passed or the goal is reached
 */
function calculateMonthlyRequirement(currentAmount, targetAmount, beginDate, deadline) {
  const start = new Date(beginDate);
  const end = new Date(deadline);
  const now = new Date();

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  if (currentAmount >= targetAmount) return 0;

  // Start of accumulation = Max(begindate, now) — if the start date has passed, we start now
  const actualStart = start > now ? start : now;
  
  // If the deadline has already passed — return 0
  if (end < now) return 0;

  const remainingAmount = targetAmount - currentAmount;
  
  // Count months from the start of accumulation to the deadline
  const monthsDiff = (end.getFullYear() - actualStart.getFullYear()) * 12 + 
                     (end.getMonth() - actualStart.getMonth());
  
  // If months < 1 — calculate as for 1 month
  const divisor = Math.max(1, monthsDiff);
  
  return Math.round(remainingAmount / divisor);
}

/* ── API функції для цілей ────────────────────────────────────────────────────── */

/**
 * Retrieves the list of active goals for the user.
 *
 * @param {BudgetUser} viewer
 * @param {Array<string>} periods — ключі «РРРР-ММ» (не використовується, але зберігаємо для сумісності)
 * @returns {Array<object>} список цілей з розрахунками прогресу та щомісячної суми
 */
function fetchGoals(viewer, periods) {
  const sheet = getRequiredSheet(SHEET_GOALS);
  const records = readSheetAsRecords(SHEET_GOALS, REQUIRED_GOAL_COLUMNS);
  
  return records
    .filter(function (record) {
      return isTruthyFlag(record[HEADER_GOAL_ACTIVE]);
    })
    .map(function (record) {
      const current = toPositiveNumber(record[HEADER_GOAL_CURRENT_AMOUNT]);
      const target = toPositiveNumber(record[HEADER_GOAL_TARGET_AMOUNT]);
      const begin = toIsoDate(record[HEADER_GOAL_BEGIN_DATE]);
      const deadline = toIsoDate(record[HEADER_GOAL_DEADLINE]);

      return {
        id: String(record[HEADER_GOAL_ID] || '').trim(),
        name: String(record[HEADER_GOAL_NAME] || '').trim(),
        deadline: deadline,
        type: String(record[HEADER_GOAL_TYPE] || '').trim(),
        active: isTruthyFlag(record[HEADER_GOAL_ACTIVE]),
        progress: calculateGoalProgress(current, target),
        monthlyRequirement: calculateMonthlyRequirement(current, target, begin, deadline),
      };
    });
}

/**
 * Adjusts the current amount of a goal (adds or subtracts).
 *
 * @param {object} payload — { id, amount }
 * @param {BudgetUser} viewer
 * @returns {object} оновлена ціль
 */
function adjustGoal(payload, viewer) {
  const sheet = getRequiredSheet(SHEET_GOALS);
  const indexByName = readSheetHeader(sheet).index;
  const idColumnIndex = indexByName.get(HEADER_GOAL_ID.toLowerCase());
  const currentColumnIndex = indexByName.get(HEADER_GOAL_CURRENT_AMOUNT.toLowerCase());
  const beginColumnIndex = indexByName.get(HEADER_GOAL_BEGIN_DATE.toLowerCase());
  
  const rowIndex = findGoalRowIndexById(sheet, payload.id, indexByName);
  if (rowIndex === -1) {
    throw new RequestError('Ціль з таким ID не знайдено', 'BAD_REQUEST');
  }

  const currentAmount = toPositiveNumber(sheet.getRange(rowIndex, currentColumnIndex + 1).getValue());
  const adjustment = Number(payload.amount) || 0;
  const newAmount = Math.max(0, currentAmount + adjustment);

  sheet.getRange(rowIndex, currentColumnIndex + 1).setValue(newAmount);

  const updatedCurrent = toPositiveNumber(sheet.getRange(rowIndex, currentColumnIndex + 1).getValue());
  const target = toPositiveNumber(sheet.getRange(rowIndex, indexByName.get(HEADER_GOAL_TARGET_AMOUNT.toLowerCase()) + 1).getValue());
  const begin = toIsoDate(sheet.getRange(rowIndex, beginColumnIndex + 1).getValue());
  const deadline = toIsoDate(sheet.getRange(rowIndex, indexByName.get(HEADER_GOAL_DEADLINE.toLowerCase()) + 1).getValue());

  return {
    id: payload.id,
    progress: calculateGoalProgress(updatedCurrent, target),
    monthlyRequirement: calculateMonthlyRequirement(updatedCurrent, target, begin, deadline),
  };
}

/**
 * Finds the index of the goal row by its ID.
 *
 * @param {Sheet} sheet
 * @param {string} id
 * @param {Map<string, number>} indexByName
 * @returns {number} номер рядка або -1
 */
function findGoalRowIndexById(sheet, id, indexByName) {
  const normalizedId = String(id || '').trim();
  if (normalizedId === '') return -1;

  const lastRowIndex = sheet.getLastRow();
  if (lastRowIndex < 2) return -1;

  const idColumnIndex = indexByName.get(HEADER_GOAL_ID.toLowerCase());
  const idValues = sheet.getRange(2, idColumnIndex + 1, lastRowIndex - 1, 1).getValues();

  for (let i = 0; i < idValues.length; i++) {
    if (String(idValues[i][0]).trim() === normalizedId) return i + 2;
  }

  return -1;
}
