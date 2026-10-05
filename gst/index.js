'use strict';
/**
 * Barrel + orchestration. `buildReturn` is the single entry point the API/UI calls.
 */
const config = require('./config');
const money = require('./money');
const gstin = require('./gstin');
const period = require('./period');
const classify = require('./classify');
const gstr1 = require('./gstr1');
const gstr3b = require('./gstr3b');
const validate = require('./validate');
const reconcile = require('./reconcile');
const schema = require('./schema');

/**
 * Full pipeline for one period.
 *
 * @param {object} input
 *   sales            raw sale rows (snake_case from DB)
 *   purchases        raw purchase rows for ITC
 *   products         product master
 *   cfg              config overrides
 *   period           "YYYY-MM"
 *   lockedPeriods    array of locked period strings
 *   recon2B          parsed 2B rows
 *   reconDecisions   Map
 *   manual3B         { interest, lateFee, cashBalance, creditBalance }
 */
function buildReturn(input) {
  const cfg = config.mergeConfig(input.cfg, config.DEFAULT_CONFIG);
  const periodStr = input.period;

  // 1. normalise + filter to period
  const masterIndex = classify.buildMasterIndex(input.products);
  const allDocs = (input.sales || []).map((s) => classify.normalizeSale(s, cfg, masterIndex));
  const periodDocs = allDocs.filter((d) => d.period === periodStr);

  // 2. validation FIRST — export is blocked while blockers exist
  const validation = validate.validateForFiling(periodDocs, {
    cfg,
    masterIndex,
    lockedPeriods: new Set(input.lockedPeriods || []),
    annualTurnoverRupees: input.annualTurnoverRupees || 0,
  });

  // 3. GSTR-1
  const g1 = gstr1.buildGSTR1(periodDocs, cfg, { period: periodStr });

  // 4. GSTR-3B (ITC from reconciliation only)
  const recon = reconcile.reconcile2B(
    (input.purchases || []).map(normalisePurchase),
    input.recon2B || [],
    cfg,
    input.reconDecisions,
  );
  const taxDocs = periodDocs.filter((d) => !d.isDraft && !d.isCancelled);
  const g3b = gstr3b.buildGSTR3B(
    taxDocs,
    {
      // Reconcile's Table 4(A) split. Without this, Table 4 came out at zero even
      // when reconciliation had accepted credit — the claimed ITC never reached
      // the return.
      ...(recon.summary.table4 || {}),
      creditByHead: recon.summary.claimableByHead,
    },
    input.manual3B || {},
    g1,
    cfg,
  );

  // 5. reconciliations
  const booksVsReturn = reconcile.reconcileBooksVsReturn(periodDocs, g1, g3b, cfg);
  const turnover = reconcile.annualTurnover(allDocs, cfg, periodStr + '-01');

  // 6. JSON + schema validation (always produced so the UI can preview)
  const portalJSON = schema.toPortalJSON(g1, cfg, { period: periodStr });
  const schemaCheck = schema.validatePortalJSON(portalJSON, cfg);

  return {
    period: periodStr,
    cfg,
    docs: periodDocs,
    validation,
    gstr1: g1,
    gstr3b: g3b,
    recon2b: recon,
    booksVsReturn,
    turnover,
    portalJSON,
    schemaCheck,
    dueDates: period.dueDatesFor(periodStr, cfg),
    requiresIFF: period.requiresIFF(periodStr, cfg),
  };
}

/** Map a persisted purchase row into the ITC shape. */
function normalisePurchase(p) {
  const num = (v) => money.toPaise(String(v == null ? 0 : v));
  // The DB columns are purchase_*; these used to read the unprefixed names only,
  // so every CGST/SGST/IGST amount on a purchase was read as zero and every 2B
  // row showed a phantom tax difference. Accept both spellings.
  const head = (a, b) => (p[a] != null && p[a] !== '' ? p[a] : p[b]);
  return {
    key: `${String(p.supplier_gstin || '').toUpperCase()}|${reconcile.normInvoiceNo(p.supplier_invoice_no || p.supplier_invoice_number || p.supplierInvoiceNo || '')}`,
    gstin: String(p.supplier_gstin || '').toUpperCase(),
    invoiceNo: String(p.supplier_invoice_no || p.supplier_invoice_number || p.supplierInvoiceNo || ''),
    date: p.date,
    supplier: String(p.supplier || ''),
    // purchases store tax as a lump sum; split when the row carries heads
    taxablePaise: num(p.purchase_taxable != null ? p.purchase_taxable : p.supplier_bill_total),
    igstPaise: num(head('purchase_igst', 'igst')),
    cgstPaise: num(head('purchase_cgst', 'cgst')),
    sgstPaise: num(head('purchase_sgst', 'sgst')),
    cessPaise: num(head('purchase_cess', 'cess')),
    isImport: !!p.is_import,
    reverseCharge: !!p.reverse_charge,
    itcEligible: p.itc_eligible !== false,
    ineligibleReason: String(p.ineligible_reason || ''),
  };
}

module.exports = {
  ...config,
  ...money,
  ...gstin,
  ...period,
  ...classify,
  ...gstr1,
  ...gstr3b,
  ...validate,
  ...reconcile,
  ...schema,
  mergeConfig: config.mergeConfig,
  buildReturn,
  normalisePurchase,
};