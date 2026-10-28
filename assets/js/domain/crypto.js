/**
 * crypto.js — client-side hashing.
 *
 * Login scheme: the password never leaves the browser in plain text.
 *   passwordHash = SHA-256(password)
 *   proof        = SHA-256(passwordHash + timestamp)
 *
 * The same applies to registration: the server accepts the ready
 * passwordHash, not the password itself. Thus, the plain password
 * never leaves the browser in any request — neither during login nor
 * during account creation.
 *
 * The same passwordHash value is stored in the table. Restoring the
 * password from it is only possible via brute force — and only by those
 * who have access to the table.
 *
 * All strings are encoded in UTF-8 on both sides, otherwise
 * the hashes would not match.
 *
 *
 */
 
/**
 * SHA-256 as a hexadecimal string.
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
 * Prepares the login proof for the server.
 *
 * @param {string} password — entered by the user
 * @param {number} timestampMs — client time, adjusted for skew
 * @returns {Promise<string>} proof
 */
export async function buildLoginProof(password, timestampMs) {
  const passwordHash = await sha256Hex(password);
  return sha256Hex(passwordHash + String(timestampMs));
}
 
/**
 * What is stored in the table and used for registration.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export function hashPassword(password) {
  return sha256Hex(password);
}
 
/**
 * Whether hashing is available on this page.
 * @returns {boolean}
 */
export function isCryptoAvailable() {
  return typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";
}