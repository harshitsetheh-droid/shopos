'use strict';
/**
 * Document normalisation + supply classification.
 *
 * Turns a raw persisted sale row into a normalised GST document, then decides
 * where it belongs in GSTR-1 / GSTR-3B. Core Rules 1–3 are enforced here.
 */
const { DEFAULT_CONFIG } = require('./config');
const { toPaise, taxOnPaise, sumPaise } = require('./money');
const { validateGSTIN, stateCodeOf, resolveStateCode, isInterState } = require('./gstin');
const { toDate, financialYearStart, financialYearLabel, returnPeriod } = require('./period');

/** Document types that NEVER appear in a return (Core Rule 1). */
const NON_RETURN_DOC_TYPES = new Set([
  'estimate', 'quotation', 'delivery_challan', 'challan', 'proforma', 'draft_document', 'statement',
]);

/** All known document types → label + is-a-tax-document flag. */
const DOC_TYPES = {
  tax_invoice:        { label: 'Tax Invoice',        isTax: true,  negative: false },
  bill_of_supply:     { label: 'Bill of Supply',     isTax: false, negative: false },
  credit_note:        { label: 'Credit Note',        isTax: true,  negative: true  },
  debit_note:         { label: 'Debit Note',         isTax: true,  negative: true  },
  export_invoice:     { label: 'Export Invoice',     isTax: true,  negative: false },
 sez_invoice:         { label: 'SEZ Supply Invoice', isTax: true,  negative: false },
  estimate:           { label: 'Estimate',           isTax: false, negative: false },
  quotation:          { label: 'Quotation',          isTax: false, negative: false },
  delivery_challan:   { label: 'Delivery Challan',   isTax: false, negative: false },
};

/** Document lifecycle statuses. */
const DOC_STATUS = { DRAFT: 'draft', FINALISED: 'finalised', CANCELLED: 'cancelled' };

/**
 * Derive the tax split for one line at sale time (rate-level logic).
 * Mirrors the billing screen's itemTaxRates() but works on paise.
 */
function lineTaxRates(item, interState, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  let cgst = Number(item.cgst || 0);
  let sgst = Number(item.sgst || 0);
  let igst = Number(item.igst || 0);
  const total = Number(item.gst || 0);
  if (!interState) {
    igst = 0;
    if (!cgst && !sgst && total > 0) { cgst = total / 2; sgst = total / 2; }
  } else {
    cgst = 0; sgst = 0;
    if (!igst && total > 0) igst = total;
  }
  return { cgst, sgst, igst, rate: interState ? (igst || total) : (total || (cgst + sgst)) };
}

/** Effective tax rate a line contributes, honouring nil/exempt/non-GST flags. */
function effectiveRate(line, cfg) {
  if (line.isNil || line.isExempt || line.isNonGst) return 0;
  return Number(line.ratePct || 0);
}

/**
 * Build a normalised GST document from a persisted sale row.
 *
 * @param {object} s   sale row (snake_case from DB, or camelCase from app)
 * @param {object} cfg config
 * @param {Map|object} productIndex optional product master for HSN fallback
 */
function normalizeSale(s, cfg, productIndex) {
  const config = cfg || DEFAULT_CONFIG;
  const homeState = String(config.business.stateCode || '');
  const docType = String(s.doc_type || s.docType || 'tax_invoice');
  // The DB column is doc_status and the client sends docStatus; `status` is the
  // older/hand-written spelling. Reading only `status` meant a genuinely
  // cancelled invoice was normalised as finalised and its value went straight
  // into the B2B/B2C totals.
  const status = String(s.doc_status || s.docStatus || s.status || DOC_STATUS.FINALISED).toLowerCase();

  const custGstin = String(s.cust_gstin || s.customerGstin || '').trim().toUpperCase();
  const gstCheck = validateGSTIN(custGstin, config);

  const dateStr = s.date || s.invoice_date || '';
  const placeOfSupply = String(
    s.place_of_supply || s.placeOfSupply ||
    gstCheck.stateCode || stateCodeOf(custGstin) ||
    homeState || ''
  );
  // A persisted inter/intra flag is authoritative — it was recorded at billing
  // time from the actual customer location. Only fall back to the place of
  // supply when no flag was ever stored (legacy rows).
  const hasInter = s.is_interstate !== null && s.is_interstate !== undefined;
  const hasIntra = s.intra !== null && s.intra !== undefined;
  let interState;
  if (hasInter) interState = !!s.is_interstate;
  else if (hasIntra) interState = !s.intra;
  else interState = isInterState(homeState, placeOfSupply);

  const supplyType = String(s.supply_type || s.supplyType || 'domestic');
  const idx = productIndex instanceof Map ? productIndex : null;

  const lines = (Array.isArray(s.items) ? s.items : []).map((it, i) => {
    const key = String(it.name || '').trim().toLowerCase();
    const p = idx ? (idx.get(it.id) || idx.get(key)) : null;
    // Legacy rows stored no HSN on the line, so fall back to the product master.
    // Record that we did so, so the validator can still surface the data gap
    // instead of hiding it.
    const lineCode = String(it.hsn || it.sac || '');
    const masterCode = p ? String(p.hsn || p.sac || '') : '';
    const hsn = lineCode || masterCode;
    const hsnFromMaster = !lineCode && !!masterCode;
    const rateSrc = { cgst: it.cgst, sgst: it.sgst, igst: it.igst, gst: it.gst };
    const tr = lineTaxRates(rateSrc, interState, config);
    const gross = Number(it.customPrice != null ? it.customPrice : it.price) || 0;
    const qty = Number(it.qty) || 0;
    const taxable = toPaise(String(gross * qty));
    const taxApplied = !!(s.tax_applied !== undefined ? s.tax_applied : s.taxApplied);
    const isNil = !!it.isNil || !!it.nilRated;
    const isExempt = !!it.isExempt || !!it.exempt;
    const isNonGst = !!it.isNonGst || !!it.nonGst;
    const rate = (isNil || isExempt || isNonGst || !taxApplied) ? 0 : tr.rate;
    const tax = taxApplied ? taxOnPaise(taxable, rate) : 0n;
    // Split the computed tax into heads according to supply type.
    let cgstP = 0n, sgstP = 0n, igstP = 0n;
    if (tax > 0n) {
      if (supplyType === 'export' || supplyType === 'sez') { igstP = tax; }
      else if (interState) { igstP = tax; }
      else { cgstP = taxOnPaise(taxable, rate / 2); sgstP = tax - cgstP; }
    }
    return {
      idx: i,
      productId: it.id != null ? it.id : null,
      name: String(it.name || ''),
      hsn,
      sac: String(it.sac || ''),
      uqc: String(it.uqc || p?.uqc || config.uqcDefault),
      qty: String(qty),
      unitPricePaise: toPaise(String(gross)),
      taxablePaise: taxable,
      ratePct: rate,
      cgstPaise: cgstP,
      sgstPaise: sgstP,
      igstPaise: igstP,
      cessPaise: 0n,
      isNil, isExempt, isNonGst,
      // rate declared by the product master — drives the Core Rule 3 cross-check
      masterRate: tr.rate,
      // HSN/SAC came from the product master, not the invoice line itself
      hsnFromMaster,
      hsnOnLine: lineCode,
    };
  });

  const totals = {
    taxablePaise: sumPaise(lines.map((l) => l.taxablePaise)),
    cgstPaise: sumPaise(lines.map((l) => l.cgstPaise)),
    sgstPaise: sumPaise(lines.map((l) => l.sgstPaise)),
    igstPaise: sumPaise(lines.map((l) => l.igstPaise)),
    cessPaise: sumPaise(lines.map((l) => l.cessPaise)),
  };
  totals.invoicePaise = totals.taxablePaise + totals.cgstPaise + totals.sgstPaise + totals.igstPaise + totals.cessPaise;

  return {
    id: String(s.id || ''),
    invoiceNo: String(s.invoice_no || s.invoiceNo || s.id || ''),
    docType,
    docTypeLabel: (DOC_TYPES[docType] || { label: docType }).label,
    isTaxDocument: !!(DOC_TYPES[docType] && DOC_TYPES[docType].isTax),
    isCreditNote: docType === 'credit_note',
    isDebitNote: docType === 'debit_note',
    isNegative: !!(DOC_TYPES[docType] && DOC_TYPES[docType].negative),
    status,
    isDraft: status === DOC_STATUS.DRAFT,
    isCancelled: status === DOC_STATUS.CANCELLED,
    date: dateStr,
    period: returnPeriod(dateStr),
    financialYear: financialYearStart(dateStr, config),
    financialYearLabel: financialYearLabel(dateStr, config),
    customerName: String(s.customer_name || s.customerName || ''),
    customerGstin: custGstin,
    customerGstinValid: gstCheck.valid,
    // Structural validity (length, pattern, known state) decides B2B vs B2C. A
    // check-digit mismatch is advisory — see validateGSTIN — so it must not
    // demote a registered buyer into B2C Small.
    customerGstinUsable: gstCheck.structurallyValid === true,
    customerStateCode: gstCheck.stateCode || stateCodeOf(custGstin) || '',
    placeOfSupply,
    homeStateCode: homeState,
    interState,
    reverseCharge: !!s.reverse_charge,
    supplyType,
    exemptReason: String(s.exempt_reason || ''),
    nilRatedReason: String(s.nil_rated_reason || ''),
    nonGstReason: String(s.non_gst_reason || ''),
    lines,
    totals,
    linkedInvoiceNo: String(s.linked_invoice_no || s.linkedInvoiceNo || ''),
    linkedInvoiceId: String(s.linked_invoice_id || s.linkedInvoiceId || ''),
    // raw stored tax, used by the validator to detect drift
    storedTaxRupees: Number(s.tax || 0),
    storedTotalRupees: Number(s.total || 0),
    taxApplied: !!s.tax_applied,
    raw: s,
  };
}

/**
 * Classify the document's supply type for GSTR-1 table routing.
 * → 'taxable' | 'nil' | 'exempt' | 'non_gst' | 'zero_rated' | 'excluded'
 */
function classifySupply(doc, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  if (NON_RETURN_DOC_TYPES.has(doc.docType)) return 'excluded';
  if (doc.isDraft) return 'excluded';

  const lines = doc.lines || [];
  if (!lines.length) return 'excluded';

  const hasTax = lines.some((l) => (l.cgstPaise + l.sgstPaise + l.igstPaise) > 0n);
  if (hasTax) {
    if (doc.supplyType === 'export' || doc.supplyType === 'sez') return 'zero_rated';
    return 'taxable';
  }
  // No tax on any line — decide nil / exempt / non-GST
  const allNil = lines.every((l) => l.isNil);
  const allNonGst = lines.every((l) => l.isNonGst);
  if (allNonGst) return 'non_gst';
  if (allNil) return 'nil';
  if (lines.some((l) => l.isExempt) && !lines.some((l) => !l.isExempt && !l.isNil && !l.isNonGst)) return 'exempt';
  // Mixed taxable-rate master lines with no tax → suspicious, flag via validator
  return 'non_gst';
}

/**
 * B2B / B2C-Large / B2C-Small.
 * Rules come from config (threshold). A valid GSTIN makes a recipient "registered".
 */
function classifyRecipient(doc, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  // Structural validity, not checksum. A buyer who gave a well-formed GSTIN in a
  // real state code is a B2B recipient even if the check digit does not verify;
  // that is a warning on the validation tab, not a reclassification.
  const registered = doc.customerGstinUsable === true;
  if (registered) return 'b2b';
  const threshold = Number(config.thresholds.b2cLargeInvoiceValue);
  const value = doc.totals.invoicePaise;
  // B2C Large: unregistered + inter-state + invoice value >= threshold
  if (!registered && doc.interState && value >= toPaise(String(threshold))) return 'b2c_large';
  return 'b2c_small';
}

/** CDNR vs CDNUR for credit/debit notes. */
function classifyCreditNote(doc) {
  return doc.customerGstinUsable ? 'cdnr' : 'cdnur';
}

/** Section of GSTR-1 a document belongs to. */
function gstr1SectionOf(doc, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  const supply = classifySupply(doc, config);
  if (supply === 'excluded') return null;
  if (doc.isCancelled) return 'b2b'; // counted in Documents Issued only; caller must skip tax tables
  if (doc.isNegative) {
    return { b2b: 'cdnr', b2c_large: 'cdnur', b2c_small: 'cdnur' }[classifyRecipient(doc, config)];
  }
  const r = classifyRecipient(doc, config);
  if (supply === 'nil' || supply === 'exempt' || supply === 'non_gst') return 'nil_exempt';
  if (supply === 'zero_rated') return 'exports';
  return r; // 'b2b' | 'b2c_large' | 'b2c_small'
}

/**
 * Core Rule 3 — detect a line declared as nil/exempt/non-GST while the product
 * master carries a non-zero GST rate. Such a bill must be a CRITICAL warning.
 *
 * @param {object} doc normalised document
 * @param {Map} [masterIndex] product master keyed by id or lowercase name
 * @returns {Array<{docId,invoiceNo,lineIdx,name,masterRate}>}
 */
function findSuspiciousNonGstLines(doc, masterIndex) {
  const out = [];
  const idx = masterIndex instanceof Map ? masterIndex : null;
  for (const l of (doc.lines || [])) {
    if (!(l.isNil || l.isExempt || l.isNonGst)) continue;
    // Prefer the live product master; fall back to the rate snapshotted on the line.
    let masterRate = Number(l.masterRate || 0);
    if (idx) {
      const p = idx.get(l.productId) || idx.get(String(l.name || '').trim().toLowerCase());
      if (p) {
        const ig = Number(p.igst || p.gst || 0);
        masterRate = ig > 0 ? ig : Number(p.cgst || 0) + Number(p.sgst || 0);
      }
    }
    if (masterRate > 0) {
      out.push({
        docId: doc.id,
        invoiceNo: doc.invoiceNo,
        lineIdx: l.idx,
        name: l.name,
        masterRate,
      });
    }
  }
  return out;
}

/**
 * Build a product-master index (by id and lowercase name) for HSN / rate / UQC
 * lookups. Used for the Core Rule 3 cross-check.
 */
function buildMasterIndex(products) {
  const m = new Map();
  for (const p of products || []) {
    if (!p) continue;
    const norm = {
      id: p.id,
      hsn: p.hsn || '',
      sac: p.sac || '',
      uqc: p.uqc || '',
      cgst: Number(p.cgst || 0),
      sgst: Number(p.sgst || 0),
      igst: Number(p.igst || 0),
      gst: Number(p.gst || 0),
      isNil: !!p.is_nil,
      isExempt: !!p.is_exempt,
    };
    m.set(p.id, norm);
    m.set(String(p.name || '').trim().toLowerCase(), norm);
  }
  return m;
}

module.exports = {
  NON_RETURN_DOC_TYPES,
  DOC_TYPES,
  DOC_STATUS,
  normalizeSale,
  lineTaxRates,
  effectiveRate,
  classifySupply,
  classifyRecipient,
  classifyCreditNote,
  gstr1SectionOf,
  findSuspiciousNonGstLines,
  buildMasterIndex,
  resolveStateCode,
  toDate,
};