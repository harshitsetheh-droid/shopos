'use strict';
/**
 * Generates GSTINs whose check digit matches gst/gstin.js, and prints them so
 * test fixtures can use syntactically valid, self-consistent GSTINs.
 *
 * These are SYNTHETIC test values — they are not real registrations.
 */
const { validateGSTIN } = require('../gstin');
const { mergeConfig, DEFAULT_CONFIG } = require('../config');

const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FACTORS = [1, 2, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 59, 67];

function checkDigit(base14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = ALPHA.indexOf(base14[i]);
    if (v < 0) throw new Error(`bad char at ${i}: ${base14[i]}`);
    let addend = (v * FACTORS[i]) % 36;
    if (addend > 9) addend = Math.floor(addend / 10) + addend;
    sum += addend;
  }
  return ALPHA[(36 - (sum % 36)) % 36];
}

function makeGstin(stateCode, pan, entity) {
  const base = `${stateCode}${pan}${entity}Z`;
  if (base.length !== 14) throw new Error(`base must be 14 chars, got ${base.length}`);
  return base + checkDigit(base);
}

const cfg = mergeConfig({ business: { gstin: '', stateCode: '27' } }, DEFAULT_CONFIG);

const samples = [
  ['27', 'AAPFU0939F', '1', 'MH'],
  ['29', 'AAGCB7383J', '1', 'KA'],
  ['09', 'AAJCB5618M', '1', 'UP'],
  ['07', 'AAACA1234B', '1', 'DL'],
  ['33', 'AABCU9999A', '1', 'TN'],
  ['27', 'AAACD5678D', 'C', 'MH-comp'],
];

const out = {};
for (const [st, pan, ent, label] of samples) {
  const g = makeGstin(st, pan, ent);
  const r = validateGSTIN(g, cfg);
  console.log(`${label.padEnd(9)} ${g}  valid=${r.valid}${r.valid ? '' : ' (' + r.reason + ')'}`);
  out[label] = g;
}
module.exports = out;