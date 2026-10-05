'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSale, buildMasterIndex } = require('../classify');
const { buildGSTR1 } = require('../gstr1');
const { buildReturn } = require('../index');
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

// Regression: the DB column is doc_status and the client sends docStatus, but
// normalizeSale only read `status`. Every cancelled invoice in a real return was
// therefore normalised as finalised and its value went into the B2B/B2C totals.
// The test above used the `status` spelling, which is why it passed.
test('doc_status and docStatus are both honoured for cancellation', () => {
  for (const shape of [{ doc_status: 'cancelled' }, { docStatus: 'cancelled' }]) {
    const d = normalizeSale(sale({ id: 'B', invoice_no: 'B/001', ...shape }), cfg, idx);
    assert.strictEqual(d.isCancelled, true, JSON.stringify(shape));
    const g = buildGSTR1([
      normalizeSale(sale({ id: 'A', invoice_no: 'A/001' }), cfg, idx),
      d,
    ], cfg, { period: '2026-08' });
    assert.strictEqual(g.counts.cancelled, 1, JSON.stringify(shape));
    assert.strictEqual(g.b2cs.reduce((a, r) => a + r.taxablePaise, 0n), 10000n, JSON.stringify(shape));
  }
});

test('taxApplied is honoured in either spelling', () => {
  for (const shape of [{ tax_applied: true }, { taxApplied: true }]) {
    const d = normalizeSale(sale({ items: [line({ qty: 1 })], sub: 100, tax: 5, total: 105, ...shape }), cfg, idx);
    assert.ok(d.totals.cgstPaise > 0n || d.totals.sgstPaise > 0n, JSON.stringify(shape));
  }
  for (const shape of [{ tax_applied: false }, { taxApplied: false }]) {
    const d = normalizeSale(sale({ items: [line({ qty: 1 })], sub: 100, tax: 0, total: 100, ...shape }), cfg, idx);
    assert.strictEqual(d.totals.igstPaise, 0n, JSON.stringify(shape));
  }
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

// supply_type is what routes an export, but it is only one signal. A document
// typed export_invoice is an export even if that column is missing or stale —
// otherwise the sale is booked as a domestic B2B supply and IGST to a foreign
// buyer is reported as an ordinary intra-state sale.
test('the document type alone identifies an export', () => {
  const g = build([sale({ doc_type: 'export_invoice', place_of_supply: '96', is_interstate: true,
    items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 5 })] })]);
  assert.strictEqual(g.exp.length, 1, 'must not fall into B2B/B2C');
  assert.strictEqual(g.b2cs.length, 0);
  assert.strictEqual(g.b2b.length, 0);
  assert.ok(g.exp[0].igstPaise > 0n);
});

test('the document type alone identifies a SEZ supply', () => {
  // A SEZ supply is always treated as inter-state, so the line carries IGST.
  const g = build([sale({ doc_type: 'sez_invoice', place_of_supply: '27', is_interstate: true,
    items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 5 })] })]);
  assert.strictEqual(g.sez.length, 1, 'must land in the SEZ table, not the exports table');
  assert.strictEqual(g.exp.length, 0);
  assert.ok(g.sez[0].igstPaise > 0n);
});

// The return is built from raw DB rows, so snake_case is the shape that matters.
// This used to read only the camelCase key and reported every export as WOPAY,
// which puts paid exports into the wrong GSTR-1 8A/8B box on a real filing.
test('export payment status is read from the DB column name', () => {
  const paid = build([sale({ supply_type: 'export', place_of_supply: '96', is_interstate: true,
    export_payment_type: cfg.exports.withPayment })]);
  assert.strictEqual(paid.exp[0].paymentType, 'WPAY');
});

test('export payment status also accepts the client-side camelCase form', () => {
  const paid = build([sale({ supply_type: 'export', place_of_supply: '96', is_interstate: true,
    exportPaymentType: 'WPAY' })]);
  assert.strictEqual(paid.exp[0].paymentType, 'WPAY');
});

test('an export with no recorded payment status falls back to the config default', () => {
  const g = build([sale({ supply_type: 'export', place_of_supply: '96', is_interstate: true })]);
  assert.strictEqual(g.exp[0].paymentType, cfg.exports.withoutPayment);
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

// A credit note only carries the original invoice NUMBER. The billing screen
// never sets original_invoice_period, so amendments used to come out empty in
// practice and the section of GSTR-1 that reports corrections against a filed
// period was silently blank. buildReturn now passes the other periods' documents
// so the original period can be resolved from the linked invoice number.
test('an amendment resolves its original period from the linked invoice number', () => {
  const out = buildReturn({
    sales: [
      sale({ id: 'ORIG', invoice_no: 'A/001', cust_gstin: GSTIN_MH, date: '2026-08-15',
        items: [line({ qty: 1 })], sub: 100, tax: 5, total: 105 }),
      sale({ id: 'CN', doc_type: 'credit_note', invoice_no: 'CN/001', cust_gstin: GSTIN_MH,
        linked_invoice_no: 'A/001', date: '2026-09-20',
        items: [line({ qty: 1 })], sub: -100, tax: -5, total: -105 }),
    ],
    products, cfg, period: '2026-09', lockedPeriods: ['2026-08'],
  });
  assert.strictEqual(out.gstr1.amendments.length, 1);
  const a = out.gstr1.amendments[0];
  assert.strictEqual(a.invoiceNumber, 'CN/001');
  assert.strictEqual(a.originalPeriod, '2026-08');
  assert.strictEqual(a.originalInvoiceNumber, 'A/001');
  assert.strictEqual(out.gstr1.cdnr.length, 1, 'and it still appears in the CDN table');
});

test('a note pointing at an invoice in the same period is not an amendment', () => {
  const out = buildReturn({
    sales: [
      sale({ id: 'A', invoice_no: 'B/001', cust_gstin: GSTIN_MH, date: '2026-09-01',
        items: [line({ qty: 1 })], sub: 100, tax: 5, total: 105 }),
      sale({ id: 'C', doc_type: 'credit_note', invoice_no: 'CN/002', cust_gstin: GSTIN_MH,
        linked_invoice_no: 'B/001', date: '2026-09-20',
        items: [line({ qty: 1 })], sub: -100, tax: -5, total: -105 }),
    ],
    products, cfg, period: '2026-09',
  });
  assert.strictEqual(out.gstr1.amendments.length, 0);
});

test('a note whose linked invoice cannot be found is not an amendment', () => {
  const out = buildReturn({
    sales: [sale({ id: 'C', doc_type: 'credit_note', invoice_no: 'CN/003', cust_gstin: GSTIN_MH,
      linked_invoice_no: 'NEVER-EXISTED', date: '2026-09-20',
      items: [line({ qty: 1 })], sub: -100, tax: -5, total: -105 })],
    products, cfg, period: '2026-09',
  });
  assert.strictEqual(out.gstr1.amendments.length, 0);
});