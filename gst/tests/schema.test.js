'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSale, buildMasterIndex } = require('../classify');
const { buildGSTR1 } = require('../gstr1');
const { toPortalJSON, validatePortalJSON } = require('../schema');
const { GSTR1_SCHEMA_VERSION } = require('../config');
const { cfg, sale, line, products, GSTIN_MH } = require('./fixtures');

const idx = buildMasterIndex(products);
const build = (rows) => buildGSTR1(rows.map((r) => normalizeSale(r, cfg, idx)), cfg, { period: '2026-08' });

test('portal JSON carries the GSTIN, filing period and schema version', () => {
  const j = toPortalJSON(build([sale({ cust_gstin: GSTIN_MH })]), cfg, { period: '2026-08' });
  assert.strictEqual(j.gstin, cfg.business.gstin);
  assert.strictEqual(j.fp, '2026-08');
  assert.strictEqual(j.version, GSTR1_SCHEMA_VERSION);
});

test('portal JSON passes schema validation for clean data', () => {
  const j = toPortalJSON(build([
    sale({ id: '1', invoice_no: 'A/001', cust_gstin: GSTIN_MH }),
    sale({ id: '2', invoice_no: 'A/002' }),
    sale({ id: '3', invoice_no: 'B/001',
      items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isExempt: true })], tax: 0, total: 100 }),
  ]), cfg, { period: '2026-08' });
  const v = validatePortalJSON(j, cfg);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  assert.strictEqual(v.schemaVersion, GSTR1_SCHEMA_VERSION);
  assert.strictEqual(v.versionMatchesConfig, true);
});

test('schema validation catches a missing GSTIN before download', () => {
  const j = toPortalJSON(build([sale()]), cfg, { period: '2026-08' });
  j.gstin = '';
  const v = validatePortalJSON(j, cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('gstin')));
});

test('schema validation catches a bad filing period', () => {
  const j = toPortalJSON(build([sale()]), cfg, { period: '2026-08' });
  j.fp = 'August';
  assert.strictEqual(validatePortalJSON(j, cfg).ok, false);
});

test('schema validation rejects a B2B row with no invoice number', () => {
  const j = toPortalJSON(build([sale({ cust_gstin: GSTIN_MH })]), cfg, { period: '2026-08' });
  j.b2b[0].inum = '';
  const v = validatePortalJSON(j, cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('inum')));
});

test('schema validation warns on an unusual rate slab', () => {
  const j = toPortalJSON(build([sale({ cust_gstin: GSTIN_MH })]), cfg, { period: '2026-08' });
  j.b2b[0].items[0].rt = 6.5;   // not a standard GST slab
  const v = validatePortalJSON(j, cfg);
  assert.ok(v.warnings.some((w) => w.includes('6.5')), v.warnings.join(' | '));
});

test('a standard slab produces no rate warning', () => {
  const j = toPortalJSON(build([sale({ cust_gstin: GSTIN_MH })]), cfg, { period: '2026-08' });
  const v = validatePortalJSON(j, cfg);
  assert.ok(!v.warnings.some((w) => w.includes('not in the configured slab')));
});

test('nil/exempt rows are present in the portal JSON (Core Rule 2)', () => {
  const j = toPortalJSON(build([sale({
    id: 'B/1', invoice_no: 'B/001',
    items: [line({ gst: 0, cgst: 0, sgst: 0, igst: 0, isNil: true })], tax: 0, total: 100,
  })]), cfg, { period: '2026-08' });
  assert.ok(Array.isArray(j.nil_exempt));
  assert.strictEqual(j.nil_exempt.length, 1);
  assert.strictEqual(j.nil_exempt[0].sply_ty, 'NIL');
});

test('amounts in portal JSON are 2-decimal rupee numbers', () => {
  const j = toPortalJSON(build([sale({ cust_gstin: GSTIN_MH })]), cfg, { period: '2026-08' });
  const amt = j.b2b[0].items[0].amt;
  assert.strictEqual(typeof amt, 'number');
  assert.strictEqual(amt, 100);
  assert.strictEqual(j.b2b[0].items[0].csamt, 2.5);
  assert.strictEqual(j.b2b[0].val, 105);
});

test('HSN section is emitted with uqc and quantity', () => {
  const j = toPortalJSON(build([sale()]), cfg, { period: '2026-08' });
  assert.ok(Array.isArray(j.hsn.data));
  const h = j.hsn.data.find((x) => x.hsn_sc === '1905');
  assert.ok(h);
  assert.strictEqual(h.uqc, 'NOS');
  assert.strictEqual(h.qty, 10);
});