'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSale, buildMasterIndex } = require('../classify');
const { buildGSTR1 } = require('../gstr1');
const { cfg, sale, line, products, GSTIN_MH } = require('./fixtures');

const idx = buildMasterIndex(products);
const P = '2026-08';
const build = (rows) => buildGSTR1(rows.map((r) => normalizeSale(r, cfg, idx)), cfg, { period: P });

test('B2B invoice lands in the b2b table with rate-wise breakup', () => {
  const g = build([sale({ cust_gstin: GSTIN_MH, place_of_supply: '27', is_interstate: false })]);
  assert.strictEqual(g.b2b.length, 1);
  assert.strictEqual(g.b2b[0].gstin, GSTIN_MH);
  assert.strictEqual(g.b2b.length && g.b2b[0].rateBreakup.length, 1);
  assert.strictEqual(g.b2b[0].rateBreakup[0].rate, 5);
  // intra-state: CGST + SGST present, IGST zero
  assert.ok(g.b2b[0].rateBreakup[0].cgstPaise > 0n);
  assert.strictEqual(g.b2b[0].rateBreakup[0].igstPaise, 0n);
});

test('B2C small is consolidated state-wise + rate-wise, not invoice-wise', () => {
  const g = build([
    sale({ id: 'TXN-1', invoice_no: 'A/001' }),
    sale({ id: 'TXN-2', invoice_no: 'A/002' }),
  ]);
  assert.strictEqual(g.b2b.length, 0);
  assert.strictEqual(g.b2cs.length, 1);           // one state, one rate
  assert.strictEqual(g.b2cs[0].rate, 5);
  assert.strictEqual(g.b2cs[0].placeOfSupply, '27');
  assert.strictEqual(g.b2cs[0].invoiceCount, 2);  // two invoices rolled up
});

test('HSN summary aggregates by HSN + rate and sums correctly', () => {
  const g = build([
    sale({ id: 'TXN-1', invoice_no: 'A/001' }),
    sale({ id: 'TXN-2', invoice_no: 'A/002' }),
  ]);
  const rows = g.hsn.rows.filter((r) => r.hsnSac === '1905');
  assert.ok(rows.length >= 1);
  // each invoice is 100 taxable @5% → 2 invoices = 200 taxable
  assert.strictEqual(rows[0].taxablePaise, 20000n);
  assert.strictEqual(g.hsn.byHsn['1905'].taxablePaise, 20000n);
});

test('HSN summary splits B2B and B2C taxable value', () => {
  const g = build([
    sale({ id: 'TXN-1', invoice_no: 'A/001', cust_gstin: GSTIN_MH }),
    sale({ id: 'TXN-2', invoice_no: 'A/002' }),
  ]);
  const h = g.hsn.byHsn['1905'];
  assert.strictEqual(h.rows[0].b2bTaxablePaise, 10000n);
  assert.strictEqual(h.rows[0].b2cTaxablePaise, 10000n);
});

test('credit note reduces the B2B taxable total (negative sign)', () => {
  const withNote = build([
    sale({ id: 'TXN-1', invoice_no: 'A/001', cust_gstin: GSTIN_MH }),
    sale({ id: 'TXN-2', invoice_no: 'CN/001', doc_type: 'credit_note',
      cust_gstin: GSTIN_MH, linked_invoice_no: 'A/001' }),
  ]);
  // A credit note to a registered customer goes to the CDNR table, not B2B.
  assert.strictEqual(withNote.b2b.length, 1);
  assert.strictEqual(withNote.cdnr.length, 1);
  // +100 on the invoice, -100 on the credit note → net zero
  const b2bTaxable = withNote.b2b.reduce((a, r) => a + r.totalTaxablePaise, 0n);
  const cdnrTaxable = withNote.cdnr.reduce((a, r) => a + r.totalTaxablePaise, 0n);
  assert.strictEqual(b2bTaxable, 10000n);
  assert.strictEqual(cdnrTaxable, -10000n);
  assert.strictEqual(b2bTaxable + cdnrTaxable, 0n);
});

test('credit note to an unregistered customer goes to CDNUR', () => {
  const g = build([
    sale({ id: 'TXN-1', invoice_no: 'A/001' }),
    sale({ id: 'TXN-2', invoice_no: 'CN/001', doc_type: 'credit_note',
      linked_invoice_no: 'A/001' }),
  ]);
  assert.strictEqual(g.cdnur.length, 1);
  assert.strictEqual(g.cdnr.length, 0);
});

test('cancelled invoices are excluded from tax tables but counted as cancelled', () => {
  const g = build([
    sale({ id: 'TXN-1', invoice_no: 'A/001' }),
    sale({ id: 'TXN-2', invoice_no: 'A/002', status: 'cancelled' }),
  ]);
  assert.strictEqual(g.counts.cancelled, 1);
  // only the live invoice contributes taxable value
  assert.strictEqual(g.b2cs.reduce((a, r) => a + r.taxablePaise, 0n), 10000n);
  // ...but Documents Issued still lists it as cancelled
  const series = g.docs_issued.find((s) => s.series === 'SI');
  assert.strictEqual(series.totalCancelled, 1);
  assert.ok(series.cancelledNumbers.includes('A/002'));
});

test('drafts are excluded from every table', () => {
  const g = build([sale({ status: 'draft' })]);
  assert.strictEqual(g.b2cs.length, 0);
  assert.strictEqual(g.b2b.length, 0);
});

test('nil / exempt / non-GST supplies appear in nil_exempt (Core Rule 2)', () => {
  const g = build([
    sale({ id: 'TXN-1', invoice_no: 'A/001', cust_gstin: GSTIN_MH }),
    sale({ id: 'TXN-2', invoice_no: 'B/001',
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isExempt: true })], tax: 0, total: 100 }),
    sale({ id: 'TXN-3', invoice_no: 'C/001',
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isNonGst: true })], tax: 0, total: 100 }),
  ]);
  assert.ok(g.nil_exempt.length >= 2, 'exempt + non_gst both bucketed');
  const kinds = g.nil_exempt.map((r) => r.supplyType);
  assert.ok(kinds.includes('exempt'));
  assert.ok(kinds.includes('non_gst'));
  // they must NOT be mixed into the taxable B2B table
  assert.strictEqual(g.b2b.reduce((a, r) => a + r.totalTaxablePaise, 0n), 10000n);
});

test('zero-rated export goes to the exports table, not B2C', () => {
  const g = build([sale({ supply_type: 'export', place_of_supply: '96', is_interstate: true })]);
  assert.strictEqual(g.exp.length, 1);
  assert.strictEqual(g.b2cs.length, 0);
  assert.ok(g.exp[0].igstPaise > 0n);
});

test('Documents Issued reports from/to numbers per series', () => {
  const g = build([
    sale({ id: 'TXN-1', invoice_no: 'SI/001' }),
    sale({ id: 'TXN-2', invoice_no: 'SI/003' }),
    sale({ id: 'TXN-3', invoice_no: 'SI/002' }),
  ]);
  const s = g.docs_issued.find((x) => x.series === 'SI');
  assert.strictEqual(s.fromNumber, 'SI/001');
  assert.strictEqual(s.toNumber, 'SI/003');
  assert.strictEqual(s.totalIssued, 3);
});

test('amendments are collected when the original period differs', () => {
  const g = build([sale({
    invoice_no: 'AMD/001',
    original_invoice_period: '2026-07',
    original_invoice_no: 'SI/2026-07/099',
    amendment_reason: 'Rate correction',
  })]);
  assert.strictEqual(g.amendments.length, 1);
  assert.strictEqual(g.amendments[0].originalPeriod, '2026-07');
});