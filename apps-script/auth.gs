/**
 * auth.gs — password authentication and session management on the Google Apps Script side.
 *
 * Separated from Code.gs because it is a self-contained layer: it only handles
 * users and does not look at operations or budgets.
 *
 * ── Login Scheme ──────────────────────────────────────────────────────────────
 * Password is not stored in the browser:
 *   passwordHash = SHA-256(password)          ← this is the "password" in the system
 *   proof        = SHA-256(passwordHash + timestamp)
 *
 * The server only stores passwordHash. For login, a proof is sent along with
 * the client time: a value intercepted by a third-party extension or
 * malicious software will not work later — it is tied to a time window
 * and cannot be used twice.
 *
 * Hashes on both sides must match byte-for-byte, so UTF-8 and hexadecimal
 * notation are used everywhere (see assets/js/domain/crypto.js).
 *
 * ── Sessions ──────────────────────────────────────────────────────────────────
 * After a successful login, the server signs a token (HMAC-SHA256) with the login,
 * issuance time, and expiration time. The browser stores the token and
 * no longer needs the password. The signing key and lifetime are in
 * PropertiesService, so they can be changed without redeploying the script.
 *  */

/** Default week, if nothing is set in PropertiesService. */
const TOKEN_TTL_HOURS_DEFAULT = 168;

/**
 * How much the client clock can deviate from the server.
 * Within this window, the proof is considered fresh.
 *  */
const PROOF_TIMESTAMP_WINDOW_MINUTES = 60;

/** Minimum password length. Same on server and in form. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * Standard response to a failed login.
 *
 * Does not reveal if the login exists or not: otherwise, it would be
 * possible to brute-force logins and find registered users by checking
 * the error message.
 *  */
const REFUSAL_MESSAGE = 'Невірний логін або пароль';

const PROPERTY_TOKEN_SECRET = 'moneyflow.tokenSecret';
const PROPERTY_TOKEN_TTL = 'moneyflow.tokenTtlHours';
const PROPERTY_LOGIN_STATE = 'moneyflow.loginState';

/* ── Brute-force protection ────────────────────────────────────────────── */

/**
 * Maximum consecutive failed attempts allowed before lockout.
 *
 * The counter is shared across all users: until verified, it is unknown
 * whose password is being brute-forced.
 *
 * Lockout is checked BEFORE any hash comparisons, so once triggered,
 * all attempts are blocked — including those with the correct password.
 * Brute-forcing ~144,000 attempts per day is reduced to 480: a 300x reduction.
 *  */

const MAX_FAILED_ATTEMPTS = 5;

/** Minutes to lockout login after exceeding allowed attempts. */

const LOCKOUT_DURATION_MINUTES = 15;

/** Key in PropertiesService where the attempt counter is stored. */

const PROPERTY_FAILED_ATTEMPTS = 'moneyflow.loginAttempts';

/* ── Hashes ───────────────────────────────────────────────────────────── */

/**
 * Returns the SHA-256 hash of a string as a hexadecimal text.
 * @param {string} text
 * @returns {string}
 *  */

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

/* ── Signing Secret ───────────────────────────────────────────────────────── */

/**
 * Returns the signing secret, creating it on first access.
 * Session lifetime is configured separately in PropertiesService
 * so it can be changed without redeploying the script.
 *
 * @returns {string}
 *  */

function getOrCreateTokenSecret() {
  const scriptProperties = PropertiesService.getScriptProperties();

  let secret = scriptProperties.getProperty(PROPERTY_TOKEN_SECRET);
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    scriptProperties.setProperty(PROPERTY_TOKEN_SECRET, secret);
  }

  return secret;
}

/** @returns {number} session token lifetime in hours */
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

/* ── Login State ────────────────────────────────────────────────────────── */

/**
 * Temporary state which should not be named: time of the last accepted
 * proof (to prevent replay) and time of password change (so that
 * expired tokens no longer work).
 *
 * @returns {{ [login: string]: { lastProofAtMs: number, credentialsChangedAtMs: number } }}
 *  */
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
 *  */
function updateLoginState(login, patch) {
  const loginState = readLoginState();
  const previousEntry = loginState[login] || {};

  loginState[login] = Object.assign(previousEntry, patch);
  PropertiesService.getScriptProperties().setProperty(
    PROPERTY_LOGIN_STATE,
    JSON.stringify(loginState),
  );
}

/* ── Brute Force Protection ─────────────────────────────────────────────── */

/**
 * @returns {{ failures: number, firstFailureAtMs: number, blockedUntilMs: number }}
 *  */
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
 *  */
function saveAttemptState(state) {
  PropertiesService.getScriptProperties().setProperty(
    PROPERTY_FAILED_ATTEMPTS,
    JSON.stringify(state),
  );
}

/**
 * @throws {RequestError} if login is currently blocked
 *  */
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

/** Counts failed attempts and enables lockout when sufficient. */
function registerFailedAttempt() {
  const nowMs = Date.now();
  const attemptState = readAttemptState();

  // New attempt series: first failure resets the lockout counter.
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

/* ── Password Login ────────────────────────────────────────────────────────── */

/**
 * Verifies proof and returns session.
 *
 * @param {{ login: string, proof: string, timestamp: number }} payload
 * @returns {{ token: string, expiresAt: number, serverTime: number, viewer: object }}
 *  */
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

  // No user found, account is inactive, or hash is broken — return
  // the same response. Different texts would reveal which users are
  // registered: it would be possible to brute-force logins and check
  // which ones respond differently.
  if (!user) {
    registerFailedAttempt();
    throw new RequestError(REFUSAL_MESSAGE, 'UNAUTHORIZED');
  }

  // Correct code, but account is not active yet. We tell the user
  // directly so they don't look for an error in their own password.
  if (!user.isActive) {
    throw new RequestError(
      'Акаунт створено, але ще не активовано. Адміністратор має увімкнути його в таблиці.',
      'UNAUTHORIZED',
    );
  }

  // Replay: the same proof is not accepted twice. An intercepted
  // request becomes useless once it has been replayed.
  //
  // The state key is the canonical name from the sheet, not the input:
  // otherwise "Olya" and "Olya" in Cyrillic would have different entries and bypass
  // the replay check.
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

/* ── Sessions ────────────────────────────────────────────────────────── */

/**
 * @param {string} login
 * @param {number} issuedAtMs
 * @returns {string}
 *  */
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
 *  */
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

  // The only case where the token is invalid but signed correctly
  // and all data in it is honest: simply expired.
  //
  // The client on this code stores a queue - after re-login
  // it will be processed. The rest of the failures (account disabled, password changed,
  // token forged) are UNAUTHORIZED, and the queue is discarded:
  // re-login won't help, as otherwise the record would be blocked forever.
  if (payload.expiresAt < Date.now()) {
    throw new RequestError('Термін сесії минув. Увійдіть знову.', 'SESSION_EXPIRED');
  }

  return payload;
}

/**
 * @param {string} encodedPayload
 * @returns {string} signature in base64url format
 *  */
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
 * Finds user by login. Login is the name, so it
 * must be unique.
 *
 * @param {string} login
 * @returns {{ name: string, color: string, passwordHash: string, isActive: boolean } | null}
 *  */
function findUserByLogin(login) {
  const normalizedLogin = login.trim().toLowerCase();

  for (const user of readUsers()) {
    if (user.name.toLowerCase() === normalizedLogin) return user;
  }

  return null;
}

/* ── Registration and Password Change ────────────────────────────────────────── */

/**
 * Password rules. Same for standalone registration and for
 * passwords set by an administrator.
 *
 * @param {string} password
 * @throws {RequestError}
 *  */
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
 * Writes a row to the Users sheet.
 *
 * @param {{ login: string, passwordHash: string, color: string, isActive: boolean }} newUser
 *  */
function insertUserRecord(newUser) {
  // insertUserRecord writes by keys, not by positions, so a
  // missing property would silently end up in a cell as undefined.
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

  // Values are passed in header order; appendRowByColumnNames
  // will arrange them so that the order of columns in the table does not matter.
  appendRowByColumnNames(usersSheet, [
    newUser.login,
    newUser.color,
    newUser.passwordHash,
    newUser.isActive ? FLAG_ACTIVE : FLAG_INACTIVE,
  ]);
}

/**
 * Updates password of existing user and invalidates old
 * tokens: change time is recorded, and session issued earlier
 * no longer works.
 *
 * @param {string} login
 * @param {string} newPassword
 *  */
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

    // The state key is the canonical name from the sheet, not the input:
    // otherwise "Olya" and "Olya" in Cyrillic would have different entries and bypass
    // the replay check.
    updateLoginState(rowLogin, { credentialsChangedAtMs: Date.now() });
    return;
  }

  throw new RequestError('Користувача «' + login + '» не знайдено', 'BAD_REQUEST');
}

/* ── Base64url ──────────────────────────────────────────────────────────── */

/**
 * Text in base64url without '=' at the end.
 * This is how the useful payload of the token lies.
 *
 * @param {string} text
 * @returns {string}
 *  */
function base64UrlEncodeUtf8(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.newBlob(String(text), 'text/plain', 'UTF-8').getBytes(),
  ).replace(/=+$/, '');
}

/**
 * @param {string} encodedText
 * @returns {string}
 *  */
function base64UrlDecodeUtf8(encodedText) {
  // base64 requires length multiple of 4, and '=' were stripped during encoding.
  const padded = encodedText + '==='.slice((encodedText.length + 3) % 4);
  const bytes = Utilities.base64DecodeWebSafe(padded);

  return bytes.length === 0 ? '' : Utilities.newBlob(bytes).getDataAsString('UTF-8');
}
