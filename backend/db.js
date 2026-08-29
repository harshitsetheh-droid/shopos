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
  password: process.env.DB_PASSWORD || 'Harshit@12b',
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

    // GST split migration
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cgst DECIMAL(5,2) DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sgst DECIMAL(5,2) DEFAULT 0`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS igst DECIMAL(5,2) DEFAULT 0`);

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
