'use strict';
/**
 * GSTR-1 JSON in the official GST portal (offline tool) shape, plus a
 * pre-download schema validation step.
 *
 * SCHEMA VERSION: see config.schemaVersion (GSTR1_SCHEMA_VERSION in config.js).
 * ⚠ The portal periodically revises this schema. Re-check the current version at
 *   https://www.gst.gov.in → Utilities → Offline Tools before you rely on it,
 *   and bump GSTR1_SCHEMA_VERSION in gst/config.js when it changes.
 */
const { DEFAULT_CONFIG, GSTR1_SCHEMA_VERSION } = require('./config');
const { toRupees } = require('./money');

/** Integer paise → 2-decimal rupee number, for JSON output. */
const rs = (paise) => Number(toRupees(paise || 0).toFixed(2));

/**
 * Absolute value of a paise amount.
 *
 * These are BigInt, and Math.abs() throws on BigInt. `x || 0` is not a safe
 * fallback either: 0n is falsy, so it would silently swap a BigInt for a Number
 * and corrupt any later arithmetic.
 */
function absPaise(p) {
  if (p === undefined || p === null) return 0;
  return p < 0 ? -p : p;
}

/**
 * Convert the engine's GSTR-1 object into the portal JSON structure.
 */
function toPortalJSON(g1, cfg, meta) {
  const config = cfg || DEFAULT_CONFIG;
  const m = meta || {};
  return {
    gstin: config.business.gstin,
    fp: m.period || '',
    taxpayerType: config.business.constitution || 'R',
    version: config.schemaVersion,
    hash: 'sha256',           // filled by the portal; placeholder for offline review
    remark: m.remark || '',

    b2b: (g1.b2b || []).map((r) => ({
      ctin: r.gstin,
      inum: r.invoiceNumber,
      idt: r.invoiceDate,
      val: rs(r.invoiceValuePaise),
      pos: r.placeOfSupply,
      rchrg: 'N',
      inv_typ: 'R',
      items: (r.rateBreakup || []).map((b) => ({
        num: 1,
        rt: b.rate,
        amt: rs(b.taxablePaise),
        csamt: rs(b.cgstPaise),
        scamt: rs(b.sgstPaise),
        iamt: rs(b.igstPaise),
        cslamt: rs(b.cessPaise),
      })),
    })),

    b2cl: (g1.b2cl || []).map((r) => ({
      pos: r.placeOfSupply,
      inum: r.invoiceNumber,
      idt: r.invoiceDate,
      val: rs(r.invoiceValuePaise),
      ecom_gstin: r.ecommerceGstin || '',
      items: (r.rateBreakup || []).map((b) => ({
        num: 1, rt: b.rate, amt: rs(b.taxablePaise),
        csamt: rs(b.cgstPaise), scamt: rs(b.sgstPaise), iamt: rs(b.igstPaise),
      })),
    })),

    b2cs: (g1.b2cs || []).map((r) => ({
      sply_ty: r.interState == null ? (r.placeOfSupply !== config.business.stateCode ? 'INTER' : 'INTRA') : '',
      pos: r.placeOfSupply,
      typ: 'OE',
      rt: r.rate,
      amt: rs(r.taxablePaise),
      csamt: rs(r.cgstPaise), scamt: rs(r.sgstPaise), iamt: rs(r.igstPaise),
      ccess: rs(r.cessPaise),
    })),

    exp: (g1.exp || []).map((r) => ({
      inum: r.invoiceNumber,
      idt: r.invoiceDate,
      val: rs(r.invoiceValuePaise),
      pos: r.placeOfSupply,
      rchrg: 'N',
      inv_typ: r.paymentType || config.exports.withoutPayment,
      items: [{
        rt: Number(r.rate) || 0,
        txval: rs(r.taxablePaise),
        iamt: rs(r.igstPaise),
        cess: rs(r.cessPaise),
      }],
    })),

    sez: (g1.sez || []).map((r) => ({
      inum: r.invoiceNumber,
      idt: r.invoiceDate,
      val: rs(r.invoiceValuePaise),
      pos: r.placeOfSupply,
      rchrg: 'N',
      inv_typ: 'R',
      items: [{
        rt: Number(r.rate) || 0,
        txval: rs(r.taxablePaise),
        iamt: rs(r.igstPaise), cess: rs(r.cessPaise),
      }],
    })),

    cdnr: (g1.cdnr || []).map((r) => ({
      ctin: r.gstin,
      nt_num: r.noteNumber,
      nt_dt: r.noteDate,
      ntty: r.noteType,
      // Gross note value. These are BigInt paise — Math.abs on a BigInt throws,
      // which broke the whole return build for any period containing a note.
      val: rs(absPaise(r.totalInvoicePaise)),
      pos: r.placeOfSupply,
      rchrg: 'N',
      inv_typ: r.noteType === 'C' ? 'C' : 'D',
      items: (r.rateBreakup || []).map((b) => ({
        num: 1, rt: b.rate, amt: rs(b.taxablePaise),
        csamt: rs(b.cgstPaise), scamt: rs(b.sgstPaise), iamt: rs(b.igstPaise),
      })),
    })),

    cdnur: (g1.cdnur || []).map((r) => ({
      typ: r.noteType === 'C' ? 'C' : 'D',
      nt_num: r.noteNumber,
      nt_dt: r.noteDate,
      val: rs(absPaise(r.totalInvoicePaise)),
      pos: r.placeOfSupply,
      rchrg: 'N',
      items: (r.rateBreakup || []).map((b) => ({
        num: 1, rt: b.rate, amt: rs(b.taxablePaise),
        csamt: rs(b.cgstPaise), scamt: rs(b.sgstPaise), iamt: rs(b.igstPaise),
      })),
    })),

    // Nil / Exempt / Non-GST (Core Rule 2 — must not be omitted)
    nil_exempt: (g1.nil_exempt || []).map((r) => ({
      sply_ty: r.supplyType === 'nil' ? 'NIL' : (r.supplyType === 'exempt' ? 'EXEMPT' : 'NGSUP'),
      pos: r.placeOfSupply || '',
      typ: r.recipientType === 'b2b' ? 'R' : 'OE',
      rt: 0,
      amt: rs(r.taxablePaise),
      csamt: 0, scamt: 0, iamt: 0, ccess: 0,
    })),

    // HSN summary
    hsn: {
      data: Object.values((g1.hsn && g1.hsn.byHsn) || {}).map((h) => ({
        num: 0,
        hsn_sc: h.hsn,
        desc: (h.rows[0] && h.rows[0].description) || '',
        uqc: (h.rows[0] && h.rows[0].uqc) || config.uqcDefault,
        rt: h.rows[0] ? h.rows[0].rate : 0,
        qty: sumQty(h.rows),
        txval: rs(h.taxablePaise),
        iamt: rs(h.igstPaise),
        camt: rs(h.cgstPaise),
        samt: rs(h.sgstPaise),
        csamt: rs(h.cessPaise),
        // B2B / B2C split (required at higher turnover)
        b2b: rs(sumB2B(h, 'b2bTaxablePaise')),
        b2c: rs(sumB2B(h, 'b2cTaxablePaise')),
      })),
    },

    // Documents issued / cancelled
    docs_issued: (g1.docs_issued || []).map((s) => ({
      doc_typ: s.docTypeLabel,
      from_sr: s.fromNumber,
      to_sr: s.toNumber,
      totnum: s.totalIssued,
      cancel: s.totalCancelled,
      net_issue: s.totalIssued - s.totalCancelled,
      net_value: rs(s.netTaxablePaise),
      net_tax: rs(s.netTaxPaise),
      doc_amt: rs(s.netTaxablePaise),
      rates: (s.rateTotals || []).map((rt) => ({
        rt: rt.rate, amt: rs(rt.taxablePaise), csamt: rs(rt.cgstPaise),
        samt: rs(rt.sgstPaise), iamt: rs(rt.igstPaise),
      })),
    })),

    // Amendments for invoices raised in earlier periods
    amendments: (g1.amendments || []).map((a) => ({
      inum: a.invoiceNumber,
      idt: a.invoiceDate,
      oinum: a.originalInvoiceNumber,
      otdt: a.originalPeriod,
      reason: a.reason,
    })),
  };
}

function sumQty(rows) {
  let n = 0;
  for (const r of rows || []) {
    const v = Number(r.qtyTotal);
    if (isFinite(v)) n += v;
  }
  return Number(n.toFixed(3));
}
function sumB2B(h, field) {
  return (h.rows || []).reduce((a, r) => a + Number(r[field] || 0), 0);
}

// ── Schema validation (runs BEFORE download) ────────────────────────────────

/** Minimal structural rules the portal expects. Extend per schema version. */
function validatePortalJSON(json, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  const errors = [];
  const warnings = [];
  const push = (arr, cond, msg) => { if (cond) arr.push(msg); };

  push(errors, !json.gstin, 'gstin is missing');
  if (json.gstin) {
    push(errors, !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(json.gstin)),
      'gstin does not match the expected 15-character format');
  }
  push(errors, !/^\d{4}-\d{2}$/.test(String(json.fp || '')), 'fp (filing period) must be "YYYY-MM"');
  push(errors, !json.version, 'schema version is missing');

  const arrays = ['b2b', 'b2cl', 'b2cs', 'exp', 'sez', 'cdnr', 'cdnur', 'nil_exempt'];
  for (const k of arrays) {
    push(errors, !Array.isArray(json[k]), `${k} must be an array`);
  }

  // B2B rows need a valid counterparty GSTIN and an invoice number
  (json.b2b || []).forEach((r, i) => {
    push(errors, !r.ctin, `b2b[${i}] missing ctin`);
    push(errors, !r.inum, `b2b[${i}] missing inum`);
    push(errors, !Array.isArray(r.items) || !r.items.length, `b2b[${i}] has no item rows`);
    (r.items || []).forEach((it, j) => {
      push(errors, typeof it.rt !== 'number', `b2b[${i}].items[${j}] missing numeric rt`);
    });
  });

  // Rate slabs
  for (const k of ['b2b', 'b2cl', 'b2cs']) {
    for (const r of json[k] || []) {
      const list = r.items || [{ rt: r.rt }];
      for (const it of list) {
        push(warnings, it.rt != null && !config.rates.includes(Number(it.rt)),
          `${k} uses rate ${it.rt} which is not in the configured slab list`);
      }
    }
  }

  // HSN rows
  push(errors, !json.hsn || !Array.isArray(json.hsn.data), 'hsn.data must be an array');
  (json.hsn?.data || []).forEach((h, i) => {
    push(errors, !h.hsn_sc, `hsn[${i}] missing hsn_sc`);
    push(warnings, String(h.hsn_sc || '').length < config.hsn.minDigits,
      `hsn[${i}] "${h.hsn_sc}" has fewer than ${config.hsn.minDigits} digits`);
  });

  // Documents issued
  for (const d of json.docs_issued || []) {
    push(errors, !(Number(d.totnum) >= 0), 'docs_issued.totnum must be a number');
    push(errors, String(d.from_sr || '') > String(d.to_sr || ''), 'docs_issued from_sr is after to_sr');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    schemaVersion: json.version || config.schemaVersion,
    expectedSchemaVersion: GSTR1_SCHEMA_VERSION,
    versionMatchesConfig: (json.version || config.schemaVersion) === config.schemaVersion,
  };
}

module.exports = { toPortalJSON, validatePortalJSON, rs };