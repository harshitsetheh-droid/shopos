'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSale, buildMasterIndex } = require('../classify');
const { buildGSTR1 } = require('../gstr1');
const { buildGSTR3B, applySetOff } = require('../gstr3b');
const { buildReturn } = require('../index');
const { parse2B } = require('../reconcile');
const { cfg, sale, line, products, GSTIN_MH, GSTIN_KA } = require('./fixtures');

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

// Regression: the tie-out counted 3.1(e) non-GST supplies on the GSTR-1 side only
// (they live inside nil_exempt there) and omitted them from the 3B side, so every
// period containing a non-GST bill reported a false imbalance. A correct return
// must never look unbalanced — that trains the filer to ignore the check.
test('the tie-out stays balanced when the period contains a non-GST supply', () => {
  const d = docs([
    sale({ id: 'TXN-1', invoice_no: 'A/001', cust_gstin: GSTIN_MH }),
    sale({ id: 'TXN-2', invoice_no: 'N/001', tax_applied: false,
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isNonGst: true })],
      sub: 100, tax: 0, total: 100 }),
  ]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {}, {}, g1, cfg);
  assert.ok(g3.t31.e_non_gst.taxablePaise > 0n, 'precondition: the bill is non-GST');
  assert.strictEqual(g3.tieOut.diffTaxablePaise, 0n, `diff=${g3.tieOut.diffTaxablePaise}`);
  assert.strictEqual(g3.tieOut.balanced, true);
});

test('the tie-out stays balanced with an export and a credit note together', () => {
  const d = docs([
    sale({ id: 'TXN-1', invoice_no: 'E/001', doc_type: 'export_invoice', supply_type: 'export',
      place_of_supply: '96', is_interstate: true, export_payment_type: 'WPAY',
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 5 })] }),
    sale({ id: 'CN-1', doc_type: 'credit_note', invoice_no: 'CN/001', cust_gstin: GSTIN_MH,
      linked_invoice_no: 'A/001', items: [line({ qty: 1 })] }),
    sale({ id: 'TXN-3', invoice_no: 'A/003' }),
  ]);
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {}, {}, g1, cfg);
  assert.strictEqual(g3.tieOut.balanced, true,
    `diff taxable=${g3.tieOut.diffTaxablePaise} diff igst=${g3.tieOut.diffIgstPaise}`);
});

// ── end-to-end: reconciliation credit must actually reach Table 4 ──────────
// buildReturn passes recon.summary.table4 into buildGSTR3B. When that mapping was
// missing, reconciliation happily accepted credit and GSTR-3B still reported zero
// available ITC — the shop would file a return claiming nothing.
test('reconciliation credit flows through buildReturn into Table 4', () => {
  const sales = [{
    id: 'TXN-1', invoice_no: 'A/001', cust_gstin: GSTIN_MH, place_of_supply: '27',
    is_interstate: false, doc_type: 'tax_invoice', status: 'finalised',
    date: '2026-08-03', tax_applied: true, pay_type: 'paid',
    items: [{ name: 'Rice', qty: 1, price: 1000, gst: 18, cgst: 9, sgst: 9, igst: 0, hsn: '1006' }],
    sub: 1000, tax: 180, total: 1180,
  }];
  const purchases = [{
    supplier_gstin: GSTIN_KA, supplier_invoice_no: 'P/001', date: '2026-08-05',
    purchase_taxable: 500, purchase_cgst: 45, purchase_sgst: 45,
    is_import: false, reverse_charge: false, itc_eligible: true,
  }];
  const twoBPayload = {
    b2b: [{ ctin: GSTIN_KA, inum: 'P/001', idt: '05/08/2026', val: 590, taxval: 500, camt: 45, samt: 45 }],
  };
  const out = buildReturn({
    sales, products, purchases, cfg, period: '2026-08',
    recon2B: parse2B(twoBPayload, cfg),
  });
  assert.strictEqual(out.recon2b.summary.claimable, 9000n, 'precondition: ₹90 accepted');
  assert.strictEqual(out.gstr3b.table4.eligible.others, 9000n, '₹90 must appear under 4(A)(7)');
  assert.strictEqual(out.gstr3b.table4.netAvailable, 9000n);
  assert.strictEqual(out.gstr3b.creditAvail.cgst, 4500n);
  assert.strictEqual(out.gstr3b.creditAvail.sgst, 4500n);
  // Sale liability ₹180 = CGST ₹90 + SGST ₹90. Credit is ₹45 each, so ₹45 of
  // each head stays payable and the IGST head is untouched.
  assert.strictEqual(out.gstr3b.setOff.payable.cgst, 4500n);
  assert.strictEqual(out.gstr3b.setOff.payable.sgst, 4500n);
  assert.strictEqual(out.gstr3b.setOff.payable.igst, 0n);
  assert.strictEqual(out.gstr3b.setOff.consumed.cgst, 4500n);
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

// The cash ledger (challans already paid) was applied to IGST alone, so money
// already paid never reduced CGST/SGST payable and the return overstated what
// was owed. It now offsets every head, in order, from a single balance.
const cashDocs = () => docs([
  sale({ id: 'A', invoice_no: 'A/1', is_interstate: true, place_of_supply: '29',
    items: [line({ qty: 1, price: 100, gst: 0, cgst: 0, sgst: 0, igst: 5 })],
    sub: 100, tax: 5, total: 105 }),
  sale({ id: 'B', invoice_no: 'B/1',
    items: [line({ qty: 1, price: 120, gst: 10, cgst: 5, sgst: 5, igst: 0 })],
    sub: 120, tax: 12, total: 132 }),
]);
const noCredit = {
  others: 0n, creditByHead: { igst: 0n, cgst: 0n, sgst: 0n, cess: 0n },
  reversed: 0n, ineligible: 0n,
};
const flat = (o) => ({ igst: o.igst, cgst: o.cgst, sgst: o.sgst, cess: o.cess });

test('with no cash the full liability is payable', () => {
  const g = buildGSTR3B(cashDocs(), noCredit, { cashBalance: 0n }, null, cfg);
  assert.deepStrictEqual(flat(g.setOff.payable), { igst: 500n, cgst: 600n, sgst: 600n, cess: 0n });
});

test('cash reduces IGST, then CGST, then SGST', () => {
  const g = buildGSTR3B(cashDocs(), noCredit, { cashBalance: 500n }, null, cfg);
  assert.deepStrictEqual(flat(g.setOff.cashUsed), { igst: 500n, cgst: 0n, sgst: 0n, cess: 0n });
  assert.deepStrictEqual(flat(g.setOff.payable), { igst: 0n, cgst: 600n, sgst: 600n, cess: 0n });
});

test('cash beyond IGST is applied to the state heads, not left unspent', () => {
  const g = buildGSTR3B(cashDocs(), noCredit, { cashBalance: 1200n }, null, cfg);
  assert.deepStrictEqual(flat(g.setOff.cashUsed), { igst: 500n, cgst: 600n, sgst: 100n, cess: 0n });
  assert.deepStrictEqual(flat(g.setOff.payable), { igst: 0n, cgst: 0n, sgst: 500n, cess: 0n });
});

test('excess cash never makes a head negative', () => {
  const g = buildGSTR3B(cashDocs(), noCredit, { cashBalance: 5000n }, null, cfg);
  for (const head of ['igst', 'cgst', 'sgst', 'cess']) {
    assert.ok(g.setOff.payable[head] >= 0n, `${head} went negative`);
  }
  const used = flat(g.setOff.cashUsed);
  assert.strictEqual(used.igst + used.cgst + used.sgst + used.cess, 1700n);
});

test('cash is not used while input credit still covers the liability', () => {
  const withCredit = {
    others: 9000n, creditByHead: { igst: 9000n, cgst: 0n, sgst: 0n, cess: 0n },
    reversed: 0n, ineligible: 0n,
  };
  const g = buildGSTR3B(cashDocs(), withCredit, { cashBalance: 500n }, null, cfg);
  assert.deepStrictEqual(flat(g.setOff.payable), { igst: 0n, cgst: 0n, sgst: 0n, cess: 0n });
  assert.deepStrictEqual(flat(g.setOff.cashUsed), { igst: 0n, cgst: 0n, sgst: 0n, cess: 0n });
  assert.strictEqual(g.setOff.remainingCredit.igst, 7300n, 'credit is carried forward');
});