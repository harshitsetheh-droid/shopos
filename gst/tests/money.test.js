'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toPaise, taxOnPaise, fmtPaise, toRupees } = require('../money');

test('toPaise converts rupees to integer paise exactly', () => {
  assert.strictEqual(toPaise('0'), 0n);
  assert.strictEqual(toPaise('105'), 10500n);
  assert.strictEqual(toPaise('10.50'), 1050n);
  assert.strictEqual(toPaise('0.01'), 1n);
  assert.strictEqual(toPaise(-5), -500n);
  assert.strictEqual(toPaise(99.999), 10000n); // half-up on the 3rd decimal
});

test('toPaise rejects garbage instead of silently producing NaN', () => {
  assert.throws(() => toPaise('abc'), TypeError);
  assert.throws(() => toPaise('12abc'), TypeError);
  assert.strictEqual(toPaise(''), 0n);
  assert.strictEqual(toPaise(null), 0n);
});

test('no float arithmetic leaks into paise values', () => {
  // 0.1 + 0.2 must NOT produce 0.30000000000000004 in our money type
  const a = toPaise('0.1');
  const b = toPaise('0.2');
  assert.strictEqual(typeof (a + b), 'bigint');
  assert.strictEqual((a + b).toString(), '30');
});

test('taxOnPaise computes whole-paise tax with half-up rounding', () => {
  assert.strictEqual(taxOnPaise(10000n, 5), 500n);      // 100.00 @5% = 5.00
  assert.strictEqual(taxOnPaise(10500n, 18), 1890n);    // 105.00 @18% = 18.90
  assert.strictEqual(taxOnPaise(10000n, 2.5), 250n);    // fractional slab
  assert.strictEqual(taxOnPaise(10000n, 0.25), 25n);    // 0.25% slab
  assert.strictEqual(taxOnPaise(0n, 18), 0n);
  // 10.05 @ 18% = 1.809 → 181 paise
  assert.strictEqual(taxOnPaise(1005n, 18), 181n);
  // 10.06 @ 18% = 1.8108 → 181 paise
  assert.strictEqual(taxOnPaise(1006n, 18), 181n);
  // 33.33 @ 18% = 5.9994 → 600 paise
  assert.strictEqual(taxOnPaise(3333n, 18), 600n);
});

test('tax split for intra-state is equal CGST + SGST summing to the total tax', () => {
  const taxable = 10000n;
  const rate = 18;
  const total = taxOnPaise(taxable, rate);
  const cgst = taxOnPaise(taxable, rate / 2);
  const sgst = total - cgst;
  assert.strictEqual(cgst + sgst, total);
});

test('fmtPaise renders clean display strings', () => {
  assert.strictEqual(fmtPaise(0n), '0.00');
  assert.strictEqual(fmtPaise(10500n), '105.00');
  assert.strictEqual(fmtPaise(123456n), '1,234.56');
  assert.strictEqual(fmtPaise(-500n), '-5.00');
});

test('toRupees is for display only and is not used in arithmetic', () => {
  assert.strictEqual(toRupees(10500n), 105);
  assert.strictEqual(toRupees(0n), 0);
});