/**
 * formatters.js — the single place for converting raw values into text for the UI.
 * Rule: no other module calls Intl directly.
 *
 *
 */
 
const currencyFormatter = new Intl.NumberFormat("uk-UA", {
  style: "currency",
  currency: "UAH",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
 
const compactCurrencyFormatter = new Intl.NumberFormat("uk-UA", {
  style: "currency",
  currency: "UAH",
  notation: "compact",
  maximumFractionDigits: 1,
});
 
const percentageFormatter = new Intl.NumberFormat("uk-UA", {
  style: "percent",
  maximumFractionDigits: 0,
});
 
const monthTitleFormatter = new Intl.DateTimeFormat("uk-UA", {
  month: "long",
  year: "numeric",
});
 
const shortDateFormatter = new Intl.DateTimeFormat("uk-UA", {
  day: "numeric",
  month: "short",
});
 
/**
 * @param {number} amount
 * @returns {string} e.g., "1 250 ₴"
 *
 *
 */
export function formatCurrency(amount) {
  return currencyFormatter.format(Math.round((amount + Number.EPSILON) * 100) / 100);
}
 
/**
 * @param {number} amount
 * @returns {string} e.g., "1,2 тис. ₴"
 *
 *
 */
export function formatCompactCurrency(amount) {
  return compactCurrencyFormatter.format(amount);
}
 
/**
 * @param {number} ratio — fraction, e.g., 0.42
 * @returns {string} e.g., "42%"
 *
 *
 */
export function formatPercentage(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return percentageFormatter.format(ratio);
}
 
/**
 * Converts a value into a positive percentage deviation with a sign.
 * @param {number} currentValue
 * @param {number} previousValue
 * @returns {{ percent: number, tone: 'positive' | 'negative' | 'neutral', hasBaseline: boolean }}
 *
 *
 */
export function describeChangeRate(currentValue, previousValue) {
  if (!previousValue) {
    return { percent: 0, tone: "neutral", hasBaseline: false };
  }
 
  const percent = (currentValue - previousValue) / Math.abs(previousValue);
 
  if (Math.abs(percent) < 0.005) {
    return { percent: 0, tone: "neutral", hasBaseline: true };
  }
 
  return {
    percent,
    tone: percent < 0 ? "positive" : "negative",
    hasBaseline: true,
  };
}
 
/**
 * @param {string} periodKey — "2026-10"
 * @returns {string} e.g., "жовтень 2026"
 *
 *
 */
export function formatPeriodTitle(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  return monthTitleFormatter.format(new Date(year, month - 1, 1));
}
 
/**
 * Converts "2026-10-05" to a local date without time zone shift.
 * @param {string} isoDateValue
 * @returns {Date | null}
 *
 *
 */
export function parseIsoDate(isoDateValue) {
  // We take only the date. If time is included —
  // "2026-10-15T09:15" — appending own time to such
  // a string would yield an unreadable result.
  const datePart = String(isoDateValue ?? '').slice(0, 10);
  const parsedDate = new Date(`${datePart}T00:00:00`);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}
 
/**
 * Time from an operation string.
 * @param {string} dateTimeValue — "2026-10-15" or "2026-10-15T09:15"
 * @returns {string} "09:15" or empty string if no time
 *
 *
 */
export function formatClockTime(dateTimeValue) {
  const timeMatch = String(dateTimeValue ?? '').match(/\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
  return timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : '';
}
 
/**
 * Date without the year: the list shows one month, and the year is
 * already in the month selection above it. Repeating it in the
 * row is the most expensive place on a narrow screen.
 *
 * @param {string} dateValue — "2026-10-05"
 * @returns {string} e.g., "5 жовт."
 *
 *
 */
export function formatShortDate(dateValue) {
  const parsedDate = parseIsoDate(dateValue);
  if (!parsedDate) return dateValue;
  return shortDateFormatter.format(parsedDate);
}
 
/**
 * Parses an amount string, accepting both "120" and "1 250,50".
 * @param {string} rawInput
 * @returns {number | null} — null if input is not a number
 *
 *
 */
export function parseAmountInput(rawInput) {
  const normalizedInput = rawInput.replace(/\s| /g, "").replace(",", ".");
  if (normalizedInput === "") return null;
 
  const parsedAmount = Number(normalizedInput);
  return Number.isFinite(parsedAmount) ? parsedAmount : null;
}