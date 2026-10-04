/**
 * gst/config.js — the single source of truth for rates, thresholds, due dates,
 * digit rules and the schema version.
 *
 * The point of these tests is that nothing legal is buried in code: if a value
 * can be read from config, it must be, and mergeConfig must not silently drop
 * the defaults when a caller passes only overrides.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mergeConfig, DEFAULT_CONFIG, STATE_CODES, GSTR1_SCHEMA_VERSION } = require('../config');

test('mergeConfig with no overrides returns the full defaults', () => {
  // Regression: base used to default to undefined, so mergeConfig({}) returned
  // {} and every consumer of the endpoint silently saw an empty config.
  const m = mergeConfig({});
  assert.ok(Object.keys(m).length > 5, `only ${Object.keys(m).length} keys`);
  assert.strictEqual(m.thresholds.b2cLargeInvoiceValue, DEFAULT_CONFIG.thresholds.b2cLargeInvoiceValue);
  assert.strictEqual(m.dueDates.gstr1Monthly, DEFAULT_CONFIG.dueDates.gstr1Monthly);
  assert.ok(Array.isArray(m.rates) && m.rates.length > 0);
  assert.ok(Array.isArray(m.setOffOrder) && m.setOffOrder.length > 0);
  assert.ok(Array.isArray(m.documents) && m.documents.length > 0);
});

test('every rule the engine reads has a default value', () => {
  const m = mergeConfig({});
  const expected = [
    'schemaVersion', 'business', 'filing', 'financialYear', 'gstin', 'hsn',
    'invoice', 'thresholds', 'setOffOrder', 'rates', 'cess', 'dueDates',
    'reconciliation', 'exemptions', 'exports', 'nilRated', 'documents',
  ];
  for (const k of expected) assert.ok(k in m, `missing config key: ${k}`);
});

test('an override replaces one key without disturbing its siblings', () => {
  const m = mergeConfig({ thresholds: { b2cLargeInvoiceValue: 5 } });
  assert.strictEqual(m.thresholds.b2cLargeInvoiceValue, 5);
  assert.strictEqual(
    m.thresholds.eInvoiceTurnoverRupees,
    DEFAULT_CONFIG.thresholds.eInvoiceTurnoverRupees,
    'sibling threshold was lost',
  );
});

test('an explicit base overrides the default base', () => {
  const custom = mergeConfig({ a: 1 }, { a: 0, b: 2 });
  assert.deepStrictEqual(custom, { a: 1, b: 2 });
});

test('arrays are replaced wholesale, not merged element-wise', () => {
  const m = mergeConfig({ rates: [0, 18] });
  assert.deepStrictEqual(m.rates, [0, 18]);
});

test('the schema version is a single named constant', () => {
  assert.strictEqual(mergeConfig({}).schemaVersion, GSTR1_SCHEMA_VERSION);
  assert.match(GSTR1_SCHEMA_VERSION, /^gstr1-offline-[\d.]+$/);
});

test('the e-invoice threshold lives in config rather than an inline fallback', () => {
  // It used to be read as `config.thresholds.eInvoiceTurnoverRupees ?? 50000000`,
  // which meant deleting the key silently restored a hardcoded number.
  assert.strictEqual(typeof DEFAULT_CONFIG.thresholds.eInvoiceTurnoverRupees, 'number');
  const m = mergeConfig({ thresholds: { eInvoiceTurnoverRupees: 42 } });
  assert.strictEqual(m.thresholds.eInvoiceTurnoverRupees, 42);
});

test('set-off order encodes the statutory head restrictions', () => {
  const order = mergeConfig({}).setOffOrder;
  const has = (c, l) => order.some(([a, b]) => a === c && b === l);
  assert.ok(has('cess', 'cess'), 'cess must settle first');
  assert.ok(has('igst', 'igst') && has('igst', 'cgst') && has('igst', 'sgst'));
  assert.ok(has('cgst', 'cgst') && has('cgst', 'igst'));
  assert.ok(has('sgst', 'sgst') && has('sgst', 'igst'));
  assert.ok(!has('cgst', 'sgst'), 'CGST credit must never settle SGST liability');
  assert.ok(!has('sgst', 'cgst'), 'SGST credit must never settle CGST liability');
});

test('HSN digit rules are ordered from lowest turnover to highest', () => {
  const { digitsByTurnover } = mergeConfig({}).hsn;
  let prev = -1;
  for (const b of digitsByTurnover) {
    assert.ok(b.upto > prev, 'brackets must ascend');
    assert.ok(b.digits >= 4, 'HSN is never shorter than 4 digits');
    prev = b.upto;
  }
});

test('every state code is two digits and uniquely named', () => {
  const seen = new Set();
  for (const [code, name] of Object.entries(STATE_CODES)) {
    assert.match(code, /^\d{2}$/, `bad state code ${code}`);
    assert.ok(!seen.has(name), `duplicate state name ${name}`);
    seen.add(name);
  }
});

test('document types name themselves, and non-return types are flagged', () => {
  for (const d of mergeConfig({}).documents) {
    assert.match(d.value, /^[a-z_]+$/, `bad doc type ${d.value}`);
    assert.ok(d.label, `doc type ${d.value} has no label`);
    assert.strictEqual(typeof d.inReturn, 'boolean');
  }
});

test('DEFAULT_CONFIG is frozen so nothing can mutate the legal defaults at runtime', () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.throws(() => { 'use strict'; DEFAULT_CONFIG.thresholds.b2cLargeInvoiceValue = 1; });
});

test('mergeConfig does not leak a write into the frozen defaults', () => {
  const m = mergeConfig({ thresholds: { b2cLargeInvoiceValue: 7 } });
  m.thresholds.b2cLargeInvoiceValue = 9;
  assert.strictEqual(DEFAULT_CONFIG.thresholds.b2cLargeInvoiceValue, 100000);
});