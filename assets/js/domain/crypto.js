/**
 * crypto.js — хешування на клієнті.
 *
 * Схема входу: пароль не залишає браузер у відкритому вигляді.
 *   passwordHash = SHA-256(пароль)
 *   proof        = SHA-256(passwordHash + timestamp)
 *
 * Те саме стосується реєстрації: сервер приймає готовий
 * passwordHash, а не сам пароль. Тому відкритий пароль не
 * залишає браузер ні в одному запиті — ні при вході, ні при
 * створенні акаунта.
 *
 * У таблиці лежить те саме значення passwordHash. Відновити з
 * нього пароль можна лише перебором — і лише тим, хто має
 * доступ до таблиці.
 *
 * Усі рядки кодуються в UTF-8 однаково на обох сторонах, інакше
 * хеші не збігалися б.
 */

/**
 * SHA-256 у вигляді шістнадцяткового рядка.
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function sha256Hex(value) {
  const encodedValue = new TextEncoder().encode(value);
  const digestBuffer = await crypto.subtle.digest("SHA-256", encodedValue);

  return [...new Uint8Array(digestBuffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Готує доказ входу для сервера.
 *
 * @param {string} password — введений користувачем
 * @param {number} timestampMs — час клієнта, скоригований на зсув
 * @returns {Promise<string>} proof
 */
export async function buildLoginProof(password, timestampMs) {
  const passwordHash = await sha256Hex(password);
  return sha256Hex(passwordHash + String(timestampMs));
}

/**
 * Те, що зберігається в таблиці й іде на реєстрацію.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export function hashPassword(password) {
  return sha256Hex(password);
}

/** Чи доступне хешування на цій сторінні. */
export function isCryptoAvailable() {
  return typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";
}