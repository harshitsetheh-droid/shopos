'use strict';
/**
 * GSTR-2B reconciliation (Part 5) and Books-vs-Return reconciliation (Part 6).
 */
const { DEFAULT_CONFIG } = require('./config');
const { toPaise, sumPaise } = require('./money');
const { validateGSTIN } = require('./gstin');
const { classifySupply } = require('./classify');
const { financialYearStart } = require('./period');

const ZERO = 0n;

/**
 * Normalise an invoice number so cosmetic differences don't break a match:
 * "INV-001" / "inv/001" / "INV 001" → "INV001".
 */
function normInvoiceNo(v, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  let s = String(v || '').toUpperCase().trim();
  if (config.reconciliation.fuzzyInvoiceNumber) {
    const strip = config.reconciliation.invoiceNumberStripChars.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
    s = s.replace(new RegExp(`[${strip}]`, 'g'), '');
    // Strip leading zeros from each numeric run so INV001 === INV1 and 007 === 7.
    s = s.replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ''));
  }
  return s;
}

function normDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Parse a GSTR-2B JSON export (accepts the common portal shapes). */
function parse2B(json, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  const rows = [];
  let data = json;
  if (typeof json === 'string') {
    try { data = JSON.parse(json); } catch (e) {
      throw new Error('2B file is not valid JSON');
    }
  }
  // The portal wraps rows differently across versions — probe known keys.
  const candidates = (data && (data.b2b || data.ctin || data.invoice || data.data)) || [];
  const list = Array.isArray(candidates) ? candidates : (candidates && Array.isArray(candidates.items) ? candidates.items : []);
  for (const r of list) {
    const gstin = String(r.ctin || r.gstin || r.supplierGstin || '').toUpperCase().trim();
    const invNo = String(r.inv || r.invoiceNumber || r.invoice_no || r.invNo || '');
    const invDate = normDate(r.idt || r.invoiceDate || r.invdt || r.date);
    const invType = String(r.ity || r.invoiceType || 'R').toUpperCase(); // R=regular, D=debit, C=credit
    const invVal = toPaise(String(r.val || r.invoiceValue || 0));
    const taxable = toPaise(String(r.taxableVal || r.taxable || 0));
    const igst = toPaise(String(r.igstAmt || r.igst || 0));
    const cgst = toPaise(String(r.cgstAmt || r.cgst || 0));
    const sgst = toPaise(String(r.sgstAmt || r.sgst || 0));
    const cess = toPaise(String(r.cessAmt || r.cess || 0));
    if (!gstin && !invNo) continue;
    rows.push({
      gstin, invoiceNo: invNo, normNo: normInvoiceNo(invNo, config), invoiceDate: invDate,
      invoiceType: invType,
      invoiceValuePaise: invVal, taxablePaise: taxable,
      igstPaise: igst, cgstPaise: cgst, sgstPaise: sgst, cessPaise: cess,
      itcClaimed: !(invType === 'D'),   // debit notes cannot be claimed as ITC
      period: String(r.irt || r.filingPeriod || r.period || '').trim(),
      filingDate: normDate(r.fdt || ''),
    });
  }
  return rows;
}

/**
 * Match a purchase register against GSTR-2B.
 *
 * Buckets: matched | matched_tolerance | value_mismatch | missing_in_books |
 *          missing_in_2b
 *
 * @param {Array} books     purchase entries: {key, gstin, invoiceNo, date, taxablePaise, igstPaise, cgstPaise, sgstPaise, cessPaise}
 * @param {Array} twoB      rows from parse2B()
 * @param {object} cfg
 * @param {Map}    decisions  key -> 'accept'|'reject'|'pending' (user overrides)
 */
function reconcile2B(books, twoB, cfg, decisions) {
  const config = cfg || DEFAULT_CONFIG;
  const tol = toPaise(String(config.reconciliation.toleranceRupees));
  const dec = decisions || new Map();

  const bIndex = new Map();
  for (const b of books || []) {
    bIndex.set(matchKey(b.gstin, normInvoiceNo(b.invoiceNo, config), config), b);
  }
  const used = new Set();
  const results = [];
  const tolerance = config.reconciliation.toleranceRupees;

  // ── 2B rows → match against books ───────────────────────────────────────
  for (const r of twoB || []) {
    const k = matchKey(r.gstin, r.normNo, config);
    const b = bIndex.get(k);
    if (!b) {
      results.push({
        bucket: 'missing_in_books', side: '2b', row: r,
        key: k,
        diffTaxablePaise: r.taxablePaise, diffIgstPaise: r.igstPaise,
        diffCgstPaise: r.cgstPaise, diffSgstPaise: r.sgstPaise,
        itcAtRiskPaise: r.igstPaise + r.cgstPaise + r.sgstPaise,
      });
      continue;
    }
    used.add(k);
    const dT = r.taxablePaise - nz(b.taxablePaise);
    const dI = r.igstPaise - nz(b.igstPaise);
    const dC = r.cgstPaise - nz(b.cgstPaise);
    const dS = r.sgstPaise - nz(b.sgstPaise);
    const dX = r.cessPaise - nz(b.cessPaise);
    const withinTol = [dT, dI, dC, dS, dX].every((d) => d <= tol && d >= -tol);
    const exact = dT === 0n && dI === 0n && dC === 0n && dS === 0n && dX === 0n;
    results.push({
      bucket: exact ? 'matched' : (withinTol ? 'matched_tolerance' : 'value_mismatch'),
      side: 'both', row2b: r, rowBooks: b, key: k,
      diffTaxablePaise: dT, diffIgstPaise: dI, diffCgstPaise: dC, diffSgstPaise: dS, diffCessPaise: dX,
      toleranceRupees: tolerance,
    });
  }

  // ── books rows not present in 2B ───────────────────────────────────────
  for (const [k, b] of bIndex) {
    if (used.has(k)) continue;
    results.push({
      bucket: 'missing_in_2b', side: 'books', row: b, key: k,
      diffTaxablePaise: -nz(b.taxablePaise),
      diffIgstPaise: -nz(b.igstPaise),
      itcAtRiskPaise: nz(b.igstPaise) + nz(b.cgstPaise) + nz(b.sgstPaise),
    });
  }

  // ── Apply user decisions + compute claimable ITC ────────────────────────
  const summary = emptySummary();
  for (const r of results) {
    // Clean matches may be claimed automatically. Anything doubtful defaults to
    // 'pending' — claiming ITC on a mismatch without the user agreeing is the
    // kind of error that gets a return rejected.
    const DEFAULT_BY_BUCKET = {
      matched: 'accept',
      matched_tolerance: 'accept',
      value_mismatch: 'pending',
      missing_in_books: 'pending',
      missing_in_2b: 'pending',
    };
    const d = dec.get(r.key) || DEFAULT_BY_BUCKET[r.bucket] || 'pending';
    r.decision = d;
    r.note = dec.get(r.key + ':note') || '';
    const tax = itcOf(r);
    r.itcPaise = tax;
    switch (r.bucket) {
      case 'matched':
        summary.matched++;
        if (d === 'accept') claimRow(summary, r, tax);
        else summary.itcAtRisk += tax;
        break;
      case 'matched_tolerance':
        summary.matchedWithTolerance++;
        if (d === 'accept') claimRow(summary, r, tax);
        else summary.itcAtRisk += tax;
        break;
      case 'value_mismatch':
        summary.valueMismatch++;
        if (d === 'accept') claimRow(summary, r, tax);
        else summary.itcAtRisk += tax;
        break;
      case 'missing_in_books':
        summary.missingInBooks++;
        if (d === 'accept') claimRow(summary, r, tax);
        else summary.itcAtRisk += tax;
        break;
      case 'missing_in_2b':
        summary.missingIn2B++;
        if (d === 'accept') claimRow(summary, r, tax);
        else summary.itcAtRisk += tax;
        break;
      default: break;
    }
    if (d === 'pending') summary.pending++;
  }

  return { results, summary, toleranceRupees: tolerance };
}

/**
 * Add an accepted entry's ITC to the claimable total and its per-head split.
 * `r` may be a 2B-side row, a books-side row, or a matched pair.
 */
function claimRow(summary, r, tax) {
  summary.claimable += tax;
  const src = r.row2b || r.row;
  if (!src) return;
  summary.claimableByHead.igst += nz(src.igstPaise);
  summary.claimableByHead.cgst += nz(src.cgstPaise);
  summary.claimableByHead.sgst += nz(src.sgstPaise);
  summary.claimableByHead.cess += nz(src.cessPaise);
}

function itcOf(r) {
  if (r.bucket === 'matched' || r.bucket === 'matched_tolerance' || r.bucket === 'value_mismatch') {
    const x = r.row2b;
    if (x && x.invoiceType === 'D') return ZERO;   // debit note → no ITC
    return nz(x.igstPaise) + nz(x.cgstPaise) + nz(x.sgstPaise) + nz(x.cessPaise);
  }
  const b = r.row;
  if (!b) return ZERO;
  return nz(b.igstPaise) + nz(b.cgstPaise) + nz(b.sgstPaise) + nz(b.cessPaise);
}

function matchKey(gstin, normNo, config) {
  const cfg = config || DEFAULT_CONFIG;
  const g = validateGSTIN(gstin, cfg).valid ? String(gstin).toUpperCase() : String(gstin || '').toUpperCase().trim();
  return `${g}|${normNo || ''}`;
}

function emptySummary() {
  return {
    matched: 0, matchedWithTolerance: 0, valueMismatch: 0,
    missingInBooks: 0, missingIn2B: 0, pending: 0,
    claimable: ZERO, itcAtRisk: ZERO,
    claimableByHead: { igst: ZERO, cgst: ZERO, sgst: ZERO, cess: ZERO },
  };
}

function nz(v) { return typeof v === 'bigint' ? v : BigInt(v || 0); }

// ── Part 6: Books vs Return ─────────────────────────────────────────────────

/**
 * Reconcile books total against GSTR-1 and GSTR-3B.
 * Difference must be zero; any non-zero value is explained document-by-document.
 */
function reconcileBooksVsReturn(docs, gstr1, gstr3b, cfg) {
  const config = cfg || DEFAULT_CONFIG;

  // Books: every real sale document in the period (excluding non-sale docs)
  const saleDocs = docs.filter((d) => classifySupply(d, config) !== 'excluded');
  const booksTaxable = saleDocs.reduce((a, d) => a + d.totals.taxablePaise, ZERO);
  const booksTax = saleDocs.reduce(
    (a, d) => a + d.totals.cgstPaise + d.totals.sgstPaise + d.totals.igstPaise + d.totals.cessPaise, ZERO);

  const gstr1Taxable = (gstr1 && gstr1.totals ? gstr1.totals.taxablePaise : ZERO);
  const gstr1Tax = (gstr1 && gstr1.totals
    ? gstr1.totals.cgstPaise + gstr1.totals.sgstPaise + gstr1.totals.igstPaise + gstr1.totals.cessPaise
    : ZERO);

  const gstr3bTaxable = (gstr3b && gstr3b.totals ? gstr3b.totals.taxablePaise : ZERO);
  const gstr3bTax = (gstr3b && gstr3b.totals ? gstr3b.totals.taxPaise : ZERO);

  // Documents excluded from the return explain any gap
  const excluded = docs.filter((d) => classifySupply(d, config) === 'excluded');
  const cancelled = docs.filter((d) => d.isCancelled);
  const drafts = docs.filter((d) => d.isDraft);

  return {
    books: {
      taxablePaise: booksTaxable,
      taxPaise: booksTax,
      documentCount: saleDocs.length,
    },
    gstr1: { taxablePaise: gstr1Taxable, taxPaise: gstr1Tax },
    gstr3b: { taxablePaise: gstr3bTaxable, taxPaise: gstr3bTax },

    differences: {
      booksVsGstr1TaxablePaise: booksTaxable - gstr1Taxable,
      booksVsGstr1TaxPaise: booksTax - gstr1Tax,
      gstr1VsGstr3bTaxablePaise: gstr1Taxable - gstr3bTaxable,
      gstr1VsGstr3bTaxPaise: gstr1Tax - gstr3bTax,
    },

    explanations: {
      excludedDocs: excluded.map((d) => ({
        invoiceNo: d.invoiceNo, reason: `Not a return document (${d.docTypeLabel})`,
        taxablePaise: d.totals.taxablePaise,
      })),
      cancelledDocs: cancelled.map((d) => ({
        invoiceNo: d.invoiceNo, reason: 'Cancelled — shown in Documents Issued only',
        taxablePaise: d.totals.taxablePaise,
      })),
      draftDocs: drafts.map((d) => ({
        invoiceNo: d.invoiceNo, reason: 'Draft — excluded from the return',
        taxablePaise: d.totals.taxablePaise,
      })),
    },

    balanced: (booksTaxable - gstr1Taxable) === 0n && (gstr1Taxable - gstr3bTaxable) === 0n,
  };
}

/**
 * Annual aggregate turnover for the financial year (taxable + exempt + exports).
 * Drives e-invoice, HSN digit and QRMP eligibility thresholds.
 */
function annualTurnover(docs, cfg, asOfDate) {
  const config = cfg || DEFAULT_CONFIG;
  const fy = financialYearStart(asOfDate || new Date().toISOString().slice(0, 10), config);
  const inFY = docs.filter((d) => d.financialYear === fy && !d.isCancelled && !d.isDraft);
  const taxable = inFY.filter((d) => classifySupply(d, config) === 'taxable')
    .reduce((a, d) => a + d.totals.taxablePaise, ZERO);
  const exempt = inFY.filter((d) => ['exempt', 'nil', 'non_gst'].includes(classifySupply(d, config)))
    .reduce((a, d) => a + d.totals.taxablePaise, ZERO);
  const exports = inFY.filter((d) => classifySupply(d, config) === 'zero_rated')
    .reduce((a, d) => a + d.totals.invoicePaise, ZERO);

  const total = taxable + exempt + exports;
  return {
    financialYear: fy,
    taxablePaise: taxable,
    exemptPaise: exempt,
    exportPaise: exports,
    totalPaise: total,
    totalRupees: Number(total) / 100,
    eInvoiceApplicable: Number(total) / 100 >= config.thresholds.eInvoiceTurnoverRupees,
    requiredHsnDigits: (() => {
      const r = Number(total) / 100;
      for (const b of config.hsn.digitsByTurnover) if (r <= b.upto) return b.digits;
      return config.hsn.minDigits;
    })(),
  };
}

module.exports = {
  parse2B,
  reconcile2B,
  reconcileBooksVsReturn,
  annualTurnover,
  normInvoiceNo,
  matchKey,
};