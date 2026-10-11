/**
 * bootstrap-sheets.gs — ОДНОРАЗОВИЙ скрипт підготовки таблиці.
 *
 * Запускається вручну з редактора Apps Script ПЕРЕД тим, як вставити
 * основні Code.gs та auth.gs. Створює три аркуші з шапками, заповнює
 * каталог категорій і заводить користувачів.
 *
 * Після створення таблиці видаліть цей файл і вставте основні.
 *
 * Використання: рядок функції bootstrapSheets → «Запустити».
 */

/**
 * Початкові користувачі та їхні паролі. Пароль не генерується — ви
 * задаєте його самі й запам'ятовуєте. У таблиці зберігається лише
 * хеш, тому дістати пароль із таблиці неможливо.
 *
 * Вимоги: щонайменше 10 символів, мала й велика літера та цифра.
 * Перевіряє requireStrongPassword на сервері.
 */
const DEMO_USERS = [
  { login: 'Я',       color: '#2563eb', password: 'Grivna-2026' },
  { login: 'Дружина', color: '#db2777', password: 'Kvitka-2026' },
];

/** Каталог категорій: назва, тип, іконка, колір, місячний ліміт у гривнях. */
const DEMO_CATEGORIES = [
  ['Продукти',       'Витрата', '🛒', '#0f9d58', 12000],
  ['Кафе/Ресторани', 'Витрата', '☕', '#d97706', 4000],
  ['Авто',           'Витрата', '🚗', '#0891b2', 5000],
  ['Дім/Комуналка',  'Витрата', '🏠', '#2563eb', 6000],
  ['Здоров\'я',      'Витрата', '💊', '#db2777', 2000],
  ['Розваги',        'Витрата', '🎬', '#7c3aed', 2500],
  ['Інше',           'Витрата', '📦', '#5a6478', 0],
  ['Зарплата',       'Дохід',   '💼', '#0f9d58', 0],
  ['Премія',         'Дохід',   '🎁', '#65a30d', 0],
  ['Підробіток',     'Дохід',   '💻', '#4f46e5', 0],
];

/**
 * Точка входу. Викликається вручну з редактора.
 */
function bootstrapSheets() {
  const spreadsheet = SpreadsheetApp.getActive();

  writeSheet(spreadsheet, 'Transactions', [
    'ID', 'Дата', 'Тип', 'Категорія', 'Сума', 'Користувач', 'Нотатка', 'Записано',
  ]);

  writeSheet(spreadsheet, 'Categories', [
    'Назва', 'Тип', 'Іконка', 'Колір', 'Ліміт, ₴',
  ]);

  // Порядок колонок неважливий: сервер пише за підписами, а не позиціями.
  writeSheet(spreadsheet, 'Users', [
    'Ім\'я', 'Колір', 'Пароль', 'Активний',
  ]);

  fillCategories();
  fillUsers();

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
 * Створює аркуш або повністю очищає наявний і пише шапку.
 *
 * @param {Spreadsheet} spreadsheet
 * @param {string} sheetName
 * @param {Array<string>} headerNames
 */
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

/** Заповнює аркуш Categories. */
function fillCategories() {
  const categoriesSheet = SpreadsheetApp.getActive().getSheetByName('Categories');
  categoriesSheet.getRange(2, 1, DEMO_CATEGORIES.length, 5).setValues(DEMO_CATEGORIES);
}

/** Заповнює аркуш Users: логін, колір, хеш пароля, ознака активності. */
function fillUsers() {
  const usersSheet = SpreadsheetApp.getActive().getSheetByName('Users');

  const userRows = DEMO_USERS.map(function (user) {
    return [user.login, user.color, hashPassword(user.password), 'Так'];
  });

  usersSheet.getRange(2, 1, userRows.length, 4).setValues(userRows);
}

/**
 * SHA-256 пароля шістнадцятковим текстом.
 *
 * Дублює hashText з auth.gs: підготовка таблиці відбувається до того,
 * як основні файли в проєкті, тож доведеться мати копію. Після
 * вставки основних файлів bootstrap можна видалити разом із ним.
 *
 * @param {string} password
 * @returns {string}
 */
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
 * Додає кілька прикладів операцій у поточному місяці.
 * Викликайте вручну, якщо хочете подивитися, як виглядає заповнений бюджет.
 */
function addSampleTransactions() {
  const spreadsheet = SpreadsheetApp.getActive();
  const transactionsSheet = spreadsheet.getSheetByName('Transactions');

  if (transactionsSheet.getLastRow() > 1) {
    throw new Error('Аркуш Transactions уже містить дані — очистіть його перед демо-заповненням.');
  }

  const today = new Date();

  /** @param {number} daysAgo скільки днів тому */
  function daysAgo(daysAgo) {
    return new Date(today.getFullYear(), today.getMonth(), Math.max(today.getDate() - daysAgo, 1));
  }

  const samples = [
    [daysAgo(1), 'Витрата', 'Продукти',      2450, 'Я',       'Продуковий'],
    [daysAgo(2), 'Витрата', 'Кафе/Ресторани', 680, 'Дружина', 'Кав\'ярня'],
    [daysAgo(3), 'Дохід',   'Зарплата',      32000, 'Я',       ''],
    [daysAgo(5), 'Витрата', 'Авто',          3100, 'Я',       'Бензин'],
    [daysAgo(7), 'Витрата', 'Дім/Комуналка', 4200, 'Я',       'Комуналка'],
  ];

  transactionsSheet.getRange(2, 1, samples.length, 8).setValues(
    samples.map(function (sample) {
      return [Utilities.getUuid(), sample[0], sample[1], sample[2], sample[3], sample[4], sample[5], new Date()];
    }),
  );
}