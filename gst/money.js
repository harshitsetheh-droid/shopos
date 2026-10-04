'use strict';
/**
 * Money helpers. Core Rule 4: all money is integer PAISE. No floats.
 * Every value entering or leaving the GST engine is a BigInt-safe integer.
 */

const Paise = BigInt(100);

/** Convert rupees (number|string|bigint|decimal-string) → integer paise. Rounds half-up. */
function toPaise(rupees) {
  if (rupees === null || rupees === undefined || rupees === '') return 0n;
  if (typeof rupees === 'bigint') return rupees * Paise;
  const s = String(rupees).trim();
  if (!s) return 0n;
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new TypeError(`toPaise: invalid money value "${rupees}"`);
  }
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const [whole, frac = ''] = abs.split('.');
  // Paise need 2 decimal places; the 3rd digit decides half-up rounding.
  const frac3 = (frac.slice(0, 3) + '000').slice(0, 3);
  const paiseFromFrac = BigInt(frac3.slice(0, 2) || '0');
  const roundUp = frac3[2] >= '5';
  const paise = BigInt(whole) * Paise + paiseFromFrac + (roundUp ? 1n : 0n);
  return neg ? -paise : paise;
}

/** Integer paise → rupees Number (for display only). Never feed this back into math. */
function toRupees(paise) {
  const p = typeof paise === 'bigint' ? paise : BigInt(paise || 0);
  return Number(p) / 100;
}

/** Format integer paise as a display string. */
function fmtPaise(paise) {
  const p = typeof paise === 'bigint' ? paise : BigInt(paise || 0);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = abs / Paise;
  const frac = abs % Paise;
  const fracStr = frac.toString().padStart(2, '0');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + wholeStr + '.' + fracStr;
}

/** Round a BigInt paise value (no-op, provided for symmetry/readability). */
function roundPaise(paise) {
  return typeof paise === 'bigint' ? paise : BigInt(Math.round(Number(paise) || 0));
}

/**
 * Compute tax on a taxable paise amount at a given rate, half-up on paise.
 * ratePct may be fractional (e.g. 2.5, 0.25). Uses scaled integers, no floats.
 */
function taxOnPaise(taxablePaise, ratePct) {
  const amt = typeof taxablePaise === 'bigint' ? taxablePaise : BigInt(taxablePaise || 0);
  const rateNum = BigInt(String(ratePct).split('.')[0] || 0);
  const rateDec = (String(ratePct).split('.')[1] || '').padEnd(6, '0').slice(0, 6);
  // rate = rateNum/100 + rateDec/1e6  → store as numerator/1e6
  const rateScaled = rateNum * 1000000n + BigInt(rateDec);
  const num = amt * rateScaled;
  const den = 100n * 1000000n;
  const q = num / den;
  const r = num % den;
  // half-up rounding
  return (r * 2n >= den) ? q + 1n : q;
}

/** Sum array of bigint/number paise. */
function sumPaise(list) {
  return (list || []).reduce((a, b) => a + (typeof b === 'bigint' ? b : BigInt(b || 0)), 0n);
}

/** Safe conversion for DB / JSON boundaries: paise → integer string. */
function paiseToStr(paise) {
  return (typeof paise === 'bigint' ? paise : BigInt(paise || 0)).toString();
}

module.exports = {
  Paise,
  toPaise,
  toRupees,
  fmtPaise,
  roundPaise,
  taxOnPaise,
  sumPaise,
  paiseToStr,
};