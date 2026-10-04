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
      `SELECT id, username, name, email, location, password, gstin, legal_name, trade_name, pan,
              state_code, constitution, filing_frequency, qrmp_type
       FROM accounts WHERE username=$1 OR email=$1`,
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
    res.json({ user: {
      id: user.id, username: user.username, name: user.name, email: user.email,
      location: user.location || '',
      gstin: user.gstin || '', legalName: user.legal_name || '', tradeName: user.trade_name || '',
      pan: user.pan || '', stateCode: user.state_code || '',
      constitution: user.constitution || 'proprietorship',
      filingFrequency: user.filing_frequency || 'monthly',
      qrmpType: user.qrmp_type || 'monthly-payment',
    }, token });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.get('/api/auth/verify', authMiddleware, async (req, res) => {
  try {
    // Must return the same business identity as /auth/login — the GST setup form
    // reads this on session restore, and it was silently coming back empty.
    const result = await pool.query(
      `SELECT name, username, email, location, gstin, legal_name, trade_name, pan,
              state_code, constitution, filing_frequency, qrmp_type
       FROM accounts WHERE id=$1`, [req.user.id]);
    const u = result.rows[0] || {};
    res.json({ valid: true, user: {
      ...req.user,
      name: u.name, username: u.username, location: u.location || '',
      email: u.email || '',
      gstin: u.gstin || '', legalName: u.legal_name || '', tradeName: u.trade_name || '',
      pan: u.pan || '', stateCode: u.state_code || '',
      constitution: u.constitution || 'proprietorship',
      filingFrequency: u.filing_frequency || 'monthly',
      qrmpType: u.qrmp_type || 'monthly-payment',
    } });
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
    const delta = req.body && req.body.delta;

    // Fast path: the client sends only what changed. Falls through to the full
    // path below when `delta` is absent (older clients, imports, first save).
    if (delta && delta.mode === 'noop') return res.json({ success: true, mode: 'noop' });

    if (delta && delta.mode === 'delta') {
      if (!delta.changed || typeof delta.changed !== 'object') {
        return res.status(400).json({ error: 'delta.changed must be an object' });
      }
      await client.query('BEGIN');
      try {
        await applyDelta(client, aid, delta.changed || {});
        await persistAppState(client, aid, req.body);
        await client.query('COMMIT');
        return res.json({ success: true, mode: 'delta' });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Delta save error:', e.message);
        if (process.env.GST_DEBUG) console.error(e);
        throw e;
      }
    }

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
          `INSERT INTO sales (id, account_id, customer_name, customer_phone, items, sub, tax, total, method, amt_paid, pending, date, tax_applied, pay_type, change_return, udhaar_included, extra_udhaar_amount, actual_total, hidden,
              doc_type, invoice_no, invoice_series, cust_gstin, place_of_supply, is_interstate, supply_type, doc_status,
              cancel_date, cancel_reason, reverse_charge, nil_rated_reason, exempt_reason, non_gst_reason,
              linked_invoice_no, linked_invoice_id, linked_invoice_date, note_reason, export_payment_type,
              original_invoice_no, original_invoice_period, amendment_reason, customer_location)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
              $20,$21,$22,$23,$24,$25,$26,$27,
              $28,$29,$30,$31,$32,$33,
              $34,$35,$36,$37,$38,
              $39,$40,$41,$42)
           ON CONFLICT (id,account_id) DO UPDATE SET
              customer_name=EXCLUDED.customer_name, customer_phone=EXCLUDED.customer_phone, items=EXCLUDED.items,
              sub=EXCLUDED.sub, tax=EXCLUDED.tax, total=EXCLUDED.total, method=EXCLUDED.method,
              amt_paid=EXCLUDED.amt_paid, pending=EXCLUDED.pending, date=EXCLUDED.date,
              tax_applied=EXCLUDED.tax_applied, pay_type=EXCLUDED.pay_type, change_return=EXCLUDED.change_return,
              udhaar_included=EXCLUDED.udhaar_included, extra_udhaar_amount=EXCLUDED.extra_udhaar_amount,
              actual_total=EXCLUDED.actual_total, hidden=EXCLUDED.hidden,
              doc_type=EXCLUDED.doc_type, invoice_no=EXCLUDED.invoice_no, invoice_series=EXCLUDED.invoice_series,
              cust_gstin=EXCLUDED.cust_gstin, place_of_supply=EXCLUDED.place_of_supply,
              is_interstate=EXCLUDED.is_interstate, supply_type=EXCLUDED.supply_type,
              doc_status=EXCLUDED.doc_status, cancel_date=EXCLUDED.cancel_date, cancel_reason=EXCLUDED.cancel_reason,
              reverse_charge=EXCLUDED.reverse_charge, nil_rated_reason=EXCLUDED.nil_rated_reason,
              exempt_reason=EXCLUDED.exempt_reason, non_gst_reason=EXCLUDED.non_gst_reason,
              linked_invoice_no=EXCLUDED.linked_invoice_no, linked_invoice_id=EXCLUDED.linked_invoice_id,
              linked_invoice_date=EXCLUDED.linked_invoice_date, note_reason=EXCLUDED.note_reason,
              export_payment_type=EXCLUDED.export_payment_type,
              original_invoice_no=EXCLUDED.original_invoice_no,
              original_invoice_period=EXCLUDED.original_invoice_period,
              amendment_reason=EXCLUDED.amendment_reason,
              customer_location=EXCLUDED.customer_location`,
          [String(s.id).slice(0,50), aid, String(s.customerName||'').slice(0,255), String(s.customerPhone||'').slice(0,20), JSON.stringify(s.items||[]), parseFloat(s.sub)||0, parseFloat(s.tax)||0, parseFloat(s.total)||0, String(s.method||'Cash').slice(0,50), parseFloat(s.amtPaid)||0, parseFloat(s.pending)||0, s.date||new Date(), !!s.taxApplied, String(s.payType||'paid').slice(0,20), parseFloat(s.change)||0, !!s.udhaarIncluded, parseFloat(s.extraUdhaarAmount)||0, s.actualTotal!=null?parseFloat(s.actualTotal):null, !!s.hidden,
            String(s.docType||'tax_invoice').slice(0,30), String(s.invoiceNo||'').slice(0,64), String(s.invoiceSeries||'').slice(0,30),
            String(s.custGstin||'').slice(0,15), String(s.placeOfSupply||'').slice(0,2),
            s.isInterstate!=null?!!s.isInterstate:(s.intra!=null?!s.intra:false),
            String(s.supplyType||'domestic').slice(0,20), String(s.docStatus||s.status||'finalised').slice(0,20),
            s.cancelDate||null, String(s.cancelReason||''), !!s.reverseCharge,
            String(s.nilRatedReason||''), String(s.exemptReason||''), String(s.nonGstReason||''),
            String(s.linkedInvoiceNo||'').slice(0,64), String(s.linkedInvoiceId||'').slice(0,50), s.linkedInvoiceDate||null,
            String(s.noteReason||''), String(s.exportPaymentType||'').slice(0,10),
            String(s.originalInvoiceNo||'').slice(0,64), String(s.originalInvoicePeriod||'').slice(0,7),
            String(s.amendmentReason||''),
            String(s.customerLocation||'').slice(0,500)]
        );
      }
    }
    if (inventoryHistory) {
      await client.query('DELETE FROM inventory_history WHERE account_id=$1', [aid]);
      for (const h of inventoryHistory) {
        await client.query(
          `INSERT INTO inventory_history (id, account_id, date, supplier, transport, notes, items,
              supplier_gstin, supplier_state_code, purchase_invoice_date, purchase_taxable,
              purchase_cgst, purchase_sgst, purchase_igst, purchase_cess,
              is_import, reverse_charge, itc_eligible, ineligible_reason, expense_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           ON CONFLICT (id,account_id) DO UPDATE SET
              date=EXCLUDED.date, supplier=EXCLUDED.supplier, transport=EXCLUDED.transport,
              notes=EXCLUDED.notes, items=EXCLUDED.items,
              supplier_gstin=EXCLUDED.supplier_gstin, supplier_state_code=EXCLUDED.supplier_state_code,
              purchase_invoice_date=EXCLUDED.purchase_invoice_date, purchase_taxable=EXCLUDED.purchase_taxable,
              purchase_cgst=EXCLUDED.purchase_cgst, purchase_sgst=EXCLUDED.purchase_sgst,
              purchase_igst=EXCLUDED.purchase_igst, purchase_cess=EXCLUDED.purchase_cess,
              is_import=EXCLUDED.is_import, reverse_charge=EXCLUDED.reverse_charge,
              itc_eligible=EXCLUDED.itc_eligible, ineligible_reason=EXCLUDED.ineligible_reason,
              expense_id=EXCLUDED.expense_id`,
          [String(h.id).slice(0,50), aid, h.date||new Date(), String(h.supplier||'').slice(0,255),
            Math.max(0,parseFloat(h.transport)||0), String(h.notes||'').slice(0,1000), JSON.stringify(h.items||[]),
            String(h.supplierGstin||'').slice(0,15), String(h.supplierStateCode||'').slice(0,2),
            h.purchaseInvoiceDate||null, Math.max(0,parseFloat(h.purchaseTaxable)||0),
            Math.max(0,parseFloat(h.purchaseCgst)||0), Math.max(0,parseFloat(h.purchaseSgst)||0),
            Math.max(0,parseFloat(h.purchaseIgst)||0), Math.max(0,parseFloat(h.purchaseCess)||0),
            !!h.isImport, !!h.reverseCharge, h.itcEligible!==false, String(h.ineligibleReason||''),
            String(h.expenseId||'').slice(0,50)]
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
          `INSERT INTO advance_orders (id, account_id, cust_name, phone, pack_time, adv_paid, notes, items, total, status, sale_id, transport, tax_applied, transport_cost, addl_paid, bills, location)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (id,account_id) DO UPDATE SET cust_name=EXCLUDED.cust_name, phone=EXCLUDED.phone, pack_time=EXCLUDED.pack_time, adv_paid=EXCLUDED.adv_paid, notes=EXCLUDED.notes, items=EXCLUDED.items, total=EXCLUDED.total, status=EXCLUDED.status, sale_id=EXCLUDED.sale_id, transport=EXCLUDED.transport, tax_applied=EXCLUDED.tax_applied, transport_cost=EXCLUDED.transport_cost, addl_paid=EXCLUDED.addl_paid, bills=EXCLUDED.bills, location=EXCLUDED.location`,
          [String(o.id).slice(0,50), aid, String(o.custName).slice(0,255), String(o.phone||'').slice(0,20), o.packTime||null, Math.max(0,parseFloat(o.advPaid)||0), String(o.notes||'').slice(0,1000), JSON.stringify(o.items||[]), parseFloat(o.total)||0, String(o.status||'scheduled').slice(0,50), o.saleId||null, o.transport ? JSON.stringify(o.transport) : null, !!o.taxApplied, Math.max(0,parseFloat(o.transportCost)||0), Math.max(0,parseFloat(o.addlPaid)||0), JSON.stringify(o.bills||[]), o.location ? JSON.stringify(o.location) : null]
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
          'INSERT INTO customer_ledgers (id, account_id, customer_name, phone, entries, location) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id,account_id) DO UPDATE SET customer_name=EXCLUDED.customer_name, phone=EXCLUDED.phone, entries=EXCLUDED.entries, location=EXCLUDED.location',
          [l.id, aid, String(l.customerName||l.customer_name).slice(0,255), String(l.phone||'').slice(0,20), JSON.stringify(l.entries||[]), l.location ? JSON.stringify(l.location) : null]
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

// ── DELTA PERSISTENCE (perf) ───────────────────────────────────────────────────
// The full /api/save path deletes and re-inserts every row. The delta path
// upserts only the records the client says changed, which keeps saving O(changed)
// instead of O(total) as the dataset grows.

const DELTA_TABLES = {
  categories:      { table: 'categories',      cols: ['id','name','emoji'],                    push: 'categories' },
  products:        { table: 'products',        cols: ['id','name','price','price5','price10','stock','cat_id','emoji','image','description','sku','low','no_of_boxes','no_of_pieces','pieces_per_box','gst','hsn','location','cess','purchase_price','last_purchase_date','cgst','sgst','igst','unit','weight_per_price'], push: 'products' },
  sales:           { table: 'sales',           cols: ['id','customer_name','customer_phone','items','sub','tax','total','method','amt_paid','pending','date','tax_applied','pay_type','change_return','udhaar_included','extra_udhaar_amount','actual_total','hidden','doc_type','invoice_no','invoice_series','cust_gstin','place_of_supply','is_interstate','supply_type','doc_status','cancel_date','cancel_reason','reverse_charge','nil_rated_reason','exempt_reason','non_gst_reason','linked_invoice_no','linked_invoice_id','linked_invoice_date','note_reason','export_payment_type','original_invoice_no','original_invoice_period','amendment_reason','customer_location'],
                     // The DB DEFAULTs never fire because these columns are always named in the
                     // INSERT, so the enum defaults have to be applied here or every row lands as NULL.
                     // NULL doc_status would silently defeat the "doc_status <> 'cancelled'" filter
                     // used by period locking, and the report engine treats NULL as unknown.
                     defaults: {
                       doc_type: 'tax_invoice', supply_type: 'domestic', doc_status: 'finalised',
                       // The schema declares these TEXT DEFAULT ''; mirror that so the delta path
                       // produces the same rows the full-payload path does.
                       invoice_no: '', invoice_series: '', cust_gstin: '', place_of_supply: '',
                       cancel_reason: '', nil_rated_reason: '', exempt_reason: '', non_gst_reason: '',
                       linked_invoice_no: '', linked_invoice_id: '', note_reason: '',
                       export_payment_type: '', original_invoice_no: '', original_invoice_period: '',
                       amendment_reason: '', customer_location: '',
                     }, push: 'sales' },
  inventoryHistory:{ table: 'inventory_history', cols: ['id','date','supplier','transport','notes','items','supplier_gstin','supplier_state_code','purchase_invoice_date','purchase_taxable','purchase_cgst','purchase_sgst','purchase_igst','purchase_cess','is_import','reverse_charge','itc_eligible','ineligible_reason','expense_id'], push: 'inventoryHistory' },
  udhaarRecords:   { table: 'udhaar_records',  cols: ['id','name','phone','reference','bills','total_bill','total_paid','total_pending','credit'], push: 'udhaarRecords' },
  advanceOrders:   { table: 'advance_orders',  cols: ['id','cust_name','phone','pack_time','adv_paid','notes','items','total','status','sale_id','transport','tax_applied','transport_cost','addl_paid','bills','location'], push: 'advanceOrders' },
  notes:           { table: 'notes',           cols: ['id','title','content','updated_at'], push: 'notes' },
  customerLedgers: { table: 'customer_ledgers',cols: ['id','customer_name','phone','entries','location'], push: 'customerLedgers' },
  expenses:        { table: 'expenses',        cols: ['id','name','amount','category','notes','date','photo'], push: 'expenses' },
};

/** Map a client record onto the snake_case column list for a table. */
function toRow(rec, cols) {
  const snake = (s) => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const out = {};
  for (const col of cols) {
    // accept either the DB column name (doc_type) or its camelCase form (docType)
    if (rec[col] !== undefined) out[col] = rec[col];
    else if (rec[snake(col)] !== undefined) out[col] = rec[snake(col)];
    else if (rec[camel(col)] !== undefined) out[col] = rec[camel(col)];
    else out[col] = undefined;
  }
  return out;
}

async function applyDelta(client, aid, changed) {
  for (const [name, spec] of Object.entries(DELTA_TABLES)) {
    const part = changed[name];
    if (!part) continue;

    // deletes
    for (const id of (part.deletes || [])) {
      await client.query(`DELETE FROM ${spec.table} WHERE id=$1 AND account_id=$2`, [id, aid]);
    }

    // upserts
    for (const rec of (part.upserts || [])) {
      if (!rec || rec.id == null) continue;
      const row = toRow(rec, spec.cols);
      for (const [c, d] of Object.entries(spec.defaults || {})) {
        if (row[c] === undefined) row[c] = d;
      }
      // Legacy client shape: the POS used to store `intra` (true = same state) and
      // never wrote is_interstate. Without this the column would go NULL and the
      // sale would be reported as inter-state after a reload.
      if (name === 'sales' && row.is_interstate === undefined) {
        row.is_interstate = rec.intra != null ? !rec.intra : false;
      }
      const cols = spec.cols.slice();
      // JSON columns must be serialised; booleans pass through; undefined → NULL
      const jsonCols = new Set(['items', 'bills', 'entries', 'transport', 'location', 'photo', 'raw']);
      for (const c of cols) {
        const v = row[c];
        if (v === undefined) { row[c] = null; continue; }
        if (jsonCols.has(c) && typeof v === 'object' && v !== null) row[c] = JSON.stringify(v);
      }
      const nonId = cols.filter((c) => c !== 'id');
      const updates = nonId.map((c) => `${c}=EXCLUDED.${c}`).join(', ');
      // $1 = id, $2 = account_id, then one placeholder per remaining column
      const placeholders = nonId.map((_, i) => '$' + (i + 3)).join(',');
      await client.query(
        `INSERT INTO ${spec.table} (id, account_id, ${nonId.join(',')})
         VALUES ($1, $2, ${placeholders})
         ON CONFLICT (id, account_id) DO UPDATE SET ${updates}`,
        [rec.id, aid, ...nonId.map((c) => row[c])],
      );
    }
  }
}

async function persistAppState(client, aid, body) {
  const nextIds = { nextProdId:1, nextCatId:1, nextSaleId:1, nextInvId:1, nextAdvId:1, nextNoteId:1, nextLedgerId:1, nextExpId:1 };
  const maxOf = (arr, re, key) => (arr && arr.length)
    ? Math.max(...arr.map((x) => parseInt(String(x[key] || '').replace(re, '')) || 0), 0) + 1
    : 1;
  if (body.products) nextIds.nextProdId = maxOf(body.products, '', 'id');
  if (body.categories) nextIds.nextCatId = maxOf(body.categories, '', 'id');
  if (body.sales) nextIds.nextSaleId = maxOf(body.sales, /^TXN-/, 'id');
  if (body.inventoryHistory) nextIds.nextInvId = maxOf(body.inventoryHistory, /^INV-/, 'id');
  if (body.advanceOrders) nextIds.nextAdvId = maxOf(body.advanceOrders, /^ADV-/, 'id');
  if (body.notes) nextIds.nextNoteId = maxOf(body.notes, /^NOTE-/, 'id');
  if (body.customerLedgers) nextIds.nextLedgerId = maxOf(body.customerLedgers, '', 'id');
  if (body.expenses) nextIds.nextExpId = maxOf(body.expenses, /^EXP-/, 'id');

  await client.query(
    'INSERT INTO app_state (key, account_id, value) VALUES ($1,$2,$3) ON CONFLICT (key,account_id) DO UPDATE SET value=EXCLUDED.value',
    ['nextIds', aid, JSON.stringify(nextIds)]
  );
  for (const k of ['purchasePriceLog', 'supplierTransportLog', 'defaults']){
    if (body[k]) {
      await client.query(
        'INSERT INTO app_state (key, account_id, value) VALUES ($1,$2,$3) ON CONFLICT (key,account_id) DO UPDATE SET value=EXCLUDED.value',
        [k, aid, JSON.stringify(body[k])]
      );
    }
  }
}

// ── GST MODULE API ─────────────────────────────────────────────────────────────
// The engine is pure/testable (see gst/). These routes only move data in/out
// and enforce the period workflow (Draft → Validated → Exported → Filed → Locked).

const gstEngine = require('../gst');

function serialise(value) {
  // BigInt is not JSON-serialisable; the engine uses integer paise throughout.
  return JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function audit(aid, period, action, detail, meta) {
  // Audit writes must never break the operation they are recording.
  try {
    await pool.query(
      `INSERT INTO gst_audit_log (account_id, period, action, detail, meta)
       VALUES ($1,$2,$3,$4,$5)`,
      [aid, period || '', action, String(detail || '').slice(0, 2000), JSON.stringify(meta || {})],
    );
  } catch (e) {
    console.error('GST audit write failed:', e.message);
  }
}

// Load the effective config: stored overrides merged over the shipped defaults.
async function loadGstConfig(aid) {
  const [acct, cfgRow] = await Promise.all([
    pool.query(
      `SELECT gstin, legal_name, trade_name, pan, state_code, constitution, filing_frequency, qrmp_type
       FROM accounts WHERE id=$1`, [aid]),
    pool.query('SELECT config FROM gst_config WHERE account_id=$1', [aid]),
  ]);
  const a = acct.rows[0] || {};
  const overrides = (cfgRow.rows[0] && cfgRow.rows[0].config) || {};
  const cfg = gstEngine.mergeConfig({
    ...overrides,
    business: {
      ...(overrides.business || {}),
      gstin: a.gstin || (overrides.business && overrides.business.gstin) || '',
      legalName: a.legal_name || '',
      tradeName: a.trade_name || '',
      pan: a.pan || '',
      stateCode: a.state_code || '',
      constitution: a.constitution || 'proprietorship',
    },
    filing: {
      ...(overrides.filing || {}),
      frequency: a.filing_frequency || 'monthly',
      qrmpType: a.qrmp_type || 'monthly-payment',
    },
  }, gstEngine.DEFAULT_CONFIG);
  return { cfg, account: a };
}

// GET /api/gst/periods — list periods with their workflow status
app.get('/api/gst/periods', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const { cfg } = await loadGstConfig(aid);
    const r = await pool.query(
      `SELECT period, status, arn, filing_date, locked_at, gstr1_exported_at, gstr3b_exported_at, notes, updated_at
       FROM gst_periods WHERE account_id=$1 ORDER BY period DESC`, [aid]);
    const locked = new Set(r.rows.filter((x) => x.locked_at || x.status === 'locked' || x.status === 'filed')
      .map((x) => x.period));
    res.json({
      periods: r.rows,
      lockedPeriods: [...locked],
      availablePeriods: gstEngine.periodsInFY(new Date().toISOString().slice(0, 10), cfg),
      dueDates: Object.fromEntries(gstEngine.periodsInFY(new Date().toISOString().slice(0, 10), cfg)
        .map((p) => [p, gstEngine.dueDatesFor(p, cfg)])),
    });
  } catch (e) {
    console.error('GST periods error:', e);
    res.status(500).json({ error: 'Failed to load GST periods' });
  }
});

// GET /api/gst/return/:period — the whole return for a period
app.get('/api/gst/return/:period', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  const period = String(req.params.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: 'Period must be YYYY-MM' });
  }
  try {
    const { cfg } = await loadGstConfig(aid);

    const [salesR, prodR, invR, periodR, reconR, decR] = await Promise.all([
      pool.query('SELECT * FROM sales WHERE account_id=$1 ORDER BY date', [aid]),
      pool.query('SELECT * FROM products WHERE account_id=$1 ORDER BY id', [aid]),
      pool.query('SELECT * FROM inventory_history WHERE account_id=$1 ORDER BY date', [aid]),
      pool.query('SELECT * FROM gst_periods WHERE account_id=$1 AND period=$2', [aid, period]),
      pool.query('SELECT raw FROM gst_recon_2b WHERE account_id=$1 AND period=$2', [aid, period]),
      pool.query('SELECT match_key, decision, note FROM gst_recon_2b WHERE account_id=$1 AND period=$2', [aid, period]),
    ]);

    const pr = periodR.rows[0] || {};
    const locked = !!(pr.locked_at || pr.status === 'locked' || pr.status === 'filed');

    // user decisions from earlier reconciliation runs
    const decisions = new Map();
    for (const d of decR.rows) decisions.set(d.match_key, d.decision);

    // the uploaded 2B rows, if any
    let twoBRows = [];
    for (const row of reconR.rows) {
      const raw = row.raw || {};
      if (Array.isArray(raw.rows)) twoBRows = twoBRows.concat(raw.rows);
    }

    const out = gstEngine.buildReturn({
      sales: salesR.rows,
      products: prodR.rows,
      purchases: invR.rows,
      cfg,
      period,
      lockedPeriods: locked ? [period] : [],
      recon2B: twoBRows,
      reconDecisions: decisions,
      manual3B: pr.manual_input || {},
      annualTurnoverRupees: 0,
    });

    res.json(serialise({
      period,
      status: pr.status || 'draft',
      arn: pr.arn || '',
      filingDate: pr.filing_date,
      locked,
      lockedAt: pr.locked_at,
      exportedAt: { gstr1: pr.gstr1_exported_at, gstr3b: pr.gstr3b_exported_at },
      notes: pr.notes || '',
      validation: out.validation,
      gstr1: out.gstr1,
      gstr3b: out.gstr3b,
      recon2b: out.recon2b,
      booksVsReturn: out.booksVsReturn,
      turnover: out.turnover,
      portalJSON: out.portalJSON,
      schemaCheck: out.schemaCheck,
      dueDates: out.dueDates,
      requiresIFF: out.requiresIFF,
      schemaVersion: gstEngine.GSTR1_SCHEMA_VERSION,
    }));
  } catch (e) {
    console.error('GST return error:', e);
    if (process.env.GST_DEBUG) { console.error(e); }
    res.status(500).json({ error: 'Failed to build the GST return', detail: String((e && e.stack) || e) });
  }
});

// GET /api/gst/config — the effective config (defaults merged with overrides).
// The billing screen reads document types and reason codes from here so the POS
// never has its own copy of the legal vocabulary.
app.get('/api/gst/config', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const r = await pool.query('SELECT config FROM gst_config WHERE account_id=$1', [aid]);
    const overrides = (r.rows[0] && r.rows[0].config) || {};
    res.json({ config: gstEngine.mergeConfig(overrides), overrides, states: gstEngine.STATE_CODES });
  } catch (e) {
    console.error('GST config read error:', e);
    res.status(500).json({ error: 'Failed to load GST configuration' });
  }
});

// POST /api/gst/config — persist config overrides
app.post('/api/gst/config', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const { config = {} } = req.body || {};
    await pool.query(
      `INSERT INTO gst_config (account_id, config, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (account_id) DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()`,
      [aid, JSON.stringify(config)],
    );
    await audit(aid, '', 'config.update', 'GST configuration updated', { keys: Object.keys(config) });
    res.json({ success: true });
  } catch (e) {
    console.error('GST config error:', e);
    res.status(500).json({ error: 'Failed to save GST configuration' });
  }
});

// POST /api/gst/business — persist business identity on the account
app.post('/api/gst/business', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const {
      gstin = '', legalName = '', tradeName = '', pan = '', stateCode = '',
      constitution = 'proprietorship', filingFrequency = 'monthly', qrmpType = 'monthly-payment',
    } = req.body || {};

    if (gstin) {
      const chk = gstEngine.validateGSTIN(gstin, gstEngine.DEFAULT_CONFIG);
      if (!chk.valid && chk.reason !== 'CHECKSUM') {
        return res.status(400).json({ error: `Invalid GSTIN (${chk.reason})` });
      }
    }
    if (stateCode && !gstEngine.STATE_CODES[stateCode]) {
      return res.status(400).json({ error: 'Unknown state code' });
    }

    await pool.query(
      `UPDATE accounts SET gstin=$2, legal_name=$3, trade_name=$4, pan=$5, state_code=$6,
              constitution=$7, filing_frequency=$8, qrmp_type=$9
       WHERE id=$1`,
      [aid, String(gstin).slice(0, 15).toUpperCase(), String(legalName).slice(0, 255),
        String(tradeName).slice(0, 255), String(pan).slice(0, 10).toUpperCase(),
        String(stateCode).slice(0, 2), String(constitution).slice(0, 30),
        String(filingFrequency).slice(0, 20), String(qrmpType).slice(0, 20)],
    );
    await audit(aid, '', 'business.update', 'Business GST details updated', { gstin, stateCode });
    res.json({ success: true });
  } catch (e) {
    console.error('GST business error:', e);
    res.status(500).json({ error: 'Failed to save business details' });
  }
});

// POST /api/gst/validate/:period — validation report only
app.post('/api/gst/validate/:period', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  const period = String(req.params.period || '');
  try {
    const { cfg } = await loadGstConfig(aid);
    const [salesR, prodR, periodR] = await Promise.all([
      pool.query('SELECT * FROM sales WHERE account_id=$1 ORDER BY date', [aid]),
      pool.query('SELECT * FROM products WHERE account_id=$1', [aid]),
      pool.query('SELECT * FROM gst_periods WHERE account_id=$1 AND period=$2', [aid, period]),
    ]);
    const pr = periodR.rows[0] || {};
    const locked = !!(pr.locked_at || pr.status === 'locked' || pr.status === 'filed');
    const idx = gstEngine.buildMasterIndex(prodR.rows);
    const docs = salesR.rows
      .map((s) => gstEngine.normalizeSale(s, cfg, idx))
      .filter((d) => d.period === period);
    const validation = gstEngine.validateForFiling(docs, {
      cfg, masterIndex: idx, lockedPeriods: locked ? [period] : [],
    });
    res.json(serialise(validation));
  } catch (e) {
    console.error('GST validate error:', e);
    res.status(500).json({ error: 'Failed to validate' });
  }
});

// POST /api/gst/status/:period — advance the workflow (validated / exported / filed / locked)
app.post('/api/gst/status/:period', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  const period = String(req.params.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM' });
  const { status, arn = '', filingDate = null, notes = '', manualInput = null } = req.body || {};

  const ALLOWED = { draft: ['validated'], validated: ['exported', 'draft'], exported: ['filed', 'validated'], filed: ['locked'], locked: [] };
  try {
    const cur = await pool.query('SELECT * FROM gst_periods WHERE account_id=$1 AND period=$2', [aid, period]);
    const current = cur.rows[0];
    const from = current ? current.status : 'draft';
    if (!ALLOWED[from] || !ALLOWED[from].includes(status)) {
      return res.status(400).json({ error: `Cannot move a period from "${from}" to "${status}"` });
    }
    if (status === 'filed' && !arn) {
      return res.status(400).json({ error: 'Enter the ARN when marking a period as filed' });
    }

    // A filed/locked period must not be editable — enforce on document writes.
    if (status === 'locked') {
      // lock every document dated in the period
      await pool.query(
        `UPDATE sales SET doc_status='cancelled', cancel_reason=$3
         WHERE account_id=$1 AND to_char(date,'YYYY-MM')=$2 AND doc_status <> 'cancelled'`,
        [aid, period, 'Period locked — raise a credit note instead'],
      );
    }

    await pool.query(
      `INSERT INTO gst_periods (account_id, period, status, arn, filing_date, locked_at,
              gstr1_exported_at, gstr3b_exported_at, manual_input, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (account_id, period) DO UPDATE SET
         status=EXCLUDED.status, arn=EXCLUDED.arn, filing_date=EXCLUDED.filing_date,
         locked_at=EXCLUDED.locked_at, notes=EXCLUDED.notes,
         gstr1_exported_at=COALESCE(EXCLUDED.gstr1_exported_at, gst_periods.gstr1_exported_at),
         gstr3b_exported_at=COALESCE(EXCLUDED.gstr3b_exported_at, gst_periods.gstr3b_exported_at),
         manual_input=COALESCE(EXCLUDED.manual_input, gst_periods.manual_input),
         updated_at=NOW()`,
      [aid, period, status, String(arn).slice(0, 50), filingDate || null,
        status === 'locked' ? new Date() : null,
        status === 'exported' ? new Date() : null,
        status === 'exported' ? new Date() : null,
        manualInput ? JSON.stringify(manualInput) : null, String(notes).slice(0, 2000)],
    );

    await audit(aid, period, `status.${status}`, `Period moved ${from} → ${status}`, { arn });
    res.json({ success: true, status, from });
  } catch (e) {
    console.error('GST status error:', e);
    res.status(500).json({ error: 'Failed to update period status' });
  }
});

// POST /api/gst/2b — store an uploaded GSTR-2B file for a period
app.post('/api/gst/2b', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  const { period = '', payload } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM' });
  try {
    const cfg = (await loadGstConfig(aid)).cfg;
    // parse2B returns integer paise (BigInt) — stringify via serialise() so the
    // payload round-trips without losing precision.
    const rows = gstEngine.parse2B(payload, cfg);
    await pool.query(
      `INSERT INTO gst_recon_2b (account_id, period, match_key, bucket, decision, note,
              supplier_gstin, invoice_no, invoice_date, taxable, igst, cgst, sgst, cess, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (account_id, period, match_key) DO UPDATE SET
         bucket=EXCLUDED.bucket, decision=EXCLUDED.decision, note=EXCLUDED.note,
         raw=EXCLUDED.raw, updated_at=NOW()`,
      [aid, period,
        gstEngine.matchKey(rows.length ? rows[0].gstin : '', '', cfg) + '|' + '__file__',
        'uploaded', 'pending', '', '', '', null, 0, 0, 0, 0, 0,
        JSON.stringify(serialise({ rows }))],
    );
    await audit(aid, period, 'recon2b.upload', `Uploaded GSTR-2B (${rows.length} rows)`, { rows: rows.length });
    res.json({ success: true, rows: rows.length });
  } catch (e) {
    console.error('GST 2B upload error:', e);
    res.status(500).json({ error: `Failed to read the 2B file: ${e.message}` });
  }
});

// POST /api/gst/recon2b/:period/:key — record accept / reject / pending
app.post('/api/gst/recon2b/:period/:key', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  const period = String(req.params.period || '');
  const key = decodeURIComponent(String(req.params.key || ''));
  const { decision = 'pending', note = '', bucket = '', supplierGstin = '', invoiceNo = '',
    invoiceDate = null, taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0 } = req.body || {};
  if (!['accept', 'reject', 'pending'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be accept, reject or pending' });
  }
  try {
    await pool.query(
      `INSERT INTO gst_recon_2b (account_id, period, match_key, bucket, decision, note,
              supplier_gstin, invoice_no, invoice_date, taxable, igst, cgst, sgst, cess, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (account_id, period, match_key) DO UPDATE SET
         decision=EXCLUDED.decision, note=EXCLUDED.note, bucket=EXCLUDED.bucket,
         updated_at=NOW()`,
      [aid, period, key, bucket || 'pending', decision, String(note).slice(0, 2000),
        String(supplierGstin).slice(0, 15), String(invoiceNo).slice(0, 64), invoiceDate,
        taxable || 0, igst || 0, cgst || 0, sgst || 0, cess || 0],
    );
    await audit(aid, period, 'recon2b.decision', `${key} → ${decision}`, { decision });
    res.json({ success: true, decision });
  } catch (e) {
    console.error('GST recon decision error:', e);
    res.status(500).json({ error: 'Failed to save the decision' });
  }
});

// GET /api/gst/audit — audit trail
app.get('/api/gst/audit', authMiddleware, async (req, res) => {
  const aid = req.user.id;
  try {
    const r = await pool.query(
      `SELECT period, action, detail, meta, created_at
       FROM gst_audit_log WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200`, [aid]);
    res.json(serialise(r.rows));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load the audit log' });
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
