// Recursive-descent parser for the four DynamoDB expression kinds. Conditions
// compile straight to predicate closures (parse once, evaluate per item);
// updates and projections compile to action/path structures that index.ts
// applies. Placeholders (#names / :values) are resolved at parse time so
// undefined-placeholder errors surface before any item is touched.

import type { AttributeMap, AttributeValue } from '../../../types.js';
import type { ExpressionContext, ParsedKeyCondition, SortKeyOperator } from './expression-types.js';
import { validationError } from '../../../http/errors.js';
import { COMPARATOR_SYMBOL, isKeyword, syntaxError, tokenize } from './lexer.js';
import type { ComparatorType, Token, TokenType } from './lexer.js';
import {
  attributeValuesEqual, beginsWith, containsValue, orderedCompare, resolvePath, sizeOf, typeOf,
} from './evaluate.js';
import type { AttributeTypeName, DocumentPath } from './evaluate.js';
import { addDecimals, subtractDecimals } from './decimal.js';

export type CompiledPredicate = (item: AttributeMap) => boolean;

export interface SetAction {
  path: DocumentPath;
  // Evaluated against the ORIGINAL item (AWS reads the pre-update image).
  value: (original: AttributeMap) => AttributeValue;
}

export interface ValueAction {
  path: DocumentPath;
  value: AttributeValue;
}

export interface ParsedUpdate {
  sets: SetAction[];
  removes: DocumentPath[];
  adds: ValueAction[];
  deletes: ValueAction[];
}

// An operand as it appears on either side of an operator: a document path, a
// :value literal or size(path). `constant`/`path` carry compile-time shape
// for the semantic checks that need them.
interface Operand {
  resolve(item: AttributeMap): AttributeValue | undefined;
  constant?: AttributeValue;
  path?: DocumentPath;
}

const CONDITION_FUNCTIONS = new Set(['attribute_exists', 'attribute_not_exists', 'attribute_type', 'begins_with', 'contains']);
const UPDATE_FUNCTIONS = new Set(['if_not_exists', 'list_append']);
const COMPARATORS = new Set<TokenType>(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const VALID_TYPE_NAMES = new Set<string>(['S', 'SS', 'N', 'NS', 'B', 'BS', 'BOOL', 'NULL', 'L', 'M']);
const UPDATE_CLAUSES = new Set(['SET', 'REMOVE', 'ADD', 'DELETE']);

// DynamoDB spells types out in operand-type error messages.
const AWS_TYPE_NAMES: Record<AttributeTypeName, string> = {
  S: 'STRING', N: 'NUMBER', B: 'BINARY', BOOL: 'BOOLEAN', NULL: 'NULL',
  L: 'LIST', M: 'MAP', SS: 'STRING SET', NS: 'NUMBER SET', BS: 'BINARY SET',
};

const MAX_IN_OPERANDS = 100;

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(
    expression: string,
    private readonly label: string,
    private readonly ctx: ExpressionContext,
  ) {
    if (expression.trim() === '') {
      throw validationError(`Invalid ${label}: The expression can not be empty;`);
    }
    this.tokens = tokenize(expression, label);
  }

  // -- token plumbing --------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const token = this.peek();
    if (token.type !== 'eof') this.pos += 1;
    return token;
  }

  private expect(type: TokenType): Token {
    if (this.peek().type !== type) this.fail();
    return this.next();
  }

  private fail(): never {
    syntaxError(this.label, this.tokens, this.pos);
  }

  private expectEnd(): void {
    if (this.peek().type !== 'eof') this.fail();
  }

  private semanticError(message: string): never {
    throw validationError(`Invalid ${this.label}: ${message}`);
  }

  private failFunction(name: string): never {
    if (CONDITION_FUNCTIONS.has(name) || UPDATE_FUNCTIONS.has(name) || name === 'size') {
      this.semanticError(`The function is not allowed to be used this way; function: ${name}`);
    }
    this.semanticError(`Invalid function name; function: ${name}`);
  }

  // -- placeholders ----------------------------------------------------------

  private resolveName(token: Token): string {
    const resolved = this.ctx.names?.[token.text];
    if (resolved === undefined) {
      throw validationError(`An expression attribute name used in the document path is not defined; attribute name: ${token.text}`);
    }
    return resolved;
  }

  private resolveValue(token: Token): AttributeValue {
    const value = this.ctx.values?.[token.text];
    if (value === undefined) {
      throw validationError(`An expression attribute value used in expression is not defined; attribute value: ${token.text}`);
    }
    return value;
  }

  // -- document paths --------------------------------------------------------

  private parseAttrName(): string {
    const token = this.peek();
    if (token.type === 'name') {
      this.next();
      return this.resolveName(token);
    }
    if (token.type === 'ident') {
      this.next();
      return token.text;
    }
    this.fail();
  }

  private parsePath(): DocumentPath {
    const path: DocumentPath = [{ attr: this.parseAttrName() }];
    for (;;) {
      if (this.peek().type === 'dot') {
        this.next();
        path.push({ attr: this.parseAttrName() });
      } else if (this.peek().type === 'lbracket') {
        this.next();
        const index = this.expect('number');
        this.expect('rbracket');
        path.push({ index: parseInt(index.text, 10) });
      } else {
        return path;
      }
    }
  }

  // -- operands --------------------------------------------------------------

  private parseOperand(): Operand {
    const token = this.peek();
    if (token.type === 'value') {
      this.next();
      const value = this.resolveValue(token);
      return { resolve: () => value, constant: value };
    }
    if (token.type === 'ident' && this.peek(1).type === 'lparen') {
      if (token.text !== 'size') this.failFunction(token.text);
      this.next();
      this.next();
      const inner = this.parseOperand();
      if (!inner.path) {
        this.semanticError('Operator or function requires a document path; operator or function: size');
      }
      this.expect('rparen');
      return {
        resolve: (item) => {
          const value = inner.resolve(item);
          return value === undefined ? undefined : sizeOf(value);
        },
      };
    }
    if (token.type === 'ident' || token.type === 'name') {
      const path = this.parsePath();
      return { path, resolve: (item) => resolvePath(item, path) };
    }
    this.fail();
  }

  // -- condition / filter expressions ----------------------------------------

  parseCondition(): CompiledPredicate {
    const predicate = this.parseOr();
    this.expectEnd();
    return predicate;
  }

  private parseOr(): CompiledPredicate {
    let left = this.parseAnd();
    while (isKeyword(this.peek(), 'OR')) {
      this.next();
      const lhs = left;
      const rhs = this.parseAnd();
      left = (item) => lhs(item) || rhs(item);
    }
    return left;
  }

  private parseAnd(): CompiledPredicate {
    let left = this.parseNot();
    while (isKeyword(this.peek(), 'AND')) {
      this.next();
      const lhs = left;
      const rhs = this.parseNot();
      left = (item) => lhs(item) && rhs(item);
    }
    return left;
  }

  private parseNot(): CompiledPredicate {
    if (isKeyword(this.peek(), 'NOT')) {
      this.next();
      const child = this.parseNot();
      return (item) => !child(item);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): CompiledPredicate {
    const token = this.peek();
    if (token.type === 'lparen') {
      this.next();
      const inner = this.parseOr();
      this.expect('rparen');
      return inner;
    }
    if (token.type === 'ident' && this.peek(1).type === 'lparen' && CONDITION_FUNCTIONS.has(token.text)) {
      return this.parseConditionFunction();
    }
    const target = this.parseOperand();
    const opToken = this.peek();
    if (COMPARATORS.has(opToken.type)) {
      this.next();
      const right = this.parseOperand();
      const symbol = COMPARATOR_SYMBOL[opToken.type as ComparatorType];
      return (item) => {
        const lhs = target.resolve(item);
        const rhs = right.resolve(item);
        if (lhs === undefined || rhs === undefined) return false;
        if (symbol === '=') return attributeValuesEqual(lhs, rhs);
        if (symbol === '<>') return !attributeValuesEqual(lhs, rhs);
        return orderedCompare(lhs, rhs, symbol);
      };
    }
    if (isKeyword(opToken, 'BETWEEN')) {
      this.next();
      const low = this.parseOperand();
      if (!isKeyword(this.peek(), 'AND')) this.fail();
      this.next();
      const high = this.parseOperand();
      return (item) => {
        const value = target.resolve(item);
        const lo = low.resolve(item);
        const hi = high.resolve(item);
        if (value === undefined || lo === undefined || hi === undefined) return false;
        return orderedCompare(value, lo, '>=') && orderedCompare(value, hi, '<=');
      };
    }
    if (isKeyword(opToken, 'IN')) {
      this.next();
      this.expect('lparen');
      const members = [this.parseOperand()];
      while (this.peek().type === 'comma') {
        this.next();
        members.push(this.parseOperand());
      }
      this.expect('rparen');
      if (members.length > MAX_IN_OPERANDS) {
        this.semanticError(`Too many operands for the operator or function; operator or function: IN, number of operands: ${members.length}`);
      }
      return (item) => {
        const value = target.resolve(item);
        if (value === undefined) return false;
        return members.some((member) => {
          const candidate = member.resolve(item);
          return candidate !== undefined && attributeValuesEqual(value, candidate);
        });
      };
    }
    this.fail();
  }

  private parseFunctionArgs(name: string, expected: number): Operand[] {
    this.expect('lparen');
    const args = [this.parseOperand()];
    while (this.peek().type === 'comma') {
      this.next();
      args.push(this.parseOperand());
    }
    this.expect('rparen');
    if (args.length !== expected) {
      this.semanticError(`Incorrect number of operands for operator or function; operator or function: ${name}, number of operands: ${args.length}`);
    }
    return args;
  }

  private requirePathArg(name: string, arg: Operand): DocumentPath {
    if (!arg.path) {
      this.semanticError(`Operator or function requires a document path; operator or function: ${name}`);
    }
    return arg.path;
  }

  private parseConditionFunction(): CompiledPredicate {
    const name = this.next().text;
    switch (name) {
      case 'attribute_exists':
      case 'attribute_not_exists': {
        const [arg] = this.parseFunctionArgs(name, 1);
        const path = this.requirePathArg(name, arg);
        const wantExists = name === 'attribute_exists';
        return (item) => (resolvePath(item, path) !== undefined) === wantExists;
      }
      case 'attribute_type': {
        const [target, typeArg] = this.parseFunctionArgs(name, 2);
        this.requirePathArg(name, target);
        const typeName = typeArg.constant?.S;
        if (typeName === undefined || !VALID_TYPE_NAMES.has(typeName)) {
          this.semanticError(`Invalid attribute type name found; type: ${typeName ?? ''}, valid types: {B,NULL,SS,BOOL,L,BS,N,NS,S,M}`);
        }
        return (item) => {
          const value = target.resolve(item);
          return value !== undefined && typeOf(value) === typeName;
        };
      }
      case 'begins_with': {
        const [target, prefix] = this.parseFunctionArgs(name, 2);
        return (item) => {
          const value = target.resolve(item);
          const pre = prefix.resolve(item);
          return value !== undefined && pre !== undefined && beginsWith(value, pre);
        };
      }
      // 'contains' — the only remaining member of CONDITION_FUNCTIONS
      default: {
        const [target, operand] = this.parseFunctionArgs(name, 2);
        return (item) => {
          const value = target.resolve(item);
          const member = operand.resolve(item);
          return value !== undefined && member !== undefined && containsValue(value, member);
        };
      }
    }
  }

  // -- key condition expressions ----------------------------------------------

  parseKeyCondition(): ParsedKeyCondition {
    const terms = this.parseKeyTermGroup();
    this.expectEnd();
    if (terms.length > 2) {
      throw validationError('Conditions can be of length 1 or 2 only');
    }
    if (terms.length === 2 && terms[0].name === terms[1].name) {
      throw validationError('KeyConditionExpressions must only contain one condition per key');
    }
    // The schema is unknown here: the partition term is the (first) equality
    // term; the emulator core validates names against the key schema and can
    // swap partition/sort when both terms are equalities.
    const equalityIndex = terms.findIndex((term) => term.operator === '=');
    if (equalityIndex === -1) {
      throw validationError('Query key condition not supported');
    }
    const partitionTerm = terms[equalityIndex];
    const sortTerm = terms.length === 2 ? terms[1 - equalityIndex] : undefined;
    const parsed: ParsedKeyCondition = {
      partition: { name: partitionTerm.name, value: partitionTerm.values[0] },
    };
    if (sortTerm) {
      parsed.sort = { name: sortTerm.name, operator: sortTerm.operator, values: sortTerm.values };
    }
    return parsed;
  }

  private parseKeyTermGroup(): KeyTerm[] {
    const terms: KeyTerm[] = [];
    for (;;) {
      if (this.peek().type === 'lparen') {
        this.next();
        terms.push(...this.parseKeyTermGroup());
        this.expect('rparen');
      } else {
        terms.push(this.parseKeyTerm());
      }
      const token = this.peek();
      if (isKeyword(token, 'AND')) {
        this.next();
        continue;
      }
      if (isKeyword(token, 'OR') || isKeyword(token, 'NOT')) {
        throw validationError(`Invalid operator used in KeyConditionExpression: ${token.text.toUpperCase()}`);
      }
      return terms;
    }
  }

  private parseKeyTerm(): KeyTerm {
    const token = this.peek();
    if (isKeyword(token, 'NOT')) {
      throw validationError('Invalid operator used in KeyConditionExpression: NOT');
    }
    if (token.type === 'ident' && this.peek(1).type === 'lparen') {
      if (token.text !== 'begins_with') {
        if (CONDITION_FUNCTIONS.has(token.text) || token.text === 'size') {
          throw validationError(`Invalid operator used in KeyConditionExpression: ${token.text}`);
        }
        this.failFunction(token.text);
      }
      this.next();
      this.expect('lparen');
      const name = this.parseKeyAttrName();
      this.expect('comma');
      const prefix = this.resolveValue(this.expect('value'));
      this.expect('rparen');
      return { name, operator: 'begins_with', values: [prefix] };
    }
    const name = this.parseKeyAttrName();
    const opToken = this.peek();
    if (opToken.type === 'ne') {
      throw validationError('Invalid operator used in KeyConditionExpression: <>');
    }
    if (COMPARATORS.has(opToken.type)) {
      this.next();
      const value = this.resolveValue(this.expect('value'));
      return { name, operator: COMPARATOR_SYMBOL[opToken.type as ComparatorType] as SortKeyOperator, values: [value] };
    }
    if (isKeyword(opToken, 'BETWEEN')) {
      this.next();
      const low = this.resolveValue(this.expect('value'));
      if (!isKeyword(this.peek(), 'AND')) this.fail();
      this.next();
      const high = this.resolveValue(this.expect('value'));
      return { name, operator: 'BETWEEN', values: [low, high] };
    }
    this.fail();
  }

  // Key attributes are always top-level names — a dotted or indexed path is a
  // syntax error at the offending token.
  private parseKeyAttrName(): string {
    const name = this.parseAttrName();
    if (this.peek().type === 'dot' || this.peek().type === 'lbracket') this.fail();
    return name;
  }

  // -- update expressions ------------------------------------------------------

  parseUpdate(): ParsedUpdate {
    const parsed: ParsedUpdate = { sets: [], removes: [], adds: [], deletes: [] };
    const seen = new Set<string>();
    while (this.peek().type !== 'eof') {
      const keyword = this.peek();
      const clause = keyword.type === 'ident' ? keyword.text.toUpperCase() : '';
      if (!UPDATE_CLAUSES.has(clause)) this.fail();
      if (seen.has(clause)) {
        this.semanticError(`The "${clause}" section can only be used once in an update expression;`);
      }
      seen.add(clause);
      this.next();
      do {
        if (clause === 'SET') parsed.sets.push(this.parseSetAction());
        else if (clause === 'REMOVE') parsed.removes.push(this.parsePath());
        else if (clause === 'ADD') parsed.adds.push(this.parseAddAction());
        else parsed.deletes.push(this.parseDeleteAction());
      } while (this.peek().type === 'comma' && (this.next(), true));
    }
    return parsed;
  }

  private parseSetAction(): SetAction {
    const path = this.parsePath();
    this.expect('eq');
    const first = this.parseSetOperand();
    const opToken = this.peek();
    if (opToken.type === 'plus' || opToken.type === 'minus') {
      this.next();
      const second = this.parseSetOperand();
      const combine = opToken.type === 'plus' ? addDecimals : subtractDecimals;
      return {
        path,
        value: (item) => {
          const lhs = first(item);
          const rhs = second(item);
          if (lhs.N === undefined || rhs.N === undefined) {
            throw validationError('An operand in the update expression has an incorrect data type');
          }
          return { N: combine(lhs.N, rhs.N) };
        },
      };
    }
    return { path, value: first };
  }

  private parseSetOperand(): (item: AttributeMap) => AttributeValue {
    const token = this.peek();
    if (token.type === 'value') {
      this.next();
      const value = this.resolveValue(token);
      return () => value;
    }
    if (token.type === 'ident' && this.peek(1).type === 'lparen') {
      if (token.text === 'if_not_exists') {
        this.next();
        this.next();
        const path = this.parsePath();
        this.expect('comma');
        const fallback = this.parseSetOperand();
        this.expect('rparen');
        return (item) => resolvePath(item, path) ?? fallback(item);
      }
      if (token.text === 'list_append') {
        this.next();
        this.next();
        const first = this.parseSetOperand();
        this.expect('comma');
        const second = this.parseSetOperand();
        this.expect('rparen');
        return (item) => {
          const lhs = first(item);
          const rhs = second(item);
          if (lhs.L === undefined || rhs.L === undefined) {
            throw validationError('An operand in the update expression has an incorrect data type');
          }
          return { L: [...lhs.L, ...rhs.L] };
        };
      }
      this.failFunction(token.text);
    }
    if (token.type === 'ident' || token.type === 'name') {
      const path = this.parsePath();
      return (item) => {
        const value = resolvePath(item, path);
        if (value === undefined) {
          throw validationError('The provided expression refers to an attribute that does not exist in the item');
        }
        return value;
      };
    }
    this.fail();
  }

  private parseAddAction(): ValueAction {
    const path = this.parsePath();
    const value = this.resolveValue(this.expect('value'));
    const type = typeOf(value);
    if (type !== 'N' && type !== 'SS' && type !== 'NS' && type !== 'BS') {
      this.semanticError(`Incorrect operand type for operator or function; operator: ADD, operand type: ${AWS_TYPE_NAMES[type]}`);
    }
    return { path, value };
  }

  private parseDeleteAction(): ValueAction {
    const path = this.parsePath();
    const value = this.resolveValue(this.expect('value'));
    const type = typeOf(value);
    if (type !== 'SS' && type !== 'NS' && type !== 'BS') {
      this.semanticError(`Incorrect operand type for operator or function; operator: DELETE, operand type: ${AWS_TYPE_NAMES[type]}`);
    }
    return { path, value };
  }

  // -- projection expressions ---------------------------------------------------

  parseProjection(): DocumentPath[] {
    const paths = [this.parsePath()];
    while (this.peek().type === 'comma') {
      this.next();
      paths.push(this.parsePath());
    }
    this.expectEnd();
    return paths;
  }
}

interface KeyTerm {
  name: string;
  operator: SortKeyOperator;
  values: AttributeValue[];
}

export function parseConditionExpression(expression: string, ctx: ExpressionContext, label: string): CompiledPredicate {
  return new Parser(expression, label, ctx).parseCondition();
}

export function parseKeyConditionExpression(expression: string, ctx: ExpressionContext): ParsedKeyCondition {
  return new Parser(expression, 'KeyConditionExpression', ctx).parseKeyCondition();
}

export function parseUpdateExpression(expression: string, ctx: ExpressionContext): ParsedUpdate {
  return new Parser(expression, 'UpdateExpression', ctx).parseUpdate();
}

export function parseProjectionExpression(expression: string, ctx: ExpressionContext): DocumentPath[] {
  return new Parser(expression, 'ProjectionExpression', ctx).parseProjection();
}
