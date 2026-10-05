'use strict';
// One-off verification: apply migrations and confirm the GST schema landed.
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'backend', 'db'));

(async () => {
  await db.initDB();
  const { pool } = db;
  const q = (sql) => pool.query(sql);

  const salesCols = await q(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='sales'
      AND column_name IN ('doc_type','invoice_no','invoice_series','cust_gstin','place_of_supply',
                          'is_interstate','supply_type','doc_status','cancel_date','cancel_reason',
                          'reverse_charge','nil_rated_reason','exempt_reason','non_gst_reason',
                          'linked_invoice_no','linked_invoice_id','linked_invoice_date','note_reason',
                          'export_payment_type','original_invoice_no','original_invoice_period',
                          'amendment_reason','customer_location','exclude_financials')
    ORDER BY column_name`);

  const invCols = await q(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='inventory_history'
      AND column_name IN ('supplier_invoice_no','supplier_gstin','supplier_state_code','purchase_invoice_date',
                          'purchase_taxable','purchase_cgst','purchase_sgst','purchase_igst','purchase_cess',
                          'itc_eligible','ineligible_reason','is_import','reverse_charge','expense_id',
                          'destination','parcel_count','supplier_bill','supplier_bill_paid','supplier_bill_status',
                          'supplier_bill_photo','transport_provider','transport_cost','transport_paid',
                          'transport_status','transport_bill_photo','transport_cost_expense_id')
    ORDER BY column_name`);

  const prodCols = await q(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='products' AND column_name IN ('sac','uqc','is_nil','is_exempt','exempt_reason')
    ORDER BY column_name`);

  const acctCols = await q(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='accounts' AND column_name IN
      ('gstin','legal_name','trade_name','pan','state_code','constitution','filing_frequency','qrmp_type')
    ORDER BY column_name`);

  const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'gst_%' ORDER BY table_name`);
  const indexes = await q(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%' AND (tablename='sales' OR tablename='inventory_history' OR tablename LIKE 'gst_%') ORDER BY indexname`);

  console.log('sales GST columns        :', salesCols.rows.map((r) => r.column_name).join(', ') || '(none)');
  console.log('inventory_history columns:', invCols.rows.map((r) => r.column_name).join(', ') || '(none)');
  console.log('products columns         :', prodCols.rows.map((r) => r.column_name).join(', ') || '(none)');
  console.log('accounts columns         :', acctCols.rows.map((r) => r.column_name).join(', ') || '(none)');
  console.log('gst tables               :', tables.rows.map((r) => r.table_name).join(', ') || '(none)');
  console.log('indexes                  :\n  ' + (indexes.rows.map((r) => r.indexname).join('\n  ') || '(none)'));

  // Printing is not a check. Compare each query's result against the full list
  // it asked for, so a migration that silently fails to apply is caught here
  // rather than in production.
  const EXPECT = {
    'sales GST columns': ['doc_type','invoice_no','invoice_series','cust_gstin','place_of_supply',
      'is_interstate','supply_type','doc_status','cancel_date','cancel_reason','reverse_charge',
      'nil_rated_reason','exempt_reason','non_gst_reason','linked_invoice_no','linked_invoice_id',
      'linked_invoice_date','note_reason','export_payment_type','original_invoice_no',
      'original_invoice_period','amendment_reason','customer_location','exclude_financials'],
    'inventory_history columns': ['supplier_invoice_no','supplier_gstin','supplier_state_code','purchase_invoice_date',
      'purchase_taxable','purchase_cgst','purchase_sgst','purchase_igst','purchase_cess',
      'itc_eligible','ineligible_reason','is_import','reverse_charge','expense_id',
      'destination','parcel_count','supplier_bill','supplier_bill_paid','supplier_bill_status',
      'supplier_bill_photo','transport_provider','transport_cost','transport_paid',
      'transport_status','transport_bill_photo','transport_cost_expense_id'],
    'products columns': ['sac','uqc','is_nil','is_exempt','exempt_reason'],
    'accounts columns': ['gstin','legal_name','trade_name','pan','state_code','constitution',
      'filing_frequency','qrmp_type'],
    'gst tables': ['gst_audit_log','gst_config','gst_periods','gst_recon_2b'],
  };
  const actual = {
    'sales GST columns': salesCols.rows.map((r) => r.column_name),
    'inventory_history columns': invCols.rows.map((r) => r.column_name),
    'products columns': prodCols.rows.map((r) => r.column_name),
    'accounts columns': acctCols.rows.map((r) => r.column_name),
    'gst tables': tables.rows.map((r) => r.table_name),
  };

  let bad = 0;
  for (const [label, want] of Object.entries(EXPECT)) {
    const have = new Set(actual[label]);
    const missing = want.filter((c) => !have.has(c));
    if (missing.length) { bad++; console.log(`✗ ${label}: MISSING ${missing.join(', ')}`); }
    else console.log(`✓ ${label}: all ${want.length} present`);
  }
  console.log(bad ? `\nFAILED: ${bad} group(s) incomplete` : '\nOK: schema complete');

  await pool.end();
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});