// Tokenizer for the (frozen) DynamoDB expression grammar. Shared by the key
// condition, condition/filter, update and projection parsers. Keywords stay
// `ident` tokens — the parsers match them case-insensitively where the
// grammar expects one, so attributes named e.g. "and" still work behind `#`
// placeholders while bare `AND`/`and` both parse as the operator.

import { validationError } from '../../../http/errors.js';

export type TokenType =
  | 'ident'    // attribute name, keyword or function name
  | 'name'     // #placeholder
  | 'value'    // :placeholder
  | 'number'   // digit run (only valid inside [ ] list indexes)
  | 'lparen' | 'rparen' | 'lbracket' | 'rbracket'
  | 'comma' | 'dot' | 'plus' | 'minus'
  | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'
  | 'eof';

export interface Token {
  type: TokenType;
  text: string;
}

export type ComparatorType = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export const COMPARATOR_SYMBOL: Record<ComparatorType, '=' | '<>' | '<' | '<=' | '>' | '>='> = {
  eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=',
};

// AWS-shaped syntax error: token text plus a small window of surrounding
// tokens as the "near" context.
export function syntaxError(label: string, tokens: Token[], index: number): never {
  const token = tokens[Math.min(index, tokens.length - 1)];
  const text = token.type === 'eof' ? '<EOF>' : token.text;
  const near = tokens
    .slice(Math.max(0, index - 1), index + 2)
    .map((t) => (t.type === 'eof' ? '<EOF>' : t.text))
    .join(' ');
  throw validationError(`Invalid ${label}: Syntax error; token: "${text}", near: "${near || text}"`);
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

const SINGLE_CHAR: Record<string, TokenType> = {
  '(': 'lparen', ')': 'rparen', '[': 'lbracket', ']': 'rbracket',
  ',': 'comma', '.': 'dot', '+': 'plus', '-': 'minus', '=': 'eq',
};

export function tokenize(expression: string, label: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < expression.length) {
    const ch = expression[pos];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      pos += 1;
      continue;
    }
    if (ch === '#' || ch === ':') {
      let end = pos + 1;
      while (end < expression.length && IDENT_PART.test(expression[end])) end += 1;
      if (end === pos + 1) {
        tokens.push({ type: 'ident', text: ch });
        syntaxError(label, [...tokens, { type: 'eof', text: '' }], tokens.length - 1);
      }
      tokens.push({ type: ch === '#' ? 'name' : 'value', text: expression.slice(pos, end) });
      pos = end;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let end = pos + 1;
      while (end < expression.length && IDENT_PART.test(expression[end])) end += 1;
      tokens.push({ type: 'ident', text: expression.slice(pos, end) });
      pos = end;
      continue;
    }
    if (DIGIT.test(ch)) {
      let end = pos + 1;
      while (end < expression.length && DIGIT.test(expression[end])) end += 1;
      tokens.push({ type: 'number', text: expression.slice(pos, end) });
      pos = end;
      continue;
    }
    if (ch === '<') {
      const next = expression[pos + 1];
      if (next === '>') {
        tokens.push({ type: 'ne', text: '<>' });
        pos += 2;
      } else if (next === '=') {
        tokens.push({ type: 'le', text: '<=' });
        pos += 2;
      } else {
        tokens.push({ type: 'lt', text: '<' });
        pos += 1;
      }
      continue;
    }
    if (ch === '>') {
      if (expression[pos + 1] === '=') {
        tokens.push({ type: 'ge', text: '>=' });
        pos += 2;
      } else {
        tokens.push({ type: 'gt', text: '>' });
        pos += 1;
      }
      continue;
    }
    const single = SINGLE_CHAR[ch];
    if (single) {
      tokens.push({ type: single, text: ch });
      pos += 1;
      continue;
    }
    tokens.push({ type: 'ident', text: ch });
    syntaxError(label, [...tokens, { type: 'eof', text: '' }], tokens.length - 1);
  }
  tokens.push({ type: 'eof', text: '' });
  return tokens;
}

// Case-insensitive keyword check on an ident token (AND/OR/NOT/BETWEEN/IN/
// SET/REMOVE/ADD/DELETE are keywords; function names are case-sensitive).
export function isKeyword(token: Token, keyword: string): boolean {
  return token.type === 'ident' && token.text.toUpperCase() === keyword;
}
