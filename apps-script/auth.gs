/**
 * auth.gs — вхід за паролем і сесії на стороні Google Apps Script.
 *
 * Розділено з Code.gs, бо це самодостатній шар: він не дивиться
 * в операції й бюджет, лише в людей.
 *
 * ── Схема входу ───────────────────────────────────────────────────────────
 * Пароль не залишає браузер:
 *   passwordHash = SHA-256(пароль)          ← це і є «пароль» у системі
 *   proof        = SHA-256(passwordHash + timestamp)
 *
 * Сервер зберігає лише passwordHash. Для входу надсилається proof
 * разом із часом клієнта: значення, перехоплене стороннім розширенням
 * або шкідливим ПЗ, згодом не працює — воно прив'язане до вікна
 * часу і не приймається двічі.
 *
 * Хеші на обох сторонах мають збігатися до байта, тому скрізь
 * UTF-8 і шістнадцятковий запис (див. assets/js/domain/crypto.js).
 *
 * ── Сесії ────────────────────────────────────────────────────────────────
 * Після успішного входу сервер підписує токен (HMAC-SHA256) з логіном,
 * часом видачі та часом завершення. Браузер зберігає токен і більше
 * не має пароля. Ключ підпису й термін життя — у PropertiesService,
 * тому змінюються без передеплоювання скрипта.
 */

/** Стандартний тиждень, якщо в PropertiesService нічого не задано. */
const TOKEN_TTL_HOURS_DEFAULT = 168;

/**
 * Наскільки може розходитися годинник клієнта із серверним.
 * За таке вікно доказ вважається свіжим.
 */
const PROOF_TIMESTAMP_WINDOW_MINUTES = 60;

/** Мінімальна довжина пароля. Однакова на сервері й у формі. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * Однакова відповідь на відмову у вході.
 *
 * Не розкриває, існує такий логін чи ні: інакше можна було б
 * перебирати логіни й за текстом помилки дізнаватися, хто
 * зареєстрований.
 */
const REFUSAL_MESSAGE = 'Невірний логін або пароль';

const PROPERTY_TOKEN_SECRET = 'moneyflow.tokenSecret';
const PROPERTY_TOKEN_TTL = 'moneyflow.tokenTtlHours';
const PROPERTY_LOGIN_STATE = 'moneyflow.loginState';

/* ── Захист від перебору ────────────────────────────────────────────────── */

/**
 * Скільки невдалих спроб поспіль допускаємо до блокування.
 *
 * Лічильник спільний на всіх: до перевірки ще невідомо, чий пароль
 * намагаються підібрати.
 *
 * Блокування перевіряється ДО будь-якого порівняння хешів, тому
 * після спрацювання відсікаються всі спроби — включно з правильним
 * паролем. Перебір з ~144 000 спроб на добу падає до 480: у 300 разів.
 */
const MAX_FAILED_ATTEMPTS = 5;

/** На скільки хвилин блокується вхід після цих спроб. */
const LOCKOUT_DURATION_MINUTES = 15;

/** Ключ у PropertiesService, де живе лічильник спроб. */
const PROPERTY_FAILED_ATTEMPTS = 'moneyflow.loginAttempts';

/* ── Хеші ───────────────────────────────────────────────────────────────── */

/**
 * SHA-256 рядка шістнадцятковим текстом.
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
  const digestBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8,
  );

  return digestBytes
    .map(function (byteValue) {
      return ('0' + ((byteValue + 256) % 256).toString(16)).slice(-2);
    })
    .join('');
}

/* ── Секрет підпису ─────────────────────────────────────────────────────── */

/**
 * Повертає секрет підпису, створюючи його при першому зверненні.
 * Термін життя сесій налаштовується окремо, у PropertiesService,
 * щоб не довелося передеплоювати скрипт.
 *
 * @returns {string}
 */
function getOrCreateTokenSecret() {
  const scriptProperties = PropertiesService.getScriptProperties();

  let secret = scriptProperties.getProperty(PROPERTY_TOKEN_SECRET);
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    scriptProperties.setProperty(PROPERTY_TOKEN_SECRET, secret);
  }

  return secret;
}

/** @returns {number} скільки годин живий токен */
function getTokenTtlHours() {
  const rawValue = PropertiesService.getScriptProperties().getProperty(PROPERTY_TOKEN_TTL);
  const parsedValue = Number(rawValue);

  if (!isFinite(parsedValue) || parsedValue <= 0) return TOKEN_TTL_HOURS_DEFAULT;
  return parsedValue;
}

/** @param {number} hours */
function setTokenTtlHours(hours) {
  PropertiesService.getScriptProperties().setProperty(PROPERTY_TOKEN_TTL, String(hours));
}

/* ── Стан входів ────────────────────────────────────────────────────────── */

/**
 * Тимчасовий стан, який не має називати: час останнього прийнятого
 * доказу (щоб не пропустити реплей) і час зміни пароля (щоб
 * застарілі токени перестали діяти).
 *
 * @returns {{ [login: string]: { lastProofAtMs: number, credentialsChangedAtMs: number } }}
 */
function readLoginState() {
  const rawState = PropertiesService.getScriptProperties().getProperty(PROPERTY_LOGIN_STATE);
  if (!rawState) return {};

  try {
    const parsedState = JSON.parse(rawState);
    return typeof parsedState === 'object' && parsedState !== null ? parsedState : {};
  } catch (error) {
    return {};
  }
}

/**
 * @param {string} login
 * @param {{ lastProofAtMs?: number, credentialsChangedAtMs?: number }} patch
 */
function updateLoginState(login, patch) {
  const loginState = readLoginState();
  const previousEntry = loginState[login] || {};

  loginState[login] = Object.assign(previousEntry, patch);
  PropertiesService.getScriptProperties().setProperty(
    PROPERTY_LOGIN_STATE,
    JSON.stringify(loginState),
  );
}

/* ── Захист від перебору ────────────────────────────────────────────────── */

/**
 * @returns {{ failures: number, firstFailureAtMs: number, blockedUntilMs: number }}
 */
function readAttemptState() {
  const rawState = PropertiesService.getScriptProperties().getProperty(PROPERTY_FAILED_ATTEMPTS);
  if (!rawState) return { failures: 0, firstFailureAtMs: 0, blockedUntilMs: 0 };

  try {
    const parsedState = JSON.parse(rawState);
    return {
      failures: Number(parsedState.failures) || 0,
      firstFailureAtMs: Number(parsedState.firstFailureAtMs) || 0,
      blockedUntilMs: Number(parsedState.blockedUntilMs) || 0,
    };
  } catch (error) {
    return { failures: 0, firstFailureAtMs: 0, blockedUntilMs: 0 };
  }
}

/**
 * @param {{ failures?: number, firstFailureAtMs?: number, blockedUntilMs?: number }} state
 */
function saveAttemptState(state) {
  PropertiesService.getScriptProperties().setProperty(
    PROPERTY_FAILED_ATTEMPTS,
    JSON.stringify(state),
  );
}

/**
 * @throws {RequestError} якщо вхід зараз заблокований
 */
function ensureLoginIsNotBlocked() {
  const attemptState = readAttemptState();

  if (attemptState.blockedUntilMs <= Date.now()) return;

  const secondsLeft = Math.ceil((attemptState.blockedUntilMs - Date.now()) / 1000);
  throw new RequestError(
    'Забагато спроб із невірним паролем. Спробуйте за ' +
    Math.ceil(secondsLeft / 60) + ' хв.',
    'RATE_LIMITED',
    { retryAfterSeconds: secondsLeft },
  );
}

/** Рахує невдалу спробу й, коли їх достатньо, вмикає блокування. */
function registerFailedAttempt() {
  const nowMs = Date.now();
  const attemptState = readAttemptState();

  // Нова серія спроб: перша невдача відкриває відлік заново.
  const isNewSeries = nowMs - attemptState.firstFailureAtMs > LOCKOUT_DURATION_MINUTES * 60 * 1000;
  const failures = (isNewSeries ? 0 : attemptState.failures) + 1;
  const firstFailureAtMs = isNewSeries ? nowMs : attemptState.firstFailureAtMs;

  const blockedUntilMs = failures >= MAX_FAILED_ATTEMPTS
    ? nowMs + LOCKOUT_DURATION_MINUTES * 60 * 1000
    : 0;

  saveAttemptState({ failures, firstFailureAtMs, blockedUntilMs });
}

function clearFailedAttempts() {
  saveAttemptState({ failures: 0, firstFailureAtMs: 0, blockedUntilMs: 0 });
}

/* ── Вхід за паролем ────────────────────────────────────────────────────── */

/**
 * Перевіряє доказ і повертає сесію.
 *
 * @param {{ login: string, proof: string, timestamp: number }} payload
 * @returns {{ token: string, expiresAt: number, serverTime: number, viewer: object }}
 */
function authenticateByCredentials(payload) {
  ensureLoginIsNotBlocked();

  const login = String(payload.login || '').trim();
  const proof = String(payload.proof || '').trim();
  const clientTimestamp = Number(payload.timestamp);

  if (login === '' || proof === '') {
    throw new RequestError('Введіть логін і пароль', 'UNAUTHORIZED');
  }

  if (!isFinite(clientTimestamp)) {
    throw new RequestError('Незрозумілий час у запиті', 'BAD_REQUEST');
  }

  const nowMs = Date.now();
  const windowMs = PROOF_TIMESTAMP_WINDOW_MINUTES * 60 * 1000;

  if (Math.abs(nowMs - clientTimestamp) > windowMs) {
    throw new RequestError(
      'Годинник пристрою надто відрізняється від серверного. Перевірте дату й час.',
      'BAD_REQUEST',
      { serverTime: nowMs },
    );
  }

  const user = findUserByLogin(login);

  // Немає користувача, є неактивний, зламаний хеш — назові
  // однакова відповідь. Різні тексти видали б перелік тих,
  // хто тут зареєстрований: можна було б перебирати логіни й
  // дивитися, які відповідають інакше.
  if (!user) {
    registerFailedAttempt();
    throw new RequestError(REFUSAL_MESSAGE, 'UNAUTHORIZED');
  }

  // Код правильний, але акаунт ще не увімкнутий. Кажемо прямо,
  // щоб людина не шукала помилку у своєму паролі.
  if (!user.isActive) {
    throw new RequestError(
      'Акаунт створено, але ще не активовано. Адміністратор має увімкнути його в таблиці.',
      'UNAUTHORIZED',
    );
  }

  // Реплей: той самий доказ удруге не приймається. Перехоплений
  // запит стає безкорисним, щойно його вже відіграли.
  //
  // Ключ стану — канонічне ім'я з аркуша, а не те, що ввели:
  // інакше «ОЛЯ» й «Оля» мали б різні записи й обхід реплею.
  const loginState = readLoginState()[user.name] || {};
  if (clientTimestamp <= (loginState.lastProofAtMs || 0)) {
    throw new RequestError(
      'Цей запит уже використаний. Зачекайте трохи або спробуйте ще раз.',
      'BAD_REQUEST',
      { serverTime: nowMs },
    );
  }

  if (!isSha256Hex(user.passwordHash)) {
    console.error(
      'У користувача «' + user.name + '» некоректний хеш (' +
      user.passwordHash.length + ' символів замість 64). ' +
      'Виправте: checkUsersIntegrity(); resetUserPassword(логін, НовийПароль);',
    );
    registerFailedAttempt();
    throw new RequestError(REFUSAL_MESSAGE, 'UNAUTHORIZED');
  }

  const expectedProof = hashText(user.passwordHash + String(clientTimestamp));
  if (expectedProof !== proof) {
    registerFailedAttempt();
    throw new RequestError(REFUSAL_MESSAGE, 'UNAUTHORIZED');
  }

  clearFailedAttempts();
  updateLoginState(user.name, { lastProofAtMs: clientTimestamp });

  return {
    token: issueSessionToken(login, nowMs),
    expiresAt: nowMs + getTokenTtlHours() * 60 * 60 * 1000,
    serverTime: nowMs,
    viewer: { name: user.name, color: user.color },
  };
}

/* ── Сесії ──────────────────────────────────────────────────────────────── */

/**
 * @param {string} login
 * @param {number} issuedAtMs
 * @returns {string}
 */
function issueSessionToken(login, issuedAtMs) {
  const payload = {
    login: login,
    issuedAt: issuedAtMs,
    expiresAt: issuedAtMs + getTokenTtlHours() * 60 * 60 * 1000,
  };

  const encodedPayload = base64UrlEncodeUtf8(JSON.stringify(payload));
  return encodedPayload + '.' + signTokenPayload(encodedPayload);
}

/**
 * @param {string} token
 * @returns {{ login: string, issuedAt: number, expiresAt: number }}
 */
function verifySessionToken(token) {
  const rawToken = String(token || '').trim();
  if (rawToken === '') {
    throw new RequestError('Немає активної сесії', 'UNAUTHORIZED');
  }

  const parts = rawToken.split('.');
  if (parts.length !== 2) {
    throw new RequestError('Пошкоджений токен', 'UNAUTHORIZED');
  }

  const [encodedPayload, providedSignature] = parts;

  if (signTokenPayload(encodedPayload) !== providedSignature) {
    throw new RequestError('Підпис токена не збігається', 'UNAUTHORIZED');
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeUtf8(encodedPayload));
  } catch (error) {
    throw new RequestError('Не вдалося прочитати токен', 'UNAUTHORIZED');
  }

  if (!payload.login || !payload.expiresAt) {
    throw new RequestError('Токен відсутній або спустошений', 'UNAUTHORIZED');
  }

  if (payload.expiresAt < Date.now()) {
    throw new RequestError('Термін сесії минув. Увійдіть знову.', 'UNAUTHORIZED');
  }

  return payload;
}

/**
 * @param {string} encodedPayload
 * @returns {string} підпис у форматі base64url
 */
function signTokenPayload(encodedPayload) {
  const signatureBytes = Utilities.computeHmacSha256Signature(
    encodedPayload,
    getOrCreateTokenSecret(),
  );
  return Utilities.base64Encode(signatureBytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Знаходить користувача за логіном. Логін — це ім'я, тому воно
 * має бути унікальним.
 *
 * @param {string} login
 * @returns {{ name: string, color: string, passwordHash: string, isActive: boolean } | null}
 */
function findUserByLogin(login) {
  const normalizedLogin = login.trim().toLowerCase();

  for (const user of readUsers()) {
    if (user.name.toLowerCase() === normalizedLogin) return user;
  }

  return null;
}

/* ── Реєстрація та зміна пароля ────────────────────────────────────────── */

/**
 * Правила до пароля. Однакові для самостійної реєстрації і для
 * паролів, які заводить адміністратор.
 *
 * @param {string} password
 * @throws {RequestError}
 */
function requireStrongPassword(password) {
  const unmetRules = [
    { isMet: password.length >= MIN_PASSWORD_LENGTH,
      message: 'Пароль має містити щонайменше ' + MIN_PASSWORD_LENGTH + ' символів' },
    { isMet: /[a-z]/.test(password),
      message: 'Пароль має містити хоча б одну малу літеру' },
    { isMet: /[A-Z]/.test(password),
      message: 'Пароль має містити хоча б одну велику літеру' },
    { isMet: /\d/.test(password),
      message: 'Пароль має містити хоча б одну цифру' },
  ];

  for (const rule of unmetRules) {
    if (!rule.isMet) throw new RequestError(rule.message, 'BAD_REQUEST');
  }
}

/**
 * Пише рядок у аркуш Users.
 *
 * @param {{ login: string, passwordHash: string, color: string, isActive: boolean }} newUser
 */
function insertUserRecord(newUser) {
  // insertUserRecord пише за ключами, а не за позиціями, тому
  // пропущена властивість тихо потрапила б у клітинку як undefined.
  for (const requiredKey of ['login', 'passwordHash', 'color']) {
    if (typeof newUser[requiredKey] !== 'string' || newUser[requiredKey] === '') {
      throw new Error(
        'insertUserRecord: не задано «' + requiredKey + '». ' +
        'Перевірте, чи всі поля передано користувачеві.',
      );
    }
  }

  const usersSheet = getRequiredSheet(SHEET_USERS);
  requireSheetColumns(SHEET_USERS, readSheetHeader(usersSheet).index, REQUIRED_USER_COLUMNS);

  // Значення передаються в порядку шапки; appendRowByColumnNames сам
  // розставить їх так, щоб порядок колонок у таблиці не мав значення.
  appendRowByColumnNames(usersSheet, [
    newUser.login,
    newUser.color,
    newUser.passwordHash,
    newUser.isActive ? FLAG_ACTIVE : FLAG_INACTIVE,
  ]);
}

/**
 * Оновлює пароль існуючого користувача та інвалідує його старі
 * токени: час зміни записується, і сесія, видана раніше,
 * більше не проходить.
 *
 * @param {string} login
 * @param {string} newPassword
 */
function replaceUserPassword(login, newPassword) {
  const normalizedLogin = login.trim().toLowerCase();
  const usersSheet = getRequiredSheet(SHEET_USERS);

  const usersHeader = readSheetHeader(usersSheet);
  const indexByName = usersHeader.index;
  requireSheetColumns(SHEET_USERS, indexByName, [HEADER_USER_NAME, HEADER_USER_PASSWORD_HASH]);

  const passwordColumnIndex = indexByName.get(HEADER_USER_PASSWORD_HASH.toLowerCase());
  const nameColumnIndex = indexByName.get(HEADER_USER_NAME.toLowerCase());

  const lastRowIndex = usersSheet.getLastRow();
  const nameColumnValues = usersSheet
    .getRange(2, nameColumnIndex + 1, lastRowIndex - 1, 1)
    .getValues();

  for (let offset = 0; offset < nameColumnValues.length; offset += 1) {
    const rowLogin = String(nameColumnValues[offset][0]).trim();
    if (rowLogin.toLowerCase() !== normalizedLogin) continue;

    usersSheet.getRange(offset + 2, passwordColumnIndex + 1).setValue(hashText(newPassword));

    // Ключ стану — точне ім'я з аркуша, а не те, що ввів користувач:
    // інакше «ОЛЯ» й «Оля» мали б різні записи.
    updateLoginState(rowLogin, { credentialsChangedAtMs: Date.now() });
    return;
  }

  throw new RequestError('Користувача «' + login + '» не знайдено', 'BAD_REQUEST');
}

/* ── Base64url ──────────────────────────────────────────────────────────── */

/**
 * Текст у base64url без '=' наприкінці.
 * Саме в такому вигляді лежить корисне навантаження токена.
 *
 * @param {string} text
 * @returns {string}
 */
function base64UrlEncodeUtf8(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.newBlob(String(text), 'text/plain', 'UTF-8').getBytes(),
  ).replace(/=+$/, '');
}

/**
 * @param {string} encodedText
 * @returns {string}
 */
function base64UrlDecodeUtf8(encodedText) {
  // base64 потребує довжину, кратну 4, а '=' обрізали при кодуванні.
  const padded = encodedText + '==='.slice((encodedText.length + 3) % 4);
  const bytes = Utilities.base64DecodeWebSafe(padded);

  return bytes.length === 0 ? '' : Utilities.newBlob(bytes).getDataAsString('UTF-8');
}
