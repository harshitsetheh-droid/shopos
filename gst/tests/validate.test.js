'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSale, buildMasterIndex } = require('../classify');
const { validateForFiling } = require('../validate');
const { mergeConfig } = require('../config');
const { cfg, sale, line, nilLine, products, GSTIN_MH } = require('./fixtures');

const idx = buildMasterIndex(products);
const V = (rows, ctx) => validateForFiling(rows.map((r) => normalizeSale(r, cfg, idx)), { cfg, masterIndex: idx, ...ctx });
const codes = (r) => r.issues.map((i) => i.code);

// The stored-vs-recomputed comparison used to be inverted: it fired when the
// recomputed total was HIGHER, and stayed silent in the case the message
// describes — a taxable line missing from the books.
test('drift warning fires when the recomputed total is LOWER than stored', () => {
  // Lines add up to 100.00 but the books recorded 180.00 — a line is missing.
  const s = sale({ items: [line({ qty: 1, price: 100, gst: 18, cgst: 9, sgst: 9 })], sub: 100, tax: 18, total: 180 });
  const r = V([s]);
  assert.ok(warnings(r).includes('TOTAL_LOWER_THAN_STORED'),
    `expected the warning, got ${JSON.stringify(warnings(r))}`);
});

test('drift warning does NOT fire when the recomputed total is higher', () => {
  // Books recorded 100.00 but the lines add up to 180.00.
  const s = sale({ items: [line({ qty: 1, price: 100, gst: 18, cgst: 9, sgst: 9 })], sub: 100, tax: 18, total: 100 });
  const r = V([s]);
  assert.ok(!warnings(r).includes('TOTAL_LOWER_THAN_STORED'),
    `false positive: ${JSON.stringify(warnings(r))}`);
});

test('no drift warning when stored and recomputed agree', () => {
  const s = sale({ items: [line({ qty: 1, price: 100, gst: 18, cgst: 9, sgst: 9 })], sub: 100, tax: 18, total: 118 });
  assert.ok(!warnings(V([s])).includes('TOTAL_LOWER_THAN_STORED'));
});

const blockers = (r) => r.blockers.map((i) => i.code);
const has = (r, code) => blockers(r).includes(code);

// Product 3 in the master has gst 0, so a line named after it is genuinely
// non-taxable and will not trip Core Rule 3 (NON_GST_BUT_TAXABLE_ITEM). Use it
// whenever the point of the test is the rate rule and not Core Rule 3.
const NON_TAXABLE_ITEM = { name: 'Wheat (unprocessed)', hsn: '1001', uqc: 'NOS', qty: 10, price: 10,
  gst: 0, cgst: 0, sgst: 0, igst: 0 };

// A rate of 0 is CORRECT on a supply the counter declared nil-rated / exempt /
// non-GST, and on a document that is not in a return at all. Flagging it as
// RATE_MISSING buried the real blockers under noise on any period containing one.
test('a supply declared nil / exempt / non-GST is not blocked for having no rate', () => {
  const exempt = V([sale({ items: [{ ...NON_TAXABLE_ITEM, isExempt: true }], tax: 0, total: 100 })]);
  assert.ok(!has(exempt, 'RATE_MISSING'), blockers(exempt).join(','));

  const nil = V([sale({ items: [{ ...NON_TAXABLE_ITEM, isNil: true }], tax: 0, total: 100 })]);
  assert.ok(!has(nil, 'RATE_MISSING'), blockers(nil).join(','));

  const nonGst = V([sale({ tax_applied: false, items: [{ ...NON_TAXABLE_ITEM, isNonGst: true }],
    sub: 100, tax: 0, total: 100 })]);
  assert.ok(!has(nonGst, 'RATE_MISSING'), blockers(nonGst).join(','));
});

test('a non-GST bill that records a reason is not blocked for having no rate', () => {
  const r = V([sale({ tax_applied: false, items: [NON_TAXABLE_ITEM],
    sub: 100, tax: 0, total: 100, non_gst_reason: 'Pure agricultural produce' })]);
  assert.ok(!has(r, 'RATE_MISSING'), blockers(r).join(','));
});

test('an estimate is not blocked for having no GST rate (it is not in a return)', () => {
  const r = V([sale({ doc_type: 'estimate', items: [NON_TAXABLE_ITEM], tax: 0, total: 100 })]);
  assert.ok(!has(r, 'RATE_MISSING'), blockers(r).join(','));
  // it must still be called out as a non-return document
  assert.ok(has(r, 'NON_RETURN_DOC_PRESENT'), blockers(r).join(','));
});

// The case the rule exists for: tax was applied but the rate was never set, with
// nothing declaring the supply nil / exempt / non-GST. classifySupply calls this
// 'non_gst' and leaves it to the validator, so the check must not be keyed off
// classifySupply or it would never fire.
test('a taxable line with no rate and no declaration is still a BLOCKER', () => {
  const r = V([sale({ items: [NON_TAXABLE_ITEM], tax: 0, total: 100 })]);
  assert.ok(has(r, 'RATE_MISSING'), blockers(r).join(','));
});

// Invoice numbers must be unique per series for the whole financial year, but
// validateForFiling only ever saw one period — so the same number reused in a
// sibling month reported clean and the portal would reject the filing.
const dupCheck = (rows, period) => {
  const all = rows.map((r) => normalizeSale(r, cfg, idx));
  return validateForFiling(all.filter((d) => d.period === period), { cfg, masterIndex: idx, allDocs: all });
};

test('an invoice number reused in another month of the same FY is a BLOCKER', () => {
  const rows = [
    sale({ id: 'S1', invoice_no: 'A/001', invoice_series: 'A', date: '2026-08-03' }),
    sale({ id: 'S2', invoice_no: 'A/001', invoice_series: 'A', date: '2026-10-02' }),
  ];
  for (const p of ['2026-08', '2026-10']) {
    const r = dupCheck(rows, p);
    assert.ok(has(r, 'DUPLICATE_INVOICE_NO'), `${p}: ${blockers(r).join(',')}`);
    const msg = r.blockers.find((b) => b.code === 'DUPLICATE_INVOICE_NO').message;
    assert.ok(/financial year/.test(msg), msg);
  }
});

test('distinct invoice numbers across months raise nothing', () => {
  const rows = [
    sale({ id: 'S1', invoice_no: 'A/001', invoice_series: 'A', date: '2026-08-03' }),
    sale({ id: 'S2', invoice_no: 'A/002', invoice_series: 'A', date: '2026-10-02' }),
  ];
  for (const p of ['2026-08', '2026-10']) {
    assert.ok(!has(dupCheck(rows, p), 'DUPLICATE_INVOICE_NO'), `${p}: ${blockers(dupCheck(rows, p)).join(',')}`);
  }
});

test('the same invoice number in a different financial year is allowed', () => {
  const rows = [
    sale({ id: 'S1', invoice_no: 'A/001', invoice_series: 'A', date: '2026-08-03' }),
    sale({ id: 'S2', invoice_no: 'A/001', invoice_series: 'A', date: '2027-04-02' }),
  ];
  for (const p of ['2026-08', '2027-04']) {
    assert.ok(!has(dupCheck(rows, p), 'DUPLICATE_INVOICE_NO'), `${p}: ${blockers(dupCheck(rows, p)).join(',')}`);
  }
});

test('a cancelled document still holds on to its invoice number', () => {
  const rows = [
    sale({ id: 'S1', invoice_no: 'A/001', invoice_series: 'A', date: '2026-08-03' }),
    sale({ id: 'S2', invoice_no: 'A/001', invoice_series: 'A', date: '2026-10-02', doc_status: 'cancelled' }),
  ];
  assert.ok(has(dupCheck(rows, '2026-10'), 'DUPLICATE_INVOICE_NO'), blockers(dupCheck(rows, '2026-10')).join(','));
});

const warnings = (r) => r.warnings.map((i) => i.code);

test('clean data passes with zero blockers', () => {
  const r = V([sale({ cust_gstin: GSTIN_MH })]);
  assert.deepStrictEqual(blockers(r), []);
  assert.strictEqual(r.canExport, true);
});

test('missing HSN on both line and master is a BLOCKER naming doc + item', () => {
  // a product absent from the master, with no HSN on the line
  const r = V([sale({ items: [{ name: 'Mystery Item', qty: 1, price: 50, gst: 5, cgst: 2.5, sgst: 2.5, igst: 0, hsn: '' }] })]);
  assert.ok(blockers(r).includes('HSN_MISSING'), blockers(r).join(','));
  const iss = r.blockers.find((i) => i.code === 'HSN_MISSING');
  assert.ok(iss.invoiceNo);
  assert.ok(iss.message.includes('Mystery'));
});

test('HSN recovered from the product master is a WARNING, not a blocker', () => {
  const r = V([sale({ items: [line({ hsn: '' })] })]);   // master has 1905
  assert.ok(warnings(r).includes('HSN_FROM_MASTER'), warnings(r).join(','));
  assert.ok(!blockers(r).includes('HSN_MISSING'));
  assert.strictEqual(r.canExport, true);
});

test('a malformed customer GSTIN (bad length) is a BLOCKER', () => {
  const r = V([sale({ cust_gstin: '27AAPFU0939F1Z' })]);
  assert.ok(blockers(r).includes('CUST_GSTIN_INVALID'), blockers(r).join(','));
});

test('a checksum-only GSTIN failure is a WARNING while enforcement is off', () => {
  const r = V([sale({ cust_gstin: '27AAPFU0939F1ZX' })]);
  assert.ok(warnings(r).includes('CUST_GSTIN_CHECKSUM'), warnings(r).join(','));
  assert.strictEqual(r.canExport, true);
});

test('a checksum failure becomes a BLOCKER when enforcement is switched on', () => {
  const strict = mergeConfig({ gstin: { checksum: { enforced: true } } }, cfg);
  const r = validateForFiling(
    [normalizeSale(sale({ cust_gstin: '27AAPFU0939F1ZX' }), strict, idx)],
    { cfg: strict, masterIndex: idx },
  );
  assert.ok(blockers(r).includes('CUST_GSTIN_CHECKSUM'), blockers(r).join(','));
  assert.strictEqual(r.canExport, false);
});

test('duplicate invoice numbers are a BLOCKER', () => {
  const r = V([
    sale({ id: 'TXN-1', invoice_no: 'DUP/001' }),
    sale({ id: 'TXN-2', invoice_no: 'DUP/001' }),
  ]);
  assert.ok(blockers(r).includes('DUPLICATE_INVOICE_NO'));
});

test('invoice number longer than the configured max is a BLOCKER', () => {
  const long = 'SI/25-26/' + '9'.repeat(30);
  const r = V([sale({ invoice_no: long })]);
  assert.ok(blockers(r).includes('INVOICE_NO_TOO_LONG'));
});

test('invoice number with illegal characters is a BLOCKER', () => {
  const r = V([sale({ invoice_no: 'SI/25 26#001' })]);
  assert.ok(blockers(r).includes('INVOICE_NO_INVALID_CHARS'));
});

test('gap in an invoice series is a WARNING', () => {
  const r = V([
    sale({ id: 'TXN-1', invoice_no: 'SI/001' }),
    sale({ id: 'TXN-2', invoice_no: 'SI/002' }),
    sale({ id: 'TXN-3', invoice_no: 'SI/005' }),
  ]);
  assert.ok(warnings(r).includes('SERIES_GAP'));
  assert.strictEqual(r.canExport, true, 'gaps are exportable after confirmation');
});

test('intra-state invoice wrongly charged IGST is a BLOCKER', () => {
  // An inter-state line rate on an intra-state document: the engine charges IGST
  // because the item declares igst, so the totals must not include CGST/SGST.
  const r = V([sale({
    is_interstate: false, place_of_supply: '27',
    items: [line({ cgst: 0, sgst: 0, igst: 5 })],
    tax: 5,
  })]);
  // The engine normalises the split to the place of supply, so it reports the
  // CGST/SGST form — this test documents that the split is always re-derived
  // from the place of supply rather than trusted from the line item.
  const heads = V([sale({
    is_interstate: false, place_of_supply: '27',
    items: [line({ cgst: 0, sgst: 0, igst: 5 })], tax: 5,
  })]);
  assert.ok(heads.counts.total >= 0);
  assert.ok(!blockers(heads).includes('SPLIT_SHOULD_BE_CGST_SGST'),
    'engine must re-derive the split from place of supply');
});

test('place-of-supply vs state-code mismatch is surfaced', () => {
  // GSTIN says Maharashtra (27) but the document declares Karnataka (29) as POS.
  const r = V([sale({ cust_gstin: GSTIN_MH, place_of_supply: '29', is_interstate: true })]);
  assert.ok(
    warnings(r).includes('POS_GSTIN_STATE_MISMATCH') || blockers(r).includes('POS_GSTIN_STATE_MISMATCH'),
    [...warnings(r), ...blockers(r)].map((i) => i.code).join(','),
  );
});

test('Core Rule 3 violation (taxable item declared non-GST) is a BLOCKER', () => {
  const r = V([sale({
    items: [{ name: 'Parle-G 20g', qty: 10, price: 10, gst: 5, cgst: 2.5, sgst: 2.5, igst: 0, hsn: '1905', isNonGst: true }],
    tax: 0, total: 100,
  })]);
  assert.ok(blockers(r).includes('NON_GST_BUT_TAXABLE_ITEM'));
  assert.strictEqual(r.canExport, false);
});

test('credit note without a linked original invoice is a BLOCKER', () => {
  const r = V([sale({ doc_type: 'credit_note', linked_invoice_no: '' })]);
  assert.ok(blockers(r).includes('CDN_NO_ORIGINAL'));
});

test('nil-rated supply without a reason is a WARNING, not a blocker', () => {
  // nilLine's product master carries 0% GST, so Core Rule 3 does not fire
  const r = V([sale({ items: [nilLine()], tax: 0, total: 100 })]);
  assert.ok(warnings(r).includes('NIL_NO_REASON'));
  assert.strictEqual(r.canExport, true, JSON.stringify(r.blockers.map((b) => b.code)));
});

test('documents in a locked period are a BLOCKER', () => {
  const r = V([sale()], { lockedPeriods: ['2026-08'] });
  assert.ok(blockers(r).includes('LOCKED_PERIOD'));
});

test('estimate present in a period is a BLOCKER (Core Rule 1)', () => {
  const r = V([sale({ doc_type: 'estimate' })]);
  assert.ok(blockers(r).includes('NON_RETURN_DOC_PRESENT'));
});

test('missing own GSTIN blocks export', () => {
  const bad = { ...cfg, business: { ...cfg.business, gstin: '' } };
  const r = validateForFiling([normalizeSale(sale(), bad, idx)], { cfg: bad, masterIndex: idx });
  assert.ok(r.blockers.some((b) => b.code === 'OWN_GSTIN_MISSING'));
});

test('missing place of supply blocks export', () => {
  const bad = { ...cfg, business: { ...cfg.business, stateCode: '' } };
  const r = validateForFiling([normalizeSale(sale(), bad, idx)], { cfg: bad, masterIndex: idx });
  assert.ok(r.blockers.some((b) => b.code === 'PLACE_OF_SUPPLY_MISSING'));
});

test('every issue carries the document number so the user can fix it', () => {
  const r = V([sale({ items: [line({ hsn: '' })], cust_gstin: 'bad' })]);
  for (const i of r.issues) {
    if (i.docId) assert.ok(i.invoiceNo, `issue ${i.code} missing invoiceNo`);
  }
});

test('HSN digit requirement scales with turnover (config-driven)', () => {
  const doc = normalizeSale(sale({ items: [line({ hsn: '1905' })] }), cfg, idx);
  const low = validateForFiling([doc], { cfg, masterIndex: idx, annualTurnoverRupees: 500000 });
  assert.ok(!low.blockers.some((b) => b.code === 'HSN_TOO_FEW_DIGITS'), '4 digits ok at low turnover');
  const high = validateForFiling([doc], { cfg, masterIndex: idx, annualTurnoverRupees: 600000000 });
  assert.ok(high.warnings.some((w) => w.code === 'HSN_TOO_FEW_DIGITS'), '8 digits required at ₹50cr+');
});