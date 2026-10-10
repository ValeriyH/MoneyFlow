/**
 * amountExpression.js — розбір виразу у полі суми.
 *
 * Користувач може написати «120+80+50» або «1250/2» — зручно, коли
 * накопичуєш дрібні покупки в одному полі. Результат обчислення
 * і є тим числом, що потрапить у таблицю.
 *
 * Важливо: вираз НЕ виконується через eval(). Тут власний рекурсивний
 * парсер, який приймає тільки числа, чотири оператори та дужки.
 * Жодного довільного JavaScript з поля виконати не можна.
 */

/** Довжина, вище якої вираз відкидається — захист від залипання. */
const MAX_EXPRESSION_LENGTH = 40;

const KNOWN_OPERATORS = new Set(['+', '-', '*', '/']);

/** Помилка розбору — має зрозумілу людині причину. */
class AmountExpressionError extends Error {}

/**
 * Розбиває рядок на токени.
 * @param {string} expression
 * @returns {Array<{ type: 'number' | 'operator' | 'openParen' | 'closeParen', value?: number | string }> | null}
 *   null, якщо є невідомий символ.
 */
function tokenize(expression) {
  const tokens = [];
  let position = 0;

  while (position < expression.length) {
    const currentCharacter = expression[position];

    if (/\s/.test(currentCharacter)) {
      position += 1;
      continue;
    }

    if (KNOWN_OPERATORS.has(currentCharacter)) {
      tokens.push({ type: 'operator', value: currentCharacter });
      position += 1;
      continue;
    }

    if (currentCharacter === '(') {
      tokens.push({ type: 'openParen' });
      position += 1;
      continue;
    }

    if (currentCharacter === ')') {
      tokens.push({ type: 'closeParen' });
      position += 1;
      continue;
    }

    // 56,50 і 56.50 обидва читаються як 56.50 — український варіант
    // та класичний розділовик однаково зрозумілі людині.
    const numberMatch = /^\d+(?:[.,]\d*)?/.exec(expression.slice(position));
    if (numberMatch) {
      tokens.push({ type: 'number', value: Number(numberMatch[0].replace(',', '.')) });
      position += numberMatch[0].length;
      continue;
    }

    return null;
  }

  return tokens;
}

/**
 * Обчислює значення вже розбитого на токени виразу.
 *
 * Граматика:
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := number | '(' expression ')'
 *
 * @param {Array<{ type: string, value?: number | string }>} tokens
 * @returns {number}
 */
function computeTokensValue(tokens) {
  let cursor = 0;

  const peekToken = () => tokens[cursor];
  const takeToken = () => tokens[cursor++];

  /** @returns {number} */
  function parseExpression() {
    let leftOperand = parseTerm();

    while (peekToken()?.type === 'operator' && ['+', '-'].includes(peekToken().value)) {
      const operator = takeToken().value;
      const rightOperand = parseTerm();
      leftOperand = operator === '+' ? leftOperand + rightOperand : leftOperand - rightOperand;
    }

    return leftOperand;
  }

  /** @returns {number} */
  function parseTerm() {
    let leftOperand = parseFactor();

    while (peekToken()?.type === 'operator' && ['*', '/'].includes(peekToken().value)) {
      const operator = takeToken().value;
      const rightOperand = parseFactor();

      if (operator === '/' && rightOperand === 0) {
        throw new AmountExpressionError('Ділити на нуль не можна');
      }

      leftOperand = operator === '*' ? leftOperand * rightOperand : leftOperand / rightOperand;
    }

    return leftOperand;
  }

  /** @returns {number} */
  function parseFactor() {
    const token = takeToken();

    if (!token) throw new AmountExpressionError('Вираз обірвано — допишіть число');

    if (token.type === 'number') return token.value;

    if (token.type === 'openParen') {
      const valueInsideParens = parseExpression();
      const closingToken = takeToken();

      if (closingToken?.type !== 'closeParen') {
        throw new AmountExpressionError('Немає закритої дужки');
      }

      return valueInsideParens;
    }

    throw new AmountExpressionError('Очікується число');
  }

  const result = parseExpression();

  if (cursor < tokens.length) {
    throw new AmountExpressionError('Зайвий символ у виразі');
  }

  return result;
}

/**
 * Головна точка входу: перетворює текст поля на число.
 *
 * @param {string} rawInput
 * @returns {{ status: 'empty' } |
 *           { status: 'valid', value: number, isExpression: boolean } |
 *           { status: 'incomplete', message: string } |
 *           { status: 'invalid', message: string }}
 *   'empty'      — поле порожнє;
 *   'valid'      — число готове до збереження;
 *   'incomplete' — виказ почато, але не завершено («56+»);
 *   'invalid'    — такий вираз прийняти не можна.
 */
export function evaluateAmountExpression(rawInput) {
  const trimmedInput = String(rawInput ?? '').trim();

  if (trimmedInput === '') return { status: 'empty' };

  if (trimmedInput.length > MAX_EXPRESSION_LENGTH) {
    return { status: 'invalid', message: 'Задовгий вираз' };
  }

  const tokens = tokenize(trimmedInput);
  if (!tokens) {
    return { status: 'invalid', message: 'Незрозумілий символ у виразі' };
  }

  const isExpression = tokens.some((token) => token.type !== 'number');

  try {
    const rawValue = computeTokensValue(tokens);

    if (!Number.isFinite(rawValue)) {
      return { status: 'invalid', message: 'Вираз дав нечисловий результат' };
    }

    return {
      status: 'valid',
      value: Math.round(rawValue * 100) / 100,
      isExpression,
    };
  } catch (error) {
    return {
      status: 'incomplete',
      message: error instanceof AmountExpressionError ? error.message : 'Невірний вираз',
    };
  }
}

/**
 * Чи можна дописати оператор до поточного вмісту поля.
 * Кнопка «+» не додає його, якщо вже стоїть оператор — інакше
 * вийде «56++».
 *
 * @param {string} rawInput
 * @returns {boolean}
 */
export function canAppendOperator(rawInput) {
  const trimmedInput = String(rawInput ?? '').trim();
  if (trimmedInput === '') return true;
  return !KNOWN_OPERATORS.has(trimmedInput[trimmedInput.length - 1]);
}