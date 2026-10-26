/**
 * period.js — handling months as "YYYY-MM" keys.
 * The single place where calendar math lives.
 *
 *
 */
/**
 * @param {Date} [referenceDate]
 * @returns {string} current month key, e.g., "2026-10"
 *
 *
 */
export function currentPeriodKey(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
 
/**
 * @param {string} periodKey — "2026-10"
 * @param {number} offsetInMonths
 * @returns {string}
 *
 *
 */
export function shiftPeriodKey(periodKey, offsetInMonths) {
  const [year, month] = periodKey.split("-").map(Number);
  const shiftedDate = new Date(year, month - 1 + offsetInMonths, 1);
  return currentPeriodKey(shiftedDate);
}
 
/**
 * How many days have already passed in the month as of today.
 * For completed months — full length, for future ones — zero.
 *
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {number}
 *
 *
 */
export function elapsedDaysInPeriod(periodKey, referenceDate = new Date()) {
  if (periodKey === currentPeriodKey(referenceDate)) {
    return referenceDate.getDate();
  }
 
  return periodKey < currentPeriodKey(referenceDate) ? daysInPeriod(periodKey) : 0;
}
 
/**
 * @param {string} periodKey
 * @returns {number} 28 | 29 | 30 | 31
 *
 *
 */
export function daysInPeriod(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}
 
/**
 * How many days are left until the end of the month, including today.
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {number}
 *
 *
 */
export function remainingDaysInPeriod(periodKey, referenceDate = new Date()) {
  const totalDays = daysInPeriod(periodKey);
  const elapsedDays = elapsedDaysInPeriod(periodKey, referenceDate);
  return Math.max(totalDays - elapsedDays, 0);
}
 
/**
 * Does the month match the current one — this determines whether
 * to show the "end of month projection".
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {boolean}
 *
 *
 */
export function isCurrentPeriod(periodKey, referenceDate = new Date()) {
  return periodKey === currentPeriodKey(referenceDate);
}
 
/**
 * Local time in the format acceptable by date and time fields:
 * "2026-10-17T02:49". Date — first 10 chars, time — next 5.
 *
 * **The single place in the project where local time is built for the screen.**
 * The reason it's only here: `toISOString()` by contract always
 * converts to UTC — this is not our choice, but the method's behavior. In Kyiv
 * (UTC+3) at 00:30 it would return yesterday's date — and no refresh would
 * fix it, because every refresh would calculate the same thing.
 * Therefore, we take local fields from the `Date` object, not convert them.
 *
 * Seconds are not needed: in the `Date` column, `YYYY-MM-DDHH:MM` is stored.
 *
 * For labels that are not output anywhere (`recordedAt`,
 * `lastSyncedAt`), UTC remains correct — there, string monotonicity is
 * what matters, not the local time.
 *
 * @param {Date} [referenceDate]
 * @returns {string}
 *
 *
 */
export function toLocalIso(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  const day = String(referenceDate.getDate()).padStart(2, "0");
  const hours = String(referenceDate.getHours()).padStart(2, "0");
  const minutes = String(referenceDate.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}