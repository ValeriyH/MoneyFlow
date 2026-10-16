/**
 * formatters.js — єдине місце для перетворення сирих значень на текст для UI.
 * Правило: жоден інший модуль не викликає Intl напряму.
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
 * @returns {string} наприклад «1 250 ₴»
 */
export function formatCurrency(amount) {
  return currencyFormatter.format(Math.round((amount + Number.EPSILON) * 100) / 100);
}

/**
 * @param {number} amount
 * @returns {string} наприклад «1,2 тис. ₴»
 */
export function formatCompactCurrency(amount) {
  return compactCurrencyFormatter.format(amount);
}

/**
 * @param {number} ratio — частка, наприклад 0.42
 * @returns {string} наприклад «42%»
 */
export function formatPercentage(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return percentageFormatter.format(ratio);
}

/**
 * Перетворює значення на позитивне відсоткове відхилення зі знаком.
 * @param {number} currentValue
 * @param {number} previousValue
 * @returns {{ percent: number, tone: 'positive' | 'negative' | 'neutral', hasBaseline: boolean }}
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
 * @param {string} periodKey — «2026-10»
 * @returns {string} наприклад «жовтень 2026»
 */
export function formatPeriodTitle(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  return monthTitleFormatter.format(new Date(year, month - 1, 1));
}

/**
 * Перетворює «2026-10-05» на локальну дату без зсуву часового поясу.
 * @param {string} isoDateValue
 * @returns {Date | null}
 */
export function parseIsoDate(isoDateValue) {
  // Беремо лише дату. Запис може прийти з часом —
  // «2026-10-15T09:15» — і дописування власного часу до такого
  // рядка дало б нерозбірливий.
  const datePart = String(isoDateValue ?? '').slice(0, 10);
  const parsedDate = new Date(`${datePart}T00:00:00`);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

/**
 * Час із рядка операції.
 * @param {string} dateTimeValue — «2026-10-15» або «2026-10-15T09:15»
 * @returns {string} «09:15» або порожній рядок, коли часу немає
 */
export function formatClockTime(dateTimeValue) {
  const timeMatch = String(dateTimeValue ?? '').match(/\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
  return timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : '';
}

/**
 * Дата без року: список показує один місяць, а рік уже стоїть
 * у виборі місяця над ним. У рядку таблиці повторювати його —
 * це найдорожче місце на вузькому екрані.
 *
 * @param {string} dateValue — «2026-10-05»
 * @returns {string} наприклад «5 жовт.»
 */
export function formatShortDate(dateValue) {
  const parsedDate = parseIsoDate(dateValue);
  if (!parsedDate) return dateValue;
  return shortDateFormatter.format(parsedDate);
}

/**
 * Розбирає рядок суми, приймаючи і «120», і «1 250,50».
 * @param {string} rawInput
 * @returns {number | null} — null, якщо введено не число
 */
export function parseAmountInput(rawInput) {
  const normalizedInput = rawInput.replace(/\s| /g, "").replace(",", ".");
  if (normalizedInput === "") return null;

  const parsedAmount = Number(normalizedInput);
  return Number.isFinite(parsedAmount) ? parsedAmount : null;
}