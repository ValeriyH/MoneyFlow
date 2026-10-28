/**
 * amountExpression.js — parsing the value in the amount field.
 *
 * A user can write "120+80+50" or "1250/2" — convenient when
 * accumulating small purchases in one field. The calculation result
 * is the number that goes into the table.
 *
 * Important: the expression is NOT evaluated via eval(). It uses a custom
 * recursive parser that only accepts numbers, four operators, and parentheses.
 * No arbitrary JavaScript from the field can be executed.
 *
 *
 */
/** Maximum length before the expression is rejected — protection against stuck input. */
const MAX_EXPRESSION_LENGTH = 40;
 
const KNOWN_OPERATORS = new Set(['+', '-', '*', '/']);
 
/** Parsing error — contains a human-readable reason. */
class AmountExpressionError extends Error {}
 
/**
 * Breaks down a string into tokens.
 * @param {string} expression
 * @returns {Array<{ type: 'number' | 'operator' | 'openParen' | 'closeParen', value?: number | string }> | null}
 *   null if an unknown character is present.
 *
 *
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
 
    // 56,50 and 56.50 are both read as 56.50 — both the Ukrainian
    // and the classical decimal separators are recognized.
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
 * Calculates the value of an already tokenized expression.
 *
 * Grammar:
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := number | '(' expression ')'
 *
 * @param {Array<{ type: string, value?: number | string }>} tokens
 * @returns {number}
 *
 *
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
 * Main entry point: converts field text into a number.
 *
 * @param {string} rawInput
 * @returns {{ status: 'empty' } |
 *           { status: 'valid', value: number, isExpression: boolean } |
 *           { status: 'incomplete', message: string } |
 *           { status: 'invalid', message: string }}
 *   'empty'      — field is empty;
 *   'valid'      — number is ready to be saved;
 *   'incomplete' — expression started but not finished («56+»);
 *   'invalid'    — such expression cannot be accepted.
 *
 *
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
 * Is it possible to append an operator to the current field content.
 * The «+» button doesn't add it if an operator is already there — otherwise
 * it would result in «56++».
 *
 * @param {string} rawInput
 * @returns {boolean}
 *
 *
 */
export function canAppendOperator(rawInput) {
  const trimmedInput = String(rawInput ?? '').trim();
  if (trimmedInput === '') return true;
  return !KNOWN_OPERATORS.has(trimmedInput[trimmedInput.length - 1]);
}