'use strict';
/**
 * Delta-save test: proves /api/save upserts only what changed and that data
 * survives. Also confirms the full-payload path still works.
 */
const path = require('path');
const BASE = 'http://localhost:' + 3112;
const { spawn } = require('child_process');

let server, token = '';
const stamp = Date.now();
const USER = `gst_delta_${stamp}`;
const PASS = 'Delta@Test123';
const results = [];
const check = (n, c, e) => { results.push({ n, ok: !!c }); console.log(`${c ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const res = await fetch(BASE + '/api' + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  const t = await res.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 120) }; }
  return { status: res.status, data: d };
}

async function waitFor() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.status) return true; } catch {}
    await wait(500);
  }
  return false;
}

const P = (n) => ({ id: n, name: 'P' + n, price: 10 * n, stock: n, catId: 1, emoji: '📦', hsn: '1905' });

(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'backend', 'server.js')], {
    env: { ...process.env, PORT: '3112' }, stdio: 'ignore',
  });
  try {
    if (!await waitFor()) throw new Error('no server');
    let r = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ username: USER, name: 'D', email: USER + '@t.local', password: PASS, location: 'Pune' }) });
    token = r.data.token; check('signup', !!token);

    // full save (baseline)
    r = await api('/save', { method: 'POST', body: JSON.stringify({
      categories: [{ id: 1, name: 'C', emoji: '📂' }],
      products: [P(1), P(2), P(3)],
      sales: [], inventoryHistory: [], udhaarRecords: [], advanceOrders: [], notes: [], expenses: [],
    }) });
    check('full save', r.status === 200, r.data.error || '');

    // delta: update ONE product, delete another, add a third
    const p1 = { ...P(1), price: 999 };
    const p4 = P(4);
    r = await api('/save', { method: 'POST', body: JSON.stringify({
      delta: { mode: 'delta', changed: { products: { upserts: [p1, p4], deletes: [3] } } },
    }) });
    check('delta save accepted', r.status === 200 && r.data.mode === 'delta', r.data.error || JSON.stringify(r.data));

    r = await api('/load');
    const products = r.data.products || [];
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    check('update applied', byId[1] && Number(byId[1].price) === 999, `price=${byId[1] && byId[1].price}`);
    check('insert applied', !!byId[4], `count=${products.length}`);
    check('delete applied', !byId[3], `id3 gone=${!byId[3]}`);
    check('untouched rows survive', !!byId[2] && !!byId[1], `count=${products.length}`);

    // delta on sales with GST fields round-trips
    const sale = {
      id: 'TXN-000001', customerName: 'Ramesh', customerPhone: '9999999999',
      items: [{ id: 1, name: 'P1', qty: 2, price: 999, gst: 5, cgst: 2.5, sgst: 2.5, igst: 0, hsn: '1905' }],
      sub: 1998, tax: 99.9, total: 2097.9, amtPaid: 2097.9, pending: 0,
      date: new Date().toISOString(), taxApplied: true, payType: 'paid',
      docType: 'tax_invoice', invoiceNo: 'SI/001', invoiceSeries: 'SI',
      placeOfSupply: '27', isInterstate: false, custGstin: '',
    };
    r = await api('/save', { method: 'POST', body: JSON.stringify({
      delta: { mode: 'delta', changed: { sales: { upserts: [sale], deletes: [] } } },
    }) });
    check('delta sale saved', r.status === 200, r.data.error || '');

    r = await api('/load');
    const s = (r.data.sales || [])[0];
    check('sale GST fields persisted', s && s.doc_type === 'tax_invoice' && s.invoice_no === 'SI/001' && s.place_of_supply === '27',
      s ? `${s.doc_type}/${s.invoice_no}/${s.place_of_supply}` : 'missing');
    check('is_interstate persisted (the reload bug)', s && s.is_interstate === false, `is_interstate=${s && s.is_interstate}`);

    // The legacy client shape only ever set `intra` (true = same state). Without
    // the server-side fallback the column lands NULL and the bill is read back
    // as inter-state after a reload. `isInterstate` must be absent for the
    // fallback to be exercised at all.
    const legacy = (id, intra) => {
      const o = { ...sale, id, intra };
      delete o.isInterstate;
      return o;
    };
    r = await api('/save', { method: 'POST', body: JSON.stringify({
      delta: { mode: 'delta', changed: { sales: { upserts: [
        legacy('TXN-000002', false), legacy('TXN-000003', true),
      ], deletes: ['TXN-000001'] } } },
    }) });
    r = await api('/load');
    const bySaleId = Object.fromEntries((r.data.sales || []).map((x) => [x.id, x]));
    check('legacy intra=false maps to is_interstate=true',
      bySaleId['TXN-000002'] && bySaleId['TXN-000002'].is_interstate === true,
      `got=${bySaleId['TXN-000002'] && bySaleId['TXN-000002'].is_interstate}`);
    check('legacy intra=true maps to is_interstate=false',
      bySaleId['TXN-000003'] && bySaleId['TXN-000003'].is_interstate === false,
      `got=${bySaleId['TXN-000003'] && bySaleId['TXN-000003'].is_interstate}`);

    // A sale saved without any GST fields must still land as a finalised tax
    // invoice. A NULL doc_status silently defeats the "doc_status <> 'cancelled'"
    // filter that period locking relies on, so the defaults matter.
    r = await api('/save', { method: 'POST', body: JSON.stringify({
      delta: { mode: 'delta', changed: { sales: { upserts: [
        { id: 'TXN-000004', customerName: 'Walk-in', items: [], sub: 100, tax: 0, total: 100,
          amtPaid: 100, pending: 0, date: new Date().toISOString(), method: 'Cash', payType: 'paid' },
      ], deletes: ['TXN-000002', 'TXN-000003'] } } },
    }) });
    r = await api('/load');
    const bare = (r.data.sales || []).find((x) => x.id === 'TXN-000004');
    check('enum defaults applied when GST fields are absent',
      bare && bare.doc_type === 'tax_invoice' && bare.doc_status === 'finalised' && bare.supply_type === 'domestic',
      bare ? `${bare.doc_type}/${bare.doc_status}/${bare.supply_type}` : 'missing');
    check('customer_location round-trips',
      bare && bare.customer_location === '', `got=${bare && bare.customer_location}`);

    // noop delta is harmless
    r = await api('/save', { method: 'POST', body: JSON.stringify({ delta: { mode: 'noop' } }) });
    check('noop delta tolerated', r.status === 200, r.data.error || '');

    // full save still works after delta use (backwards compatible)
    r = await api('/save', { method: 'POST', body: JSON.stringify({
      categories: [{ id: 1, name: 'C', emoji: '📂' }],
      products: [P(1)], sales: [sale], inventoryHistory: [], udhaarRecords: [],
      advanceOrders: [], notes: [], expenses: [],
    }) });
    check('full save after delta', r.status === 200, r.data.error || '');
    r = await api('/load');
    check('full save replaced products', (r.data.products || []).length === 1, `count=${(r.data.products||[]).length}`);

    r = await api('/delete-all', { method: 'POST', body: JSON.stringify({ password: PASS }) });
    check('cleanup', r.status === 200, r.data.error || '');
  } catch (e) {
    check('suite completed', false, e.message);
  } finally {
    if (server) server.kill();
    const f = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - f}/${results.length} checks passed`);
    process.exit(f ? 1 : 0);
  }
})();