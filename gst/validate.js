'use strict';
/**
 * Pre-filing validation report (Part 2).
 * Every issue carries the document number so the user can jump straight to it.
 * BLOCKER = export refused. WARNING = export allowed after explicit confirm.
 */
const { DEFAULT_CONFIG } = require('./config');
const { toPaise, fmtPaise } = require('./money');
const { validateGSTIN, stateCodeOf } = require('./gstin');
const { classifySupply, findSuspiciousNonGstLines, NON_RETURN_DOC_TYPES } = require('./classify');

const BLOCKER = 'BLOCKER';
const WARNING = 'WARNING';

function issue(severity, code, message, doc, extra) {
  return {
    severity, code, message,
    docId: doc ? doc.id : '',
    invoiceNo: doc ? doc.invoiceNo : '',
    docDate: doc ? doc.date : '',
    customer: doc ? doc.customerName : '',
    fix: (extra && extra.fix) || '',
    ...(extra || {}),
  };
}

/**
 * @param {Array} docs  normalised documents in the period (incl. cancelled)
 * @param {object} ctx  { lockedPeriods:Set, cfg, masterIndex, gstin, allDocs }
 *   `allDocs` is every document across all periods. Invoice numbers must be
 *   unique per series for the whole financial year, not just within one period,
 *   and a period-only view cannot see a number reused in a sibling month.
 */
function validateForFiling(docs, ctx) {
  const config = (ctx && ctx.cfg) || DEFAULT_CONFIG;
  const lockedRaw = (ctx && ctx.lockedPeriods) || [];
  // accept a Set, an array, or a comma-separated string
  const locked = lockedRaw instanceof Set
    ? lockedRaw
    : new Set(Array.isArray(lockedRaw)
      ? lockedRaw
      : String(lockedRaw).split(',').map((s) => s.trim()).filter(Boolean));
  const masterIndex = ctx && ctx.masterIndex;
  const issues = [];

  // ── Own GSTIN sanity ────────────────────────────────────────────────────
  const ownGstin = config.business.gstin;
  if (!ownGstin) {
    issues.push(issue(BLOCKER, 'OWN_GSTIN_MISSING',
      'Your business GSTIN is not configured. GSTR-1/3B cannot be generated without it.',
      null, { fix: 'GST panel → Settings → Business GSTIN' }));
  } else {
    const chk = validateGSTIN(ownGstin, config);
    if (!chk.valid) {
      const checksumOnly = chk.reason === 'CHECKSUM';
      const sev = checksumOnly && !config.gstin.checksum.enforced ? WARNING : BLOCKER;
      issues.push(issue(sev, checksumOnly ? 'OWN_GSTIN_CHECKSUM' : 'OWN_GSTIN_INVALID',
        `Business GSTIN "${ownGstin}" failed the ${chk.reason} check.`
        + (checksumOnly ? ' (Checksum enforcement is off — verify against the GST portal.)' : ''),
        null, { fix: 'GST panel → Settings → correct the GSTIN' }));
    }
  }
  if (!config.business.stateCode) {
    issues.push(issue(BLOCKER, 'PLACE_OF_SUPPLY_MISSING',
      'Business state code / place of supply is not configured; CGST vs IGST cannot be decided.',
      null, { fix: 'GST panel → Settings → State code' }));
  }

  const seenInvoiceNos = new Map();  // invoiceNo -> docId  (duplicate detection)
  const perSeries = new Map();       // series -> [numeric suffix] (gap detection)

  // Invoice numbers must be unique per series across the whole financial year.
  // The docs passed in are one period, so a number reused in another month was
  // invisible here — a filing the portal rejects, reported as clean.
  const fySeen = new Map();          // `${fy}|${series}|${invoiceNo}` -> [{period, id}]
  for (const d of (ctx && ctx.allDocs) || []) {
    if (!d.invoiceNo || d.isDraft) continue;
    const series = String(d.raw?.invoice_series || d.docTypeLabel || '');
    const key = `${d.financialYear}|${series}|${String(d.invoiceNo).trim().toUpperCase()}`;
    if (!fySeen.has(key)) fySeen.set(key, []);
    fySeen.get(key).push(d);
  }

  for (const doc of docs) {
    const n = doc.invoiceNo;

    // A GST rate of 0 is correct — not missing — on a supply the counter actually
    // declared nil-rated / exempt / non-GST, and on a document that is not in a
    // return at all (estimates, delivery challans). Demanding a rate there buried
    // the real blockers under noise on every period that contained one.
    //
    // This must NOT be keyed off classifySupply: for a genuinely taxable line
    // whose rate was simply never set, classifySupply deliberately falls through
    // to 'non_gst' and leaves flagging it to THIS rule. Keying off it would switch
    // the check off for exactly the case it exists to catch.
    const declaredNonTaxable = doc.lines.every((l) => l.isNil || l.isExempt || l.isNonGst)
      || !!(doc.nilRatedReason || doc.exemptReason || doc.nonGstReason);
    const rateRequired = !NON_RETURN_DOC_TYPES.has(doc.docType) && !declaredNonTaxable;

    // ── Locked / filed period documents ──────────────────────────────────
    if (locked.has(doc.period)) {
      issues.push(issue(BLOCKER, 'LOCKED_PERIOD',
        `${n} belongs to a locked/filed period (${doc.period}). It cannot be edited; raise a credit note instead.`,
        doc, { fix: 'Raise a credit note in the current period' }));
    }

    // ── Estimates / Quotations / Challans must never appear ───────────────
    if (doc.docType === 'estimate' || doc.docType === 'quotation'
      || doc.docType === 'delivery_challan' || doc.docType === 'challan') {
      issues.push(issue(BLOCKER, 'NON_RETURN_DOC_PRESENT',
        `${n} is a ${doc.docTypeLabel} — such documents must never be included in a return.`,
        doc, { fix: 'Mark the document as a Tax Invoice / Bill of Supply, or exclude it' }));
    }
    if (doc.isDraft) {
      issues.push(issue(WARNING, 'DRAFT_DOC',
        `${n} is still a draft and has been excluded from the return.`, doc,
        { fix: 'Finalise the document if it should be reported' }));
    }

    // ── Invoice number format & length ───────────────────────────────────
    if (!n) {
      issues.push(issue(BLOCKER, 'INVOICE_NO_MISSING', 'Document has no invoice number.', doc));
    } else {
      if (String(n).length > config.invoice.maxLength) {
        issues.push(issue(BLOCKER, 'INVOICE_NO_TOO_LONG',
          `Invoice number "${n}" exceeds ${config.invoice.maxLength} characters (${String(n).length}).`, doc,
          { fix: 'Shorten the invoice number' }));
      }
      const okChars = new RegExp(config.invoice.allowedChars).test(String(n));
      if (!okChars) {
        issues.push(issue(BLOCKER, 'INVOICE_NO_INVALID_CHARS',
          `Invoice number "${n}" contains characters that are not allowed.`, doc,
          { fix: 'Use only letters, digits and / - _ .' }));
      }
      if (seenInvoiceNos.has(n) && seenInvoiceNos.get(n) !== doc.id) {
        issues.push(issue(BLOCKER, 'DUPLICATE_INVOICE_NO',
          `Invoice number "${n}" is used by more than one document.`, doc,
          { fix: 'Give each document a unique invoice number' }));
      }
      seenInvoiceNos.set(n, doc.id);

      // same number, different period, same financial year — invisible to the
      // within-period check above
      const dupSeries = String(doc.raw?.invoice_series || doc.docTypeLabel || '');
      const dupes = (fySeen.get(`${doc.financialYear}|${dupSeries}|${String(n).trim().toUpperCase()}`) || [])
        .filter((x) => x.id !== doc.id);
      if (dupes.length) {
        issues.push(issue(BLOCKER, 'DUPLICATE_INVOICE_NO',
          `Invoice number "${n}" is also used in ${dupes.map((x) => x.period).join(', ')} — `
          + 'invoice numbers must be unique across the financial year.', doc,
          { fix: 'Renumber this document, or raise a credit note against the earlier one' }));
      }

      // gap detection within a series (numeric suffix only)
      const series = String(doc.raw?.invoice_series || doc.docTypeLabel);
      const m = /(\d+)\s*$/.exec(String(n));
      if (m) {
        if (!perSeries.has(series)) perSeries.set(series, new Set());
        perSeries.get(series).add(Number(m[1]));
      }
    }

    // ── Line-level: HSN/SAC presence & digit count ───────────────────────
    for (const l of doc.lines) {
      const code = String(l.hsn || l.sac || '').trim();
      // HSN recovered from the product master is still a data gap on the document
      if (l.hsnFromMaster) {
        issues.push(issue(WARNING, 'HSN_FROM_MASTER',
          `${n}: item "${l.name}" has no HSN on the invoice; ${code} was taken from the product master.`, doc,
          { fix: `Add HSN ${code} to "${l.name}" on the document, or fix the product master` }));
      }
      if (!code) {
        issues.push(issue(BLOCKER, 'HSN_MISSING',
          `${n}: item "${l.name}" has no HSN/SAC code.`, doc,
          { fix: `Add HSN/SAC to "${l.name}" in the product master` }));
      } else {
        const isSac = !!l.sac && !l.hsn;
        const re = isSac ? new RegExp(config.hsn.sacPattern) : new RegExp(config.hsn.pattern);
        if (!re.test(code)) {
          issues.push(issue(BLOCKER, 'HSN_INVALID',
            `${n}: item "${l.name}" HSN/SAC "${code}" is not a valid code.`, doc,
            { fix: 'Correct the HSN/SAC in the product master' }));
        } else if (code.length < requiredHsnDigits(ctx, config)) {
          issues.push(issue(WARNING, 'HSN_TOO_FEW_DIGITS',
            `${n}: item "${l.name}" HSN "${code}" has ${code.length} digits but ${requiredHsnDigits(ctx, config)} are required for your turnover.`,
            doc, { fix: 'Expand the HSN to the required number of digits' }));
        }
      }

      // missing GST rate on a taxable line
      if (rateRequired && !l.isNil && !l.isExempt && !l.isNonGst && l.taxablePaise > 0n
        && Number(l.ratePct) === 0 && l.masterRate === 0) {
        issues.push(issue(BLOCKER, 'RATE_MISSING',
          `${n}: item "${l.name}" has no GST rate set.`, doc,
          { fix: `Set CGST/SGST or IGST for "${l.name}" in the product master` }));
      }
      // rate not in the configured slab list
      if (l.ratePct && !config.rates.includes(Number(l.ratePct))) {
        issues.push(issue(WARNING, 'RATE_UNUSUAL',
          `${n}: item "${l.name}" uses rate ${l.ratePct}% which is not a standard slab.`, doc,
          { fix: 'Confirm the rate is correct for this HSN' }));
      }
    }

    // ── Customer GSTIN ───────────────────────────────────────────────────
    if (doc.customerGstin) {
      const chk = validateGSTIN(doc.customerGstin, config);
      if (!chk.valid) {
        // Length / format / state-code problems are always blockers.
        // A checksum mismatch is only a blocker when enforcement is switched on.
        const checksumOnly = chk.reason === 'CHECKSUM';
        const sev = checksumOnly && !config.gstin.checksum.enforced ? WARNING : BLOCKER;
        issues.push(issue(sev, checksumOnly ? 'CUST_GSTIN_CHECKSUM' : 'CUST_GSTIN_INVALID',
          `${n}: customer GSTIN "${doc.customerGstin}" failed the ${chk.reason} check.`
          + (checksumOnly ? ' (Checksum enforcement is off — verify against the GST portal.)' : ''),
          doc, { fix: 'Verify the customer GSTIN on the document' }));
      } else if (chk.stateCode && doc.placeOfSupply && chk.stateCode !== doc.placeOfSupply) {
        issues.push(issue(WARNING, 'POS_GSTIN_STATE_MISMATCH',
          `${n}: customer GSTIN state ${chk.stateCode} (${stateNameOf(chk.stateCode)}) differs from place of supply ${doc.placeOfSupply}.`,
          doc, { fix: 'Verify the place of supply / GSTIN state' }));
      }
    }

    // ── Tax split vs place of supply ─────────────────────────────────────
    const taxHeads = (doc.totals.cgstPaise + doc.totals.sgstPaise) > 0n;
    if (!doc.interState && doc.totals.igstPaise > 0n) {
      issues.push(issue(BLOCKER, 'SPLIT_SHOULD_BE_CGST_SGST',
        `${n}: intra-state supply but IGST is charged. Should be CGST + SGST.`, doc,
        { fix: 'Re-issue with CGST + SGST' }));
    }
    if (doc.interState && taxHeads) {
      issues.push(issue(BLOCKER, 'SPLIT_SHOULD_BE_IGST',
        `${n}: inter-state supply but CGST/SGST is charged. Should be IGST.`, doc,
        { fix: 'Re-issue with IGST' }));
    }
    if (!doc.interState && doc.totals.cgstPaise !== doc.totals.sgstPaise && doc.totals.cgstPaise > 0n) {
      issues.push(issue(WARNING, 'SPLIT_NOT_EQUAL',
        `${n}: CGST (${fmtPaise(doc.totals.cgstPaise)}) and SGST (${fmtPaise(doc.totals.sgstPaise)}) are not equal for an intra-state supply.`, doc));
    }

    // ── Line totals vs header totals ─────────────────────────────────────
    const lineSum = doc.lines.reduce((a, l) => a + l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise, 0n);
    if (doc.totals.invoicePaise !== lineSum) {
      issues.push(issue(BLOCKER, 'HEADER_LINE_MISMATCH',
        `${n}: header total ${fmtPaise(doc.totals.invoicePaise)} ≠ sum of lines ${fmtPaise(lineSum)}.`, doc,
        { fix: 'Recalculate the invoice totals' }));
    }
    // drift vs what was originally stored at billing time
    if (doc.storedTotalRupees > 0) {
      const storedInvoice = toPaise(String(doc.storedTotalRupees));
      const drift = storedInvoice - doc.totals.invoicePaise;
      // drift > 0 means the books recorded MORE than the lines add up to, i.e. the
      // recomputed total is lower. (The comparison used to be inverted, so this
      // fired on the opposite case and stayed silent on the real one.)
      if (drift > 0n) {
        issues.push(issue(WARNING, 'TOTAL_LOWER_THAN_STORED',
          `${n}: recomputed total ${fmtPaise(doc.totals.invoicePaise)} is lower than the stored total ${fmtPaise(storedInvoice)}.`, doc,
          { fix: 'Review the invoice — a taxable line may be missing' }));
      }
    }

    // ── Credit note must reference an original invoice ───────────────────
    if (doc.isNegative) {
      if (!doc.linkedInvoiceNo && !doc.linkedInvoiceId) {
        issues.push(issue(BLOCKER, 'CDN_NO_ORIGINAL',
          `${n}: ${doc.docTypeLabel} has no linked original invoice number.`, doc,
          { fix: 'Link the original invoice number' }));
      }
      if (doc.customerGstin && !doc.linkedInvoiceNo) {
        issues.push(issue(WARNING, 'CDNR_NO_ORIGINAL',
          `${n}: credit note to a registered customer must cite the original invoice's GSTIN and number.`, doc));
      }
    }

    // ── Suspicious "non-GST" bills (Core Rule 3 — CRITICAL) ─────────────
    const susp = findSuspiciousNonGstLines(doc, masterIndex);
    for (const s of susp) {
      const ln = s.lineIdx != null ? doc.lines[s.lineIdx] : null;
      const declaredAs = ln && ln.isNonGst ? 'non-GST' : (ln && ln.isNil ? 'nil-rated' : 'exempt');
      issues.push(issue(BLOCKER, 'NON_GST_BUT_TAXABLE_ITEM',
        `${n}: "${s.name}" is declared ${declaredAs} but the product master carries ${s.masterRate}% GST. `
        + 'A taxable sale cannot be excluded from the return.',
        doc, { fix: `Set GST ${s.masterRate}% on "${s.name}", or correct the supply classification` }));
    }

    // ── Nil / exempt / non-GST must carry a reason (Core Rule 2) ─────────
    const supply = classifySupply(doc, config);
    if (supply === 'nil' && !doc.nilRatedReason) {
      issues.push(issue(WARNING, 'NIL_NO_REASON',
        `${n}: nil-rated supply with no reason recorded.`, doc,
        { fix: 'Record the nil-rated reason' }));
    }
    if (supply === 'exempt' && !doc.exemptReason) {
      issues.push(issue(WARNING, 'EXEMPT_NO_REASON',
        `${n}: exempt supply with no reason recorded.`, doc,
        { fix: 'Record the exemption reason' }));
    }
    if (supply === 'non_gst' && !doc.nonGstReason) {
      issues.push(issue(WARNING, 'NONGST_NO_REASON',
        `${n}: non-GST supply with no reason recorded.`, doc,
        { fix: 'Record the non-GST reason (e.g. unprocessed agricultural produce)' }));
    }
  }

  // ── Gaps in a document series ──────────────────────────────────────────
  for (const [series, nums] of perSeries) {
    if (nums.size < 2) continue;
    const sorted = [...nums].sort((a, b) => a - b);
    const gaps = [];
    for (let i = sorted[0] + 1; i < sorted[sorted.length - 1]; i++) {
      if (!nums.has(i)) gaps.push(i);
    }
    if (gaps.length) {
      issues.push(issue(WARNING, 'SERIES_GAP',
        `Series "${series}" has gaps in numbering: ${gaps.slice(0, 12).join(', ')}${gaps.length > 12 ? '…' : ''}.`,
        null, { fix: 'Confirm the missing numbers are genuinely unused' }));
    }
  }

  const blockers = issues.filter((i) => i.severity === BLOCKER);
  const warnings = issues.filter((i) => i.severity === WARNING);

  return {
    issues,
    blockers,
    warnings,
    counts: { blockers: blockers.length, warnings: warnings.length, total: issues.length },
    canExport: blockers.length === 0,   // Part 2: must pass before export
  };
}

function requiredHsnDigits(ctx, config) {
  const turnover = Number((ctx && ctx.annualTurnoverRupees) || 0);
  for (const b of config.hsn.digitsByTurnover) {
    if (turnover <= b.upto) return b.digits;
  }
  return config.hsn.minDigits;
}

function stateNameOf(code) {
  return require('./gstin').stateName(code) || code;
}

module.exports = { validateForFiling, BLOCKER, WARNING };