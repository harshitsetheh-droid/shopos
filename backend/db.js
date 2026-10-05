require('dotenv').config();
const { Pool, types } = require('pg');

// Return TIMESTAMP (oid 1114) and TIMESTAMPTZ (oid 1184) as strings
// so JS Date conversion doesn't double-shift timezone
types.setTypeParser(1114, str => str ? str.replace(' ', 'T') : str);
types.setTypeParser(1184, str => str ? str.replace(' ', 'T') : str);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'shopos',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

async function initDB() {
  const client = await pool.connect();
  try {
    // Check if old tables exist (without account_id) and drop them
    const check = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='categories' AND column_name='account_id'
    `);
    if (check.rows.length === 0) {
      // Old schema — drop & recreate
      await client.query(`
        DROP TABLE IF EXISTS advance_orders CASCADE;
        DROP TABLE IF EXISTS udhaar_records CASCADE;
        DROP TABLE IF EXISTS inventory_history CASCADE;
        DROP TABLE IF EXISTS sales CASCADE;
        DROP TABLE IF EXISTS products CASCADE;
      DROP TABLE IF EXISTS categories CASCADE;
      DROP TABLE IF EXISTS app_state CASCADE;
      DROP TABLE IF EXISTS qr_codes CASCADE;
      `);
      console.log('♻️  Recreated tables with account_id isolation');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255) NOT NULL,
        location VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        emoji VARCHAR(50) DEFAULT '📂',
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10,2) NOT NULL DEFAULT 0,
        stock INTEGER DEFAULT 0,
        cat_id INTEGER DEFAULT NULL,
        emoji VARCHAR(50) DEFAULT '📦',
        image TEXT DEFAULT '',
        description TEXT DEFAULT '',
        sku VARCHAR(255) DEFAULT '',
        low INTEGER DEFAULT 10,
        no_of_boxes INTEGER DEFAULT 0,
        no_of_pieces INTEGER DEFAULT 0,
        pieces_per_box INTEGER DEFAULT 1,
        gst DECIMAL(5,2) DEFAULT 0,
        hsn VARCHAR(20) DEFAULT '',
        location VARCHAR(100) DEFAULT '',
        cess DECIMAL(5,2) DEFAULT 0,
        purchase_price DECIMAL(10,2) DEFAULT 0,
        last_purchase_date TIMESTAMP DEFAULT NULL,
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS sales (
        id VARCHAR(50),
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        customer_name VARCHAR(255) DEFAULT '',
        customer_phone VARCHAR(20) DEFAULT '',
        items JSONB DEFAULT '[]',
        sub DECIMAL(10,2) DEFAULT 0,
        tax DECIMAL(10,2) DEFAULT 0,
        total DECIMAL(10,2) DEFAULT 0,
        method VARCHAR(50) DEFAULT 'Cash',
        amt_paid DECIMAL(10,2) DEFAULT 0,
        pending DECIMAL(10,2) DEFAULT 0,
        date TIMESTAMP DEFAULT NOW(),
        tax_applied BOOLEAN DEFAULT false,
        pay_type VARCHAR(50) DEFAULT 'paid',
        change_return DECIMAL(10,2) DEFAULT 0,
        udhaar_included BOOLEAN DEFAULT false,
        extra_udhaar_amount DECIMAL(10,2) DEFAULT 0,
        actual_total DECIMAL(10,2),
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS inventory_history (
        id VARCHAR(50),
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date TIMESTAMP DEFAULT NOW(),
        supplier VARCHAR(255) DEFAULT '',
        transport DECIMAL(10,2) DEFAULT 0,
        notes TEXT DEFAULT '',
        items JSONB DEFAULT '[]',
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS udhaar_records (
        id VARCHAR(50),
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) DEFAULT '',
        reference VARCHAR(255) DEFAULT '',
        bills JSONB DEFAULT '[]',
        total_bill DECIMAL(10,2) DEFAULT 0,
        total_paid DECIMAL(10,2) DEFAULT 0,
        total_pending DECIMAL(10,2) DEFAULT 0,
        credit DECIMAL(10,2) DEFAULT 0,
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS advance_orders (
        id VARCHAR(50),
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        cust_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) DEFAULT '',
        pack_time TIMESTAMP,
        adv_paid DECIMAL(10,2) DEFAULT 0,
        notes TEXT DEFAULT '',
        items JSONB DEFAULT '[]',
        total DECIMAL(10,2) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'scheduled',
        sale_id VARCHAR(50) DEFAULT NULL,
        transport JSONB DEFAULT NULL,
        tax_applied BOOLEAN DEFAULT false,
        transport_cost DECIMAL(10,2) DEFAULT 0,
        addl_paid DECIMAL(10,2) DEFAULT 0,
        bills JSONB DEFAULT '[]',
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key VARCHAR(100),
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        value JSONB NOT NULL,
        PRIMARY KEY (key, account_id)
      );

      CREATE TABLE IF NOT EXISTS qr_codes (
        id SERIAL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        sku TEXT NOT NULL DEFAULT '',
        product_name TEXT DEFAULT '',
        product_id INTEGER DEFAULT NULL,
        qr_data TEXT DEFAULT '',
        barcode_type TEXT DEFAULT 'qr',
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id VARCHAR(50),
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        title TEXT DEFAULT '',
        content TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (id, account_id)
      );

      CREATE TABLE IF NOT EXISTS customer_ledgers (
        id SERIAL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        customer_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) DEFAULT '',
        entries JSONB DEFAULT '[]',
        PRIMARY KEY (id, account_id)
      );
    `);
    // Ensure credit column exists (legacy)
    await client.query(`ALTER TABLE udhaar_records ADD COLUMN IF NOT EXISTS credit DECIMAL(10,2) DEFAULT 0`);
    // Ensure new product columns exist
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn VARCHAR(20) DEFAULT ''`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS location VARCHAR(100) DEFAULT ''`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cess DECIMAL(5,2) DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price DECIMAL(10,2) DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS last_purchase_date TIMESTAMP DEFAULT NULL`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit VARCHAR(20) DEFAULT ''`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_per_price INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price5 DECIMAL(10,2) DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price10 DECIMAL(10,2) DEFAULT 0`);
    // Ensure location column exists on accounts
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS location VARCHAR(255) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS actual_total DECIMAL(10,2)`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE advance_orders ADD COLUMN IF NOT EXISTS location JSONB`);
    await client.query(`ALTER TABLE customer_ledgers ADD COLUMN IF NOT EXISTS location JSONB`);

    // GST split migration
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cgst DECIMAL(5,2) DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sgst DECIMAL(5,2) DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS igst DECIMAL(5,2) DEFAULT 0`);

    // ── GST module migrations (2026-08) ───────────────────────────────────────
    // Everything below is ADDITIVE. No table or column is dropped.

    // Business identity for GSTR-1 / GSTR-3B
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS gstin VARCHAR(15) DEFAULT ''`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255) DEFAULT ''`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trade_name VARCHAR(255) DEFAULT ''`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pan VARCHAR(10) DEFAULT ''`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS state_code VARCHAR(2) DEFAULT ''`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS constitution VARCHAR(30) DEFAULT 'proprietorship'`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS filing_frequency VARCHAR(20) DEFAULT 'monthly'`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS qrmp_type VARCHAR(20) DEFAULT 'monthly-payment'`);

    // Product master: UQC + nil/exempt flags + SAC
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sac VARCHAR(20) DEFAULT ''`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS uqc VARCHAR(10) DEFAULT ''`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_nil BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_exempt BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS exempt_reason TEXT DEFAULT ''`);

    // Sales: document type, invoice numbering, place of supply, credit notes.
    // is_interstate fixes a real bug: `intra` was never persisted, so after any
    // reload historical invoices re-printed with IGST instead of CGST+SGST.
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS doc_type VARCHAR(30) DEFAULT 'tax_invoice'`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_no VARCHAR(64) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_series VARCHAR(30) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cust_gstin VARCHAR(15) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(2) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_interstate BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS supply_type VARCHAR(20) DEFAULT 'domestic'`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS doc_status VARCHAR(20) DEFAULT 'finalised'`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancel_date TIMESTAMP DEFAULT NULL`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancel_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS nil_rated_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS exempt_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS non_gst_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS linked_invoice_no VARCHAR(64) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS linked_invoice_id VARCHAR(50) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS linked_invoice_date TIMESTAMP DEFAULT NULL`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS note_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS export_payment_type VARCHAR(10) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS original_invoice_no VARCHAR(64) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS original_invoice_period VARCHAR(7) DEFAULT ''`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS amendment_reason TEXT DEFAULT ''`);
    // Raw customer location string the POS captured. The place-of-supply state
    // code is derived from it at billing time and stored in place_of_supply,
    // but keeping the string lets a later state-code fix be re-derived without
    // asking the counter staff to retype it.
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_location TEXT DEFAULT ''`);

    // Purchases: supplier GSTIN + ITC heads, needed for GSTR-2B reconciliation
    // The supplier's own invoice number. Without it a purchase row cannot be
    // matched to its 2B line, so reconciliation silently matched nothing.
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS supplier_invoice_no VARCHAR(64) DEFAULT ''`);

    // The stock-entry form has always collected these, but the table never had a
    // column for any of them, so they were silently dropped on every save and the
    // Inventory History reports (including their "Supplier Bill Paid/Due" sorts)
    // ran on incomplete data. Additive only - nothing is dropped.
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS destination TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS parcel_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS supplier_bill DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS supplier_bill_paid DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS supplier_bill_status VARCHAR(20) DEFAULT 'paid'`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS supplier_bill_photo TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS transport_provider TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS transport_cost DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS transport_paid DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS transport_status VARCHAR(20) DEFAULT 'paid'`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS transport_bill_photo TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS transport_cost_expense_id VARCHAR(50) DEFAULT ''`);

    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS supplier_gstin VARCHAR(15) DEFAULT ''`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS supplier_state_code VARCHAR(2) DEFAULT ''`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS purchase_invoice_date TIMESTAMP DEFAULT NULL`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS purchase_taxable DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS purchase_cgst DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS purchase_sgst DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS purchase_igst DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS purchase_cess DECIMAL(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS is_import BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS itc_eligible BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS ineligible_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS expense_id VARCHAR(50) DEFAULT ''`);

    // Return periods: Draft → Validated → Exported → Filed → Locked
    await client.query(`
      CREATE TABLE IF NOT EXISTS gst_periods (
        id SERIAL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        period VARCHAR(7) NOT NULL,
        status VARCHAR(20) DEFAULT 'draft',
        arn VARCHAR(50) DEFAULT '',
        filing_date TIMESTAMP DEFAULT NULL,
        locked_at TIMESTAMP DEFAULT NULL,
        gstr1_exported_at TIMESTAMP DEFAULT NULL,
        gstr3b_exported_at TIMESTAMP DEFAULT NULL,
        manual_input JSONB DEFAULT '{}'::jsonb,
        notes TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (account_id, period)
      )`);

    // Per-period 2B reconciliation decisions (accept / reject / pending + note)
    await client.query(`
      CREATE TABLE IF NOT EXISTS gst_recon_2b (
        id SERIAL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        period VARCHAR(7) NOT NULL,
        match_key VARCHAR(200) NOT NULL,
        bucket VARCHAR(30) DEFAULT 'pending',
        decision VARCHAR(20) DEFAULT 'pending',
        note TEXT DEFAULT '',
        supplier_gstin VARCHAR(15) DEFAULT '',
        invoice_no VARCHAR(64) DEFAULT '',
        invoice_date TIMESTAMP DEFAULT NULL,
        taxable DECIMAL(12,2) DEFAULT 0,
        igst DECIMAL(12,2) DEFAULT 0,
        cgst DECIMAL(12,2) DEFAULT 0,
        sgst DECIMAL(12,2) DEFAULT 0,
        cess DECIMAL(12,2) DEFAULT 0,
        raw JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (account_id, period, match_key)
      )`);

    // Audit log for export / mark-filed / period-lock actions
    await client.query(`
      CREATE TABLE IF NOT EXISTS gst_audit_log (
        id SERIAL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        period VARCHAR(7) DEFAULT '',
        action VARCHAR(40) NOT NULL,
        detail TEXT DEFAULT '',
        actor VARCHAR(255) DEFAULT '',
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    // GST config (JSONB per account) — rates, thresholds, due dates live here
    await client.query(`
      CREATE TABLE IF NOT EXISTS gst_config (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP DEFAULT NOW()
      )`);

    // ── Performance indexes ───────────────────────────────────────────────────
    // /api/save re-writes rows on every change; these keep lookups fast.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_account_date ON sales(account_id, date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_account_inv ON sales(account_id, invoice_no)`);
    // NOTE: an index on to_char(date,'YYYY-MM') is rejected — the function is not
    // IMMUTABLE. The (account_id, date) index above already serves period range
    // queries, so no expression index is needed.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_account_date_doc ON sales(account_id, date, doc_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_account_status ON sales(account_id, doc_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_account_date ON inventory_history(account_id, date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_account_gstin ON inventory_history(account_id, supplier_gstin)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_account_cat ON products(account_id, cat_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gst_periods_account ON gst_periods(account_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gst_audit_account ON gst_audit_log(account_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gst_recon_period ON gst_recon_2b(account_id, period)`);

    // Migrate existing gst data into cgst/sgst (split equally for backward compat)
    await client.query(`
      UPDATE products SET
        cgst = CASE WHEN gst > 0 AND (cgst = 0 OR cgst IS NULL) THEN ROUND(gst/2.0, 2) ELSE cgst END,
        sgst = CASE WHEN gst > 0 AND (sgst = 0 OR sgst IS NULL) THEN ROUND(gst/2.0, 2) ELSE sgst END,
        igst = CASE WHEN gst > 0 AND (igst = 0 OR igst IS NULL) THEN gst ELSE igst END
      WHERE (cgst = 0 OR cgst IS NULL) AND gst > 0
    `);

    // Expenses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id VARCHAR(50),
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL DEFAULT '',
        amount DECIMAL(10,2) DEFAULT 0,
        category VARCHAR(100) DEFAULT '',
        notes TEXT DEFAULT '',
        date TIMESTAMP DEFAULT NOW(),
        photo TEXT DEFAULT '',
        PRIMARY KEY (id, account_id)
      )`);
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT ''`);

    // Migration tracking table (no FK so safe for system-level tracking)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // One-time timezone migration: existing timestamps stored UTC value as local time
    // Need +5:30h (IST offset) to correct; run only once
    const migCheck = await client.query(`SELECT * FROM _migrations WHERE name='tz_fix_530'`);
    if (!migCheck.rows.length) {
      const hasData = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM sales
          UNION SELECT 1 FROM inventory_history
          UNION SELECT 1 FROM advance_orders
          UNION SELECT 1 FROM notes
          UNION SELECT 1 FROM qr_codes
        ) AS has_any
      `);
      if (hasData.rows[0].has_any) {
        console.log('🕐 Running timezone migration (+5:30h)...');
        await client.query(`UPDATE sales SET date = date + INTERVAL '5 hours 30 minutes' WHERE date IS NOT NULL`);
        await client.query(`UPDATE inventory_history SET date = date + INTERVAL '5 hours 30 minutes' WHERE date IS NOT NULL`);
        await client.query(`UPDATE advance_orders SET pack_time = pack_time + INTERVAL '5 hours 30 minutes' WHERE pack_time IS NOT NULL`);
        await client.query(`UPDATE notes SET updated_at = updated_at + INTERVAL '5 hours 30 minutes' WHERE updated_at IS NOT NULL`);
        await client.query(`UPDATE qr_codes SET created_at = created_at + INTERVAL '5 hours 30 minutes' WHERE created_at IS NOT NULL`);
        console.log('✅ Timezone migration complete');
      }
      await client.query(`INSERT INTO _migrations (name) VALUES ('tz_fix_530')`);
    }

    console.log('✅ Database tables initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
