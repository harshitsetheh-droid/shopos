'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSale, buildMasterIndex } = require('../classify');
const { buildGSTR1 } = require('../gstr1');
const { buildGSTR3B, applySetOff } = require('../gstr3b');
const { cfg, sale, line, products, GSTIN_MH } = require('./fixtures');

const idx = buildMasterIndex(products);
const docs = (rows) => rows.map((r) => normalizeSale(r, cfg, idx));

test('3.1(a) receives taxable outward supplies', () => {
  const d = docs([sale({ cust_gstin: GSTIN_MH })]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d.filter((x) => !x.isCancelled), {}, {}, g1, cfg);
  assert.strictEqual(g3.t31.a_taxable.taxablePaise, 10000n);
  assert.ok(g3.t31.a_taxable.cgstPaise > 0n);
  assert.strictEqual(g3.t31.a_taxable.sgstPaise, g3.t31.a_taxable.cgstPaise);
});

test('3.1(c) receives nil/exempt and 3.1(e) receives non-GST supplies', () => {
  const d = docs([
    sale({ id: 'TXN-1', invoice_no: 'B/001',
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isNil: true })], tax: 0, total: 100 }),
    sale({ id: 'TXN-2', invoice_no: 'C/001',
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isNonGst: true })], tax: 0, total: 100 }),
  ]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {}, {}, g1, cfg);
  assert.strictEqual(g3.t31.c_nil_exempt.taxablePaise, 10000n);
  assert.strictEqual(g3.t31.e_non_gst.taxablePaise, 10000n);
  assert.strictEqual(g3.t31.a_taxable.taxablePaise, 0n);
});

test('3.2 captures inter-state supplies to unregistered persons', () => {
  const d = docs([sale({ place_of_supply: '29', is_interstate: true })]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {}, {}, g1, cfg);
  assert.strictEqual(g3.t32.taxablePaise, 10000n);
  assert.ok(g3.t32.igstPaise > 0n);
});

test('3B outward ties to GSTR-1 (balanced = true)', () => {
  const d = docs([
    sale({ id: 'TXN-1', invoice_no: 'A/001', cust_gstin: GSTIN_MH }),
    sale({ id: 'TXN-2', invoice_no: 'A/002' }),
    sale({ id: 'TXN-3', invoice_no: 'B/001',
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isExempt: true })], tax: 0, total: 100 }),
  ]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {}, {}, g1, cfg);
  assert.strictEqual(g3.tieOut.checked, true);
  assert.strictEqual(g3.tieOut.balanced, true,
    `expected tie-out, diff taxable=${g3.tieOut.diffTaxablePaise} diff igst=${g3.tieOut.diffIgstPaise}`);
});

// ── set-off order ───────────────────────────────────────────────────────────
test('IGST credit is consumed against IGST first', () => {
  const r = applySetOff(
    { igst: 100n, cgst: 50n, sgst: 50n, cess: 0n },
    { igst: 80n, cgst: 0n, sgst: 0n, cess: 0n },
    [['igst', 'igst'], ['igst', 'cgst'], ['igst', 'sgst']],
  );
  assert.strictEqual(r.consumed.igst, 80n);
  assert.strictEqual(r.payable.igst, 20n);
  assert.strictEqual(r.payable.cgst, 50n);
});

test('surplus IGST credit spills into CGST then SGST in statutory order', () => {
  const r = applySetOff(
    { igst: 0n, cgst: 40n, sgst: 40n, cess: 0n },
    { igst: 100n, cgst: 0n, sgst: 0n, cess: 0n },
    [['igst', 'igst'], ['igst', 'cgst'], ['igst', 'sgst']],
  );
  // 80p of IGST credit offsets 40 CGST + 40 SGST; the remaining 20p carries forward.
  assert.strictEqual(r.consumed.igst, 80n);
  assert.strictEqual(r.payable.cgst, 0n);
  assert.strictEqual(r.payable.sgst, 0n);
  assert.strictEqual(r.remainingCredit.igst, 20n);
});

test('CGST credit cannot offset SGST liability', () => {
  const { DEFAULT_CONFIG } = require('../config');
  const r = applySetOff(
    { igst: 0n, cgst: 0n, sgst: 50n, cess: 0n },
    { igst: 0n, cgst: 50n, sgst: 0n, cess: 0n },
    DEFAULT_CONFIG.setOffOrder,
  );
  // CGST credit is stranded: it may not be applied to SGST liability
  assert.strictEqual(r.consumed.cgst, 0n);
  assert.strictEqual(r.payable.sgst, 50n);
  assert.strictEqual(r.remainingCredit.cgst, 50n);
});

test('CGST credit offsets CGST liability first, then spills into IGST', () => {
  const { DEFAULT_CONFIG } = require('../config');
  const r = applySetOff(
    { igst: 30n, cgst: 40n, sgst: 0n, cess: 0n },
    { igst: 0n, cgst: 70n, sgst: 0n, cess: 0n },
    DEFAULT_CONFIG.setOffOrder,
  );
  assert.strictEqual(r.consumed.cgst, 70n);
  assert.strictEqual(r.payable.cgst, 0n);
  assert.strictEqual(r.payable.igst, 0n, 'CGST credit may settle IGST after CGST is exhausted');
});

test('SGST credit may not settle CGST liability', () => {
  const { DEFAULT_CONFIG } = require('../config');
  const r = applySetOff(
    { igst: 0n, cgst: 40n, sgst: 0n, cess: 0n },
    { igst: 0n, cgst: 0n, sgst: 40n, cess: 0n },
    DEFAULT_CONFIG.setOffOrder,
  );
  assert.strictEqual(r.consumed.sgst, 0n);
  assert.strictEqual(r.payable.cgst, 40n);
  assert.strictEqual(r.remainingCredit.sgst, 40n);
});

test('credit exceeding liability is retained, not discarded', () => {
  const r = applySetOff(
    { igst: 10n, cgst: 0n, sgst: 0n, cess: 0n },
    { igst: 90n, cgst: 0n, sgst: 0n, cess: 0n },
    [['igst', 'igst']],
  );
  assert.strictEqual(r.payable.igst, 0n);
  assert.strictEqual(r.remainingCredit.igst, 80n);
});

test('Table 4 computes eligible minus reversed minus ineligible = net', () => {
  const d = docs([sale()]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {
    importGoods: 500n, rcm: 200n, others: 100n, reversed: 50n, ineligible: 25n,
    creditByHead: { igst: 700n, cgst: 0n, sgst: 0n },
  }, {}, g1, cfg);
  assert.strictEqual(g3.table4.totalEligible, 800n);
  assert.strictEqual(g3.table4.netAvailable, 725n);
});

test('manual interest is added without corrupting the liability heads', () => {
  const d = docs([sale()]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {}, { interest: 12n, lateFee: 20n }, g1, cfg);
  assert.strictEqual(g3.additions.interest, 12n);
  assert.strictEqual(g3.additions.lateFee, 20n);
  assert.ok(g3.liability.cgst > 0n);
});