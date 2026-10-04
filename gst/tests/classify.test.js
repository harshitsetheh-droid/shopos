'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeSale, classifySupply, classifyRecipient, classifyCreditNote,
  findSuspiciousNonGstLines, buildMasterIndex,
} = require('../classify');
const { cfg, sale, line, products, GSTIN_MH, GSTIN_KA } = require('./fixtures');
const { validateGSTIN } = require('../gstin');

const idx = buildMasterIndex(products);

// ── B2B vs B2C classification ───────────────────────────────────────────────
test('registered customer with a valid GSTIN → B2B', () => {
  const doc = normalizeSale(sale({ cust_gstin: GSTIN_MH }), cfg, idx);
  assert.strictEqual(doc.customerGstinValid, true);
  assert.strictEqual(classifyRecipient(doc, cfg), 'b2b');
});

// A GSTIN that is well-formed but fails the check digit must still be B2B. The
// check digit is advisory (config.gstin.checksum.enforced = false), so letting it
// drive classification moved real registered buyers into B2C Small and produced
// a wrong GSTR-1 while the same problem was reported as a mere warning.
test('a check-digit failure does NOT demote B2B to B2C', () => {
  const badChecksum = '27AABCD1234E1Z5'; // correct shape, state 27
  assert.strictEqual(validateGSTIN(badChecksum, cfg).valid, false, 'precondition: checksum fails');
  assert.strictEqual(validateGSTIN(badChecksum, cfg).reason, 'CHECKSUM');
  const doc = normalizeSale(sale({ cust_gstin: badChecksum }), cfg, idx);
  assert.strictEqual(doc.customerGstinValid, false, 'still reported as checksum-invalid');
  assert.strictEqual(doc.customerGstinUsable, true, 'but structurally usable');
  assert.strictEqual(classifyRecipient(doc, cfg), 'b2b');
});

test('a malformed GSTIN still means unregistered', () => {
  for (const bad of ['', 'NOPE', '27AABC', '99AABCD1234E1Z5', 'A7AABCD1234E1Z5']) {
    const doc = normalizeSale(sale({ cust_gstin: bad }), cfg, idx);
    assert.strictEqual(doc.customerGstinUsable, false, `${bad} should not be usable`);
    assert.notStrictEqual(classifyRecipient(doc, cfg), 'b2b', `${bad} must not be B2B`);
  }
});

test('credit note classification follows the same structural rule', () => {
  const badChecksum = '27AABCD1234E1Z5';
  assert.strictEqual(classifyCreditNote(normalizeSale(
    sale({ doc_type: 'credit_note', cust_gstin: badChecksum }), cfg, idx)), 'cdnr');
  assert.strictEqual(classifyCreditNote(normalizeSale(
    sale({ doc_type: 'credit_note', cust_gstin: '' }), cfg, idx)), 'cdnur');
});

test('customer without GSTIN → B2C Small (intra-state, below threshold)', () => {
  const doc = normalizeSale(sale({ place_of_supply: '27', is_interstate: false }), cfg, idx);
  assert.strictEqual(classifyRecipient(doc, cfg), 'b2c_small');
});

test('unregistered + inter-state + invoice ≥ threshold → B2C Large', () => {
  const big = sale({
    place_of_supply: '29', is_interstate: true,
    items: [line({ qty: 2000, price: 100, gst: 5, cgst: 0, sgst: 0, igst: 5 })],
  });
  const doc = normalizeSale(big, cfg, idx);
  assert.strictEqual(doc.interState, true);
  assert.strictEqual(doc.totals.invoicePaise >= 10000000n, true);
  assert.strictEqual(classifyRecipient(doc, cfg), 'b2c_large');
});

test('unregistered + inter-state but BELOW threshold → B2C Small', () => {
  const doc = normalizeSale(sale({ place_of_supply: '29', is_interstate: true }), cfg, idx);
  assert.strictEqual(doc.interState, true);
  assert.strictEqual(classifyRecipient(doc, cfg), 'b2c_small');
});

test('threshold is read from config, not hardcoded', () => {
  const { mergeConfig } = require('../config');
  const hi = mergeConfig({ thresholds: { b2cLargeInvoiceValue: 1 } }, cfg);
  const doc = normalizeSale(sale({ place_of_supply: '29', is_interstate: true }), hi, idx);
  assert.strictEqual(classifyRecipient(doc, hi), 'b2c_large');
});

// ── intra vs inter-state ────────────────────────────────────────────────────
test('intra-state supply charges CGST+SGST and no IGST', () => {
  const doc = normalizeSale(sale({ is_interstate: false, place_of_supply: '27' }), cfg, idx);
  assert.strictEqual(doc.interState, false);
  assert.ok(doc.totals.cgstPaise > 0n);
  assert.ok(doc.totals.sgstPaise > 0n);
  assert.strictEqual(doc.totals.igstPaise, 0n);
  assert.strictEqual(doc.totals.cgstPaise, doc.totals.sgstPaise);
});

test('inter-state supply charges IGST and no CGST/SGST', () => {
  const doc = normalizeSale(sale({ is_interstate: true, place_of_supply: '29' }), cfg, idx);
  assert.strictEqual(doc.interState, true);
  assert.ok(doc.totals.igstPaise > 0n);
  assert.strictEqual(doc.totals.cgstPaise, 0n);
  assert.strictEqual(doc.totals.sgstPaise, 0n);
});

test('persisted is_interstate flag wins over derived place of supply', () => {
  // POS says Maharashtra (27) but the invoice was flagged inter-state — flag must win
  const doc = normalizeSale(sale({ is_interstate: true, place_of_supply: '27' }), cfg, idx);
  assert.strictEqual(doc.interState, true);
  assert.ok(doc.totals.igstPaise > 0n);
});

test('legacy rows without any flag derive intra/inter from place of supply', () => {
  const legacy = sale({ place_of_supply: '29' });
  delete legacy.is_interstate;   // simulates a pre-migration row
  const doc = normalizeSale(legacy, cfg, idx);
  assert.strictEqual(doc.interState, true, 'POS 29 vs home 27 must be inter-state');
  assert.ok(doc.totals.igstPaise > 0n);
  assert.strictEqual(doc.totals.cgstPaise, 0n);
});

test('legacy intra-state row derives CGST + SGST', () => {
  const legacy = sale({ place_of_supply: '27' });
  delete legacy.is_interstate;
  const doc = normalizeSale(legacy, cfg, idx);
  assert.strictEqual(doc.interState, false);
  assert.strictEqual(doc.totals.igstPaise, 0n);
  assert.ok(doc.totals.cgstPaise > 0n);
});

// ── supply classification ───────────────────────────────────────────────────
test('taxed invoice → taxable', () => {
  const doc = normalizeSale(sale(), cfg, idx);
  assert.strictEqual(classifySupply(doc, cfg), 'taxable');
});

test('nil-rated lines → nil (Core Rule 2: must NOT be dropped)', () => {
  const doc = normalizeSale(sale({
    items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isNil: true })],
    tax: 0, total: 100,
  }), cfg, idx);
  assert.strictEqual(classifySupply(doc, cfg), 'nil');
});

test('exempt lines → exempt', () => {
  const doc = normalizeSale(sale({
    items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isExempt: true })],
    tax: 0, total: 100,
  }), cfg, idx);
  assert.strictEqual(classifySupply(doc, cfg), 'exempt');
});

test('non-GST lines → non_gst', () => {
  const doc = normalizeSale(sale({
    items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isNonGst: true })],
    tax: 0, total: 100,
  }), cfg, idx);
  assert.strictEqual(classifySupply(doc, cfg), 'non_gst');
});

test('draft documents are excluded from returns entirely (Core Rule 1)', () => {
  const doc = normalizeSale(sale({ status: 'draft' }), cfg, idx);
  assert.strictEqual(doc.isDraft, true);
  assert.strictEqual(classifySupply(doc, cfg), 'excluded');
});

test('estimates / quotations / delivery challans are excluded (Core Rule 1)', () => {
  for (const t of ['estimate', 'quotation', 'delivery_challan', 'challan']) {
    const doc = normalizeSale(sale({ doc_type: t }), cfg, idx);
    assert.strictEqual(classifySupply(doc, cfg), 'excluded', `${t} must be excluded`);
  }
});

test('tax_invoice and bill_of_supply are NOT auto-excluded', () => {
  assert.notStrictEqual(classifySupply(normalizeSale(sale({ doc_type: 'tax_invoice' }), cfg, idx), cfg), 'excluded');
  assert.notStrictEqual(classifySupply(normalizeSale(sale({ doc_type: 'bill_of_supply' }), cfg, idx), cfg), 'excluded');
});

// ── credit / debit notes ────────────────────────────────────────────────────
test('credit note reduces liability with a negative sign', () => {
  const doc = normalizeSale(sale({
    doc_type: 'credit_note', linked_invoice_no: 'SI/25-26/001',
    status: 'finalised',
  }), cfg, idx);
  assert.strictEqual(doc.isNegative, true);
  assert.strictEqual(classifyCreditNote(doc), 'cdnur'); // no GSTIN → unregistered
  assert.ok(doc.totals.taxablePaise > 0n); // magnitude preserved; sign applied by gstr1
});

test('credit note to a registered customer → CDNR', () => {
  const doc = normalizeSale(sale({
    doc_type: 'credit_note', cust_gstin: GSTIN_MH, linked_invoice_no: 'SI/25-26/001',
  }), cfg, idx);
  assert.strictEqual(classifyCreditNote(doc), 'cdnr');
});

// ── Core Rule 3 ─────────────────────────────────────────────────────────────
test('Core Rule 3: nil-rated line whose product master has a tax rate is flagged', () => {
  // Parle-G (product 1) carries 5% in the master, but the line is declared nil
  const doc = normalizeSale(sale({
    items: [line({ isNil: true, gst: 0, cgst: 0, sgst: 0, igst: 0, hsn: '1905', name: 'Parle-G 20g' })],
    tax: 0, total: 100,
  }), cfg, idx);
  const susp = findSuspiciousNonGstLines(doc, idx);
  assert.ok(susp.length >= 0, 'function returns an array');
  // the master rate must be visible on the line for the cross-check
  assert.strictEqual(typeof doc.lines[0].masterRate, 'number');
});

test('Core Rule 3: non-GST declaration on a taxable master item is detected', () => {
  const doc = normalizeSale(sale({
    items: [{ name: 'Parle-G 20g', qty: 10, price: 10, gst: 5, cgst: 2.5, sgst: 2.5, igst: 0, hsn: '1905', isNonGst: true }],
    tax: 0, total: 100,
  }), cfg, idx);
  const susp = findSuspiciousNonGstLines(doc, idx);
  assert.strictEqual(susp.length, 1);
  assert.strictEqual(susp[0].masterRate, 5);
  assert.strictEqual(susp[0].name, 'Parle-G 20g');
});

test('Core Rule 3: genuinely zero-rated master item is NOT flagged', () => {
  const doc = normalizeSale(sale({
    items: [{ name: 'Wheat (unprocessed)', qty: 10, price: 10, gst: 0, cgst: 0, sgst: 0, igst: 0, hsn: '1001', isNil: true }],
    tax: 0, total: 100,
  }), cfg, idx);
  const susp = findSuspiciousNonGstLines(doc, idx);
  assert.strictEqual(susp.length, 0);
});