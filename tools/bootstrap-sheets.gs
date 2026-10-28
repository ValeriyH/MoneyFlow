/**
 * bootstrap-sheets.gs — One-time script to set up the spreadsheet.
 *
 * Run manually from the Apps Script editor BEFORE inserting the main
 * Code.gs and auth.gs files. It creates sheets with headers, populates
 * the category catalog, monthly budgets, and initializes users.
 *
 * Delete this file after the spreadsheet is created and insert the main files.
 *
 * Usage: Run the bootstrapSheets function.
 *
 * */
 
/**
 * Initial users and their passwords. The password is not generated — you
* set it yourself and remember it. Only a hash is stored in the table,
* hash, so it's impossible to retrieve the password from the table.
*
* Requirements: at least 10 characters, one lowercase and one uppercase letter, and a digit.
* Verified by requireStrongPassword on the server.
*
* @property {Array<object>} DEMO_USERS
* */
const DEMO_USERS = [
  { login: 'Я',       color: '#2563eb', password: 'Grivna-2026' },
  { login: 'Дружина', color: '#db2777', password: 'Kvitka-2026' },
];
 
/**
 * Category catalog: name, icon, color, activity status.
 *
 * "Active" — yes/no. If empty, it means "active", so you can add a
* category by filling only the name, icon, and color.
*
* @property {Array<Array<string>>} DEMO_CATEGORIES
* */
const DEMO_CATEGORIES = [
  ['Продукти',       '🛒', '#0f9d58', 'Так'],
  ['Кафе/Ресторани', '☕', '#d97706', 'Так'],
  ['Авто',           '🚗', '#0891b2', 'Так'],
  ['Дім/Комуналка',  '🏠', '#2563eb', 'Так'],
  ['Здоров\'я',      '💊', '#db2777', 'Так'],
  ['Розваги',        '🎬', '#7c3aed', 'Так'],
  ['Інше',           '📦', '#5a6478', 'Так'],
];
 
/**
* Monthly budget: month key, category, amount.
*
* To add the next month — select the block, copy it, paste it below,
* and update the "Month" column. A category for which there is no row
* here remains available for manual entry, but is not included in the budget.
*
* @property {Array<Array<string>>} DEMO_LIMITS
* */
const DEMO_LIMITS = [
  ['2026-10', 'Продукти',       12000],
  ['2026-10', 'Кафе/Ресторани',  4000],
  ['2026-10', 'Авто',            5000],
  ['2026-10', 'Дім/Комуналка',   6000],
  ['2026-10', 'Здоров\'я',       2000],
  ['2026-10', 'Розваги',         2500],
];
 
/**
* Goals: accumulation (savings) and projects.
*
* Types:
* - "Savings": for saving money (e.g., a new gadget).
* - "Project": for distributed expenses (e.g., car repair).
*
* @property {Array<Array<string>>} DEMO_GOALS
* */
const DEMO_GOALS = [
  ['Savings', '💻 Ноутбук', '25000', '0', '2026-12-31', '2026-10-01'],
  ['Project', '🔧 Ремонт авто', '8000', '0', '2027-11-15', '2026-10-01'],
  ['Savings', '🚆 Подорож до Києва', '35000', '0', '2027-01-31', '2026-10-01'],
  ['Project', '🛏️ Оновлення інтер\'єру спальні', '12000', '0', '2026-12-31', '2026-10-05'],
  ['Savings', '🎁 На подарунок', '5000', '0', '2026-12-20', '2026-10-01'],
];
 
const BOOTSTRAP_SHEET_NAMES = ['Transactions', 'Categories', 'BudgetLimits', 'Users', 'Goals'];

/**
* Entry point. Run manually from the editor.
*
* Writes only into clean sheets: if any of them already holds data, nothing
* is touched and the script stops. To start over, clear or delete those
* sheets yourself.
*
* @property {Array<object>} DEMO_USERS
* */
function bootstrapSheets() {
  const spreadsheet = SpreadsheetApp.getActive();

  assertSheetsAreClean(spreadsheet);

  try {
    populateSheets(spreadsheet);
  } catch (error) {
    // The writes cannot be rolled back, and the next run would refuse
    // to start on the half-filled sheets — the log says what to do.
    Logger.log(
      'ПОМИЛКА під час заповнення: ' + error.message + '\n' +
      'Частина аркушів уже може містити дані, тому повторний запуск зупиниться. ' +
      'Очистіть або видаліть аркуші ' + BOOTSTRAP_SHEET_NAMES.join(', ') +
      ' і запустіть bootstrapSheets ще раз.',
    );
    throw error;
  }

  const summary =
    'MoneyFlow: таблицю підготовлено.\n' +
    'Початкові паролі: ' +
    DEMO_USERS.map(function (user) {
      return user.login + ' → ' + user.password;
    }).join(', ') +
    '\nНаступний крок — вставити Code.gs та auth.gs у цей самий проєкт ' +
    'Apps Script і розгорнути як Web App (Execute as: Me, ' +
    'Who has access: Anyone).';

  Logger.log(summary);
  spreadsheet.toast(summary, 'Готово', 10);
}

/**
* Creates all sheets with headers and fills them with demo data.
*
* @param {Spreadsheet} spreadsheet
* @returns {void}
* */
function populateSheets(spreadsheet) {
  writeSheet(spreadsheet, 'Transactions', [
    'ID', 'Дата', 'Категорія', 'Сума', 'Користувач', 'Нотатка', 'Записано',
  ]);
 
  writeSheet(spreadsheet, 'Categories', [
    'Назва', 'Іконка', 'Колір', 'Активна',
  ]);
 
  writeSheet(spreadsheet, 'BudgetLimits', [
    'Місяць', 'Категорія', 'Ліміт, ₴',
  ]);
 
  // Column order is irrelevant: server writes by headers, not positions.
  writeSheet(spreadsheet, 'Users', [
    'Ім\'я', 'Колір', 'Пароль', 'Активний',
  ]);
 
  // New sheet for goals
  writeSheet(spreadsheet, 'Goals', [
    'ID', 'Назва', 'Цільова сума', 'Поточна сума', 'Дедлайн', 'Початок', 'Тип', 'Активна',
  ]);
 
  fillCategories();
  fillLimits();
  fillUsers();
  fillGoals();
  addSampleTransactions();

  SpreadsheetApp.flush();
}
 
/**
* Stops the bootstrap if any target sheet already has rows below the header.
* All sheets are checked before the first write, so a refusal never leaves
* the table half-overwritten.
*
* @param {Spreadsheet} spreadsheet
* @returns {void}
* */
function assertSheetsAreClean(spreadsheet) {
  const occupiedSheetNames = BOOTSTRAP_SHEET_NAMES.filter(function (sheetName) {
    const sheet = spreadsheet.getSheetByName(sheetName);
    return sheet !== null && sheet.getLastRow() > 1;
  });

  if (occupiedSheetNames.length > 0) {
    throw new Error(
      'Аркуші вже містять дані: ' + occupiedSheetNames.join(', ') + '. ' +
      'Нічого не змінено. Очистіть або видаліть ці аркуші вручну, ' +
      'якщо справді хочете почати з нуля.',
    );
  }
}

/**
* Creates a sheet or clears an existing one and writes the header.
*
* @param {Spreadsheet} spreadsheet
* @param {string} sheetName
* @param {Array<string>} headerNames
* */
function writeSheet(spreadsheet, sheetName, headerNames) {
  let sheet = spreadsheet.getSheetByName(sheetName);
 
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  } else {
    sheet.clear();
  }
 
  sheet.getRange(1, 1, 1, headerNames.length).setValues([headerNames]);
  sheet.getRange(1, 1, 1, headerNames.length)
    .setFontWeight('bold')
    .setBackground('#e8efff');
 
  sheet.setFrozenRows(1);
}
 
/** Fills the Categories sheet. */
function fillCategories() {
  const categoriesSheet = SpreadsheetApp.getActive().getSheetByName('Categories');
  categoriesSheet.getRange(2, 1, DEMO_CATEGORIES.length, 4).setValues(DEMO_CATEGORIES);
}
 
/** Fills the BudgetLimits sheet: month, category, amount. */
function fillLimits() {
  const limitsSheet = SpreadsheetApp.getActive().getSheetByName('BudgetLimits');
  limitsSheet.getRange(2, 1, DEMO_LIMITS.length, 3).setValues(DEMO_LIMITS);
}
 
/** Fills the Users sheet: login, color, password hash, activity status. */
function fillUsers() {
  const usersSheet = SpreadsheetApp.getActive().getSheetByName('Users');
 
  const userRows = DEMO_USERS.map(function (user) {
    return [user.login, user.color, hashPassword(user.password), 'Так'];
  });
 
  usersSheet.getRange(2, 1, userRows.length, 4).setValues(userRows);
}
 
/** Fills the Goals sheet: ID, name, target amount, current amount, deadline, start, type, active. */
function fillGoals() {
  const goalsSheet = SpreadsheetApp.getActive().getSheetByName('Goals');
 
  // DEMO_GOALS item: [type, name, target, current, deadline, start]
  const goalRows = DEMO_GOALS.map(function (goal) {
    return [
      Utilities.getUuid(), goal[1], Number(goal[2]), Number(goal[3]),
      parseLocalDate(goal[4]), parseLocalDate(goal[5]), goal[0], 'Так',
    ];
  });

  goalsSheet.getRange(2, 1, goalRows.length, goalRows[0].length).setValues(goalRows);
}

/**
 * «YYYY-MM-DD» as a date at local midnight: new Date('YYYY-MM-DD') is parsed
 * as UTC and could land on the previous day in the sheet.
 *
 * @param {string} isoDate
 * @returns {Date}
 */
function parseLocalDate(isoDate) {
  const parts = isoDate.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}
 
/**
* SHA-256 hash of the password as a hexadecimal string.
*
* Duplicates hashText from auth.gs: the table preparation occurs before
* the main files are in the project, so a copy is required here.
* After inserting the main files, bootstrap can be deleted along with it.
*
* @param {string} password
* @returns {string}
* */
function hashPassword(password) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(password),
    Utilities.Charset.UTF_8,
  )
    .map(function (byteValue) {
      return ('0' + ((byteValue + 256) % 256).toString(16)).slice(-2);
    })
    .join('');
}
 
/**
* Adds several sample transactions (October 2026, the month with demo limits).
* Called by bootstrapSheets; can also be run alone on an empty Transactions sheet.
*
* @property {Array<Array<string>>} DEMO_TRANSACTIONS
* */
const DEMO_TRANSACTIONS = [
  ['2026-10-01', 'Продукти', 2450, 'Я', 'Продуктовий'],
  ['2026-10-02', 'Кафе/Ресторани', 680, 'Дружина', 'Кав\'ярня'],
  ['2026-10-05', 'Авто', 3100, 'Я', 'Бензин'],
  ['2026-10-07', 'Дім/Комуналка', 4200, 'Я', 'Комуналка'],
];
 
function addSampleTransactions() {
  const spreadsheet = SpreadsheetApp.getActive();
  const transactionsSheet = spreadsheet.getSheetByName('Transactions');
 
  if (transactionsSheet.getLastRow() > 1) {
    throw new Error('Аркуш Transactions уже містить дані — очистіть його перед демо-заповненням.');
  }
 
  transactionsSheet.getRange(2, 1, DEMO_TRANSACTIONS.length, 7).setValues(
    DEMO_TRANSACTIONS.map(function (sample) {
      return [Utilities.getUuid(), sample[0], sample[1], sample[2], sample[3], sample[4], new Date()];
    }),
  );
}
