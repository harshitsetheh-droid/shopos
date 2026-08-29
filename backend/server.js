const express = require('express');
require('dotenv').config();
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'shopos_secret_key_change_in_prod';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

// ── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, name, email, password, location } = req.body;
    if (!username || !name || !email || !password || !location) {
      return res.status(400).json({ error: 'All fields including location are required' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO accounts (username, name, email, password, location) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, name, email, location',
      [username.trim(), name.trim(), email.trim().toLowerCase(), hash, (location||'').trim()]
    );
    const token = jwt.sign({ id: result.rows[0].id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: result.rows[0], token });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username or email already exists' });
    console.error('Signup error:', e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { ident, password } = req.body;
    if (!ident || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' });
    }
    const result = await pool.query(
      'SELECT * FROM accounts WHERE username=$1 OR email=$1',
      [ident.trim()]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: { id: user.id, username: user.username, name: user.name, email: user.email, location: user.location||'' }, token });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.get('/api/auth/verify', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT name, username, location FROM accounts WHERE id=$1', [req.user.id]);
    const u = result.rows[0] || {};
    res.json({ valid: true, user: { ...req.user, name: u.name, location: u.location||'' } });
  } catch(e) {
    res.json({ valid: true, user: req.user });
  }
});

// ── DATA ROUTES (all require auth, scoped to account_id) ─────────────────────
app.get('/api/load', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const [catR, prodR, salesR, invR, udR, advR, noteR, ledgerR, appStateR, expR] = await Promise.all([
      pool.query('SELECT * FROM categories WHERE account_id=$1 ORDER BY id', [aid]),
      pool.query('SELECT * FROM products WHERE account_id=$1 ORDER BY id', [aid]),
      pool.query('SELECT * FROM sales WHERE account_id=$1 ORDER BY date', [aid]),
      pool.query('SELECT * FROM inventory_history WHERE account_id=$1 ORDER BY date', [aid]),
      pool.query('SELECT * FROM udhaar_records WHERE account_id=$1 ORDER BY name', [aid]),
      pool.query('SELECT * FROM advance_orders WHERE account_id=$1 ORDER BY pack_time', [aid]),
      pool.query('SELECT * FROM notes WHERE account_id=$1 ORDER BY updated_at DESC', [aid]),
      pool.query('SELECT * FROM customer_ledgers WHERE account_id=$1 ORDER BY customer_name', [aid]),
      pool.query('SELECT * FROM app_state WHERE account_id=$1', [aid]),
      pool.query('SELECT * FROM expenses WHERE account_id=$1 ORDER BY date DESC', [aid]),
    ]);
    let purchasePriceLog = [];
    const ppRow = appStateR.rows.find(r => r.key === 'purchasePriceLog');
    if (ppRow) purchasePriceLog = ppRow.value;
    let supplierTransportLog = [];
    const stRow = appStateR.rows.find(r => r.key === 'supplierTransportLog');
    if (stRow) supplierTransportLog = stRow.value;
    const defRow = appStateR.rows.find(r => r.key === 'defaults');
    const defaults = defRow ? defRow.value : null;
    res.json({
      categories: catR.rows,
      products: prodR.rows,
      sales: salesR.rows,
      inventoryHistory: invR.rows,
      udhaarRecords: udR.rows,
      advanceOrders: advR.rows,
      notes: noteR.rows,
      customerLedgers: ledgerR.rows,
      purchasePriceLog,
      supplierTransportLog,
      expenses: expR.rows,
      defaults,
    });
  } catch (e) {
    console.error('Load error:', e);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

app.post('/api/save', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  const client = await pool.connect();
  try {
    const { categories, products, sales, inventoryHistory, udhaarRecords, advanceOrders, notes, expenses } = req.body;
    if (!Array.isArray(categories) || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Invalid data format' });
    }

    await client.query('BEGIN');

    if (categories) {
      await client.query('DELETE FROM categories WHERE account_id=$1', [aid]);
      for (const c of categories) {
        await client.query(
          'INSERT INTO categories (id, account_id, name, emoji) VALUES ($1,$2,$3,$4) ON CONFLICT (id,account_id) DO UPDATE SET name=EXCLUDED.name, emoji=EXCLUDED.emoji',
          [c.id, aid, String(c.name).slice(0,255), String(c.emoji||'📂').slice(0,50)]
        );
      }
    }
    if (products) {
      await client.query('DELETE FROM products WHERE account_id=$1', [aid]);
      for (const p of products) {
        await client.query(
           `INSERT INTO products (id, account_id, name, price, price5, price10, stock, cat_id, emoji, image, description, sku, low, no_of_boxes, no_of_pieces, pieces_per_box, gst, hsn, location, cess, purchase_price, last_purchase_date, cgst, sgst, igst, unit, weight_per_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
           ON CONFLICT (id,account_id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price, price5=EXCLUDED.price5, price10=EXCLUDED.price10, stock=EXCLUDED.stock, cat_id=EXCLUDED.cat_id, emoji=EXCLUDED.emoji, image=EXCLUDED.image, description=EXCLUDED.description, sku=EXCLUDED.sku, low=EXCLUDED.low, no_of_boxes=EXCLUDED.no_of_boxes, no_of_pieces=EXCLUDED.no_of_pieces, pieces_per_box=EXCLUDED.pieces_per_box, gst=EXCLUDED.gst, hsn=EXCLUDED.hsn, location=EXCLUDED.location, cess=EXCLUDED.cess, purchase_price=EXCLUDED.purchase_price, last_purchase_date=EXCLUDED.last_purchase_date, cgst=EXCLUDED.cgst, sgst=EXCLUDED.sgst, igst=EXCLUDED.igst, unit=EXCLUDED.unit, weight_per_price=EXCLUDED.weight_per_price`,
          [p.id, aid, String(p.name).slice(0,255), Math.max(0,parseFloat(p.price)||0), Math.max(0,parseFloat(p.price5)||0), Math.max(0,parseFloat(p.price10)||0), Math.max(0,parseInt(p.stock)||0), p.catId || null, String(p.emoji||'📦').slice(0,50), String(p.image||''), String(p.description||'').slice(0,500), String(p.sku||'').slice(0,100), Math.max(0,parseInt(p.low)||0), Math.max(0,parseInt(p.noOfBoxes)||0), Math.max(0,parseInt(p.noOfPieces)||0), Math.max(1,parseInt(p.piecesPerBox)||1), Math.min(100,Math.max(0,parseFloat(p.gst)||0)), String(p.hsn||'').slice(0,20), String(p.location||'').slice(0,100), Math.min(100,Math.max(0,parseFloat(p.cess)||0)), Math.max(0,parseFloat(p.purchasePrice)||0), p.lastPurchaseDate || null, Math.min(100,Math.max(0,parseFloat(p.cgst)||0)), Math.min(100,Math.max(0,parseFloat(p.sgst)||0)), Math.min(100,Math.max(0,parseFloat(p.igst)||0)), String(p.unit||'').slice(0,20), Math.max(0,parseInt(p.weightPerPrice)||0)]
        );
      }
    }
    if (sales) {
      await client.query('DELETE FROM sales WHERE account_id=$1', [aid]);
      for (const s of sales) {
        await client.query(
          `INSERT INTO sales (id, account_id, customer_name, customer_phone, items, sub, tax, total, method, amt_paid, pending, date, tax_applied, pay_type, change_return, udhaar_included, extra_udhaar_amount, actual_total, hidden)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (id,account_id) DO UPDATE SET customer_name=EXCLUDED.customer_name, customer_phone=EXCLUDED.customer_phone, items=EXCLUDED.items, sub=EXCLUDED.sub, tax=EXCLUDED.tax, total=EXCLUDED.total, method=EXCLUDED.method, amt_paid=EXCLUDED.amt_paid, pending=EXCLUDED.pending, date=EXCLUDED.date, tax_applied=EXCLUDED.tax_applied, pay_type=EXCLUDED.pay_type, change_return=EXCLUDED.change_return, udhaar_included=EXCLUDED.udhaar_included, extra_udhaar_amount=EXCLUDED.extra_udhaar_amount, actual_total=EXCLUDED.actual_total, hidden=EXCLUDED.hidden`,
          [String(s.id).slice(0,50), aid, String(s.customerName||'').slice(0,255), String(s.customerPhone||'').slice(0,20), JSON.stringify(s.items||[]), parseFloat(s.sub)||0, parseFloat(s.tax)||0, parseFloat(s.total)||0, String(s.method||'Cash').slice(0,50), parseFloat(s.amtPaid)||0, parseFloat(s.pending)||0, s.date||new Date(), !!s.taxApplied, String(s.payType||'paid').slice(0,20), parseFloat(s.change)||0, !!s.udhaarIncluded, parseFloat(s.extraUdhaarAmount)||0, s.actualTotal!=null?parseFloat(s.actualTotal):null, !!s.hidden]
        );
      }
    }
    if (inventoryHistory) {
      await client.query('DELETE FROM inventory_history WHERE account_id=$1', [aid]);
      for (const h of inventoryHistory) {
        await client.query(
          'INSERT INTO inventory_history (id, account_id, date, supplier, transport, notes, items) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id,account_id) DO UPDATE SET date=EXCLUDED.date, supplier=EXCLUDED.supplier, transport=EXCLUDED.transport, notes=EXCLUDED.notes, items=EXCLUDED.items',
          [String(h.id).slice(0,50), aid, h.date||new Date(), String(h.supplier||'').slice(0,255), Math.max(0,parseFloat(h.transport)||0), String(h.notes||'').slice(0,1000), JSON.stringify(h.items||[])]
        );
      }
    }
    if (udhaarRecords) {
      await client.query('DELETE FROM udhaar_records WHERE account_id=$1', [aid]);
      for (const r of udhaarRecords) {
        await client.query(
          'INSERT INTO udhaar_records (id, account_id, name, phone, reference, bills, total_bill, total_paid, total_pending, credit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id,account_id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, reference=EXCLUDED.reference, bills=EXCLUDED.bills, total_bill=EXCLUDED.total_bill, total_paid=EXCLUDED.total_paid, total_pending=EXCLUDED.total_pending, credit=EXCLUDED.credit',
          [String(r.id).slice(0,50), aid, String(r.name).slice(0,255), String(r.phone||'').slice(0,20), String(r.reference||'').slice(0,255), JSON.stringify(r.bills||[]), parseFloat(r.totalBill)||0, parseFloat(r.totalPaid)||0, parseFloat(r.totalPending)||0, parseFloat(r.credit||0)||0]
        );
      }
    }
    if (advanceOrders) {
      await client.query('DELETE FROM advance_orders WHERE account_id=$1', [aid]);
      for (const o of advanceOrders) {
        await client.query(
          `INSERT INTO advance_orders (id, account_id, cust_name, phone, pack_time, adv_paid, notes, items, total, status, sale_id, transport, tax_applied, transport_cost, addl_paid, bills)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id,account_id) DO UPDATE SET cust_name=EXCLUDED.cust_name, phone=EXCLUDED.phone, pack_time=EXCLUDED.pack_time, adv_paid=EXCLUDED.adv_paid, notes=EXCLUDED.notes, items=EXCLUDED.items, total=EXCLUDED.total, status=EXCLUDED.status, sale_id=EXCLUDED.sale_id, transport=EXCLUDED.transport, tax_applied=EXCLUDED.tax_applied, transport_cost=EXCLUDED.transport_cost, addl_paid=EXCLUDED.addl_paid, bills=EXCLUDED.bills`,
          [String(o.id).slice(0,50), aid, String(o.custName).slice(0,255), String(o.phone||'').slice(0,20), o.packTime||null, Math.max(0,parseFloat(o.advPaid)||0), String(o.notes||'').slice(0,1000), JSON.stringify(o.items||[]), parseFloat(o.total)||0, String(o.status||'scheduled').slice(0,50), o.saleId||null, o.transport ? JSON.stringify(o.transport) : null, !!o.taxApplied, Math.max(0,parseFloat(o.transportCost)||0), Math.max(0,parseFloat(o.addlPaid)||0), JSON.stringify(o.bills||[])]
        );
      }
    }
    if (notes) {
      await client.query('DELETE FROM notes WHERE account_id=$1', [aid]);
      for (const n of notes) {
        await client.query(
          'INSERT INTO notes (id, account_id, title, content, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id,account_id) DO UPDATE SET title=EXCLUDED.title, content=EXCLUDED.content, updated_at=EXCLUDED.updated_at',
          [String(n.id).slice(0,50), aid, String(n.title||'').slice(0,255), String(n.content||''), n.updatedAt||new Date()]
        );
      }
    }
    if (req.body.customerLedgers) {
      await client.query('DELETE FROM customer_ledgers WHERE account_id=$1', [aid]);
      for (const l of req.body.customerLedgers) {
        await client.query(
          'INSERT INTO customer_ledgers (id, account_id, customer_name, phone, entries) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id,account_id) DO UPDATE SET customer_name=EXCLUDED.customer_name, phone=EXCLUDED.phone, entries=EXCLUDED.entries',
          [l.id, aid, String(l.customerName||l.customer_name).slice(0,255), String(l.phone||'').slice(0,20), JSON.stringify(l.entries||[])]
        );
      }
    }

    if (expenses) {
      await client.query('DELETE FROM expenses WHERE account_id=$1', [aid]);
      for (const e of expenses) {
        await client.query(
          'INSERT INTO expenses (id, account_id, name, amount, category, notes, date, photo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id,account_id) DO UPDATE SET name=EXCLUDED.name, amount=EXCLUDED.amount, category=EXCLUDED.category, notes=EXCLUDED.notes, date=EXCLUDED.date, photo=EXCLUDED.photo',
          [String(e.id).slice(0,50), aid, String(e.name||'').slice(0,255), parseFloat(e.amount)||0, String(e.category||'').slice(0,100), String(e.notes||''), e.date||new Date(), String(e.photo||'').slice(0,5000000)]
        );
      }
    }

    const nextIds = { nextProdId: 1, nextCatId: 1, nextSaleId: 1, nextInvId: 1, nextAdvId: 1, nextNoteId: 1, nextLedgerId: 1, nextExpId: 1 };
    if (products && products.length) nextIds.nextProdId = Math.max(...products.map(p => p.id)) + 1;
    if (categories && categories.length) nextIds.nextCatId = Math.max(...categories.map(c => c.id)) + 1;
    if (sales && sales.length) {
      const nums = sales.map(s => parseInt(s.id.replace('TXN-', '')) || 0);
      nextIds.nextSaleId = Math.max(...nums, 0) + 1;
    }
    if (inventoryHistory && inventoryHistory.length) {
      const nums = inventoryHistory.map(h => parseInt(h.id.replace('INV-', '')) || 0);
      nextIds.nextInvId = Math.max(...nums, 0) + 1;
    }
    if (advanceOrders && advanceOrders.length) {
      const nums = advanceOrders.map(o => parseInt(o.id.replace('ADV-', '')) || 0);
      nextIds.nextAdvId = Math.max(...nums, 0) + 1;
    }
    if (notes && notes.length) {
      const nums = notes.map(n => parseInt(n.id.replace('NOTE-', '')) || 0);
      nextIds.nextNoteId = Math.max(...nums, 0) + 1;
    }
    if (req.body.customerLedgers && req.body.customerLedgers.length) {
      nextIds.nextLedgerId = Math.max(...req.body.customerLedgers.map(l => parseInt(l.id) || 0), 0) + 1;
    }
    if (expenses && expenses.length) {
      nextIds.nextExpId = Math.max(...expenses.map(e => parseInt(e.id.replace('EXP-', '')) || 0), 0) + 1;
    }
    await client.query(
      'INSERT INTO app_state (key, account_id, value) VALUES ($1,$2,$3) ON CONFLICT (key,account_id) DO UPDATE SET value=EXCLUDED.value',
      ['nextIds', aid, JSON.stringify(nextIds)]
    );
    if (req.body.purchasePriceLog) {
      await client.query(
        'INSERT INTO app_state (key, account_id, value) VALUES ($1,$2,$3) ON CONFLICT (key,account_id) DO UPDATE SET value=EXCLUDED.value',
        ['purchasePriceLog', aid, JSON.stringify(req.body.purchasePriceLog)]
      );
    }
    if (req.body.supplierTransportLog) {
      await client.query(
        'INSERT INTO app_state (key, account_id, value) VALUES ($1,$2,$3) ON CONFLICT (key,account_id) DO UPDATE SET value=EXCLUDED.value',
        ['supplierTransportLog', aid, JSON.stringify(req.body.supplierTransportLog)]
      );
    }
    if (req.body.defaults) {
      await client.query(
        'INSERT INTO app_state (key, account_id, value) VALUES ($1,$2,$3) ON CONFLICT (key,account_id) DO UPDATE SET value=EXCLUDED.value',
        ['defaults', aid, JSON.stringify(req.body.defaults)]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Save error:', e);
    res.status(500).json({ error: 'Failed to save data' });
  } finally {
    client.release();
  }
});

app.get('/api/state', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const result = await pool.query('SELECT value FROM app_state WHERE key=$1 AND account_id=$2', ['nextIds', aid]);
    if (result.rows.length) {
      res.json({ nextIds: result.rows[0].value });
    } else {
      res.json({ nextIds: { nextProdId: 1, nextCatId: 1, nextSaleId: 1, nextInvId: 1, nextAdvId: 1, nextNoteId: 1, nextLedgerId: 1, nextExpId: 1 } });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to load state' });
  }
});

// ── DELETE ALL DATA ───────────────────────────────────────────────────────────
app.post('/api/delete-all', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const user = await pool.query('SELECT password FROM accounts WHERE id=$1', [aid]);
    if (!user.rows.length) return res.status(400).json({ error: 'User not found' });
    const match = await bcrypt.compare(password, user.rows[0].password);
    if (!match) return res.status(400).json({ error: 'Wrong password' });
    await pool.query('DELETE FROM categories WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM products WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM sales WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM inventory_history WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM udhaar_records WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM advance_orders WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM notes WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM customer_ledgers WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM app_state WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM qr_codes WHERE account_id=$1', [aid]);
    await pool.query('DELETE FROM expenses WHERE account_id=$1', [aid]);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete all error:', e);
    res.status(500).json({ error: 'Failed to delete data' });
  }
});

// ── QR CODES API ───────────────────────────────────────────────────────────────
app.get('/api/qr/list', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const result = await pool.query('SELECT * FROM qr_codes WHERE account_id=$1 ORDER BY created_at DESC', [aid]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load QR codes' });
  }
});

app.post('/api/qr/save', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const { sku, product_name, product_id, qr_data, barcode_type } = req.body;
    const result = await pool.query(
      `INSERT INTO qr_codes (account_id, sku, product_name, product_id, qr_data, barcode_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [aid, String(sku||'').slice(0,255), String(product_name||'').slice(0,255), product_id||null, String(qr_data||'').slice(0,500), String(barcode_type||'qr').slice(0,20)]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save QR code' });
  }
});

app.delete('/api/qr/delete/:id', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    await pool.query('DELETE FROM qr_codes WHERE id=$1 AND account_id=$2', [req.params.id, aid]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete QR code' });
  }
});

app.delete('/api/qr/delete-all', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    await pool.query('DELETE FROM qr_codes WHERE account_id=$1', [aid]);
    res.json({ success: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete QR codes' });
  }
});

// ── START ──────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`🚀 ShopOS API server running on http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
}

start();
