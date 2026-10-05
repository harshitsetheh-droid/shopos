/* ============================================================================
 * GST & RETURNS — UI layer
 * All report logic lives in /gst (pure, unit-tested). This file only:
 *   - calls /api/gst/* endpoints
 *   - renders tables/figures (paise → ₹ for display only)
 *   - handles export (Excel + portal JSON) with a pre-download schema check
 *   - drives the period workflow: Draft → Validated → Exported → Filed → Locked
 * ==========================================================================*/

let _gst = {
  period: '',
  data: null,          // full return payload for _gst.period
  loading: false,
  tab: 'overview',
  config: null,        // engine config echoed from the server
  setup: null,         // business + filing settings
  schemaCheck: null,
  error: '',
};

/* ── helpers ─────────────────────────────────────────────────────────────── */
const GST_STATE_CODES = window.GST_STATE_CODES || null;

function gstRs(paise){
  // integer paise → display rupees. Never feed the result back into arithmetic.
  const n = Number(paise || 0);
  return '₹' + fmt(n / 100);
}
/** Sum paise values that may arrive as BigInt, Number or decimal string. */
function gstSum(...vals){
  let n = 0;
  for (const v of vals){ const x = Number(v || 0); if (Number.isFinite(x)) n += x; }
  return n;
}
function gstQty(v){  const n = Number(v || 0);
  return Number.isFinite(n) ? String(n) : '0';
}
function gstEscape(v){
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function gstTab(name){
  _gst.tab = name;
  document.querySelectorAll('.gst-tabs .gst-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.gst-tabpanel').forEach((p) => {
    p.style.display = p.dataset.tab === name ? '' : 'none';
  });
}

/**
 * Called from the app after login / session restore so the setup form and
 * period list are ready before the user opens the GST page.
 */
async function gstOnLogin(user){
  if (user && user.gstin !== undefined){
    _gst.setup = {
      gstin: user.gstin || '',
      legalName: user.legalName || '',
      tradeName: user.tradeName || '',
      pan: user.pan || '',
      stateCode: user.stateCode || '',
      constitution: user.constitution || 'proprietorship',
      filingFrequency: user.filingFrequency || 'monthly',
      qrmpType: user.qrmpType || 'monthly-payment',
    };
  }
  _gst.loaded = false;   // force a refresh of periods on next visit
}

/* ── page render ──────────────────────────────────────────────────────────── */
async function renderGstPage(){
  const setupWrap = document.getElementById('gstSetupWrap');
  const periodWrap = document.getElementById('gstPeriodWrap');
  const tabsWrap = document.getElementById('gstTabsWrap');

  if (!_gst.loaded){
    await Promise.all([gstLoadSetup(), gstLoadPeriods()]);
    _gst.loaded = true;
  }

  renderGstSetup();
  renderGstPeriods();

  if (!_gst.period){
    tabsWrap.style.display = 'none';
    return;
  }
  tabsWrap.style.display = '';
  renderGstTabs();
  await gstLoadReturn();
}

/* ── setup / config ───────────────────────────────────────────────────────── */
async function gstLoadSetup(){
  // Config first: the setup form's state dropdown is built from it, so rendering
  // before this resolves produced an empty "Select…" list.
  if (!window.__gstStates){
    try {
      const cfgRes = await _api('/gst/config');
      window.__gstStates = (cfgRes && cfgRes.states) || {};
      _gstStateList = null;
    } catch(e){ /* the dropdown falls back to just the saved code */ }
  }
  try {
    const res = await fetch(API_BASE + '/auth/verify', { headers: _authHeaders() });
    const data = await res.json();
    const u = (data && data.user) || {};
    _gst.setup = {
      gstin: u.gstin || '',
      legalName: u.legalName || '',
      tradeName: u.tradeName || '',
      pan: u.pan || '',
      stateCode: u.stateCode || '',
      constitution: u.constitution || 'proprietorship',
      filingFrequency: u.filingFrequency || 'monthly',
      qrmpType: u.qrmpType || 'monthly-payment',
    };
  } catch(e){
    _gst.error = 'Could not load business details';
  }
}

// The state list comes from /gst/config (which serves gst/config.js STATE_CODES).
// It used to be a hand-copied array here and had already drifted out of date —
// 25 Daman and Diu and 96 Other Country were missing, so those could not be picked.
let _gstStateList = null;
function gstStateList(){
  if (_gstStateList) return _gstStateList;
  const states = (_gst.config && _gst.config.states) || window.__gstStates || {};
  _gstStateList = Object.entries(states).map(([code, name]) => [code, name]);
  return _gstStateList;
}

function renderGstSetup(){
  const el = document.getElementById('gstSetupWrap');
  if (!el) return;
  const s = _gst.setup || {};
  const missing = [];
  if (!s.gstin) missing.push('business GSTIN');
  if (!s.stateCode) missing.push('state code / place of supply');

  el.innerHTML = `
    ${missing.length ? `<div class="gst-alert gst-alert-blocker">
        <strong>Setup required.</strong> Add your ${gstEscape(missing.join(' and '))} before generating a return.
        Without a GSTIN, B2B classification and the portal JSON cannot be produced.
      </div>` : `<div class="gst-alert gst-alert-ok"><strong>Ready.</strong> Business GSTIN and place of supply are set.</div>`}

    <div class="gst-grid">
      <div class="form-group"><label>Business GSTIN</label>
        <input id="gstIn" value="${gstEscape(s.gstin)}" placeholder="27AAPFU0939F1ZV" maxlength="15"
               style="text-transform:uppercase;" oninput="gstValidateGstinField('gstIn')"></div>
      <div class="form-group"><label>PAN</label>
        <input id="gstPan" value="${gstEscape(s.pan)}" placeholder="AAPFU0939F" maxlength="10"
               style="text-transform:uppercase;"></div>
      <div class="form-group"><label>Legal name</label>
        <input id="gstLegalName" value="${gstEscape(s.legalName)}" placeholder="As on the GST registration"></div>
      <div class="form-group"><label>Trade name</label>
        <input id="gstTradeName" value="${gstEscape(s.tradeName)}" placeholder="Shop name"></div>
      <div class="form-group"><label>Place of supply (state code)</label>
        <select id="gstStateCode">
          <option value="">Select…</option>
          ${gstStateList().map(([c,n]) => `<option value="${c}"${s.stateCode===c?' selected':''}>${c} — ${n}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Constitution</label>
        <select id="gstConstitution">
          ${['proprietorship','partnership','llp','company','hni','trust','society','government']
            .map((v) => `<option value="${v}"${s.constitution===v?' selected':''}>${v}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Filing frequency</label>
        <select id="gstFrequency">
          <option value="monthly"${s.filingFrequency==='monthly'?' selected':''}>Monthly</option>
          <option value="qrmp"${s.filingFrequency==='qrmp'?' selected':''}>QRMP (quarterly)</option>
        </select></div>
      <div class="form-group"><label>QRMP type</label>
        <select id="gstQrmpType">
          <option value="monthly-payment"${s.qrmpType==='monthly-payment'?' selected':''}>Monthly payment (M-Q) + IFF for B2B in months 1–2</option>
          <option value="quarterly"${s.qrmpType==='quarterly'?' selected':''}>Quarterly payment (QRMP)</option>
        </select></div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="gstSaveBusiness()">Save business details</button>
      <button class="btn btn-ghost" onclick="openGstConfigModal()">Advanced config (rates, thresholds, due dates)</button>
      <span id="gstSetupMsg" style="font-size:12px;color:var(--muted);"></span>
    </div>
    <div class="gst-note">
      <strong>Verify before filing.</strong> Rates, thresholds, due dates and the JSON schema version are configurable —
      check them against the latest CBIC/GSTN notification. JSON schema in use:
      <code>${gstEscape((_gst.data && _gst.data.schemaVersion) || 'gstr1-offline-1.4')}</code>
    </div>`;
}

function gstValidateGstinField(id){
  const el = document.getElementById(id);
  if (!el) return;
  const v = String(el.value || '').trim().toUpperCase();
  el.classList.remove('gst-ok', 'gst-bad');
  if (!v) return;
  const ok = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v);
  el.classList.add(ok ? 'gst-ok' : 'gst-bad');
  el.title = ok ? 'Format looks valid' : 'Does not match the GSTIN format';
}

async function gstSaveBusiness(){
  const msg = document.getElementById('gstSetupMsg');
  msg.textContent = 'Saving…'; msg.style.color = 'var(--muted)';
  try {
    await _api('/gst/business', {
      method: 'POST',
      body: JSON.stringify({
        gstin: document.getElementById('gstIn').value.trim().toUpperCase(),
        pan: document.getElementById('gstPan').value.trim().toUpperCase(),
        legalName: document.getElementById('gstLegalName').value.trim(),
        tradeName: document.getElementById('gstTradeName').value.trim(),
        stateCode: document.getElementById('gstStateCode').value,
        constitution: document.getElementById('gstConstitution').value,
        filingFrequency: document.getElementById('gstFrequency').value,
        qrmpType: document.getElementById('gstQrmpType').value,
      }),
    });
    msg.textContent = '✓ Saved'; msg.style.color = 'var(--green)';
    await gstLoadSetup();
    renderGstSetup();
    if (_gst.period) await gstLoadReturn();
  } catch(e){
    msg.textContent = '✗ ' + e.message; msg.style.color = 'var(--red)';
  }
}

function openGstConfigModal(){
  const cfg = (_gst.data && _gst.data.config) || {};
  const th = cfg.thresholds || {};
  const due = cfg.dueDates || {};
  const recon = cfg.reconciliation || {};
  openModal('gstConfigModal');
  document.getElementById('gstCfgThreshold').value = th.b2cLargeInvoiceValue != null ? th.b2cLargeInvoiceValue : 100000;
  document.getElementById('gstCfgTolerance').value = recon.toleranceRupees != null ? recon.toleranceRupees : 1;
  document.getElementById('gstCfgGstr1').value = due.gstr1Monthly != null ? due.gstr1Monthly : 11;
  document.getElementById('gstCfgGstr3b').value = due.gstr3bMonthly != null ? due.gstr3bMonthly : 20;
  document.getElementById('gstCfgRates').value = (cfg.rates || [0,0.25,1,1.5,3,5,6,7.5,12,18,28]).join(',');
  document.getElementById('gstCfgSchema').value = cfg.schemaVersion || 'gstr1-offline-1.4';
  document.getElementById('gstCfgEnforceChecksum').checked = !!(cfg.gstin && cfg.gstin.checksum && cfg.gstin.checksum.enforced);
}

async function gstSaveConfig(){
  const msg = document.getElementById('gstCfgMsg');
  msg.textContent = 'Saving…';
  try {
    const rates = String(document.getElementById('gstCfgRates').value || '')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    await _api('/gst/config', {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: document.getElementById('gstCfgSchema').value.trim(),
        rates,
        thresholds: { b2cLargeInvoiceValue: Number(document.getElementById('gstCfgThreshold').value) || 0 },
        dueDates: {
          gstr1Monthly: Number(document.getElementById('gstCfgGstr1').value) || 11,
          gstr3bMonthly: Number(document.getElementById('gstCfgGstr3b').value) || 20,
        },
        reconciliation: { toleranceRupees: Number(document.getElementById('gstCfgTolerance').value) || 0 },
        gstin: { checksum: { enforced: document.getElementById('gstCfgEnforceChecksum').checked } },
      }),
    });
    msg.textContent = '✓ Saved — reload the period to recompute';
    if (_gst.period) await gstLoadReturn();
  } catch(e){
    msg.textContent = '✗ ' + e.message;
  }
}

/* ── periods ──────────────────────────────────────────────────────────────── */
async function gstLoadPeriods(){
  try {
    const res = await _api('/gst/periods');
    _gst.periods = res;
    const first = (res.periods && res.periods[0] && res.periods[0].period) || null;
    if (!_gst.period){
      const d = new Date();
      const cur = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      _gst.period = (res.availablePeriods || []).includes(cur)
        ? cur
        : (first || (res.availablePeriods || [])[0] || '');
    }
  } catch(e){
    _gst.periods = { periods: [], availablePeriods: [], lockedPeriods: [], dueDates: {} };
    _gst.error = e.message;
  }
}

function renderGstPeriods(){
  const el = document.getElementById('gstPeriodWrap');
  if (!el) return;
  const p = _gst.periods || { periods: [], availablePeriods: [], lockedPeriods: [], dueDates: {} };
  const byPeriod = {};
  (p.periods || []).forEach((x) => { byPeriod[x.period] = x; });
  const all = Array.from(new Set([...(p.availablePeriods||[]), ...Object.keys(byPeriod)])).sort().reverse();

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const label = (per) => {
    const m = /^(\d{4})-(\d{2})$/.exec(per);
    return m ? `${MONTHS[Number(m[2])-1]} ${m[1]}` : per;
  };

  const dd = (p.dueDates || {})[_gst.period] || {};
  const locked = (p.lockedPeriods || []).includes(_gst.period);
  const rec = byPeriod[_gst.period];
  const st = rec ? rec.status : 'draft';

  el.innerHTML = `
    <div class="gst-period-row">
      <select id="gstPeriodSel" onchange="gstSelectPeriod(this.value)">
        ${all.map((per) => `<option value="${per}"${per===_gst.period?' selected':''}>${label(per)}</option>`).join('')}
      </select>
      <span class="gst-badge gst-badge-${gstEscape(st)}">${gstEscape(st.toUpperCase())}</span>
      ${locked ? '<span class="gst-badge gst-badge-locked">🔒 Locked</span>' : ''}
    </div>
    <div class="gst-due-row">
      <span>Due dates</span>
      <span>GSTR-1 <strong>${dd.gstr1 ? label(dd.gstr1) : '—'}</strong></span>
      <span>GSTR-3B <strong>${dd.gstr3b ? label(dd.gstr3b) : '—'}</strong></span>
      <span>GSTR-2B <strong>${dd.gstr2 ? label(dd.gstr2) : '—'}</strong></span>
      ${(_gst.data && _gst.data.requiresIFF) ? '<span class="gst-note-inline">IFF applies (B2B furnish for months 1–2)</span>' : ''}
    </div>`;
}

function gstSelectPeriod(per){
  _gst.period = per;
  renderGstPeriods();
  gstLoadReturn();
}

const GST_TABS = [
  ['overview','📊 Overview'],
  ['validate','✅ Validation'],
  ['gstr1','📄 GSTR-1'],
  ['gstr3b','🧮 GSTR-3B'],
  ['recon','🔗 2B Recon'],
  ['books','⚖️ Books vs Return'],
  ['file','🔒 Filing'],
];

function renderGstTabs(){
  const t = document.getElementById('gstTabs');
  if (!t) return;
  const v = _gst.data && _gst.data.validation;
  const bCount = v ? v.counts.blockers : 0;
  t.innerHTML = GST_TABS.map(([k, label]) => `
    <div class="gst-tab${k===_gst.tab?' active':''}" data-tab="${k}" onclick="gstTab('${k}')">
      ${label}${k==='validate' && bCount ? `<span class="gst-tab-badge${bCount?' bad':''}">${bCount}</span>` : ''}
    </div>`).join('');
  document.querySelectorAll('.gst-tabpanel').forEach((p) => {
    p.style.display = p.dataset.tab === _gst.tab ? '' : 'none';
  });
}

/* ── fetch the return ─────────────────────────────────────────────────────── */
async function gstLoadReturn(){
  if (!_gst.period) return;
  _gst.loading = true;
  try {
    _gst.data = await _api('/gst/return/' + _gst.period);
    _gst.error = '';
  } catch(e){
    _gst.data = null;
    _gst.error = e.message;
  }
  _gst.loading = false;
  renderGstTabs();
  renderGstPanels();
  renderGstPeriods();
}

function renderGstPanels(){
  const d = _gst.data;
  if (_gst.error){
    document.getElementById('gstTabOverview').innerHTML =
      `<div class="gst-alert gst-alert-blocker">${gstEscape(_gst.error)}</div>`;
    return;
  }
  if (!d){
    document.getElementById('gstTabOverview').innerHTML = '<div class="empty-inline">No data loaded.</div>';
    return;
  }
  renderGstOverview();
  renderGstValidate();
  renderGstGstr1();
  renderGstGstr3b();
  renderGstRecon();
  renderGstBooks();
  renderGstFiling();
}

/* ── overview ─────────────────────────────────────────────────────────────── */
function renderGstOverview(){
  const el = document.getElementById('gstTabOverview');
  const d = _gst.data;
  if (!el || !d) return;
  const v = d.validation, g = d.gstr1, b = d.gstr3b, t = d.turnover;

  const stat = (label, value, sub, tone) => `
    <div class="stat-card ${tone || ''}">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div>
    </div>`;

  el.innerHTML = `
    <div class="stats-row">
      ${stat('Taxable value', gstRs(g.totals.taxablePaise), `${g.counts.documents} documents`, 'accent')}
      ${stat('Tax payable', gstRs(g.totals.cgstPaise + g.totals.sgstPaise + g.totals.igstPaise + g.totals.cessPaise),
        `C ${gstRs(g.totals.cgstPaise)} · S ${gstRs(g.totals.sgstPaise)} · I ${gstRs(g.totals.igstPaise)}`, 'red')}
      ${stat('ITC claimable', gstRs(b.table4.netAvailable), 'eligible − reversed − ineligible', 'green')}
      ${stat('Net payable', gstRs(b.setOff.payable.igst + b.setOff.payable.cgst + b.setOff.payable.sgst),
        'after set-off', 'yellow')}
    </div>

    <div class="gst-grid2">
      <div class="card">
        <div class="card-title">📄 Table summary (GSTR-1)</div>
        <table class="gst-table">
          <tbody>
            ${[['B2B (registered)', g.b2b.length, g.b2b.reduce((a,r)=>a+r.totalTaxablePaise,0)],
               ['B2C Large', g.b2cl.length, g.b2cl.reduce((a,r)=>a+r.totalTaxablePaise,0)],
               ['B2C Small', g.b2cs.length, g.b2cs.reduce((a,r)=>a+r.taxablePaise,0)],
               ['Exports', g.exp.length, g.exp.reduce((a,r)=>a+r.taxablePaise,0)],
               ['SEZ', g.sez.length, g.sez.reduce((a,r)=>a+r.taxablePaise,0)],
               ['Credit/Debit Notes (CDNR)', g.cdnr.length, g.cdnr.reduce((a,r)=>a+r.totalTaxablePaise,0)],
               ['Credit/Debit Notes (CDNUR)', g.cdnur.length, g.cdnur.reduce((a,r)=>a+r.totalTaxablePaise,0)],
               ['Nil / Exempt / Non-GST', g.nil_exempt.length, g.nil_exempt.reduce((a,r)=>a+r.taxablePaise,0)]
              ].map(([n,cnt,val]) => `<tr><td>${n}</td><td class="r">${cnt}</td><td class="r">${gstRs(val)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">📈 Financial-year turnover (${gstEscape(t.financialYear || '')})</div>
        <table class="gst-table">
          <tbody>
            <tr><td>Taxable supplies</td><td class="r">${gstRs(t.taxablePaise)}</td></tr>
            <tr><td>Exempt / nil / non-GST</td><td class="r">${gstRs(t.exemptPaise)}</td></tr>
            <tr><td>Exports</td><td class="r">${gstRs(t.exportPaise)}</td></tr>
            <tr><td><strong>Aggregate turnover</strong></td><td class="r"><strong>${gstRs(t.totalPaise)}</strong></td></tr>
            <tr><td>HSN digits required</td><td class="r">${t.requiredHsnDigits}</td></tr>
            <tr><td>E-invoice applicable</td><td class="r">${t.eInvoiceApplicable ? 'Yes' : 'No'}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">🔍 Cross-checks</div>
      ${b.tieOut.checked ? `
        <div class="gst-alert ${b.tieOut.balanced ? 'gst-alert-ok' : 'gst-alert-blocker'}">
          GSTR-1 ↔ GSTR-3B taxable:
          ${gstRs(b.tieOut.diffTaxablePaise === 0 ? 0 : 0)} difference
          ${gstRs(b.tieOut.diffTaxablePaise)} ·
          IGST difference ${gstRs(b.tieOut.diffIgstPaise)}
          ${b.tieOut.balanced ? '✓ balanced' : '✗ investigate before filing'}
        </div>` : ''}
      <div class="gst-alert ${d.booksVsReturn.balanced ? 'gst-alert-ok' : 'gst-alert-warn'}">
        Books vs GSTR-1 taxable difference: ${gstRs(d.booksVsReturn.differences.booksVsGstr1TaxablePaise)}
      </div>
      <div class="gst-alert ${v.counts.blockers ? 'gst-alert-blocker' : 'gst-alert-ok'}">
        Pre-filing validation: ${v.counts.blockers} blocker(s), ${v.counts.warnings} warning(s)
        ${v.canExport ? '· export allowed' : '· export blocked'}
      </div>
    </div>`;
}

/* ── validation ───────────────────────────────────────────────────────────── */
function renderGstValidate(){
  const el = document.getElementById('gstTabValidate');
  const d = _gst.data;
  if (!el || !d) return;
  const v = d.validation;

  const rows = (list) => list.map((i) => `
    <tr class="${i.severity === 'BLOCKER' ? 'row-blocker' : 'row-warn'}">
      <td><span class="gst-badge gst-badge-${i.severity === 'BLOCKER' ? 'blocker' : 'warning'}">${i.severity}</span></td>
      <td><code>${gstEscape(i.code)}</code></td>
      <td>${i.invoiceNo ? `<strong>${gstEscape(i.invoiceNo)}</strong><br><span style="font-size:11px;color:var(--muted);">${gstEscape(i.customer || '')}</span>` : '—'}</td>
      <td>${gstEscape(i.message)}</td>
      <td style="font-size:11px;color:var(--muted);">${gstEscape(i.fix || '')}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="gst-alert ${v.canExport ? 'gst-alert-ok' : 'gst-alert-blocker'}">
      ${v.canExport
        ? `✓ No blockers — you may export. ${v.counts.warnings} warning(s) can be confirmed and ignored.`
        : `✗ ${v.counts.blockers} blocker(s) must be fixed before export.`}
    </div>
    ${v.counts.blockers ? `<div class="card"><div class="card-title">🚫 Blockers</div>
      <table class="gst-table"><thead><tr><th>Severity</th><th>Code</th><th>Document</th><th>Issue</th><th>How to fix</th></tr></thead>
      <tbody>${rows(v.blockers)}</tbody></table></div>` : ''}
    ${v.counts.warnings ? `<div class="card"><div class="card-title">⚠️ Warnings</div>
      <table class="gst-table"><thead><tr><th>Severity</th><th>Code</th><th>Document</th><th>Issue</th><th>How to fix</th></tr></thead>
      <tbody>${rows(v.warnings)}</tbody></table></div>` : ''}
    ${!v.counts.total ? '<div class="empty-inline">No issues found.</div>' : ''}`;
}

/* ── GSTR-1 ───────────────────────────────────────────────────────────────── */
function gstRateRows(b){
  return (b || []).map((r) => `<tr>
    <td>${gstEscape(String(r.rate))}%</td>
    <td class="r">${gstRs(r.taxablePaise)}</td>
    <td class="r">${gstRs(r.cgstPaise)}</td>
    <td class="r">${gstRs(r.sgstPaise)}</td>
    <td class="r">${gstRs(r.igstPaise)}</td>
  </tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted);">—</td></tr>';
}

function renderGstGstr1(){
  const el = document.getElementById('gstTabGstr1');
  const d = _gst.data;
  if (!el || !d) return;
  const g = d.gstr1;
  const v = d.validation;
  const hdr = `<tr><th>Rate</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">IGST</th></tr>`;

  const b2b = g.b2b.map((r) => `
    <tr class="gst-doc-row"><td colspan="5">
      <strong>${gstEscape(r.gstin)}</strong> · ${gstEscape(r.counterpartyName || '')} ·
      ${gstEscape(r.invoiceNumber)} · ${gstEscape(r.invoiceDate)} · ${gstRs(r.invoiceValuePaise)}
      <table class="gst-table gst-table-nested"><thead>${hdr}</thead><tbody>${gstRateRows(r.rateBreakup)}</tbody></table>
    </td></tr>`).join('') || '<tr><td style="color:var(--muted);">No B2B invoices</td></tr>';

  const b2cl = g.b2cl.map((r) => `
    <tr class="gst-doc-row"><td colspan="5">
      POS ${gstEscape(r.placeOfSupply)} · ${gstEscape(r.invoiceNumber)} · ${gstEscape(r.invoiceDate)} · ${gstRs(r.invoiceValuePaise)}
      <table class="gst-table gst-table-nested"><thead>${hdr}</thead><tbody>${gstRateRows(r.rateBreakup)}</tbody></table>
    </td></tr>`).join('') || '<tr><td style="color:var(--muted);">No B2C Large invoices</td></tr>';

  const b2cs = g.b2cs.map((r) => `<tr>
    <td>${gstEscape(r.placeOfSupply)}${r.stateName ? ' — '+gstEscape(r.stateName) : ''}</td>
    <td>${gstEscape(String(r.rate))}%</td>
    <td class="r">${r.invoiceCount}</td>
    <td class="r">${gstRs(r.taxablePaise)}</td>
    <td class="r">${gstRs(r.cgstPaise)}</td>
    <td class="r">${gstRs(r.sgstPaise)}</td>
    <td class="r">${gstRs(r.igstPaise)}</td>
  </tr>`).join('') || '<tr><td colspan="7" style="color:var(--muted);">No B2C Small supplies</td></tr>';

  const nilEx = g.nil_exempt.map((r) => `<tr>
    <td>${gstEscape(String(r.supplyType).toUpperCase())}</td>
    <td>${r.interState ? 'Inter-state' : 'Intra-state'}</td>
    <td>${gstEscape(r.recipientType)}</td>
    <td>${gstEscape(r.placeOfSupply || '')}</td>
    <td class="r">${gstRs(r.taxablePaise)}</td>
    <td style="font-size:11px;color:var(--muted);">${gstEscape((r.invoiceNos||[]).slice(0,6).join(', '))}</td>
  </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted);">No nil / exempt / non-GST supplies</td></tr>';

  const hsn = Object.values(g.hsn.byHsn || {}).map((h) => {
    const rows = (h.rows || []).map((r) => `
      <tr>
        <td>${gstEscape(r.hsnSac)}</td>
        <td>${gstEscape(r.description || '')}</td>
        <td>${gstEscape(r.uqc || '')}</td>
        <td class="r">${gstQty(r.qtyTotal)}</td>
        <td>${gstEscape(String(r.rate))}%</td>
        <td class="r">${gstRs(r.taxablePaise)}</td>
        <td class="r">${gstRs(r.cgstPaise + r.sgstPaise + r.igstPaise)}</td>
        <td class="r">${gstRs(r.b2bTaxablePaise)}</td>
        <td class="r">${gstRs(r.b2cTaxablePaise)}</td>
      </tr>`).join('');
    return rows;
  }).join('');

  const docs = g.docs_issued.map((s) => `<tr>
    <td>${gstEscape(s.docTypeLabel)}</td>
    <td>${gstEscape(s.fromNumber)} → ${gstEscape(s.toNumber)}</td>
    <td class="r">${s.totalIssued}</td>
    <td class="r">${s.totalCancelled}</td>
    <td style="font-size:11px;color:var(--muted);">${gstEscape((s.cancelledNumbers||[]).join(', '))}</td>
    <td class="r">${gstRs(s.netTaxablePaise)}</td>
  </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted);">No documents issued</td></tr>';

  el.innerHTML = `
    <div class="gst-export-bar">
      <button class="btn btn-primary" onclick="gstExportExcel()"${v.canExport ? '' : ' disabled title="Fix blockers first"'}>⬇️ Export Excel (one sheet per table)</button>
      <button class="btn ${v.canExport ? 'btn-primary' : 'btn-ghost'}" onclick="gstExportJSON()"${v.canExport ? '' : ' disabled title="Fix blockers first"'}>⬇️ Export portal JSON</button>
      <span class="gst-schema-line">
        schema <code>${gstEscape(d.schemaVersion)}</code>
        ${d.schemaCheck ? (d.schemaCheck.ok ? '<span class="gst-badge gst-badge-ok">valid</span>' : '<span class="gst-badge gst-badge-blocker">schema errors</span>') : ''}
      </span>
      ${!v.canExport ? '<span class="gst-badge gst-badge-blocker">export blocked — fix blockers in Validation</span>' : ''}
    </div>

    ${d.schemaCheck && !d.schemaCheck.ok ? `<div class="gst-alert gst-alert-blocker">
      <strong>JSON schema validation failed.</strong>
      <ul>${(d.schemaCheck.errors||[]).map((e)=>`<li>${gstEscape(e)}</li>`).join('')}</ul>
    </div>` : ''}

    <div class="card"><div class="card-title">B2B — registered recipients (invoice-wise)</div>
      <table class="gst-table"><tbody>${b2b}</tbody></table></div>

    <div class="card"><div class="card-title">B2C Large — unregistered, inter-state, above threshold</div>
      <table class="gst-table"><tbody>${b2cl}</tbody></table></div>

    <div class="card"><div class="card-title">B2C Small — state-wise &amp; rate-wise</div>
      <table class="gst-table">
        <thead><tr><th>Place of supply</th><th>Rate</th><th class="r">Invoices</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">IGST</th></tr></thead>
        <tbody>${b2cs}</tbody></table></div>

    <div class="card"><div class="card-title">Nil / Exempt / Non-GST supplies (Core Rule 2 — never omitted)</div>
      <table class="gst-table">
        <thead><tr><th>Type</th><th>Supply</th><th>Recipient</th><th>POS</th><th class="r">Taxable</th><th>Documents</th></tr></thead>
        <tbody>${nilEx}</tbody></table></div>

    <div class="card"><div class="card-title">Credit / Debit Notes</div>
      <table class="gst-table">
        <thead><tr><th>Type</th><th>GSTIN</th><th>Note no.</th><th>Original invoice</th><th class="r">Taxable</th><th class="r">Tax</th></tr></thead>
        <tbody>
          ${g.cdnr.concat(g.cdnur).map((r) => `<tr>
            <td>${r.noteType === 'C' ? 'Credit' : 'Debit'}</td>
            <td>${gstEscape(r.gstin || '—')}</td>
            <td>${gstEscape(r.noteNumber)}</td>
            <td>${gstEscape(r.originalInvoiceNumber || '—')}</td>
            <td class="r">${gstRs(r.totalTaxablePaise)}</td>
            <td class="r">${gstRs(r.totalCgstPaise + r.totalSgstPaise + r.totalIgstPaise)}</td>
          </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted);">No credit / debit notes</td></tr>'}
        </tbody></table></div>

    <div class="card"><div class="card-title">HSN / SAC summary</div>
      <table class="gst-table">
        <thead><tr><th>HSN</th><th>Description</th><th>UQC</th><th class="r">Qty</th><th>Rate</th><th class="r">Taxable</th><th class="r">Tax</th><th class="r">B2B</th><th class="r">B2C</th></tr></thead>
        <tbody>${hsn || '<tr><td colspan="9" style="color:var(--muted);">No HSN data</td></tr>'}</tbody></table></div>

    <div class="card"><div class="card-title">Documents issued &amp; cancelled</div>
      <table class="gst-table">
        <thead><tr><th>Document type</th><th>From → To</th><th class="r">Issued</th><th class="r">Cancelled</th><th>Cancelled numbers</th><th class="r">Taxable</th></tr></thead>
        <tbody>${docs}</tbody></table></div>

    ${g.amendments && g.amendments.length ? `<div class="card"><div class="card-title">Amendments</div>
      <table class="gst-table">
        <thead><tr><th>Invoice</th><th>Date</th><th>Original period</th><th>Original invoice</th><th>Reason</th></tr></thead>
        <tbody>${g.amendments.map((a) => `<tr>
          <td>${gstEscape(a.invoiceNumber)}</td><td>${gstEscape(a.invoiceDate)}</td>
          <td>${gstEscape(a.originalPeriod)}</td><td>${gstEscape(a.originalInvoiceNumber)}</td>
          <td>${gstEscape(a.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

/* ── GSTR-3B ──────────────────────────────────────────────────────────────── */
function renderGstGstr3b(){
  const el = document.getElementById('gstTabGstr3b');
  const d = _gst.data;
  if (!el || !d) return;
  const b = d.gstr3b;
  const R = (t) => `<tr><td>${t.label}</td><td class="r">${gstRs(t.taxablePaise)}</td><td class="r">${gstRs(t.igstPaise)}</td><td class="r">${gstRs(t.cgstPaise)}</td><td class="r">${gstRs(t.sgstPaise)}</td></tr>`;

  el.innerHTML = `
    <div class="card"><div class="card-title">3.1 Outward supplies</div>
      <table class="gst-table">
        <thead><tr><th>Table</th><th class="r">Taxable value</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th></tr></thead>
        <tbody>
          ${R({label:'3.1(a) Taxable supplies (other than nil/exempt/zero-rated)', ...b.t31.a_taxable})}
          ${R({label:'3.1(b) Zero-rated supplies', ...b.t31.b_zero_rated})}
          ${R({label:'3.1(c) Nil / exempt supplies', ...b.t31.c_nil_exempt})}
          ${R({label:'3.1(d) Inward supplies on reverse charge', ...b.t31.d_reverse_charge})}
          ${R({label:'3.1(e) Non-GST outward supplies', ...b.t31.e_non_gst})}
          ${R({label:'3.2 Inter-state supplies to unregistered / composition / UIN', ...b.t32})}
        </tbody></table></div>

    <div class="card"><div class="card-title">Table 4 — Input tax credit</div>
      <table class="gst-table">
        <tbody>
          <tr><td>4(A)(1)(a) Import of goods</td><td class="r">${gstRs(b.table4.eligible.importGoods)}</td></tr>
          <tr><td>4(A)(1)(b) Import of services</td><td class="r">${gstRs(b.table4.eligible.importServices)}</td></tr>
          <tr><td>4(A)(5) Inward supplies (reverse charge)</td><td class="r">${gstRs(b.table4.eligible.rcm)}</td></tr>
          <tr><td>4(A)(6) Credit received from ISD</td><td class="r">${gstRs(b.table4.eligible.isd)}</td></tr>
          <tr><td>4(A)(7) All other ITC</td><td class="r">${gstRs(b.table4.eligible.others)}</td></tr>
          <tr><td><strong>Total eligible ITC</strong></td><td class="r"><strong>${gstRs(b.table4.totalEligible)}</strong></td></tr>
          <tr><td>4(B) ITC reversed</td><td class="r">${gstRs(b.table4.reversed)}</td></tr>
          <tr><td>4(C) Ineligible ITC (Sec 17(5))</td><td class="r">${gstRs(b.table4.ineligible)}</td></tr>
          <tr class="gst-total"><td><strong>Net ITC available</strong></td><td class="r"><strong>${gstRs(b.table4.netAvailable)}</strong></td></tr>
        </tbody></table>
      <div class="gst-note" style="margin-top:10px;">
        Only credit from entries you matched or accepted in <strong>2B Recon</strong> is included here.
      </div></div>

    <div class="card"><div class="card-title">Liability &amp; set-off</div>
      <table class="gst-table">
        <thead><tr><th>Head</th><th class="r">Tax payable</th><th class="r">ITC applied</th><th class="r">Cash / credit used</th><th class="r">Net payable</th></tr></thead>
        <tbody>
          ${['igst','cgst','sgst','cess'].map((h) => `<tr>
            <td>${h.toUpperCase()}</td>
            <td class="r">${gstRs(b.liability[h])}</td>
            <td class="r">${gstRs(b.setOff.consumed[h])}</td>
            <td class="r">${h === 'igst' ? gstRs(b.setOff.cashUsed ? b.setOff.cashUsed.igst : 0) : '—'}</td>
            <td class="r"><strong>${gstRs(b.setOff.payable[h])}</strong></td>
          </tr>`).join('')}
        </tbody></table>
      ${b.setOff.steps.length ? `<div class="card-title" style="margin-top:14px;font-size:12px;">Set-off steps applied</div>
        <table class="gst-table"><tbody>${b.setOff.steps.map((s) => `<tr>
          <td>${gstEscape(s.creditHead.toUpperCase())} credit → ${gstEscape(s.againstHead.toUpperCase())} liability</td>
          <td class="r">${gstRs(s.amountPaise)}</td></tr>`).join('')}
          ${Object.entries(b.setOff.remainingCredit).filter(([,v]) => Number(v) > 0).map(([h,v]) => `<tr>
            <td>${gstEscape(h.toUpperCase())} credit carried forward</td><td class="r">${gstRs(v)}</td></tr>`).join('')}
        </tbody></table>` : ''}
    </div>

    <div class="card"><div class="card-title">Manual inputs (interest, fees, ledger balances)</div>
      <div class="gst-grid">
        <div class="form-group"><label>Interest (₹)</label><input id="gst3bInterest" type="number" step="0.01" min="0"
          value="${((Number(b.additions.interest)||0)/100).toFixed(2)}"></div>
        <div class="form-group"><label>Late fee (₹)</label><input id="gst3bLateFee" type="number" step="0.01" min="0"
          value="${((Number(b.additions.lateFee)||0)/100).toFixed(2)}"></div>
        <div class="form-group"><label>Cash ledger balance (₹)</label><input id="gst3bCash" type="number" step="0.01" min="0"
          value="${gstRs(Number(b.setOff.cashUsed ? b.setOff.cashUsed.igst : 0))}"></div>
        <div class="form-group"><label>Credit ledger balance (₹)</label><input id="gst3bCredit" type="number" step="0.01" min="0"
          value="${gstRs(Number(b.additions.credit || 0))}"></div>
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="gstSaveManual3B()">Save manual inputs</button>
      <span id="gst3bMsg" style="font-size:12px;color:var(--muted);margin-left:10px;"></span>
    </div>`;
}

async function gstSaveManual3B(){
  const msg = document.getElementById('gst3bMsg');
  msg.textContent = 'Saving…';
  try {
    await _api('/gst/status/' + _gst.period, {
      method: 'POST',
      body: JSON.stringify({
        status: (_gst.data && _gst.data.status) || 'draft',
        arn: (_gst.data && _gst.data.arn) || '',
        manualInput: {
          interest: Number(document.getElementById('gst3bInterest').value || 0),
          lateFee: Number(document.getElementById('gst3bLateFee').value || 0),
          cashBalance: Number(document.getElementById('gst3bCash').value || 0),
          creditBalance: Number(document.getElementById('gst3bCredit').value || 0),
        },
      }),
    });
    msg.textContent = '✓ Saved';
    await gstLoadReturn();
  } catch(e){
    msg.textContent = '✗ ' + e.message;
  }
}

/* ── 2B reconciliation ────────────────────────────────────────────────────── */
function renderGstRecon(){
  const el = document.getElementById('gstTabRecon');
  const d = _gst.data;
  if (!el || !d) return;
  const s = d.recon2b.summary;
  const res = d.recon2b.results || [];
  const st = (v) => {
    const e = document.getElementById('gstDecision_' + v);
    if (e) e.textContent = '✓';
  };

  el.innerHTML = `
    <div class="gst-export-bar">
      <button class="btn btn-primary" onclick="openModal('gst2bModal')">📤 Upload GSTR-2B</button>
      <span class="gst-schema-line">tolerance ±₹${Number(d.recon2b.toleranceRupees)||0}</span>
    </div>

    <div class="stats-row">
      <div class="stat-card green"><div class="stat-label">Matched</div><div class="stat-value">${s.matched + s.matchedWithTolerance}</div><div class="stat-sub">${s.matchedWithTolerance} within tolerance</div></div>
      <div class="stat-card yellow"><div class="stat-label">Value / tax mismatch</div><div class="stat-value">${s.valueMismatch}</div><div class="stat-sub">need a decision</div></div>
      <div class="stat-card red"><div class="stat-label">Missing in books</div><div class="stat-value">${s.missingInBooks}</div><div class="stat-sub">in 2B, not in your purchases</div></div>
      <div class="stat-card yellow"><div class="stat-label">Missing in 2B</div><div class="stat-value">${s.missingIn2B}</div><div class="stat-sub">in books, not in 2B</div></div>
      <div class="stat-card green"><div class="stat-label">ITC claimable</div><div class="stat-value">${gstRs(s.claimable)}</div><div class="stat-sub">matched or accepted</div></div>
      <div class="stat-card red"><div class="stat-label">ITC at risk</div><div class="stat-value">${gstRs(s.itcAtRisk)}</div><div class="stat-sub">rejected or pending</div></div>
    </div>

    <div class="card"><div class="card-title">Matching results</div>
      ${res.length ? `<table class="gst-table">
        <thead><tr><th>Bucket</th><th>Supplier GSTIN</th><th>Invoice</th><th>Date</th><th class="r">Taxable</th><th class="r">Diff taxable</th><th class="r">Diff tax</th><th class="r">ITC</th><th>Decision</th><th>Action</th></tr></thead>
        <tbody>${res.map((r) => {
          const src = r.row2b || r.row || {};
          // The tax difference is the sum of all four heads. Amounts reach the
          // browser as BigInt-serialised strings, so sum via Number, not "+".
          const diffTax = gstSum(r.diffIgstPaise, r.diffCgstPaise, r.diffSgstPaise, r.diffCessPaise);
          return `<tr>
            <td><span class="gst-badge gst-badge-${r.bucket === 'matched' ? 'ok' : (r.bucket === 'matched_tolerance' ? 'warning' : 'blocker')}">${gstEscape(r.bucket)}</span></td>
            <td>${gstEscape(src.gstin || '')}</td>
            <td>${gstEscape(src.invoiceNo || '')}</td>
            <td>${gstEscape(src.invoiceDate || '')}</td>
            <td class="r">${gstRs(src.taxablePaise)}</td>
            <td class="r">${gstRs(r.diffTaxablePaise)}</td>
            <td class="r">${gstRs(diffTax)}</td>
            <td class="r">${gstRs(r.itcPaise)}</td>
            <td><span class="gst-badge">${gstEscape(r.decision || 'pending')}</span></td>
            <td>
              <button class="btn btn-ghost btn-sm" onclick="gstDecide('${encodeURIComponent(r.key)}','accept')">Accept</button>
              <button class="btn btn-ghost btn-sm" onclick="gstDecide('${encodeURIComponent(r.key)}','reject')">Reject</button>
              <button class="btn btn-ghost btn-sm" onclick="gstDecide('${encodeURIComponent(r.key)}','pending')">Pending</button>
            </td>
          </tr>`;
        }).join('')}</tbody></table>`
        : '<div class="empty-inline">No GSTR-2B uploaded for this period yet.</div>'}
    </div>

    <div class="gst-note">
      Entries that are not a clean match default to <strong>pending</strong> and are <em>not</em> claimed.
      Accepting a mismatch is your responsibility — keep a note for the auditor.
    </div>`;
}

async function gstDecide(key, decision){
  try {
    await _api('/gst/recon2b/' + _gst.period + '/' + key, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    await gstLoadReturn();
  } catch(e){
    notify('Could not save the decision: ' + e.message, 'error');
  }
}

function gstUpload2B(){
  const msg = document.getElementById('gst2bMsg');
  msg.textContent = 'Reading file…';
  const done = async (text) => {
    try {
      const payload = JSON.parse(text);
      msg.textContent = 'Uploading…';
      const r = await _api('/gst/2b', {
        method: 'POST',
        body: JSON.stringify({ period: _gst.period, payload }),
      });
      msg.innerHTML = `✓ ${r.rows} row(s) read. Reconciling…`;
      closeModal('gst2bModal');
      await gstLoadReturn();
      gstTab('recon');
    } catch(e){
      msg.textContent = '✗ ' + e.message;
    }
  };
  const f = document.getElementById('gst2bFile').files[0];
  if (f){
    const rd = new FileReader();
    rd.onload = () => done(String(rd.result));
    rd.onerror = () => { msg.textContent = '✗ Could not read the file'; };
    rd.readAsText(f);
    return;
  }
  const pasted = document.getElementById('gst2bPaste').value.trim();
  if (!pasted){ msg.textContent = 'Choose a file or paste the JSON'; return; }
  done(pasted);
}

/* ── books vs return ──────────────────────────────────────────────────────── */
function renderGstBooks(){
  const el = document.getElementById('gstTabBooks');
  const d = _gst.data;
  if (!el || !d) return;
  const r = d.booksVsReturn;
  const diff = (v) => `<span style="color:${v === 0 || Number(v) === 0 ? 'var(--green)' : 'var(--red)'};font-weight:700;">${gstRs(v)}</span>`;

  el.innerHTML = `
    <div class="card"><div class="card-title">Books vs return</div>
      <table class="gst-table">
        <thead><tr><th>Source</th><th class="r">Taxable value</th><th class="r">Tax</th></tr></thead>
        <tbody>
          <tr><td>Books (sale documents in this period)</td><td class="r">${gstRs(r.books.taxablePaise)}</td><td class="r">${gstRs(r.books.taxPaise)}</td></tr>
          <tr><td>GSTR-1</td><td class="r">${gstRs(r.gstr1.taxablePaise)}</td><td class="r">${gstRs(r.gstr1.taxPaise)}</td></tr>
          <tr><td>GSTR-3B</td><td class="r">${gstRs(r.gstr3b.taxablePaise)}</td><td class="r">${gstRs(r.gstr3b.taxPaise)}</td></tr>
        </tbody></table>
      <div class="gst-grid2" style="margin-top:12px;">
        <div class="gst-alert ${Number(r.differences.booksVsGstr1TaxablePaise) === 0 ? 'gst-alert-ok' : 'gst-alert-blocker'}">
          Books − GSTR-1 taxable: ${diff(r.differences.booksVsGstr1TaxablePaise)}
        </div>
        <div class="gst-alert ${Number(r.differences.gstr1VsGstr3bTaxablePaise) === 0 ? 'gst-alert-ok' : 'gst-alert-blocker'}">
          GSTR-1 − GSTR-3B taxable: ${diff(r.differences.gstr1VsGstr3bTaxablePaise)}
        </div>
      </div>
      ${Number(r.differences.booksVsGstr1TaxablePaise) !== 0 ? `
        <div class="card-title" style="margin-top:14px;">Documents explaining the difference</div>
        <table class="gst-table">
          <thead><tr><th>Document</th><th>Reason</th><th class="r">Taxable</th></tr></thead>
          <tbody>
            ${[].concat(
              r.explanations.excludedDocs.map((x) => [x.invoiceNo, x.reason, x.taxablePaise]),
              r.explanations.cancelledDocs.map((x) => [x.invoiceNo, x.reason, x.taxablePaise]),
              r.explanations.draftDocs.map((x) => [x.invoiceNo, x.reason, x.taxablePaise]),
            ).map(([n, why, val]) => `<tr><td>${gstEscape(n)}</td><td>${gstEscape(why)}</td><td class="r">${gstRs(val)}</td></tr>`).join('')
              || '<tr><td colspan="3" style="color:var(--muted);">No explaining documents found</td></tr>'}
          </tbody></table>` : ''}
    </div>

    <div class="card"><div class="card-title">Annual aggregate turnover</div>
      <table class="gst-table"><tbody>
        <tr><td>Financial year</td><td class="r">${gstEscape(d.turnover.financialYear || '')}</td></tr>
        <tr><td>Taxable + exempt + exports</td><td class="r">${gstRs(d.turnover.totalPaise)}</td></tr>
        <tr><td>HSN digits required</td><td class="r">${d.turnover.requiredHsnDigits}</td></tr>
        <tr><td>E-invoice applicable</td><td class="r">${d.turnover.eInvoiceApplicable ? 'Yes' : 'No'}</td></tr>
      </tbody></table>
      <div class="gst-note" style="margin-top:10px;">
        E-invoice, HSN digit rules and QRMP eligibility all depend on this turnover.
        Thresholds live in the config, not in code.
      </div></div>`;
}

/* ── filing workflow ──────────────────────────────────────────────────────── */
const GST_FLOW = ['draft','validated','exported','filed','locked'];

function renderGstFiling(){
  const el = document.getElementById('gstTabFile');
  const d = _gst.data;
  if (!el || !d) return;
  const cur = d.status || 'draft';
  const idx = GST_FLOW.indexOf(cur);
  const next = GST_FLOW[idx + 1];

  const stepBtn = (label, target) => {
    const allowed = GST_FLOW.indexOf(target) === idx + 1;
    return `<button class="btn ${allowed ? 'btn-primary' : 'btn-ghost'}" ${allowed ? '' : 'disabled'}
      onclick="gstAdvanceStatus('${target}')">${label}</button>`;
  };

  el.innerHTML = `
    <div class="card"><div class="card-title">Workflow</div>
      <div class="gst-flow">
        ${GST_FLOW.map((s, i) => `<div class="gst-flow-step ${i <= idx ? 'done' : ''} ${s === cur ? 'current' : ''}">
          <div class="gst-flow-dot">${i <= idx ? '✓' : i + 1}</div>
          <div class="gst-flow-label">${s}</div>
        </div>`).join('<div class="gst-flow-line"></div>')}
      </div>
      <div class="gst-note" style="margin-top:12px;">
        Once a period is <strong>filed</strong> or <strong>locked</strong>, its documents cannot be edited.
        Corrections must be made with a credit / debit note or an amendment in a later period.
      </div>
    </div>

    <div class="card"><div class="card-title">Filing details</div>
      <div class="gst-grid">
        <div class="form-group"><label>ARN</label><input id="gstArn" value="${gstEscape(d.arn || '')}" placeholder="AA240326…"></div>
        <div class="form-group"><label>Filing date</label><input id="gstFilingDate" type="date" value="${gstEscape((d.filingDate||'').slice(0,10))}"></div>
      </div>
      <div class="form-group" style="margin-top:12px;"><label>Notes</label>
        <textarea id="gstPeriodNotes" rows="3" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);color:var(--text);">${gstEscape(d.notes || '')}</textarea></div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
        ${cur === 'draft' ? stepBtn('Mark validated', 'validated') : ''}
        ${cur === 'validated' ? stepBtn('Mark exported', 'exported') + `<button class="btn btn-ghost" onclick="gstAdvanceStatus('draft')">Back to draft</button>` : ''}
        ${cur === 'exported' ? stepBtn('Mark filed (enter ARN)', 'filed') : ''}
        ${cur === 'filed' ? stepBtn('Lock period', 'locked') : ''}
        ${cur === 'locked' ? '<span class="gst-badge gst-badge-locked">🔒 Locked — read only</span>' : ''}
      </div>
      <div id="gstFilingMsg" style="font-size:12px;color:var(--muted);margin-top:10px;"></div>
    </div>

    <div class="card"><div class="card-title">Due dates &amp; reminder</div>
      <table class="gst-table"><tbody>
        <tr><td>GSTR-1 due</td><td class="r">${gstEscape(d.dueDates.gstr1 || '—')}</td><td>${gstDueHint(d.dueDates.gstr1)}</td></tr>
        <tr><td>GSTR-3B due</td><td class="r">${gstEscape(d.dueDates.gstr3b || '—')}</td><td>${gstDueHint(d.dueDates.gstr3b)}</td></tr>
        <tr><td>GSTR-2B due</td><td class="r">${gstEscape(d.dueDates.gstr2 || '—')}</td><td>${gstDueHint(d.dueDates.gstr2)}</td></tr>
      </tbody></table>
      <div class="gst-note" style="margin-top:10px;">Due dates come from config — verify against the GST portal notification.</div>
    </div>`;
}

function gstDueHint(due){
  if (!due) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(due + 'T00:00:00');
  const days = Math.round((d - today) / 86400000);
  if (days < 0) return `<span class="gst-badge gst-badge-blocker">overdue by ${Math.abs(days)} day(s)</span>`;
  if (days === 0) return '<span class="gst-badge gst-badge-warning">due today</span>';
  if (days <= 7) return `<span class="gst-badge gst-badge-warning">in ${days} day(s)</span>`;
  return `<span style="color:var(--muted);font-size:11px;">in ${days} day(s)</span>`;
}

async function gstAdvanceStatus(target){
  const msg = document.getElementById('gstFilingMsg');
  msg.textContent = 'Saving…';
  try {
    await _api('/gst/status/' + _gst.period, {
      method: 'POST',
      body: JSON.stringify({
        status: target,
        arn: document.getElementById('gstArn').value.trim(),
        filingDate: document.getElementById('gstFilingDate').value || null,
        notes: document.getElementById('gstPeriodNotes').value,
      }),
    });
    msg.textContent = '✓ ' + target;
    if (target === 'locked') notify('Period locked. Use credit notes for corrections.', 'success');
    await gstLoadReturn();
  } catch(e){
    msg.textContent = '✗ ' + e.message;
    notify(e.message, 'error');
  }
}

/* ── exports ──────────────────────────────────────────────────────────────── */
function gstExportExcel(){
  const d = _gst.data;
  if (!d) return;
  if (!d.validation.canExport){ notify('Fix the blockers before exporting', 'error'); return; }
  if (typeof XLSX === 'undefined'){ notify('Excel library not loaded', 'error'); return; }

  const g = d.gstr1, b = d.gstr3b;
  const wb = XLSX.utils.book_new();
  const add = (name, aoa) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name.slice(0, 31));
  };

  add('B2B', [['GSTIN','Customer','Invoice No','Invoice Date','Invoice Value','Place of Supply','Rate','Taxable','CGST','SGST','IGST'],
    ...g.b2b.flatMap((r) => (r.rateBreakup||[]).map((b2) => [r.gstin, r.counterpartyName, r.invoiceNumber, r.invoiceDate, r.invoiceValuePaise/100, r.placeOfSupply, b2.rate, b2.taxablePaise/100, b2.cgstPaise/100, b2.sgstPaise/100, b2.igstPaise/100]))]);

  add('B2C Large', [['Place of Supply','Invoice No','Invoice Date','Invoice Value','Rate','Taxable','CGST','SGST','IGST'],
    ...g.b2cl.flatMap((r) => (r.rateBreakup||[]).map((x) => [r.placeOfSupply, r.invoiceNumber, r.invoiceDate, r.invoiceValuePaise/100, x.rate, x.taxablePaise/100, x.cgstPaise/100, x.sgstPaise/100, x.igstPaise/100]))]);

  add('B2C Small', [['Place of Supply','State','Rate','Invoices','Taxable','CGST','SGST','IGST'],
    ...g.b2cs.map((r) => [r.placeOfSupply, r.stateName, r.rate, r.invoiceCount, r.taxablePaise/100, r.cgstPaise/100, r.sgstPaise/100, r.igstPaise/100])]);

  add('Nil Exempt NonGST', [['Type','Inter/Intra','Recipient','POS','Taxable','Documents'],
    ...g.nil_exempt.map((r) => [r.supplyType, r.interState ? 'Inter' : 'Intra', r.recipientType, r.placeOfSupply, r.taxablePaise/100, (r.invoiceNos||[]).join(', ')])]);

  add('CDN', [['Type','GSTIN','Note No','Note Date','Original Invoice','Taxable','CGST','SGST','IGST'],
    ...g.cdnr.concat(g.cdnur).map((r) => [r.noteType, r.gstin, r.noteNumber, r.noteDate, r.originalInvoiceNumber, r.totalTaxablePaise/100, r.totalCgstPaise/100, r.totalSgstPaise/100, r.totalIgstPaise/100])]);

  add('Exports SEZ', [['Type','GSTIN/UIN','Invoice No','Invoice Date','Value','Rate','Taxable','IGST','Payment'],
    ...g.exp.map((r) => ['Export', r.gstin, r.invoiceNumber, r.invoiceDate, r.invoiceValuePaise/100, r.rate, r.taxablePaise/100, r.igstPaise/100, r.paymentType]),
    ...g.sez.map((r) => ['SEZ', r.gstin, r.invoiceNumber, r.invoiceDate, r.invoiceValuePaise/100, r.rate, r.taxablePaise/100, r.igstPaise/100, ''])]);

  add('HSN', [['HSN/SAC','Description','UQC','Qty','Rate','Taxable','IGST','CGST','SGST','Cess','B2B','B2C'],
    ...g.hsn.rows.map((r) => [r.hsnSac, r.description, r.uqc, r.qtyTotal, r.rate, r.taxablePaise/100, r.igstPaise/100, r.cgstPaise/100, r.sgstPaise/100, r.cessPaise/100, r.b2bTaxablePaise/100, r.b2cTaxablePaise/100])]);

  add('Amendments', [['Note / Invoice','Date','Original period','Original invoice','Reason'],
    ...(g.amendments || []).map((a) => [a.invoiceNumber, a.invoiceDate, a.originalPeriod, a.originalInvoiceNumber, a.reason || ''])]);

  add('Docs Issued', [['Document Type','Series','From','To','Issued','Cancelled','Cancelled Numbers','Taxable','Tax'],
    ...g.docs_issued.map((s) => [s.docTypeLabel, s.series, s.fromNumber, s.toNumber, s.totalIssued, s.totalCancelled, (s.cancelledNumbers||[]).join(', '), s.netTaxablePaise/100, s.netTaxPaise/100])]);

  add('GSTR3B', [['Table','Taxable','IGST','CGST','SGST'],
    ['3.1(a) Taxable', b.t31.a_taxable.taxablePaise/100, b.t31.a_taxable.igstPaise/100, b.t31.a_taxable.cgstPaise/100, b.t31.a_taxable.sgstPaise/100],
    ['3.1(b) Zero-rated', b.t31.b_zero_rated.taxablePaise/100, b.t31.b_zero_rated.igstPaise/100, b.t31.b_zero_rated.cgstPaise/100, b.t31.b_zero_rated.sgstPaise/100],
    ['3.1(c) Nil/Exempt', b.t31.c_nil_exempt.taxablePaise/100, b.t31.c_nil_exempt.igstPaise/100, b.t31.c_nil_exempt.cgstPaise/100, b.t31.c_nil_exempt.sgstPaise/100],
    ['3.1(d) RCM', b.t31.d_reverse_charge.taxablePaise/100, b.t31.d_reverse_charge.igstPaise/100, b.t31.d_reverse_charge.cgstPaise/100, b.t31.d_reverse_charge.sgstPaise/100],
    ['3.1(e) Non-GST', b.t31.e_non_gst.taxablePaise/100, b.t31.e_non_gst.igstPaise/100, b.t31.e_non_gst.cgstPaise/100, b.t31.e_non_gst.sgstPaise/100],
    ['3.2 Inter-state unreg', b.t32.taxablePaise/100, b.t32.igstPaise/100, b.t32.cgstPaise/100, b.t32.sgstPaise/100],
    ['4 Net ITC available', '', b.table4.netAvailable/100, '', ''],
    ['Net payable', '', b.setOff.payable.igst/100, b.setOff.payable.cgst/100, b.setOff.payable.sgst/100],
  ]);

  add('Validation', [['Severity','Code','Invoice','Customer','Issue','Fix'],
    ...d.validation.issues.map((i) => [i.severity, i.code, i.invoiceNo, i.customer, i.message, i.fix || ''])]);

  add('2B Recon', [['Bucket','Supplier GSTIN','Invoice','Date','Taxable','Diff Taxable','Diff Tax','ITC','Decision'],
    ...d.recon2b.results.map((r) => {
      const s = r.row2b || r.row || {};
      return [r.bucket, s.gstin||'', s.invoiceNo||'', s.invoiceDate||'',
              gstSum(s.taxablePaise)/100, gstSum(r.diffTaxablePaise)/100,
              gstSum(r.diffIgstPaise, r.diffCgstPaise, r.diffSgstPaise, r.diffCessPaise)/100,
              gstSum(r.itcPaise)/100, r.decision||'pending'];
    })]);

  const fileName = 'GSTR1_GSTR3B_' + _gst.period + '.xlsx';
  XLSX.writeFile(wb, fileName);
  gstRecordExport('excel', fileName, gstr1Counts(g));
  notify('Excel exported — review each sheet before filing');
}

/** Row counts per table, for the audit record. */
function gstr1Counts(g){
  return Object.entries({ b2b:g.b2b, b2cl:g.b2cl, b2cs:g.b2cs, nil_exempt:g.nil_exempt,
    cdnr:g.cdnr, cdnur:g.cdnur, exp:g.exp, sez:g.sez, docsIssued:g.docs_issued, hsn:g.hsn && g.hsn.rows })
    .map(([k, v]) => [k, (v || []).length]);
}
function gstr3bCounts(b){
  return [['hsn', (b && b.hsn && b.hsn.rows || []).length]];
}

/** Record the download in the audit trail. Never block the export on it. */
async function gstRecordExport(kind, fileName, rowCounts){
  try {
    await _api('/gst/export', {
      method: 'POST',
      body: JSON.stringify({ period: _gst.period, kind, fileName, rowCounts }),
    });
  } catch(e){ /* the file is already downloaded; a missing audit line is not worth blocking */ }
}

function gstExportJSON(){
  const d = _gst.data;
  if (!d) return;
  if (!d.validation.canExport){ notify('Fix the blockers before exporting', 'error'); return; }

  // schema validation runs BEFORE download
  const chk = d.schemaCheck || {};
  if (!chk.ok){
    if (!confirm('The portal JSON failed schema validation:\n\n- ' + (chk.errors||[]).join('\n- ') + '\n\nDownload anyway?')){
      return;
    }
  }
  const blob = new Blob([JSON.stringify(d.portalJSON, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const fileName = 'GSTR1_' + _gst.period + '_' + (d.schemaVersion || '') + '.json';
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
  gstRecordExport('portal_json', fileName, gstr1Counts(d.gstr1));
  notify('JSON exported (schema ' + (d.schemaVersion || '') + ')');
}