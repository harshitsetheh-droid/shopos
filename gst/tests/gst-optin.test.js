'use strict';
/**
 * GST opt-in guarantee, end to end through the real API.
 *
 * The rule under test: tax exists only where the user explicitly selected the GST
 * option. A document with GST off must contribute NO tax to GSTR-1 or GSTR-3B,
 * even though its item master carries a rate.
 *
 * The nuance this file pins down deliberately: a GST-off document is a Bill of
 * Supply. It must not appear in the TAXABLE tables (B2B/B2C/3.1(a)), but its
 * turnover still belongs in the nil/exempt/non-GST reporting - dropping it
 * entirely would under-report revenue. So the assertion is "tax is zero" plus
 * "not in the taxable buckets", not "invisible".
 */
const path = require('path');
const BASE = 'http://localhost:' + (process.env.PORT || 3113);
const { spawn } = require('child_process');

let server;
let token = '';
const stamp = Date.now();
const USER = `gst_optin_${stamp}`;
const PASS = 'Optin@Test123';

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + '/api' + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ident: 'x', password: 'y' }),
      });
      if (r.status) return true;
    } catch { /* not up yet */ }
    await wait(500);
  }
  return false;
}

/**
 * Every taxable bucket in GSTR-1, so "no tax" can be checked exhaustively.
 * nil_exempt is deliberately absent: a GST-off document belongs there, because
 * dropping it would under-report turnover.
 */
const TAXABLE_TABLES = ['b2b', 'b2cl', 'b2cs', 'exp', 'sez'];

/** The engine reports money in integer paise, under *Paise keys. */
function taxPaise(row) {
  return Number(row.igstPaise || 0) + Number(row.cgstPaise || 0)
    + Number(row.sgstPaise || 0) + Number(row.cessPaise || 0);
}
function taxablePaise(row) {
  return Number(row.totalTaxablePaise != null ? row.totalTaxablePaise : row.taxablePaise || 0);
}

function sumTaxInTables(gstr1, tables) {
  let tax = 0;
  let taxable = 0;
  let rows = 0;
  for (const t of tables) {
    for (const row of (gstr1[t] || [])) {
      rows++;
      tax += taxPaise(row);
      taxable += taxablePaise(row);
    }
  }
  return { tax, taxable, rows };
}

/** Which table (if any) this invoice number shows up in. */
function mentionsDoc(gstr1, docId) {
  for (const [k, v] of Object.entries(gstr1 || {})) {
    if (!Array.isArray(v)) continue;
    for (const row of v) {
      if (JSON.stringify(row).includes(docId)) return k;
    }
  }
  return null;
}

const rs = (paise) => Number(paise) / 100;

(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'backend', 'server.js')], {
    env: { ...process.env, PORT: '3113' },
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: path.join(__dirname, '..', '..', 'backend'),
  });

  try {
    if (!await waitForServer()) throw new Error('server did not start');

    let r = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: USER, name: 'GST Opt-in', email: USER + '@test.local', password: PASS, location: 'Mumbai' }),
    });
    check('signup', r.status === 200 && r.data.token, r.data.error || '');
    token = r.data.token || '';
    const accountId = r.data.user && r.data.user.id;

    r = await api('/gst/business', {
      method: 'POST',
      body: JSON.stringify({ gstin: '27AAPFU0939F1Z4', stateCode: '27', legalName: 'GST Opt-in', constitution: 'proprietorship', filingFrequency: 'monthly' }),
    });
    check('business details saved', r.status === 200, r.data.error || '');

    const today = new Date();
    const period = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const iso = period + '-05';

    // Two identical taxable products, two documents that differ ONLY in whether the
    // GST option was selected. Any tax difference between them is the bug.
    const gstItem = { id: 1, name: 'Parle-G 20g', qty: 10, price: 10, gst: 18, cgst: 9, sgst: 9, igst: 0, hsn: '1905', uqc: 'NOS' };

    r = await api('/save', {
      method: 'POST',
      body: JSON.stringify({
        categories: [{ id: 1, name: 'Grocery', emoji: 'x' }],
        products: [{ id: 1, name: 'Parle-G 20g', price: 10, stock: 100, catId: 1, emoji: 'x', hsn: '1905', uqc: 'NOS', gst: 18, cgst: 9, sgst: 9, igst: 0 }],
        advanceOrders: [{
          // GST OFF: the shape finalizeAdvOrder now produces. Rates are zeroed and
          // taxApplied is false, so nothing can be re-derived from the master.
          id: 'ADV-0001', custName: 'Walk-in', phone: '9000000000',
          packTime: iso + 'T10:00', advPaid: 100, notes: '', total: 100,
          status: 'billed', saleId: 'TXN-000001', gstEnabled: false, advanceUnused: 0,
          items: [{ productId: 1, productName: 'Parle-G 20g', price: 10, qty: 10 }],
        }],
        sales: [
          { id: 'TXN-000001', customerName: 'Walk-in', items: [{ ...gstItem, gst: 0, cgst: 0, sgst: 0, igst: 0 }], sub: 100, tax: 0, total: 100, amtPaid: 100, pending: 0, date: iso, taxApplied: false, docType: 'bill_of_supply', invoiceNo: 'BOS/001', invoiceSeries: 'BOS', placeOfSupply: '27', isInterstate: false },
          // GST ON: same product, same rate, same value.
          { id: 'TXN-000002', customerName: 'Walk-in', items: [gstItem], sub: 100, tax: 18, total: 118, amtPaid: 118, pending: 0, date: iso, taxApplied: true, docType: 'tax_invoice', invoiceNo: 'SI/001', invoiceSeries: 'SI', placeOfSupply: '27', isInterstate: false },
        ],
      }),
    });
    check('sales seeded', r.status === 200, r.data.error || '');

    r = await api('/gst/return/' + period);
    check('return built', r.status === 200, r.data.error || '');
    const d = r.data || {};
    const g = d.gstr1 || {};
    const b = d.gstr3b || {};

    // ── the GST-on document must be present and fully taxed ────────────────────
    const taxable = sumTaxInTables(g, TAXABLE_TABLES);
    check('GST-on doc is taxed in a taxable table', taxable.tax > 0,
      `tax=₹${rs(taxable.tax)} taxable=₹${rs(taxable.taxable)}`);
    check('taxable tables hold exactly the GST-on value (₹100)',
      rs(taxable.taxable) === 100, `₹${rs(taxable.taxable)}`);
    check('tax in taxable tables is exactly 18% of ₹100 (₹18)',
      rs(taxable.tax) === 18, `₹${rs(taxable.tax)}`);

    // ── the GST-off doc must add nothing anywhere ─────────────────────────────
    // It legitimately appears in nil_exempt (a Bill of Supply still has turnover),
    // so the assertion is about the TAXABLE tables specifically.
    const offIn = mentionsDoc(g, 'BOS/001');
    check('GST-off doc appears only in the non-GST table',
      offIn === null || offIn === 'nil_exempt',
      `found in ${offIn}`);
    check('GST-off doc is in no taxable table',
      TAXABLE_TABLES.every((t) => !JSON.stringify(g[t] || []).includes('BOS/001')),
      `taxable tables checked: ${TAXABLE_TABLES.join(', ')}`);

    // Its turnover must still be reported, just not as tax.
    const bosRow = (g.nil_exempt || []).find((row) => JSON.stringify(row).includes('BOS/001'));
    check('GST-off doc is still reported in the non-GST table', !!bosRow,
      `nil_exempt=${(g.nil_exempt || []).length}`);
    if (bosRow) {
      check('non-GST row reports zero tax', taxPaise(bosRow) === 0,
        `tax=₹${rs(taxPaise(bosRow))}`);
      check('non-GST row still reports its taxable value', rs(taxablePaise(bosRow)) === 100,
        `taxable=₹${rs(taxablePaise(bosRow))}`);
    }

    // ── 3B must reflect only the GST-on supply in the taxable head ─────────────
    const t31 = b.t31 || {};
    const a = t31.a_taxable || {};
    const e = t31.e_non_gst || {};
    check('3.1(a) taxable value counts only the GST-on doc',
      rs(a.taxablePaise) === 100, `taxable=₹${rs(a.taxablePaise)} (expected 100, not 200)`);
    check('3.1(a) tax is CGST ₹9 + SGST ₹9, IGST ₹0',
      rs(a.cgstPaise) === 9 && rs(a.sgstPaise) === 9 && rs(a.igstPaise) === 0,
      `igst=₹${rs(a.igstPaise)} cgst=₹${rs(a.cgstPaise)} sgst=₹${rs(a.sgstPaise)}`);
    check('3.1(e) non-GST holds the GST-off value with zero tax',
      rs(e.taxablePaise) === 100 && taxPaise(e) === 0,
      `taxable=₹${rs(e.taxablePaise)} tax=₹${rs(taxPaise(e))}`);

    // The outward liability must be exactly the one taxed invoice.
    // setOff.payable is the post-credit figure; liability is pre-credit.
    // BigInt paise arrive as strings over JSON, hence the explicit Number().
    const liab = b.liability || {};
    const liabTotal = rs(Number(liab.cgst || 0) + Number(liab.sgst || 0) + Number(liab.igst || 0));
    check('outward liability is ₹18, from the GST-on document only',
      liabTotal === 18, `₹${liabTotal}`);

    // ── 3B and GSTR-1 must still tie out even with a mixed period ──────────────
    check('3B ties out to GSTR-1', b.tieOut && b.tieOut.balanced === true,
      b.tieOut ? `diff=₹${rs(b.tieOut.diffTaxablePaise)}` : 'no tieOut');

    // ── docs issued count both documents (an invoice was still issued) ─────────
    check('both documents are counted as issued', (g.docs_issued || []).length >= 2,
      `docs_issued=${(g.docs_issued || []).length}`);

    // ── cleanup ───────────────────────────────────────────────────────────────
    // The full-save path requires categories+products to be arrays; sending only
    // sales is rejected outright, so the test would fail on its own teardown.
    r = await api('/save', {
      method: 'POST',
      body: JSON.stringify({ categories: [], products: [], sales: [], advanceOrders: [] }),
    });
    check('cleanup', r.status === 200, r.data.error || '');
    r = await api('/gst/periods');
    check('account still readable after cleanup', r.status === 200, r.data.error || '');
  } catch (e) {
    check('suite completed', false, e.message);
  } finally {
    if (server) server.kill();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
