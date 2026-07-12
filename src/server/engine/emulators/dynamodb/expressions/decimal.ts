// Exact decimal-string arithmetic for DynamoDB N values. Numbers travel the
// wire as strings and must stay strings end-to-end: `ADD` / `SET a = a + :v`
// and sort-key comparisons operate on the decimal text directly (BigInt
// coefficient + scale), so 0.1 + 0.2 is exactly "0.3" and integers beyond
// 2^53 never lose precision.

import { validationError } from '../../../http/errors.js';

interface Decimal {
  negative: boolean;
  coefficient: bigint; // absolute significand, no decimal point
  scale: number;       // digits after the decimal point (>= 0)
}

const NUMBER_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
// DynamoDB supports magnitudes up to 1E+126 and down to 1E-130; anything the
// wire should never carry is rejected instead of allocating huge BigInts.
const MAX_EXPONENT = 130;

function parseDecimal(text: string): Decimal {
  const match = NUMBER_PATTERN.exec(text.trim());
  const intPart = match?.[2] ?? '';
  const fracPart = match?.[3] ?? '';
  if (!match || intPart.length + fracPart.length === 0) {
    throw validationError(`The parameter cannot be converted to a numeric value: ${text}`);
  }
  let coefficient = BigInt(intPart + fracPart);
  let scale = fracPart.length;
  const exponent = match[4] ? parseInt(match[4], 10) : 0;
  if (coefficient !== 0n && Math.abs(exponent) > MAX_EXPONENT) {
    const bound = exponent > 0 ? 'larger' : 'smaller';
    throw validationError(`Number ${exponent > 0 ? 'overflow' : 'underflow'}. Attempting to store a number with magnitude ${bound} than supported range`);
  }
  if (exponent > 0) {
    if (exponent >= scale) {
      coefficient *= 10n ** BigInt(exponent - scale);
      scale = 0;
    } else {
      scale -= exponent;
    }
  } else if (exponent < 0) {
    scale += -exponent;
  }
  return { negative: match[1] === '-' && coefficient !== 0n, coefficient, scale };
}

function renderDecimal(dec: Decimal): string {
  let { coefficient, scale } = dec;
  if (coefficient === 0n) return '0';
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  const digits = coefficient.toString();
  let text: string;
  if (scale === 0) {
    text = digits;
  } else if (digits.length <= scale) {
    text = `0.${digits.padStart(scale, '0')}`;
  } else {
    text = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  }
  return dec.negative ? `-${text}` : text;
}

// Signed coefficients of both operands brought to a common scale.
function aligned(a: string, b: string): { left: bigint; right: bigint; scale: number } {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  const scale = Math.max(da.scale, db.scale);
  const left = (da.negative ? -da.coefficient : da.coefficient) * 10n ** BigInt(scale - da.scale);
  const right = (db.negative ? -db.coefficient : db.coefficient) * 10n ** BigInt(scale - db.scale);
  return { left, right, scale };
}

function fromSigned(value: bigint, scale: number): string {
  return renderDecimal({ negative: value < 0n, coefficient: value < 0n ? -value : value, scale });
}

export function addDecimals(a: string, b: string): string {
  const { left, right, scale } = aligned(a, b);
  return fromSigned(left + right, scale);
}

export function subtractDecimals(a: string, b: string): string {
  const { left, right, scale } = aligned(a, b);
  return fromSigned(left - right, scale);
}

export function compareDecimals(a: string, b: string): number {
  const { left, right } = aligned(a, b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// Canonical form ("01.10" → "1.1") — used to normalize N values and NS
// members so equality matches DynamoDB's numeric semantics.
export function normalizeDecimal(text: string): string {
  return renderDecimal(parseDecimal(text));
}
