'use strict';
/**
 * End-to-end API smoke test for the GST module.
 * Starts the real Express server, exercises the workflow against a temp
 * account, then removes everything it created.
 */
const path = require('path');
const BASE = 'http://localhost:' + (process.env.PORT || 3111);
const { spawn } = require('child_process');

let server;
let token = '';
let accountId = 0;
const stamp = Date.now();
const USER = `gst_smoke_${stamp}`;
const PASS = 'Smoke@Test123';

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + '/api' + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
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

(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'backend', 'server.js')], {
    env: { ...process.env, PORT: '3111', GST_DEBUG: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    if (!await waitForServer()) throw new Error('server did not start');

    // 1. signup
    let r = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: USER, name: 'GST Smoke', email: USER + '@test.local', password: PASS, location: 'Mumbai' }),
    });
    check('signup', r.status === 200 && r.data.token, r.data.error || '');
    token = r.data.token || '';
    accountId = r.data.user && r.data.user.id;

    // 1b. log back in. This endpoint selects the account row itself, so it is
    // the only thing that catches a column dropped from that SELECT — signup
    // happily returns a token without touching the password hash.
    r = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ident: USER, password: PASS }),
    });
    check('login works after signup', r.status === 200 && r.data.token, r.data.error || `status=${r.status}`);
    check('login rejects a wrong password', await (async () => {
      const bad = await api('/auth/login', {
        method: 'POST', body: JSON.stringify({ ident: USER, password: PASS + 'x' }),
      });
      return bad.status === 400;
    })());
    check('login returns business GST fields', !!(r.data.user && 'stateCode' in r.data.user && 'filingFrequency' in r.data.user),
      JSON.stringify(r.data.user || {}).slice(0, 120));
    if (r.data.token) token = r.data.token;

    // 2. business GSTIN setup — reject malformed, accept a valid one
    r = await api('/gst/business', { method: 'POST', body: JSON.stringify({ gstin: 'NOPE', stateCode: '27' }) });
    check('malformed GSTIN rejected', r.status === 400, r.data.error || '');

    r = await api('/gst/business', { method: 'POST', body: JSON.stringify({ gstin: '27AAPFU0939F1Z4', stateCode: '99' }) });
    check('unknown state code rejected', r.status === 400, r.data.error || '');

    r = await api('/gst/business', {
      method: 'POST',
      body: JSON.stringify({ gstin: '27AAPFU0939F1Z4', stateCode: '27', legalName: 'GST Smoke', constitution: 'proprietorship', filingFrequency: 'monthly' }),
    });
    check('business details saved', r.status === 200, r.data.error || '');

    // 3. seed sales for the period
    const today = new Date();
    const period = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const iso = period + '-05';
    r = await api('/save', {
      method: 'POST',
      body: JSON.stringify({
        categories: [{ id: 1, name: 'Grocery', emoji: '🛒' }],
        products: [{ id: 1, name: 'Parle-G 20g', price: 10, stock: 100, catId: 1, emoji: '🍪', hsn: '1905', uqc: 'NOS', cgst: 2.5, sgst: 2.5, igst: 0, gst: 5 }],
        sales: [
          { id: 'TXN-000001', customerName: 'Ramesh', items: [{ id: 1, name: 'Parle-G 20g', qty: 10, price: 10, gst: 5, cgst: 2.5, sgst: 2.5, igst: 0, hsn: '1905' }], sub: 100, tax: 5, total: 105, amtPaid: 105, pending: 0, date: iso, taxApplied: true, docType: 'tax_invoice', invoiceNo: 'SI/001', invoiceSeries: 'SI', placeOfSupply: '27', isInterstate: false },
          { id: 'TXN-000002', customerName: 'Karnataka Buyer', items: [{ id: 1, name: 'Parle-G 20g', qty: 2000, price: 100, gst: 5, cgst: 0, sgst: 0, igst: 5, hsn: '1905' }], sub: 200000, tax: 10000, total: 210000, amtPaid: 210000, pending: 0, date: iso, taxApplied: true, docType: 'tax_invoice', invoiceNo: 'SI/002', invoiceSeries: 'SI', placeOfSupply: '29', isInterstate: true },
          { id: 'TXN-000003', customerName: 'Exempt Buyer', items: [{ id: 1, name: 'Parle-G 20g', qty: 10, price: 10, gst: 0, cgst: 0, sgst: 0, igst: 0, hsn: '1905', isNil: true }], sub: 100, tax: 0, total: 100, amtPaid: 100, pending: 0, date: iso, taxApplied: true, docType: 'bill_of_supply', invoiceNo: 'BOS/001', invoiceSeries: 'BOS', placeOfSupply: '27', isInterstate: false, nilRatedReason: 'Agricultural produce' },
          { id: 'TXN-000004', customerName: 'Estimate Guy', items: [{ id: 1, name: 'Parle-G 20g', qty: 1, price: 10, gst: 5, cgst: 2.5, sgst: 2.5, igst: 0, hsn: '1905' }], sub: 10, tax: 0.5, total: 10.5, amtPaid: 0, pending: 10.5, date: iso, taxApplied: true, docType: 'estimate', invoiceNo: 'EST/001', placeOfSupply: '27', isInterstate: false },
        ],
      }),
    });
    check('sales seeded', r.status === 200, r.data.error || '');

    // 4. periods
    r = await api('/gst/periods');
    check('periods listed', r.status === 200 && Array.isArray(r.data.availablePeriods), r.data.error || '');
    check('period available', (r.data.availablePeriods || []).includes(period), period);

    // 5. build the return
    r = await api('/gst/return/' + period);
    check('return built', r.status === 200, r.data.error || '');
    const d = r.data || {};
    check('blockers detected (estimate present)', d.validation && d.validation.counts.blockers > 0,
      `blockers=${d.validation && d.validation.counts.blockers}`);
    check('export blocked by blockers', d.validation && d.validation.canExport === false);

    // 6. classification expectations
    const g = d.gstr1 || {};
    check('B2C Large captured', (g.b2cl || []).length === 1, `b2cl=${(g.b2cl || []).length}`);
    check('B2C Small captured', (g.b2cs || []).length >= 1, `b2cs=${(g.b2cs || []).length}`);
    check('nil supply in nil_exempt (Core Rule 2)', (g.nil_exempt || []).length >= 1, `nil=${(g.nil_exempt || []).length}`);
    check('documents issued listed', (g.docs_issued || []).length >= 1);

    // 7. 3B tie-out
    const b = d.gstr3b || {};
    check('3B ↔ GSTR-1 tied out', b.tieOut && b.tieOut.balanced === true,
      b.tieOut ? `diff=${b.tieOut.diffTaxablePaise}` : 'no tieOut');

    // 8. schema validation of the portal JSON
    check('portal JSON schema valid', d.schemaCheck && d.schemaCheck.ok === true,
      d.schemaCheck ? (d.schemaCheck.errors || []).join(';') : 'none');

    // 9. workflow transitions
    // Manual 3B inputs are edited while the period is still a draft, and the UI
    // sends the current status alongside them. That request must not be treated
    // as a draft→draft transition, or the inputs cannot be entered at all.
    r = await api('/gst/status/' + period, {
      method: 'POST',
      body: JSON.stringify({
        status: 'draft',
        manualInput: { interest: 1250, lateFee: 25000, cashBalance: 7301, creditBalance: 1000 },
      }),
    });
    check('manual inputs save while the period is a draft', r.status === 200, r.data.error || '');
    r = await api('/gst/return/' + period);
    const adds = (r.data.gstr3b || {}).additions || {};
    // paise, serialised as decimal strings because the engine uses BigInt
    check('manual inputs persist as paise',
      String(adds.interest) === '1250' && String(adds.lateFee) === '25000'
      && String(adds.cash) === '7301' && String(adds.credit) === '1000',
      `interest=${adds.interest} lateFee=${adds.lateFee} cash=${adds.cash} credit=${adds.credit}`);

    r = await api('/gst/status/' + period, { method: 'POST', body: JSON.stringify({ status: 'locked' }) });
    check('illegal transition draft→locked rejected', r.status === 400, r.data.error || '');

    r = await api('/gst/status/' + period, { method: 'POST', body: JSON.stringify({ status: 'exported' }) });
    check('illegal transition draft→exported rejected', r.status === 400, r.data.error || '');

    r = await api('/gst/status/' + period, { method: 'POST', body: JSON.stringify({ status: 'validated' }) });
    check('draft→validated', r.status === 200, r.data.error || '');

    r = await api('/gst/status/' + period, { method: 'POST', body: JSON.stringify({ status: 'filed' }) });
    check('validated→filed without ARN rejected', r.status === 400, r.data.error || '');

    r = await api('/gst/status/' + period, { method: 'POST', body: JSON.stringify({ status: 'exported' }) });
    check('validated→exported', r.status === 200, r.data.error || '');

    r = await api('/gst/status/' + period, {
      method: 'POST',
      body: JSON.stringify({ status: 'filed', arn: 'AA260805000123X', filingDate: iso }),
    });
    check('exported→filed with ARN', r.status === 200, r.data.error || '');

    r = await api('/gst/status/' + period, { method: 'POST', body: JSON.stringify({ status: 'locked' }) });
    check('filed→locked', r.status === 200, r.data.error || '');

    // 10. a locked period must reject edits
    r = await api('/gst/return/' + period);
    check('locked period is read-only', r.data && r.data.locked === true);
    check('locked period surfaces a blocker', r.data && r.data.validation.counts.blockers > 0,
      `blockers=${r.data && r.data.validation.counts.blockers}`);

    r = await api('/gst/status/' + period, {
      method: 'POST',
      body: JSON.stringify({ status: 'locked', manualInput: { interest: 999 } }),
    });
    check('locked period refuses a manual input edit', r.status === 400, r.data.error || '');

    // 11. 2B upload + decisions
    r = await api('/gst/2b', {
      method: 'POST',
      body: JSON.stringify({
        period,
        payload: { b2b: [{ ctin: '29AAGCB7383J1ZA', inv: 'INV-001', idt: '2026-08-15', taxableVal: 1000, igstAmt: 180 }] },
      }),
    });
    check('2B uploaded', r.status === 200 && r.data.rows === 1, r.data.error || JSON.stringify(r.data));

    r = await api('/gst/recon2b/' + period + '/' + encodeURIComponent('29AAGCB7383J1ZA|INV1'), {
      method: 'POST',
      body: JSON.stringify({ decision: 'accept' }),
    });
    check('2B decision saved', r.status === 200, r.data.error || '');

    // 12. audit log
    r = await api('/gst/audit');
    const actions = (r.data || []).map((x) => x.action);
    check('audit log records actions', (r.data || []).length > 0, actions.join(', '));
    check('audit records lock', actions.includes('status.locked'));

    // 13. config
    r = await api('/gst/config', {
      method: 'POST',
      body: JSON.stringify({ thresholds: { b2cLargeInvoiceValue: 50000 }, reconciliation: { toleranceRupees: 2 } }),
    });
    check('config saved', r.status === 200, r.data.error || '');

    // A download happens in the browser, so the audit trail only sees the file
    // leaving the system if the client reports it. Check it is recorded, and
    // that a bogus kind is rejected rather than silently logged.
    r = await api('/gst/export', {
      method: 'POST',
      body: JSON.stringify({ period, kind: 'excel', fileName: 'GSTR1_test.xlsx', rowCounts: { b2b: 3 } }),
    });
    check('export is recorded in the audit trail', r.status === 200 && r.data.success, r.data.error || '');

    r = await api('/gst/export', {
      method: 'POST',
      body: JSON.stringify({ period, kind: 'something-else' }),
    });
    check('export audit rejects an unknown kind', r.status === 400, r.data.error || '');

    r = await api('/gst/export', { method: 'POST', body: JSON.stringify({ period: 'nope', kind: 'excel' }) });
    check('export audit rejects a bad period', r.status === 400, r.data.error || '');

    // 14. cleanup
    r = await api('/delete-all', { method: 'POST', body: JSON.stringify({ password: PASS }) });
    check('cleanup', r.status === 200, r.data.error || '');
  } catch (e) {
    check('suite completed', false, e.message);
  } finally {
    if (server) server.kill();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();