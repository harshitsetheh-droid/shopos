'use strict';
/**
 * GSTR-3B summary + ITC set-off.
 *
 * Outward (3.1) values are derived from the SAME documents that build GSTR-1,
 * so the two always tie out. ITC (Table 4) comes from reconciled purchase
 * entries (see reconcile.js) — only accepted/matched entries may be claimed.
 */
const { DEFAULT_CONFIG } = require('./config');
const { sumPaise } = require('./money');
const { classifySupply, NON_RETURN_DOC_TYPES } = require('./classify');

const ZERO = 0n;

/**
 * @param {Array} taxDocs      normalised, non-draft, non-cancelled docs in period
 * @param {object} itc         { importGoods, rcm, isd, others, reversed, ineligible }  (paise)
 * @param {object} manual      { interest, lateFee, cashBalance, creditBalance,cessInterest } (paise)
 * @param {object} gstr1       the GSTR-1 object, for cross-checking
 */
function buildGSTR3B(taxDocs, itc, manual, gstr1, cfg) {
  const config = cfg || DEFAULT_CONFIG;

  // Core Rule 1: estimates, quotations and delivery challans are never part of
  // 3B. Filter here too so 3B can never pick them up from a caller that
  // passed every document in the period.
  const reportable = (taxDocs || []).filter((d) => !d.isDraft && !d.isCancelled
    && !NON_RETURN_DOC_TYPES.has(d.docType));

  // ── 3.1 Outward supplies ────────────────────────────────────────────────
  const t31 = {
    a_taxable: blank(),
    b_zero_rated: blank(),
    c_nil_exempt: blank(),
    d_reverse_charge: blank(),
    e_non_gst: blank(),
  };

  for (const doc of reportable) {
    const supply = classifySupply(doc, config);
    const sign = doc.isNegative ? -1n : 1n;
    const add = (bucket) => {
      bucket.taxablePaise += doc.totals.taxablePaise * sign;
      bucket.igstPaise += doc.totals.igstPaise * sign;
      bucket.cgstPaise += doc.totals.cgstPaise * sign;
      bucket.sgstPaise += doc.totals.sgstPaise * sign;
      bucket.cessPaise += doc.totals.cessPaise * sign;
    };
    if (doc.reverseCharge) { add(t31.d_reverse_charge); continue; }
    switch (supply) {
      case 'taxable':    add(t31.a_taxable); break;
      case 'zero_rated': add(t31.b_zero_rated); break;
      case 'nil':
      case 'exempt':     add(t31.c_nil_exempt); break;
      case 'non_gst':    add(t31.e_non_gst); break;
      default:           add(t31.a_taxable); break;
    }
  }

  // ── 3.2 Inter-state supplies to unregistered / composition / UIN holders ──
  const t32 = blank();
  for (const doc of reportable) {
    if (doc.customerGstin) continue;               // registered → 3.1(a)
    if (!doc.interState) continue;                  // intra-state → not 3.2
    const sign = doc.isNegative ? -1n : 1n;
    t32.taxablePaise += doc.totals.taxablePaise * sign;
    t32.igstPaise += doc.totals.igstPaise * sign;
    t32.cgstPaise += doc.totals.cgstPaise * sign;
    t32.sgstPaise += doc.totals.sgstPaise * sign;
    t32.cessPaise += doc.totals.cessPaise * sign;
  }

  // ── Table 4: ITC ─────────────────────────────────────────────────────────
  const itcIn = itc || {};
  const t4 = {
    eligible: {
      importGoods: nz(itcIn.importGoods),   // 4(A)(1)(a)  import of goods
      importServices: nz(itcIn.importServices), // 4(A)(1)(b)
      rcm: nz(itcIn.rcm),                   // 4(A)(5)    RCM on inward supplies
      isd: nz(itcIn.isd),                   // 4(A)(6)    ISD credit received
      others: nz(itcIn.others),             // 4(A)(7)    all other ITC
    },
    reversed: nz(itcIn.reversed),           // 4(B)
    ineligible: nz(itcIn.ineligible),       // 4(C)  Sec 17(5)
  };
  t4.totalEligible = t4.eligible.importGoods + t4.eligible.importServices
    + t4.eligible.rcm + t4.eligible.isd + t4.eligible.others;
  t4.netAvailable = t4.totalEligible - t4.reversed - t4.ineligible;

  // ── Liability & set-off ──────────────────────────────────────────────────
  const liability = {
    igst: t31.a_taxable.igstPaise + t31.b_zero_rated.igstPaise + t31.d_reverse_charge.igstPaise,
    cgst: t31.a_taxable.cgstPaise + t31.d_reverse_charge.cgstPaise,
    sgst: t31.a_taxable.sgstPaise + t31.d_reverse_charge.sgstPaise,
    cess: t31.a_taxable.cessPaise + t31.b_zero_rated.cessPaise
      + t31.c_nil_exempt.cessPaise + t31.d_reverse_charge.cessPaise + t31.e_non_gst.cessPaise,
  };

  const manualIn = manual || {};
  const additions = {
    interest: nz(manualIn.interest),
    lateFee: nz(manualIn.lateFee),
    // credit ledger balance available to offset liability
    credit: nz(manualIn.creditBalance),
  };

  // ITC by head — caller supplies the split from reconciliation
  const credit = {
    igst: nz((itcIn.creditByHead || {}).igst),
    cgst: nz((itcIn.creditByHead || {}).cgst),
    sgst: nz((itcIn.creditByHead || {}).sgst),
    cess: nz((itcIn.creditByHead || {}).cess),
  };

  const setOff = applySetOff(liability, credit, config.setOffOrder);
  // Cash ledger (challans already paid) applies only after all credit is
  // exhausted, and against every head — not just IGST. It used to be applied to
  // IGST alone, so challan money never reduced CGST/SGST payable and the return
  // overstated what was owed even though the shop had already paid.
  const CASH_ORDER = ['igst', 'cgst', 'sgst', 'cess'];
  const cashUsed = { igst: ZERO, cgst: ZERO, sgst: ZERO, cess: ZERO };
  let cashLeft = nz(manualIn.cashBalance);
  for (const head of CASH_ORDER) {
    if (cashLeft <= ZERO) break;
    const used = minBig(setOff.payable[head], cashLeft);
    cashUsed[head] = used;
    setOff.payable[head] -= used;
    cashLeft -= used;
  }
  setOff.cashUsed = cashUsed;

  // ── Cross-check against GSTR-1 ───────────────────────────────────────────
  const tieOut = tieToGSTR1(t31, gstr1);

  return {
    t31,
    t32,
    table4: t4,
    liability,
    creditAvail: credit,
    additions,
    setOff,
    tieOut,
    totals: {
      // 3.2 is a memorandum disclosure of supplies already counted in 3.1(a) /
      // 3.1(b), so it is deliberately NOT added here.
      taxablePaise: t31.a_taxable.taxablePaise + t31.b_zero_rated.taxablePaise
        + t31.c_nil_exempt.taxablePaise + t31.d_reverse_charge.taxablePaise
        + t31.e_non_gst.taxablePaise,
      taxPaise: liability.igst + liability.cgst + liability.sgst + liability.cess,
    },
  };
}

function blank() {
  return { taxablePaise: ZERO, igstPaise: ZERO, cgstPaise: ZERO, sgstPaise: ZERO, cessPaise: ZERO };
}
function nz(v) { return typeof v === 'bigint' ? v : BigInt(v || 0); }
function minBig(a, b) { return a < b ? a : b; }

/**
 * Apply ITC against liability in the statutory order (config.setOffOrder).
 * Returns a matrix of what was consumed and the residual payable.
 */
function applySetOff(liability, credit, order) {
  const seq = order && order.length ? order : [['igst', 'igst']];
  // working copies
  const L = { igst: nz(liability.igst), cgst: nz(liability.cgst), sgst: nz(liability.sgst), cess: nz(liability.cess) };
  const C = { igst: nz(credit.igst), cgst: nz(credit.cgst), sgst: nz(credit.sgst), cess: nz(credit.cess) };
  const consumed = { igst: ZERO, cgst: ZERO, sgst: ZERO, cess: ZERO };
  const steps = [];

  // config.setOffOrder is [creditHead, liabilityHead] in statutory sequence,
  // e.g. IGST credit against IGST, then CGST, then SGST liability.
  for (const [creditHead, liabilityHead] of seq) {
    if (C[creditHead] <= 0n) continue;
    const use = L[liabilityHead] < C[creditHead] ? L[liabilityHead] : C[creditHead];
    if (use <= 0n) continue;
    L[liabilityHead] -= use;
    C[creditHead] -= use;
    consumed[creditHead] += use;
    steps.push({ creditHead, againstHead: liabilityHead, amountPaise: use });
  }
  // residual ITC (credit left) is carried forward, not lost
  return {
    steps,
    consumed,
    remainingCredit: { igst: C.igst, cgst: C.cgst, sgst: C.sgst, cess: C.cess },
    payable: { igst: L.igst, cgst: L.cgst, sgst: L.sgst, cess: L.cess },
    cashUsed: { igst: ZERO },
  };
}

/** 3B outward values must equal GSTR-1 totals; surface any difference. */
function tieToGSTR1(t31, gstr1) {
  if (!gstr1) return { checked: false };
  const g = gstr1;
  const gstr1Taxable =
    sumBig(g.b2b, 'totalTaxablePaise') + sumBig(g.b2cl, 'totalTaxablePaise') + sumBig(g.b2cs, 'taxablePaise')
    + sumBig(g.exp, 'taxablePaise') + sumBig(g.sez, 'taxablePaise')
    + sumBig(g.cdnr, 'totalTaxablePaise') + sumBig(g.cdnur, 'totalTaxablePaise');
  const gstr1NilExempt = sumBig(g.nil_exempt, 'taxablePaise');

  // 3.1(e) Non-GST outward supplies ARE part of the 3B outward total, and on the
  // GSTR-1 side they already sit inside nil_exempt. They have to appear on BOTH
  // sides or the tie-out reports a false difference for every period containing a
  // non-GST bill — which is exactly the "Core Rule 2 supplies are included" case.
  const t3bTaxable = t31.a_taxable.taxablePaise + t31.b_zero_rated.taxablePaise
    + t31.d_reverse_charge.taxablePaise + t31.e_non_gst.taxablePaise;
  const t3bNilExempt = t31.c_nil_exempt.taxablePaise;

  const gstr1Igst = sumBig(g.b2b, 'totalIgstPaise') + sumBig(g.b2cl, 'totalIgstPaise')
    + sumBig(g.b2cs, 'igstPaise') + sumBig(g.exp, 'igstPaise') + sumBig(g.sez, 'igstPaise')
    + sumBig(g.cdnr, 'totalIgstPaise') + sumBig(g.cdnur, 'totalIgstPaise')
    + sumBig(g.nil_exempt, 'igstPaise');   // non-GST rows carry no IGST, kept for symmetry
  const t3bIgst = t31.a_taxable.igstPaise + t31.b_zero_rated.igstPaise
    + t31.d_reverse_charge.igstPaise + t31.e_non_gst.igstPaise;   // non-GST rows carry no IGST

  const diffTaxable = gstr1Taxable + gstr1NilExempt - (t3bTaxable + t3bNilExempt);
  const diffIgst = gstr1Igst - t3bIgst;

  return {
    checked: true,
    gstr1TaxablePaise: gstr1Taxable,
    gstr1NilExemptPaise: gstr1NilExempt,
    gstr1IgstPaise: gstr1Igst,
    t3bTaxablePaise: t3bTaxable,
    t3bNilExemptPaise: t3bNilExempt,
    t3bIgstPaise: t3bIgst,
    diffTaxablePaise: diffTaxable,
    diffIgstPaise: diffIgst,
    balanced: diffTaxable === 0n && diffIgst === 0n,
  };
}

function sumBig(arr, field) {
  return (arr || []).reduce((a, r) => a + nz(r ? r[field] : 0), ZERO);
}

module.exports = { buildGSTR3B, applySetOff, tieToGSTR1, blank };