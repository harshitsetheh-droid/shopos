'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parse2B, reconcile2B, normInvoiceNo, reconcileBooksVsReturn, annualTurnover, rehydrate2BRows } = require('../reconcile');
const { normalisePurchase } = require('../index');
const { normalizeSale, buildMasterIndex } = require('../classify');
const { buildGSTR1 } = require('../gstr1');
const { buildGSTR3B } = require('../gstr3b');
const { cfg, sale, line, nilLine, products, GSTIN_MH, GSTIN_KA, GSTIN_UP } = require('./fixtures');

const idx = buildMasterIndex(products);

// ── invoice-number normalisation ────────────────────────────────────────────
test('invoice numbers normalise across formatting differences', () => {
  assert.strictEqual(normInvoiceNo('INV-001'), 'INV1');
  assert.strictEqual(normInvoiceNo('inv/001'), 'INV1');
  assert.strictEqual(normInvoiceNo('INV 001'), 'INV1');
  assert.strictEqual(normInvoiceNo('INV.001'), 'INV1');
});

test('leading zeros are stripped so 001 and 1 match', () => {
  assert.strictEqual(normInvoiceNo('AB-0001'), normInvoiceNo('AB-1'));
});

// ── 2B parsing ──────────────────────────────────────────────────────────────
test('parse2B reads the common portal shapes', () => {
  const rows = parse2B({
    b2b: [
      {
        ctin: GSTIN_UP, inv: '001', idt: '2026-08-15', ity: 'R', val: 1180.00,
        taxableVal: 1000.00, igstAmt: 180.00, cgstAmt: 0, sgstAmt: 0, cessAmt: 0,
      },
    ],
  }, cfg);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].gstin, GSTIN_UP);
  assert.strictEqual(rows[0].taxablePaise, 100000n);
  assert.strictEqual(rows[0].igstPaise, 18000n);
  assert.strictEqual(rows[0].itcClaimed, true);
});

// Regression: parse2B only accepted the taxableVal / igstAmt / cgstAmt spellings
// and "inv" for the invoice number. The portal's own offline JSON uses inum /
// taxval / iamt / camt / samt / cessamt, so a genuine 2B file parsed to an empty
// invoice number and all-zero amounts — every row landed in missing_in_books and
// nothing could ever be claimed. This test uses the real portal field names.
test('parse2B reads the actual GST portal field names', () => {
  const rows = parse2B({
    b2b: [{
      ctin: GSTIN_UP, inum: 'INV-001', idt: '15/08/2026', invty: 'R',
      val: 1180.00, taxval: 1000.00, iamt: 0.00, camt: 90.00, samt: 90.00,
      csamt: 0, cessamt: 0, rchrg: 'N', irt: '082026', fdt: '2026-08-15',
    }],
  }, cfg);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].invoiceNo, 'INV-001');
  assert.strictEqual(rows[0].normNo, 'INV1');
  assert.strictEqual(rows[0].invoiceValuePaise, 118000n);
  assert.strictEqual(rows[0].taxablePaise, 100000n);
  assert.strictEqual(rows[0].cgstPaise, 9000n);
  assert.strictEqual(rows[0].sgstPaise, 9000n);
  assert.strictEqual(rows[0].igstPaise, 0n);
  assert.strictEqual(rows[0].invoiceType, 'R');
  assert.strictEqual(rows[0].itcClaimed, true);
});

test('a real 2B row matches the purchase register', () => {
  const p = normalisePurchase({
    supplier_gstin: GSTIN_UP, supplier_invoice_no: 'INV-001', date: '2026-08-15',
    purchase_taxable: 1000, purchase_cgst: 90, purchase_sgst: 90,
  });
  const rows = parse2B({
    b2b: [{ ctin: GSTIN_UP, inum: 'INV-001', idt: '15/08/2026', val: 1180, taxval: 1000, camt: 90, samt: 90 }],
  }, cfg);
  const r = reconcile2B([p], rows, cfg, new Map());
  assert.strictEqual(r.results.length, 1, JSON.stringify(r.results.map((x) => x.bucket)));
  assert.strictEqual(r.results[0].bucket, 'matched');
  assert.strictEqual(r.results[0].decision, 'accept');
  assert.strictEqual(r.summary.claimable, 18000n);
});

// Regression: the uploaded 2B rows were stored parsed, and BigInt paise cannot
// survive JSONB — serialise() writes them out as decimal strings. Re-reading them
// on the next request made reconcile2B evaluate "80000" - 80000n and throw, so the
// whole return failed to build from the second request onwards.
test('2B rows survive a JSON round trip (BigInt becomes a string)', () => {
  const rows = parse2B({
    b2b: [{ ctin: GSTIN_UP, inum: 'INV-001', idt: '15/08/2026', val: 1180, taxval: 1000, camt: 90, samt: 90 }],
  }, cfg);
  const throughJson = JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  assert.strictEqual(typeof throughJson[0].taxablePaise, 'string', 'precondition: stored as a string');

  const books = [normalisePurchase({
    supplier_gstin: GSTIN_UP, supplier_invoice_no: 'INV-001', date: '2026-08-15',
    purchase_taxable: 1000, purchase_cgst: 90, purchase_sgst: 90,
  })];
  assert.doesNotThrow(() => reconcile2B(books, throughJson, cfg, new Map()),
    'a stored 2B row must not throw');

  const r = reconcile2B(books, throughJson, cfg, new Map());
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.results[0].bucket, 'matched');
  assert.strictEqual(r.summary.claimable, 18000n);
});

test('rehydrate2BRows restores BigInt amounts', () => {
  const [row] = rehydrate2BRows([{ gstin: GSTIN_UP, invoiceNo: 'I1', normNo: 'I1',
    taxablePaise: '100000', cgstPaise: 9000, sgstPaise: '9000', igstPaise: 0, cessPaise: null }]);
  assert.strictEqual(row.taxablePaise, 100000n);
  assert.strictEqual(row.cgstPaise, 9000n);
  assert.strictEqual(row.sgstPaise, 9000n);
  assert.strictEqual(row.cessPaise, 0n);
});

test('amounts arriving as Numbers or garbage strings do not throw', () => {
  const r = reconcile2B([], [
    { gstin: GSTIN_UP, normNo: 'I1', invoiceNo: 'I1', taxablePaise: 1000.4, igstPaise: 0,
      cgstPaise: 'abc', sgstPaise: '', cessPaise: null },
  ], cfg, new Map());
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.results[0].itcAtRiskPaise, 0n);
});

// normalisePurchase read igst / cgst / sgst / cess, but the DB columns are
// purchase_igst / purchase_cgst / purchase_sgst / purchase_cess. Every tax head on
// a purchase was therefore read as zero, so reconciliation showed a phantom tax
// difference on every single purchase.
test('normalisePurchase reads the purchase_* tax head columns', () => {
  const p = normalisePurchase({
    supplier_gstin: GSTIN_UP, supplier_bill: 'INV-001', date: '2026-08-15',
    purchase_taxable: 1000, purchase_cgst: 90, purchase_sgst: 90, purchase_igst: 0, purchase_cess: 5,
  });
  assert.strictEqual(p.taxablePaise, 100000n);
  assert.strictEqual(p.cgstPaise, 9000n);
  assert.strictEqual(p.sgstPaise, 9000n);
  assert.strictEqual(p.igstPaise, 0n);
  assert.strictEqual(p.cessPaise, 500n);
});

test('normalisePurchase still accepts the unprefixed spellings', () => {
  const p = normalisePurchase({ supplier_gstin: GSTIN_UP, supplier_invoice_no: 'I1', cgst: 10, sgst: 10 });
  assert.strictEqual(p.cgstPaise, 1000n);
  assert.strictEqual(p.sgstPaise, 1000n);
});

// supplier_bill is a rupee AMOUNT in the POS, not an invoice number. Reading it
// as one meant the purchase register could never be matched to a 2B row.
test('a supplier bill amount is never used as the invoice number', () => {
  const p = normalisePurchase({ supplier_gstin: GSTIN_UP, supplier_bill: 4200, purchase_taxable: 4000 });
  assert.strictEqual(p.invoiceNo, '');
  assert.strictEqual(p.taxablePaise, 400000n);
});

test('parse2B marks debit notes as ITC-ineligible', () => {
  const rows = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: '2', idt: '2026-08-15', ity: 'D', val: 100, taxableVal: 100 }] }, cfg);
  assert.strictEqual(rows[0].invoiceType, 'D');
  assert.strictEqual(rows[0].itcClaimed, false);
});

test('parse2B rejects a non-JSON payload with a clear error', () => {
  assert.throws(() => parse2B('not json', cfg), /not valid JSON/);
});

const books = [{
  key: 'x', gstin: GSTIN_UP, invoiceNo: 'INV-001', date: '2026-08-15',
  taxablePaise: 100000n, igstPaise: 18000n, cgstPaise: 0n, sgstPaise: 0n, cessPaise: 0n,
}];

// A books row that is absent from 2B, so the 2B-only rows below do not also
// register as missing_in_2b.
const booksOnly = [{
  key: 'y', gstin: GSTIN_KA, invoiceNo: 'INV-777', date: '2026-08-16',
  taxablePaise: 50000n, igstPaise: 0n, cgstPaise: 2500n, sgstPaise: 2500n, cessPaise: 0n,
}];

// ── reconciliation buckets ──────────────────────────────────────────────────
test('exact match lands in the matched bucket', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1000, igstAmt: 180 }] }, cfg);
  const r = reconcile2B(books, twoB, cfg, new Map());
  assert.strictEqual(r.summary.matched, 1);
  assert.strictEqual(r.summary.claimable, 18000n);
  assert.strictEqual(r.summary.itcAtRisk, 0n);
});

test('fuzzy invoice-number formatting still matches', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'inv/1', idt: '2026-08-15', taxableVal: 1000, igstAmt: 180 }] }, cfg);
  const r = reconcile2B(books, twoB, cfg, new Map());
  assert.strictEqual(r.summary.matched, 1);
});

test('within-tolerance difference lands in matched_tolerance', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1000.50, igstAmt: 180 }] }, cfg);
  const r = reconcile2B(books, twoB, cfg, new Map());
  assert.strictEqual(r.summary.matchedWithTolerance, 1);
  assert.strictEqual(r.summary.claimable, 18000n);
});

test('large difference lands in value_mismatch and ITC is NOT claimed by default', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1500, igstAmt: 270 }] }, cfg);
  const r = reconcile2B(books, twoB, cfg, new Map());
  assert.strictEqual(r.summary.valueMismatch, 1);
  // doubtful entries default to 'pending' — never auto-claimed
  assert.strictEqual(r.summary.claimable, 0n);
  assert.strictEqual(r.summary.itcAtRisk, 27000n);
  assert.strictEqual(r.results[0].decision, 'pending');
});

test('a 2B row absent from books lands in missing_in_books', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-999', idt: '2026-08-15', taxableVal: 500, igstAmt: 90 }] }, cfg);
  const r = reconcile2B(booksOnly, twoB, cfg, new Map());
  assert.strictEqual(r.summary.missingInBooks, 1);
  assert.strictEqual(r.summary.claimable, 0n);
  // 900p of ITC is at risk from the 2B-only row, plus the unmatched books row
  assert.strictEqual(r.summary.itcAtRisk, 9000n + 5000n);
});

test('a books row absent from 2B is not claimed by default', () => {
  const r = reconcile2B(books, [], cfg, new Map());
  assert.strictEqual(r.summary.missingIn2B, 1);
  assert.strictEqual(r.summary.claimable, 0n);
  assert.strictEqual(r.summary.itcAtRisk, 18000n);
});

test('a books row absent from 2B lands in missing_in_2b', () => {
  const r = reconcile2B(books, [], cfg, new Map());
  assert.strictEqual(r.summary.missingIn2B, 1);
  assert.strictEqual(r.summary.claimable, 0n);
});

test('user can accept a mismatch and claim it', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1500, igstAmt: 270 }] }, cfg);
  const d = new Map([[`${GSTIN_UP}|INV1`, 'accept']]);
  const r = reconcile2B(books, twoB, cfg, d);
  assert.strictEqual(r.summary.claimable, 27000n);
  assert.strictEqual(r.summary.itcAtRisk, 0n);
});

test('user can reject an entry so it is not claimed', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1500, igstAmt: 270 }] }, cfg);
  const d = new Map([[`${GSTIN_UP}|INV1`, 'reject']]);
  const r = reconcile2B(books, twoB, cfg, d);
  assert.strictEqual(r.summary.claimable, 0n);
  assert.strictEqual(r.summary.itcAtRisk, 27000n);
});

test('2B invoice dates are read in the portal DD/MM/YYYY format', () => {
  const rows = parse2B({
    b2b: [{ ctin: GSTIN_UP, inum: 'I1', idt: '05/10/2026', val: 100 }],
  }, cfg);
  assert.strictEqual(rows[0].invoiceDate, '2026-10-05');
  // ISO must keep working, and 2-digit years must not be mangled
  assert.strictEqual(parse2B({ b2b: [{ ctin: GSTIN_UP, inum: 'I2', idt: '2026-08-15' }] }, cfg)[0].invoiceDate, '2026-08-15');
  assert.strictEqual(parse2B({ b2b: [{ ctin: GSTIN_UP, inum: 'I3', idt: '15-08-26' }] }, cfg)[0].invoiceDate, '2026-08-15');
  assert.strictEqual(parse2B({ b2b: [{ ctin: GSTIN_UP, inum: 'I4', idt: '' }] }, cfg)[0].invoiceDate, '');
});

test('claimable ITC is split by head for the 3B set-off', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1000, igstAmt: 180 }] }, cfg);
  const r = reconcile2B(books, twoB, cfg, new Map());
  assert.strictEqual(r.summary.claimableByHead.igst, 18000n);
  assert.strictEqual(r.summary.claimableByHead.cgst, 0n);
});

// GSTR-3B Table 4 reads importGoods / rcm / others, but the reconciliation
// summary only exposed a single `claimable` figure. Nothing mapped across, so
// Table 4 rendered as zero no matter how much credit had been accepted.
test('claimable ITC is split into the Table 4(A) buckets', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1000, igstAmt: 180 }] }, cfg);
  const r = reconcile2B(books, twoB, cfg, new Map());
  assert.strictEqual(r.summary.table4.others, 18000n, 'an ordinary purchase is 4(A)(7)');
  assert.strictEqual(r.summary.table4.importGoods, 0n);
  assert.strictEqual(r.summary.table4.rcm, 0n);
});

test('the Table 4 buckets always sum to the claimed credit', () => {
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1000, igstAmt: 180 }] }, cfg);
  const r = reconcile2B(books, twoB, cfg, new Map());
  const t = r.summary.table4;
  const sum = t.importGoods + t.importServices + t.rcm + t.isd + t.others;
  assert.strictEqual(sum, r.summary.claimable);
});

test('tolerance is configurable', () => {
  const loose = { ...cfg, reconciliation: { ...cfg.reconciliation, toleranceRupees: 10 } };
  const twoB = parse2B({ b2b: [{ ctin: GSTIN_UP, inv: 'INV-001', idt: '2026-08-15', taxableVal: 1009, igstAmt: 180 }] }, loose);
  const r = reconcile2B(books, twoB, loose, new Map());
  assert.strictEqual(r.summary.matchedWithTolerance, 1);
});

// ── books vs return ─────────────────────────────────────────────────────────
test('books total equals GSTR-1 when nothing is excluded', () => {
  const d = [sale({ cust_gstin: GSTIN_MH })].map((s) => normalizeSale(s, cfg, idx));
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d, {}, {}, g1, cfg);
  const r = reconcileBooksVsReturn(d, g1, g3, cfg);
  assert.strictEqual(r.differences.booksVsGstr1TaxablePaise, 0n);
  assert.strictEqual(r.balanced, true);
});

test('excluded documents are listed as explanations', () => {
  const d = [sale({ cust_gstin: GSTIN_MH }), sale({ id: 'TXN-9', invoice_no: 'E/001', doc_type: 'estimate' })]
    .map((s) => normalizeSale(s, cfg, idx));
  const g1 = buildGSTR1(d, cfg, { period: '2026-08' });
  const g3 = buildGSTR3B(d.filter((x) => !x.isDraft && !x.isCancelled), {}, {}, g1, cfg);
  const r = reconcileBooksVsReturn(d, g1, g3, cfg);
  assert.strictEqual(r.explanations.excludedDocs.length, 1);
  assert.strictEqual(r.explanations.excludedDocs[0].invoiceNo, 'E/001');
});

// ── annual turnover ─────────────────────────────────────────────────────────
test('annual turnover aggregates taxable + exempt + exports for the FY', () => {
  const all = [
    sale({ id: '1', invoice_no: 'A/1', date: '2026-08-01' }),
    // a genuinely exempt item (master rate 0%) so Core Rule 3 stays quiet
    sale({ id: '2', invoice_no: 'B/1', date: '2026-09-01',
      items: [{ ...nilLine(), isExempt: true, isNil: false }], tax: 0, total: 100 }),
    sale({ id: '3', invoice_no: 'C/1', date: '2025-06-01' }), // prior FY — excluded
  ].map((s) => normalizeSale(s, cfg, idx));
  const t = annualTurnover(all, cfg, '2026-12-01');
  assert.strictEqual(t.financialYear, '2026-04');
  assert.strictEqual(t.taxablePaise, 10000n);
  assert.strictEqual(t.exemptPaise, 10000n);
  assert.strictEqual(t.totalPaise, 20000n);
});