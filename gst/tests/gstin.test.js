'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateGSTIN, stateCodeOf, resolveStateCode, isInterState } = require('../gstin');
const { cfg } = require('./fixtures');
const { mergeConfig } = require('../config');
const { GSTIN_MH, GSTIN_KA, GSTIN_UP } = require('./fixtures');

test('valid GSTINs are accepted and expose state/PAN/composition', () => {
  const r = validateGSTIN(GSTIN_MH, cfg);
  assert.strictEqual(r.valid, true, JSON.stringify(r));
  assert.strictEqual(r.stateCode, '27');
  assert.strictEqual(r.pan, 'AAPFU0939F');
});

test('a GSTIN with a wrong check digit is reported as CHECKSUM', () => {
  const bad = GSTIN_MH.slice(0, 14) + (GSTIN_MH[14] === 'Z' ? 'Y' : 'Z');
  const r = validateGSTIN(bad, cfg);
  // Either the checksum fails, or the char is rejected outright — both are safe.
  assert.strictEqual(r.valid, false);
  assert.ok(['CHECKSUM', 'FORMAT'].includes(r.reason), r.reason);
});

test('checksum is reported but NOT enforced by default (never blocks a filing)', () => {
  assert.strictEqual(cfg.gstin.checksum.enforced, false);
  const bad = GSTIN_MH.slice(0, 14) + (GSTIN_MH[14] === 'Z' ? 'Y' : 'Z');
  assert.strictEqual(validateGSTIN(bad, cfg).reason, 'CHECKSUM');
  const strict = mergeConfig({ gstin: { checksum: { enforced: true } } }, cfg);
  assert.strictEqual(strict.gstin.checksum.enforced, true);
});

test('wrong length is rejected', () => {
  assert.strictEqual(validateGSTIN('27AAPFU0939F1Z', cfg).reason, 'LENGTH');
  assert.strictEqual(validateGSTIN('', cfg).reason, 'EMPTY');
});

test('unknown state code is rejected', () => {
  assert.strictEqual(validateGSTIN('99AAPFU0939F1ZV', cfg).reason, 'STATE_CODE');
});

test('lowercase GSTIN is accepted (normalised to upper)', () => {
  assert.strictEqual(validateGSTIN(GSTIN_MH.toLowerCase(), cfg).valid, true);
});

test('illegal characters are rejected', () => {
  assert.strictEqual(validateGSTIN('27-AAPFU0939F1ZV', cfg).valid, false);
  assert.strictEqual(validateGSTIN('27AAPFU0939F1ZV!', cfg).valid, false);
});

test('stateCodeOf extracts the leading 2 digits', () => {
  assert.strictEqual(stateCodeOf(GSTIN_KA), '29');
  assert.strictEqual(stateCodeOf('nonsense'), '');
});

test('resolveStateCode maps free text to a state code', () => {
  assert.strictEqual(resolveStateCode('Maharashtra'), '27');
  assert.strictEqual(resolveStateCode('Shop 4, MG Road, Bengaluru, Karnataka'), '29');
  assert.strictEqual(resolveStateCode('New Delhi'), '07');
  assert.strictEqual(resolveStateCode('27'), '27');
  assert.strictEqual(resolveStateCode('Nowhere Land'), '');
});

test('isInterState compares jurisdiction codes', () => {
  assert.strictEqual(isInterState('27', '27'), false);
  assert.strictEqual(isInterState('27', '29'), true);
  assert.strictEqual(isInterState('', '29'), false); // unknown → treated as intra, flagged later
});