/*
 * Code.gs — server-side of MoneyFlow.
 *
 * Actions:
 *   doPost(action=loadSnapshot)       — returns a budget snapshot;
 *   doPost(action=fetchGoals)         — goals with their change history;
 *   doPost(action=submitTransactions) — applies queued user transactions
 *                                       (expenses, goal changes).
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

const SHEET_EXPENSES = 'Expenses';
const SHEET_TRANSACTIONS = 'Transactions';
const SHEET_CATEGORIES = 'Categories';
const SHEET_BUDGET_LIMITS = 'BudgetLimits';
const SHEET_USERS = 'Users';
const SHEET_GOALS = 'Goals';
const SHEET_GOAL_HISTORY = 'GoalHistory';
// Upper bound for one goal change: protects the sheet from absurd values (1e308, Infinity).
const MAX_GOAL_ADJUSTMENT = 1000000000;
const TRANSACTION_LOCK_TIMEOUT_MS = 10000;
// One request carries the whole client queue; the cap keeps it within Apps Script time limits.
const MAX_TRANSACTIONS_PER_REQUEST = 50;
// Client-generated UUIDs; the strict pattern also keeps formulas out of the ID cells.
const ENTITY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

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
const HEADER_GOAL_DEADLINE = 'Дедлайн';
const HEADER_GOAL_BEGIN_DATE = 'Початок';
const HEADER_GOAL_TYPE = 'Тип';
const HEADER_GOAL_ACTIVE = 'Активна';

const HEADER_GOAL_HISTORY_GOAL_ID = 'Ціль';

const HEADER_TRANSACTION_TYPE = 'Тип';
const HEADER_TRANSACTION_OPERATION = 'Операція';

/*
 * Columns without which the sheet makes no sense.
 *
 * The project has no backward compatibility, so the "old scheme" is not supported.
* Instead, every change must fail immediately and loudly: if
* someone renames a column, it's better to have an explicit error in the log than
* a budget that silently shows zeros. This is how we almost
* lost data three times already.
 */
const REQUIRED_EXPENSE_COLUMNS = [
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
  HEADER_GOAL_ID, HEADER_GOAL_NAME, HEADER_GOAL_TARGET_AMOUNT,
  HEADER_GOAL_DEADLINE, HEADER_GOAL_BEGIN_DATE, HEADER_GOAL_TYPE, HEADER_GOAL_ACTIVE,
];

const REQUIRED_GOAL_HISTORY_COLUMNS = [
  HEADER_ID, HEADER_GOAL_HISTORY_GOAL_ID, HEADER_AMOUNT, HEADER_USER, HEADER_DATE,
];

const REQUIRED_TRANSACTION_LOG_COLUMNS = [
  HEADER_ID, HEADER_USER, HEADER_RECORDED_AT, HEADER_TRANSACTION_TYPE, HEADER_TRANSACTION_OPERATION,
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

      case 'fetchGoals':
        return respondWithJson({
          ok: true,
          goals: fetchGoals(viewer),
        });

      case 'submitTransactions':
        return respondWithJson({
          ok: true,
          results: applyTransactions(payload.transactions, viewer),
          // Fresh data in the same response, built once for the whole batch,
          // even if nothing changed: a duplicate usually means the first
          // response was lost, and the client still needs to see the result.
          snapshot: buildSnapshot(viewer, periods, limitPeriod),
          goals: fetchGoals(viewer),
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
*   @param {Array<string>} periods — expenses for these months
*   @param {string} limitPeriod — limits for exactly this month
*   @returns {{ serverTime: string, viewer: object, categories: Array<object>, periods: Array<string>, expenses: Array<object> }}
 */
function buildSnapshot(viewer, periods, limitPeriod) {
  return {
    serverTime: new Date().toISOString(),
    viewer: { name: viewer.name, color: viewer.color },
    categories: readCategoriesWithLimits([limitPeriod]),
    periods: periods,
    expenses: readExpenses(periods),
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
* and all their past history remains in Expenses and GoalHistory.
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
 * Expenses for only the specified months.
*
* The sheet is not read completely. First, one column with the date — in eight
* times fewer cells than all columns, - to find the boundaries of the required
* months. Then only the row range between them is read.
*
* @param {Array<string>} periods — keys "YYYY-MM"
* @returns {Array<object>}
 */
function readExpenses(periods) {
  const sheet = getOptionalSheet(SHEET_EXPENSES);
  if (!sheet) return [];

  const header = readSheetHeader(sheet);
  requireSheetColumns(SHEET_EXPENSES, header.index, REQUIRED_EXPENSE_COLUMNS);

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

  const expenses = [];
  let skippedRowsCount = 0;

  sliceValues.forEach(function (dataRow) {
    const record = mapRowToRecord(dataRow, columnIndexByName);
    const occurredOn = toIsoDateTime(record[HEADER_DATE]);

    // An expense from another month is just ignored — it ended up in the range
    // due to the padding for entries added with a backdate.
    if (occurredOn && periods.indexOf(occurredOn.slice(0, 7)) === -1) return;

    const amount = toPositiveNumber(record[HEADER_AMOUNT]);

    if (!amount || !occurredOn) {
      skippedRowsCount += 1;
      return;
    }

    expenses.push({
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

  return expenses;
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

/* ── Operation: expense ─────────────────────────────────────────────────── */

/**
 * Adds, edits or deletes one Expenses row.
 *
 * Idempotent by targetId, like every operation handler: a retry may arrive
 * after the row was written but before the log marked the transaction, so
 * adding an existing row and deleting a missing one both succeed without changes.
 *
 * @param {{ action: string, targetId: string, data: object }} operation
 *   data for add and update: { occurredOn, category, amount, note? }
 * @param {BudgetUser} viewer
 * @returns {object} the data actually applied — it goes to the log
 * @throws {RequestError}
 */
function applyExpense(operation, viewer) {
  const expensesSheet = getRequiredSheet(SHEET_EXPENSES);
  const expensesHeader = readSheetHeader(expensesSheet);
  requireSheetColumns(SHEET_EXPENSES, expensesHeader.index, REQUIRED_EXPENSE_COLUMNS);

  const rowIndex = findExpenseRowIndexById(expensesSheet, operation.targetId, expensesHeader.index);

  if (operation.action === 'delete') {
    if (rowIndex !== -1) expensesSheet.deleteRow(rowIndex);
    return {};
  }

  const fields = parseExpenseFields(operation.data);

  if (operation.action === 'add') {
    if (rowIndex !== -1) return fields;

    appendRecordByColumnNames(expensesSheet, expensesHeader, [
      [HEADER_ID, operation.targetId],
      [HEADER_DATE, fields.occurredOn],
      [HEADER_CATEGORY, fields.category],
      [HEADER_AMOUNT, fields.amount],
      [HEADER_USER, viewer.name],
      [HEADER_NOTE, fields.note],
      [HEADER_RECORDED_AT, new Date()],
    ]);
    return fields;
  }

  if (rowIndex === -1) {
    throw new RequestError('Витрату з таким ID не знайдено', 'BAD_REQUEST');
  }

  // «Користувач» is not overwritten: the expense was made by whoever entered
  // it, even if someone else corrected the date later. «Записано» is the time
  // of the last write to the row.
  const index = expensesHeader.index;
  const setCell = function (columnName, value) {
    expensesSheet.getRange(rowIndex, index.get(columnName.toLowerCase()) + 1).setValue(value);
  };
  setCell(HEADER_DATE, fields.occurredOn);
  setCell(HEADER_CATEGORY, fields.category);
  setCell(HEADER_AMOUNT, fields.amount);
  setCell(HEADER_NOTE, fields.note);
  setCell(HEADER_RECORDED_AT, new Date());

  return fields;
}

/**
 * @param {object} data
 * @returns {{ occurredOn: string, category: string, amount: number, note: string }}
 * @throws {RequestError}
 */
function parseExpenseFields(data) {
  const amount = toPositiveNumber(data.amount);
  const occurredOn = toIsoDateTime(data.occurredOn);
  const category = String(data.category || '').trim();

  if (!amount) {
    throw new RequestError('Сума має бути додатним числом', 'BAD_REQUEST');
  }
  if (!occurredOn) {
    throw new RequestError('Не вдалося розпізнати дату: ' + data.occurredOn, 'BAD_REQUEST');
  }
  if (!category) {
    throw new RequestError('Не вказано категорію', 'BAD_REQUEST');
  }

  return {
    occurredOn: occurredOn,
    category: category,
    amount: amount,
    note: String(data.note || '').trim().slice(0, 200),
  };
}

/**
 * Finds the expense row by its ID.
 *
 * @param {Sheet} expensesSheet
 * @param {string} expenseId
 * @param {Map<string, number>} indexByName - header index, already read
 * @returns {number} row number from one or -1
 */
function findExpenseRowIndexById(expensesSheet, expenseId, indexByName) {
  const lastRowIndex = expensesSheet.getLastRow();
  if (lastRowIndex < 2) return -1;

  const idColumnNumber = indexByName.get(HEADER_ID.toLowerCase()) + 1;
  const idColumnValues = expensesSheet.getRange(2, idColumnNumber, lastRowIndex - 1, 1).getValues();

  for (let offset = 0; offset < idColumnValues.length; offset += 1) {
    if (String(idColumnValues[offset][0]).trim() === expenseId) return offset + 2;
  }

  return -1;
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
 * formatted as text. Then a Date object arrives from the sheet, and
 * String() of it gives «Mon Oct 01 2026…» — the key matches nothing,
 * and the row silently drops out of the budget.
 *
 * So three forms are accepted: a Date object, «2026-10» and «2026-10-01».
 *
 * @param {unknown} rawValue
 * @returns {string} «2026-10», or empty string if it cannot be parsed
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
 * Accepts «2026-10-05», «2026-10-05T14:30», a date from the sheet or
 * an ISO string — and returns the same shape.
 *
 * Time is not invented: if there is none, the result stays without
 * time. Otherwise a record entered a week ago without time would show
 * the time it was read at — and look as if it had just been added.
 *
 * @param {unknown} rawValue
 * @returns {string} «2026-10-05T14:30», «2026-10-05» or empty string
 */
function toIsoDateTime(rawValue) {
  // A Date object appears only in cells where someone typed the date
  // by hand: Sheets recognised it as a real date rather than text.
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
 * Accepts «2026-10-05», a date from the sheet or an ISO string.
 * @param {unknown} rawValue
 * @returns {string} «2026-10-05» or empty string
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
 * @returns {string} ISO time or empty string
 */
function toIsoTimestamp(rawValue) {
  if (Object.prototype.toString.call(rawValue) === '[object Date]') {
    return rawValue.toISOString();
  }

  const parsedDate = new Date(String(rawValue || ''));
  return isNaN(parsedDate.getTime()) ? '' : parsedDate.toISOString();
}

/* ── Responses and errors ───────────────────────────────────────────────── */

/**
 * Request error.
 *
 * Carries two texts:
 *   message        - what went wrong. Goes to the response `error` and the log.
 *   displayMessage - what to show the person. Goes to `displayError`.
 *
 * Split for one case: the server may know that a user's hash in the
 * sheet is broken, but must not tell that to someone who is just
 * guessing logins — otherwise the response reveals who is registered
 * here. Details stay in error, the screen shows a neutral text.
 *
 * If displayMessage is not given, the same text as in error is shown.
 */
class RequestError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ [key: string]: unknown }} [details] — extra response fields
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
 * Apps Script does not allow setting the HTTP status, so the error
 * code travels in the response body.
 *
 * Error format:
 *   error        - for the log and the developer
 *   displayError - what the page shows
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
 * @param {number} currentAmount — current amount
 * @param {number} targetAmount — target amount
 * @returns {number} percentage from 0 to 100
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
 * @param {number} currentAmount — current amount
 * @param {number} targetAmount — target amount
 * @param {string} beginDate — start date (YYYY-MM-DD)
 * @param {string} deadline — deadline date (YYYY-MM-DD)
 * @returns {number} monthly amount, or 0 if the deadline has passed or the goal is reached
 */
function calculateMonthlyRequirement(currentAmount, targetAmount, beginDate, deadline) {
  // Dates are compared as «YYYY-MM-DD» strings in the script timezone:
  // new Date('YYYY-MM-DD') is parsed as UTC, and local getters would then
  // shift the month for timezones behind UTC.
  const isoPattern = /^(\d{4})-(\d{2})-(\d{2})/;
  const beginMatch = String(beginDate || '').match(isoPattern);
  const deadlineMatch = String(deadline || '').match(isoPattern);

  if (!beginMatch || !deadlineMatch) return 0;
  if (currentAmount >= targetAmount) return 0;

  const today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');

  // If the deadline has already passed — return 0
  if (deadlineMatch[0] < today) return 0;

  // Start of accumulation = Max(begindate, today) — if the start date has passed, we start now
  const startMatch = (beginMatch[0] > today ? beginMatch[0] : today).match(isoPattern);

  const remainingAmount = targetAmount - currentAmount;

  // Count months from the start of accumulation to the deadline
  const monthsDiff = (Number(deadlineMatch[1]) - Number(startMatch[1])) * 12 +
                     (Number(deadlineMatch[2]) - Number(startMatch[2]));
  
  // If months < 1 — calculate as for 1 month
  const divisor = Math.max(1, monthsDiff);
  
  return Math.round(remainingAmount / divisor);
}

/* ── Goals ──────────────────────────────────────────────────────────────── */

/**
 * Active goals with their change history.
 *
 * The current amount is not stored anywhere: it is the sum of the goal's
 * GoalHistory rows. A stored copy next to the history would sooner or later
 * disagree with it, and nobody could tell which one is right.
 *
 * @param {BudgetUser} viewer
 * @returns {Array<object>} goals with progress, monthly requirement and history (newest first)
 */
function fetchGoals(viewer) {
  const records = readSheetAsRecords(SHEET_GOALS, REQUIRED_GOAL_COLUMNS);
  const historyByGoalId = groupGoalHistoryByGoalId(
    readSheetAsRecords(SHEET_GOAL_HISTORY, REQUIRED_GOAL_HISTORY_COLUMNS),
  );

  return records
    .filter(function (record) {
      return isTruthyFlag(record[HEADER_GOAL_ACTIVE]);
    })
    .map(function (record) {
      const id = String(record[HEADER_GOAL_ID] || '').trim();
      const history = historyByGoalId[id] || [];
      const current = sumGoalChangeAmounts(history);
      const target = toPositiveNumber(record[HEADER_GOAL_TARGET_AMOUNT]);
      const begin = toIsoDate(record[HEADER_GOAL_BEGIN_DATE]);
      const deadline = toIsoDate(record[HEADER_GOAL_DEADLINE]);

      return {
        id: id,
        name: String(record[HEADER_GOAL_NAME] || '').trim(),
        deadline: deadline,
        type: String(record[HEADER_GOAL_TYPE] || '').trim(),
        active: isTruthyFlag(record[HEADER_GOAL_ACTIVE]),
        targetAmount: target,
        currentAmount: current,
        progress: calculateGoalProgress(current, target),
        monthlyRequirement: calculateMonthlyRequirement(current, target, begin, deadline),
        history: history.slice().reverse(),
      };
    });
}

/**
 * @param {Array<Record<string, unknown>>} historyRecords — GoalHistory rows in sheet order
 * @returns {Record<string, Array<{ id: string, amount: number, user: string, occurredOn: string }>>}
 *   changes per goal ID, in sheet (oldest first) order
 */
function groupGoalHistoryByGoalId(historyRecords) {
  const historyByGoalId = {};

  historyRecords.forEach(function (record) {
    const goalId = String(record[HEADER_GOAL_HISTORY_GOAL_ID] || '').trim();
    if (goalId === '') return;

    if (!historyByGoalId[goalId]) historyByGoalId[goalId] = [];
    historyByGoalId[goalId].push({
      id: String(record[HEADER_ID] || '').trim(),
      amount: toSignedAmount(record[HEADER_AMOUNT]),
      user: String(record[HEADER_USER] || '').trim(),
      occurredOn: toIsoDate(record[HEADER_DATE]),
    });
  });

  return historyByGoalId;
}

/**
 * @param {Array<{ amount: number }>} changes
 * @returns {number} sum rounded to kopecks: float addition would leave 0.30000000000000004
 */
function sumGoalChangeAmounts(changes) {
  const total = changes.reduce(function (sum, change) {
    return sum + change.amount;
  }, 0);
  return Math.round(total * 100) / 100;
}

/**
 * @param {unknown} rawValue
 * @returns {number} finite amount rounded to kopecks, 0 if not a number; may be negative
 */
function toSignedAmount(rawValue) {
  const parsedValue = Number(rawValue);
  if (!isFinite(parsedValue)) return 0;
  return Math.round(parsedValue * 100) / 100;
}

/* ── Transactions ───────────────────────────────────────────────────────── */

/*
 * A Transaction is one action a user asked for: { id, operation }.
 * The operation says what to do: { type, action, targetId, data }.
 *
 * The Transactions sheet is a write-only log: it is consulted only to
 * recognise a repeated transaction, and is never read to build a view.
 * Entity sheets (GoalHistory, …) hold the current state.
 */

/** Operation handlers by type. Each validates, applies and returns the data it applied. */
const OPERATION_HANDLERS = {
  expense: applyExpense,
  goalChange: applyGoalChange,
};

const OPERATION_ACTIONS = ['add', 'update', 'delete'];

/**
 * Applies the client's queue in order, under one lock.
 *
 * Each transaction gets its own result, so one invalid entry does not hold
 * back the rest. An infrastructure failure (lock timeout, broken sheet)
 * fails the whole request instead: the client keeps the queue and retries.
 *
 * @param {unknown} rawTransactions
 * @param {BudgetUser} viewer
 * @returns {Array<{ id: string, status: string, error?: string }>}
 *   status: applied | duplicate | rejected
 * @throws {RequestError}
 */
function applyTransactions(rawTransactions, viewer) {
  if (!Array.isArray(rawTransactions) || rawTransactions.length === 0) {
    throw new RequestError('Не передано транзакцій', 'BAD_REQUEST');
  }
  if (rawTransactions.length > MAX_TRANSACTIONS_PER_REQUEST) {
    throw new RequestError(
      'Забагато транзакцій в одному запиті: ' + rawTransactions.length +
      ', дозволено ' + MAX_TRANSACTIONS_PER_REQUEST,
      'BAD_REQUEST',
    );
  }

  const logSheet = getRequiredSheet(SHEET_TRANSACTIONS);
  const logHeader = readSheetHeader(logSheet);
  requireSheetColumns(SHEET_TRANSACTIONS, logHeader.index, REQUIRED_TRANSACTION_LOG_COLUMNS);

  // Validation reads the current state and the write depends on it
  // (balance check, duplicate check): without the lock two requests
  // could both pass the check and both write.
  const lock = LockService.getScriptLock();
  lock.waitLock(TRANSACTION_LOCK_TIMEOUT_MS);

  try {
    return rawTransactions.map(function (rawTransaction) {
      return applyTransaction(rawTransaction, viewer, logSheet, logHeader);
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * @param {unknown} rawTransaction
 * @param {BudgetUser} viewer
 * @param {Sheet} logSheet
 * @param {{ row: Array<unknown>, index: Map<string, number> }} logHeader
 * @returns {{ id: string, status: string, error?: string }}
 * @throws {RequestError} when the transaction has no usable ID: the client
 *   matches results by ID, so there is nothing to report back to
 */
function applyTransaction(rawTransaction, viewer, logSheet, logHeader) {
  const transactionId = parseEntityId(rawTransaction && rawTransaction.id);
  if (!transactionId) {
    throw new RequestError('Транзакція без коректного ID', 'BAD_REQUEST');
  }

  if (isTransactionLogged(logSheet, logHeader.index, transactionId)) {
    return { id: transactionId, status: 'duplicate' };
  }

  try {
    const operation = parseOperation(rawTransaction.operation);
    const appliedData = OPERATION_HANDLERS[operation.type](operation, viewer);

    // The log row goes last, as a commit marker: if the script dies after
    // the entity write, the retry is not recognised as a duplicate and is
    // applied again — harmlessly, because handlers are idempotent by targetId.
    appendRecordByColumnNames(logSheet, logHeader, [
      [HEADER_ID, transactionId],
      [HEADER_USER, viewer.name],
      [HEADER_RECORDED_AT, new Date()],
      [HEADER_TRANSACTION_TYPE, operation.type],
      [HEADER_TRANSACTION_OPERATION, JSON.stringify({
        action: operation.action,
        targetId: operation.targetId,
        data: appliedData,
      })],
    ]);

    return { id: transactionId, status: 'applied' };
  } catch (error) {
    // Only a rejection of the request itself is "rejected". A broken sheet
    // or a timeout is not the transaction's fault: it must stay in the queue.
    if (!(error instanceof RequestError) || error.code !== 'BAD_REQUEST') throw error;
    return { id: transactionId, status: 'rejected', error: error.displayMessage };
  }
}

/**
 * @param {Sheet} logSheet
 * @param {Map<string, number>} indexByName
 * @param {string} transactionId
 * @returns {boolean} whether this transaction was already applied
 */
function isTransactionLogged(logSheet, indexByName, transactionId) {
  const lastRowIndex = logSheet.getLastRow();
  if (lastRowIndex < 2) return false;

  const idColumnNumber = indexByName.get(HEADER_ID.toLowerCase()) + 1;

  // TextFinder searches on Google's side: the log only grows, and pulling
  // the whole ID column into the script on every write would grow with it.
  return logSheet.getRange(2, idColumnNumber, lastRowIndex - 1, 1)
    .createTextFinder(transactionId)
    .matchEntireCell(true)
    .findNext() !== null;
}

/**
 * @param {unknown} rawValue
 * @returns {string} trimmed ID or empty string if it does not match ENTITY_ID_PATTERN
 */
function parseEntityId(rawValue) {
  const id = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim();
  return ENTITY_ID_PATTERN.test(id) ? id : '';
}

/**
 * @param {unknown} rawOperation
 * @returns {{ type: string, action: string, targetId: string, data: object }}
 * @throws {RequestError}
 */
function parseOperation(rawOperation) {
  if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
    throw new RequestError('Не передано операцію', 'BAD_REQUEST');
  }

  const type = String(rawOperation.type || '').trim();
  if (!Object.prototype.hasOwnProperty.call(OPERATION_HANDLERS, type)) {
    throw new RequestError('Невідомий тип операції: ' + (type || '(порожньо)'), 'BAD_REQUEST');
  }

  const action = String(rawOperation.action || '').trim();
  if (OPERATION_ACTIONS.indexOf(action) === -1) {
    throw new RequestError('Невідома дія операції: ' + (action || '(порожньо)'), 'BAD_REQUEST');
  }

  const targetId = parseEntityId(rawOperation.targetId);
  if (!targetId) {
    throw new RequestError('Операція без коректного ID запису', 'BAD_REQUEST');
  }

  const rawData = rawOperation.data;
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : {};

  return { type: type, action: action, targetId: targetId, data: data };
}

/**
 * Appends a row by column names: the column order in the sheet does not matter.
 *
 * @param {Sheet} sheet
 * @param {{ row: Array<unknown>, index: Map<string, number> }} header
 * @param {Array<[string, unknown]>} valuesByColumnName
 * @returns {void}
 * @throws {Error} if a column is missing: better write nothing than shift values
 */
function appendRecordByColumnNames(sheet, header, valuesByColumnName) {
  const sheetRow = new Array(header.row.length).fill('');

  valuesByColumnName.forEach(function (entry) {
    const columnIndex = header.index.get(entry[0].toLowerCase());
    if (columnIndex === undefined) {
      throw new Error('У аркуші ' + sheet.getName() + ' немає стовпця «' + entry[0] + '». Нічого не записано.');
    }
    sheetRow[columnIndex] = entry[1];
  });

  sheet.appendRow(sheetRow);
}

/* ── Operation: goalChange ──────────────────────────────────────────────── */

/**
 * Adds, edits or deletes one GoalHistory row.
 *
 * Idempotent by targetId, because a retry may arrive after the row was
 * written but before the log marked the transaction: adding an existing
 * row and deleting a missing one both succeed without changes.
 *
 * @param {{ action: string, targetId: string, data: object }} operation
 *   data for add: { goalId, amount, occurredOn? }; for update: { amount, occurredOn? }
 * @param {BudgetUser} viewer
 * @returns {object} the data actually applied — it goes to the log
 * @throws {RequestError}
 */
function applyGoalChange(operation, viewer) {
  const historySheet = getRequiredSheet(SHEET_GOAL_HISTORY);
  const historyHeader = readSheetHeader(historySheet);
  requireSheetColumns(SHEET_GOAL_HISTORY, historyHeader.index, REQUIRED_GOAL_HISTORY_COLUMNS);

  const changes = readGoalHistoryRows(historySheet, historyHeader.index);
  const existing = changes.filter(function (change) {
    return change.id === operation.targetId;
  })[0] || null;

  if (operation.action === 'delete') {
    if (!existing) return {};

    requireActiveGoal(existing.goalId);
    requireNonNegativeGoalBalance(changes, existing.goalId, existing.id, 0);
    historySheet.deleteRow(existing.rowIndex);
    return { goalId: existing.goalId, amount: existing.amount };
  }

  const amount = parseGoalChangeAmount(operation.data.amount);
  const occurredOn = parseGoalChangeDate(operation.data.occurredOn);

  if (operation.action === 'add') {
    if (existing) {
      return { goalId: existing.goalId, amount: existing.amount, occurredOn: existing.occurredOn };
    }

    const goalId = parseEntityId(operation.data.goalId);
    if (!goalId) {
      throw new RequestError('Не вказано ціль', 'BAD_REQUEST');
    }

    const addedOn = occurredOn || Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');

    requireActiveGoal(goalId);
    requireNonNegativeGoalBalance(changes, goalId, null, amount);
    appendRecordByColumnNames(historySheet, historyHeader, [
      [HEADER_ID, operation.targetId],
      [HEADER_GOAL_HISTORY_GOAL_ID, goalId],
      [HEADER_AMOUNT, amount],
      [HEADER_USER, viewer.name],
      [HEADER_DATE, addedOn],
    ]);
    return { goalId: goalId, amount: amount, occurredOn: addedOn };
  }

  if (!existing) {
    throw new RequestError('Запис історії цілі не знайдено', 'BAD_REQUEST');
  }

  requireActiveGoal(existing.goalId);
  requireNonNegativeGoalBalance(changes, existing.goalId, existing.id, amount);

  // The author is not overwritten: the money was moved by whoever
  // entered it, even if someone else corrected the amount later.
  const updatedOn = occurredOn || existing.occurredOn;
  historySheet.getRange(existing.rowIndex, historyHeader.index.get(HEADER_AMOUNT.toLowerCase()) + 1).setValue(amount);
  historySheet.getRange(existing.rowIndex, historyHeader.index.get(HEADER_DATE.toLowerCase()) + 1).setValue(updatedOn);
  return { goalId: existing.goalId, amount: amount, occurredOn: updatedOn };
}

/**
 * @param {Sheet} historySheet
 * @param {Map<string, number>} indexByName
 * @returns {Array<{ rowIndex: number, id: string, goalId: string, amount: number, occurredOn: string }>}
 */
function readGoalHistoryRows(historySheet, indexByName) {
  const lastRowIndex = historySheet.getLastRow();
  if (lastRowIndex < 2) return [];

  const values = historySheet.getRange(2, 1, lastRowIndex - 1, historySheet.getLastColumn()).getValues();
  const idColumn = indexByName.get(HEADER_ID.toLowerCase());
  const goalIdColumn = indexByName.get(HEADER_GOAL_HISTORY_GOAL_ID.toLowerCase());
  const amountColumn = indexByName.get(HEADER_AMOUNT.toLowerCase());
  const dateColumn = indexByName.get(HEADER_DATE.toLowerCase());

  return values.map(function (row, offset) {
    return {
      rowIndex: offset + 2,
      id: String(row[idColumn]).trim(),
      goalId: String(row[goalIdColumn]).trim(),
      amount: toSignedAmount(row[amountColumn]),
      occurredOn: toIsoDate(row[dateColumn]),
    };
  });
}

/**
 * @param {unknown} rawValue
 * @returns {number} non-zero amount rounded to kopecks; negative means a withdrawal
 * @throws {RequestError}
 */
function parseGoalChangeAmount(rawValue) {
  const amount = typeof rawValue === 'number' ? Math.round(rawValue * 100) / 100 : NaN;

  if (!isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_GOAL_ADJUSTMENT) {
    throw new RequestError('Некоректна сума зміни цілі', 'BAD_REQUEST');
  }
  return amount;
}

/**
 * The date is optional for goal changes: an absent one means "today" on add
 * and "unchanged" on update.
 *
 * @param {unknown} rawValue
 * @returns {string} «YYYY-MM-DD» or empty string when not given
 * @throws {RequestError} when given but not a date
 */
function parseGoalChangeDate(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return '';

  const occurredOn = toIsoDate(rawValue);
  if (!occurredOn) {
    throw new RequestError('Не вдалося розпізнати дату: ' + rawValue, 'BAD_REQUEST');
  }
  return occurredOn;
}

/**
 * @param {string} goalId
 * @returns {void}
 * @throws {RequestError} if the goal is missing or inactive: hidden goals
 *   are not shown, so nobody can see what a change to them would do
 */
function requireActiveGoal(goalId) {
  const goalRecord = readSheetAsRecords(SHEET_GOALS, REQUIRED_GOAL_COLUMNS).filter(function (record) {
    return String(record[HEADER_GOAL_ID] || '').trim() === goalId;
  })[0];

  if (!goalRecord || !isTruthyFlag(goalRecord[HEADER_GOAL_ACTIVE])) {
    throw new RequestError('Ціль не знайдено або вона неактивна', 'BAD_REQUEST');
  }
}

/**
 * @param {Array<{ id: string, goalId: string, amount: number }>} changes — all GoalHistory rows
 * @param {string} goalId
 * @param {string | null} replacedChangeId — the row being edited or deleted, excluded from the sum
 * @param {number} newAmount — amount that takes its place (0 for delete)
 * @returns {void}
 * @throws {RequestError} if the goal would end up below zero
 */
function requireNonNegativeGoalBalance(changes, goalId, replacedChangeId, newAmount) {
  const remainingChanges = changes.filter(function (change) {
    return change.goalId === goalId && change.id !== replacedChangeId;
  });
  const balance = Math.round((sumGoalChangeAmounts(remainingChanges) + newAmount) * 100) / 100;

  if (balance < 0) {
    throw new RequestError('Сума цілі не може стати від’ємною', 'BAD_REQUEST');
  }
}
