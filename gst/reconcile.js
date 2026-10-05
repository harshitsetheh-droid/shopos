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

/**
 * Normalise a date to YYYY-MM-DD.
 *
 * GSTR-2B reports invoice dates as DD/MM/YYYY, which is not a date ISO accepts,
 * so the original ISO-only regex silently produced an empty string for every
 * real 2B row — dates showed blank throughout the reconciliation tab.
 */
function normDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // DD/MM/YYYY — the GSTR-2B format
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  // DD-MM-YY
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/.exec(s);
  if (m) return `20${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
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
  // GSTR-2B files in the wild use several spellings. The portal's own offline
  // JSON uses taxval / iamt / camt / samt / csamt / cessamt; older extracts and
  // hand-typed rows use taxableVal / igstAmt / cgstAmt / sgstAmt. Accept the union
  // — reading only the second set silently reduced every real 2B row to zero, so
  // nothing ever matched.
  const pick = (row, ...keys) => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return 0;
  };
  for (const r of list) {
    const gstin = String(r.ctin || r.gstin || r.supplierGstin || '').toUpperCase().trim();
    // inum is the portal's own spelling of the invoice number; without it every
    // 2B row had an empty invoice number and could never match the books.
    const invNo = String(pick(r, 'inum', 'inv', 'invNo', 'invoiceNumber', 'invoice_no') || '');
    const invDate = normDate(r.idt || r.invoiceDate || r.invdt || r.date);
    const invType = String(r.ity || r.invoiceType || r.inv_typ || r.invty || 'R').toUpperCase(); // R=regular, D=debit, C=credit
    const invVal = toPaise(String(pick(r, 'val', 'invoiceValue', 'invVal')));
    const taxable = toPaise(String(pick(r, 'taxval', 'taxableVal', 'taxable', 'taxableValue')));
    const igst = toPaise(String(pick(r, 'iamt', 'igstAmt', 'igst')));
    const cgst = toPaise(String(pick(r, 'camt', 'cgstAmt', 'cgst')));
    const sgst = toPaise(String(pick(r, 'samt', 'sgstAmt', 'sgst')));
    const cess = toPaise(String(pick(r, 'cessamt', 'cessAmt', 'cess')));
    const itcClaimed = String(r.itcAvlbl || r.itcAvailable || '').toUpperCase();
    if (!gstin && !invNo) continue;
    rows.push({
      gstin, invoiceNo: invNo, normNo: normInvoiceNo(invNo, config), invoiceDate: invDate,
      invoiceType: invType,
      invoiceValuePaise: invVal, taxablePaise: taxable,
      igstPaise: igst, cgstPaise: cgst, sgstPaise: sgst, cessPaise: cess,
      // A debit note cannot be claimed as ITC. Where the file states ITC
      // availability, respect it — the portal marks ineligible rows explicitly.
      itcClaimed: itcClaimed
        ? itcClaimed === 'Y'
        : invType !== 'D',
      period: String(r.irt || r.filingPeriod || r.period || '').trim(),
      filingDate: normDate(r.fdt || ''),
    });
  }
  return rows;
}

/**
 * Turn previously-parsed rows back into the BigInt shape reconcile2B expects.
 *
 * parse2B output cannot survive a JSONB round trip: BigInt is not JSON, so it is
 * written out as a decimal string. Feeding those strings straight back in made
 * reconcile2B evaluate "80000" - 80000n and throw. Prefer re-parsing the stored
 * payload (see the /api/gst/2b route); this exists for rows saved the old way.
 */
function rehydrate2BRows(rows) {
  return (rows || []).map((r) => ({
    ...r,
    invoiceValuePaise: nz(r.invoiceValuePaise),
    taxablePaise: nz(r.taxablePaise),
    igstPaise: nz(r.igstPaise),
    cgstPaise: nz(r.cgstPaise),
    sgstPaise: nz(r.sgstPaise),
    cessPaise: nz(r.cessPaise),
    itcClaimed: r.itcClaimed !== false,
  }));
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
  // nz() every amount on both sides. These rows travel through JSONB and the
  // client, so they can arrive as BigInt, Number or a decimal string; mixing two
  // of those throws and takes the whole return build down with it.
  for (const raw of twoB || []) {
    const r = rehydrate2BRows([raw])[0];
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
      diffCgstPaise: -nz(b.cgstPaise),
      diffSgstPaise: -nz(b.sgstPaise),
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

    // A supplier debit note reverses credit already taken. itcOf() returns 0 for
    // it so it is never claimed, but the amount belongs in Table 4(B) rather than
    // disappearing from the return. A matched pair keeps the 2B row in row2b; a
    // 2B-only row keeps it in row.
    const twoBSide = r.row2b || (r.side === '2b' ? r.row : null) || null;
    if (twoBSide && twoBSide.invoiceType === 'D') {
      const raw = nz(twoBSide.igstPaise) + nz(twoBSide.cgstPaise)
        + nz(twoBSide.sgstPaise) + nz(twoBSide.cessPaise);
      summary.reversed += raw;
      summary.reversedRows.push({
        invoiceNo: twoBSide.invoiceNo || '',
        gstin: twoBSide.gstin || '',
        taxPaise: raw,
      });
      r.eligible = false;
      r.reversesCredit = raw;
      continue;
    }

    // A purchase the user has marked ineligible is never claimable, whatever the
    // reconciliation says — a perfect 2B match cannot override Section 17(5).
    // It is reported in Table 4(C) instead of vanishing from the return. The
    // recorded decision is left as-is, since it still describes the 2B comparison.
    const bkRow = r.rowBooks || (r.side === 'books' ? r.row : null) || null;
    if (bkRow && bkRow.itcEligible === false) {
      summary.ineligible += tax;
      summary.ineligibleRows.push({
        invoiceNo: bkRow.invoiceNo || '',
        gstin: bkRow.gstin || '',
        reason: bkRow.ineligibleReason || 'Not eligible for credit',
        taxPaise: tax,
      });
      r.eligible = false;
      continue;
    }
    r.eligible = true;

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

  // Split into the GSTR-3B Table 4(A) buckets. Accumulated here, alongside the
  // claim itself, so the buckets can never drift from the claimed total.
  // Import of goods → 4(A)(1)(a); reverse charge → 4(A)(5); everything else 4(A)(7).
  const bk = r.rowBooks || null;
  if (bk && bk.isImport) summary.table4.importGoods += tax;
  else if (bk && bk.reverseCharge) summary.table4.rcm += tax;
  else summary.table4.others += tax;
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
    // GSTR-3B Table 4(C): credit the user has declared ineligible (Section 17(5)).
    // The purchase form collects itc_eligible and a reason, and they used to be
    // read but never used, so 4(C) was always zero on a real return.
    ineligible: ZERO,
    ineligibleRows: [],
    // 4(B): credit reversed by a supplier debit note. itcOf() zeroes the tax so it
    // is never claimed; this keeps the amount visible in the return.
    reversed: ZERO,
    reversedRows: [],
    // GSTR-3B Table 4(A) buckets for the accepted credit. sum of these === claimable.
    table4: {
      importGoods: ZERO,   // 4(A)(1)(a) import of goods
      importServices: ZERO, // 4(A)(1)(b) — not derived from a purchase register
      rcm: ZERO,           // 4(A)(5) inward supplies on reverse charge
      isd: ZERO,           // 4(A)(6) credit received from ISD
      others: ZERO,        // 4(A)(7) all other ITC
    },
  };
}

/**
 * Coerce anything to BigInt paise. Rows reach this module as BigInt, as Numbers,
 * and as decimal strings (parse2B output cannot survive a JSONB round trip), so
 * every amount is funnelled through here rather than assumed.
 */
function nz(v) {
  if (typeof v === 'bigint') return v;
  if (v === null || v === undefined || v === '') return 0n;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.round(v)) : 0n;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
}

// ── Part 6: Books vs Return ─────────────────────────────────────────────────

/**
 * Reconcile books total against GSTR-1 and GSTR-3B.
 * Difference must be zero; any non-zero value is explained document-by-document.
 */
function reconcileBooksVsReturn(docs, gstr1, gstr3b, cfg) {
  const config = cfg || DEFAULT_CONFIG;

  // Books: every real sale document in the period (excluding non-sale docs)
  //
  // doc.totals is the UNSIGNED line sum — GSTR-1 applies the credit/debit-note
  // sign separately when it builds its rows. Books must use the same sign, or a
  // ₹250 credit note is added instead of subtracted and the Books-vs-Return
  // panel reports a phantom ₹500 gap on every period that contains a note.
  // Books = the documents that BELONG in this return: finalised, non-draft, and
  // of a type that appears in a return at all.
  //
  // Including cancelled or draft documents here made the panel permanently
  // non-zero for any period that had one, so a genuine imbalance could not be
  // told apart from ordinary noise. They are listed under explanations instead.
  const inReturn = (d) => classifySupply(d, config) !== 'excluded' && !d.isDraft && !d.isCancelled;
  const saleDocs = docs.filter(inReturn);
  const signed = (d, v) => (d.isNegative ? -v : v);
  const booksTaxable = saleDocs.reduce((a, d) => a + signed(d, d.totals.taxablePaise), ZERO);
  const booksTax = saleDocs.reduce(
    (a, d) => a + signed(d, d.totals.cgstPaise + d.totals.sgstPaise + d.totals.igstPaise + d.totals.cessPaise), ZERO);

  const gstr1Taxable = (gstr1 && gstr1.totals ? gstr1.totals.taxablePaise : ZERO);
  const gstr1Tax = (gstr1 && gstr1.totals
    ? gstr1.totals.cgstPaise + gstr1.totals.sgstPaise + gstr1.totals.igstPaise + gstr1.totals.cessPaise
    : ZERO);

  const gstr3bTaxable = (gstr3b && gstr3b.totals ? gstr3b.totals.taxablePaise : ZERO);
  const gstr3bTax = (gstr3b && gstr3b.totals ? gstr3b.totals.taxPaise : ZERO);

  // Everything the return left out, each document in exactly ONE bucket. A draft
  // used to be reported both as excluded ("not a return document — Tax Invoice",
  // which is nonsense) and as a draft, double-counting it in the totals.
  const buckets = { excluded: [], cancelled: [], drafts: [] };
  for (const d of docs) {
    if (d.isDraft) buckets.drafts.push(d);
    else if (d.isCancelled) buckets.cancelled.push(d);
    else if (classifySupply(d, config) === 'excluded') buckets.excluded.push(d);
  }
  const { excluded, cancelled, drafts } = buckets;

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
  rehydrate2BRows,
  reconcile2B,
  reconcileBooksVsReturn,
  annualTurnover,
  normInvoiceNo,
  matchKey,
};