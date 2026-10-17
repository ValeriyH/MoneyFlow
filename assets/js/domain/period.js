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
 * Локальний час у форматі, який приймають поля дати й часу:
 * «2026-10-17T02:49». Дата — перші 10 символів, час — наступні 5.
 *
 * **Єдине місце у проєкті, де будується локальний час для екрана.**
 * Причина, чому воно одне: `toISOString()` за контрактом завжди
 * переводить в UTC — це не наш вибір, а поведінка методу. У Києві
 * (UTC+3) о 00:30 він поверне вчорашню дату, і жодне
 * перезавантаження її не виправить, бо кожне рахуватиме те саме.
 * Тому беремо локальні поля об'єкта `Date`, а не конвертуємо.
 *
 * Секунди не потрібні: у колонці `Дата` лежить `РРРР-ММ-ДДГГ:ХХ`.
 *
 * Для міток, які нікуди не виводяться (`recordedAt`,
 * `lastSyncedAt`), UTC лишається правильним — там важлива
 * монотонність рядка, а не місцевий час.
 *
 * @param {Date} [referenceDate]
 * @returns {string}
 */
export function toLocalIso(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  const day = String(referenceDate.getDate()).padStart(2, "0");
  const hours = String(referenceDate.getHours()).padStart(2, "0");
  const minutes = String(referenceDate.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}
