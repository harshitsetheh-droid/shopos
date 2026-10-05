'use strict';
/**
 * GSTR-1 data generation. Builds every table from normalised documents.
 * All money is integer paise; conversion to rupees happens only at export time.
 *
 * Tables: b2b, b2cl, b2cs, exp, sez, cdnr, cdnur, nil_exempt,
 *         hsn, docs_issued, amendments
 */
const { DEFAULT_CONFIG } = require('./config');
const { toPaise, sumPaise } = require('./money');
const {
  classifySupply, classifyRecipient, classifyCreditNote, DOC_STATUS,
} = require('./classify');
const { stateName } = require('./gstin');
const { formatDate, requiresIFF } = require('./period');

const ZERO = 0n;

/** Shape of one GSTR-1 row. Taxable fields are paise. */
function blankRow() {
  return {
    taxablePaise: ZERO, cgstPaise: ZERO, sgstPaise: ZERO, igstPaise: ZERO, cessPaise: ZERO,
  };
}

function addLine(row, line, sign) {
  // Credit/debit notes REDUCE the outward liability (negative sign).
  row.taxablePaise += line.taxablePaise * sign;
  row.cgstPaise += line.cgstPaise * sign;
  row.sgstPaise += line.sgstPaise * sign;
  row.igstPaise += line.igstPaise * sign;
  row.cessPaise += line.cessPaise * sign;
  return row;
}

function rateKey(r) {
  return String(Number(r || 0));
}

/** Group lines by rate for invoice-wise tables (rate-wise sub-totals). */
function rateBreakup(doc, sign, onlyRates) {
  const map = new Map();
  for (const l of doc.lines) {
    if (onlyRates && !onlyRates.has(rateKey(l.ratePct))) continue;
    const k = rateKey(l.ratePct);
    if (!map.has(k)) map.set(k, blankRow());
    addLine(map.get(k), l, sign);
  }
  return [...map.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([rate, row]) => ({ rate: Number(rate), ...row }));
}

/** Group lines by (state, rate) for state-wise consolidated tables. */
function stateRateBreakup(docs, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  // map: placeOfSupply -> rate -> { row, docs:Set(invoiceNo) }
  const map = new Map();
  for (const doc of docs) {
    const sign = doc.isNegative ? -1n : 1n;
    const pos = doc.placeOfSupply || doc.customerStateCode || config.business.stateCode || '';
    if (!map.has(pos)) map.set(pos, new Map());
    const byState = map.get(pos);
    for (const l of doc.lines) {
      const k = rateKey(l.ratePct);
      if (!byState.has(k)) byState.set(k, { row: blankRow(), docs: new Set() });
      const cell = byState.get(k);
      addLine(cell.row, l, sign);
      cell.docs.add(doc.invoiceNo);
    }
  }
  const out = [];
  for (const [pos, byState] of map) {
    for (const [rate, cell] of [...byState.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      out.push({
        placeOfSupply: pos,
        stateName: stateName(pos),
        rate: Number(rate),
        taxablePaise: cell.row.taxablePaise,
        cgstPaise: cell.row.cgstPaise,
        sgstPaise: cell.row.sgstPaise,
        igstPaise: cell.row.igstPaise,
        cessPaise: cell.row.cessPaise,
        invoiceCount: cell.docs.size,
      });
    }
  }
  return out;
}

/**
 * Build the complete GSTR-1 data set for a period.
 *
 * @param {Array} docs normalised, non-draft, in-period documents (any status)
 * @param {object} cfg
 * @param {object} opts { seriesInfo, period }
 */
function buildGSTR1(docs, cfg, opts) {
  const config = cfg || DEFAULT_CONFIG;
  const options = opts || {};
  const period = options.period || '';

  // Core Rule 1: only FINALISED docs reach tax tables. Cancelled docs are
  // retained for "Documents Issued" but excluded from every tax table.
  const eligible = docs.filter((d) => !d.isDraft);
  const taxDocs = eligible.filter((d) => !d.isCancelled);

  const out = {
    period,
    generatedFrom: 'shopos-gst-engine',
    schemaVersion: config.schemaVersion,
    requiresIFF: requiresIFF(period, config),

    b2b: [],            // invoice-wise, rate-wise
    b2cl: [],           // B2C Large, inter-state, invoice-wise
    b2cs: [],           // B2C Small, state-wise + rate-wise
    exp: [],            // exports with/without payment
    sez: [],            // SEZ supplies
    cdnr: [],           // credit/debit notes - registered
    cdnur: [],          // credit/debit notes - unregistered
    nil_exempt: [],     // nil / exempt / non-GST (Core Rule 2)
    hsn: {},            // HSN summary keyed by hsn|rate
    docs_issued: [],
    amendments: [],
    totals: blankRow(),
    counts: { documents: 0, cancelled: 0, excluded: 0, creditNotes: 0 },
  };

  // ── Nil / Exempt / Non-GST bucket (Core Rule 2) ───────────────────────────
  // These must NOT be dropped even for a registered business.
  const nilRows = new Map(); // key: supplyType|interState|recipientType
  for (const doc of taxDocs) {
    const supply = classifySupply(doc, config);
    if (supply !== 'nil' && supply !== 'exempt' && supply !== 'non_gst') continue;
    const recipient = classifyRecipient(doc, config);   // b2b | b2c_large | b2c_small
    const posCode = doc.placeOfSupply || doc.customerStateCode || config.business.stateCode || '';
    const key = [supply, doc.interState ? 'inter' : 'intra', recipient].join('|');
    if (!nilRows.has(key)) {
      nilRows.set(key, {
        supplyType: supply,             // 'nil' | 'exempt' | 'non_gst'
        interState: doc.interState,
        recipientType: recipient,
        placeOfSupply: posCode,
        stateName: stateName(posCode),
        ...blankRow(),
        invoiceNos: [],
      });
    }
    const row = nilRows.get(key);
    const sign = doc.isNegative ? -1n : 1n;
    for (const l of doc.lines) { addLine(row, l, sign); row.invoiceNos.push(doc.invoiceNo); }
  }
  out.nil_exempt = [...nilRows.values()].map((r) => ({ ...r, invoiceCount: r.invoiceNos.length }));

  // ── Invoice-wise tables ──────────────────────────────────────────────────
  for (const doc of taxDocs) {
    out.counts.documents++;
    if (doc.isNegative) out.counts.creditNotes++;

    const supply = classifySupply(doc, config);
    const recipient = classifyRecipient(doc, config);
    const sign = doc.isNegative ? -1n : 1n;

    // exports / SEZ
    if (supply === 'zero_rated') {
      const row = {
        gstin: doc.customerGstin || 'URP',
        uin: doc.customerGstin ? '' : String(doc.raw?.uin || ''),
        invoiceNumber: doc.invoiceNo,
        invoiceDate: formatDate(doc.date),
        invoiceValuePaise: doc.totals.invoicePaise * sign,
        placeOfSupply: doc.placeOfSupply,
        rate: rateKey(doc.lines[0]?.ratePct || 0),
        taxablePaise: ZERO, igstPaise: ZERO, cessPaise: ZERO,
        // with/without payment. Accept the DB column name or the client-side
        // camelCase form, like every other field in normalizeSale — reading only
        // the camelCase key silently reported every export as WOPAY, because the
        // return is built from the raw DB rows.
        paymentType: String(doc.raw?.export_payment_type || doc.raw?.exportPaymentType || '')
          || config.exports.withoutPayment,
      };
      for (const l of doc.lines) { row.taxablePaise += l.taxablePaise * sign; row.igstPaise += l.igstPaise * sign; }
      const target = doc.supplyType === 'sez' ? out.sez : out.exp;
      target.push(row);
      continue;
    }

    // nil / exempt / non-GST already bucketed above — never mixed into B2x
    if (supply === 'nil' || supply === 'exempt' || supply === 'non_gst') continue;

    // credit / debit notes
    if (doc.isNegative) {
      const cdnType = classifyCreditNote(doc);
      const row = {
        gstin: doc.customerGstin || '',
        noteNumber: doc.invoiceNo,
        noteDate: formatDate(doc.date),
        noteType: doc.isCreditNote ? 'C' : 'D',
        // linked original invoice (mandatory for CDNR)
        originalInvoiceNumber: doc.linkedInvoiceNo || '',
        originalInvoiceDate: formatDate(doc.raw?.linked_invoice_date || ''),
        // reason for issue
        reason: String(doc.raw?.note_reason || doc.raw?.notes || ''),
        placeOfSupply: doc.placeOfSupply,
        rateBreakup: rateBreakup(doc, sign),
        ...sumRow(doc, sign),
      };
      (cdnType === 'cdnr' ? out.cdnr : out.cdnur).push(row);
      continue;
    }

    // regular taxable invoice
    const base = {
      invoiceNumber: doc.invoiceNo,
      invoiceDate: formatDate(doc.date),
      invoiceValuePaise: doc.totals.invoicePaise,
      placeOfSupply: doc.placeOfSupply,
      rateBreakup: rateBreakup(doc, sign),
      ...sumRow(doc, sign),
    };

    if (recipient === 'b2b') {
      out.b2b.push({
        gstin: doc.customerGstin,
        counterpartyName: doc.customerName,
        ...base,
      });
    } else if (recipient === 'b2c_large') {
      out.b2cl.push({ ecommerceGstin: doc.customerGstin || '', ...base });
    }
    // b2c_small is consolidated state-wise below, not invoice-wise
  }

  // ── B2C Small (state-wise + rate-wise consolidated) ─────────────────────
  const b2cSmallDocs = taxDocs.filter((d) => classifySupply(d, config) === 'taxable' && classifyRecipient(d, config) === 'b2c_small');
  out.b2cs = stateRateBreakup(b2cSmallDocs, config);

  // ── HSN summary ──────────────────────────────────────────────────────────
  out.hsn = buildHsnSummary(taxDocs, config);

  // ── Documents Issued (per series) ────────────────────────────────────────
  out.docs_issued = buildDocumentsIssued(eligible, config);

  // ── Amendments: corrections pointing at an earlier period ────────────────
  out.amendments = taxDocs.filter((d) => {
    const prior = d.raw?.original_invoice_period;
    return !!prior && String(prior) !== String(d.period);
  }).map((d) => ({
    invoiceNumber: d.invoiceNo,
    invoiceDate: formatDate(d.date),
    originalPeriod: String(d.raw.original_invoice_period),
    originalInvoiceNumber: String(d.raw.original_invoice_no || ''),
    reason: String(d.raw.amendment_reason || ''),
  }));

  // ── Totals ──────────────────────────────────────────────────────────────
  out.totals = grandTotals(out);
  out.counts.cancelled = eligible.length - taxDocs.length;
  return out;
}

/** Sum one document's line amounts with a sign. */
function sumRow(doc, sign) {
  const taxable = sumPaise(doc.lines.map((l) => l.taxablePaise));
  const cgst = sumPaise(doc.lines.map((l) => l.cgstPaise));
  const sgst = sumPaise(doc.lines.map((l) => l.sgstPaise));
  const igst = sumPaise(doc.lines.map((l) => l.igstPaise));
  const cess = sumPaise(doc.lines.map((l) => l.cessPaise));
  return {
    totalTaxablePaise: taxable * sign,
    totalCgstPaise: cgst * sign,
    totalSgstPaise: sgst * sign,
    totalIgstPaise: igst * sign,
    totalCessPaise: cess * sign,
    // Gross value of the note, matching what invoiceValuePaise means on a
    // regular invoice, so the portal JSON can reuse one field name.
    totalInvoicePaise: (taxable + cgst + sgst + igst + cess) * sign,
  };
}

/** HSN/SAC summary keyed by hsn|rate, with taxable value and tax split. */
function buildHsnSummary(docs, config) {
  const map = new Map();
  for (const doc of docs) {
    const supply = classifySupply(doc, config);
    const sign = doc.isNegative ? -1n : 1n;
    for (const l of doc.lines) {
      const code = String(l.hsn || l.sac || '').trim();
      const key = `${code}|${rateKey(l.ratePct)}`;
      if (!map.has(key)) {
        map.set(key, {
          hsnSac: code,
          description: l.name,
          uqc: l.uqc,
          rate: Number(l.ratePct),
          supplyType: supply,
          qtyTotal: '0',
          ...blankRow(),
          b2bTaxablePaise: ZERO, b2bCgstPaise: ZERO, b2bSgstPaise: ZERO, b2bIgstPaise: ZERO,
          b2cTaxablePaise: ZERO, b2cCgstPaise: ZERO, b2cSgstPaise: ZERO, b2cIgstPaise: ZERO,
          invoiceNos: [],
        });
      }
      const row = map.get(key);
      row.description = row.description || l.name;
      addLine(row, l, sign);
      // B2B / B2C split (required at higher turnover)
      if (classifyRecipient(doc, config) === 'b2b') {
        row.b2bTaxablePaise += l.taxablePaise * sign;
        row.b2bCgstPaise += l.cgstPaise * sign;
        row.b2bSgstPaise += l.sgstPaise * sign;
        row.b2bIgstPaise += l.igstPaise * sign;
      } else {
        row.b2cTaxablePaise += l.taxablePaise * sign;
        row.b2cCgstPaise += l.cgstPaise * sign;
        row.b2cSgstPaise += l.sgstPaise * sign;
        row.b2cIgstPaise += l.igstPaise * sign;
      }
      row.qtyTotal = addQtyStrings(row.qtyTotal, l.qty);
      if (!row.invoiceNos.includes(doc.invoiceNo)) row.invoiceNos.push(doc.invoiceNo);
    }
  }
  const rows = [...map.values()].sort((a, b) => (a.hsnSac < b.hsnSac ? -1 : a.hsnSac > b.hsnSac ? 1 : a.rate - b.rate));
  const byHsn = {};
  for (const r of rows) {
    if (!r.hsnSac) continue;
    if (!byHsn[r.hsnSac]) byHsn[r.hsnSac] = { hsn: r.hsnSac, rows: [], ...blankRow() };
    const agg = byHsn[r.hsnSac];
    agg.rows.push(r);
    agg.taxablePaise += r.taxablePaise;
    agg.cgstPaise += r.cgstPaise;
    agg.sgstPaise += r.sgstPaise;
    agg.igstPaise += r.igstPaise;
    agg.cessPaise += r.cessPaise;
  }
  return { rows, byHsn };
}

function addQtyStrings(a, b) {
  const na = Number(a); const nb = Number(b);
  if (!isFinite(na) || !isFinite(nb)) return String(a || b || '');
  return String(na + nb);
}

/**
 * Table 13 — Documents Issued, grouped per invoice series.
 * Cancelled invoices are shown here but excluded from all tax tables (Part 1).
 */
function buildDocumentsIssued(eligibleDocs, config) {
  const series = new Map();
  const numOf = (n) => String(n || '');

  for (const d of eligibleDocs) {
    const key = String(d.raw?.invoice_series || d.docTypeLabel);
    if (!series.has(key)) {
      series.set(key, {
        series: key,
        docType: d.docType,
        docTypeLabel: d.docTypeLabel,
        fromNumber: d.invoiceNo,
        toNumber: d.invoiceNo,
        totalIssued: 0,
        totalCancelled: 0,
        cancelledNumbers: [],
        rateTotals: [],
        netTaxablePaise: ZERO,
        netTaxPaise: ZERO,
      });
    }
    const s = series.get(key);
    if (numOf(d.invoiceNo) < numOf(s.fromNumber)) s.fromNumber = d.invoiceNo;
    if (numOf(d.invoiceNo) > numOf(s.toNumber)) s.toNumber = d.invoiceNo;

    if (d.isCancelled) {
      s.totalCancelled++;
      s.cancelledNumbers.push(d.invoiceNo);
    } else {
      s.totalIssued++;
      s.netTaxablePaise += d.totals.taxablePaise;
      s.netTaxPaise += d.totals.cgstPaise + d.totals.sgstPaise + d.totals.igstPaise;
    }
  }

  // Rate-wise totals per series (tax invoices only, cancelled excluded)
  for (const s of series.values()) {
    const byRate = new Map();
    for (const d of eligibleDocs) {
      if (d.isCancelled) continue;
      if (String(d.raw?.invoice_series || d.docTypeLabel) !== s.series) continue;
      const sign = d.isNegative ? -1n : 1n;
      for (const l of d.lines) {
        const k = rateKey(l.ratePct);
        if (!byRate.has(k)) byRate.set(k, blankRow());
        addLine(byRate.get(k), l, sign);
      }
    }
    s.rateTotals = [...byRate.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([rate, row]) => ({ rate: Number(rate), ...row }));
  }
  return [...series.values()];
}

/** Grand totals across all tax-bearing tables. */
function grandTotals(out) {
  const t = blankRow();
  const eat = (arr, sign = 1) => {
    for (const r of arr || []) {
      t.taxablePaise += (r.taxablePaise ?? r.totalTaxablePaise ?? ZERO) * BigInt(sign);
      t.cgstPaise += (r.cgstPaise ?? r.totalCgstPaise ?? ZERO) * BigInt(sign);
      t.sgstPaise += (r.sgstPaise ?? r.totalSgstPaise ?? ZERO) * BigInt(sign);
      t.igstPaise += (r.igstPaise ?? r.totalIgstPaise ?? ZERO) * BigInt(sign);
      t.cessPaise += (r.cessPaise ?? r.totalCessPaise ?? ZERO) * BigInt(sign);
    }
  };
  eat(out.b2b); eat(out.b2cl); eat(out.b2cs);
  eat(out.exp); eat(out.sez);
  eat(out.cdnr); eat(out.cdnur);
  eat(out.nil_exempt);
  return t;
}

module.exports = {
  buildGSTR1,
  buildHsnSummary,
  buildDocumentsIssued,
  stateRateBreakup,
  rateBreakup,
  grandTotals,
  sumRow,
  blankRow,
  toPaise,
};