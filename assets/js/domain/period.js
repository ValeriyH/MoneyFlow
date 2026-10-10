/**
 * period.js — робота з місяцями як з ключами «РРРР-ММ».
 * Єдине місце, де живе календарна математика.
 */

/**
 * @param {Date} [referenceDate]
 * @returns {string} ключ поточного місяця, наприклад «2026-10»
 */
export function currentPeriodKey(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * @param {string} periodKey — «2026-10»
 * @param {number} offsetInMonths
 * @returns {string}
 */
export function shiftPeriodKey(periodKey, offsetInMonths) {
  const [year, month] = periodKey.split("-").map(Number);
  const shiftedDate = new Date(year, month - 1 + offsetInMonths, 1);
  return currentPeriodKey(shiftedDate);
}

/**
 * Скільки днів уже минуло в місяці станом на сьогодні.
 * Для завершених місяців — повна довжина, для майбутніх — нуль.
 *
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {number}
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
 */
export function daysInPeriod(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

/**
 * Скільки днів залишилося до кінця місяця включно з сьогоднішнім.
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 * @returns {number}
 */
export function remainingDaysInPeriod(periodKey, referenceDate = new Date()) {
  const totalDays = daysInPeriod(periodKey);
  const elapsedDays = elapsedDaysInPeriod(periodKey, referenceDate);
  return Math.max(totalDays - elapsedDays, 0);
}

/**
 * Чи збігається місяць із поточним — від цього залежить,
 * чи показувати «прогноз на кінець місяця».
 * @param {string} periodKey
 * @param {Date} [referenceDate]
 */
export function isCurrentPeriod(periodKey, referenceDate = new Date()) {
  return periodKey === currentPeriodKey(referenceDate);
}

/**
 * @param {Date} [referenceDate]
 * @returns {string} сьогоднішня дата у форматі, який приймає `<input type="date">`
 */
export function todayAsIsoDate(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  const day = String(referenceDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}