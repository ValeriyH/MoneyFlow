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
  ['Savings', 'Ноутбук', '25000', '0', '2026-12-31', '2026-10-01'],
  ['Project', 'Ремонт авто', '8000', '0', '2026-11-15', '2026-10-01'],
  ['Savings', 'Подорож до Києва', '35000', '0', '2027-01-31', '2026-10-01'],
  ['Project', 'Оновлення інтер\'єру спальні', '12000', '0', '2026-12-31', '2026-10-05'],
];
 
/**
* Entry point. Run manually from the editor.
*
* @property {Array<object>} DEMO_USERS
* */
function bootstrapSheets() {
  const spreadsheet = SpreadsheetApp.getActive();
 
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
 
  SpreadsheetApp.flush();
 
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
 
  const goalRows = DEMO_GOALS.map(function (goal) {
    return [Utilities.getUuid(), goal[0], goal[1], parseInt(goal[2]), 0, new Date(goal[5]), new Date(goal[6]), goal[3], 'Так'];
  });
 
  goalsSheet.getRange(2, 1, goalRows.length, 8).setValues(goalRows);
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
* Adds several sample transactions to the current month.
* Call manually if you want to see what a populated budget looks like.
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
 
  const today = new Date();
 
  /** @param {number} daysAgo how many days ago */
  function daysAgo(daysAgo) {
    return new Date(today.getFullYear(), today.getMonth(), Math.max(today.getDate() - daysAgo, 1));
  }
 
  transactionsSheet.getRange(2, 1, DEMO_TRANSACTIONS.length, 7).setValues(
    DEMO_TRANSACTIONS.map(function (sample) {
      return [Utilities.getUuid(), sample[0], sample[1], sample[2], sample[3], sample[4], new Date()];
    }),
  );
}
