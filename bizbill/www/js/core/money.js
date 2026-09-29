// Exact money / quantity arithmetic.
//
// All monetary values are stored as integer paise (1 rupee = 100 paise).
// All quantities are stored as integer milli-units (1 unit = 1000).
// Percentages (GST %, discount %) are handled as integer basis points
// (18% = 1800 bp) so that no floating point value ever enters a total.
// Intermediate products go through BigInt so large quantities x rates
// cannot overflow Number's 53-bit integer range.
//
// Rounding policy (used everywhere): round half away from zero.

export const QTY_SCALE = 1000;

/** Round (a * b) / c to the nearest integer, half away from zero. */
export function mulDivRound(a, b, c) {
  const A = BigInt(Math.trunc(a));
  const B = BigInt(Math.trunc(b));
  const C = BigInt(Math.trunc(c));
  if (C === 0n) throw new RangeError('division by zero');
  let num = A * B;
  let den = C;
  if (den < 0n) { num = -num; den = -den; }
  const neg = num < 0n;
  if (neg) num = -num;
  let q = num / den;
  const r = num % den;
  if (r * 2n >= den) q += 1n;
  return Number(neg ? -q : q);
}

/** Integer division rounding half away from zero. */
export function divRound(a, b) {
  return mulDivRound(a, 1, b);
}

/** Percent number (e.g. 18, 0.25, 12.5) -> basis points integer. */
export function pctToBp(pct) {
  const n = typeof pct === 'string' ? parseDecimal(pct, 2) : Math.round(Number(pct || 0) * 100);
  if (!Number.isFinite(n)) return 0;
  return n;
}

/** Apply a basis-point rate to an amount in paise. */
export function applyBp(amountPaise, bp) {
  return mulDivRound(amountPaise, bp, 10000);
}

/**
 * Parse a decimal string ("1,234.56", "-12.5", "  7 ") into an integer
 * scaled by 10^scale without using floating point. Extra decimals are
 * rounded half away from zero. Returns NaN on invalid input.
 */
export function parseDecimal(input, scale) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return NaN;
    input = numberToPlainString(input);
  }
  if (input == null) return NaN;
  let s = String(input).trim().replace(/[,\s₹]/g, '');
  if (s.startsWith('Rs.')) s = s.slice(3);
  if (s === '' || s === '-' || s === '.') return NaN;
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return NaN;
  const neg = m[1] === '-';
  const intPart = m[2] || '0';
  let frac = m[3] || '';
  let roundUp = false;
  if (frac.length > scale) {
    roundUp = frac.charCodeAt(scale) - 48 >= 5;
    frac = frac.slice(0, scale);
  }
  frac = frac.padEnd(scale, '0');
  let v = BigInt(intPart + frac);
  if (roundUp) v += 1n;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
  const n = Number(v);
  return neg ? -n : n;
}

function numberToPlainString(n) {
  // Avoid exponent notation for small/large numbers.
  if (Math.abs(n) < 1e21) {
    const s = String(n);
    if (!/e/i.test(s)) return s;
    return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(n);
}

export const toPaise = (v) => {
  const n = parseDecimal(v, 2);
  return Number.isNaN(n) ? 0 : n;
};

export const toQty = (v) => {
  const n = parseDecimal(v, 3);
  return Number.isNaN(n) ? 0 : n;
};

/** Format an integer scaled by 10^scale as a plain decimal string. */
export function scaledToString(value, scale, minDecimals = scale) {
  const v = Math.trunc(Number(value) || 0);
  const neg = v < 0;
  let s = String(Math.abs(v)).padStart(scale + 1, '0');
  let intPart = scale ? s.slice(0, -scale) : s;
  let frac = scale ? s.slice(-scale) : '';
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1);
  return (neg ? '-' : '') + intPart + (frac ? '.' + frac : '');
}

/** Paise -> "1234.50" (for inputs / CSV). */
export const paiseToInput = (p) => scaledToString(p, 2, 2);
/** Qty milli -> "1.5" (for inputs / CSV). */
export const qtyToInput = (q) => scaledToString(q, 3, 0);
/** Basis points -> "18" / "0.25". */
export const bpToPct = (bp) => scaledToString(bp, 2, 0);

/** Group digits the Indian way: 12,34,567. */
export function groupIndian(intStr) {
  if (intStr.length <= 3) return intStr;
  const last3 = intStr.slice(-3);
  let rest = intStr.slice(0, -3);
  const parts = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return parts.join(',') + ',' + last3;
}

export function groupIntl(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format paise for display. opts: {symbol, grouping:'indian'|'intl', decimals}
 */
export function formatMoney(paise, opts = {}) {
  const { symbol = '₹', grouping = 'indian', decimals = 2 } = opts;
  let v = Math.trunc(Number(paise) || 0);
  if (decimals === 0) v = divRound(v, 100) * 100;
  const neg = v < 0;
  const abs = Math.abs(v);
  const intStr = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = grouping === 'intl' ? groupIntl(intStr) : groupIndian(intStr);
  return (neg ? '-' : '') + symbol + grouped + (decimals ? '.' + frac : '');
}

export function formatQty(q, decimals = 3) {
  const v = Math.trunc(Number(q) || 0);
  const str = scaledToString(v, 3, 0);
  if (decimals >= 3) return str;
  // Round to requested decimals for display only.
  const factor = 10 ** (3 - decimals);
  const r = divRound(v, factor);
  return scaledToString(r, decimals, 0);
}

/** qty (milli) x rate (paise per unit) -> paise */
export function qtyTimesRate(qtyMilli, ratePaise) {
  return mulDivRound(qtyMilli, ratePaise, QTY_SCALE);
}

/** Round paise to nearest whole rupee; returns {rounded, roundOff}. */
export function roundToRupee(paise) {
  const rounded = divRound(paise, 100) * 100;
  return { rounded, roundOff: rounded - paise };
}

export function sum(arr, fn = (x) => x) {
  let t = 0;
  for (const x of arr) t += fn(x) || 0;
  return t;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}

/** Indian-system number to words, e.g. 123456 -> "One Lakh Twenty Three Thousand Four Hundred Fifty Six" */
export function intToWordsIndian(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(intToWordsIndian(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}

export function amountInWords(paise, currency = 'Rupees', subunit = 'Paise') {
  const abs = Math.abs(Math.trunc(paise));
  const r = Math.floor(abs / 100);
  const p = abs % 100;
  let s = (paise < 0 ? 'Minus ' : '') + currency + ' ' + intToWordsIndian(r);
  if (p) s += ' and ' + twoDigits(p) + ' ' + subunit;
  return s + ' Only';
}
