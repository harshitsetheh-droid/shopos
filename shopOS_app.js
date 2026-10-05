/* ══════════════════════════════════════════
   ShopOS v7 — app.js
   ══════════════════════════════════════════ */

// ── API CONFIG ───────────────────────────────────────────────────────────────
const API_BASE = 'http://localhost:3000/api';
let _token = sessionStorage.getItem('shopOS_token') || '';
let _authUser = null; // full user record incl. business GST details
function _authHeaders(){
  return _token ? { 'Authorization': 'Bearer ' + _token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}
async function _api(path, opts = {}){
  opts.headers = { ..._authHeaders(), ...opts.headers };
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Save to PostgreSQL instantly on every mutation
let _savePromise = Promise.resolve();
let _dataLoaded = false;
function saveAllData(immediate){
  _custPhoneCache={sig:'',map:null};
  _savePromise = _savePromise.then(() => _doSave()).catch(() => {});
  return immediate ? _savePromise : void 0;
}
// ── Delta tracking (perf) ─────────────────────────────────────────────────────
// The previous /api/save deleted and re-inserted EVERY row on every keystroke-
// triggered save, which is O(n) and gets slow with real volumes. We now
// fingerprint each record and send only what actually changed. The server still
// accepts a full payload (see the fallback inside _buildDelta) so nothing breaks.
let _syncSig = {};       // collection -> { id: hash }
let _syncPending = null; // true once a change happened before the first snapshot

function _sigOf(v){
  try { return String(JSON.stringify(v)); } catch(e){ return String(v); }
}
function _recordSig(list, keyFn){
  const out = {};
  for (const r of (list || [])){
    const k = keyFn(r);
    if (k != null) out[k] = _sigOf(r);
  }
  return out;
}
function _buildDelta(){
  const snap = {
    categories:    _recordSig(categories,    (r) => r.id),
    products:      _recordSig(products,      (r) => r.id),
    sales:         _recordSig(sales,         (r) => r.id),
    inventoryHistory: _recordSig(inventoryHistory, (r) => r.id),
    udhaarRecords: _recordSig(udhaarRecords, (r) => r.id),
    advanceOrders: _recordSig(advanceOrders, (r) => r.id),
    notes:         _recordSig(notes,         (r) => r.id),
    customerLedgers: _recordSig(customerLedgers, (r) => r.id),
    expenses:      _recordSig(expenses,      (r) => r.id),
  };

  if (_syncPending || !Object.keys(_syncSig).length){
    // No baseline yet → send everything once.
    _syncSig = snap;
    _syncPending = false;
    return { mode:'full' };
  }

  const live = {
    categories, products, sales, inventoryHistory, udhaarRecords,
    advanceOrders, notes, customerLedgers, expenses,
  };
  const keyFns = {
    categories:(r) => r.id, products:(r) => r.id, sales:(r) => r.id,
    inventoryHistory:(r) => r.id, udhaarRecords:(r) => r.id,
    advanceOrders:(r) => r.id, notes:(r) => r.id,
    customerLedgers:(r) => r.id, expenses:(r) => r.id,
  };

  const changed = {};
  let any = false;
  for (const name of Object.keys(snap)){
    const prev = _syncSig[name] || {};
    const now = snap[name];
    const upserts = [];
    const deletes = [];
    for (const k of Object.keys(now)){
      if (prev[k] !== now[k]) upserts.push(live[name].find((r) => keyFns[name](r) === k));
    }
    for (const k of Object.keys(prev)){
      if (!(k in now)) deletes.push(k);
    }
    if (upserts.length || deletes.length){
      changed[name] = { upserts: upserts.filter(Boolean), deletes };
      any = true;
    }
  }
  _syncSig = snap;
  if (!any) return { mode:'noop' };
  return { mode:'delta', changed };
}

async function _doSave(){
  if (!_dataLoaded) return;
  try {
    await _api('/save', {
      method: 'POST',
      body: JSON.stringify({categories,products,sales,inventoryHistory,udhaarRecords,advanceOrders,notes,customerLedgers,purchasePriceLog,supplierTransportLog,expenses,delta:_buildDelta()})
    });
    _savePromise = Promise.resolve();
  } catch(e) {
    console.error('Save error:', e);
    _savePromise = Promise.resolve();
    setTimeout(_doSave, 2000);
  }
}
function _localDateStr(d){
  if(!d) d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Safety net: periodic save every 10s
setInterval(() => { _doSave(); }, 10000);

// ── AUTH ────────────────────────────────────────────────────────────────────
function getAccounts(){ return JSON.parse(localStorage.getItem('shopOS_accounts')||'[]'); }
function saveAccounts(arr){ localStorage.setItem('shopOS_accounts', JSON.stringify(arr)); }

/* ── Tab switch ── */
function switchAuthTab(tab){
  document.getElementById('formLogin').style.display  = tab==='login'  ? '' : 'none';
  document.getElementById('formSignup').style.display = tab==='signup' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active',  tab==='login');
  document.getElementById('tabSignup').classList.toggle('active', tab==='signup');
  hideAuthMsg('loginError');
  hideAuthMsg('signupError');
  hideAuthMsg('signupSuccess');
}

function showAuthError(id, msg){ const e=document.getElementById(id); e.textContent=msg; e.classList.add('show'); }
function hideAuthMsg(id){ document.getElementById(id)?.classList.remove('show'); }
function showAuthSuccess(id,msg){ const e=document.getElementById(id); e.textContent=msg; e.classList.add('show'); }

/* ── Show/hide password ── */
function togglePwVis(inputId, eyeEl){
  const inp = document.getElementById(inputId);
  if(inp.type==='password'){ inp.type='text'; eyeEl.textContent='🙈'; }
  else { inp.type='password'; eyeEl.textContent='👁'; }
}

/* ── Email validation ── */
function isValidEmail(email){
  if(!email) return false;
  var e = email.trim().toLowerCase();
  // Must end with @gmail.com
  if(!e.endsWith("@gmail.com")) return false;
  var local = e.slice(0, e.indexOf("@"));
  // Local part rules (same as real Gmail):
  // - only letters, numbers, dots
  // - no double dots
  // - cannot start or end with a dot
  if(!/^[a-z0-9][a-z0-9.]*[a-z0-9]$/.test(local) && !/^[a-z0-9]$/.test(local)) return false;
  if(local.includes("..")) return false;
  return true;
}

function checkEmailLive(){
  const val = document.getElementById('signupEmail').value.trim();
  const inp = document.getElementById('signupEmail');
  const st  = document.getElementById('emailStatus');
  if(!val){ inp.className='auth-input'; st.textContent=''; return; }
  if(!isValidEmail(val)){
    inp.className='auth-input invalid'; st.textContent='✗';
    document.getElementById('signupError').textContent='Only Gmail addresses allowed (e.g. name@gmail.com)';
    document.getElementById('signupError').classList.add('show');
    return;
  }
  hideAuthMsg('signupError');
  const taken = getAccounts().find(a=>a.email?.toLowerCase()===val.toLowerCase());
  if(taken){
    inp.className='auth-input invalid'; st.textContent='✗';
    document.getElementById('signupError').textContent='This email is already registered.';
    document.getElementById('signupError').classList.add('show');
  } else {
    inp.className='auth-input valid'; st.textContent='✓'; hideAuthMsg('signupError');
    document.getElementById('googleVerifyNote').style.display='flex';
  }
}

/* ── Username live check + suggestions ── */
function checkUsernameLive(){
  const val  = document.getElementById('signupUser').value.trim();
  const inp  = document.getElementById('signupUser');
  const st   = document.getElementById('usernameStatus');
  const sugg = document.getElementById('usernameSuggestions');
  sugg.innerHTML='';
  if(!val){ inp.className='auth-input'; st.textContent=''; return; }
  if(val.length<3){ inp.className='auth-input invalid'; st.textContent='✗'; return; }
  const taken = getAccounts().find(a=>a.username.toLowerCase()===val.toLowerCase());
  if(taken){
    inp.className='auth-input invalid'; st.textContent='✗';
    // Generate suggestions
    const suggestions = generateUsernameSuggestions(val);
    suggestions.forEach(s=>{
      const chip = document.createElement('span');
      chip.className='auth-suggestion-chip';
      chip.textContent=s;
      chip.onclick=()=>{ document.getElementById('signupUser').value=s; checkUsernameLive(); };
      sugg.appendChild(chip);
    });
  } else {
    inp.className='auth-input valid'; st.textContent='✓';
  }
}

function generateUsernameSuggestions(base){
  const accounts = getAccounts();
  const taken = new Set(accounts.map(a=>a.username.toLowerCase()));
  const candidates = [];
  const clean = base.replace(/[^a-zA-Z0-9_]/g,'');
  const year  = new Date().getFullYear();
  const nums  = [1,2,123,99,007,42,2025,2026];
  const suffixes = ['_shop','_store','_pro','_biz','_official'];
  for(let n of nums){ const c=clean+n; if(!taken.has(c.toLowerCase())) candidates.push(c); }
  for(let s of suffixes){ const c=clean+s; if(!taken.has(c.toLowerCase())) candidates.push(c); }
  candidates.push(clean+'_'+year);
  return [...new Set(candidates)].slice(0,5);
}

/* ── Password strength ── */
function checkPasswordLive(){
  const val = document.getElementById('signupPass').value;
  const rules = {
    len:    val.length>=8,
    upper:  /[A-Z]/.test(val),
    num:    /[0-9]/.test(val),
    special:/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(val)
  };
  let score=0;
  for(let k in rules){
    const el = document.getElementById('rule-'+k);
    const icon = el.querySelector('.rule-icon');
    if(rules[k]){ el.classList.add('met');   icon.textContent='✓'; score++; }
    else         { el.classList.remove('met'); icon.textContent='✗'; }
  }
  const fill  = document.getElementById('pwStrengthFill');
  const pct   = (score/4)*100;
  const colors=['#ef4444','#f97316','#eab308','#22c55e'];
  fill.style.width   = pct+'%';
  fill.style.background = colors[score>0?score-1:0];
  checkConfirmLive();
}

function checkConfirmLive(){
  const p1  = document.getElementById('signupPass').value;
  const p2  = document.getElementById('signupPass2').value;
  const msg = document.getElementById('matchMsg');
  if(!p2){ msg.textContent=''; return; }
  if(p1===p2){ msg.style.color='var(--green)'; msg.textContent='✓ Passwords match'; }
  else        { msg.style.color='var(--red)';  msg.textContent='✗ Passwords do not match'; }
}

function passwordIsStrong(pass){
  return pass.length>=8 && /[A-Z]/.test(pass) && /[0-9]/.test(pass) && /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pass);
}

/* ── Sign Up ── */
async function doSignup(){
  hideAuthMsg('signupError');
  const name  = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const user  = document.getElementById('signupUser').value.trim();
  const pass  = document.getElementById('signupPass').value;
  const pass2 = document.getElementById('signupPass2').value;
  const location = document.getElementById('signupLocation').value.trim();

  if(!name||!email||!user||!pass||!pass2||!location){
    showAuthError('signupError','Please fill in all fields including location.'); return;
  }
  if(!isValidEmail(email)){
    showAuthError('signupError','Please enter a valid Gmail address (e.g. name@gmail.com).'); return;
  }
  if(user.length<3){
    showAuthError('signupError','Username must be at least 3 characters.'); return;
  }
  if(!passwordIsStrong(pass)){
    showAuthError('signupError','Password does not meet all requirements. Please check the rules below.'); return;
  }
  if(pass!==pass2){
    showAuthError('signupError','Passwords do not match.'); return;
  }

  try {
    await _api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username:user, name, email, password:pass, location })
    });
  } catch(e) {
    showAuthError('signupError', e.message);
    return;
  }

  showAuthSuccess('signupSuccess','🎉 Account created! Redirecting to login…');
  ['signupName','signupEmail','signupUser','signupPass','signupPass2','signupLocation'].forEach(id=>{
    document.getElementById(id).value='';
    document.getElementById(id).className='auth-input';
  });
  document.getElementById('usernameSuggestions').innerHTML='';
  document.getElementById('pwStrengthFill').style.width='0%';
  ['rule-len','rule-upper','rule-num','rule-special'].forEach(id=>{
    const el=document.getElementById(id); el.classList.remove('met');
    el.querySelector('.rule-icon').textContent='✗';
  });
  document.getElementById('matchMsg').textContent='';
  document.getElementById('emailStatus').textContent='';
  document.getElementById('usernameStatus').textContent='';
  document.getElementById('googleVerifyNote').style.display='none';

  setTimeout(()=>{ switchAuthTab('login'); hideAuthMsg('signupSuccess'); }, 1800);
}

/* ── Login ── */
async function doLogin(){
  hideAuthMsg('loginError');
  const ident = document.getElementById('loginUser').value.trim();
  const pass  = document.getElementById('loginPass').value;
  if(!ident||!pass){ showAuthError('loginError','Please fill in all fields.'); return; }
  try {
    const res = await _api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ident, password: pass })
    });
    _token = res.token;
    sessionStorage.setItem('shopOS_token', _token);
    _authUser = res.user || null;
    unlockApp(res.user.name||res.user.username, res.user.location);
    await loadAllData();
  } catch(e) {
    showAuthError('loginError', e.message);
  }
}

/* ── Unlock app ── */
let _userLocation = '';
let bellPanelOpen = false;
let _bellDismissed = {};
try{ const v=JSON.parse(localStorage.getItem('shopOS_bellDismissed')); if(v&&typeof v==='object') _bellDismissed=v; }catch(e){}
function _saveBellDismissed(){ try{ localStorage.setItem('shopOS_bellDismissed',JSON.stringify(_bellDismissed)); }catch(e){} }
function _resetBellDismissed(){ _bellDismissed={}; _saveBellDismissed(); }
function markBellDismissed(type,id){ _bellDismissed[type+':'+id]=true; _saveBellDismissed(); }

function shortLocLabel(loc){
  if(!loc) return '';
  const parts = String(loc).split(',').map(s=>s.trim()).filter(Boolean);
  if(parts.length<=2) return parts.join(', ');
  // Drop trailing "India" / country part, keep last 2 meaningful location parts
  const last = parts[parts.length-1];
  const dropCountry = /india/i.test(last);
  const keep = dropCountry ? parts.slice(-3) : parts.slice(-2);
  let label = keep.join(', ');
  if(label.length>38) label = parts.slice(-1)[0];
  return label;
}

function unlockApp(displayName, location){
  _userLocation = location || '';
  const authScreen = document.getElementById('authScreen');
  const mainApp    = document.getElementById('mainApp');
  authScreen.classList.add('fade-out');
  setTimeout(()=>{ authScreen.style.display='none'; },400);
  mainApp.classList.remove('app-hidden');
  const lbl = document.getElementById('authUserLabel');
  if(lbl) lbl.textContent='👤 '+displayName;
  const ci=document.getElementById('cartCustLocation');
  if(ci) ci.value=_userLocation;
  // Let the GST module pick up the business GST details from login/verify
  if(typeof gstOnLogin==='function'){ try{ gstOnLogin(_authUser); }catch(e){ console.warn('GST init failed', e); } }
  // Show shop location in nav if present
  const navWrap=document.getElementById('navLocWrap');
  const navLabel=document.getElementById('navLocLabel');
  if(_userLocation && navWrap && navLabel){ navLabel.textContent=shortLocLabel(_userLocation); navWrap.style.display='inline-flex'; }
  // Show bell
  const bellWrap=document.getElementById('bellWrap');
  if(bellWrap) bellWrap.style.display='inline-flex';
  updateReminderCount();
  // Auto-fill cart location with device's current location if empty
  if(ci && !ci.value.trim())  autoFillCartLocation();
  // Refresh reminders after data loads
  setTimeout(()=>updateReminderCount(), 2000);
}

function doLogout(){
  _token = '';
  sessionStorage.removeItem('shopOS_token');
  location.reload();
}

// Auto-login if token exists
(function checkSession(){
  const t = sessionStorage.getItem('shopOS_token');
  if(t){
    _token = t;
    document.addEventListener('DOMContentLoaded', async () => {
      try {
        const res = await _api('/auth/verify');
        _authUser = res.user || null;
    unlockApp(res.user.name||res.user.username, res.user.location);
        await loadAllData();
        calInit();
        // Init custom selects + enhance all native selects
        document.querySelectorAll('.cust-sel-wrap').forEach(w=>{
          const sel=w.querySelector('.cust-sel-item.sel');
          if(sel) w.dataset.val=sel.dataset.value;
        });
        enhanceSelects();
      } catch(e) {
        sessionStorage.removeItem('shopOS_token');
        _token = '';
      }
    });
  }
})();


let products         = [];
let categories       = [];
let sales            = [];
let cart             = [];
let inventoryHistory = [];
let udhaarRecords    = [];
let advanceOrders    = [];
let notes            = [];
let qrCodes          = [];
let customerLedgers  = [];
let purchasePriceLog = []; // [{productName, purchasePrice, date}]
let supplierTransportLog = []; // persistent: survives inventory history deletion [{date, supplier, transportProvider, products}]
let expenses = [];
let _nextExpId = 1;

let nextProdId=1, nextCatId=1, nextSaleId=1, nextInvId=1, nextAdvId=1;
let _nextNoteId=1, _nextLedgerId=1;
let _invSearch='', _posSearch='', _bulkMode='pieces';
let _gstBreakdownOpen=false, _salesFilter='month', _salesGstOnly=false, _salesMethodFilter=null, _salesSearchQuery='', _salesSearchMode='customer';
let _invEntryRowCount=0, _advRowCount=0;
let _supplierManualStatus=false, _transportManualStatus=false;
let _udhaarIncluded=false;
let _udhaarSort='pending_desc';
let _invLowStockFilter=false;
let _advReminderTimers=[];
let _bulkStockView='pcs';
let _posStockView={}; // per-product stock view toggle in POS grid
let _posCatFilter=0;

// Udhaar reminder settings
let _udhaarReminderDays=[5,15,30]; // default: 5 days, 15 days, 30 days
let _udhaarReminderTimer=null;

// ── QTY HELPERS ─────────────────────────────────────────────────────────────
function formatQty(b,p){
  b=Math.max(0,b||0); p=Math.max(0,p||0);
  if(!b&&!p) return 'No stock';
  if(b&&p) return `${b} box${b!==1?'es':''} & ${p} pc${p!==1?'s':''}`;
  if(b) return `${b} box${b!==1?'es':''}`;
  return `${p} pc${p!==1?'s':''}`;
}
function calcTotalStock(b,p,ppb){
  return Math.max(0,b||0)*Math.max(1,ppb||1)+Math.max(0,p||0);
}
function fmt(n){ return Number(n||0).toFixed(2); }

// Smart rounding: ceil if decimal >= .20, floor if < .20
function smartRound(n){
  const floored = Math.floor(n);
  const dec = n - floored;
  return dec >= 0.20 ? Math.ceil(n) : floored;
}
function toTitleCase(s){ return s.trim().toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()); }
function up(s){ return String(s==null?'':s).trim().toUpperCase(); }
function getCatName(id){ return categories.find(x=>x.id===id)?.name||'Uncategorized'; }
function getCatEmoji(id){ return categories.find(x=>x.id===id)?.emoji||'📦'; }

function autoCalcStock(){
  const b=Math.max(0,parseInt(document.getElementById('pNoOfBoxes').value)||0);
  const p=Math.max(0,parseInt(document.getElementById('pNoOfPieces').value)||0);
  const ppb=Math.max(1,parseInt(document.getElementById('pPiecesPerBox').value)||1);
  const t=calcTotalStock(b,p,ppb);
  document.getElementById('pStock').value=t;
  const d=document.getElementById('stockAutoDisplay'); if(!d) return;
  const unit=document.getElementById('pUnit')?.value?.trim()||'';
  const wt=isWeightUnit(unit);
  const base=getWeightBaseUnit(unit);
  if(wt){
    if(b&&p) d.textContent=`${b} ${base} + ${p} gm = ${t} gm total`;
    else if(b) d.textContent=`${b} ${base} × ${ppb} = ${t} gm total`;
    else if(p) d.textContent=`${t} gm`;
    else d.textContent='0 gm';
  } else {
    if(b&&p) d.textContent=`${b} box${b!==1?'es':''} + ${p} pcs = ${t} pcs total`;
    else if(b) d.textContent=`${b} box${b!==1?'es':''} × ${ppb} = ${t} pcs total`;
    else if(p) d.textContent=`${t} pcs`;
    else d.textContent='0 pcs';
  }
}

const qtyToggleState={};
function toggleQtyDisplay(pid){
  qtyToggleState[pid]=!qtyToggleState[pid];
  const el=document.querySelector(`[data-qty-product="${pid}"]`);
  const p=products.find(x=>x.id===pid);
  if(el&&p) el.innerHTML=renderQtyCell(p);
}
function renderQtyCell(p){
  const exp=qtyToggleState[p.id];
  const b=Math.max(0,p.noOfBoxes||0), pc=Math.max(0,p.noOfPieces||0), ppb=Math.max(1,p.piecesPerBox||1);
  if(!b&&!pc) return `<span class="qty-display">No stock</span>`;
  const txt=exp?`${b*ppb+pc} pcs total`:formatQty(b,pc);
  const can=b>0;
  const hint=can?`<span class="qty-hint">${exp?'click for boxes':'click for pcs'}</span>`:'';
  return `<span class="${can?(exp?'qty-display expanded':'qty-display'):'qty-display'}" ${can?`onclick="toggleQtyDisplay(${p.id})"`:''}>${txt}</span>${hint}`;
}

// ── CATEGORIES ─────────────────────────────────────────────────────────────
function refreshCategoryDropdowns(){
  const base='<option value="">All Categories</option>';
  const opts=base+categories.map(c=>`<option value="${c.id}">${c.emoji} ${c.name}</option>`).join('');
  ['invCatFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.value;
    el.innerHTML = opts;
    el.value = val;
  });
}

function openAddCategory(){
  document.getElementById('catModalTitle').textContent='Add Category';
  ['catName','catEmoji'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('catEditId').value='';
  document.getElementById('categoryModal').classList.add('open');
  setTimeout(()=>document.getElementById('catName').focus(),100);
}
function openEditCategory(id){
  const c=categories.find(x=>x.id===id);
  if (!c) return;
  document.getElementById('catModalTitle').textContent='Edit Category';
  document.getElementById('catName').value=c.name;
  document.getElementById('catEmoji').value=c.emoji;
  document.getElementById('catEditId').value=id;
  document.getElementById('categoryModal').classList.add('open');
  setTimeout(()=>document.getElementById('catName').focus(),100);
}
function saveCategory(){
  const raw=document.getElementById('catName').value.trim();
  if(!raw){ notify('Category name required','error'); return; }
  const name=raw.toUpperCase();
  const emoji=document.getElementById('catEmoji').value.trim()||'📂';
  const editId=document.getElementById('catEditId').value;
  if(editId){
    const c=categories.find(x=>x.id===parseInt(editId));
    c.name=name; c.emoji=emoji; notify('Category updated!');
  } else {
    if(categories.some(c=>c.name.toLowerCase()===name.toLowerCase())){ notify(`"${name}" already exists`,'error'); return; }
    categories.push({id:nextCatId++,name,emoji}); notify('Category added!');
  }
  closeModal('categoryModal'); refreshCategoryDropdowns(); renderCategories(); saveAllData();
}
// ── CUSTOM CONFIRM DELETE ────────────────────────────────────────────────────
function showConfirmDelete(title, msg, onConfirm){
  document.getElementById('confirmDeleteTitle').textContent=title;
  document.getElementById('confirmDeleteMsg').innerHTML=msg;
  const btn=document.getElementById('confirmDeleteBtn');
  btn.onclick=()=>{ closeModal('confirmDeleteModal'); onConfirm(); };
  document.getElementById('confirmDeleteModal').classList.add('open');
}

function deleteCategory(id){
  if(products.some(p=>p.catId===id)){ notify('Remove products in this category first','error'); return; }
  const c=categories.find(x=>x.id===id); if(!c) return;
  showConfirmDelete('🗑️ Delete Category',
    `Are you sure you want to delete the category <strong>"${c.name}"</strong>?<br><span style="font-size:12px;color:var(--muted);">This action cannot be undone.</span>`,
    ()=>{ categories=categories.filter(x=>x.id!==id); refreshCategoryDropdowns(); renderCategories(); notify('Category deleted'); saveAllData(); }
  );
}
function renderCategories(){
  const el=document.getElementById('categoryGrid');
  let list=categories;
  const searchBox=document.getElementById('categorySearch');
  const q=(searchBox?searchBox.value:'').trim().toLowerCase();
  if(q) list=categories.filter(c=>matchWords(c.name,q)||matchWords(c.emoji||'',q));
  const sortSel=document.getElementById('categorySort');
  const sortVal=sortSel?sortSel.value:'name';
  list=[...list];
  if(sortVal==='name') list.sort((a,b)=>a.name.localeCompare(b.name));
  else if(sortVal==='name_desc') list.sort((a,b)=>b.name.localeCompare(a.name));
  else if(sortVal==='count_desc') list.sort((a,b)=>products.filter(p=>p.catId===b.id).length-products.filter(p=>p.catId===a.id).length);
  else if(sortVal==='count_asc') list.sort((a,b)=>products.filter(p=>p.catId===a.id).length-products.filter(p=>p.catId===b.id).length);
  if(!list.length){
    el.innerHTML=`<div class="empty-state" style="grid-column:1/-1;"><div class="big">🏷️</div><p>${categories.length?'No categories match your search.':'No categories yet.'}</p>${categories.length?'':`<button class="btn btn-primary" onclick="openAddCategory()">+ Add Category</button>`}</div>`;
    return;
  }
  el.innerHTML=list.map(c=>{
    const count=products.filter(p=>p.catId===c.id).length;
    return `<div class="cat-card">
      <div style="font-size:30px;margin-bottom:8px;">${c.emoji}</div>
      <div class="cat-name">${hlStr(c.name,q)}</div>
      <div class="cat-count">${count} product${count!==1?'s':''}</div>
      <div class="cat-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditCategory(${c.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCategory(${c.id})">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// ── INVENTORY ───────────────────────────────────────────────────────────────
function renderInventory(){
  const countEl = document.getElementById('invProductCount');
  if(countEl) countEl.textContent = products.length ? `(${products.length} unique products)` : '';
  const search=(_invSearch||'').toLowerCase();
  const catFilter=parseInt(document.getElementById('invCatFilter').value)||0;
  const sortVal=document.getElementById('invSortFilter')?.value||'name';
  let filtered=products.filter(p=>
    (matchWords(p.name,search)||matchWords(getCatName(p.catId),search))&&
    (!catFilter||p.catId===catFilter)
  );
  // Low stock filter (set from dashboard click)
  if(_invLowStockFilter) filtered=filtered.filter(p=>p.stock<=p.low);
  // Sorting
  filtered=[...filtered];
  if(sortVal==='name') filtered.sort((a,b)=>a.name.localeCompare(b.name));
  else if(sortVal==='name_desc') filtered.sort((a,b)=>b.name.localeCompare(a.name));
  else if(sortVal==='price_asc') filtered.sort((a,b)=>a.price-b.price);
  else if(sortVal==='price_desc') filtered.sort((a,b)=>b.price-a.price);
  else if(sortVal==='stock_asc') filtered.sort((a,b)=>a.stock-b.stock);
  else if(sortVal==='stock_desc') filtered.sort((a,b)=>b.stock-a.stock);
  else if(sortVal==='newest') filtered.sort((a,b)=>b.id-a.id);
  else if(sortVal==='oldest') filtered.sort((a,b)=>a.id-b.id);
  const wrap=document.getElementById('inventoryWrap');
  // Show banner if low stock filter is active
  const banner=_invLowStockFilter?`<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:10px 16px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--red);">
    ⚠️ Showing <strong>Low Stock / Out of Stock</strong> items only
    <button class="btn btn-ghost btn-sm" onclick="_invLowStockFilter=false;renderInventory();">✕ Clear Filter</button>
  </div>`:'';
  // Show undo banner if there's a pending import snapshot
  const undoBanner=_lastImportSnapshot?`<div style="background:rgba(241,196,15,.12);border:1px solid rgba(241,196,15,.4);border-radius:8px;padding:10px 16px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--accent);">
    📥 <strong>Import completed</strong> — click Undo to restore products to pre-import state
    <div style="display:flex;gap:8px;">
      <button class="btn btn-ghost btn-sm" onclick="undoLastImport()" style="border-color:var(--red);color:var(--red);">↩ Undo</button>
      <button class="btn btn-ghost btn-sm" onclick="_lastImportSnapshot=null;renderInventory();" style="border-color:var(--border);">Dismiss</button>
    </div>
  </div>`:'';
  if(!products.length){
    wrap.innerHTML=undoBanner+banner+`<div class="empty-state"><div class="big">📦</div><p>${categories.length?'Add your first product.':'Add a category first.'}</p><button class="btn btn-primary" onclick="${categories.length?'openAddProduct()':"navigate('categories')"}">${categories.length?'+ Add Product':'→ Add Category'}</button></div>`;
    return;
  }
  if(!filtered.length){ wrap.innerHTML=undoBanner+banner+`<div class="empty-state"><div class="big">🔍</div><p>No products match.</p></div>`; return; }
  wrap.innerHTML=undoBanner+banner+`<table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Quantity</th><th>Status</th><th>Actions</th></tr></thead><tbody>${
    filtered.map(p=>{
      const status=p.stock===0?'Out of Stock':p.stock<=p.low?'Low Stock':'In Stock';
      const badge=p.stock===0?'badge-red':p.stock<=p.low?'badge-yellow':'badge-green';
      const fill=Math.min((p.stock/Math.max(p.low*2,1))*100,100);
      const fillColor=p.stock===0?'var(--red)':p.stock<=p.low?'var(--accent)':'var(--green)';
      return `<tr>
        <td><span style="font-size:16px;margin-right:8px;">${p.image?`<img src="${p.image}" alt="" style="width:24px;height:24px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:4px;cursor:zoom-in;" onclick="openLightbox('${p.image}','${p.name.replace(/'/g,"\\'")}' )">`:`${p.emoji}`}</span><span style="font-size:18px;font-weight:600;">${p.name}</span>${p.description?`<div style="font-size:10px;color:var(--muted);margin-top:2px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.description}</div>`:''} ${p.piecesPerBox?`<span style="font-size:10px;color:var(--muted);margin-left:6px;">1 box=${p.piecesPerBox}pcs</span>`:''}${p.hsn?`<span style="font-size:9px;color:var(--accent2);margin-left:6px;">HSN:${p.hsn}</span>`:''}${p.location?`<span style="font-size:9px;color:var(--muted);margin-left:6px;">📍${p.location}</span>`:''}${p.cess?`<span style="font-size:9px;color:var(--muted);margin-left:6px;">Cess:${p.cess}%</span>`:''}${p.gst?`<span style="font-size:9px;color:var(--accent2);margin-left:6px;">${p.cgst>0&&p.sgst>0?'C:'+p.cgst+'%/S:'+p.sgst+'%':p.igst>0?'I:'+p.igst+'%':'G:'+p.gst+'%'}</span>`:''}${p.purchasePrice?`<span style="font-size:9px;color:var(--muted);margin-left:6px;">PC:₹${fmt(p.purchasePrice)}</span>`:''}${p.price5?`<span style="font-size:9px;color:var(--accent);margin-left:6px;">5pc ₹${fmt(p.price5)}</span>`:''}${p.price10?`<span style="font-size:9px;color:var(--accent);margin-left:6px;">10pc ₹${fmt(p.price10)}</span>`:''}${p.lastPurchaseDate?`<span style="font-size:9px;color:var(--muted);margin-left:6px;">🛒${p.lastPurchaseDate.slice(0,10)}</span>`:''}</td>
        <td><span class="badge badge-blue">${getCatEmoji(p.catId)} ${getCatName(p.catId)}</span></td>
        <td style="color:var(--accent);">₹${fmt(p.price)}</td>
        <td><div data-qty-product="${p.id}">${renderQtyCell(p)}</div>
          <div class="stock-bar" style="width:60px;margin-top:4px;"><div class="stock-fill" style="width:${fill}%;background:${fillColor}"></div></div></td>
        <td><span class="badge ${badge}">${status}</span></td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="openEditProduct(${p.id})">Edit</button>
          <button class="btn btn-danger btn-sm" style="margin-left:6px;" onclick="deleteProduct(${p.id})">Delete</button>
        </td></tr>`;
    }).join('')
  }</tbody></table>`;
}
function filterInvAndAC(v){
  _invSearch=v;
  renderInventory();
  // Autocomplete
  const list=document.getElementById('invAcList');
  if(!v.trim()){ list.style.display='none'; return; }
  const q=v.toLowerCase();
  const matches=products.filter(p=>matchWords(p.name,q)).slice(0,7);
  if(!matches.length){ list.style.display='none'; return; }
  list.innerHTML=matches.map(p=>`<div class="autocomplete-item" onmousedown="event.preventDefault();document.getElementById('invSearch').value='${p.name.replace(/'/g,"\\'")}';filterInvAndAC('${p.name.replace(/'/g,"\\'")}');document.getElementById('invAcList').style.display='none';">
    <span class="ai-icon">${p.image?`<img src="${p.image}" style="width:22px;height:22px;object-fit:cover;border-radius:4px;vertical-align:middle;">`:p.emoji}</span>
    <span class="ai-name">${hlStr(p.name,q)}</span>
    <span class="ai-sub">${getCatName(p.catId)}</span>
  </div>`).join('');
  list.style.display='block';
}

function openAddProduct(prefill){
  if(!categories.length){ notify('Add a category first!','error'); navigate('categories'); return; }
  document.getElementById('modalTitle').textContent='Add Product';
  ['pName','pPrice','pPrice5','pPrice10','pSKU','pEmoji','pNoOfBoxes','pNoOfPieces','pPiecesPerBox','pCGST','pSGST','pIGST','pHSN','pLocation','pCess','pPurchasePrice','pUnit','pWeightPerPrice'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('pDescription').value='';
  document.getElementById('pLowAlert').value=getDefVal('low',10);
  document.getElementById('pCGST').value=getDefVal('cgst','')||'';
  document.getElementById('pSGST').value=getDefVal('sgst','')||'';
  document.getElementById('pIGST').value=getDefVal('igst','')||'';
  document.getElementById('pCess').value=getDefVal('cess','')||'';
  document.getElementById('pHSN').value=getDefVal('hsn','')||'';
  document.getElementById('pLocation').value=getDefVal('location','')||'';
  document.getElementById('pPiecesPerBox').value=getDefVal('ppb','')||'';
  document.getElementById('pPurchasePrice').value=getDefVal('purchasePrice','')||'';
  document.getElementById('pDescription').value=getDefVal('description','')||'';
  if(_defaults.category_on && _defaults.category){
    document.getElementById('pCategory').value=_defaults.category;
    const cat=categories.find(c=>String(c.id)===String(_defaults.category));
    document.getElementById('pCategoryText').value=cat?cat.emoji+' '+cat.name:'';
  }
  document.getElementById('pStock').value='0';
  document.getElementById('stockAutoDisplay').textContent='0 pcs';
  document.getElementById('pEditId').value='';
  document.getElementById('pCategory').value='';
  document.getElementById('pCategoryText').value='';
  document.getElementById('pDescription').value='';
  clearProductImage();
  comboClose('pNameWrap'); comboClose('pCatWrap');
  onUnitChange();
  if(prefill){
    if(prefill.name) document.getElementById('pName').value = prefill.name;
    if(prefill.sku) document.getElementById('pSKU').value = prefill.sku;
  }
  document.getElementById('productModal').classList.add('open');
  setTimeout(()=>document.getElementById('pName').focus(),100);
}
function openEditProduct(id){
  const p=products.find(x=>x.id===id);
  document.getElementById('modalTitle').textContent='Edit Product';
  document.getElementById('pName').value=p.name;
  document.getElementById('pPrice').value=p.price;
  document.getElementById('pPrice5').value=p.price5||'';
  document.getElementById('pPrice10').value=p.price10||'';
  document.getElementById('pSKU').value=p.sku||'';
  document.getElementById('pLowAlert').value=p.low;
  document.getElementById('pEmoji').value=p.emoji;
  document.getElementById('pCategory').value=p.catId;
  const cat=categories.find(x=>x.id===p.catId);
  document.getElementById('pCategoryText').value=cat?`${cat.emoji} ${cat.name}`:'';
  document.getElementById('pEditId').value=id;
  document.getElementById('pNoOfBoxes').value=p.noOfBoxes||0;
  document.getElementById('pNoOfPieces').value=p.noOfPieces||0;
  document.getElementById('pPiecesPerBox').value=p.piecesPerBox||'';
  document.getElementById('pCGST').value=p.cgst||'';
  document.getElementById('pSGST').value=p.sgst||'';
  document.getElementById('pIGST').value=p.igst||'';
  document.getElementById('pHSN').value=p.hsn||'';
  document.getElementById('pLocation').value=p.location||'';
  document.getElementById('pCess').value=p.cess||'';
  document.getElementById('pPurchasePrice').value=p.purchasePrice||'';
  document.getElementById('pUnit').value=p.unit||'';
  document.getElementById('pWeightPerPrice').value=p.weightPerPrice||'';
  onUnitChange();
  document.getElementById('pDescription').value=p.description||'';
  // Load image or emoji preview
  clearProductImage();
  if(p.image){
    const img=document.getElementById('pImgPreviewImg');
    const emojiEl=document.getElementById('pImgPreviewEmoji');
    img.src=p.image; img.style.display='block'; emojiEl.style.display='none';
    document.getElementById('pImgClearBtn').style.display='';
    document.getElementById('pImageFile')._currentImage=p.image;
  } else {
    updateEmojiPreview();
  }
  comboClose('pNameWrap'); comboClose('pCatWrap');
  autoCalcStock();
  document.getElementById('productModal').classList.add('open');
  setTimeout(()=>document.getElementById('pName').focus(),100);
}
function saveProduct(){
  const rawName=document.getElementById('pName').value.trim();
  const price=parseFloat(document.getElementById('pPrice').value);
  const price5=parseFloat(document.getElementById('pPrice5').value)||null;
  const price10=parseFloat(document.getElementById('pPrice10').value)||null;
  const catId=parseInt(document.getElementById('pCategory').value);
  if(!rawName){ notify('Product name is required','error'); return; }
  if(isNaN(price)||price<0){ notify('Enter a valid price','error'); return; }
  if(!catId){ notify('Please select or create a category','error'); return; }
  const name=rawName.toUpperCase();
  const emoji=document.getElementById('pEmoji').value.trim()||'📦';
  const image=document.getElementById('pImageFile')._currentImage||'';
  const description=document.getElementById('pDescription').value.trim();
  const sku=document.getElementById('pSKU').value.trim()||'SKU-'+String(nextProdId).padStart(3,'0');
  const low=parseInt(document.getElementById('pLowAlert').value)||2;
  const cgst=parseFloat(document.getElementById('pCGST').value)||0;
  const sgst=parseFloat(document.getElementById('pSGST').value)||0;
  const igst=parseFloat(document.getElementById('pIGST').value)||0;
  const gst=cgst+sgst; // effective rate for local sales
  const hsn=document.getElementById('pHSN').value.trim();
  const location=document.getElementById('pLocation').value.trim();
  const cess=parseFloat(document.getElementById('pCess').value)||0;
  const purchasePrice=parseFloat(document.getElementById('pPurchasePrice').value)||0;
  const unit=document.getElementById('pUnit')?.value.trim()||'';
  const weightPerPrice=isWeightUnit(unit) ? (parseInt(document.getElementById('pWeightPerPrice')?.value)||0) : 0;
  const noOfBoxes=Math.max(0,parseInt(document.getElementById('pNoOfBoxes').value)||0);
  const noOfPieces=Math.max(0,parseInt(document.getElementById('pNoOfPieces').value)||0);
  const piecesPerBox=Math.max(1,parseInt(document.getElementById('pPiecesPerBox').value)||1);
  const stock=calcTotalStock(noOfBoxes,noOfPieces,piecesPerBox);
  const editId=document.getElementById('pEditId').value;
  if(editId){
    const p=products.find(x=>x.id===parseInt(editId));
    if(p.purchasePrice !== purchasePrice) logPurchasePriceChange(p.name, purchasePrice);
    Object.assign(p,{name,price,price5,price10,stock,catId,emoji,image,description,sku,low,noOfBoxes,noOfPieces,piecesPerBox,gst,cgst,sgst,igst,hsn,location,cess,purchasePrice,unit,weightPerPrice});
    notify('Product updated!');
  } else {
    const existing = products.find(p=>p.name.toLowerCase()===name.toLowerCase());
    if(existing){
      showConfirmDelete('⚠️ Duplicate Product',
        `Product <strong>"${name}"</strong> already exists.<br>Add <strong>${stock} pcs</strong> to its stock instead?`,
        ()=>{
          existing.stock += stock; existing.lastPurchaseDate=_localDateStr();
          closeModal('productModal'); renderInventory(); saveAllData();
          notify(`✓ ${stock} pcs added to "${name}"`);
        }
      );
      return;
    }
    const newProd = {id:nextProdId++,name,price,price5,price10,stock,catId,emoji,image,description,sku,low,noOfBoxes,noOfPieces,piecesPerBox,gst,cgst,sgst,igst,hsn,location,cess,purchasePrice,lastPurchaseDate:'',unit,weightPerPrice};
    products.push(newProd);
    if(purchasePrice > 0) logPurchasePriceChange(name, purchasePrice);
    notify('Product added!');
    // Auto-generate QR/barcode if pending from scan (skip if QR already exists for same name)
    if(_pendingQrGen && !qrCodes.some(q => q.product_name && q.product_name.toLowerCase() === newProd.name.toLowerCase())){
      const mode = _pendingQrGen;
      _pendingQrGen = null;
      setTimeout(() => {
        saveQrCode({ sku: newProd.sku, product_name: newProd.name, product_id: newProd.id, qr_data: newProd.sku, barcode_type: mode });
      }, 100);
    } else if(_pendingQrGen){
      _pendingQrGen = null;
    }
  }
  closeModal('productModal'); renderInventory(); saveAllData();
}
function deleteProduct(id){
  const p=products.find(x=>x.id===id); if(!p) return;
  showConfirmDelete('🗑️ Delete Product',
    `Are you sure you want to delete <strong>"${p.name}"</strong>?<br><span style="font-size:12px;color:var(--muted);">Category: ${getCatName(p.catId)} · Price: ₹${fmt(p.price)} · Stock: ${p.stock} pcs<br>This action cannot be undone.</span>`,
    ()=>{ products=products.filter(x=>x.id!==id); renderInventory(); notify('Product deleted'); saveAllData(); }
  );
}

// ── PURCHASE PRICE HISTORY HELPERS ──────────────────────────────────────────
function logPurchasePriceChange(productName, newPrice, source='Price Update'){
  const existing = purchasePriceLog.filter(e => e.productName === productName);
  if(existing.length && existing[existing.length-1].purchasePrice === newPrice) return;
  purchasePriceLog.push({ productName, purchasePrice: newPrice, date: _localDateStr(), source });
}
function getPurchasePriceAtDate(productName, saleDate){
  // Find the log entry closest to (but not after) the sale date
  const logs = purchasePriceLog.filter(e => e.productName === productName && e.date <= saleDate);
  if(logs.length){
    logs.sort((a,b) => b.date.localeCompare(a.date));
    return logs[0].purchasePrice;
  }
  // Fallback to current product price
  const p = products.find(x => x.name === productName);
  return p ? p.purchasePrice : 0;
}

// ── MODAL TAB NAVIGATION ────────────────────────────────────────────────────
const modalFieldOrder=['pName','pCategoryText','pPrice','pPurchasePrice','pCGST','pSGST','pIGST','pCess','pHSN','pLocation','pSKU','pLowAlert','pPiecesPerBox','pDescription','pNoOfBoxes','pNoOfPieces'];

// ── Product Image Upload Helpers ────────────────────────────────────────────
function handleProductImageUpload(input){
  const file=input.files[0]; if(!file) return;
  if(file.size>5*1024*1024){ notify('Image too large (max 5MB)','error'); return; }
  const reader=new FileReader();
  reader.onload=function(e){
    const original=e.target.result;
    // Compress image to max 400x400 for storage efficiency
    const img=new Image();
    img.onload=function(){
      const canvas=document.createElement('canvas');
      const max=400;
      let w=img.width, h=img.height;
      if(w>max||h>max){ const r=Math.min(max/w,max/h); w=Math.round(w*r); h=Math.round(h*r); }
      canvas.width=w; canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      const compressed=canvas.toDataURL('image/jpeg',0.75);
      input._currentImage=compressed;
      // Show preview
      const previewImg=document.getElementById('pImgPreviewImg');
      const emojiEl=document.getElementById('pImgPreviewEmoji');
      previewImg.src=compressed; previewImg.style.display='block'; emojiEl.style.display='none';
      document.getElementById('pImgClearBtn').style.display='';
    };
    img.src=original;
  };
  reader.readAsDataURL(file);
}
function clearProductImage(){
  const fileInput=document.getElementById('pImageFile');
  fileInput.value=''; fileInput._currentImage='';
  document.getElementById('pImgPreviewImg').style.display='none';
  document.getElementById('pImgPreviewImg').src='';
  document.getElementById('pImgClearBtn').style.display='none';
  document.getElementById('pImgPreviewEmoji').style.display='';
}
function updateEmojiPreview(){
  // kept for compatibility, emoji is now hidden input
}
// ── Universal product icon helper ─────────────────────────────────────────
// Returns an <img> if product has image, otherwise the emoji span/text
function pIcon(p, sizePx){
  if(p && p.image){
    const s = sizePx || 24;
    return `<img src="${p.image}" alt="" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:${s<=28?4:8}px;vertical-align:middle;display:inline-block;">`;
  }
  return p ? (p.emoji || '📦') : '📦';
}
// kept for backward compat
function productIcon(p){
  return p && p.image
    ? `<img src="${p.image}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`
    : `<span style="font-size:28px;">${(p&&p.emoji)||'📦'}</span>`;
}

// ── Image Lightbox ────────────────────────────────────────────────────────
function openLightbox(src, name){
  const lb=document.getElementById('imgLightbox');
  document.getElementById('imgLightboxImg').src=src;
  document.getElementById('imgLightboxName').textContent=name||'';
  lb.style.display='flex';
  document.body.style.overflow='hidden';
}
function closeLightbox(){
  document.getElementById('imgLightbox').style.display='none';
  document.body.style.overflow='';
}
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeLightbox(); });
function modalTab(e,currentId){
  if(e.key==='Enter'||e.key==='Tab'){
    e.preventDefault();
    const idx=modalFieldOrder.indexOf(currentId);
    const next=modalFieldOrder[idx+1];
    if(next){const el=document.getElementById(next);if(el){el.focus();if(el.select)el.select();}}
  }
}

// Quick Add Product field order: name → category → price → ppb → emoji → gst
const qpFieldOrder=['qpName','qpCatText','qpPrice','qpPPB','qpCGST','qpSGST','qpIGST','qpDescription'];
function qpTab(e,currentId){
  if(e.key==='Enter'||e.key==='Tab'){
    e.preventDefault();
    const idx=qpFieldOrder.indexOf(currentId);
    const next=qpFieldOrder[idx+1];
    if(next){const el=document.getElementById(next);if(el){el.focus();if(el.select)el.select();}}
    else saveQuickProduct();
  }
}

// ── COMBO ENGINE ────────────────────────────────────────────────────────────
const _comboIdx={};

function comboOpen(wid){ document.getElementById(wid).classList.add('open'); _comboIdx[wid]=-1; }
function comboClose(wid){ const el=document.getElementById(wid); if(el) el.classList.remove('open'); }

function hlStr(text,q){
  if(!q) return text;
  const esc=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return text.replace(new RegExp('('+esc+')','gi'),'<span class="ac-hl">$1</span>');
}

function matchWords(text,q){
  if(!q) return true;
  const t=text.toLowerCase();
  const words=q.toLowerCase().trim().split(/\s+/);
  return words.every(w=>t.includes(w));
}

// Generic combo input renderer
// getItems(q) -> [{icon,main,sub,id,display,isCreate,...}]
function comboInput(wid, listId, getItems, hiddenId, onSelectExtra){
  const wrap=document.getElementById(wid);
  const input=wrap.querySelector('.combo-input');
  const list=document.getElementById(listId);
  const q=(input.value||'').trim().toLowerCase();
  const items=getItems(q);
  if(!items.length){ comboClose(wid); return; }
  list.innerHTML=items.map((it,i)=>{
    const icon=it.icon?`<span class="ci-icon">${it.icon}</span>`:'';
    const main=`<span class="ci-main">${hlStr(it.main,q)}</span>`;
    const sub=it.sub?`<span class="ci-sub">${it.sub}</span>`:'';
    const cls='combo-item'+(it.isCreate?' combo-create':'');
    return `<div class="${cls}" data-i="${i}"
      onmousedown="event.preventDefault();_comboSelect('${wid}','${listId}',${i})">
      ${icon}${main}${sub}
    </div>`;
  }).join('');
  list._items=items;
  list._hiddenId=hiddenId;
  list._onSelectExtra=onSelectExtra;
  comboOpen(wid);
}

function _comboSelect(wid, listId, idx){
  const list=document.getElementById(listId);
  const items=list._items||[];
  const it=items[idx]; if(!it) return;
  const wrap=document.getElementById(wid);
  const input=wrap.querySelector('.combo-input');
  const hiddenId=list._hiddenId;
  const onSelectExtra=list._onSelectExtra;
  if(it.isCreate){
    const name=input.value.trim().toUpperCase();
    const emoji='📂';
    categories.push({id:nextCatId++,name,emoji});
    const newCat=categories[categories.length-1];
    input.value=`${emoji} ${name}`;
    if(hiddenId) document.getElementById(hiddenId).value=newCat.id;
    refreshCategoryDropdowns();
    notify(`Category "${name}" created!`);
  } else {
    input.value=it.display||it.main;
    if(hiddenId&&it.id!==undefined) document.getElementById(hiddenId).value=it.id;
    if(onSelectExtra) onSelectExtra(it);
  }
  comboClose(wid);
  // Tab to next field
  if(wid==='pNameWrap') setTimeout(()=>document.getElementById('pCategoryText').focus(),50);
  else if(wid==='pCatWrap') setTimeout(()=>document.getElementById('pPrice').focus(),50);
}

function comboKey(e, wid, listId, hiddenId, onSelectExtra){
  const wrap=document.getElementById(wid);
  const list=document.getElementById(listId);
  const items=list._items||[];
  const isOpen=wrap.classList.contains('open');
  if(e.key==='ArrowDown'){
    e.preventDefault();
    if(!isOpen){ comboInput(wid,listId,list._getItems||(()=>[]),hiddenId,onSelectExtra); return; }
    _comboIdx[wid]=Math.min((_comboIdx[wid]||0)+1,items.length-1);
    _updateComboHi(listId,wid);
  } else if(e.key==='ArrowUp'){
    e.preventDefault();
    _comboIdx[wid]=Math.max((_comboIdx[wid]||0)-1,0);
    _updateComboHi(listId,wid);
  } else if(e.key==='Enter'){
    e.preventDefault();
    const idx=_comboIdx[wid]!=null?_comboIdx[wid]:0;
    if(isOpen&&items.length&&idx>=0){ _comboSelect(wid,listId,idx); }
    else {
      if(wid==='pNameWrap'){ const inp=wrap.querySelector('.combo-input'); inp.value=toTitleCase(inp.value); comboClose(wid); setTimeout(()=>document.getElementById('pCategoryText').focus(),50); }
      else if(wid==='pCatWrap'){ comboClose(wid); setTimeout(()=>document.getElementById('pPrice').focus(),50); }
    }
  } else if(e.key==='Escape'||e.key==='Tab'){ comboClose(wid); }
}

function _updateComboHi(listId,wid){
  const list=document.getElementById(listId);
  const si=_comboIdx[wid]!=null?_comboIdx[wid]:0;
  list.querySelectorAll('.combo-item').forEach((el,i)=>el.classList.toggle('hi',i===si));
}

// Close combos on outside click
document.addEventListener('click',e=>{
  document.querySelectorAll('.combo-wrap.open').forEach(wrap=>{
    if(!wrap.contains(e.target)) comboClose(wrap.id);
  });
});

// ── ITEM PROVIDERS ──────────────────────────────────────────────────────────
function getProductNameItems(q){
  if(!q) return [];
  return products.filter(p=>matchWords(p.name,q)).slice(0,8).map(p=>({
    icon:p.emoji, main:p.name, sub:getCatName(p.catId), id:p.id, display:p.name
  }));
}

function getCatItems(q){
  const text=document.getElementById('pCategoryText')?.value||'';
  const matches=categories.filter(c=>matchWords(c.name,(q||'')));
  const items=matches.map(c=>({icon:c.emoji,main:c.name,id:c.id,display:`${c.emoji} ${c.name}`}));
  const exact=matches.some(c=>c.name.toLowerCase()===(q||'').toLowerCase());
  if(text.trim()&&!exact) items.push({icon:'➕',main:`Create "${toTitleCase(text.trim())}"`,isCreate:true});
  return items;
}

function getQpCatItems(q){
  const text=document.getElementById('qpCatText')?.value||'';
  const matches=categories.filter(c=>matchWords(c.name,(q||'')));
  const items=matches.map(c=>({icon:c.emoji,main:c.name,id:c.id,display:`${c.emoji} ${c.name}`}));
  const exact=matches.some(c=>c.name.toLowerCase()===(q||'').toLowerCase());
  if(text.trim()&&!exact) items.push({icon:'➕',main:`Create "${toTitleCase(text.trim())}"`,isCreate:true});
  return items;
}

const _defaultUnits = ['pcs','kg','g','mg','litre','ml','m','cm','mm','box','pack','pair','set','dozen','ton','ft','inch'];
function getUnitItems(q){
  const text = document.getElementById('pUnit')?.value || '';
  const used = new Set(products.map(p => p.unit).filter(Boolean));
  const allUnits = [...new Set([..._defaultUnits, ...used])];
  const matches = allUnits.filter(u => matchWords(u, q||''));
  const items = matches.map(u => ({icon:'📏',main:u,display:u}));
  if(text.trim() && !matches.some(u => u.toLowerCase() === text.trim().toLowerCase())){
    items.push({icon:'➕',main:`Create "${text.trim()}"`,isCreate:true});
  }
  return items;
}

const _weightUnits = ['kg','g','gm','gms','gram','grams','kilogram','kilograms','mg','milligram','quintal','tonne','ton'];
function isWeightUnit(u){
  if(!u) return false;
  return _weightUnits.includes(u.toLowerCase().trim());
}
function getWeightBaseUnit(u){
  if(!u) return 'pcs';
  const lu = u.toLowerCase().trim();
  if(['kg','kilogram','kilograms'].includes(lu)) return 'kg';
  if(['g','gm','gms','gram','grams','mg','milligram'].includes(lu)) return 'gm';
  return lu;
}
function onUnitChange(){
  const unit = document.getElementById('pUnit')?.value?.trim() || '';
  const wt = isWeightUnit(unit);
  const base = getWeightBaseUnit(unit);
  const wppRow = document.getElementById('weightPerPriceRow');
  const boxesLabel = document.getElementById('pBoxesLabel');
  const piecesLabel = document.getElementById('pPiecesLabel');
  const ppbLabel = document.getElementById('pPPBLabel');
  const stockTitle = document.getElementById('stockSectionTitle');
  const priceLabel = document.getElementById('pPriceLabel');
  const ppLabel = document.getElementById('pPurchasePriceLabel');
  const boxesInput = document.getElementById('pNoOfBoxes');
  const piecesInput = document.getElementById('pNoOfPieces');
  const ppbInput = document.getElementById('pPiecesPerBox');
  if(wt){
    wppRow.style.display = '';
    if(base==='kg'){
      boxesLabel.textContent = 'in Kilograms';
      piecesLabel.textContent = 'in Grams';
      ppbLabel.textContent = 'Grams per Kg';
      boxesInput.placeholder = 'e.g. 5';
      piecesInput.placeholder = 'e.g. 500';
      ppbInput.placeholder = 'e.g. 1000';
    } else {
      boxesLabel.textContent = 'in '+unit.toUpperCase();
      piecesLabel.textContent = 'in Grams';
      ppbLabel.textContent = 'Grams per '+unit.toUpperCase();
      boxesInput.placeholder = 'e.g. 5';
      piecesInput.placeholder = 'e.g. 500';
      ppbInput.placeholder = 'e.g. 1000';
    }
    stockTitle.textContent = '⚖️ Weight Stock ('+base+')';
    priceLabel.textContent = 'Selling Price (₹) per [weight] *';
    ppLabel.textContent = 'Purchase Price (₹) per [weight]';
  } else {
    wppRow.style.display = 'none';
    boxesLabel.textContent = 'Number of Boxes';
    piecesLabel.textContent = 'Loose Pieces';
    ppbLabel.textContent = 'Pieces Per Box';
    boxesInput.placeholder = '0';
    piecesInput.placeholder = '0';
    ppbInput.placeholder = 'e.g. 45';
    stockTitle.textContent = '📦 Stock Quantity (boxes + loose pieces)';
    priceLabel.textContent = 'Selling Price (₹) *';
    ppLabel.textContent = 'Purchase Price (₹)';
  }
  autoCalcStock();
}

function getCustNameItems(q){
  if(!q) return [];
  const names=new Map();
  udhaarRecords.forEach(r=>names.set(r.name.toLowerCase(),{name:r.name,phone:r.phone||'',pending:r.totalPending}));
  advanceOrders.forEach(o=>{if(!names.has(o.custName.toLowerCase()))names.set(o.custName.toLowerCase(),{name:o.custName,phone:o.phone||'',pending:0});});
  sales.forEach(s=>{if(s.customerName&&!names.has(s.customerName.toLowerCase()))names.set(s.customerName.toLowerCase(),{name:s.customerName,phone:s.customerPhone||'',pending:0});});
  const all=[...names.values()];
  const filtered=all.filter(x=>matchWords(x.name,q));
  return filtered.map(x=>({
    icon:'👤', main:x.name, display:x.name,
    sub:x.pending>0?`⚠️ ₹${fmt(x.pending)} pending`:x.phone?`📞 ${x.phone}`:'',
    phone:x.phone, pending:x.pending
  }));
}

function selectAdvCust(it){
  if(it.phone&&document.getElementById('advPhone')) document.getElementById('advPhone').value=it.phone;
}

// ── CUSTOMER NAME COMBO (checkout) ─────────────────────────────────────────
function custNameInput(){
  const q=(document.getElementById('custName').value||'').trim().toLowerCase();
  const items=getCustNameItems(q);
  const list=document.getElementById('custNameList');
  if(!items.length){ comboClose('custNameWrap'); checkUdhaarWarn(); return; }
  list.innerHTML=items.map((it,i)=>`<div class="combo-item" onmousedown="event.preventDefault();selectCustNameItem('${it.main.replace(/'/g,"\\'")}','${(it.phone||'').replace(/'/g,"\\'")}')">
    <span class="ci-icon">${it.icon}</span>
    <span class="ci-main">${hlStr(it.main,q)}</span>
    <span class="ci-sub">${it.sub}</span>
  </div>`).join('');
  list._items=items;
  comboOpen('custNameWrap');
  checkUdhaarWarn();
}

function custNameKey(e){
  const list=document.getElementById('custNameList');
  const items=list._items||[];
  const wrap=document.getElementById('custNameWrap');
  const isOpen=wrap.classList.contains('open');
  if(e.key==='ArrowDown'){
    e.preventDefault();
    if(!isOpen){
      // If combo is closed, navigate to next checkout field
      const nextEl=getNextCheckoutField(document.getElementById('custName'));
      if(nextEl){nextEl.focus();return;}
    }
    _comboIdx['custNameWrap']=Math.min((_comboIdx['custNameWrap']||0)+1,items.length-1);
    list.querySelectorAll('.combo-item').forEach((el,i)=>el.classList.toggle('hi',i===(_comboIdx['custNameWrap']||0)));
  } else if(e.key==='ArrowUp'){
    e.preventDefault();
    if(!isOpen){
      const prevEl=getPrevCheckoutField(document.getElementById('custName'));
      if(prevEl){prevEl.focus();return;}
    }
    _comboIdx['custNameWrap']=Math.max((_comboIdx['custNameWrap']||0)-1,0);
    list.querySelectorAll('.combo-item').forEach((el,i)=>el.classList.toggle('hi',i===(_comboIdx['custNameWrap']||0)));
  } else if(e.key==='Enter'){
    e.preventDefault();
    const idx=_comboIdx['custNameWrap']||0;
    if(isOpen&&items.length&&idx>=0){
      const it=items[idx];
      selectCustNameItem(it.main,it.phone||'');
    } else { comboClose('custNameWrap'); document.getElementById('custPhone').focus(); }
  } else if(e.key==='Escape'||e.key==='Tab'){ comboClose('custNameWrap'); }
}

function selectCustNameItem(name,phone){
  document.getElementById('custName').value=name;
  if(phone) document.getElementById('custPhone').value=phone;
  comboClose('custNameWrap');
  checkUdhaarWarn();
}

// ── PHONE → CUSTOMER AUTO-FILL (checkout + advance) ─────────────────────────
let _custPhoneCache={sig:'',map:null};
function getPhoneToCustMap(){
  const s=sales[sales.length-1], u=udhaarRecords[udhaarRecords.length-1], a=advanceOrders[advanceOrders.length-1];
  const sig=sales.length+'|'+udhaarRecords.length+'|'+advanceOrders.length+'|'+(s?s.id:'')+'|'+(u?u.name:'')+'|'+(a?a.id:'');
  if(_custPhoneCache.sig===sig&&_custPhoneCache.map) return _custPhoneCache.map;
  const m=new Map();
  const add=(name,phone)=>{
    if(!name||!phone) return;
    const last10=phone.replace(/\D/g,'').slice(-10);
    if(last10.length===10&&!m.has(last10)) m.set(last10,name);
  };
  udhaarRecords.forEach(r=>add(r.name,r.phone||''));
  advanceOrders.forEach(o=>add(o.custName,o.phone||''));
  sales.forEach(s=>add(s.customerName,s.customerPhone||''));
  _custPhoneCache={sig,map:m};
  return m;
}
function custPhoneInput(){
  const nameEl=document.getElementById('custName');
  const phoneEl=document.getElementById('custPhone');
  if(!nameEl||!phoneEl) return;
  const clean=phoneEl.value.replace(/\D/g,'');
  if(clean.length<10) return;
  const name=getPhoneToCustMap().get(clean.slice(-10));
  if(name&&!(nameEl.value||'').trim().toLowerCase()){
    nameEl.value=name;
    checkUdhaarWarn();
  }
}
function advPhoneInput(){
  const nameEl=document.getElementById('advCustName');
  const phoneEl=document.getElementById('advPhone');
  if(!nameEl||!phoneEl) return;
  const clean=phoneEl.value.replace(/\D/g,'');
  if(clean.length<10) return;
  const name=getPhoneToCustMap().get(clean.slice(-10));
  if(name&&!(nameEl.value||'').trim().toLowerCase()) nameEl.value=name;
}

function checkUdhaarWarn(){
  const box=document.getElementById('udhaarWarnBox'); if(!box) return;
  const n=(document.getElementById('custName').value||'').trim().toLowerCase();
  if(!n){ box.innerHTML=''; return; }
  const rec=udhaarRecords.find(r=>r.name.toLowerCase()===n);
  if(rec&&rec.totalPending>0){
    const pct=Math.min(100,rec.totalBill>0?rec.totalPaid/rec.totalBill*100:0);
    box.innerHTML=`<div class="udhaar-warn">
      <div class="uw-title">⚠️ Existing Udhaar for ${rec.name}</div>
      <div class="uw-row"><span>Total Billed</span><span>₹${fmt(rec.totalBill)}</span></div>
      <div class="uw-row"><span>Amount Paid</span><span style="color:var(--green);">₹${fmt(rec.totalPaid)}</span></div>
      <div class="uw-row"><span>Pending</span><span style="color:var(--red);font-weight:600;">₹${fmt(rec.totalPending)}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;"></div></div>
      <div style="margin-top:10px;">
        <button class="btn btn-sm" id="includeUdhaarBtn" onclick="toggleIncludeUdhaar()" style="background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.4);font-size:11px;">
          + Include Previous Udhaar (₹${fmt(rec.totalPending)}) in this Bill
        </button>
        <span id="udhaarIncludedTag" style="display:none;font-size:11px;color:var(--green);margin-left:8px;">✓ Included</span>
      </div>
    </div>`;
    _udhaarIncluded=false;
    updateCheckoutTotal();
  } else { box.innerHTML=''; _udhaarIncluded=false; updateCheckoutTotal(); }
}

// ── PHONE VALIDATION ────────────────────────────────────────────────────────
function validatePhone(phone){
  const clean=phone.replace(/[\s\-\(\)]/g,'');
  return /^[6-9]\d{9}$/.test(clean);
}

// ── CHECKOUT FIELD KEYBOARD NAVIGATION ──────────────────────────────────────
// Checkout fields order: custName(0), custPhone(1), payType(2), ... then amount fields
const _checkoutFieldIds=['custName','custPhone'];

function checkoutFieldKeyNav(event, el){
  // Arrow key navigation between checkout fields
  const fieldIdx=parseInt(el.getAttribute('data-checkout-field')||'-1');
  if(event.key==='ArrowDown'||event.key==='Enter'){
    event.preventDefault();
    // Validate phone before moving
    if(el.id==='custPhone'){
      const val=el.value.trim();
      const payType=document.getElementById('payType').value;
      if(val&&!validatePhone(val)){
        el.style.borderColor='var(--red)';
        notify('Please enter a valid 10-digit phone number','error');
        return;
      } else { el.style.borderColor=''; }
    }
    // Move to next visible field
    const nextEl=getNextCheckoutField(el);
    if(nextEl) nextEl.focus();
  } else if(event.key==='ArrowUp'){
    event.preventDefault();
    const prevEl=getPrevCheckoutField(el);
    if(prevEl) prevEl.focus();
  }
}

function getNextCheckoutField(current){
  const allFields=getVisibleCheckoutFields();
  const idx=allFields.indexOf(current);
  return idx>=0&&idx<allFields.length-1?allFields[idx+1]:null;
}
function getPrevCheckoutField(current){
  const allFields=getVisibleCheckoutFields();
  const idx=allFields.indexOf(current);
  return idx>0?allFields[idx-1]:null;
}
function getVisibleCheckoutFields(){
  const modal=document.getElementById('checkoutModal');
  if(!modal) return [];
  const fields=[];
  modal.querySelectorAll('input:not([type=hidden]),select').forEach(el=>{
    if(el.offsetParent!==null&&!el.readOnly&&el.id!=='applyTaxChk'&&el.type!=='checkbox') fields.push(el);
  });
  return fields;
}
function toggleTheme(){
  const dark=document.documentElement.getAttribute('data-theme')==='dark';
  document.documentElement.setAttribute('data-theme',dark?'light':'dark');
  document.getElementById('themeLabel').textContent=dark?'☀️ Light':'🌙 Dark';
}
function updateClock(){
  const now = new Date();
  document.getElementById('clockDisplay').textContent=
    now.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · '+
    now.toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
  // Self-correcting: reschedule exactly at the next whole second boundary
  setTimeout(updateClock, 1000 - now.getMilliseconds());
}
updateClock();

// ── NOTIFY ──────────────────────────────────────────────────────────────────
function notify(msg,type='success'){
  const n=document.getElementById('notif');
  n.textContent=(type==='success'?'✓ ':'✕ ')+msg;
  n.className='notif show '+type;
  setTimeout(()=>n.className='notif',3000);
}

// ── NAVIGATION ──────────────────────────────────────────────────────────────
function navigate(page){
  // Clear inventory search when navigating away from inventory
  if(page!=='inventory'){
    _invSearch='';
    _invLowStockFilter=false; // reset low stock filter when leaving inventory
    const invEl=document.getElementById('invSearch');
    if(invEl) invEl.value='';
    const invAcList=document.getElementById('invAcList');
    if(invAcList) invAcList.style.display='none';
  }
  // Clear POS search when navigating away from POS
  if(page!=='pos'){
    _posSearch='';
    const posEl=document.getElementById('posSearch');
    if(posEl) posEl.value='';
    const posAcList=document.getElementById('posAcList');
    if(posAcList) posAcList.style.display='none';
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pg=document.getElementById('page-'+page);
  if(pg) pg.classList.add('active');
  const navEl=document.querySelector(`.nav-item[data-page="${page}"]`);
  if(navEl) navEl.classList.add('active');
  const renders={
    dashboard:renderDashboard, pos:renderPOS, advance:renderAdvanceOrders,
    inventory:renderInventory, categories:renderCategories,
    sales:renderSalesHistory, invhistory:renderInventoryHistory,
    udhaar:renderUdhaar, customers:renderCustomers, reports:renderReports,
    qr:renderQrPage, expenses:renderExpenses, defaults:renderDefaults,
    scanadd:renderScanAdd,
    notes:renderNotes,
    // gst_ui.js loads after this file, so renderGstPage does not exist yet at the
    // navigate('dashboard') call at the bottom of this file. typeof-guard it rather
    // than letting the whole render throw on a missing binding.
    gst: typeof renderGstPage==='function' ? renderGstPage : null
  };
  renders[page]?.();
  enhanceSelects();
}

// ── POS ─────────────────────────────────────────────────────────────────────
function renderPOS(){
  const catFilter=_posCatFilter||0;
  const filtered=products.filter(p=>matchWords(p.name,_posSearch)&&(!catFilter||p.catId===catFilter));
  const grid=document.getElementById('productGrid');
  if(!products.length){
    grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1;"><div class="big">📦</div><p>No products yet.</p><button class="btn btn-primary" onclick="navigate('inventory')">→ Inventory</button></div>`;
  } else if(!filtered.length){
    grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1;"><div class="big">🔍</div><p>No matching products.</p></div>`;
  } else {
    grid.innerHTML=filtered.map(p=>{
      const stockView=_posStockView[p.id]||'qty'; // 'qty' = boxes&pcs, 'pcs' = total pcs
      const stockLabel=p.stock===0?'Out of stock':
        stockView==='pcs'
          ? `${p.stock} pcs`
          : formatQty(p.noOfBoxes||0,p.noOfPieces||0)||`${p.stock} pcs`;
      const hasBoxes=(p.noOfBoxes||0)>0;
      return `
      <div class="product-tile" onclick="addToCart(${p.id})" style="${p.stock===0?'opacity:.4;pointer-events:none':''}" onmouseenter="startPosTileHover(event,${p.id})" onmouseleave="cancelPosTileHover()">
        <div style="font-size:28px;margin-bottom:8px;">${p.image?`<img src="${p.image}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px;">`:`<span>${p.emoji}</span>`}</div>
        <div class="p-name">${p.name}</div>
        <div class="p-price">${isWeightUnit(p.unit)&&p.weightPerPrice>0?`₹${fmt(p.price)}/<span style="font-size:10px;">${p.weightPerPrice}gm</span>`:`₹${fmt(p.price)}`}</div>
        <div class="p-stock${hasBoxes?' p-stock-toggle':''}" ${hasBoxes?`onclick="event.stopPropagation();togglePosStockView(${p.id})" title="Click to toggle view"`:''}>
          ${stockLabel}${hasBoxes&&p.stock>0?` <span style="font-size:9px;opacity:.5;">🔄</span>`:''}
        </div>
        ${p.gst?`<div style="font-size:9px;color:var(--accent2);margin-top:2px;">${p.cgst>0&&p.sgst>0?'CGST '+p.cgst+'% / SGST '+p.sgst+'%':p.igst>0?'IGST '+p.igst+'%':'GST '+p.gst+'%'}</div>`:''}
        ${p.hsn?`<div style="font-size:8px;color:var(--muted);margin-top:1px;">HSN:${p.hsn}</div>`:''}
        ${p.purchasePrice?`<div style="font-size:8px;color:var(--muted);margin-top:1px;">PC:₹${fmt(p.purchasePrice)}</div>`:''}
        ${p.description?`<div class="p-desc" style="font-size:10px;color:var(--muted);margin-top:4px;display:none;line-height:1.4;text-align:center;">${p.description.slice(0,100)}${p.description.length>100?'...':''}</div>`:''}
      </div>`;
    }).join('');
  }
  renderCart();
}


// ── POS Tile Hover Tooltip ──────────────────────────────────────────────────
let _posTileHoverTimer = null;
let _posTileTooltip = null;

function startPosTileHover(event, productId){
  cancelPosTileHover();
  const tile = event.currentTarget;
  _posTileHoverTimer = setTimeout(() => {
    const p = products.find(x => x.id === productId);
    if(!p) return;
    // Remove existing
    if(_posTileTooltip) _posTileTooltip.remove();
    const tip = document.createElement('div');
    tip.id = 'posTileTooltip';
    tip.className = 'pos-tile-tooltip';
    const cat = categories.find(x => x.id === p.catId);
    const stockStr = formatQty(p.noOfBoxes||0, p.noOfPieces||0) || `${p.stock} pcs`;
    tip.innerHTML = `
      <div style="display:flex;gap:12px;align-items:flex-start;">
        ${p.image
          ? `<img src="${p.image}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;flex-shrink:0;">`
          : `<div style="width:64px;height:64px;display:flex;align-items:center;justify-content:center;font-size:36px;background:var(--surface2);border-radius:8px;flex-shrink:0;">${p.emoji||'📦'}</div>`
        }
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px;">${p.name}</div>
          ${cat ? `<div style="font-size:11px;color:var(--accent2);margin-bottom:6px;">${cat.emoji||''} ${cat.name}</div>` : ''}
          ${p.description ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px;line-height:1.5;">${p.description}</div>` : ''}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;font-size:11px;">
            <span style="color:var(--muted);">Price</span><span style="color:var(--accent);font-weight:600;">₹${fmt(p.price)}/pc</span>
            ${p.purchasePrice ? `<span style="color:var(--muted);">Purchase Price</span><span style="color:var(--muted);">₹${fmt(p.purchasePrice)}/pc</span>` : ''}
            ${p.gst ? `<span style="color:var(--muted);">GST</span><span style="color:var(--accent2);">${p.cgst>0&&p.sgst>0?'CGST '+p.cgst+'% + SGST '+p.sgst+'%':p.igst>0?'IGST '+p.igst+'%':p.gst+'%'}</span>` : ''}
            <span style="color:var(--muted);">Stock</span><span style="color:${p.stock===0?'var(--red)':'var(--green)'};">${stockStr}</span>
            ${p.piecesPerBox ? `<span style="color:var(--muted);">Per Box</span><span>${p.piecesPerBox} pcs</span>` : ''}
            ${p.sku ? `<span style="color:var(--muted);">SKU</span><span>${p.sku}</span>` : ''}
            ${p.location ? `<span style="color:var(--muted);">Location</span><span>${p.location}</span>` : ''}
            ${p.lastPurchaseDate ? `<span style="color:var(--muted);">Last Purchase</span><span>${p.lastPurchaseDate.slice(0,10)}</span>` : ''}
          </div>
        </div>
      </div>`;
    document.body.appendChild(tip);
    _posTileTooltip = tip;
    // Position near tile
    const rect = tile.getBoundingClientRect();
    const tipW = 280;
    let left = rect.right + 10;
    if(left + tipW > window.innerWidth) left = rect.left - tipW - 10;
    let top = rect.top;
    if(top + tip.offsetHeight > window.innerHeight) top = window.innerHeight - tip.offsetHeight - 10;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }, 500);
}

function cancelPosTileHover(){
  clearTimeout(_posTileHoverTimer);
  if(_posTileTooltip){ _posTileTooltip.remove(); _posTileTooltip = null; }
}

function handleBarcodeScan(code){
  const input=document.getElementById('posBarcodeScan');
  if(input) input.value='';
  if(!code.trim()) return;
  const q=code.trim().toLowerCase();
  // Look up by SKU, qr_data (from QR history), or name
  let p=products.find(x=>x.sku.toLowerCase()===q);
  if(!p) p=products.find(x=>(x.qr_data||'').toLowerCase()===q);
  if(!p) p=products.find(x=>x.name.toLowerCase()===q);
  if(!p){ notify(`Product not found for barcode: ${code.trim()}`,'error'); return; }
  // Use addToCart if it exists and product has stock
  if(typeof addToCart==='function'){ addToCart(p.id); }
  else { notify('Cannot add to cart','error'); }
  setTimeout(()=>{if(input) input.focus();},100);
}

function filterPOSAndAC(v){
  _posSearch=v.toLowerCase();
  renderPOS();
  const list=document.getElementById('posAcList');
  if(!v.trim()){ list.style.display='none'; return; }
  const q=v.toLowerCase();
  const matches=products.filter(p=>matchWords(p.name,q)&&p.stock>0).slice(0,7);
  if(!matches.length){ list.style.display='none'; return; }
  list.innerHTML=matches.map(p=>`<div class="autocomplete-item" onmousedown="event.preventDefault();addToCartByName('${p.name.replace(/'/g,"\\'")}');">
    <span class="ai-icon">${p.image?`<img src="${p.image}" style="width:22px;height:22px;object-fit:cover;border-radius:4px;vertical-align:middle;">`:p.emoji}</span>
    <span class="ai-name">${hlStr(p.name,q)}</span>
    <span class="ai-sub">₹${fmt(p.price)} · ${formatQty(p.noOfBoxes||0,p.noOfPieces||0)}</span>
  </div>`).join('');
  list.style.display='block';
}

function filterPOSCatAC(v){
  const list=document.getElementById('posCatAcList');
  const q=v.trim().toLowerCase();
  let matches=categories.filter(c=>matchWords(c.name,q));
  if(!matches.length && !q){ matches=[...categories]; }
  if(!matches.length){ list.style.display='none'; return; }
  list.innerHTML=`<div class="autocomplete-item" onmousedown="event.preventDefault();_posCatFilter=0;document.getElementById('posCatInput').value='';renderPOS();document.getElementById('posCatAcList').style.display='none';">
    <span class="ai-icon">📋</span><span class="ai-name">All Categories</span>
  </div>`+matches.map(c=>`<div class="autocomplete-item" onmousedown="event.preventDefault();_posCatFilter=${c.id};document.getElementById('posCatInput').value='${(c.emoji+' '+c.name).replace(/'/g,"\\'")}';renderPOS();document.getElementById('posCatAcList').style.display='none';">
    <span class="ai-icon">${c.emoji}</span><span class="ai-name">${hlStr(c.name,q)}</span>
  </div>`).join('');
  list.style.display='block';
}

function addToCartByName(name){
  const p=products.find(x=>x.name===name);
  if(p) addToCart(p.id);
  document.getElementById('posAcList').style.display='none';
}

function renderScanAdd(){
  const el = document.getElementById('scanAddInput');
  if(el) el.value = '';
  document.getElementById('scanAddResult').style.display = 'none';
  document.getElementById('scanAddNotFound').style.display = 'none';
  // Restore remembered QR auto-gen settings (with 24h expiry check)
  const settingsDiv = document.getElementById('scanAddQrSettings');
  if(settingsDiv) settingsDiv.style.display = '';
  const remembered = localStorage.getItem('_qrAutoGen');
  const rememberedType = localStorage.getItem('_qrAutoGenType');
  if(remembered && (Date.now() - parseInt(remembered)) < 86400000 && rememberedType && rememberedType !== 'none'){
    const chk = document.getElementById('scanAutoRemember');
    if(chk) chk.checked = true;
    const radios = document.querySelectorAll('input[name="scanQrChoice"]');
    radios.forEach(r => { if(r.value === rememberedType) r.checked = true; });
  } else {
    localStorage.removeItem('_qrAutoGen');
    localStorage.removeItem('_qrAutoGenType');
  }
  setTimeout(() => { if(el) el.focus(); }, 150);
}

let _lastScannedCode = '';
let _scanAddTimer = null;
function scanAddDebounce(el){
  clearTimeout(_scanAddTimer);
  _scanAddTimer = setTimeout(() => {
    if(el.value.trim()) handleScanAdd(el.value);
  }, 250);
}

function handleScanAdd(code){
  code = code.trim();
  if(!code) return;
  const p = products.find(x => x.sku === code) || products.find(x => x.name.toLowerCase() === code.toLowerCase());
  const resultDiv = document.getElementById('scanAddResult');
  const notFoundDiv = document.getElementById('scanAddNotFound');
  if(p){
    notFoundDiv.style.display = 'none';
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `
      <div style="text-align:center;padding:16px 0;">
        <div style="font-size:40px;margin-bottom:8px;">✅</div>
        <div style="font-size:16px;font-weight:600;">${escHtml(p.name)}</div>
        <div style="font-size:13px;color:var(--muted);margin:4px 0;">SKU: ${escHtml(p.sku||'—')} · ₹${fmt(p.price)} · Stock: ${p.stock}</div>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">
          <button class="btn btn-primary" onclick="scanAddToCart(${p.id})">🛒 Add to Cart</button>
          <button class="btn btn-ghost" onclick="openEditProduct(${p.id})">✏️ Edit</button>
        </div>
      </div>`;
    document.getElementById('scanAddInput').value = '';
  } else {
    resultDiv.style.display = 'none';
    notFoundDiv.style.display = 'block';
    _lastScannedCode = code;
  }
}

function scanAddToCart(id){
  addToCart(id);
  document.getElementById('scanAddResult').style.display = 'none';
  notify('✅ Added to cart');
}

let _pendingQrGen = null;

function scanAddAsNewProduct(){
  if(!_lastScannedCode) return;
  // Save remember setting
  const rememberChk = document.getElementById('scanAutoRemember');
  if(rememberChk && rememberChk.checked){
    const selected = document.querySelector('input[name="scanQrChoice"]:checked');
    if(selected){
      localStorage.setItem('_qrAutoGen', Date.now());
      localStorage.setItem('_qrAutoGenType', selected.value);
    }
  }
  // Determine QR auto-gen preference
  const autoRemember = localStorage.getItem('_qrAutoGen');
  if(autoRemember){
    const autoType = localStorage.getItem('_qrAutoGenType');
    if(autoType && autoType !== 'none') _pendingQrGen = autoType;
  }
  openAddProduct({ sku: _lastScannedCode, name: '' });
  document.getElementById('scanAddNotFound').style.display = 'none';
  document.getElementById('scanAddInput').value = '';
}

// ── EXPENSES ─────────────────────────────────────────────────────────────────
let _expFilter = 'all';
let _expCatFilter = '';

function calcExpenses(salesArr){
  if(!salesArr) return 0;
  return expenses.reduce((a,e)=>{
    return a + (Number(e.amount)||0);
  }, 0);
}

function calcPeriodExpenses(fromDate, toDate){
  return expenses.reduce((a,e)=>{
    const d = new Date(e.date);
    if(fromDate && d < fromDate) return a;
    if(toDate && d > toDate) return a;
    return a + (Number(e.amount)||0);
  }, 0);
}

function calcNetProfit(salesArr){
  return calcProfit(salesArr) - calcExpenses(salesArr);
}

function openAddExpense(){
  const existing=document.getElementById('expenseModalBg');
  if(existing) existing.remove();
  const bg=document.createElement('div');
  bg.id='expenseModalBg';
  bg.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  const today=_localDateStr().slice(0,10);
  bg.innerHTML=`<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;width:440px;max-width:92vw;max-height:90vh;overflow-y:auto;animation:popIn .2s ease;">
    <div style="font-size:20px;font-weight:700;font-family:var(--font-head);margin-bottom:20px;">💸 Add Expense</div>
    <div class="form-group" style="margin-bottom:14px;">
      <label>Expense Name</label>
      <input id="expModalName" placeholder="e.g. Rent, Electricity, Staff salary..." style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);">
    </div>
    <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
      <div class="form-group" style="margin:0;">
        <label>Amount (₹)</label>
        <input id="expModalAmt" type="number" min="0" step="0.01" placeholder="0" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);">
      </div>
      <div class="form-group" style="margin:0;">
        <label>Category</label>
        <input id="expModalCat" placeholder="e.g. Rent, Utilities" list="expCatSuggestions" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);">
        <datalist id="expCatSuggestions"><option value="Rent"><option value="Utilities"><option value="Salary"><option value="Transport"><option value="Marketing"><option value="Maintenance"><option value="Office"><option value="Other"></datalist>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:14px;">
      <label>Date</label>
      <input id="expModalDate" type="text" data-calendar value="${today}" readonly placeholder="Select date..." style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);cursor:pointer;">
    </div>
    <div class="form-group" style="margin-bottom:14px;">
      <label>Photo (optional)</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="file" id="expModalPhoto" accept="image/*" onchange="handleExpensePhotoUpload(this)" style="display:none;">
        <button class="btn btn-ghost" onclick="document.getElementById('expModalPhoto').click()" style="font-size:12px;">📷 Attach Photo</button>
        <div id="expPhotoPreview" style="display:none;position:relative;">
          <img id="expPhotoImg" style="max-width:60px;max-height:60px;border-radius:8px;border:1px solid var(--border);">
          <button onclick="clearExpensePhoto()" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:var(--red);color:#fff;border:none;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
        </div>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:20px;">
      <label>Notes (optional)</label>
      <textarea id="expModalNotes" placeholder="Any additional details..." style="width:100%;min-height:60px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface1);color:var(--text);resize:vertical;font-family:inherit;"></textarea>
    </div>
    <div class="modal-actions" style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn btn-ghost" onclick="this.closest('#expenseModalBg').remove()">Cancel</button>
      <button class="btn btn-primary" onclick="saveExpenseFromModal()">💸 Save Expense</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  setTimeout(()=>{
    document.getElementById('expModalName').focus();
    const dateEl=document.getElementById('expModalDate');
    if(dateEl) calBind(dateEl);
  },100);
}

function saveExpenseFromModal(){
  const name=document.getElementById('expModalName').value.trim();
  const amount=parseFloat(document.getElementById('expModalAmt').value)||0;
  const category=document.getElementById('expModalCat').value.trim();
  const dateEl=document.getElementById('expModalDate');
  const date=dateEl?._val||dateEl?.value||'';
  const notes=document.getElementById('expModalNotes').value.trim();
  const photo=document.getElementById('expPhotoImg')?.src||'';
  if(!name){notify('Enter expense name','error');return;}
  if(amount<=0){notify('Enter valid amount','error');return;}
  const id='EXP-'+String(_nextExpId++);
  expenses.unshift({id,name,amount,category,notes,date:date?date+'T00:00:00':_localDateStr(),photo:photo||undefined});
  document.getElementById('expenseModalBg').remove();
  renderExpenses();
  saveAllData();
  notify('💸 Expense added: ₹'+fmt(amount));
}

function handleExpensePhotoUpload(input){
  const file=input.files[0]; if(!file) return;
  if(file.size>5*1024*1024){ notify('Image too large (max 5MB)','error'); return; }
  const reader=new FileReader();
  reader.onload=function(e){
    const img=new Image();
    img.onload=function(){
      const canvas=document.createElement('canvas');
      const max=600;
      let w=img.width, h=img.height;
      if(w>max||h>max){ const r=Math.min(max/w,max/h); w=Math.round(w*r); h=Math.round(h*r); }
      canvas.width=w; canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      const compressed=canvas.toDataURL('image/jpeg',0.7);
      document.getElementById('expPhotoImg').src=compressed;
      document.getElementById('expPhotoPreview').style.display='block';
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}
function clearExpensePhoto(){
  document.getElementById('expModalPhoto').value='';
  document.getElementById('expPhotoImg').src='';
  document.getElementById('expPhotoPreview').style.display='none';
}

function deleteExpense(id){
  if(!confirm('Delete this expense?'))return;
  expenses=expenses.filter(e=>e.id!==id);
  renderExpenses();
  saveAllData();
  notify('Expense deleted');
}

function editExpense(id){
  const e=expenses.find(x=>x.id===id);
  if(!e) return;
  const existing=document.getElementById('expenseModalBg');
  if(existing) existing.remove();
  const bg=document.createElement('div');
  bg.id='expenseModalBg';
  bg.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  bg.onclick=ev=>{if(ev.target===bg)bg.remove();};
  const expDate=e.date?e.date.slice(0,10):'';
  const photoHtml=e.photo?`<div id="expPhotoPreview" style="display:block;position:relative;"><img id="expPhotoImg" src="${e.photo}" style="max-width:60px;max-height:60px;border-radius:8px;border:1px solid var(--border);"><button onclick="clearExpensePhoto()" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:var(--red);color:#fff;border:none;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button></div>`:`<div id="expPhotoPreview" style="display:none;"><img id="expPhotoImg" style="max-width:60px;max-height:60px;border-radius:8px;border:1px solid var(--border);"><button onclick="clearExpensePhoto()" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:var(--red);color:#fff;border:none;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button></div>`;
  bg.innerHTML=`<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;width:440px;max-width:92vw;max-height:90vh;overflow-y:auto;animation:popIn .2s ease;">
    <div style="font-size:20px;font-weight:700;font-family:var(--font-head);margin-bottom:20px;">✏️ Edit Expense</div>
    <div class="form-group" style="margin-bottom:14px;">
      <label>Expense Name</label>
      <input id="expModalName" value="${escHtml(e.name||e.title||'')}" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);">
    </div>
    <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
      <div class="form-group" style="margin:0;">
        <label>Amount (₹)</label>
        <input id="expModalAmt" type="number" min="0" step="0.01" value="${e.amount}" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);">
      </div>
      <div class="form-group" style="margin:0;">
        <label>Category</label>
        <input id="expModalCat" value="${escHtml(e.category)}" list="expCatSuggestions" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);">
        <datalist id="expCatSuggestions"><option value="Rent"><option value="Utilities"><option value="Salary"><option value="Transport"><option value="Marketing"><option value="Maintenance"><option value="Office"><option value="Other"></datalist>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:14px;">
      <label>Date</label>
      <input id="expModalDate" type="text" data-calendar value="${expDate}" readonly placeholder="Select date..." style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);cursor:pointer;">
    </div>
    <div class="form-group" style="margin-bottom:14px;">
      <label>Photo (optional)</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="file" id="expModalPhoto" accept="image/*" onchange="handleExpensePhotoUpload(this)" style="display:none;">
        <button class="btn btn-ghost" onclick="document.getElementById('expModalPhoto').click()" style="font-size:12px;">📷 ${e.photo?'Change':'Attach'} Photo</button>
        ${photoHtml}
      </div>
    </div>
    <div class="form-group" style="margin-bottom:20px;">
      <label>Notes</label>
      <textarea id="expModalNotes" style="width:100%;min-height:60px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface1);color:var(--text);resize:vertical;font-family:inherit;">${escHtml(e.notes)}</textarea>
    </div>
    <div class="modal-actions" style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn btn-ghost" onclick="this.closest('#expenseModalBg').remove()">Cancel</button>
      <button class="btn btn-primary" onclick="updateExpenseFromModal('${escHtml(e.id)}')">✓ Save</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  setTimeout(()=>{
    const dateEl=document.getElementById('expModalDate');
    if(dateEl) calBind(dateEl);
  },100);
}

function updateExpenseFromModal(id){
  const e=expenses.find(x=>x.id===id);
  if(!e) return;
  const name=document.getElementById('expModalName').value.trim();
  const amount=parseFloat(document.getElementById('expModalAmt').value)||0;
  const category=document.getElementById('expModalCat').value.trim();
  const dateEl=document.getElementById('expModalDate');
  const date=dateEl?._val||dateEl?.value||'';
  const notes=document.getElementById('expModalNotes').value.trim();
  const photoEl=document.getElementById('expPhotoImg');
  const photo=photoEl?.src||'';
  if(!name||amount<=0){notify('Fill name and amount','error');return;}
  e.name=name;e.amount=amount;e.category=category;e.notes=notes;
  if(date) e.date=date+'T00:00:00';
  e.photo=photo||undefined;
  document.getElementById('expenseModalBg').remove();
  renderExpenses();
  saveAllData();
}

function renderExpenses(){
  const wrap=document.getElementById('expensesWrap');
  const totalEl=document.getElementById('expTotal');
  if(!wrap) return;
  const total=expenses.reduce((a,e)=>a+(Number(e.amount)||0),0);
  if(totalEl) totalEl.textContent='Total: ₹'+fmt(total);
  if(!expenses.length){
    wrap.innerHTML='<div class="empty-state" style="padding:30px 0;"><div class="big">💸</div><p>No expenses yet. Click "Add Expense" to start tracking.</p></div>';
    return;
  }
  // Group by category
  const catTotals={};
  expenses.forEach(e=>{const c=e.category||'Uncategorized';catTotals[c]=(catTotals[c]||0)+(Number(e.amount)||0);});
  const catHtml=Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c,a])=>`<span style="display:inline-flex;gap:4px;align-items:center;background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;"><span style="font-weight:600;">${escHtml(c)}</span> <span style="color:var(--red);">₹${fmt(a)}</span></span>`).join('');
  let html=`<div style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:6px;">${catHtml}</div>`;
  html+=`<table><thead><tr><th>Name</th><th>Category</th><th>Amount</th><th>Date</th><th>Notes</th><th>Photo</th><th style="width:80px;">Actions</th></tr></thead><tbody>`;
  expenses.forEach(e=>{
    const d=e.date?new Date(e.date):null;
    const invMatch=e.notes?.match(/INV:\s*(INV-\d+)/);
    const invExists=invMatch?inventoryHistory.some(entry=>entry.id===invMatch[1]):false;
    html+=`<tr${invExists?` onclick="scrollToInvEntry('${invMatch[1]}')" style="cursor:pointer;"`:''}>
      <td style="font-weight:600;">${escHtml(e.name||e.title||'Transport')}</td>
      <td><span style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:2px 10px;font-size:11px;">${escHtml(e.category||'—')}</span></td>
      <td style="color:var(--red);font-weight:600;">₹${fmt(e.amount)}</td>
      <td style="color:var(--muted);font-size:12px;">${d?d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):'—'}</td>
      <td style="color:var(--muted);font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(e.notes||'')}</td>
      <td>${e.photo?`<img src="${e.photo}" style="width:32px;height:32px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--border);" onclick="window.open('${e.photo}','_blank')" title="View photo">`:''}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost" style="font-size:14px;padding:2px 6px;" onclick="editExpense('${escHtml(e.id)}')" title="Edit">✏️</button>
        <button class="btn btn-ghost" style="font-size:14px;padding:2px 6px;color:var(--red);" onclick="deleteExpense('${escHtml(e.id)}')" title="Delete">🗑️</button>
      </td>
    </tr>`;
  });
  html+='</tbody></table>';
  wrap.innerHTML=html;
}
// ── END EXPENSES ──

// ── BY DEFAULT SETTINGS ──────────────────────────────────────────────────────
let _defaults = {};
const _defFields = [
  { key:'cgst',       label:'CGST %',            type:'number', step:'0.01', min:0, max:100, placeholder:'0' },
  { key:'sgst',       label:'SGST %',            type:'number', step:'0.01', min:0, max:100, placeholder:'0' },
  { key:'igst',       label:'IGST %',            type:'number', step:'0.01', min:0, max:100, placeholder:'0' },
  { key:'cess',       label:'Cess %',            type:'number', step:'0.01', min:0, max:100, placeholder:'0' },
  { key:'hsn',        label:'HSN / SAC Code',    type:'text',   placeholder:'e.g. 0405' },
  { key:'location',   label:'Location (shelf/rack)', type:'text', placeholder:'e.g. Aisle 3' },
  { key:'low',        label:'Low Stock Alert',   type:'number', step:'1', min:0, placeholder:'10' },
  { key:'ppb',        label:'Pieces Per Box',    type:'number', step:'1', min:1, placeholder:'1' },
  { key:'purchasePrice', label:'Purchase Price (₹)', type:'number', step:'0.01', min:0, placeholder:'0.00' },
  { key:'category',   label:'Default Category',  type:'category' },
  { key:'description',label:'Description',       type:'text',   placeholder:'e.g. 500g pack, Amul butter' },
  { key:'payMethod',  label:'Default Payment Method', type:'select', options:['Cash','UPI','Card','Credit'] },
  { key:'showUnsold', label:'Include unsold products in Reports', type:'toggle' },
];

function renderDefaults(){
  const wrap=document.getElementById('defaultsWrap');
  if(!wrap) return;
  wrap.innerHTML=_defFields.map(f=>{
    const on=_defaults[f.key+'_on'];
    let input='';
    if(f.type==='select'){
      input=`<select id="def_${f.key}" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);color:var(--text);font-size:13px;${on?'':'opacity:.4;pointer-events:none;'}">
        ${f.options.map(o=>`<option value="${o}"${_defaults[f.key]===o?' selected':''}>${o}</option>`).join('')}
      </select>`;
    } else if(f.type==='category'){
      const catVal=_defaults[f.key]||'';
      const cat=catVal?categories.find(c=>String(c.id)===String(catVal)):null;
      input=`<div class="combo-wrap" id="def_catWrap" style="position:relative;${on?'':'opacity:.4;pointer-events:none;'}">
        <input id="def_categoryText" class="combo-input" value="${cat?cat.emoji+' '+cat.name:''}" placeholder="Type to select..." autocomplete="off" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);color:var(--text);font-size:13px;width:100%;"
          oninput="comboInput('def_catWrap','def_catList',getDefCatItems,'def_category',null)"
          onkeydown="comboKey(event,'def_catWrap','def_catList','def_category',null)">
        <input type="hidden" id="def_category" value="${catVal}">
        <div class="combo-list" id="def_catList"></div>
      </div>`;
    } else {
      const attrs=[
        `id="def_${f.key}"`, `type="${f.type}"`, `value="${_defaults[f.key]||''}"`,
        `placeholder="${f.placeholder||''}"`, `style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);color:var(--text);font-size:13px;${on?'':'opacity:.4;pointer-events:none;'}"`
      ];
      if(f.min!=null) attrs.push(`min="${f.min}"`);
      if(f.max!=null) attrs.push(`max="${f.max}"`);
      if(f.step) attrs.push(`step="${f.step}"`);
      input=`<input ${attrs.join(' ')}>`;
    }
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border);">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;min-width:120px;">
        <input type="checkbox" id="def_${f.key}${f.type==='toggle'?'':'_on'}" ${f.type==='toggle'?(_defaults[f.key]?'checked':''):(on?'checked':'')} onchange="${f.type==='toggle'?`_defaults['${f.key}']=this.checked;`:`_defaults['${f.key}_on']=this.checked;renderDefaults();`}" style="width:16px;height:16px;accent-color:var(--accent);">
        <span style="font-weight:${(f.type==='toggle'?_defaults[f.key]:on)?'600':'400'};color:${(f.type==='toggle'?_defaults[f.key]:on)?'var(--text)':'var(--muted)'};">${f.label}</span>
      </label>
      ${f.type==='toggle'?'':`<div style="flex:1;">${input}</div>`}
    </div>`;
  }).join('');
}

function getDefCatItems(){
  return categories.map(c=>({value:String(c.id),label:c.emoji+' '+c.name}));
}

function saveDefaults(){
  _defFields.forEach(f=>{
    if(f.type==='toggle'){
      const el=document.getElementById('def_'+f.key);
      _defaults[f.key]=el?el.checked:false;
    } else {
      const on=document.getElementById('def_'+f.key+'_on');
      _defaults[f.key+'_on']=on?on.checked:false;
      if(f.type==='category'){
        const el=document.getElementById('def_category');
        _defaults[f.key]=el?el.value:'';
      } else if(f.type==='select'){
        const el=document.getElementById('def_'+f.key);
        _defaults[f.key]=el?el.value:'';
      } else {
        const el=document.getElementById('def_'+f.key);
        _defaults[f.key]=f.type==='number'?(parseFloat(el?.value)||0):(el?.value||'');
      }
    }
  });
  const msg=document.getElementById('defSaveMsg');
  if(msg){msg.textContent='✓ Saved'; setTimeout(()=>msg.textContent='',2000);}
  saveAllData();
  notify('Defaults saved');
}

function getDefVal(key, existingVal){
  if(existingVal!=null && existingVal!=='' && existingVal!==0) return existingVal;
  if(!_defaults[key+'_on']) return existingVal;
  return _defaults[key] ?? existingVal;
}
// ── END DEFAULTS ──

// ── NOTES ─────────────────────────────────────────────────────────────────────
function renderNotes(){
  const wrap = document.getElementById('notesWrap');
  if(!wrap) return;
  if(!notes.length){
    wrap.innerHTML = '<div class="empty-state" style="padding:30px 0;"><div class="big">📝</div><p>No notes yet. Click "Add Note" to create one.</p></div>';
    return;
  }
  const colors=['#2d1b4e','#1b3a2d','#3a2a1b','#1b2d3a','#3a1b2d'];
  wrap.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">${
    notes.map((n, i) => `
    <div style="background:${colors[i%colors.length]};border-radius:12px;padding:20px;display:flex;flex-direction:column;min-height:160px;position:relative;transition:transform .2s,box-shadow .2s;border:1px solid rgba(255,255,255,.08);" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,.3)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
        <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.3;word-break:break-word;">${escHtml(n.title || 'Untitled')}</div>
        <div style="display:flex;gap:4px;flex-shrink:0;margin-left:8px;">
          <button class="btn btn-ghost" style="font-size:14px;padding:2px 6px;background:rgba(255,255,255,.1);border:none;border-radius:6px;color:#fff;cursor:pointer;line-height:1;" onclick="editNotePrompt('${escHtml(n.id)}')" title="Edit">✏️</button>
          <button class="btn btn-ghost" style="font-size:14px;padding:2px 6px;background:rgba(255,255,255,.1);border:none;border-radius:6px;color:#f87171;cursor:pointer;line-height:1;" onclick="deleteNote('${escHtml(n.id)}')" title="Delete">🗑️</button>
        </div>
      </div>
      ${n.content?`<div style="font-size:13px;color:rgba(255,255,255,.7);white-space:pre-wrap;line-height:1.6;flex:1;word-break:break-word;">${escHtml(n.content)}</div>`:''}
      <div style="font-size:10px;color:rgba(255,255,255,.35);margin-top:12px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px;">${n.updatedAt ? new Date(n.updatedAt).toLocaleString() : ''}</div>
    </div>
  `).join('')}</div>`;
}

function addNote(){
  showNoteModal(null);
}

function editNotePrompt(id){
  const n = notes.find(x => x.id === id);
  if(!n) return;
  showNoteModal(n);
}

function showNoteModal(note){
  const existing=document.getElementById('noteModalBg');
  if(existing) existing.remove();
  const bg=document.createElement('div');
  bg.id='noteModalBg';
  bg.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  bg.innerHTML=`<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;width:440px;max-width:92vw;max-height:90vh;overflow-y:auto;animation:popIn .2s ease;">
    <div style="font-size:20px;font-weight:700;font-family:var(--font-head);margin-bottom:20px;">${note?'✏️ Edit Note':'➕ New Note'}</div>
    <div class="form-group" style="margin-bottom:14px;">
      <label>Title</label>
      <input id="noteModalTitle" placeholder="Note title..." value="${note?escHtml(note.title):''}" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:15px;background:var(--surface1);color:var(--text);">
    </div>
    <div class="form-group" style="margin-bottom:20px;">
      <label>Content</label>
      <textarea id="noteModalContent" placeholder="Write your note here..." style="width:100%;min-height:120px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface1);color:var(--text);resize:vertical;font-family:inherit;">${note?escHtml(note.content):''}</textarea>
    </div>
    <div class="modal-actions" style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn btn-ghost" onclick="this.closest('#noteModalBg').remove()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNoteFromModal('${note?escHtml(note.id):''}')">${note?'✓ Save':'➕ Add'}</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  setTimeout(()=>document.getElementById('noteModalTitle').focus(),100);
}

function saveNoteFromModal(id){
  const title=document.getElementById('noteModalTitle').value.trim()||'Untitled';
  const content=document.getElementById('noteModalContent').value.trim();
  if(id){
    const n=notes.find(x=>x.id===id);
    if(!n) return;
    n.title=title;
    n.content=content;
    n.updatedAt=_localDateStr();
  } else {
    const nid='NOTE-'+String(_nextNoteId++);
    notes.unshift({id:nid,title,content,updatedAt:_localDateStr()});
  }
  document.getElementById('noteModalBg').remove();
  renderNotes();
  saveAllData();
}

function deleteNote(id){
  if(!confirm('Delete this note?')) return;
  notes = notes.filter(x => x.id !== id);
  renderNotes();
  saveAllData();
}
// ── END NOTES ──

function togglePosStockView(pid){
  _posStockView[pid]=(_posStockView[pid]||'qty')==='qty'?'pcs':'qty';
  renderPOS();
}

// ── BULK PRICING ──────────────────────────────────────────────────────────────
// SP tiers: 1-4 pcs → base price, 5-9 pcs → price5, 10+ pcs → price10
function getBulkPrice(p, qty){
  if(!p) return 0;
  if(qty >= 10 && p.price10 != null && p.price10 > 0) return p.price10;
  if(qty >= 5 && p.price5 != null && p.price5 > 0) return p.price5;
  return p.price || 0;
}
function refreshItemBulkPrice(item, prod){
  if(!item || item.weightPerPrice > 0) return;
  if(item.customPrice != null) return;
  item.price = getBulkPrice(prod, item.qty);
}

function addToCart(id){
  const p=products.find(x=>x.id===id); if(!p) return;
  if(p.stock<=0){ notify(p.name+' is out of stock','error'); return; }
  const wt=isWeightUnit(p.unit);
  if(wt && p.weightPerPrice>0){
    const gm=prompt('Enter weight in grams:');
    if(gm===null) return;
    const grams=parseFloat(gm);
    if(isNaN(grams)||grams<=0){ notify('Enter valid weight','error'); return; }
    const unitPrice=(grams/p.weightPerPrice)*p.price;
    const ex=cart.find(x=>x.id===id);
    if(ex){ ex.qty+=grams; ex.customPrice=(ex.qty/ex.weightPerPrice)*p.price; }
    else cart.push({id:p.id,name:p.name,price:unitPrice,qty:grams,emoji:p.emoji,gst:p.gst||0,cgst:p.cgst||0,sgst:p.sgst||0,igst:p.igst||0,piecesPerBox:1,weight:p.unit,weightPerPrice:p.weightPerPrice,basePrice:p.price});
    renderCart(); notify(p.name+' added ('+grams+' gm)');
    return;
  }
  const ex=cart.find(x=>x.id===id);
  if(ex){ if(ex.qty>=p.stock){notify('Max stock reached','error');return;} ex.qty++; refreshItemBulkPrice(ex,p); }
  else cart.push({id:p.id,name:p.name,price:p.price,qty:1,emoji:p.emoji,gst:p.gst||0,cgst:p.cgst||0,sgst:p.sgst||0,igst:p.igst||0,piecesPerBox:p.piecesPerBox||1});
  renderCart(); notify(p.name+' added');
}

// ── BULK QTY ─────────────────────────────────────────────────────────────────
function openBulkQty(id){
  const p=products.find(x=>x.id===id); if(!p) return;
  document.getElementById('bulkProductId').value=id;
  _bulkStockView='pcs';
  renderBulkStockDisplay(p);
  document.getElementById('bulkBoxes').value='';
  document.getElementById('bulkPieces').value='';
  document.getElementById('bulkPreview').style.display='none';
  document.getElementById('bulkPPBInfo').textContent=p.piecesPerBox?`1 box = ${p.piecesPerBox} pcs`:'';
  setBulkMode(p.piecesPerBox?'both':'pieces');
  // Pre-fill override price & discount if already set for this item
  const existing = cart.find(x=>x.id===id);
  document.getElementById('bulkNewPrice').value = existing?.customPrice != null ? existing.customPrice : '';
  document.getElementById('bulkNewDisc').value = existing?.overrideDisc != null ? existing.overrideDisc : (existing?.customPrice!=null&&existing.customPrice<p.price&&p.price>0?Math.round((1-existing.customPrice/p.price)*1000)/10:'');
  // Pre-fill qty so the modal can also act as a price editor for existing items
  if(existing && existing.qty>0 && !(existing.weightPerPrice>0)){
    document.getElementById('bulkPieces').value = existing.qty;
  }
  updateBulkPreview();
  document.getElementById('bulkQtyModal').classList.add('open');
}
function renderBulkStockDisplay(p){
  if(!p) { p=products.find(x=>x.id===parseInt(document.getElementById('bulkProductId').value)); }
  if(!p) return;
  const ppb=Math.max(1,p.piecesPerBox||1);
  const boxes=p.noOfBoxes||0;
  const pcs=p.noOfPieces||0;
  let stockText;
  if(_bulkStockView==='pcs'){
    stockText=`Stock: <span class="bulk-stock-toggle" onclick="toggleBulkStockView()" title="Click to see in boxes &amp; pcs">${p.stock} pcs 🔄</span>`;
  } else {
    stockText=`Stock: <span class="bulk-stock-toggle" onclick="toggleBulkStockView()" title="Click to see total pcs">${formatQty(boxes,pcs)} 🔄</span>`;
  }
  document.getElementById('bulkQtyProductName').innerHTML=`${p.image?`<img src="${p.image}" style="width:28px;height:28px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px;">`:p.emoji+' '} ${p.name} · ₹${fmt(p.price)}/pc · ${stockText}${p.purchasePrice?` · <span style="color:var(--muted)">PC: ₹${fmt(p.purchasePrice)}</span>`:''}`;
}
function toggleBulkStockView(){
  _bulkStockView=_bulkStockView==='pcs'?'boxes':'pcs';
  renderBulkStockDisplay();
}
function setBulkMode(mode){
  _bulkMode=mode;
  ['boxes','pieces','both'].forEach(m=>{
    const id='mode'+m.charAt(0).toUpperCase()+m.slice(1);
    document.getElementById(id).classList.toggle('active',m===mode);
  });
  document.getElementById('bulkBoxesRow').style.display=(mode==='boxes'||mode==='both')?'grid':'none';
  document.getElementById('bulkPiecesRow').style.display=(mode==='pieces'||mode==='both')?'grid':'none';
  document.getElementById('bulkPiecesLabel').textContent=mode==='both'?'Loose Pieces':'Number of Pieces';
  updateBulkPreview();
}
function onOverridePriceInput(){
  const raw=document.getElementById('bulkNewPrice')?.value?.trim();
  const disc=document.getElementById('bulkNewDisc');
  if(disc){
    const newVal=(raw!==''&&!isNaN(parseFloat(raw))&&parseFloat(raw)>=0)?'0':'';
    if(disc.value!==newVal) disc.value=newVal;
  }
  updateBulkPreview();
}
function onOverrideDiscInput(){
  const raw=document.getElementById('bulkNewDisc')?.value?.trim();
  const price=document.getElementById('bulkNewPrice');
  const pid=parseInt(document.getElementById('bulkProductId').value);
  const p=products.find(x=>x.id===pid);
  const base=p&&p.price>0?p.price:0;
  if(price&&base>0&&raw!==''&&!isNaN(parseFloat(raw))&&parseFloat(raw)>=0){
    const pct=Math.max(0,parseFloat(raw));
    const pr=parseFloat((base*(1-pct/100)).toFixed(2));
    if(price.value!==String(pr)) price.value=pr;
  }
  updateBulkPreview();
}
function updateBulkPreview(){
  const pid=parseInt(document.getElementById('bulkProductId').value);
  const p=products.find(x=>x.id===pid); if(!p) return;
  const ppb=Math.max(1,p.piecesPerBox||1);
  const boxes=Math.max(0,parseInt(document.getElementById('bulkBoxes').value)||0);
  const pieces=Math.max(0,parseInt(document.getElementById('bulkPieces').value)||0);
  const total=_bulkMode==='boxes'?boxes*ppb:_bulkMode==='pieces'?pieces:boxes*ppb+pieces;
  const overridePrice=parseFloat(document.getElementById('bulkNewPrice')?.value);
  const usePrice = (!isNaN(overridePrice) && overridePrice>=0) ? overridePrice : getBulkPrice(p,total);
  const prev=document.getElementById('bulkPreview');
  if(total>0){
    const over=total>p.stock;
    let txt=`${total} pcs · ₹${fmt(total*usePrice)}`;
    if(_bulkMode==='boxes') txt=`${boxes} box${boxes!==1?'es':''} = ${total} pcs · ₹${fmt(total*usePrice)}`;
    else if(_bulkMode==='both'&&boxes>0) txt=`${boxes} box${boxes!==1?'es':''} + ${pieces} pcs = ${total} pcs · ₹${fmt(total*usePrice)}`;
    if(overridePrice>=0 && !isNaN(overridePrice) && overridePrice!==p.price){
      txt+=` (custom ₹${fmt(overridePrice)}/pc)`;
    }
    if(over) txt+=' ⚠️ Exceeds stock!';
    document.getElementById('bulkPreviewText').textContent=txt;
    document.getElementById('bulkPreviewText').style.color=over?'var(--red)':'var(--text)';
    prev.style.display='block';
  } else prev.style.display='none';
}
function applyBulkQty(){
  const pid=parseInt(document.getElementById('bulkProductId').value);
  const p=products.find(x=>x.id===pid); if(!p) return;
  const ppb=Math.max(1,p.piecesPerBox||1);
  const boxes=Math.max(0,parseInt(document.getElementById('bulkBoxes').value)||0);
  const pieces=Math.max(0,parseInt(document.getElementById('bulkPieces').value)||0);
  const total=_bulkMode==='boxes'?boxes*ppb:_bulkMode==='pieces'?pieces:boxes*ppb+pieces;
  if(total<=0){ notify('Enter a valid quantity','error'); return; }
  if(total>p.stock){ notify('Quantity exceeds stock!','error'); return; }
  // Read optional custom price / discount from bulk modal
  const rawPrice = document.getElementById('bulkNewPrice')?.value?.trim();
  const rawDisc = document.getElementById('bulkNewDisc')?.value?.trim();
  let customPrice = null, overrideDisc = null;
  const discNum = (rawDisc !== '' && !isNaN(parseFloat(rawDisc))) ? Math.max(0,parseFloat(rawDisc)) : null;
  if(discNum!=null && discNum>0 && p.price>0){
    customPrice = parseFloat((p.price*(1-discNum/100)).toFixed(2));
    overrideDisc = Math.round(discNum*10)/10;
  } else if(rawPrice !== '' && !isNaN(parseFloat(rawPrice)) && parseFloat(rawPrice) >= 0){
    customPrice = parseFloat(rawPrice);
    overrideDisc = 0;
  }
  const ex=cart.find(x=>x.id===pid);
  const tierPrice = customPrice != null ? customPrice : getBulkPrice(p,total);
  if(ex){ ex.qty=total; ex.customPrice=customPrice; ex.overrideDisc=overrideDisc; refreshItemBulkPrice(ex,p); }
  else cart.push({id:p.id,name:p.name,price:tierPrice,qty:total,emoji:p.emoji,gst:p.gst||0,cgst:p.cgst||0,sgst:p.sgst||0,igst:p.igst||0,piecesPerBox:p.piecesPerBox||1,customPrice,overrideDisc});
  closeModal('bulkQtyModal'); renderCart(); notify(`${p.name} — ${total} pcs added${customPrice!=null?' @ ₹'+fmt(customPrice)+'/pc':''}`);
}

// ── CART ─────────────────────────────────────────────────────────────────────
function renderCart(){
  const el=document.getElementById('cartItems');
  if(!cart.length){ el.innerHTML='<div class="empty-state" style="padding:20px 0;"><div class="big">🛒</div><p>Cart is empty</p></div>'; updateTotals(); return; }
  const applyTax=document.getElementById('applyTaxChk')?.checked;
  el.innerHTML=cart.map(item=>{
    const prod=products.find(x=>x.id===item.id);
    const maxStock=prod?prod.stock:item.qty;
    const overStock=item.qty>maxStock;
    const effectivePrice = item.customPrice != null ? item.customPrice : item.price;
    const isWtItem = item.weightPerPrice > 0;
    const taxAmt=applyTax&&item.gst?(effectivePrice*(isWtItem?1:item.qty)*(item.gst/100)):0;
    const itemTotal=isWtItem ? effectivePrice : effectivePrice*item.qty;
    const intra=isIntrastate();
    const gstLabel=intra?(item.cgst>0?`CGST ${item.cgst}%+SGST ${item.sgst}%`:`GST ${item.gst}%`):(item.igst>0?`IGST ${item.igst}%`:`GST ${item.gst}%`);
    const gstTag=applyTax&&item.gst?`<span style="font-size:9px;background:rgba(64,200,240,.12);color:var(--accent2);border-radius:4px;padding:1px 5px;margin-left:4px;">${gstLabel}</span>`:'';
    const customPriceTag = item.customPrice != null
      ? (()=>{
          const basePrice = prod?prod.price:item.price;
          const ovDisc = item.overrideDisc!=null ? item.overrideDisc : (basePrice>item.customPrice ? Math.round((1-item.customPrice/basePrice)*100) : null);
          return `<span style="font-size:9px;background:rgba(253,191,74,.15);color:var(--accent);border-radius:4px;padding:1px 5px;margin-left:4px;">${(ovDisc!=null&&ovDisc>0)?'−'+ovDisc+'% off':'custom price'}</span>`;
        })()
      : '';
    const qtyLabel = isWtItem ? item.qty+' gm' : item.qty;
    const pricePerLabel = isWtItem ? '₹'+fmt(item.basePrice/item.weightPerPrice)+'/gm' : '₹'+fmt(effectivePrice)+'/pc';
    const tierTag = (!isWtItem && item.customPrice==null && prod && item.price !== prod.price)
      ? `<span style="font-size:9px;background:rgba(253,191,74,.15);color:var(--accent);border-radius:4px;padding:1px 5px;margin-left:4px;">${item.qty>=10?'10pc':'5pc'} rate</span>` : '';
    return `<div class="cart-item" style="flex-direction:column;gap:5px;${overStock?'border-left:3px solid var(--red);padding-left:8px;':''}">
      <div style="display:flex;align-items:flex-start;width:100%;">
        <div style="min-width:0;flex:1;overflow:hidden;padding-right:8px;">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name}${gstTag}${customPriceTag}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px;">${pricePerLabel}${tierTag}${item.customPrice!=null?` <span style="text-decoration:line-through;color:var(--muted);font-size:10px;">orig ₹${fmt(prod?prod.price:item.price)}</span>`:''}${isWtItem?' · '+item.qty+' gm':''}</div>
          <div style="font-size:10px;color:${overStock?'var(--red)':'var(--muted)'};">${overStock?'⚠️ Only '+maxStock+' in stock':'Stock: '+maxStock}</div>
        </div>
        <div class="item-total" data-cart-id="${item.id}" style="flex-shrink:0;color:${overStock?'var(--red)':'var(--accent)'};">₹${fmt(itemTotal)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <div class="qty-controls" style="flex-shrink:0;">
          ${isWtItem ? `<button class="qty-btn" onclick="changeQty(${item.id},-1)">−</button>
          <input class="cart-qty-input" type="number" min="1" max="${maxStock}" value="${item.qty}"
            style="${overStock?'border-color:var(--red);':''}"
            onchange="setQtyWithWarn(${item.id},this.value,${maxStock})"
            oninput="liveCheckQty(${item.id},this,${maxStock})"
            onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"
            onclick="this.select()">
          <button class="qty-btn" onclick="changeQty(${item.id},1)">+</button>
          <span style="font-size:10px;color:var(--muted);">gm</span>` : `<button class="qty-btn" onclick="changeQty(${item.id},-1)">−</button>
          <input class="cart-qty-input" type="number" min="1" max="${maxStock}" value="${item.qty}"
            style="${overStock?'border-color:var(--red);':''}"
            onchange="setQtyWithWarn(${item.id},this.value,${maxStock})"
            oninput="liveCheckQty(${item.id},this,${maxStock})"
            onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"
            onclick="this.select()">
          <button class="qty-btn" onclick="changeQty(${item.id},1)">+</button>`}
        </div>
        <span class="cart-item-bulk-btn" onclick="openBulkQty(${item.id})">📦 Bulk</span>
      </div>
    </div>`;
  }).join('');
  updateTotals();
}
function setQtyWithWarn(id,val,maxStock){
  const item=cart.find(x=>x.id===id); if(!item) return;
  const n=Math.max(1,parseInt(val)||1);
  if(n>maxStock){
    notify(`⚠️ Only ${maxStock} in stock! Setting to max.`,'error');
    item.qty=maxStock;
  } else { item.qty=n; }
  if(item.weightPerPrice>0) item.price=(item.qty/item.weightPerPrice)*item.basePrice;
  renderCart();
}
function liveCheckQty(id,input,maxStock){
  const n=parseInt(input.value)||0;
  if(n>maxStock){
    input.style.borderColor='var(--red)';
    input.title=`Max ${maxStock} in stock!`;
  } else {
    input.style.borderColor='';
    input.title='';
  }
}
function setQty(id,val){
  const item=cart.find(x=>x.id===id); if(!item) return;
  const prod=products.find(x=>x.id===id);
  const n=Math.max(1,parseInt(val)||1);
  item.qty=Math.min(n,prod.stock); renderCart();
}
function changeQty(id,delta){
  const item=cart.find(x=>x.id===id); if(!item) return;
  const prod=products.find(x=>x.id===id);
  const isWt=item.weightPerPrice>0;
  const step=isWt?10:1;
  item.qty=Math.min(Math.max(item.qty+(delta*step),0),prod.stock);
  if(item.weightPerPrice>0) item.price=(item.qty/item.weightPerPrice)*item.basePrice;
  else refreshItemBulkPrice(item,prod);
  if(item.qty<=0) cart=cart.filter(x=>x.id!==id);
  renderCart();
}
function clearCart(){ cart=[]; const d=document.getElementById('cartDiscountPct'); if(d) d.value='0'; renderCart(); }

// ── GST LOCATION LOGIC ────────────────────────────────────────────────────────
const _indianStates=['andhra pradesh','arunachal pradesh','assam','bihar','chhattisgarh','goa','gujarat','haryana','himachal pradesh','jharkhand','karnataka','kerala','madhya pradesh','maharashtra','manipur','meghalaya','mizoram','nagaland','odisha','punjab','rajasthan','sikkim','tamil nadu','telangana','tripura','uttar pradesh','uttarakhand','west bengal','delhi','jammu and kashmir','ladakh','chandigarh','puducherry','andaman and nicobar islands','dadra and nagar haveli','daman and diu','lakshadweep'];
function extractState(loc){
  if(!loc) return '';
  const l=loc.toLowerCase().trim();
  for(const s of _indianStates) if(l.includes(s)) return s;
  return l;
}
function isIntrastate(){
  // An explicit place of supply always wins over the free-text location box.
  // Otherwise the counter staff could pick POS 29 on a Maharashtra bill and the
  // tax would still be split CGST+SGST — an invoice that contradicts itself.
  const chosen = (document.getElementById('gstPlaceOfSupply')?.value || '').trim();
  if (chosen){
    const own = gstOwnStateCode();
    return !own || chosen === own;
  }
  const custLoc=document.getElementById('cartCustLocation')?.value||_userLocation;
  if(!custLoc||!_userLocation) return true;
  return extractState(custLoc)===extractState(_userLocation);
}
function onCustLocationChange(){ updateTotals(); renderCart(); gstSyncPlaceOfSupply(); }

// ── GST document capture (billing screen) ─────────────────────────────────────
// Everything here is presentation only: it reads the config served by
// /api/gst/config so document types, reason codes and state codes are never
// duplicated in this file. gstBillDocMeta() is the single place that turns the
// form into the fields stored on the sale row.
let _gstCfgPromise = null;
let _gstCfg = null;      // the rules, from config
let _gstStates = {};     // state code → name; sent alongside config, not inside it

function gstLoadConfig(){
  if (_gstCfgPromise) return _gstCfgPromise;
  _gstCfgPromise = _api('/gst/config')
    .then((r) => {
      _gstCfg = (r && r.config) || null;
      _gstStates = (r && r.states) || _gstStates || {};
      return _gstCfg;
    })
    .catch(() => { _gstCfgPromise = null; return null; });
  return _gstCfgPromise;
}

function gstDocTypes(){
  const list = _gstCfg && _gstCfg.documents;
  if (list && list.length) return list;
  // Config not loaded yet — the two types that matter for a counter bill.
  return [{ value: 'tax_invoice', label: 'Tax Invoice', inReturn: true },
          { value: 'bill_of_supply', label: 'Bill of Supply', inReturn: true }];
}

function gstRenderBillFields(){
  const dt = document.getElementById('gstDocType');
  if (!dt) return;
  // Re-render from config every time rather than latching on first paint: the
  // first paint usually happens before /gst/config returns, and a latch would
  // leave the counter stuck with the two-item fallback list for the whole session.
  const wanted = gstDocTypes();
  const have = [...dt.options].map((o) => o.value).join(',');
  const cur = dt.value;
  if (have !== wanted.map((d) => d.value).join(',')){
    dt.innerHTML = wanted
      .map((d) => `<option value="${d.value}">${d.label}${d.inReturn ? '' : ' (not in return)'}</option>`).join('');
    dt.value = wanted.some((d) => d.value === cur) ? cur : 'tax_invoice';
    // The custom dropdown copied the old option list into its trigger; rebuild it
    // or the counter sees a stale label and picks from a stale list.
    resetCustomSelect(dt);
  }

  const pos = document.getElementById('gstPlaceOfSupply');
  const states = _gstStates;
  if (pos){
    const opts = Object.entries(states)
      .map(([code, name]) => `<option value="${code}">${code} — ${name}</option>`).join('');
    if (pos.dataset.stateCount !== String(Object.keys(states).length)){
      const curPos = pos.value;
      pos.innerHTML = '<option value="">— same as shop state —</option>' + opts;
      pos.dataset.stateCount = String(Object.keys(states).length);
      resetCustomSelect(pos);
      setGstPlaceOfSupply(curPos);
    }
  }
  if (dt.dataset.enhanced !== '1' || pos === null || pos.dataset.enhanced !== '1') enhanceSelects();
}

function gstOwnStateCode(){
  const states = _gstStates;
  const own = extractState(_userLocation || '');
  for (const [code, name] of Object.entries(states)){
    if (name.toLowerCase() === String(own).toLowerCase()) return code;
  }
  return '';
}

// The custom dropdown keeps its trigger label as separate DOM text, so assigning
// select.value alone leaves the label showing the old state. Always go through
// here. Returns the code that was applied.
function setGstPlaceOfSupply(code){
  const pos = document.getElementById('gstPlaceOfSupply');
  if (!pos) return '';
  pos.value = code || '';
  const txt = document.getElementById('gstPlaceOfSupply_txt');
  if (txt){
    const opt = [...pos.options].find((o) => o.value === (code || ''));
    // options can be empty before /gst/config resolves — leave the label alone
    // rather than throwing on pos.options[0].
    if (opt) txt.textContent = opt.text;
    else if (pos.options[0]) txt.textContent = pos.options[0].text;
  }
  const wrap = document.getElementById('gstPlaceOfSupply_w');
  if (wrap){
    wrap.querySelectorAll('.cust-sel-item').forEach((el) => el.classList.toggle('sel', el.dataset.value === (code || '')));
  }
  return pos.value;
}

// Place of supply defaults to wherever the goods actually move to. The counter
// staff already types that into the cart location box, so derive it rather than
// making them pick it twice — they can still override in the dropdown, and once
// they have, isIntrastate() defers to them.
function gstSyncPlaceOfSupply(){
  const pos = document.getElementById('gstPlaceOfSupply');
  if (!pos || pos.dataset.touched === '1') return;
  const cust = extractState(document.getElementById('cartCustLocation')?.value || _userLocation || '');
  const own = gstOwnStateCode();
  let found = '';
  for (const [code, name] of Object.entries(_gstStates)){
    if (name.toLowerCase() === String(cust).toLowerCase()) { found = code; break; }
  }
  setGstPlaceOfSupply(found || own || '');
  gstRefreshBillMeta();
}

function toggleGstBillFields(){
  const box = document.getElementById('gstBillFields');
  const ch  = document.getElementById('gstDetailsChevron');
  if (!box) return;
  const open = box.style.display === 'none';
  box.style.display = open ? 'block' : 'none';
  if (ch) ch.textContent = open ? '▴' : '▾';
  if (open) { gstLoadConfig().then(gstRenderBillFields); gstRefreshBillMeta(); }
}

function onGstDocTypeChange(){
  const dt = document.getElementById('gstDocType');
  const no = document.getElementById('gstInvoiceNo');
  if (dt && no && !no.value.trim()) no.value = gstNextInvoiceNo();
  gstRefreshBillMeta();
}

function gstNextInvoiceNo(){
  // Same shape as the TXN-###### id, so a shop that already numbers bills this
  // way keeps one continuous series. Series, if set, is prefixed on the invoice.
  const n = String(nextSaleId || 1).padStart(6, '0');
  const series = (document.getElementById('gstInvoiceSeries')?.value || '').trim();
  return series ? series + n : 'TXN-' + n;
}

// Credit/debit notes have to point back at the invoice they adjust, and the
// export/SEZ types need a payment flag for the GSTR-1 8A/8B breakup.
// The reason list comes from config, so this block is re-rendered whenever the
// document type OR the reason-code list changes — including the first render
// landing before /gst/config has come back.
function gstReasonCodes(){
  const ex = (_gstCfg && _gstCfg.exemptions) || null;
  return [].concat((ex && ex.nonGstReasons) || [], (ex && ex.nilRatedReasons) || []).join('|');
}

function gstDocExtrasHtml(){
  const type = document.getElementById('gstDocType')?.value || 'tax_invoice';
  let html = '';
  if (type === 'credit_note' || type === 'debit_note'){
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div class="form-group" style="margin:0;">
        <label>Against invoice no.</label>
        <input id="gstLinkedInvoiceNo" placeholder="e.g. TXN-000123" style="width:100%;">
      </div>
      <div class="form-group" style="margin:0;">
        <label>Reason</label>
        <input id="gstNoteReason" placeholder="e.g. Return / rate correction" style="width:100%;">
      </div></div>`;
  }
  if (type === 'export_invoice' || type === 'sez_invoice'){
    html += `<div class="form-group" style="margin:0;">
      <label>Payment status</label>
      <select id="gstExportPaymentType" style="width:100%;">
        <option value="">— select —</option>
        <option value="WPAY">Paid</option>
        <option value="WOPAY">Unpaid / to be paid</option>
      </select></div>`;
  }
  // Non-GST, nil-rated and exempt supplies still have to reach the return, but
  // they need a reason so the reviewer can tell an omission from an exemption.
  html += `<div class="form-group" style="margin:8px 0 0;">
    <label>Non-GST / nil / exempt reason <span style="color:var(--muted);font-size:10px;font-weight:400;white-space:nowrap;">(only if no tax charged)</span></label>
    <input id="gstNonGstReason" list="gstReasonList" placeholder="Select or type a reason" style="width:100%;">
    <datalist id="gstReasonList">${
      (function(){
        const ex = (_gstCfg && _gstCfg.exemptions) || null;
        return [].concat((ex && ex.nonGstReasons) || [], (ex && ex.nilRatedReasons) || [])
          .map((r) => `<option value="${r}"></option>`).join('');
      })()
    }</datalist></div>`;
  return html;
}

/** Live summary under the block — the counter staff's sanity check before saving. */
function gstRefreshBillMeta(){
  const out = document.getElementById('gstBillMeta');
  if (!out) return;
  const box = document.getElementById('gstBillFields');
  const extras = document.getElementById('gstDocExtras');
  const type = document.getElementById('gstDocType')?.value || 'tax_invoice';
  const reasonKey = gstReasonCodes();
  if (extras && extras.dataset.for !== type + '|' + reasonKey){
    const keep = document.getElementById('gstNonGstReason')?.value || '';
    extras.innerHTML = gstDocExtrasHtml();
    extras.dataset.for = type + '|' + reasonKey;
    const again = document.getElementById('gstNonGstReason');
    if (again && keep) again.value = keep;
    // The export/SEZ payment select is created fresh each time, so let the
    // custom-dropdown enhancer pick it up.
    enhanceSelects();
  }
  if (!box || box.style.display === 'none'){ out.textContent = ''; return; }

  const bits = [];
  const typeMeta = gstDocTypes().find((d) => d.value === type);
  bits.push(typeMeta ? typeMeta.label : type);
  if (!typeMeta || typeMeta.inReturn){
    bits.push(isIntrastate() ? 'Intra-state (CGST+SGST)' : 'Inter-state (IGST)');
  }
  const gstin = (document.getElementById('gstCustGstin')?.value || '').trim().toUpperCase();
  const msg = document.getElementById('gstCustGstinMsg');
  if (gstin){
    const own = gstOwnStateCode();
    const custState = gstin.slice(0, 2);
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)){
      if (msg){ msg.textContent = '⚠ Does not look like a GSTIN — it will be reported as a validation warning.'; msg.style.color = 'var(--warn,#c47d00)'; }
    } else if (own && custState !== own && isIntrastate()){
      if (msg){ msg.textContent = `⚠ Buyer is in state ${custState} but this bill is placed as intra-state — pick the right place of supply so IGST is charged.`; msg.style.color = 'var(--warn,#c47d00)'; }
    } else if (own && custState !== own){
      if (msg){ msg.textContent = `Inter-state supply to state ${custState} — IGST applies.`; msg.style.color = 'var(--muted)'; }
    } else if (msg){ msg.textContent = ''; }
    bits.push(gstin);
  } else if (msg){ msg.textContent = ''; bits.push('B2C (no GSTIN)'); }

  if (document.getElementById('gstReverseCharge')?.checked) bits.push('Reverse charge');
  const reason = (document.getElementById('gstNonGstReason')?.value || '').trim();
  if (reason) bits.push(reason);
  out.textContent = bits.join(' · ');
}

/** Fresh checkout = fresh GST document block. Collapsed, so the counter flow is unchanged. */
function resetGstBillFields(){
  const box = document.getElementById('gstBillFields');
  const ch  = document.getElementById('gstDetailsChevron');
  if (box){ box.style.display = 'none'; delete box.dataset.touched; }
  if (ch) ch.textContent = '▾';
  for (const id of ['gstInvoiceNo','gstInvoiceSeries','gstCustGstin','gstLinkedInvoiceNo','gstNoteReason','gstNonGstReason']){
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  const rc = document.getElementById('gstReverseCharge'); if (rc) rc.checked = false;
  const msg = document.getElementById('gstCustGstinMsg'); if (msg) msg.textContent = '';
  const out = document.getElementById('gstBillMeta'); if (out) out.textContent = '';
  const ex  = document.getElementById('gstDocExtras'); if (ex) delete ex.dataset.for;
  const dt  = document.getElementById('gstDocType'); if (dt){ dt.value = 'tax_invoice'; delete dt.dataset.filled; }
  const pos = document.getElementById('gstPlaceOfSupply');
  if (pos){ delete pos.dataset.touched; delete pos.dataset.stateCount; setGstPlaceOfSupply(''); }
  gstLoadConfig().then(() => { gstRenderBillFields(); gstSyncPlaceOfSupply(); gstRefreshBillMeta(); });
}

/** Turn the billing form into the GST columns stored on the sale. */
function gstBillDocMeta(){
  const box = document.getElementById('gstBillFields');
  const g = (id) => (document.getElementById(id)?.value || '').trim();
  if (!box || box.style.display === 'none'){
    // Nothing was filled in, but the report still needs to know the document is
    // a finalised intra-state sale rather than a NULL.
    return { docType:'tax_invoice', supplyType:'domestic', docStatus:'finalised',
             placeOfSupply:'', isInterstate:!isIntrastate() };
  }
  const docType = g('gstDocType') || 'tax_invoice';
  const typeMeta = gstDocTypes().find((d) => d.value === docType);
  const inReturn = !typeMeta || typeMeta.inReturn;
  const pos = g('gstPlaceOfSupply').toUpperCase();
  const reason = g('gstNonGstReason');
  return {
    docType,
    supplyType: docType === 'export_invoice' ? 'export'
              : docType === 'sez_invoice' ? 'sez' : 'domestic',
    docStatus: 'finalised',
    invoiceNo: g('gstInvoiceNo') || (inReturn ? gstNextInvoiceNo() : ''),
    invoiceSeries: g('gstInvoiceSeries').slice(0, 30),
    custGstin: g('gstCustGstin').toUpperCase().slice(0, 15),
    placeOfSupply: pos.slice(0, 2),
    isInterstate: inReturn ? !isIntrastate() : false,
    reverseCharge: !!document.getElementById('gstReverseCharge')?.checked,
    linkedInvoiceNo: g('gstLinkedInvoiceNo').slice(0, 64),
    noteReason: g('gstNoteReason'),
    exportPaymentType: g('gstExportPaymentType'),
    // A reason typed with no tax charged is the non-GST / nil / exempt signal;
    // the engine reads it to fill the 3.1(c)/(e) and B2B Nil/Exempt tables.
    nonGstReason: (!document.getElementById('applyTaxChk')?.checked || !cartHasTax()) ? reason : '',
    nilRatedReason: reason,
    exemptReason: reason,
  };
}

/** True when any line on the cart actually carries a non-zero tax rate. */
function cartHasTax(){
  return (cart || []).some((i) => (i.gst || 0) > 0 || (i.cgst || 0) > 0 || (i.sgst || 0) > 0 || (i.igst || 0) > 0);
}

function geolocateCurrent(cb){
  if(!navigator.geolocation){ notify('Geolocation not supported','error'); return; }
  notify('Locating...','success');
  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      const lat=pos.coords.latitude, lng=pos.coords.longitude;
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&accept-language=en`)
        .then(r=>r.json())
        .then(d=>{
          const addr = d && d.display_name ? d.display_name : (lat.toFixed(5)+', '+lng.toFixed(5));
          cb({lat,lng,address:addr});
        })
        .catch(()=>cb({lat,lng,address:lat.toFixed(5)+', '+lng.toFixed(5)}));
    },
    ()=>{ notify('Could not get location. Please allow location access.','error'); },
    { enableHighAccuracy:true, timeout:10000, maximumAge:60000 }
  );
}

function openCartLocationMap(){
  openMapPicker({
    lat: null, lng: null,
    onConfirm:(loc)=>{
      const input=document.getElementById('cartCustLocation');
      if(input){ input.value = loc.address || (loc.lat.toFixed(5)+', '+loc.lng.toFixed(5)); onCustLocationChange(); }
    }
  });
}

function setCartLocationToCurrent(){
  geolocateCurrent((loc)=>{
    const input=document.getElementById('cartCustLocation');
    if(input){ input.value=loc.address; onCustLocationChange(); }
    notify('📍 Current location set','success');
  });
}

function autoFillCartLocation(){
  const input=document.getElementById('cartCustLocation');
  if(!input || !input.value.trim()){
    geolocateCurrent((loc)=>{
      const inp=document.getElementById('cartCustLocation');
      if(inp && !inp.value.trim()){ inp.value=loc.address; onCustLocationChange(); }
    });
  }
}

function changeNavLocation(){
  openMapPicker({
    lat:null, lng:null,
    onConfirm:(loc)=>{
      _userLocation = loc.address || (loc.lat.toFixed(5)+', '+loc.lng.toFixed(5));
      const lbl=document.getElementById('navLocLabel');
      if(lbl) lbl.textContent=shortLocLabel(_userLocation);
      const navWrap=document.getElementById('navLocWrap');
      if(navWrap) navWrap.style.display='inline-flex';
      const inp=document.getElementById('cartCustLocation');
      if(inp && !inp.value.trim()){ inp.value=_userLocation; onCustLocationChange(); }
      notify('📍 Shop location updated: '+_userLocation,'success');
    }
  });
}

// ── NOTIFICATION BELL ─────────────────────────────────────────────────────────
function getBellItems(){
  const items=[];
  const now=new Date().getTime();
  const dismissed = (_bellDismissed||{});
  const isDismissed = (type,id)=> dismissed[type+':'+id];
  // Udhaar — only show when a reminder is set AND its trigger time has passed
  udhaarRecords.filter(r=>r.totalPending>0).forEach(r=>{
    if(isDismissed('udhaar',r.id)) return;
    const due = udhaarNotificationDue(r);
    if(!due) return;
    items.push({ type:'udhaar', name:r.name, phone:r.phone||'', sub:due.label, page:'udhaar', id:r.id, priority: 2, fk: due.fk });
  });
  // Advance orders due (scheduled/ready, not billed)
  advanceOrders.filter(o=>o.status!=='billed').forEach(o=>{
    if(isDismissed('advance',o.id)) return;
    let prio=1, sub='';
    const packTime=new Date(o.packTime);
    const totalPaid=(o.advPaid||0)+(o.addlPaid||0);
    const pending=Math.max(0,o.total-totalPaid);
    if(packTime<=now){ prio=3; sub='⏰ Due NOW'; }
    else { const d=packTime.getTime()-now; sub=(d<=3600000?'🕐 Due in <1h · ':'')+packTime.toLocaleDateString('en-IN',{day:'numeric',month:'short'})+' '+packTime.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}); if(d<=3600000) prio=2; }
    items.push({ type:'advance', name:o.custName, phone:o.phone||'', sub:sub+' · ₹'+fmt(pending)+' pending', page:'advance', id:o.id, priority: prio });
  });
  items.sort((a,b)=>b.priority-a.priority);
  return items;
}

// Returns {label, fk} if an udhaar reminder is set AND its trigger time has passed, else null
function udhaarNotificationDue(rec){
  // 1) Fixed date reminder for this customer, fired=false, time reached
  if(_udhaarFixedReminders.length){
    const fr=_udhaarFixedReminders.find(r =>
      !r.fired && (r.custName||'').toLowerCase()===rec.name.toLowerCase() && new Date(r.date)<=new Date());
    if(fr) return { label:'⏰ Reminder· '+fr.note||'Due reminder', fk:'fixed|'+fr.id };
  }
  // 2) Interval reminders: fire X days AFTER the reminder was set (current time), one-shot.
  if(_udhaarReminderIntervals.length && rec.totalPending>0){
    for(const m of _udhaarReminderIntervals){
      const setAt=_udhaarIntSetAt[m];
      if(!setAt) continue;
      const ellapsedMin=Math.floor((Date.now()-setAt)/(1000*60));
      const fk=String(rec.id)+'|'+m;
      if(ellapsedMin>=m && _udhaarIntFired[fk]){
        const display = m<1440 ? fmtInterval(m) : Math.floor(m/1440)+'d';
        return { label:'⏰ Pending ₹'+fmt(rec.totalPending)+' · reminder after '+display, fk:fk };
      }
    }
  }
  return null;
}

// Returns HTML line(s) showing a customer's set reminder date/time, else ''
function getUdhaarReminderInfo(rec){
  const parts=[];
  const nm=(rec.name||'').toLowerCase();
  // Fixed per-customer reminders
  _udhaarFixedReminders.filter(r => (r.custName||'').toLowerCase()===nm).forEach(r=>{
    const d=new Date(r.date);
    const when=d.toLocaleDateString('en-IN')+' '+d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});
    parts.push('<span style="color:'+(r.fired?'var(--green)':'var(--accent2)')+';">'+(r.fired?'✅':'📅')+' Reminder: '+when+(r.note?' · '+escapeHtml(r.note):'')+(r.fired?' · done':'')+'</span>');
  });
  // Interval reminders: remind once X days after the reminder was set (persistent start time)
  if(_udhaarReminderIntervals.length && rec.totalPending>0){
    const minInt=Math.min(..._udhaarReminderIntervals);
    const setAt=_udhaarIntSetAt[minInt];
    const fk=String(rec.id)+'|'+minInt;
    const done = _udhaarIntFired[fk] ? ' · done' : '';
    let line='<span style="color:var(--accent2);">⏰ Reminder after '+fmtInterval(minInt);
    if(setAt){
      const dueDate=new Date(setAt+minInt*60000);
      line+=' ('+dueDate.toLocaleDateString('en-IN')+' '+dueDate.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})+')';
    }
    line+='</span>'+done;
    parts.push(line);
  }
  return parts.join('<br>');
}

function updateReminderCount(){
  const wrap=document.getElementById('bellWrap');
  if(!wrap) return;
  const items=getBellItems();
  const count=items.filter(i=>i.priority>=2).length; // only urgent-ish
  const badge=document.getElementById('bellCount');
  if(count>0){ badge.textContent=count; badge.style.display='flex'; }
  else { badge.style.display='none'; }
  if(bellPanelOpen) renderBellPanel();
}

function toggleBellPanel(){
  const panel=document.getElementById('bellPanel');
  if(!panel) return;
  if(bellPanelOpen){ panel.style.display='none'; bellPanelOpen=false; }
  else { renderBellPanel(); panel.style.display='block'; bellPanelOpen=true; }
}

function renderBellPanel(){
  const panel=document.getElementById('bellPanel');
  if(!panel) return;
  const items=getBellItems();
  if(!items.length){
    panel.innerHTML='<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px;">🔕 No reminders</div>';
    return;
  }
  panel.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600;">
      <span>Reminders (${items.length})</span>
      <button class="btn btn-ghost btn-sm" style="padding:2px 10px;font-size:11px;" onclick="clearAllBell()">🗑️ Clear All</button>
    </div>
    ${items.map((it,idx)=>`
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;border-left:3px solid ${it.priority>=3?'var(--red)':it.priority===2?'var(--accent2)':'transparent'};background:${idx%2?'transparent':'var(--surface2)'};" onclick="closeBellPanel();navigateToBellItem('${it.type}','${String(it.id).replace(/'/g,"\\'")}');" title="Open">
        <span style="font-size:15px;">${it.type==='udhaar'?'💸':'📋'}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(it.name)}</div>
          <div style="font-size:11px;color:var(--muted);${it.priority>=3?'color:var(--red);font-weight:700;':''}">${it.sub}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="padding:0 6px;font-size:10px;" onclick="event.stopPropagation();copyBellPhone('${String(it.phone).replace(/'/g,"\\'")}')" title="Copy phone">📞</button>
        <button class="btn btn-ghost btn-sm" style="padding:0 5px;font-size:12px;color:var(--muted);flex-shrink:0;" title="Dismiss this reminder" onclick="event.stopPropagation();dismissBellItem('${it.type}','${String(it.id).replace(/'/g,"\\'")}')">✕</button>
      </div>`).join('')}
    <div style="padding:8px 14px;font-size:10px;color:var(--muted);text-align:center;">Click an item to jump to it</div>`;
}

function dismissBellItem(type, id){
  markBellDismissed(type,id);
  updateReminderCount();
  notify('Reminder dismissed','success');
}

function clearAllBell(){
  _bellDismissed={}; _saveBellDismissed();
  updateReminderCount();
  notify('All reminders cleared','success');
}

function navigateToBellItem(type, id){
  // Dismiss this reminder permanently (persistent) so it doesn't come back
  markBellDismissed(type,id);
  if(type==='udhaar'){
    navigate('udhaar'); openUdhaarDetail(id);
  } else {
    navigate('advance'); highlightAdvCard(id);
  }
  closeBellPanel();
  updateReminderCount();
}

function highlightAdvCard(id){
  setTimeout(()=>{
    const cards=document.querySelectorAll('#advanceOrdersWrap .adv-card');
    cards.forEach(c=>c.style.border='1px solid var(--border)');
    const target=advanceOrders.find(o=>o.id===id);
    if(!target) return;
    // reverse render: newest first = index from end
    const idx=advanceOrders.length-1-advanceOrders.indexOf(target);
    const card=cards[idx];
    if(card){
      card.style.border='2px solid var(--accent)';
      card.scrollIntoView({behavior:'smooth',block:'center'});
      card.style.boxShadow='0 0 0 3px rgba(64,200,240,.25)';
      setTimeout(()=>{ card.style.border='1px solid var(--border)'; card.style.boxShadow='none'; }, 2500);
    }
  }, 250);
}

function copyBellPhone(p){ if(p) copyUdhaarPhone(p); }

function closeBellPanel(){ const p=document.getElementById('bellPanel'); if(p) p.style.display='none'; bellPanelOpen=false; }

function setCustomPrice(id, val){
  const item = cart.find(x=>x.id===id); if(!item) return;
  const v = val.trim();
  if(v==='' || isNaN(parseFloat(v))){
    item.customPrice = null; // revert to original
    const prod = products.find(x=>x.id===id);
    refreshItemBulkPrice(item, prod);
  } else {
    const n = parseFloat(v);
    if(n >= 0) item.customPrice = n;
  }
  updateTotals();
  // Update item total display without full re-render
  const applyTax = document.getElementById('applyTaxChk')?.checked;
  const effectivePrice = item.customPrice != null ? item.customPrice : item.price;
  const taxAmt = applyTax && item.gst ? (effectivePrice * item.qty * (item.gst / 100)) : 0;
  const itemTotal = effectivePrice * item.qty;
  // Find the item-total span in the cart DOM (lightweight update)
  const totalEl = document.querySelector(`.item-total[data-cart-id="${id}"]`);
  if(totalEl) totalEl.innerHTML = '₹'+fmt(itemTotal);
}

function toggleGstBreakdown(){
  _gstBreakdownOpen=!_gstBreakdownOpen;
  document.getElementById('gstBreakdownPanel').style.display=_gstBreakdownOpen?'block':'none';
  document.getElementById('gstBreakdownToggleIcon').textContent=_gstBreakdownOpen?'▼':'▶';
}
function getCartTotals(){
  const applyTax=document.getElementById('applyTaxChk')?.checked;
  const sub=cart.reduce((a,i)=>{
    const ep=i.customPrice!=null?i.customPrice:i.price;
    return a + (i.weightPerPrice>0 ? ep : ep*i.qty);
  },0);
  let tax=0;
  if(applyTax){
    const intra=isIntrastate();
    tax=cart.reduce((a,i)=>{
      const ep=i.customPrice!=null?i.customPrice:i.price;
      const amt=i.weightPerPrice>0?ep:ep*i.qty;
      // itemTaxRates derives the missing head from the combined rate. Reading
      // i.igst directly charged zero IGST on inter-state sales because the
      // product form only ever stores CGST+SGST.
      const tr=itemTaxRates(i,intra);
      return a+parseFloat((amt*((tr.cgst+tr.sgst+tr.igst)/100)).toFixed(2));
    },0);
  }
  const discountPct=Math.max(0,parseFloat(document.getElementById('cartDiscountPct')?.value)||0);
  const discount=parseFloat((sub*(discountPct/100)).toFixed(2));
  return {applyTax, sub, tax, discountPct, discount, billTotal:parseFloat((sub+tax-discount).toFixed(2))};
}
function updateTotals(){
  const applyTax=document.getElementById('applyTaxChk')?.checked;
  const intra=isIntrastate();
  const sub=cart.reduce((a,i)=>{
    const ep=i.customPrice!=null?i.customPrice:i.price;
    return a + (i.weightPerPrice>0 ? ep : ep*i.qty);
  },0);
  document.getElementById('subtotal').textContent='₹'+fmt(sub);
  const taxRow=document.getElementById('taxRow');
  const gstWrap=document.getElementById('gstBreakdownWrap');
  let tax=0;
  if(applyTax){
    taxRow.style.display='flex';
    const itemGsts = cart.map(i=>{
      const ep=i.customPrice!=null?i.customPrice:i.price;
      const amt=i.weightPerPrice>0?ep:ep*i.qty;
      const tr=itemTaxRates(i,intra);
      return parseFloat((amt*((tr.cgst+tr.sgst+tr.igst)/100)).toFixed(2));
    });
    tax = itemGsts.reduce((a,b)=>a+b,0);
    document.getElementById('taxAmt').textContent='₹'+fmt(tax);
    const itemsWithGst=cart.filter((i,idx)=>itemGsts[idx]>0);
    gstWrap.style.display=itemsWithGst.length?'block':'none';
    if(itemsWithGst.length){
      const mode=intra?'Intrastate (CGST+SGST)':'Interstate (IGST)';
      document.getElementById('gstBreakdownPanel').innerHTML=`<div style="font-size:10px;color:var(--accent);margin-bottom:6px;font-weight:600;">${mode}</div>`+cart.map((i,idx)=>{
        if(!itemGsts[idx]) return '';
        const ep=i.customPrice!=null?i.customPrice:i.price;
        const amt=i.weightPerPrice>0?ep:ep*i.qty;
        const tr=itemTaxRates(i,intra);
        const cgstAmt=intra?parseFloat((amt*(tr.cgst/100)).toFixed(2)):0;
        const sgstAmt=intra?parseFloat((amt*(tr.sgst/100)).toFixed(2)):0;
        const igstAmt=!intra?parseFloat((amt*(tr.igst/100)).toFixed(2)):0;
        const qtyStr=i.weightPerPrice>0?`${i.qty} gm`:`${i.qty}×₹${fmt(ep)}`;
        return `<div class="gst-breakdown-row"><span>${i.emoji} ${i.name} <span style="color:var(--muted);font-size:10px;">${qtyStr}</span></span><span style="color:var(--accent2);font-weight:600;font-size:11px;">CGST: ₹${fmt(cgstAmt)} · SGST: ₹${fmt(sgstAmt)} · IGST: ₹${fmt(igstAmt)}</span></div>`;
      }).join('')+`<div class="gst-breakdown-row"><span style="font-weight:600;">Total GST</span><span style="color:var(--accent);font-weight:700;">₹${fmt(tax)}</span></div>`;
    }
  } else {
    taxRow.style.display='none'; gstWrap.style.display='none';
    _gstBreakdownOpen=false; document.getElementById('gstBreakdownToggleIcon').textContent='▶';
  }
  const discountPct=Math.max(0,parseFloat(document.getElementById('cartDiscountPct')?.value)||0);
  const discount=parseFloat((sub*(discountPct/100)).toFixed(2));
  const discRow=document.getElementById('discountRow');
  const discAmt=document.getElementById('discountAmt');
  if(discRow&&discAmt){
    discRow.style.display=discount>0?'flex':'none';
    discAmt.textContent='−₹'+fmt(discount);
  }
  document.getElementById('cartTotal').textContent='₹'+smartRound(sub+tax-discount).toFixed(2);
}

// ── CHECKOUT ─────────────────────────────────────────────────────────────────
function checkout(){
  if(!cart.length){ notify('Cart is empty!','error'); return; }
  document.getElementById('custName').value='';
  document.getElementById('custPhone').value='';
  document.getElementById('udhaarWarnBox').innerHTML='';
  document.getElementById('payType').value='paid';
  document.getElementById('udhaarExtraWrap').style.display='none';
  document.getElementById('partialAmtWrap').style.display='none';
  document.getElementById('advanceOrderWrap').style.display='none';
  document.getElementById('payMethodWrap').style.display='block';
  document.getElementById('partialAmt').value='';
  document.getElementById('udhaarPayNow').value='';
  document.getElementById('custReference').value='';
  document.getElementById('pendingPreview').textContent='';
  document.getElementById('udhaarPayPreview').style.display='none';
  // Reset udhaar date & photo
  const udDateEl=document.getElementById('udhaarBillDate');
  if(udDateEl){udDateEl._val=new Date().toISOString().slice(0,10);udDateEl.value=calFmt(udDateEl._val);udDateEl.dataset.value=udDateEl._val;}
  clearUdhaarPhoto();
  document.getElementById('custNameReqMark').textContent='(optional)';
  document.getElementById('custPhoneReqMark').textContent='(optional)';
  document.getElementById('fullyPaidChangeMsg').style.display='none';
  document.getElementById('changeReturnMsg').style.display='none';
  // Reset advance order fields
  const coAdvFields=['coAdvPackDate','coAdvPackTime','coAdvPaidNow','coTransportRecipient','coTransportLocation','coTransportVehicle','coTransportCost','coDriverName','coDriverPhone','coAdvBalanceOnDelivery'];
  coAdvFields.forEach(id=>{const el=document.getElementById(id);if(el){el.value='';if(id==='coAdvPackDate'){el._val='';el.dataset.value='';}}});
  const chk=document.getElementById('coTransportChk'); if(chk) chk.checked=false;
  const tWrap=document.getElementById('transportDetailsWrap'); if(tWrap) tWrap.style.display='none';
  const prev=document.getElementById('advancePayPreview'); if(prev) prev.style.display='none';
  _udhaarIncluded=false;
  comboClose('custNameWrap');
  resetGstBillFields();
  updateCheckoutTotal();
  document.getElementById('checkoutModal').classList.add('open');
  setTimeout(()=>document.getElementById('custName').focus(),100);
}

function getCartTotal(){
  const applyTax=document.getElementById('applyTaxChk')?.checked;
  const intra=isIntrastate();
  const sub=cart.reduce((a,i)=>{ const ep=i.customPrice!=null?i.customPrice:i.price; return a+ep*i.qty; },0);
  let tax=0;
  if(applyTax){
    tax=cart.reduce((a,i)=>{
      const ep=i.customPrice!=null?i.customPrice:i.price;
      const amt=ep*i.qty;
      // Must go through itemTaxRates, not the raw cgst/sgst/igst columns. The
      // product form stores CGST+SGST only, so reading igst directly charged
      // ZERO tax on an inter-state sale while the receipt still printed IGST.
      const tr=itemTaxRates(i,intra);
      return a+(amt*((tr.cgst+tr.sgst+tr.igst)/100));
    },0);
  }
  return {sub,tax,total:sub+tax};
}

function getUdhaarPendingForCust(){
  const n=(document.getElementById('custName')?.value||'').trim().toLowerCase();
  if(!n) return 0;
  const rec=udhaarRecords.find(r=>r.name.toLowerCase()===n);
  return rec?Math.max(0,rec.totalPending):0;
}

function updateCheckoutTotal(){
  const {sub,tax,total}=getCartTotal();
  const intra=isIntrastate();
  // Same source as getCartTotal() so the CGST/SGST/IGST breakdown always adds
  // up to the total shown on the Confirm button.
  const split=(head)=>cart.reduce((a,i)=>{const ep=i.customPrice!=null?i.customPrice:i.price;const amt=ep*i.qty;return a+parseFloat((amt*(itemTaxRates(i,intra)[head]/100)).toFixed(2));},0);
  const cgstAmt=intra?split('cgst'):0;
  const sgstAmt=intra?split('sgst'):0;
  const igstAmt=intra?0:split('igst');
  const extraUd=_udhaarIncluded?getUdhaarPendingForCust():0;
  const grandTotal=total+extraUd;
  const applyTax=document.getElementById('applyTaxChk')?.checked;
  const transportCost=parseFloat(document.getElementById('coTransportCost')?.value)||0;
  const isAdv=document.getElementById('payType')?.value==='advance';
  const finalTotal=grandTotal+(isAdv?transportCost:0);
  const roundedTotal=smartRound(finalTotal);
  const hasRoundOff=Math.abs(roundedTotal-finalTotal)>0.001;
  const taxLines = applyTax&&tax>0 ? (
    (intra ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;color:var(--muted);"><span>CGST</span><span>₹${fmt(cgstAmt)}</span></div><div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;color:var(--muted);"><span>SGST</span><span>₹${fmt(sgstAmt)}</span></div>`
          : `<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;color:var(--muted);"><span>IGST</span><span>₹${fmt(igstAmt)}</span></div>`) +
    `<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;color:var(--accent);font-weight:600;"><span>Total Tax</span><span>₹${fmt(tax)}</span></div>`
  ) : '';
  document.getElementById('checkoutTotalDisplay').innerHTML=`
    <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;color:var(--muted);"><span>Subtotal</span><span>₹${fmt(sub)}</span></div>
    ${taxLines}
    ${extraUd>0?`<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;color:var(--red);"><span>+ Previous Udhaar Included</span><span>₹${fmt(extraUd)}</span></div>`:''}
    ${isAdv&&transportCost>0?`<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;color:var(--accent2);"><span>+ Transport Cost</span><span>₹${fmt(transportCost)}</span></div>`:''}
    ${hasRoundOff?`<div style="display:flex;justify-content:space-between;margin-bottom:2px;font-size:12px;color:var(--muted);"><span>Actual Amount (before round-off)</span><span>₹${fmt(finalTotal)}</span></div>`:''}
    <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;color:var(--accent);border-top:1px solid var(--border);padding-top:8px;margin-top:4px;"><span>${hasRoundOff?'Final Amount':'TOTAL'}</span><span>₹${fmt(roundedTotal)}</span></div>`;
}

function toggleIncludeUdhaar(){
  _udhaarIncluded=!_udhaarIncluded;
  const btn=document.getElementById('includeUdhaarBtn');
  const tag=document.getElementById('udhaarIncludedTag');
  if(_udhaarIncluded){
    btn.textContent='✓ Udhaar Included — Click to remove';
    btn.style.background='rgba(34,197,94,.15)';
    btn.style.color='var(--green)';
    btn.style.borderColor='rgba(34,197,94,.4)';
    if(tag) tag.style.display='inline';
  } else {
    const pending=getUdhaarPendingForCust();
    btn.textContent=`+ Include Previous Udhaar (₹${fmt(pending)}) in this Bill`;
    btn.style.background='rgba(239,68,68,.15)';
    btn.style.color='var(--red)';
    btn.style.borderColor='rgba(239,68,68,.4)';
    if(tag) tag.style.display='none';
  }
  updateCheckoutTotal();
  updatePendingPreview();
}
function onPayTypeChange(){
  const v=document.getElementById('payType').value;
  document.getElementById('udhaarExtraWrap').style.display=v==='udhaar'?'block':'none';
  document.getElementById('partialAmtWrap').style.display=v==='partial'?'block':'none';
  document.getElementById('advanceOrderWrap').style.display=v==='advance'?'block':'none';
  document.getElementById('payMethodWrap').style.display=(v==='udhaar'||v==='advance')?'none':'block';
  // Set min for advance pack time to strictly future
  if(v==='advance'){
    const minTime=new Date(Date.now()+60*1000);
    const pad=n=>String(n).padStart(2,'0');
    document.getElementById('coAdvPackTime').min=`${pad(minTime.getHours())}:${pad(minTime.getMinutes())}`;
    // Re-bind calendar in case it wasn't initialized while hidden
    const ad=document.getElementById('coAdvPackDate');
    if(ad&&typeof ad._val==='undefined') calBind(ad);
  }
  if(v==='udhaar'){
    const udDate=document.getElementById('udhaarBillDate');
    if(udDate&&typeof udDate._val==='undefined') calBind(udDate);
  }
  // Mark name & phone required for udhaar/advance
  const req=(v==='udhaar'||v==='advance');
  document.getElementById('custNameReqMark').textContent=req?'*required':'(optional)';
  document.getElementById('custNameReqMark').style.color=req?'var(--red)':'var(--muted)';
  document.getElementById('custPhoneReqMark').textContent=req?'*required':'(optional)';
  document.getElementById('custPhoneReqMark').style.color=req?'var(--red)':'var(--muted)';
  updateCheckoutTotal();
}

function handleUdhaarPhotoUpload(input){
  const file=input.files[0]; if(!file) return;
  if(file.size>5*1024*1024){ notify('Image too large (max 5MB)','error'); return; }
  const reader=new FileReader();
  reader.onload=function(e){
    const img=new Image();
    img.onload=function(){
      const canvas=document.createElement('canvas');
      const max=600;
      let w=img.width, h=img.height;
      if(w>max||h>max){ const r=Math.min(max/w,max/h); w=Math.round(w*r); h=Math.round(h*r); }
      canvas.width=w; canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      const compressed=canvas.toDataURL('image/jpeg',0.7);
      document.getElementById('udhaarPhotoImg').src=compressed;
      document.getElementById('udhaarPhotoPreview').style.display='block';
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}
function clearUdhaarPhoto(){
  const fi=document.getElementById('udhaarBillPhoto');
  if(fi) fi.value='';
  const img=document.getElementById('udhaarPhotoImg');
  if(img) img.src='';
  const prev=document.getElementById('udhaarPhotoPreview');
  if(prev) prev.style.display='none';
}

function updatePendingPreview(){
  const {total}=getCartTotal();
  const extraUd=_udhaarIncluded?getUdhaarPendingForCust():0;
  const grandTotal=total+extraUd;
  const paid=parseFloat(document.getElementById('partialAmt').value)||0;
  const pending=grandTotal-paid;
  const prevEl=document.getElementById('pendingPreview');
  const chgEl=document.getElementById('changeReturnMsg');
  if(pending>0){
    prevEl.textContent=`₹${fmt(pending)} will go to Udhaar`;
    prevEl.style.color='var(--red)';
    if(chgEl){chgEl.style.display='none';}
  } else if(pending<0){
    prevEl.textContent='Fully paid! ✓';
    prevEl.style.color='var(--green)';
    if(chgEl){chgEl.textContent=`💵 Return ₹${fmt(Math.abs(pending))} to customer`;chgEl.style.display='block';}
  } else {
    prevEl.textContent='Fully paid! ✓';
    prevEl.style.color='var(--green)';
    if(chgEl){chgEl.style.display='none';}
  }
}

function updateAdvancePreview(){
  updateCheckoutTotal();
  const {total}=getCartTotal();
  const transportCost=parseFloat(document.getElementById('coTransportCost')?.value)||0;
  const grandTotal=total+transportCost;
  const paidNow=parseFloat(document.getElementById('coAdvPaidNow')?.value)||0;
  const balance=Math.max(0,grandTotal-paidNow);
  const change=paidNow>grandTotal?paidNow-grandTotal:0;
  const balEl=document.getElementById('coAdvBalanceOnDelivery');
  if(balEl) balEl.value=fmt(balance);
  const prev=document.getElementById('advancePayPreview');
  if(prev&&grandTotal>0){
    let html=`Paying now: <strong style="color:var(--green);">₹${fmt(Math.min(paidNow,grandTotal))}</strong> &nbsp;·&nbsp; Balance on delivery: <strong style="color:var(--accent);">₹${fmt(balance)}</strong>`;
    if(change>0){
      // Check if customer has pending udhaar
      const custName=(document.getElementById('custName')?.value||'').trim().toLowerCase();
      const existingRec=custName?udhaarRecords.find(r=>r.name.toLowerCase()===custName):null;
      const existingPending=existingRec?Math.max(0,existingRec.totalPending):0;
      if(existingPending>0){
        const udApply=Math.min(change,existingPending);
        const returnAmt=change-udApply;
        html+=`<br><span style="color:var(--accent2);">₹${fmt(udApply)} can be applied to pending udhaar</span>`;
        if(returnAmt>0.005) html+=` <span style="color:var(--green);">+ Return ₹${fmt(returnAmt)}</span>`;
        html+=` <span style="color:var(--muted);font-size:10px;">(you'll confirm on checkout)</span>`;
      } else {
        html+=`<br><strong style="color:var(--green);">💵 Return ₹${fmt(change)} to customer</strong>`;
      }
    }
    prev.innerHTML=html;
    prev.style.display='block';
  }
}

function toggleTransportSection(){
  const show=document.getElementById('coTransportChk')?.checked;
  document.getElementById('transportDetailsWrap').style.display=show?'block':'none';
  if(!show){
    ['coTransportRecipient','coTransportLocation','coTransportVehicle','coTransportCost','coDriverName','coDriverPhone']
      .forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    updateAdvancePreview();
  }
}
function updateUdhaarPreview(){
  const total=getCartTotals().billTotal;
  const nowPay=parseFloat(document.getElementById('udhaarPayNow').value)||0;
  const prev=document.getElementById('udhaarPayPreview');
  if(total<=0){ if(prev) prev.style.display='none'; return; }
  // Check if customer has existing udhaar
  const custName=(document.getElementById('custName')?.value||'').trim().toLowerCase();
  const existingRec=custName?udhaarRecords.find(r=>r.name.toLowerCase()===custName):null;
  const existingPending=existingRec?Math.max(0,existingRec.totalPending):0;
  if(nowPay>total){
    const excessAfterBill=nowPay-total;
    const udApplied=Math.min(excessAfterBill,existingPending);
    const returnToCustomer=excessAfterBill-udApplied;
    let html=`Paying now: <strong style="color:var(--green);">₹${fmt(total)}</strong> <span style="color:var(--muted);">(this bill fully paid)</span>`;
    if(udApplied>0&&existingRec){
      // Show which bills the excess goes toward
      let toShow=udApplied;
      const billDetails=[];
      existingRec.bills.filter(b=>b.pending>0).forEach(b=>{
        if(toShow<=0) return;
        const apply=Math.min(toShow,b.pending);
        billDetails.push(`<span style="color:var(--accent2);">${b.saleId}</span> (₹${fmt(apply)})`);
        toShow-=apply;
      });
      html+=`<br><span style="color:var(--green);">₹${fmt(udApplied)} applied to old bill${billDetails.length>1?'s':''}: ${billDetails.join(', ')}</span>`;
    }
    if(returnToCustomer>0.005) html+=`<br><strong style="color:var(--green);">💵 Return ₹${fmt(returnToCustomer)} to customer</strong>`;
    if(existingPending>0&&udApplied>=existingPending) html+=` &nbsp;<strong style="color:var(--green);">✅ All udhaar cleared!</strong>`;
    if(prev){ prev.innerHTML=html; prev.style.display='block'; }
  } else {
    const pending=total-nowPay;
    if(prev){
      prev.innerHTML=`Paying now: <strong style="color:var(--green);">₹${fmt(nowPay)}</strong> &nbsp;·&nbsp; Udhaar remaining: <strong style="color:${pending>0?'var(--red)':'var(--green)'};">₹${fmt(pending)}</strong>`;
      prev.style.display='block';
    }
  }
}

// ── ZERO STOCK NOTIFICATION ────────────────────────────────────────────────
function checkZeroStockAfterSale(sale){
  const zeroItems=sale.items.map(i=>{
    const p=products.find(x=>x.name===i.name);
    return p&&p.stock===0?p:null;
  }).filter(Boolean);
  if(zeroItems.length){
    zeroItems.forEach((p,idx)=>{
      setTimeout(()=>{
        notify(`📦 ${p.emoji} "${p.name}" is now OUT OF STOCK! Please restock.`,'error');
      },idx*2000);
    });
  }
}
function finalizeCheckout(){
  const custName=up(document.getElementById('custName').value);
  const custPhone=(document.getElementById('custPhone').value||'').trim();
  const payType=document.getElementById('payType').value;
  // Validate name & phone for udhaar/advance
  if(payType==='udhaar'||payType==='advance'){
    if(!custName){ notify('Customer name is required','error'); document.getElementById('custName').focus(); return; }
    if(!custPhone){ notify('Phone number is required','error'); document.getElementById('custPhone').focus(); return; }
    if(custPhone&&!validatePhone(custPhone)){ notify('Please enter a valid 10-digit phone number','error'); document.getElementById('custPhone').focus(); return; }
  }
  // Validate phone if entered for other types
  if(custPhone&&!validatePhone(custPhone)&&payType!=='udhaar'&&payType!=='advance'){ notify('Please enter a valid 10-digit phone number','error'); document.getElementById('custPhone').focus(); return; }

  // ADVANCE ORDER flow
  if(payType==='advance'){
    const packTime=calGetDt('coAdvPackDate','coAdvPackTime');
    if(!packTime){ notify('Please enter pickup/packing time','error'); document.getElementById('coAdvPackDate').focus(); return; }
    if(new Date(packTime)<=new Date()){ notify('Pack time must be AFTER current time!','error'); document.getElementById('coAdvPackDate').focus(); return; }
    const ct=getCartTotals();
    const applyTax=ct.applyTax;
    const sub=ct.sub;
    const tax=ct.tax;
    const transportCost=parseFloat(document.getElementById('coTransportCost')?.value)||0;
    const actualTotal=ct.billTotal+transportCost;
    const total=smartRound(actualTotal);
    const advPaid=parseFloat(document.getElementById('coAdvPaidNow').value)||0;
    const useTransport=document.getElementById('coTransportChk')?.checked;
    const transport=useTransport?{
      recipient:(document.getElementById('coTransportRecipient')?.value||'').trim(),
      location:(document.getElementById('coTransportLocation')?.value||'').trim(),
      vehicle:(document.getElementById('coTransportVehicle')?.value||'').trim(),
      cost:transportCost,
      driverName:(document.getElementById('coDriverName')?.value||'').trim(),
      driverPhone:(document.getElementById('coDriverPhone')?.value||'').trim()
    }:null;
    // Check if advance paid > order total AND customer has pending udhaar
    if(advPaid>total){
      const n=custName.toLowerCase();
      const existingRec=udhaarRecords.find(r=>r.name.toLowerCase()===n);
      const existingPending=existingRec?Math.max(0,existingRec.totalPending):0;
      const excess=advPaid-total;
      if(existingPending>0){
        const udApply=Math.min(excess,existingPending);
        const returnAmt=excess-udApply;
        const msg=`This customer paid ₹${fmt(excess)} extra.\n\nApply ₹${fmt(udApply)} to their pending udhaar${returnAmt>0.005?` and return ₹${fmt(returnAmt)} to customer`:''}?\n\nClick OK to apply, Cancel to just return ₹${fmt(excess)} to customer.`;
        if(confirm(msg)){
          // Apply excess to udhaar bills
          let toApply=udApply;
          existingRec.bills.forEach(b=>{
            if(toApply<=0||b.pending<=0) return;
            const apply=Math.min(toApply,b.pending);
            b.amtPaid+=apply; b.pending=Math.max(0,b.pending-apply);
            b.payments.push({amount:apply,date:_localDateStr(),note:'Extra advance from ADV order'});
            toApply-=apply;
          });
          recalcUd(existingRec);
          if(returnAmt>0.005) notify(`Advance saved! Return ₹${fmt(returnAmt)} to ${custName}.`);
        }
      }
    }
    advanceOrders.push({
      id:'ADV-'+String(nextAdvId++).padStart(4,'0'),
      custName, phone:custPhone, packTime:_localDateStr(new Date(packTime)),
      advPaid, notes:'', items:cart.map(i=>({productId:i.id,productName:i.name,emoji:i.emoji,price:i.customPrice!=null?i.customPrice:i.price,qty:i.qty,basePrice:(()=>{const _p=products.find(x=>x.id===i.id);return _p?_p.price:i.price;})(),customPrice:i.customPrice!=null?i.customPrice:null,overrideDisc:i.overrideDisc!=null?i.overrideDisc:null})),
      total, actualTotal, status:'scheduled', saleId:null, transport,
      taxApplied:applyTax, transportCost, discountPct:ct.discountPct, discount:ct.discount
    });
    closeModal('checkoutModal');
    addLedgerEntry(custName, custPhone, _localDateStr(), `Advance Order ADV-${nextAdvId-1}`, 0, advPaid);
    cart=[]; renderPOS(); saveAllData();
    notify(`✓ Advance Order saved for ${custName}! Check Advance Orders section.`);
    navigate('advance');
    return;
  }

  const ct=getCartTotals();
  const applyTax=ct.applyTax;
  const sub=ct.sub;
  const tax=ct.tax;
  const cartTotal=ct.billTotal;
  // Add previous udhaar to total if included
  const extraUd=_udhaarIncluded?getUdhaarPendingForCust():0;
  const actualTotal=cartTotal+extraUd;
  const total=smartRound(actualTotal);
  const method=payType==='udhaar'?'Udhaar':document.getElementById('payMethod').value;
  let amtPaid, pending;
  if(payType==='paid'){
    amtPaid=total; pending=0;
  } else if(payType==='udhaar'){
    const rawNowPay=parseFloat(document.getElementById('udhaarPayNow').value)||0;
    amtPaid=rawNowPay; pending=Math.max(0,total-amtPaid);
    // If customer pays more than the current bill (udhaar mode)
    // check if the excess can be applied to their existing udhaar bills
    if(rawNowPay>cartTotal&&!_udhaarIncluded){
      // Extra amount beyond current bill → apply to old udhaar
      const excessBeyondBill=rawNowPay-cartTotal;
      const n=(custName||'').toLowerCase();
      const existingRec=udhaarRecords.find(r=>r.name.toLowerCase()===n);
      if(existingRec&&existingRec.totalPending>0){
        const udApplied=Math.min(excessBeyondBill,existingRec.totalPending);
        let toApply=udApplied;
        existingRec.bills.forEach(b=>{
          if(toApply<=0||b.pending<=0) return;
          const apply=Math.min(toApply,b.pending);
          b.amtPaid+=apply; b.pending=Math.max(0,b.pending-apply);
          b.payments.push({amount:apply,date:_localDateStr(),note:'Extra payment from bill'});
          toApply-=apply;
        });
        recalcUd(existingRec);
        const returnAmt=excessBeyondBill-udApplied;
        // Current bill: fully paid
        amtPaid=cartTotal; pending=0;
        const saleIdTemp='TXN-'+String(nextSaleId++).padStart(6,'0');
        const sale={
          id:saleIdTemp, customerName:custName||'Walk-in', customerPhone:custPhone,
          items:cart.map(i=>({name:i.name,qty:i.qty,price:i.customPrice!=null?i.customPrice:i.price,gst:i.gst||0,originalPrice:i.price,customPrice:i.customPrice!=null?i.customPrice:null,basePrice:(()=>{const _p=products.find(x=>x.id===i.id);return _p?_p.price:i.price;})(),overrideDisc:i.overrideDisc!=null?i.overrideDisc:null,purchasePrice:(()=>{const _p=products.find(x=>x.id===i.id);return _p?_p.purchasePrice||0:0;})()})),
          sub,tax,total,actualTotal:cartTotal,method:'Udhaar',amtPaid,pending:0,
          date:_localDateStr(),taxApplied:applyTax,payType:'paid',change:returnAmt>0?returnAmt:0,
          discountPct:ct.discountPct, discount:ct.discount,
          ...gstBillDocMeta()
        };
        sales.push(sale);
        deductCartStock();
        closeModal('checkoutModal');
        showReceipt(sale);
        addLedgerEntry(custName||'Walk-in', custPhone, sale.date, `Sale ${sale.id} - ${sale.items.map(i=>i.name).join(', ')} (incl. ₹${fmt(udApplied)} prev udhaar)`, sale.total, sale.amtPaid);
        cart=[]; renderPOS(); saveAllData();
        setTimeout(()=>checkZeroStockAfterSale(sale),1500);
        let msg=`Bill paid! ₹${fmt(udApplied)} applied to previous udhaar.`;
        if(returnAmt>0) msg+=` Return ₹${fmt(returnAmt)} to customer.`;
        notify(msg);
        return;
      }
    }
  } else {
    const rawPaid=parseFloat(document.getElementById('partialAmt').value)||0;
    amtPaid=rawPaid; pending=Math.max(0,total-amtPaid);
  }
  // If customer overpaid, return change
  const change=amtPaid>total?amtPaid-total:0;
  if(change>0){
    const changeMsg=document.getElementById('fullyPaidChangeMsg');
    if(changeMsg){changeMsg.textContent=`💵 Return ₹${fmt(change)} to customer`;changeMsg.style.display='block';}
    amtPaid=total; pending=0;
  }
  const reference=document.getElementById('custReference')?.value?.trim()||'';
    const saleId='TXN-'+String(nextSaleId++).padStart(6,'0');
    const custLocation=document.getElementById('cartCustLocation')?.value?.trim()||_userLocation;
    const intra=isIntrastate();
    const gstMeta=gstBillDocMeta();
    const sale={
      id:saleId, customerName:custName||'Walk-in', customerPhone:custPhone,
      customerLocation:custLocation, intra,
      items:cart.map(i=>({name:i.name,qty:i.qty,price:i.customPrice!=null?i.customPrice:i.price,gst:i.gst||0,cgst:i.cgst||0,sgst:i.sgst||0,igst:i.igst||0,originalPrice:i.price,customPrice:i.customPrice!=null?i.customPrice:null,basePrice:(()=>{const _p=products.find(x=>x.id===i.id);return _p?_p.price:i.price;})(),overrideDisc:i.overrideDisc!=null?i.overrideDisc:null,purchasePrice:(()=>{const _p=products.find(x=>x.id===i.id);return _p?_p.purchasePrice||0:0;})()})),
      sub,tax,total,actualTotal,method,amtPaid,pending,
      date:_localDateStr(),taxApplied:applyTax,payType,
      udhaarIncluded:extraUd>0,extraUdhaarAmount:extraUd,change,
      discountPct:ct.discountPct, discount:ct.discount,
      ...gstMeta
    };
  sales.push(sale);
  deductCartStock();
  // If udhaar was included, mark it as paid in the record
  if(_udhaarIncluded&&extraUd>0){
    const n=(custName||'').toLowerCase();
    const rec=udhaarRecords.find(r=>r.name.toLowerCase()===n);
    if(rec){
      rec.bills.forEach(b=>{if(b.pending>0){b.amtPaid+=b.pending;b.payments.push({amount:b.pending,date:_localDateStr(),note:'Included in bill '+saleId});b.pending=0;}});
      recalcUd(rec);
    }
  }
  if(pending>0){
    const udPhoto=document.getElementById('udhaarPhotoImg')?.src||'';
    const udDateEl=document.getElementById('udhaarBillDate');
    const udBillDate=udDateEl?._val||udDateEl?.value||'';
    addUdhaarBill(custName||'Walk-in',custPhone,reference,sale,udBillDate,udPhoto);
  }
  closeModal('checkoutModal');
  showReceipt(sale);
  addLedgerEntry(custName||'Walk-in', custPhone, sale.date, `Sale ${sale.id} - ${sale.items.map(i=>i.name).join(', ')}`, sale.total, sale.amtPaid);
  cart=[]; renderPOS(); saveAllData();
  setTimeout(()=>checkZeroStockAfterSale(sale),1500);
}

function deductCartStock(){
  cart.forEach(item=>{
    const p=products.find(x=>x.id===item.id); if(!p) return;
    let toDeduct=item.qty;
    const ppb=Math.max(1,p.piecesPerBox||1);
    const fromPcs=Math.min(toDeduct,Math.max(0,p.noOfPieces||0));
    p.noOfPieces=Math.max(0,(p.noOfPieces||0)-fromPcs); toDeduct-=fromPcs;
    if(toDeduct>0&&(p.noOfBoxes||0)>0){
      const boxesNeeded=Math.ceil(toDeduct/ppb);
      const boxesToOpen=Math.min(boxesNeeded,Math.max(0,p.noOfBoxes||0));
      p.noOfBoxes=Math.max(0,(p.noOfBoxes||0)-boxesToOpen);
      p.noOfPieces=Math.max(0,(p.noOfPieces||0)+boxesToOpen*ppb-toDeduct);
    }
    p.stock=Math.max(0,calcTotalStock(p.noOfBoxes||0,p.noOfPieces||0,ppb));
  });
}

function itemTaxRates(item, intra){
  let cgst = item.cgst||0, sgst = item.sgst||0, igst = item.igst||0;
  if(intra !== false){
    igst = 0;
    if(!cgst && !sgst && (item.gst||0) > 0){ cgst = (item.gst||0)/2; sgst = (item.gst||0)/2; }
  } else {
    cgst = 0; sgst = 0;
    if(!igst && (item.gst||0) > 0) igst = item.gst||0;
  }
  return {cgst, sgst, igst};
}
function showReceipt(sale){
  const billText = getBillText(sale);
  _lastSaleBillText = billText;
  _lastSale = sale;
  storedBills.push({...sale, billText});

  // Build items table rows
  let tableRows = '';
  let sno = 1;
  let trueTotal = 0;
  let cgstTot = 0, sgstTot = 0, igstTot = 0;
  const hasAnyGst = sale.taxApplied && sale.items.some(i => (i.cgst||0) > 0 || (i.sgst||0) > 0 || (i.igst||0) > 0 || (i.gst||0) > 0);

  sale.items.forEach(i => {
    const priceUsed = (i.customPrice != null) ? i.customPrice : i.price;
    const lineBase  = parseFloat((priceUsed * i.qty).toFixed(2));
    const tr = itemTaxRates(i, sale.intra);
    const cgstAmt   = (sale.taxApplied && tr.cgst) ? parseFloat((lineBase * (tr.cgst / 100)).toFixed(2)) : 0;
    const sgstAmt   = (sale.taxApplied && tr.sgst) ? parseFloat((lineBase * (tr.sgst / 100)).toFixed(2)) : 0;
    const igstAmt   = (sale.taxApplied && tr.igst) ? parseFloat((lineBase * (tr.igst / 100)).toFixed(2)) : 0;
    const lineAmt   = parseFloat((lineBase + cgstAmt + sgstAmt + igstAmt).toFixed(2));
    trueTotal += lineAmt;
    cgstTot += cgstAmt; sgstTot += sgstAmt; igstTot += igstAmt;
    const baseForOrig = i.basePrice != null ? i.basePrice : (i.originalPrice!=null?i.originalPrice:i.price);
    const isOverride = i.customPrice != null && baseForOrig > i.customPrice;
    const ovPct = i.overrideDisc != null ? i.overrideDisc : (isOverride ? Math.round((1 - i.customPrice/baseForOrig)*100) : 0);
    const priceCell = isOverride
      ? `<span style="text-decoration:line-through;color:#9ca3af;font-size:12px;">₹${fmt(baseForOrig)}</span> <span style="color:#16a34a;font-weight:700;">→ ₹${fmt(i.customPrice)}</span>`
      : `₹${fmt(priceUsed)}`;
    const discNote = isOverride && ovPct>0 ? `<br><span style="font-size:9px;color:#16a34a;font-weight:600;">−${ovPct}% off</span>` : '';
    const gstCells = hasAnyGst
      ? `<td class="r">${cgstAmt > 0 ? '<span class="gst-cell">'+tr.cgst+'%<br>₹'+fmt(cgstAmt)+'</span>' : '—'}</td><td class="r">${sgstAmt > 0 ? '<span class="gst-cell">'+tr.sgst+'%<br>₹'+fmt(sgstAmt)+'</span>' : '—'}</td><td class="r">${igstAmt > 0 ? '<span class="gst-cell">'+tr.igst+'%<br>₹'+fmt(igstAmt)+'</span>' : '—'}</td>`
      : '';
    tableRows += `<tr>
      <td class="c">${sno++}</td>
      <td class="prod-name">${i.emoji||'📦'} ${i.name}${discNote}</td>
      <td class="r">${priceCell}</td>
      <td class="c">${i.qty}</td>
      ${gstCells}
      <td class="r amt-cell">₹${fmt(lineAmt)}</td>
    </tr>`;
  });
  trueTotal = smartRound(parseFloat(trueTotal.toFixed(2)));

  // Use trueTotal (sum of Amount column, rounded) as the bill total, minus discount
  const displaySale = {...sale, total: smartRound(trueTotal - (sale.discount||0))};

  // Totals block
  const totalsHTML = buildTotalsHTML(displaySale, {cgst:parseFloat(cgstTot.toFixed(2)), sgst:parseFloat(sgstTot.toFixed(2)), igst:parseFloat(igstTot.toFixed(2))});

  // Customer line
  const custLine = (sale.customerName && sale.customerName !== 'Walk-in')
    ? `<div class="rcpt-customer">Customer: <strong>${sale.customerName}</strong>${sale.customerPhone ? ' &nbsp;·&nbsp; 📞 ' + sale.customerPhone : ''}</div>`
    : '';

  const gstHeader = hasAnyGst ? `<th class="r">CGST</th><th class="r">SGST</th><th class="r">IGST</th>` : '';

  document.getElementById('receiptContent').innerHTML = `
    <div class="receipt" id="receiptPrintArea">
      <div class="receipt-header">
        <h2>🏪 ShopOS Store</h2>
        <div class="rcpt-date">${new Date(sale.date).toLocaleString('en-IN')}</div>
        ${custLine}
      </div>
      <div class="divider"></div>
      <div style="overflow-x:auto;">
      <table class="bill-table">
        <thead>
          <tr>
            <th class="c" style="width:32px">S.No</th>
            <th>Product</th>
            <th class="r">Price/pc</th>
            <th class="c">Qty</th>
            ${gstHeader}
            <th class="r">Amount</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      </div>
      <div class="bill-totals-wrap">
        ${totalsHTML}
      </div>
      <div class="receipt-footer">
        <div class="rcpt-txn">Payment: ${sale.method} &nbsp;·&nbsp; ${sale.id}</div>
        <div class="rcpt-thanks">Thank you! Visit again 🙏</div>
      </div>
    </div>`;
  document.getElementById('receiptModal').classList.add('open');
}

function buildTotalsHTML(sale, tax){
  tax = tax || {cgst:0,sgst:0,igst:0};
  const hasRoundOff=sale.actualTotal!=null&&Math.abs(sale.actualTotal-sale.total)>0.001;
  let html='';
  if(hasRoundOff){
    html += `<div style="display:flex;justify-content:space-between;margin:4px 0;font-size:13px;color:#000;"><span style="font-weight:600;letter-spacing:.5px;">Actual Amount</span><span style="font-weight:800;font-family:var(--font-head);">₹${fmt(sale.actualTotal)}</span></div>`;
    html += `<div style="text-align:center;font-size:11px;color:#000;font-weight:600;margin:2px 0 6px;">After Round-Off</div>`;
  }
  if(sale.discount && sale.discount > 0){
    html += `<div class="tot-row" style="color:#16a34a;"><span class="lbl">Discount (${sale.discountPct||0}%)</span><span class="val">−₹${fmt(sale.discount)}</span></div>`;
  }
  html += `<div class="grand-row"><span class="lbl">${hasRoundOff?'Final Amount':'Total Amount'}</span><span class="val">₹${smartRound(sale.total).toFixed(2)}</span></div>`;
  if(sale.payType === 'udhaar' || sale.payType === 'partial'){
    html += `<div class="tot-row paid-row"><span class="lbl">✓ Paid Now</span><span class="val">₹${fmt(sale.amtPaid)}</span></div>`;
    html += `<div class="tot-row udhaar-row"><span class="lbl">⚠ Udhaar Pending</span><span class="val">₹${fmt(sale.pending)}</span></div>`;
  }
  if(sale.change > 0){
    html += `<div class="tot-row" style="color:#555;"><span class="lbl">Change Returned</span><span class="val">₹${fmt(sale.change)}</span></div>`;
  }
  return html;
}

// ── BILL STORAGE & SHARING ──────────────────────────────────────────────────
let storedBills = [];
let _lastSaleBillText = '';
let _lastSale = null;

function getBillText(sale){
  const lines = [];
  lines.push('🏪 ShopOS Store');
  lines.push(new Date(sale.date).toLocaleString('en-IN'));
  if(sale.customerName && sale.customerName !== 'Walk-in'){
    lines.push(`Customer: ${sale.customerName}${sale.customerPhone ? ' · ' + sale.customerPhone : ''}`);
  }
  lines.push(BILL_LINE);
  // A GST invoice has to carry these on its face; without them the document is
  // not a valid tax invoice even when the figures are right.
  lines.push(...gstBillHeaderLines(sale));
  lines.push(BILL_LINE);
  lines.push(padRow('S.No','Product','Price/pc','Qty','Tax(C/S/I)','Amount'));
  lines.push(BILL_LINE);
  let sno=1;
  let cgstTot=0, sgstTot=0, igstTot=0;
  sale.items.forEach(i => {
    const priceUsed = (i.customPrice != null) ? i.customPrice : i.price;
    const lineBase  = priceUsed * i.qty;
    const tr = itemTaxRates(i, sale.intra);
    const cgstAmt = sale.taxApplied && tr.cgst ? (lineBase * (tr.cgst / 100)) : 0;
    const sgstAmt = sale.taxApplied && tr.sgst ? (lineBase * (tr.sgst / 100)) : 0;
    const igstAmt = sale.taxApplied && tr.igst ? (lineBase * (tr.igst / 100)) : 0;
    cgstTot += cgstAmt; sgstTot += sgstAmt; igstTot += igstAmt;
    const gstStr  = (sale.taxApplied && (cgstAmt||sgstAmt||igstAmt)) ? [tr.cgst>0?('C'+tr.cgst+'%'):'',tr.sgst>0?('S'+tr.sgst+'%'):'',tr.igst>0?('I'+tr.igst+'%'):''].filter(Boolean).join('+')+' (₹'+fmt(cgstAmt+sgstAmt+igstAmt)+')' : '—';
    const amt     = lineBase + cgstAmt + sgstAmt + igstAmt;
    const baseForOrig = i.basePrice != null ? i.basePrice : (i.originalPrice!=null?i.originalPrice:i.price);
    const isOv = i.customPrice != null && baseForOrig > i.customPrice;
    const ovPct = i.overrideDisc != null ? i.overrideDisc : (isOv ? Math.round((1 - i.customPrice/baseForOrig)*100) : 0);
    const priceStr = isOv ? `₹${fmt(baseForOrig)}→₹${fmt(i.customPrice)}` : '₹'+fmt(priceUsed);
    lines.push(padRow(sno++, i.name+((isOv&&ovPct>0)?` (${ovPct}% off)`:''), priceStr, i.qty, gstStr, '₹'+fmt(amt)));
  });
  lines.push(BILL_LINE);
  const hasBillRoundOff=sale.actualTotal!=null&&Math.abs(sale.actualTotal-sale.total)>0.001;
  if(hasBillRoundOff) lines.push(`Actual Amount: ₹${fmt(sale.actualTotal)}`);
  if(sale.discount && sale.discount > 0) lines.push(`Discount (${sale.discountPct||0}%): −₹${fmt(sale.discount)}`);
  lines.push(`${hasBillRoundOff?'FINAL AMOUNT':'TOTAL AMOUNT'}: ₹${fmt(sale.total)}`);
  if(sale.payType === 'udhaar' || sale.payType === 'partial'){
    lines.push(`Paid Now: ₹${fmt(sale.amtPaid)}`);
    lines.push(`Udhaar Pending: ₹${fmt(sale.pending)}`);
  }
  lines.push(`Payment: ${sale.method} · ${sale.id}`);
  lines.push('');
  lines.push('Thank you! Visit again 🙏');
  return lines.join('\n');
}

/**
 * Tax-invoice face lines. Rules:
 *  - Bill of Supply and anything not in a return gets no invoice numbering.
 *  - A document that charges no tax but says nothing about why is not a valid
 *    tax invoice either, so the reason is printed rather than left blank.
 *  - The buyer's GSTIN and their state code (place of supply) are mandatory on
 *    a B2B invoice and are what decides IGST vs CGST+SGST.
 */
function gstBillHeaderLines(sale){
  const out = [];
  const type = sale.docType || 'tax_invoice';
  const typeMeta = gstDocTypes().find((d) => d.value === type);
  const inReturn = !typeMeta || typeMeta.inReturn;
  const label = typeMeta ? typeMeta.label : type;

  if (!inReturn) return [`${label} · ${sale.id}`];

  const invNo = (sale.invoiceNo || sale.id).slice(0, 64);
  out.push(`${label} No: ${invNo}`);

  const gstin = (sale.custGstin || '').trim().toUpperCase();
  if (gstin) out.push(`Buyer GSTIN: ${gstin}`);
  out.push(`Place of supply: ${(sale.placeOfSupply || gstOwnStateCode() || '—')}` +
           (sale.isInterstate ? ' (inter-state)' : ' (intra-state)'));
  if (sale.reverseCharge) out.push('Reverse charge applicable');

  if (!sale.taxApplied || !cartHasTaxFor(sale)){
    const why = sale.nonGstReason || sale.nilRatedReason || sale.exemptReason || 'No tax charged';
    out.push(`Non-taxable supply: ${why}`);
  }
  if ((type === 'credit_note' || type === 'debit_note') && sale.linkedInvoiceNo){
    out.push(`Against invoice: ${sale.linkedInvoiceNo}${sale.noteReason ? ' · ' + sale.noteReason : ''}`);
  }
  if (sale.exportPaymentType){
    out.push(`Export payment: ${sale.exportPaymentType === 'WPAY' ? 'paid' : 'to be paid'}`);
  }
  return out;
}

/** Tax on any line of an already-saved sale (cartHasTax works on the live cart). */
function cartHasTaxFor(sale){
  return (sale.items || []).some((i) => (i.gst || 0) > 0 || (i.cgst || 0) > 0 || (i.sgst || 0) > 0 || (i.igst || 0) > 0);
}

function padRow(...cols){
  const widths = [4, 13, 8, 3, 12, 8];
  const parts = cols.map((c, idx) => {
    let s = String(c == null ? '' : c);
    if (s.length > widths[idx]) s = s.slice(0, widths[idx] - 1) + '…';
    return (idx === 1 || idx === 4) ? s.padEnd(widths[idx]) : s.padStart(widths[idx]);
  });
  return parts.join(' ');
}
const BILL_LINE = '─'.repeat(53);

/* ── Generate full styled HTML page for PDF/Print ── */
function getReceiptHTML(){
  const el = document.getElementById('receiptPrintArea');
  return el ? el.outerHTML : '';
}

function buildFullReceiptHTML(sale){
  sale = sale || _lastSale;
  if(!sale) return '';

  // Build table rows
  let tableRows = '';
  let sno = 1;
  let pdfTotal = 0;
  let cgstTotPdf = 0, sgstTotPdf = 0, igstTotPdf = 0;
  const hasAnyGstPdf = sale.taxApplied && sale.items.some(i => (i.cgst||0) > 0 || (i.sgst||0) > 0 || (i.igst||0) > 0 || (i.gst||0) > 0);
  sale.items.forEach(i => {
    const priceUsed = (i.customPrice != null) ? i.customPrice : i.price;
    const lineBase  = parseFloat((priceUsed * i.qty).toFixed(2));
    const tr = itemTaxRates(i, sale.intra);
    const cgstAmt   = (sale.taxApplied && tr.cgst) ? parseFloat((lineBase * (tr.cgst / 100)).toFixed(2)) : 0;
    const sgstAmt   = (sale.taxApplied && tr.sgst) ? parseFloat((lineBase * (tr.sgst / 100)).toFixed(2)) : 0;
    const igstAmt   = (sale.taxApplied && tr.igst) ? parseFloat((lineBase * (tr.igst / 100)).toFixed(2)) : 0;
    const lineAmt   = parseFloat((lineBase + cgstAmt + sgstAmt + igstAmt).toFixed(2));
    pdfTotal += lineAmt;
    cgstTotPdf += cgstAmt; sgstTotPdf += sgstAmt; igstTotPdf += igstAmt;
    const baseForOrig = i.basePrice != null ? i.basePrice : (i.originalPrice!=null?i.originalPrice:i.price);
    const isOv = i.customPrice != null && baseForOrig > i.customPrice;
    const ovPct = i.overrideDisc != null ? i.overrideDisc : (isOv ? Math.round((1 - i.customPrice/baseForOrig)*100) : 0);
    const priceCell = isOv
      ? `<span style="text-decoration:line-through;color:#9ca3af;">₹${fmt(baseForOrig)}</span> <span style="color:#16a34a;font-weight:700;">→ ₹${fmt(i.customPrice)}</span>`
      : `₹${fmt(priceUsed)}`;
    const nameCell = `${i.emoji||'📦'} ${i.name}${(isOv&&ovPct>0)?`<br><span style="font-size:9px;color:#16a34a;font-weight:600;">−${ovPct}% off</span>`:''}`;
    const gstTd = hasAnyGstPdf
      ? `<td style="text-align:right;color:#d97706;font-size:10px;">${cgstAmt>0 ? tr.cgst+'%<br>₹'+fmt(cgstAmt) : '—'}</td><td style="text-align:right;color:#d97706;font-size:10px;">${sgstAmt>0 ? tr.sgst+'%<br>₹'+fmt(sgstAmt) : '—'}</td><td style="text-align:right;color:#d97706;font-size:10px;">${igstAmt>0 ? tr.igst+'%<br>₹'+fmt(igstAmt) : '—'}</td>`
      : '';
    tableRows += `<tr>
      <td style="text-align:center;color:#666;">${sno++}</td>
      <td>${nameCell}</td>
      <td style="text-align:right;">${priceCell}</td>
      <td style="text-align:center;">${i.qty}</td>
      ${gstTd}
      <td style="text-align:right;font-weight:700;">₹${fmt(lineAmt)}</td>
    </tr>`;
  });
  pdfTotal = parseFloat(pdfTotal.toFixed(2));
  const gstThPdf = hasAnyGstPdf ? `<th class="r">CGST</th><th class="r">SGST</th><th class="r">IGST</th>` : '';

  // Totals
  let totalsRows = '';
  if(sale.discount && sale.discount > 0)
    totalsRows += `<tr style="color:#16a34a;"><td class="tl">Discount (${sale.discountPct||0}%)</td><td class="tr">−₹${fmt(sale.discount)}</td></tr>`;
  if(sale.payType==='udhaar'||sale.payType==='partial'){
    totalsRows += `<tr style="color:#16a34a;"><td class="tl">✓ Paid Now</td><td class="tr">₹${fmt(sale.amtPaid)}</td></tr>`;
    totalsRows += `<tr style="color:#ef4444;font-weight:700;"><td class="tl">⚠ Udhaar Pending</td><td class="tr">₹${fmt(sale.pending)}</td></tr>`;
  }
  if(sale.change > 0)
    totalsRows += `<tr style="color:#555;"><td class="tl">Change Returned</td><td class="tr">₹${fmt(sale.change)}</td></tr>`;

  const custLine = (sale.customerName && sale.customerName !== 'Walk-in')
    ? `<div style="margin:6px auto;background:#f7f7f7;border-radius:6px;padding:6px 14px;display:inline-block;font-size:12px;color:#444;">
        Customer: <strong style="color:#111;">${sale.customerName}</strong>${sale.customerPhone ? ' &nbsp;·&nbsp; 📞 ' + sale.customerPhone : ''}
       </div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Bill_${sale.id}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:#f3f4f6;font-family:'Courier New',monospace;font-size:14px;padding:30px 20px;}
    .page{max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);}
    .head{background:#111;color:#fff;padding:28px 30px;text-align:center;}
    .head h1{font-size:26px;font-weight:900;letter-spacing:-0.5px;color:#f0c040;font-family:Georgia,serif;margin-bottom:4px;}
    .head .sub{color:#aaa;font-size:12px;letter-spacing:2px;text-transform:uppercase;}
    .head .dt{color:#ddd;font-size:13px;margin-top:8px;}
    .cust-wrap{padding:14px 24px;background:#f9f9f9;border-bottom:1px solid #eee;text-align:center;}
    .body{padding:0 0 24px;}
    table.items{width:100%;border-collapse:collapse;}
    table.items thead tr{background:#f4f4f4;border-bottom:2px solid #e0e0e0;}
    table.items th{padding:10px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#555;text-align:left;}
    table.items th.r,table.items td.r{text-align:right;}
    table.items th.c,table.items td.c{text-align:center;}
    table.items td{padding:11px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;vertical-align:middle;word-break:break-word;overflow-wrap:anywhere;}
    table.items{width:100%;table-layout:fixed;}
    table.items th:first-child,table.items td:first-child{width:34px;}
    table.items td:nth-child(2){word-break:break-word;overflow-wrap:anywhere;}
    table.items tbody tr:last-child td{border-bottom:none;}
    .totals-section{margin:0 20px;border-top:1.5px dashed #d0d0d0;padding-top:10px;}
    table.totals{width:100%;border-collapse:collapse;}
    table.totals td{padding:5px 10px;font-size:13px;}
    .tl{color:#666;} .tr{text-align:right;font-weight:600;color:#111;}
    .grand-bar{background:#111;border-radius:8px;margin:12px 20px 0;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;}
    .grand-bar .gl{color:#ddd;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
    .grand-bar .gv{color:#f0c040;font-size:22px;font-weight:900;font-family:Georgia,serif;}
    .footer{text-align:center;padding:18px 24px 24px;border-top:1px dashed #e0e0e0;margin-top:14px;}
    .footer .txn{font-size:12px;color:#999;margin-bottom:6px;}
    .footer .thanks{font-size:14px;color:#333;}
    @media print{body{background:#fff;padding:0;}.page{box-shadow:none;border-radius:0;max-width:100%;}}
  </style>
  </head><body>
  <div class="page">
    <div class="head">
      <h1>🏪 ShopOS Store</h1>
      <div class="sub">Tax Invoice / Bill of Supply</div>
      <div class="dt">${new Date(sale.date).toLocaleString('en-IN')}</div>
    </div>
    ${custLine ? `<div class="cust-wrap">${custLine}</div>` : ''}
    <div class="body">
      <table class="items">
        <thead><tr>
          <th class="c" style="width:34px">S.No</th>
          <th>Product</th>
          <th class="r">Price/pc</th>
          <th class="c">Qty</th>
          ${gstThPdf}
          <th class="r">Amount</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${totalsRows ? `<div class="totals-section"><table class="totals"><tbody>${totalsRows}</tbody></table></div>` : ''}
      ${sale.actualTotal!=null&&Math.abs(sale.actualTotal-sale.total)>0.001?`<div style="display:flex;justify-content:space-between;margin:8px 20px 0;font-size:13px;color:#000;"><span style="font-weight:600;letter-spacing:.5px;">Actual Amount</span><span style="font-weight:800;font-family:Georgia,serif;">₹${fmt(sale.actualTotal)}</span></div><div style="text-align:center;font-size:11px;color:#000;font-weight:600;margin:2px 20px 6px;">After Round-Off</div>`:''}
      <div class="grand-bar">
        <span class="gl">${sale.actualTotal!=null&&Math.abs(sale.actualTotal-sale.total)>0.001?'Final Amount':'Total Amount'}</span>
        <span class="gv">₹${fmt(sale.total)}</span>
      </div>
      <div class="footer">
        <div class="txn">Payment: ${sale.method} &nbsp;·&nbsp; ${sale.id}</div>
        <div class="thanks">Thank you! Visit again 🙏</div>
      </div>
    </div>
  </div>
  </body></html>`;
}

/* ── Download as PDF using print-to-PDF trick ── */
function downloadBillPDF(){
  const html = buildFullReceiptHTML(_lastSale);
  const blob = new Blob([html], {type:'text/html'});
  const url  = URL.createObjectURL(blob);
  const win = window.open(url,'_blank');
  if(win){
    win.onload = ()=>{
      setTimeout(()=>{
        win.document.title = `Bill_${_lastSale?.id||'receipt'}`;
        win.print();
      }, 400);
    };
  }
  setTimeout(()=>URL.revokeObjectURL(url), 60000);
  notify('Opening PDF print dialog…');
}

/* ── Print bill ── */
function printBill(){
  const html = buildFullReceiptHTML(_lastSale);
  const blob = new Blob([html], {type:'text/html'});
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url,'_blank');
  if(win){
    win.onload = ()=>{ setTimeout(()=>win.print(), 300); };
  }
  setTimeout(()=>URL.revokeObjectURL(url), 60000);
}

/* ── WhatsApp: send PDF + text via WhatsApp ── */
function buildBillMessage(sale){
  const itemsList = sale.items.map((i,idx)=>{
    const priceUsed = (i.customPrice!=null) ? i.customPrice : i.price;
    return `${idx+1}. ${i.name} × ${i.qty}  ₹${fmt(priceUsed*i.qty)}`;
  }).join('\n');
  const cgstTot=sale.items.reduce((a,i)=>a+itemTaxRates(i, sale.intra).cgst * (sale.taxApplied? ( (i.customPrice!=null?i.customPrice:i.price) * i.qty) : 0)/100,0);
  const sgstTot=sale.items.reduce((a,i)=>a+itemTaxRates(i, sale.intra).sgst * (sale.taxApplied? ( (i.customPrice!=null?i.customPrice:i.price) * i.qty) : 0)/100,0);
  const igstTot=sale.items.reduce((a,i)=>a+itemTaxRates(i, sale.intra).igst * (sale.taxApplied? ( (i.customPrice!=null?i.customPrice:i.price) * i.qty) : 0)/100,0);
  return (
    `🏪 *ShopOS Store — Bill Receipt*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📅 ${new Date(sale.date).toLocaleString('en-IN')}\n` +
    ((sale.customerName&&sale.customerName!=='Walk-in') ? `👤 ${sale.customerName}\n` : '') +
    `🧾 TXN: ${sale.id}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${itemsList}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Subtotal: ₹${fmt(sale.sub)}\n` +
    (cgstTot>0 ? `CGST: ₹${fmt(cgstTot)}\n` : '') +
    (sgstTot>0 ? `SGST: ₹${fmt(sgstTot)}\n` : '') +
    (igstTot>0 ? `IGST: ₹${fmt(igstTot)}\n` : '') +
    (sale.discount&&sale.discount>0 ? `Discount (${sale.discountPct||0}%): −₹${fmt(sale.discount)}\n` : '') +
    ((sale.actualTotal!=null&&Math.abs(sale.actualTotal-sale.total)>0.001) ? `Actual: ₹${fmt(sale.actualTotal)}\n`:'') +
    `*💰 TOTAL: ₹${fmt(sale.total)}*\n` +
    (sale.payType==='udhaar'||sale.payType==='partial'
      ? `✅ Paid: ₹${fmt(sale.amtPaid)} | ⚠ Pending: ₹${fmt(sale.pending)}\n` : '') +
    `Payment: ${sale.method}\n\n` +
    `_Thank you! Visit again 🙏_`
  );
}
async function generateReceiptPdfBlob(){
  if(!window.html2canvas || !window.jspdf) return null;
  const el = document.getElementById('receiptPrintArea');
  if(!el) return null;
  const canvas = await html2canvas(el, {scale:2, backgroundColor:'#ffffff', useCORS:true, logging:false});
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p','mm','a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const imgW = pageW - margin*2;
  const imgH = canvas.height * (imgW / canvas.width);
  let position = margin;
  pdf.addImage(canvas.toDataURL('image/jpeg',0.92), 'JPEG', margin, position, imgW, imgH);
  let remaining = imgH - (pageH - margin*2);
  while(remaining > 0){
    position = position - (pageH - margin*2);
    pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/jpeg',0.92), 'JPEG', margin, position, imgW, imgH);
    remaining -= (pageH - margin*2);
  }
  return pdf.output('blob');
}
function copyTextToClipboard(text){
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).catch(()=>{});
      return true;
    }
  }catch(e){}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
  return true;
}

async function sendBillWhatsApp(){
  if(!_lastSale){ notify('No bill to send','error'); return; }
  const sale = _lastSale;
  const phone = sale.customerPhone || '';
  const waMsg = buildBillMessage(sale);
  const fname = `ShopOS_Bill_${sale.id}_${new Date(sale.date).toLocaleDateString('en-IN').replace(/\//g,'-')}.pdf`;
  const cleanPhone = phone.replace(/\D/g,'');
  const hasValidPhone = cleanPhone && cleanPhone.length >= 10;
  const copyTarget = hasValidPhone
    ? cleanPhone
    : ((sale.customerName && sale.customerName !== 'Walk-in') ? sale.customerName : '');
  if(copyTarget) copyTextToClipboard(copyTarget);

  // Build a real PDF to attach in WhatsApp
  const pdfBlob = await generateReceiptPdfBlob();
  let pdfSaved = false;
  let shared = false;
  if(pdfBlob){
    const file = new File([pdfBlob], fname, {type:'application/pdf'});
    // Try the share sheet first (phones/tablets AND Windows: WhatsApp Desktop appears as a share target)
    if(navigator.share){
      try{
        await navigator.share({files:[file], text: waMsg});
        shared = true;
      }catch(e){
        if(e && e.name==='AbortError') return; // user closed the sheet
        // share unavailable/failed (e.g. Firefox) → fall through to desktop path
      }
    }
    if(!shared){
      // Desktop: save the PDF so it can be attached in the open WhatsApp chat
      const a = document.createElement('a');
      a.href = URL.createObjectURL(pdfBlob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(a.href), 15000);
      pdfSaved = true;
    }
  }

  if(shared){
    notify(copyTarget
      ? `📤 Share sheet khula — WhatsApp mein "${copyTarget}" clipboard pe copy ho gaya, search box mein Ctrl+V (paste) karo, phir Send.`
      : '📤 Share sheet khula — WhatsApp Desktop choose karo, chat select karo, PDF attached ho jayega.');
    return;
  }

  // Open WhatsApp directly to the customer's number (message pre-filled, no need to retype number)
  setTimeout(()=>{
    let waUrl;
    if(hasValidPhone && /^[6-9]\d{9}$/.test(cleanPhone)){
      waUrl = `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(waMsg)}`;
    } else if(hasValidPhone){
      waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waMsg)}`;
    } else {
      waUrl = `https://wa.me/?text=${encodeURIComponent(waMsg)}`;
    }
    window.open(waUrl, '_blank');
    notify(pdfSaved
      ? `📄 Bill PDF saved in Downloads. WhatsApp chat (${phone}) open hai — number clipboard pe hai, search mein Ctrl+V karke chat dhoondo, 📎 attach karke Send karo.`
      : '✅ WhatsApp opened — share the bill.');
  }, 500);
}


// ── UDHAAR ───────────────────────────────────────────────────────────────────
function addUdhaarBill(name,phone,reference,sale,customDate,photo){
  name=up(name);
  let rec=udhaarRecords.find(r=>r.name.toLowerCase()===name.toLowerCase());
  const billDate=customDate?customDate+'T00:00:00':sale.date;
  const bill={
    saleId:sale.id, date:billDate,
    totalBill:sale.total, amtPaid:sale.amtPaid, pending:sale.pending,
    payments:sale.amtPaid>0?[{amount:sale.amtPaid,date:billDate,note:'At billing ('+sale.method+')'}]:[],
    items:sale.items, photo:photo||undefined
  };
  if(rec){
    rec.bills.push(bill);
    rec.totalBill=(rec.totalBill||0)+sale.total;
    rec.totalPaid=(rec.totalPaid||0)+sale.amtPaid;
    rec.totalPending=(rec.totalPending||0)+sale.pending;
    if(phone&&!rec.phone) rec.phone=phone;
    if(reference&&!rec.reference) rec.reference=reference;
  } else {
    udhaarRecords.push({
      id:'UD-'+Date.now(), name, phone:phone||'', reference:reference||'',
      bills:[bill],
      totalBill:sale.total, totalPaid:sale.amtPaid, totalPending:sale.pending
    });
  }
  saveAllData();
}

function recalcUd(rec){
  rec.totalBill=rec.bills.reduce((a,b)=>a+b.totalBill,0);
  rec.totalPaid=rec.bills.reduce((a,b)=>a+b.amtPaid,0);
  rec.totalPending=rec.bills.reduce((a,b)=>a+b.pending,0);
  rec.credit=Math.max(0,(rec.credit||0));
}

function renderUdhaar(){
  const wrap=document.getElementById('udhaarWrap');
  const sb=document.getElementById('udhaarSummaryBar');
  const totalPending=udhaarRecords.reduce((a,r)=>a+r.totalPending,0);
  const pendingCount=udhaarRecords.filter(r=>r.totalPending>0).length;
  const clearedCount=udhaarRecords.filter(r=>r.totalPending<=0).length;
  sb.innerHTML=`
    <div class="stat-card red interactive-card" onclick="setUdhaarFilter('pending')" title="Click to show pending customers only">
      <div class="stat-label">Total Pending <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value red">₹${fmt(totalPending)}</div>
      <div class="stat-sub">Across all customers</div>
    </div>
    <div class="stat-card yellow interactive-card" onclick="setUdhaarFilter('all')" title="Click to show all customers">
      <div class="stat-label">Customers <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value yellow">${udhaarRecords.length}</div>
      <div class="stat-sub">With udhaar history · ${pendingCount} active</div>
    </div>
    <div class="stat-card green interactive-card" onclick="setUdhaarFilter('cleared')" title="Click to show cleared customers">
      <div class="stat-label">Cleared <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value green">${clearedCount}</div>
      <div class="stat-sub">Fully paid off</div>
    </div>`;
  if(!udhaarRecords.length){
    wrap.innerHTML=`<div class="empty-state"><div class="big">💸</div><p>No udhaar records yet.<br>Created automatically when billing with credit.</p></div>`;
    return;
  }
  // Sort and filter controls
  let filtered=[...udhaarRecords];
  if(wrap._filter==='pending') filtered=filtered.filter(r=>r.totalPending>0);
  else if(wrap._filter==='cleared') filtered=filtered.filter(r=>r.totalPending<=0);
  // Sort
  const sortBy=wrap._sort||'pending_desc';
  if(sortBy==='pending_desc') filtered.sort((a,b)=>b.totalPending-a.totalPending);
  else if(sortBy==='pending_asc') filtered.sort((a,b)=>a.totalPending-b.totalPending);
  else if(sortBy==='name') filtered.sort((a,b)=>a.name.localeCompare(b.name));
  else if(sortBy==='oldest') filtered.sort((a,b)=>{const da=b.bills?.[0]?.date||0;const db=a.bills?.[0]?.date||0;return new Date(da)-new Date(db);});
  else if(sortBy==='newest') filtered.sort((a,b)=>{const da=a.bills?.[0]?.date||0;const db=b.bills?.[0]?.date||0;return new Date(da)-new Date(db);});
  const sortLabel={pending_desc:'Pending: High to Low',pending_asc:'Pending: Low to High',name:'Name A-Z',oldest:'Oldest First',newest:'Newest First'};
  wrap.innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
      <span style="font-size:12px;color:var(--muted);">Sort by:</span>
      ${Object.entries(sortLabel).map(([k,v])=>`<button class="filter-pill${sortBy===k?' active':''}" onclick="setUdhaarSort('${k}')">${v}</button>`).join('')}
      <span style="margin-left:auto;font-size:12px;color:var(--muted);">${filtered.length} record${filtered.length!==1?'s':''}</span>
    </div>
    ${filtered.map(rec=>{
      const pct=rec.totalBill>0?Math.min(100,rec.totalPaid/rec.totalBill*100):100;
      const oldestBill=rec.bills?.find(b=>b.pending>0);
      const pendingSince=oldestBill?getTimeSince(oldestBill.date):'';
      const hasCredit = (rec.credit||0) > 0;
      const remInfo = getUdhaarReminderInfo(rec);
      // Last transaction date
      const allDates = [];
      rec.bills.forEach(b => { allDates.push(b.date); (b.payments||[]).forEach(p => allDates.push(p.date)); });
      allDates.sort((a,b) => new Date(b) - new Date(a));
      const lastTxnDate = allDates.length ? new Date(allDates[0]).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '';
      return `<div class="ud-card" onclick="openUdhaarDetail('${rec.id}')">
        <div class="ud-card-header">
          <div>
            <div class="ud-card-name">👤 ${rec.name}${pendingSince&&rec.totalPending>0?` <span style="margin-left:10px;font-size:16px;color:var(--red);font-weight:800;letter-spacing:0.5px;">⏳ Pending since ${pendingSince}</span>`:''}${lastTxnDate?` <span style="margin-left:14px;font-size:15px;color:var(--accent2);font-weight:800;">🕐 ${lastTxnDate}</span>`:''}</div>
            ${rec.phone?`<div class="ud-card-phone" style="display:flex;align-items:center;gap:10px;margin-top:8px;">
              <span style="cursor:pointer;display:flex;align-items:center;gap:6px;" title="Click to copy phone" onclick="event.stopPropagation();copyUdhaarPhone('${String(rec.phone).replace(/'/g,"\\'")}')"><span style="font-size:15px;">📞</span> ${rec.phone}</span>
              <button class="wa-ico-btn" title="WhatsApp ${rec.phone}" onclick="event.stopPropagation();waUdhaar('${String(rec.phone).replace(/'/g,"\\'")}','${String(rec.name).replace(/'/g,"\\'")}')">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              </button>
            </div>`:''}
            ${rec.reference?`<div style="font-size:13px;color:var(--accent2);margin-top:8px;">🏷️ ${rec.reference}</div>`:''}
            ${hasCredit?`<div style="font-size:12px;color:var(--accent2);margin-top:8px;">💰 Credit: ₹${fmt(rec.credit)}</div>`:''}
            ${remInfo?`<div style="margin-top:10px;background:rgba(64,200,240,.12);border:1px solid rgba(64,200,240,.3);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--accent2);font-weight:700;line-height:1.5;">${remInfo}</div>`:''}
          </div>
          <div style="margin-left:auto;text-align:right;">
            <div class="ud-pending" style="color:${hasCredit?'var(--accent2)':rec.totalPending<=0?'var(--green)':'var(--red)'};">${hasCredit?`₹${fmt(rec.credit)}`:`₹${fmt(rec.totalPending)}`}</div>
            <div class="ud-sub-info">${hasCredit?'Credit available':`of ₹${fmt(rec.totalBill)}`}</div>
          </div>
        </div>
        <div class="progress-bar" style="margin-top:4px;"><div class="progress-fill" style="width:${pct}%;background:${rec.totalPending<=0?'var(--green)':'var(--red)'};"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:12px;">
          <span style="font-size:14px;font-weight:700;">Paid: ₹${fmt(rec.totalPaid)}</span>
          <span>${rec.bills.length} bill${rec.bills.length!==1?'s':''}</span>
          <span>${hasCredit?'💰 Credit':rec.totalPending<=0?'✅ Cleared':'⏳ Pending'}</span>
        </div>
      </div>`;
    }).join('')}`;
}

function setUdhaarFilter(f){
  const wrap=document.getElementById('udhaarWrap');
  wrap._filter=f;
  renderUdhaar();
}
function setUdhaarSort(s){
  const wrap=document.getElementById('udhaarWrap');
  wrap._sort=s;
  renderUdhaar();
}

function copyUdhaarPhone(phone){
  if(!phone) return;
  (navigator.clipboard ? navigator.clipboard.writeText(phone) : Promise.reject()).then(
    () => notify(`📞 Phone copied: ${phone}`),
    () => { const ta=document.createElement('textarea'); ta.value=phone; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); notify(`📞 Phone copied: ${phone}`);}catch(e){ notify('Copy failed','error'); } document.body.removeChild(ta); }
  );
}

function waUdhaar(phone, name){
  let p = String(phone||'').replace(/[^0-9]/g,'');
  if(p.length===10) p='91'+p;
  if(p.length<10){ notify('No valid phone number','error'); return; }
  const ud = udhaarRecords.find(r => (r.name||'').toLowerCase() === String(name||'').toLowerCase());
  const pending = ud ? ud.totalPending : 0;
  const dn = ud ? ud.name : (name||'Customer');
  let msg = `Namaste *${dn}* 🙏\n\n`;
  msg += `Aapka yeh dukaan par baaki hua udhaar abhi tak pending hai. 👇\n`;
  msg += `💰 *Pending Amount:* ₹${fmt(pending)}\n`;
  if(ud && ud.totalBill) msg += `📄 *Total Billed:* ₹${fmt(ud.totalBill)}\n`;
  msg += `\nKripya jaldi zyada pay karne ka koshish karein. Thank you! 🙏`;
  window.open(`https://wa.me/${p}?text=${encodeURIComponent(msg)}`, '_blank');
}

function openUdhaarDetail(id){
  const rec=udhaarRecords.find(r=>r.id===id); if(!rec) return;
  document.getElementById('udDetailId').value=id;
  document.getElementById('udDetailTitle').textContent=`💸 ${rec.name}`;
  document.getElementById('udPayAmt').value='';
  document.getElementById('udPayNote').value='';
  // Read existing date filter values if present
  const dateFrom = document.getElementById('udDateFrom')?._val || document.getElementById('udDateFrom')?.value || '';
  const dateTo = document.getElementById('udDateTo')?._val || document.getElementById('udDateTo')?.value || '';
  // Filter bills by date range
  let bills = rec.bills;
  if(dateFrom) bills = bills.filter(b => new Date(b.date) >= new Date(dateFrom + 'T00:00:00'));
  if(dateTo) bills = bills.filter(b => new Date(b.date) <= new Date(dateTo + 'T23:59:59'));
  const pendingBills=bills.filter(b=>b.pending>0);
  let billsHtml='';
  bills.forEach((bill,idx)=>{
    const bPct=bill.totalBill>0?Math.min(100,bill.amtPaid/bill.totalBill*100):100;
    const billPendingTimeSince=bill.pending>0?getTimeSince(bill.date):'';
    billsHtml+=`<div class="bill-row">
      <div class="bill-row-header">
        ${pendingBills.length>1&&bill.pending>0?`<input type="checkbox" id="billSelect_${idx}" class="bill-checkbox" value="${idx}" checked style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" title="Include this bill in payment">`:''}
        <span class="badge badge-blue">${bill.saleId}</span>
        <span style="font-size:11px;color:var(--muted);">${new Date(bill.date).toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</span>
        ${billPendingTimeSince&&bill.pending>0?`<span style="font-size:14px;color:var(--red);margin-left:4px;font-weight:800;">⏳ ${billPendingTimeSince}</span>`:''}
        <span style="margin-left:auto;font-size:13px;font-weight:600;color:${bill.pending<=0?'var(--green)':'var(--red)'};">₹${fmt(bill.pending)} pending</span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">${bill.items.map(i=>`${i.name}×${i.qty}`).join(', ')}</div>
      ${bill.photo?`<div style="margin-bottom:6px;"><img src="${bill.photo}" style="max-width:80px;max-height:80px;border-radius:8px;border:1px solid var(--border);cursor:pointer;" onclick="window.open('${bill.photo}','_blank')" title="View bill photo"></div>`:''}
      <div class="progress-bar" style="margin-bottom:6px;"><div class="progress-fill" style="width:${bPct}%;background:${bill.pending<=0?'var(--green)':'var(--red)'};"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);">
        <span>Billed: ₹${fmt(bill.totalBill)}</span><span>Paid: ₹${fmt(bill.amtPaid)}</span>
      </div>
      ${bill.payments.length?`<div style="margin-top:8px;">
        ${bill.payments.map(pay=>`<div class="payment-entry">
          <span>${new Date(pay.date).toLocaleDateString('en-IN')}${pay.note?' · '+pay.note:''}</span>
          <span style="color:var(--green);">+₹${fmt(pay.amount)}</span>
        </div>`).join('')}
      </div>`:''}
    </div>`;
  });
  // Date filter controls
  const filterActive = dateFrom || dateTo;
  const dateFilterHtml = `
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">📅 Filter Bill History (Date Interval)</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:130px;">
          <span style="font-size:11px;color:var(--muted);">From</span>
          <input type="text" id="udDateFrom" data-calendar value="${dateFrom}" readonly placeholder="DD-MMM-YYYY" style="flex:1;padding:9px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);font-size:13px;color:var(--text);cursor:pointer;">
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:130px;">
          <span style="font-size:11px;color:var(--muted);">To</span>
          <input type="text" id="udDateTo" data-calendar value="${dateTo}" readonly placeholder="DD-MMM-YYYY" style="flex:1;padding:9px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);font-size:13px;color:var(--text);cursor:pointer;">
        </div>
        ${filterActive?`<button class="btn btn-ghost btn-sm" onclick="var id=document.getElementById('udDetailId').value;var df=document.getElementById('udDateFrom');var dt=document.getElementById('udDateTo');if(df){df._val='';df.value='';}if(dt){dt._val='';dt.value='';}openUdhaarDetail(id)">✕ Clear</button>`:''}
      </div>
    </div>`;
  const html=`
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;">
      <div style="text-align:center;padding:8px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">TOTAL BILLED</div>
        <div style="font-size:16px;font-weight:700;">₹${fmt(rec.totalBill)}</div>
      </div>
      <div style="text-align:center;padding:8px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">PAID</div>
        <div style="font-size:16px;font-weight:700;color:var(--green);">₹${fmt(rec.totalPaid)}</div>
      </div>
      <div style="text-align:center;padding:8px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">PENDING</div>
        <div style="font-size:16px;font-weight:700;color:var(--red);">₹${fmt(rec.totalPending)}</div>
      </div>
      <div style="text-align:center;padding:8px;background:rgba(64,200,240,.08);border:1px solid rgba(64,200,240,.2);border-radius:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">CREDIT</div>
        <div style="font-size:16px;font-weight:700;color:var(--accent2);">₹${fmt(rec.credit||0)}</div>
      </div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:12px;">
      ${rec.phone?`<span style="display:inline-flex;align-items:center;gap:10px;">📞 <span style="cursor:pointer;" title="Click to copy" onclick="copyUdhaarPhone('${String(rec.phone).replace(/'/g,"\\'")}')">${rec.phone}</span><button class="wa-ico-btn" style="width:32px;height:32px;" title="WhatsApp ${rec.phone}" onclick="waUdhaar('${String(rec.phone).replace(/'/g,"\\'")}','${String(rec.name).replace(/'/g,"\\'")}')"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></button></span>`:''}
      ${rec.reference?`<span>🏷️ ${rec.reference}</span>`:''}
      ${(rec.credit||0)>0?`<span style="color:var(--accent2);font-weight:600;">💰 Credit: ₹${fmt(rec.credit)} available</span>`:''}
    </div>
    ${pendingBills.length>1?`<div style="background:rgba(64,200,240,.07);border:1px solid rgba(64,200,240,.2);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--accent2);margin-bottom:10px;">
      💡 Customer has <strong>${pendingBills.length} pending bills</strong>. Checkboxes below let you choose which bills to apply payment to.
    </div>`:''}
    ${dateFilterHtml}
    <div class="modal-section" style="display:flex;align-items:center;justify-content:space-between;">
      <span>Bill History ${filterActive?`<span style="font-size:11px;color:var(--muted);">(filtered)</span>`:''}</span>
      <span style="font-size:10px;color:var(--muted);">${bills.length} of ${rec.bills.length} bill${rec.bills.length!==1?'s':''}</span>
    </div>
    <div style="max-height:280px;overflow-y:auto;padding-right:4px;margin-bottom:8px;">
      ${billsHtml}
    </div>`;
  document.getElementById('udDetailContent').innerHTML=html;
  document.querySelectorAll('#udDetailContent input[data-calendar]').forEach(el => calBind(el));
  document.getElementById('udhaarDetailModal').classList.add('open');
}

function recordUdPayment(){
  const id=document.getElementById('udDetailId').value;
  const rec=udhaarRecords.find(r=>r.id===id); if(!rec) return;
  const amt=parseFloat(document.getElementById('udPayAmt').value)||0;
  if(amt<=0){ notify('Enter a valid payment amount','error'); return; }
  const note=document.getElementById('udPayNote').value.trim();
  // Check which bills are selected (if multi-bill selection is present)
  const checkboxes=document.querySelectorAll('.bill-checkbox');
  let selectedIndices=null;
  if(checkboxes.length>0){
    selectedIndices=[];
    checkboxes.forEach(cb=>{ if(cb.checked) selectedIndices.push(parseInt(cb.value)); });
    if(selectedIndices.length===0){ notify('Please select at least one bill to apply payment to','error'); return; }
  }
  // If no pending bills, record as customer credit/prepayment
  if(rec.totalPending<=0&&rec.credit===undefined){
    rec.credit=0;
    rec.bills.forEach(b=>{ if(b.pending<0) rec.credit+=Math.abs(b.pending); });
  }
  if(rec.totalPending<=0&&rec.credit<=0&&!rec.bills.some(b=>b.pending>0)){
    rec.bills.push({
      saleId:'PREPAY-'+Date.now(), date:_localDateStr(),
      totalBill:0, amtPaid:0, pending:0,
      payments:[{amount:amt,date:_localDateStr(),note:note||'Credit / Prepayment'}],
      items:[]
    });
    rec.credit=(rec.credit||0)+amt;
    recalcUd(rec);
    addLedgerEntry(rec.name, rec.phone, _localDateStr(), `Credit / Prepayment`, 0, amt);
    closeModal('udhaarDetailModal'); renderUdhaar(); saveAllData();
    notify(`✓ ₹${fmt(amt)} recorded as credit for ${rec.name}`);
    return;
  }
  let remaining=amt;
  rec.bills.forEach((bill,idx)=>{
    if(remaining<=0||bill.pending<=0) return;
    if(selectedIndices!==null&&!selectedIndices.includes(idx)) return;
    const apply=Math.min(remaining,bill.pending);
    bill.amtPaid+=apply; bill.pending=Math.max(0,bill.pending-apply);
    bill.payments.push({amount:apply,date:_localDateStr(),note});
    remaining-=apply;
  });
  recalcUd(rec);
  const returnChange=remaining>0?remaining:0;
  if(rec.totalPending<=0&&rec.bills.length>1){
    rec.bills=[rec.bills[rec.bills.length-1]]; recalcUd(rec);
  }
  addLedgerEntry(rec.name, rec.phone, _localDateStr(), `Payment received - ₹${fmt(amt-returnChange)} applied to bills`, 0, amt-returnChange);
  closeModal('udhaarDetailModal'); renderUdhaar(); saveAllData();
  if(returnChange>0){
    document.getElementById('rtcTitle').textContent=`Return to ${rec.name}`;
    document.getElementById('rtcAmount').textContent=`₹${fmt(returnChange)}`;
    document.getElementById('rtcDetails').innerHTML=
      `<strong>${rec.name}</strong>${rec.phone?` · 📞 ${rec.phone}`:''} has overpaid.<br>Please return this amount in cash.`;
    document.getElementById('rtcTxnInfo').innerHTML=
      `<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>Amount Paid</span><span style="color:var(--green);font-weight:600;">₹${fmt(amt)}</span></div>`+
      `<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>Applied to Bills</span><span>₹${fmt(amt-returnChange)}</span></div>`+
      `<div style="display:flex;justify-content:space-between;"><span>💵 To Return</span><span style="color:var(--green);font-weight:700;">₹${fmt(returnChange)}</span></div>`;
    document.getElementById('returnToCustomerModal').classList.add('open');
  } else {
    notify(`✓ ₹${fmt(amt)} recorded for ${rec.name}`);
  }
}

// ── CUSTOMERS ─────────────────────────────────────────────────────────────────
function renderCustomers(){
  const search = (document.getElementById('custSearch')?.value||'').toLowerCase();
  const customerMap = new Map();
  sales.forEach(s => {
    const key = (s.customerName||'Walk-in').toLowerCase();
    if(!customerMap.has(key)) customerMap.set(key, { name:s.customerName||'Walk-in', phone:s.customerPhone||'', sales:[], udhaar:null, advances:[] });
    customerMap.get(key).sales.push(s);
  });
  udhaarRecords.forEach(u => {
    const key = u.name.toLowerCase();
    if(customerMap.has(key)) customerMap.get(key).udhaar = u;
    else customerMap.set(key, { name:u.name, phone:u.phone||'', sales:[], udhaar:u, advances:[] });
  });
  advanceOrders.forEach(a => {
    const key = (a.custName||'').toLowerCase();
    if(key){
      if(customerMap.has(key)) customerMap.get(key).advances.push(a);
      else customerMap.set(key, { name:a.custName, phone:a.phone||'', sales:[], udhaar:null, advances:[a] });
    }
  });
  let customers = Array.from(customerMap.values());
  if(search) customers = customers.filter(c => matchWords(c.name,search) || c.phone.includes(search));
  customers.sort((a,b) => a.name.localeCompare(b.name));
  document.getElementById('custCount').textContent = customers.length + ' customer' + (customers.length!==1?'s':'');
  const wrap = document.getElementById('customersWrap');
  if(!customers.length){
    wrap.innerHTML = `<div class="empty-state"><div class="big">👥</div><p>No customers yet. Start billing to see customers here.</p></div>`;
    return;
  }
  wrap.innerHTML = `<table><thead><tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Total Spent</th><th>Udhaar</th><th>Credit</th></tr></thead><tbody>${
    customers.map(c => {
      const totalSpent = c.sales.reduce((sum,s) => sum + (s.total||0), 0);
      const orderCount = c.sales.length + c.advances.length;
      const pending = c.udhaar ? (c.udhaar.totalPending||0) : 0;
      const credit = c.udhaar ? (c.udhaar.credit||0) : 0;
      return `<tr style="cursor:pointer;" onclick="openCustomerDetail('${escHtml(c.name)}')">
        <td><strong>${escHtml(c.name)}</strong></td>
        <td>${c.phone||'—'}</td>
        <td>${orderCount}</td>
        <td style="color:var(--accent);font-weight:600;">₹${fmt(totalSpent)}</td>
        <td style="color:${pending>0?'var(--red)':'var(--muted)'};">${pending>0?`₹${fmt(pending)}`:'—'}</td>
        <td style="color:${credit>0?'var(--accent2)':'var(--muted)'};">${credit>0?`₹${fmt(credit)}`:'—'}</td>
      </tr>`;
    }).join('')
  }</tbody></table>`;
}

function openCustomerDetail(name){
  const salesList = sales.filter(s => (s.customerName||'Walk-in').toLowerCase() === name.toLowerCase());
  const udhaarRec = udhaarRecords.find(u => u.name.toLowerCase() === name.toLowerCase());
  const advList = advanceOrders.filter(a => (a.custName||'').toLowerCase() === name.toLowerCase());
  document.getElementById('custDetailTitle').textContent = `👤 ${name}`;
  let html = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">
    <div style="text-align:center;padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">TOTAL ORDERS</div>
      <div style="font-size:20px;font-weight:700;">${salesList.length + advList.length}</div>
    </div>
    <div style="text-align:center;padding:10px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:8px;">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">TOTAL SPENT</div>
      <div style="font-size:20px;font-weight:700;color:var(--green);">₹${fmt(salesList.reduce((s,sa)=>s+(sa.total||0),0))}</div>
    </div>
    <div style="text-align:center;padding:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">UDHAAR PENDING</div>
      <div style="font-size:20px;font-weight:700;color:${(udhaarRec?.totalPending||0)>0?'var(--red)':'var(--muted)'};">₹${fmt(udhaarRec?.totalPending||0)}</div>
    </div>
  </div>`;
  if(udhaarRec && (udhaarRec.credit||0) > 0){
    html += `<div style="background:rgba(64,200,240,.07);border:1px solid rgba(64,200,240,.2);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--accent2);margin-bottom:12px;">💰 Credit Balance: ₹${fmt(udhaarRec.credit)}</div>`;
  }
  // Ledger
  const ledger = customerLedgers.find(l => l.customerName.toLowerCase() === name.toLowerCase());
  // Shop / delivery location
  const ledgerLoc = ledger ? (ledger.location||null) : null;
  html += `<div class="modal-section">📍 Shop / Delivery Location</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
      <div style="flex:1;font-size:12px;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;">
        ${ledgerLoc ? escapeHtml(ledgerLoc.address||(''+ledgerLoc.lat+', '+ledgerLoc.lng)) : '<span style="color:var(--muted);">No location saved for this customer.</span>'}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="setCustomerLocation('${String(name).replace(/'/g,"\\'")}')">${ledgerLoc?'✏️ Edit':'🗺️ Set'}</button>
      ${ledgerLoc?'<button class="btn btn-ghost btn-sm" onclick="openMapFromData('+ledgerLoc.lat+','+ledgerLoc.lng+')">Open</button>':''}
    </div>`;
  if(ledger && ledger.entries.length){
    html += `<div class="modal-section">📒 Ledger</div>
    <div style="max-height:250px;overflow-y:auto;margin-bottom:12px;">
    <table style="width:100%;font-size:11px;"><thead><tr>
      <th style="text-align:left;padding:4px 6px;">Date</th>
      <th style="text-align:left;padding:4px 6px;">Description</th>
      <th style="text-align:right;padding:4px 6px;">Debit</th>
      <th style="text-align:right;padding:4px 6px;">Credit</th>
      <th style="text-align:right;padding:4px 6px;">Balance</th>
    </tr></thead><tbody>${
      ledger.entries.map(e => `<tr>
        <td style="padding:4px 6px;color:var(--muted);">${new Date(e.date).toLocaleDateString('en-IN')}</td>
        <td style="padding:4px 6px;">${escHtml(e.description)}</td>
        <td style="padding:4px 6px;text-align:right;color:${e.debit>0?'var(--red)':'var(--muted)'};">${e.debit>0?'₹'+fmt(e.debit):'—'}</td>
        <td style="padding:4px 6px;text-align:right;color:${e.credit>0?'var(--green)':'var(--muted)'};">${e.credit>0?'₹'+fmt(e.credit):'—'}</td>
        <td style="padding:4px 6px;text-align:right;font-weight:600;">₹${fmt(e.balance)}</td>
      </tr>`).join('')
    }</tbody></table>
    </div>`;
  }
  if(salesList.length){
    html += `<div class="modal-section">🧾 Sales (${salesList.length})</div>
    <div style="max-height:200px;overflow-y:auto;margin-bottom:12px;">`;
    salesList.sort((a,b)=>new Date(b.date)-new Date(a.date)).forEach(s => {
      html += `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--surface1);">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span><span class="badge badge-blue">${s.id}</span> <span style="font-size:11px;color:var(--muted);">${new Date(s.date).toLocaleDateString('en-IN')}</span></span>
          <span style="font-weight:600;color:var(--accent);">₹${fmt(s.total)}</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">${s.items.map(i=>`${i.name||i.productName}×${i.qty}`).join(', ')}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">${s.method||'Cash'} · Paid: ₹${fmt(s.amtPaid)}${s.pending>0?` · <span style="color:var(--red);">Pending: ₹${fmt(s.pending)}</span>`:''}</div>
      </div>`;
    });
    html += `</div>`;
  }
  if(advList.length){
    html += `<div class="modal-section">📋 Advance Orders (${advList.length})</div>
    <div style="max-height:200px;overflow-y:auto;margin-bottom:12px;">`;
    advList.sort((a,b)=>new Date(b.packTime)-new Date(a.packTime)).forEach(a => {
      html += `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--surface1);">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span><span class="badge badge-blue">${a.id}</span> <span style="font-size:11px;color:var(--muted);">${new Date(a.packTime).toLocaleDateString('en-IN')}</span></span>
          <span style="font-weight:600;color:var(--accent);">₹${fmt(a.total)}</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">${a.items.map(i=>`${i.productName||i.name}×${i.qty}`).join(', ')}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">Status: <span style="color:${a.status==='billed'?'var(--green)':'var(--accent)'};">${a.status}</span> · Paid: ₹${fmt(a.advPaid)}</div>
      </div>`;
    });
    html += `</div>`;
  }
  if(udhaarRec && udhaarRec.bills?.length){
    html += `<div class="modal-section">💸 Udhaar Bills (${udhaarRec.bills.length})</div>
    <div style="max-height:200px;overflow-y:auto;margin-bottom:12px;">`;
    udhaarRec.bills.slice().reverse().forEach(b => {
      html += `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--surface1);">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span><span class="badge badge-blue">${b.saleId}</span> <span style="font-size:11px;color:var(--muted);">${new Date(b.date).toLocaleDateString('en-IN')}</span></span>
          <span style="font-weight:600;color:${b.pending>0?'var(--red)':'var(--green)'};">₹${fmt(b.pending)} pending</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">${(b.items||[]).map(i=>`${i.name||i.productName}×${i.qty}`).join(', ')}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px;">Billed: ₹${fmt(b.totalBill)} · Paid: ₹${fmt(b.amtPaid)}</div>
      </div>`;
    });
    html += `</div>`;
  }
  if(!salesList.length && !advList.length && !(udhaarRec?.bills?.length)){
    html += `<div class="empty-state"><div class="big">📭</div><p>No transactions found for this customer.</p></div>`;
  }
  html += `<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('customerDetailModal')">Close</button><button class="btn btn-primary" onclick="printCustomerLedger()">🖨️ Print Ledger</button></div>`;
  document.getElementById('custDetailContent').innerHTML = html;
  document.getElementById('customerDetailModal').classList.add('open');
}

function setCustomerLocation(name){
  const ledger = getOrCreateLedger(name, '');
  const cur = ledger.location || null;
  openMapPicker({
    lat: cur ? cur.lat : null,
    lng: cur ? cur.lng : null,
    address: cur ? cur.address : '',
    onConfirm: r => {
      ledger.location = { lat: r.lat, lng: r.lng, address: r.address };
      saveAllData();
      notify('📍 Customer location saved','success');
      openCustomerDetail(name);
    }
  });
}

function printCustomerLedger(){
  const name = (document.getElementById('custDetailTitle').textContent||'').replace('👤 ','').trim();
  if(!name) return;
  const salesList = sales.filter(s => (s.customerName||'Walk-in').toLowerCase() === name.toLowerCase());
  const udhaarRec = udhaarRecords.find(u => u.name.toLowerCase() === name.toLowerCase());
  const advList = advanceOrders.filter(a => (a.custName||'').toLowerCase() === name.toLowerCase());
  const totalSpent = salesList.reduce((s,sa) => s+(sa.total||0), 0);
  // Total Paid = initial sale payments + additional udhaar payments
  let totalPaid = salesList.reduce((s,sa) => s+(sa.amtPaid||0), 0);
  if(udhaarRec){
    udhaarRec.bills.forEach(b => {
      const saleMatch = salesList.find(sa => sa.id === b.saleId);
      if(saleMatch){
        // Add any extra payments made beyond the initial sale amtPaid
        if(b.amtPaid > saleMatch.amtPaid) totalPaid += (b.amtPaid - saleMatch.amtPaid);
      } else {
        // Bill not in sales (prepay or from advance order)
        totalPaid += b.amtPaid;
      }
    });
  }
  const pending = udhaarRec ? (udhaarRec.totalPending||0) : 0;
  const now = new Date().toLocaleString('en-IN');
  let rows = '';
  // Sales
  salesList.sort((a,b)=>new Date(b.date)-new Date(a.date)).forEach(s => {
    const items = (s.items||[]).map(i => `${i.name||i.productName}×${i.qty}`).join(', ');
    rows += `<tr><td>${s.id}</td><td>${new Date(s.date).toLocaleDateString('en-IN')}</td><td>${items}</td><td>₹${fmt(s.total)}</td><td>₹${fmt(s.amtPaid)}</td><td style="color:${s.pending>0?'red':'green'};">${s.pending>0?`₹${fmt(s.pending)}`:'✓'}</td><td>${s.method||'Cash'}</td></tr>`;
  });
  // Advance orders
  advList.sort((a,b)=>new Date(b.packTime)-new Date(a.packTime)).forEach(a => {
    const items = (a.items||[]).map(i => `${i.productName||i.name}×${i.qty}`).join(', ');
    rows += `<tr style="background:#f0f0f0;"><td>${a.id}</td><td>${a.packTime?new Date(a.packTime).toLocaleDateString('en-IN'):'—'}</td><td>${items}</td><td>₹${fmt(a.total)}</td><td>₹${fmt(a.advPaid)}</td><td style="color:${(a.total-a.advPaid)>0?'orange':'green'};">${(a.total-a.advPaid)>0?`₹${fmt(a.total-a.advPaid)}`:'✓'}</td><td>Advance</td></tr>`;
  });
  // Udhaar payments
  if(udhaarRec){
    udhaarRec.bills.forEach(b => {
      (b.payments||[]).forEach(p => {
        rows += `<tr style="background:#fff8e0;"><td>${b.saleId}</td><td>${new Date(p.date).toLocaleDateString('en-IN')}</td><td>Payment received</td><td>—</td><td style="color:green;">+₹${fmt(p.amount)}</td><td>—</td><td>${p.note||'Udhaar payment'}</td></tr>`;
      });
    });
  }
  // Ledger entries
  const ledger = customerLedgers.find(l => l.customerName.toLowerCase() === name.toLowerCase());
  let ledgerRows = '';
  if(ledger && ledger.entries.length){
    ledger.entries.forEach(e => {
      ledgerRows += `<tr>
        <td>${new Date(e.date).toLocaleDateString('en-IN')}</td>
        <td>${escHtml(e.description)}</td>
        <td style="color:${e.debit>0?'#d00':'#999'};">${e.debit>0?'₹'+fmt(e.debit):'—'}</td>
        <td style="color:${e.credit>0?'#080':'#999'};">${e.credit>0?'₹'+fmt(e.credit):'—'}</td>
        <td style="font-weight:600;">₹${fmt(e.balance)}</td>
      </tr>`;
    });
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ledger — ${escHtml(name)}</title>
  <style>
    @page { margin: 15mm; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #222; padding: 20px; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .sub { color: #666; font-size: 12px; margin-bottom: 20px; }
    .stats { display: flex; gap: 16px; margin-bottom: 20px; }
    .stat { background: #f5f5f5; padding: 10px 16px; border-radius: 6px; text-align: center; flex: 1; }
    .stat div:first-child { font-size: 11px; color: #666; }
    .stat div:last-child { font-size: 20px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th { background: #222; color: #fff; padding: 8px 10px; text-align: left; font-size: 11px; text-transform: uppercase; }
    td { padding: 7px 10px; border-bottom: 1px solid #ddd; font-size: 12px; }
    tr:nth-child(even) { background: #f9f9f9; }
    .footer { margin-top: 30px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #ddd; padding-top: 12px; }
    .section-title { font-size: 14px; font-weight: 600; margin: 16px 0 8px; }
  </style></head><body>
    <h1>📒 Customer Ledger — ${escHtml(name)}</h1>
    <div class="sub">Generated on ${now}</div>
    <div class="stats">
      <div class="stat"><div>Orders</div><div>${salesList.length + advList.length}</div></div>
      <div class="stat"><div>Total Spent</div><div>₹${fmt(totalSpent)}</div></div>
      <div class="stat"><div>Total Paid</div><div>₹${fmt(totalPaid)}</div></div>
      <div class="stat"><div>Pending</div><div style="color:${pending>0?'#d00':'#080'};">${pending>0?`₹${fmt(pending)}`:'₹0'}</div></div>
    </div>
    <div class="section-title">📋 Transactions</div>
    <table><thead><tr><th>ID</th><th>Date</th><th>Items</th><th>Total</th><th>Paid</th><th>Balance</th><th>Method</th></tr></thead>
    <tbody>${rows||'<tr><td colspan="7" style="text-align:center;color:#999;">No transactions</td></tr>'}</tbody></table>
    ${ledgerRows ? `<div class="section-title">📒 Running Ledger</div>
    <table><thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
    <tbody>${ledgerRows}</tbody></table>` : ''}
    <div class="footer">ShopOS — Customer Ledger</div>
  </body></html>`;
  const win = window.open('', '_blank');
  if(win){
    win.document.write(html);
    win.document.close();
    win.onload = () => setTimeout(() => win.print(), 300);
  }
}

// ── INVENTORY HISTORY ────────────────────────────────────────────────────────
function openAddInvEntry(){
  ['ieSupplier','ieDestination','ieTransportProvider','ieTransportCost','ieTransportPaid','ieSupplierBill','ieSupplierBillPaid','ieParcelCount','ieNotes'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  ['ieTransportStatus','ieSupplierBillStatus'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='paid';updateCustSelText(id);});
  _supplierManualStatus=false;_transportManualStatus=false;
  resetIeGstFields();
  clearInvEntryPhoto();
  _invEntryRowCount=0;
  document.getElementById('invEntryRows').innerHTML='';
  addInvEntryRow();
  document.getElementById('invEntryModal').classList.add('open');
  updateSupplierBillStatus(); updateTransportBillStatus();
  setTimeout(()=>document.getElementById('ieDestination').focus(),100);
}
function updateSupplierBillStatus(){
  const total=parseFloat(document.getElementById('ieSupplierBill')?.value)||0;
  const paid=parseFloat(document.getElementById('ieSupplierBillPaid')?.value)||0;
  const sel=document.getElementById('ieSupplierBillStatus');
  const info=document.getElementById('ieSupplierBillInfo');
  if(!info)return;
  if(total<=0){if(sel&&!_supplierManualStatus){sel.value='paid';updateCustSelText(sel.id);}info.textContent='';return;}
  if(paid>=total){
    if(sel&&!_supplierManualStatus){sel.value='paid';updateCustSelText(sel.id);}
    info.textContent=paid>total?'⚠️ ₹'+fmt(paid-total)+' extra — wapas le len':'✅ Settled';
    info.style.color='var(--green)';
  } else {
    if(sel&&!_supplierManualStatus){sel.value='due';updateCustSelText(sel.id);}
    info.textContent='⏳ ₹'+fmt(total-paid)+' baaki';
    info.style.color='var(--red)';
  }
}
function updateTransportBillStatus(){
  const total=parseFloat(document.getElementById('ieTransportCost')?.value)||0;
  const paid=parseFloat(document.getElementById('ieTransportPaid')?.value)||0;
  const sel=document.getElementById('ieTransportStatus');
  const info=document.getElementById('ieTransportBillInfo');
  if(!info)return;
  if(total<=0){if(sel&&!_transportManualStatus){sel.value='paid';updateCustSelText(sel.id);}info.textContent='';return;}
  if(paid>=total){
    if(sel&&!_transportManualStatus){sel.value='paid';updateCustSelText(sel.id);}
    info.textContent=paid>total?'⚠️ ₹'+fmt(paid-total)+' extra — wapas le len':'✅ Settled';
    info.style.color='var(--green)';
  } else {
    if(sel&&!_transportManualStatus){sel.value='due';updateCustSelText(sel.id);}
    info.textContent='⏳ ₹'+fmt(total-paid)+' baaki';
    info.style.color='var(--red)';
  }
}

function previewInvEntryPhoto(input,previewId){
  const preview=document.getElementById(previewId);
  if(!preview) return;
  if(!input.files||!input.files[0]){preview.style.display='none';return;}
  const file=input.files[0];
  const isImage=file.type.startsWith('image/');
  input._fileName=file.name;
  input._fileType=file.type;
  const reader=new FileReader();
  reader.onload=function(e){
    const data=e.target.result;
    input._base64=data; file._base64=data;
    if(isImage){
      preview.innerHTML=`<img src="${data}" style="max-width:100px;max-height:80px;border-radius:6px;border:1px solid var(--border);display:block;">`;
    } else {
      const icon=file.type.includes('pdf')?'📄':file.type.includes('spreadsheet')||file.name.match(/\.xlsx?$/i)?'📊':'📁';
      preview.innerHTML=`<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--accent2);padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;cursor:pointer;" onclick="event.stopPropagation();downloadBase64File('${data}','${file.name}')">${icon} ${file.name}</div>`;
    }
    preview.style.display='block';
  };
  reader.readAsDataURL(file);
}
function clearInvEntryPhoto(){
  ['ieTransportPhoto','ieSupplierBillPhoto'].forEach(id=>{const el=document.getElementById(id);if(el){el.value='';delete el._base64;delete el._fileName;delete el._fileType;}});
  ['ieTransportPhotoPreview','ieSupplierBillPhotoPreview'].forEach(id=>{const el=document.getElementById(id);if(el){el.innerHTML='';el.style.display='none';}});
}
function downloadBase64File(data,fileName){
  const a=document.createElement('a');
  a.href=data;
  a.download=fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function addInvEntryRow(){
  const idx=_invEntryRowCount++;
  const row=document.createElement('div');
  row.id=`ieRow_${idx}`;
  row.style.cssText='display:grid;grid-template-columns:1.8fr 0.7fr 0.7fr 0.7fr 1fr auto;gap:6px;margin-bottom:10px;align-items:end;';
  row.innerHTML=`
    <div class="form-group" style="margin:0;">${idx===0?'<label style="font-size:11px;color:var(--muted);">Product</label>':''}
      <div class="combo-wrap" id="ieProdWrap_${idx}" style="position:relative;">
        <input id="ieProdText_${idx}" class="combo-input" placeholder="Search..." autocomplete="off" style="width:100%;"
          oninput="ieProductSearch(${idx})"
          onblur="setTimeout(()=>ieProductClose(${idx}),200)"
          onfocus="ieProductSearch(${idx})">
        <input type="hidden" id="ieProduct_${idx}">
        <div id="ieProdList_${idx}" class="combo-list" style="display:none;position:absolute;z-index:2000;width:100%;max-height:200px;overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px;top:calc(100% + 4px);left:0;"></div>
      </div>
    </div>
    <div class="form-group" style="margin:0;">${idx===0?'<label style="font-size:11px;color:var(--muted);">Boxes</label>':''}
      <input id="ieBoxes_${idx}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx})">
    </div>
    <div class="form-group" style="margin:0;">${idx===0?'<label style="font-size:11px;color:var(--muted);">Pcs</label>':''}
      <input id="iePieces_${idx}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx})">
    </div>
    <div class="form-group" style="margin:0;">${idx===0?'<label style="font-size:11px;color:var(--muted);">Purc. Price/PC</label>':''}
      <input id="ieCost_${idx}" type="number" step="0.01" min="0" placeholder="0" style="width:100%;padding:9px 8px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--surface1);color:var(--text);height:40px;">
    </div>
    <div class="form-group" style="margin:0;">${idx===0?'<label style="font-size:11px;color:var(--muted);">Total</label>':''}
      <div id="ieTotal_${idx}" style="padding:9px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--accent);text-align:center;height:40px;display:flex;align-items:center;justify-content:center;">0 pcs</div>
    </div>
    <button class="btn btn-danger btn-sm" style="margin-top:${idx===0?'17':'0'}px;" onclick="removeInvEntryRow(${idx})">✕</button>`;
  document.getElementById('invEntryRows').appendChild(row);
}

function ieProductSearch(idx){
  const q=(document.getElementById(`ieProdText_${idx}`)?.value||'').toLowerCase().trim();
  const list=document.getElementById(`ieProdList_${idx}`);
  if(!list) return;
  if(!q){ list.style.display='none'; return; }
  const matches=products.filter(p=>matchWords(p.name,q)||matchWords(getCatName(p.catId),q));
  if(!matches.length){ list.style.display='none'; return; }
  list.innerHTML=matches.slice(0,10).map(p=>`
    <div onmousedown="event.preventDefault();ieProductSelect(${idx},${p.id},'${p.name.replace(/'/g,"\\'")} (${getCatName(p.catId).replace(/'/g,"\\'")})')"
      style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);"
      onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      ${p.image?`<img src="${p.image}" style="width:24px;height:24px;object-fit:cover;border-radius:4px;flex-shrink:0;">`:`<span style="font-size:18px;">${p.emoji}</span>`}
      <span style="flex:1;">${p.name}</span>
      <span style="font-size:10px;color:var(--muted);">${getCatName(p.catId)}</span>
    </div>`).join('');
  list.style.display='block';
}

function ieProductSelect(idx, pid, label){
  document.getElementById(`ieProdText_${idx}`).value=label;
  document.getElementById(`ieProduct_${idx}`).value=pid;
  document.getElementById(`ieProdList_${idx}`).style.display='none';
  const p=products.find(x=>x.id===pid);
  const costEl=document.getElementById(`ieCost_${idx}`);
  if(costEl && p) costEl.value=p.purchasePrice||0;
  updateInvEntryRow(idx);
  // Focus boxes field
  setTimeout(()=>document.getElementById(`ieBoxes_${idx}`)?.focus(),50);
}

function ieProductClose(idx){
  const list=document.getElementById(`ieProdList_${idx}`);
  if(list) list.style.display='none';
}

function removeInvEntryRow(idx){ const r=document.getElementById(`ieRow_${idx}`); if(r) r.remove(); }

function updateInvEntryRow(idx){
  const pid=parseInt(document.getElementById(`ieProduct_${idx}`)?.value)||0;
  const p=products.find(x=>x.id===pid);
  const ppb=p?Math.max(1,p.piecesPerBox||1):1;
  const boxes=Math.max(0,parseInt(document.getElementById(`ieBoxes_${idx}`)?.value)||0);
  const pcs=Math.max(0,parseInt(document.getElementById(`iePieces_${idx}`)?.value)||0);
  const total=boxes*ppb+pcs;
  const el=document.getElementById(`ieTotal_${idx}`); if(el) el.textContent=total>0?`${total} pcs`:'0 pcs';
}

// ── ADD NEW PRODUCT directly from stock entry ────────────────────────────────
let _quickProductCallback=null;
// Keep old name as wrapper for HTML button
function addNewProductInEntry(){ addNewDirectly(); }

let _invEntryExcelData = null;

function uploadInvEntryExcel(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = function(e){
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = function(ev){
      try {
        if(typeof XLSX === 'undefined'){ notify('XLSX library not loaded','error'); return; }
        const ab = ev.target.result;
        const data = new Uint8Array(ab);
        const wb = XLSX.read(data, {type:'array'});
        if(!wb.SheetNames.length){ notify('File has no sheets','error'); return; }
        const picked = pickDataSheet(wb);
        const json = (picked && picked.json && picked.json.length) ? picked.json : null;
        if(!json || !json.length){ notify('No data rows in Excel','error'); return; }
        json = json.map(row => {
          const clean = {};
          for(const k of Object.keys(row)){
            const ck = cleanHeader(k);
            if(ck) clean[ck] = row[k];
          }
          return clean;
        });
        _invEntryExcelData = json;
        showInvEntryMapping(json);
      } catch(err){
        notify('Error reading Excel: '+err.message,'error');
      }
    };
    reader.readAsArrayBuffer(file);
  };
  input.click();
}

function showInvEntryMapping(rows){
  const headers = Object.keys(rows[0]);
  const old = document.getElementById('invEntryMapModal');
  if(old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'invEntryMapModal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:999999;display:flex;align-items:center;justify-content:center;';
  const preview = rows.slice(0,5);
  let tableHtml = '<thead><tr>'+headers.map(h=>'<th style="padding:6px 8px;text-align:left;background:var(--surface2);border-bottom:1px solid var(--border);font-size:12px;">'+escHtml(h)+'</th>').join('')+'</tr></thead><tbody>';
  preview.forEach(r => { tableHtml += '<tr>'+headers.map(h=>'<td style="padding:4px 8px;border-bottom:1px solid var(--border);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;">'+escHtml(String(r[h]||''))+'</td>').join('')+'</tr>'; });
  tableHtml += '</tbody>';
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;width:680px;max-width:92vw;max-height:90vh;overflow-y:auto;">
      <div style="font-size:16px;font-weight:700;margin-bottom:16px;">📥 Map Columns for Stock Entry</div>
      <div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:6px;margin-bottom:12px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">${tableHtml}</table>
      </div>
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Map columns <span style="font-weight:400;color:var(--muted);font-size:11px;">(Product Name and at least one of Boxes/Pieces required)</span></div>
      <div id="invEntryMapping" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;"></div>
      <div class="modal-actions" style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-ghost" onclick="document.getElementById('invEntryMapModal')?.remove();_invEntryExcelData=null;" style="padding:8px 16px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);cursor:pointer;">Cancel</button>
        <button class="btn btn-primary" id="invEntryMapBtn" onclick="processInvEntryExcel()" style="padding:8px 16px;border:none;border-radius:8px;background:var(--accent);color:#000;cursor:pointer;">✓ Process</button>
      </div>
    </div>`;
  overlay.addEventListener('click', function(e){ if(e.target === this){ this.remove(); _invEntryExcelData=null; } });
  document.body.appendChild(overlay);
  // Build mapping selects
  const container = document.getElementById('invEntryMapping');
  const invFields = ['name','boxes','pieces','price','purchasePrice','category','sku'];
  const invFieldLabels = { name:'Product Name *', boxes:'Boxes', pieces:'Pieces', price:'Price', purchasePrice:'Purchase Price', category:'Category', sku:'SKU' };
  headers.forEach(hRaw => {
    const h = cleanHeader(hRaw);
    const norm = normHeader(h);
    let matched = null;
    for(const f of invFields){
      if(FIELD_MAP[f]?.some(a => normHeader(a) === norm)){ matched = f; break; }
    }
    if(!matched && ['name','productname','product_name','item','itemname'].some(a => a === norm)) matched = 'name';
    if(!matched && ['boxes','box','boxcount'].some(a => a === norm)) matched = 'boxes';
    if(!matched && ['pieces','pcs','piece'].some(a => a === norm)) matched = 'pieces';
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
    div.innerHTML = `<span style="font-size:11px;font-weight:600;color:var(--muted);">${escHtml(h)}</span>
      <select style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface1);font-size:12px;" data-header="${escHtml(h)}">
        <option value="">— Skip —</option>
        ${invFields.map(f => `<option value="${f}" ${matched===f?'selected':''}>${invFieldLabels[f]}</option>`).join('')}
      </select>`;
    container.appendChild(div);
  });
}

function processInvEntryExcel(){
  if(!_invEntryExcelData) return;
  const selects = document.querySelectorAll('#invEntryMapping select');
  const mapping = {};
  selects.forEach(sel => {
    if(sel.value){
      if(!mapping[sel.value]) mapping[sel.value] = [];
      mapping[sel.value].push(sel.dataset.header);
    }
  });
  if(!mapping.name){ notify('Map at least the Product Name column','error'); return; }
  const btn = document.getElementById('invEntryMapBtn');
  btn.disabled = true; btn.textContent = '⏳ Processing...';
  let added = 0, existingCount = 0, newCount = 0, skipped = 0;
  _invEntryExcelData.forEach((row, idx) => {
    try {
      const nameVal = String(row[mapping.name[0]]||'').trim().toUpperCase();
      if(!nameVal){ skipped++; return; }
      const boxes = mapping.boxes ? Math.max(0,parseCount(row[mapping.boxes[0]]))||0 : 0;
      const pcs = mapping.pieces ? Math.max(0,parseCount(row[mapping.pieces[0]]))||0 : 0;
      const priceVal = mapping.price ? parseNum(row[mapping.price[0]])||0 : 0;
      const purchaseVal = mapping.purchasePrice ? parseNum(row[mapping.purchasePrice[0]])||0 : 0;
      const skuVal = mapping.sku ? String(row[mapping.sku[0]]||'').trim() : '';
      const catVal = mapping.category ? String(row[mapping.category[0]]||'').trim().toUpperCase() : '';
      let prod = products.find(p => p.name.toLowerCase() === nameVal.toLowerCase());
      if(prod){
        const ppb = Math.max(1, prod.piecesPerBox || 1);
        const totalPcs = boxes * ppb + pcs;
        if(totalPcs <= 0){ skipped++; return; }
        prod.stock += totalPcs;
        prod.lastPurchaseDate = _localDateStr();
        // Add entry row
        const idx2 = _invEntryRowCount++;
        const r = document.createElement('div');
        r.id = `ieRow_${idx2}`;
        r.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;margin-bottom:10px;align-items:end;';
        r.innerHTML = `
          <div class="form-group" style="margin:0;">
            <div class="combo-wrap" id="ieProdWrap_${idx2}" style="position:relative;">
              <input id="ieProdText_${idx2}" class="combo-input" value="${prod.name} (${getCatName(prod.catId)})" autocomplete="off" style="width:100%;"
                oninput="ieProductSearch(${idx2})"
                onblur="setTimeout(()=>ieProductClose(${idx2}),200)"
                onfocus="ieProductSearch(${idx2})">
              <input type="hidden" id="ieProduct_${idx2}" value="${prod.id}">
              <div id="ieProdList_${idx2}" class="combo-list" style="display:none;position:absolute;z-index:2000;width:100%;max-height:200px;overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px;top:calc(100% + 4px);left:0;"></div>
            </div>
          </div>
          <div class="form-group" style="margin:0;"><input id="ieBoxes_${idx2}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx2})" value="${boxes}"></div>
          <div class="form-group" style="margin:0;"><input id="iePieces_${idx2}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx2})" value="${pcs}"></div>
          <div class="form-group" style="margin:0;">
            <div id="ieTotal_${idx2}" style="padding:9px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--accent);text-align:center;height:40px;display:flex;align-items:center;justify-content:center;">${totalPcs} pcs</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="removeInvEntryRow(${idx2})">✕</button>`;
        document.getElementById('invEntryRows').appendChild(r);
        existingCount++;
        added++;
      } else {
        if(priceVal <= 0 && boxes <= 0 && pcs <= 0){ skipped++; return; }
        let catId = null;
        if(catVal){
          const catLow = catVal.toLowerCase();
          const ec = categories.find(c => c.name.toLowerCase() === catLow);
          if(ec) catId = ec.id;
          else { catId = nextCatId++; categories.push({ id:catId, name:catVal, emoji:'📦' }); }
        }
        const finalSku = skuVal || ('AUTO-'+Math.random().toString(36).substring(2,8).toUpperCase());
        const ppb = 1;
        const totalPcs = boxes * ppb + pcs;
        const prodId = nextProdId++;
        const newProd = {id:prodId, name:nameVal, price:priceVal, stock:0, catId, emoji:'📦', image:'', description:'', sku:finalSku, low:2, noOfBoxes:0, noOfPieces:0, piecesPerBox:1, gst:0, cgst:0, sgst:0, igst:0, hsn:'', location:'', cess:0, purchasePrice:purchaseVal, lastPurchaseDate:_localDateStr()};
        products.push(newProd);
        // Add entry row
        const idx2 = _invEntryRowCount++;
        const r = document.createElement('div');
        r.id = `ieRow_${idx2}`;
        r.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;margin-bottom:10px;align-items:end;';
        r.innerHTML = `
          <div class="form-group" style="margin:0;">
            <div class="combo-wrap" id="ieProdWrap_${idx2}" style="position:relative;">
              <input id="ieProdText_${idx2}" class="combo-input" value="${newProd.name} (${getCatName(newProd.catId)})" autocomplete="off" style="width:100%;"
                oninput="ieProductSearch(${idx2})"
                onblur="setTimeout(()=>ieProductClose(${idx2}),200)"
                onfocus="ieProductSearch(${idx2})">
              <input type="hidden" id="ieProduct_${idx2}" value="${newProd.id}">
              <div id="ieProdList_${idx2}" class="combo-list" style="display:none;position:absolute;z-index:2000;width:100%;max-height:200px;overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px;top:calc(100% + 4px);left:0;"></div>
            </div>
          </div>
          <div class="form-group" style="margin:0;"><input id="ieBoxes_${idx2}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx2})" value="${boxes}"></div>
          <div class="form-group" style="margin:0;"><input id="iePieces_${idx2}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx2})" value="${pcs}"></div>
          <div class="form-group" style="margin:0;">
            <div id="ieTotal_${idx2}" style="padding:9px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--accent);text-align:center;height:40px;display:flex;align-items:center;justify-content:center;">${totalPcs} pcs</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="removeInvEntryRow(${idx2})">✕</button>`;
        document.getElementById('invEntryRows').appendChild(r);
        newCount++;
        added++;
        saveQrCode({ sku: finalSku, product_name: nameVal, product_id: prodId, qr_data: finalSku, barcode_type: 'Code128' });
      }
    } catch(e){ skipped++; }
  });
  btn.disabled = false; btn.textContent = '✓ Process';
  document.getElementById('invEntryMapModal')?.remove();
  _invEntryExcelData = null;
  renderInventory(); saveAllData();
  notify(`📥 ${added} row(s) added (${existingCount} existing, ${newCount} new)${skipped?`, ${skipped} skipped`:''}${newCount?`, barcode generated for ${newCount} new product(s)` : ''}`);
}

function addNewDirectly(){
  ['qpName','qpPrice','qpPPB','qpCGST','qpSGST','qpIGST','qpDescription','qpSKU'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('qpCategory').value='';
  document.getElementById('qpCatText').value='';
  comboClose('qpCatWrap');
  clearQpImage();
  document.getElementById('quickProductModal').classList.add('open');
  setTimeout(()=>document.getElementById('qpName').focus(),100);
}

function addNewViaQr(){
  const overlay = document.createElement('div');
  overlay.id = 'qrScanOverlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:1200;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;width:380px;">
      <div style="font-size:16px;font-weight:600;margin-bottom:14px;">📷 Scan QR Code</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Enter or scan the QR/barcode value:</div>
      <input id="qrScanInput" placeholder="Scan or type QR code..." autofocus style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface1);font-size:16px;color:var(--text);outline:none;box-sizing:border-box;" onkeydown="if(event.key==='Enter')processQrScan();">
      <div id="qrScanResult" style="margin-top:12px;font-size:13px;min-height:20px;"></div>
      <div class="modal-actions" style="margin-top:16px;">
        <button class="btn btn-ghost" onclick="document.getElementById('qrScanOverlay').remove();">Cancel</button>
        <button class="btn btn-primary" onclick="processQrScan()">✓ Submit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(()=>document.getElementById('qrScanInput')?.focus(),100);
}

function processQrScan(){
  const val = (document.getElementById('qrScanInput')?.value||'').trim();
  const resultEl = document.getElementById('qrScanResult');
  if(!val){ if(resultEl) resultEl.innerHTML = '<span style="color:var(--red);">Please enter a QR/barcode value</span>'; return; }
  // Check if product with this SKU exists
  const existing = products.find(p => p.sku && p.sku.toLowerCase() === val.toLowerCase());
  if(existing){
    // Add this existing product to the inventory entry
    document.getElementById('qrScanOverlay').remove();
    addExistingProductToEntry(existing);
    notify(`"${existing.name}" added to entry (already in system)`);
    return;
  }
  // New product — pre-fill SKU with QR value
  document.getElementById('qrScanOverlay').remove();
  openQuickProductFromQr(val);
}

function addExistingProductToEntry(p){
  const idx=_invEntryRowCount++;
  const row=document.createElement('div');
  row.id=`ieRow_${idx}`;
  row.style.cssText='display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;margin-bottom:10px;align-items:end;';
  row.innerHTML=`
    <div class="form-group" style="margin:0;">
      <div class="combo-wrap" id="ieProdWrap_${idx}" style="position:relative;">
        <input id="ieProdText_${idx}" class="combo-input" value="${p.name} (${getCatName(p.catId)})" autocomplete="off" style="width:100%;"
          oninput="ieProductSearch(${idx})"
          onblur="setTimeout(()=>ieProductClose(${idx}),200)"
          onfocus="ieProductSearch(${idx})">
        <input type="hidden" id="ieProduct_${idx}" value="${p.id}">
        <div id="ieProdList_${idx}" class="combo-list" style="display:none;position:absolute;z-index:2000;width:100%;max-height:200px;overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px;top:calc(100% + 4px);left:0;"></div>
      </div>
    </div>
    <div class="form-group" style="margin:0;"><input id="ieBoxes_${idx}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx})"></div>
    <div class="form-group" style="margin:0;"><input id="iePieces_${idx}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx})"></div>
    <div class="form-group" style="margin:0;">
      <div id="ieTotal_${idx}" style="padding:9px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--accent);text-align:center;height:40px;display:flex;align-items:center;justify-content:center;">0 pcs</div>
    </div>
    <button class="btn btn-danger btn-sm" onclick="removeInvEntryRow(${idx})">✕</button>`;
  document.getElementById('invEntryRows').appendChild(row);
}

function openQuickProductFromQr(qrVal){
  // Clear quick product form
  ['qpName','qpPrice','qpPPB','qpCGST','qpSGST','qpIGST','qpDescription'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('qpCategory').value='';
  document.getElementById('qpCatText').value='';
  comboClose('qpCatWrap');
  clearQpImage();
  // Pre-fill SKU with QR value
  document.getElementById('qpSKU').value = qrVal;
  document.getElementById('quickProductModal').classList.add('open');
  // Override save to ask QR question
  document.getElementById('quickProductModal').dataset.qrPending = '1';
  setTimeout(()=>document.getElementById('qpName').focus(),100);
}

function handleQpImageUpload(input){
  const file=input.files[0]; if(!file) return;
  if(file.size>5*1024*1024){ notify('Image too large (max 5MB)','error'); return; }
  const reader=new FileReader();
  reader.onload=function(e){
    const img=new Image();
    img.onload=function(){
      const canvas=document.createElement('canvas');
      const max=400; let w=img.width,h=img.height;
      if(w>max||h>max){ const r=Math.min(max/w,max/h); w=Math.round(w*r); h=Math.round(h*r); }
      canvas.width=w; canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      const compressed=canvas.toDataURL('image/jpeg',0.75);
      input._currentImage=compressed;
      const previewImg=document.getElementById('qpImgPreviewImg');
      const emojiEl=document.getElementById('qpImgPreviewEmoji');
      previewImg.src=compressed; previewImg.style.display='block'; emojiEl.style.display='none';
      document.getElementById('qpImgClearBtn').style.display='';
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}
function clearQpImage(){
  const fi=document.getElementById('qpImageFile');
  if(fi){ fi.value=''; fi._currentImage=''; }
  const pi=document.getElementById('qpImgPreviewImg');
  if(pi){ pi.style.display='none'; pi.src=''; }
  const cb=document.getElementById('qpImgClearBtn');
  if(cb) cb.style.display='none';
  const ep=document.getElementById('qpImgPreviewEmoji');
  if(ep) ep.style.display='';
}

function saveQuickProduct(){
  const rawName=(document.getElementById('qpName').value||'').trim();
  const price=parseFloat(document.getElementById('qpPrice').value)||0;
  const catId=parseInt(document.getElementById('qpCategory').value)||0;
  if(!rawName){ notify('Product name required','error'); return; }
  if(price<=0){ notify('Enter a valid price','error'); return; }
  if(!catId){ notify('Select or create a category','error'); return; }
  const name=rawName.toUpperCase();
  const qpExisting = products.find(p=>p.name.toLowerCase()===name.toLowerCase());
  if(qpExisting){
    showConfirmDelete('⚠️ Duplicate Product',
      `Product <strong>"${name}"</strong> already exists.<br>Add to entry with this product instead?`,
      ()=>{
        addExistingProductToEntry(qpExisting);
        closeModal('quickProductModal'); saveAllData();
        notify(`"${name}" added to entry`);
      }
    );
    return;
  }
  const emoji=document.getElementById('qpEmoji').value.trim()||'📦';
  const image=document.getElementById('qpImageFile')._currentImage||'';
  const description=document.getElementById('qpDescription').value.trim();
  const ppb=Math.max(1,parseInt(document.getElementById('qpPPB').value)||1);
  const cgst=parseFloat(document.getElementById('qpCGST').value)||0;
  const sgst=parseFloat(document.getElementById('qpSGST').value)||0;
  const igst=parseFloat(document.getElementById('qpIGST').value)||0;
  const gst=cgst+sgst;
  const isQrFlow = document.getElementById('quickProductModal').dataset.qrPending === '1';
  const skuRaw=(document.getElementById('qpSKU').value||'').trim();
  const sku=skuRaw||(isQrFlow?'':'SKU-'+String(nextProdId).padStart(3,'0'));
  const newProd={id:nextProdId++,name,price,stock:0,catId,emoji,image,description,sku,low:2,noOfBoxes:0,noOfPieces:0,piecesPerBox:ppb,gst,cgst,sgst,igst};
  products.push(newProd);
  closeModal('quickProductModal'); saveAllData();
  // Add a row for it in the stock entry using the searchable combo, pre-filled
  const idx=_invEntryRowCount++;
  const row=document.createElement('div');
  row.id=`ieRow_${idx}`;
  row.style.cssText='display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;margin-bottom:10px;align-items:end;';
  row.innerHTML=`
    <div class="form-group" style="margin:0;">
      <div class="combo-wrap" id="ieProdWrap_${idx}" style="position:relative;">
        <input id="ieProdText_${idx}" class="combo-input" value="${newProd.name} (${getCatName(newProd.catId)})" autocomplete="off" style="width:100%;"
          oninput="ieProductSearch(${idx})"
          onblur="setTimeout(()=>ieProductClose(${idx}),200)"
          onfocus="ieProductSearch(${idx})">
        <input type="hidden" id="ieProduct_${idx}" value="${newProd.id}">
        <div id="ieProdList_${idx}" class="combo-list" style="display:none;position:absolute;z-index:2000;width:100%;max-height:200px;overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px;top:calc(100% + 4px);left:0;"></div>
      </div>
    </div>
    <div class="form-group" style="margin:0;"><input id="ieBoxes_${idx}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx})"></div>
    <div class="form-group" style="margin:0;"><input id="iePieces_${idx}" type="number" min="0" placeholder="0" oninput="updateInvEntryRow(${idx})"></div>
    <div class="form-group" style="margin:0;">
      <div id="ieTotal_${idx}" style="padding:9px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--accent);text-align:center;height:40px;display:flex;align-items:center;justify-content:center;">0 pcs</div>
    </div>
    <button class="btn btn-danger btn-sm" onclick="removeInvEntryRow(${idx})">✕</button>`;
  document.getElementById('invEntryRows').appendChild(row);
  setTimeout(()=>document.getElementById(`ieBoxes_${idx}`)?.focus(),100);
  notify(`"${name}" created and added to entry`);
  // QR flow: ask if user wants to generate QR
  if(isQrFlow){
    delete document.getElementById('quickProductModal').dataset.qrPending;
    const qrSku = skuRaw;
    if(qrSku){
      const overlay = document.createElement('div');
      overlay.id = 'qrGenChoiceOverlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:1200;display:flex;align-items:center;justify-content:center;';
      overlay.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;width:340px;text-align:center;">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px;">📷 Generate QR for "${name}"?</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:18px;">SKU: ${qrSku}</div>
          <button class="btn btn-primary" style="width:100%;padding:12px;margin-bottom:8px;font-size:15px;" onclick="generateQrForNewProduct(${newProd.id},'${qrSku.replace(/'/g,"\\'")}');document.getElementById('qrGenChoiceOverlay').remove();">✅ Yes, Generate</button>
          <button class="btn" style="width:100%;padding:12px;font-size:15px;background:var(--surface2);border:1px solid var(--border);" onclick="clearSkuForNewProduct(${newProd.id});document.getElementById('qrGenChoiceOverlay').remove();">❌ No, Don't Generate</button>
        </div>`;
      document.body.appendChild(overlay);
    }
  }
}

function generateQrForNewProduct(prodId, sku){
  const p = products.find(x => x.id === prodId);
  if(!p) return;
  // Keep existing QR if product with same name already has one
  if(qrCodes.some(q => q.product_name && q.product_name.toLowerCase() === p.name.toLowerCase())){
    notify(`ℹ️ QR already exists for "${p.name}", keeping existing`);
    return;
  }
  notify(`Generating QR for "${p.name}"...`);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(sku)}`;
  saveQrCode({ sku, product_name: p.name, product_id: prodId, qr_data: sku, barcode_type: 'qr' });
  renderQrPage();
  notify(`✅ QR generated for "${p.name}"`);
}

function clearSkuForNewProduct(prodId){
  const p = products.find(x => x.id === prodId);
  if(!p) return;
  delete p.sku;
  saveAllData();
  notify(`SKU cleared (QR not generated)`);
}

function saveInvEntry(){
  const destination=up(document.getElementById('ieDestination')?.value);
  const transportPhotoEl=document.getElementById('ieTransportPhoto');
  const transportBillPhoto=transportPhotoEl?.files?.[0]?._base64||'';
  const supplierBillPhotoEl=document.getElementById('ieSupplierBillPhoto');
  const supplierBillPhoto=supplierBillPhotoEl?.files?.[0]?._base64||'';
  const parcelCount=parseInt(document.getElementById('ieParcelCount')?.value)||0;
  const supplier=up(document.getElementById('ieSupplier').value);
  const supplierBill=parseFloat(document.getElementById('ieSupplierBill')?.value)||0;
  const supplierBillPaid=parseFloat(document.getElementById('ieSupplierBillPaid')?.value)||0;
  const supplierBillStatus=document.getElementById('ieSupplierBillStatus')?.value||'paid';
  const transportProvider=up(document.getElementById('ieTransportProvider')?.value);
  const transportCost=parseFloat(document.getElementById('ieTransportCost')?.value)||0;
  const transportPaid=parseFloat(document.getElementById('ieTransportPaid')?.value)||0;
  const transportStatus=document.getElementById('ieTransportStatus')?.value||'paid';
  const notes=document.getElementById('ieNotes').value.trim();
  const items=[];
  let priceChanged=0;
  for(let i=0;i<_invEntryRowCount;i++){
    const prodEl=document.getElementById(`ieProduct_${i}`); if(!prodEl) continue;
    const pid=parseInt(prodEl.value)||0;
    const p=products.find(x=>x.id===pid); if(!p) continue;
    const ppb=Math.max(1,p.piecesPerBox||1);
    const boxes=Math.max(0,parseInt(document.getElementById(`ieBoxes_${i}`)?.value)||0);
    const pcs=Math.max(0,parseInt(document.getElementById(`iePieces_${i}`)?.value)||0);
    const totalPcs=boxes*ppb+pcs;
    if(totalPcs>0){
      const costVal=parseFloat(document.getElementById(`ieCost_${i}`)?.value)||0;
      const oldPrice=p.purchasePrice||0;
      const entryPrice=costVal||oldPrice;
      items.push({productId:p.id,productName:p.name,catId:p.catId,catName:getCatName(p.catId),emoji:p.emoji,noOfBoxes:boxes,noOfPieces:pcs,piecesPerBox:ppb,totalPcs,purchasePrice:entryPrice});
      p.stock+=totalPcs; p.noOfBoxes=(p.noOfBoxes||0)+boxes; p.noOfPieces=(p.noOfPieces||0)+pcs;
      p.lastPurchaseDate=_localDateStr();
      if(costVal>0 && costVal !== oldPrice){
        logPurchasePriceChange(p.name, costVal, 'Inventory History');
        p.purchasePrice = costVal;
        priceChanged++;
      }
    }
  }
  if(!items.length){ notify('Add at least one product with quantity','error'); return; }
  const invId='INV-'+String(nextInvId++).padStart(6,'0');
  const nowDate=_localDateStr();
  let expId=null;
  // Create expense for transport cost if paid
  if(transportCost>0 && transportStatus==='paid'){
    expId='EXP-'+String(_nextExpId++).padStart(4,'0');
    const expenseTitle=transportProvider?'Transport: '+transportProvider:'Transport';
    expenses.push({id:expId,name:expenseTitle,category:'Transport',amount:transportCost,date:nowDate,notes:'INV: '+invId+' · '+supplier,photo:transportBillPhoto});
  }
  // ── Purchase GST fields (2B reconciliation + GSTR-3B Table 4) ──
  const gnum=(id)=>{const v=parseFloat(document.getElementById(id)?.value);return isFinite(v)&&v>0?v:0;};
  const supplierInvoiceNo=(document.getElementById('ieSupplierInvoiceNo')?.value||'').trim();
  const supplierGstin=(document.getElementById('ieSupplierGstin')?.value||'').trim().toUpperCase();
  const purchaseInvoiceDate=(document.getElementById('iePurchaseInvoiceDate')?.value)||null;
  const purchaseTaxable=gnum('iePurchaseTaxable');
  const purchaseIgst=gnum('iePurchaseIgst'), purchaseCgst=gnum('iePurchaseCgst'), purchaseSgst=gnum('iePurchaseSgst');
  const purchaseCess=gnum('iePurchaseCess');
  const isImport=!!document.getElementById('ieIsImport')?.checked;
  const invReverseCharge=!!document.getElementById('ieReverseCharge')?.checked;
  const itcEligible=document.getElementById('ieItcEligible')?.checked!==false;
  const ineligibleReason=(document.getElementById('ieIneligibleReason')?.value||'').trim();

  if ((purchaseTaxable||purchaseCgst||purchaseSgst||purchaseIgst) && !supplierInvoiceNo){
    notify('Saved, but without the supplier invoice number this ITC cannot be matched to 2B','error');
  }
  inventoryHistory.push({id:invId,date:nowDate,destination,parcelCount,supplier,supplierBill,supplierBillPaid,supplierBillStatus,supplierBillPhoto,transportProvider,transportCost,transportPaid,transportStatus,transportBillPhoto,transportCostExpenseId:expId,notes,items,
    supplierInvoiceNo,supplierGstin,
    supplierStateCode:supplierGstin?supplierGstin.slice(0,2):'',
    purchaseInvoiceDate,purchaseTaxable,purchaseCgst,purchaseSgst,purchaseIgst,purchaseCess,
    isImport,reverseCharge:invReverseCharge,itcEligible,ineligibleReason});
  // persistent log — survives history deletion
  supplierTransportLog.push({date:nowDate,supplier,transportProvider,products:items.map(i=>({name:i.productName,qty:i.totalPcs}))});
  closeModal('invEntryModal'); renderInventoryHistory(); renderInventory();
  saveAllData();
  let msg=`Stock entry saved — ${items.length} product(s) updated`;
  if(priceChanged) msg+=` · ${priceChanged} purchase price(s) updated`;
  if(expId) msg+=` · Transport expense created`;
  notify(msg);
}

function undoInvEntry(id){
  const idx=inventoryHistory.findIndex(e=>e.id===id);
  if(idx===-1){ notify('Entry not found','error'); return; }
  const entry=inventoryHistory[idx];
  let delExp=false;
  if(entry.transportCostExpenseId||(entry.transportCost>0&&entry.transportStatus==='paid')){
    delExp=confirm('Undo this inventory entry? Stock will be reduced.\n\nAlso delete the transport expense from Expenses?');
  } else {
    if(!confirm('Undo this inventory entry? Stock will be reduced by the entered quantities.')) return;
  }
  entry.items.forEach(item=>{
    const p=products.find(x=>x.id===item.productId);
    if(!p) return;
    const subtract=item.totalPcs||0;
    p.stock=Math.max(0,p.stock-subtract);
    p.noOfBoxes=Math.max(0,(p.noOfBoxes||0)-(item.noOfBoxes||0));
    p.noOfPieces=Math.max(0,(p.noOfPieces||0)-(item.noOfPieces||0));
  });
  if(delExp&&entry.transportCostExpenseId){
    const expIdx=expenses.findIndex(e=>e.id===entry.transportCostExpenseId);
    if(expIdx!==-1) expenses.splice(expIdx,1);
  }
  inventoryHistory.splice(idx,1);
  renderInventoryHistory(); renderInventory();
  saveAllData();
  notify('Inventory entry undone — stock restored');
}

function clearInventoryHistory(){
  if(!inventoryHistory.length){ notify('No inventory history to clear','error'); return; }
  const hasExp=inventoryHistory.some(e=>e.transportCostExpenseId);
  let delExp=false;
  if(hasExp) delExp=confirm('Delete ALL inventory history records? This cannot be undone.\n\nAlso delete ALL linked transport expenses from Expenses?');
  else if(!confirm('Delete ALL inventory history records? This cannot be undone.')) return;
  if(delExp){
    inventoryHistory.forEach(e=>{if(e.transportCostExpenseId){const ei=expenses.findIndex(x=>x.id===e.transportCostExpenseId);if(ei!==-1)expenses.splice(ei,1);}});
  }
  inventoryHistory = [];
  renderInventoryHistory();
  saveAllData();
  notify('🗑️ All inventory history cleared');
}

function exportInventoryHistoryExcel(){
  if(!inventoryHistory.length){ notify('No inventory history to export','error'); return; }
  const q=(document.getElementById('invHistorySearch')?.value||'').trim()||document.getElementById('invHistoryDateSearch')?._val||'';
  let data=inventoryHistory.slice().reverse();
  if(q){
    const mode=custSelVal('csw_mode');
    const isDateMode=mode==='date';
    const sq=isDateMode?q:q.toLowerCase();
    data=inventoryHistory.slice().reverse().filter(entry=>{
      if(mode==='all'){
        if(entry.id.toLowerCase().includes(sq))return true;
        if(entry.supplier&&entry.supplier.toLowerCase().includes(sq))return true;
        if(entry.transportProvider&&entry.transportProvider.toLowerCase().includes(sq))return true;
        if(entry.date&&entry.date.includes(sq))return true;
        const d=new Date(entry.date);
        if(d.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'}).toLowerCase().includes(sq))return true;
        if(d.toISOString().slice(0,10).includes(sq))return true;
        if(entry.items&&entry.items.some(item=>item.productName&&item.productName.toLowerCase().includes(sq)))return true;
        if(entry.notes&&entry.notes.toLowerCase().includes(sq))return true;
        return false;
      } else if(mode==='inv') return entry.id.toLowerCase().includes(sq);
      else if(mode==='product') return entry.items&&entry.items.some(item=>item.productName&&item.productName.toLowerCase().includes(sq));
      else if(mode==='date'){const d=new Date(entry.date);const ds=d.toISOString().slice(0,10);const df=d.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'});return ds.includes(sq)||df.toLowerCase().includes(sq)||(entry.date&&entry.date.includes(sq));}
      else if(mode==='supplier') return entry.supplier&&entry.supplier.toLowerCase().includes(sq);
      else if(mode==='transport') return entry.transportProvider&&entry.transportProvider.toLowerCase().includes(sq);
      return false;
    });
  }
  const header=['INV ID','Date','Time','Destination','Supplier','Supplier Bill (₹)','Supplier Bill Paid (₹)','Supplier Bill Status','Transport Provider','Transport Cost (₹)','Transport Paid (₹)','Transport Status','Parcels','Notes','Product Name','Category','Boxes','Pieces','Total Pcs','Purchase Price/PC (₹)'];
  const rows=[header];
  data.forEach(entry=>{
    const d=new Date(entry.date);
    const dateStr=d.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'});
    const timeStr=d.toLocaleString('en-IN',{hour:'2-digit',minute:'2-digit'});
    const tc=entry.transportCost??entry.transport??0;
    const tp=entry.transportPaid??0;
    const sbp=entry.supplierBillPaid??0;
    if(!entry.items.length){
      rows.push([entry.id,dateStr,timeStr,entry.destination||'',entry.supplier||'',entry.supplierBill||0,sbp,entry.supplierBillStatus==='due'?'Due':'Paid',entry.transportProvider||'',tc,tp,entry.transportStatus==='due'?'Due':'Paid',entry.parcelCount||0,entry.notes||'','','','','','','']);
    } else {
      entry.items.forEach((item,idx)=>{
        rows.push([
          idx===0?entry.id:'',
          idx===0?dateStr:'',
          idx===0?timeStr:'',
          idx===0?(entry.destination||''):'',
          idx===0?(entry.supplier||''):'',
          idx===0?(entry.supplierBill||0):'',
          idx===0?sbp:'',
          idx===0?(entry.supplierBillStatus==='due'?'Due':'Paid'):'',
          idx===0?(entry.transportProvider||''):'',
          idx===0?tc:'',
          idx===0?tp:'',
          idx===0?(entry.transportStatus==='due'?'Due':'Paid'):'',
          idx===0?(entry.parcelCount||0):'',
          idx===0?(entry.notes||''):'',
          item.productName,
          item.catName||'',
          item.noOfBoxes||0,
          item.noOfPieces||0,
          item.totalPcs||0,
          item.purchasePrice||0
        ]);
      });
    }
    rows.push([]);
  });
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!cols']=[{wch:14},{wch:16},{wch:10},{wch:18},{wch:18},{wch:14},{wch:14},{wch:14},{wch:18},{wch:14},{wch:14},{wch:14},{wch:8},{wch:22},{wch:24},{wch:16},{wch:8},{wch:8},{wch:10},{wch:16}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Inventory History');
  if(supplierTransportLog.length){
    const logRows=[['Date','Supplier','Transport Provider','Products (Name × Qty)']];
    supplierTransportLog.forEach(e=>{
      logRows.push([e.date||'',e.supplier||'',e.transportProvider||'',e.products?e.products.map(p=>p.name+' ×'+p.qty).join(', '):'']);
    });
    const ws2=XLSX.utils.aoa_to_sheet(logRows);
    ws2['!cols']=[{wch:16},{wch:18},{wch:18},{wch:50}];
    XLSX.utils.book_append_sheet(wb,ws2,'Supplier & Transport Log');
  }
  const suffix=q?'_filtered':'';
  XLSX.writeFile(wb,'Inventory_History_'+new Date().toISOString().slice(0,10)+suffix+'.xlsx');
  notify('📥 Inventory history exported as Excel');
}

function exportSingleInvEntry(id){
  const entry=inventoryHistory.find(e=>e.id===id);
  if(!entry){notify('Entry not found','error');return;}
  const header=['INV ID','Date','Time','Destination','Supplier','Supplier Bill (₹)','Supplier Bill Paid (₹)','Supplier Bill Status','Transport Provider','Transport Cost (₹)','Transport Paid (₹)','Transport Status','Parcels','Notes','Product Name','Category','Boxes','Pieces','Total Pcs','Purchase Price/PC (₹)'];
  const rows=[header];
  const d=new Date(entry.date);
  const dateStr=d.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'});
  const timeStr=d.toLocaleString('en-IN',{hour:'2-digit',minute:'2-digit'});
  const tc=entry.transportCost??entry.transport??0;
  const tp=entry.transportPaid??0;
  const sbp=entry.supplierBillPaid??0;
  entry.items.forEach((item,idx)=>{
    rows.push([
      idx===0?entry.id:'',
      idx===0?dateStr:'',
      idx===0?timeStr:'',
      idx===0?(entry.destination||''):'',
      idx===0?(entry.supplier||''):'',
      idx===0?(entry.supplierBill||0):'',
      idx===0?sbp:'',
      idx===0?(entry.supplierBillStatus==='due'?'Due':'Paid'):'',
      idx===0?(entry.transportProvider||''):'',
      idx===0?tc:'',
      idx===0?tp:'',
      idx===0?(entry.transportStatus==='due'?'Due':'Paid'):'',
      idx===0?(entry.parcelCount||0):'',
      idx===0?(entry.notes||''):'',
      item.productName,
      item.catName||'',
      item.noOfBoxes||0,
      item.noOfPieces||0,
      item.totalPcs||0,
      item.purchasePrice||0
    ]);
  });
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!cols']=[{wch:14},{wch:16},{wch:10},{wch:18},{wch:18},{wch:18},{wch:14},{wch:14},{wch:14},{wch:14},{wch:22},{wch:24},{wch:16},{wch:8},{wch:8},{wch:10},{wch:16}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,entry.id);
  XLSX.writeFile(wb,entry.id+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
  notify('📥 '+entry.id+' exported');
}

// ── Custom Select helpers ──
function custSelVal(id){return document.getElementById(id).dataset.val||'all';}
function custSelToggle(id){
  const w=document.getElementById(id);
  const isOpen=w.classList.contains('open');
  document.querySelectorAll('.cust-sel-wrap.open').forEach(el=>el.classList.remove('open'));
  if(!isOpen) w.classList.add('open');
}
function custSelPick(id,val,text){
  const w=document.getElementById(id);w.dataset.val=val;
  document.getElementById(id+'_txt').textContent=text;
  w.classList.remove('open');
  document.querySelectorAll('#'+id+'_list .cust-sel-item').forEach(el=>el.classList.toggle('sel',el.dataset.value===val));
}

function updateCustSelText(selId){
  const sel=document.getElementById(selId);
  if(!sel)return;
  const opt=sel.options[sel.selectedIndex];
  if(!opt)return;
  const txt=document.getElementById(selId+'_txt');
  if(txt)txt.textContent=opt.text;
  const wrap=document.getElementById(selId+'_w');
  if(wrap)wrap.dataset.val=opt.value;
  const list=document.getElementById(selId+'_list');
  if(list)list.querySelectorAll('.cust-sel-item').forEach(el=>el.classList.toggle('sel',el.dataset.value===opt.value));
}

// Auto-enhance all native <select> to custom dropdowns
function enhanceSelects(){
  document.querySelectorAll('select:not([data-enhanced])').forEach(sel=>{
    if(sel.closest('.cust-sel-wrap')) return;
    if(sel.id==='invHistorySearchMode'||sel.id==='invHistorySort') return; // already custom
    sel.dataset.enhanced='1';
    const wrap=document.createElement('div');wrap.className='cust-sel-wrap';
    const sw=sel.style.width;
    if(sw&&sw!==''&&sw!=='auto'){
      wrap.style.width=sw;
    } else if(sw==='auto'){
      // width:auto — don't set width, rely on min-width
    } else {
      wrap.style.width='100%';
    }
    if(sel.style.minWidth) wrap.style.minWidth=sel.style.minWidth;
    const selOpt=sel.options[sel.selectedIndex];
    const initText=selOpt?selOpt.text:sel.options[0]?.text||'Select';
    const initVal=sel.value||sel.options[0]?.value||'';
    if(!sel.id) sel.id='enh_sel_'+Math.random().toString(36).slice(2,8);
    const wrapId=sel.id+'_w';
    wrap.id=wrapId;
    const listId=sel.id+'_list';
    wrap.innerHTML=`<div class="cust-sel-trig" onclick="custSelToggle('${wrapId}')"><span id="${sel.id}_txt">${initText}</span><span class="cust-sel-arr">▾</span></div><div class="cust-sel-list" id="${listId}"></div>`;
    sel.parentNode.insertBefore(wrap,sel);
    sel.style.display='none';
    wrap.dataset.val=initVal;
    // populate list
    const list=wrap.querySelector('.cust-sel-list');
    const origChange=sel.getAttribute('onchange')||'';
    Array.from(sel.options).forEach((opt,i)=>{
      const d=document.createElement('div');d.className='cust-sel-item'+(i===sel.selectedIndex?' sel':'');
      d.textContent=opt.text;d.dataset.value=opt.value;
      d.onclick=function(){
        wrap.dataset.val=opt.value;
        document.getElementById(sel.id+'_txt').textContent=opt.text;
        wrap.classList.remove('open');
        list.querySelectorAll('.cust-sel-item').forEach(el=>el.classList.toggle('sel',el.dataset.value===opt.value));
        sel.value=opt.value;
        // Trigger original change handler
        if(origChange) new Function('event',origChange).call(sel,{target:sel});
        // Dispatch native event for listeners
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        // Re-run enhanceSelects in case change added new selects
        enhanceSelects();
      };
      list.appendChild(d);
    });
    // Detect manual change via custom dropdown
    if(sel.id==='ieSupplierBillStatus') sel.addEventListener('change',function(){_supplierManualStatus=true;});
    if(sel.id==='ieTransportStatus') sel.addEventListener('change',function(){_transportManualStatus=true;});
  });
}

/**
 * Tear down the custom dropdown wrapper for one <select> so enhanceSelects can
 * rebuild it from the current options.
 *
 * enhanceSelects copies each option's text into a trigger element exactly once.
 * If anything rewrites select.innerHTML afterwards — which the GST billing block
 * does when /gst/config arrives — the visible label and the option list go stale,
 * and picking from the stale list sets a value the select no longer has.
 */
function resetCustomSelect(sel){
  if(!sel) return;
  const wrap = document.getElementById(sel.id + '_w');
  if(wrap) wrap.remove();
  sel.style.display = '';
  delete sel.dataset.enhanced;
}
document.addEventListener('click',function(e){
  if(!e.target.closest('.cust-sel-wrap')) document.querySelectorAll('.cust-sel-wrap.open').forEach(el=>el.classList.remove('open'));
});

function onInvHistoryModeChange(){
  const mode=custSelVal('csw_mode');
  const textSearch=document.getElementById('invHistorySearch');
  const dateSearch=document.getElementById('invHistoryDateSearch');
  const icon=document.getElementById('invSearchIcon');
  // Update sort options based on mode
  const sortOptsMap={
    all:[
      {v:'inv-asc',l:'Inv No. Low → High'},{v:'inv-desc',l:'Inv No. High → Low'},
      {v:'cost-asc',l:'Cost Low → High'},{v:'cost-desc',l:'Cost High → Low'},
      {v:'sb-paid-asc',l:'Supplier Bill Paid Low → High'},{v:'sb-paid-desc',l:'Supplier Bill Paid High → Low'},
      {v:'sb-due-asc',l:'Supplier Bill Due Low → High'},{v:'sb-due-desc',l:'Supplier Bill Due High → Low'},
      {v:'tp-paid-asc',l:'Transport Paid Low → High'},{v:'tp-paid-desc',l:'Transport Paid High → Low'},
      {v:'tp-due-asc',l:'Transport Due Low → High'},{v:'tp-due-desc',l:'Transport Due High → Low'}
    ],
    inv:[{v:'inv-asc',l:'Inv No. Low → High'},{v:'inv-desc',l:'Inv No. High → Low'}],
    product:[{v:'name-asc',l:'Name A→Z'},{v:'name-desc',l:'Name Z→A'}],
    date:[{v:'date-asc',l:'Date Old → New'},{v:'date-desc',l:'Date New → Old'}],
    supplier:[
      {v:'name-asc',l:'Name A→Z'},{v:'name-desc',l:'Name Z→A'},
      {v:'sb-paid-asc',l:'Supplier Bill Paid Low → High'},{v:'sb-paid-desc',l:'Supplier Bill Paid High → Low'},
      {v:'sb-due-asc',l:'Supplier Bill Due Low → High'},{v:'sb-due-desc',l:'Supplier Bill Due High → Low'}
    ],
    transport:[
      {v:'name-asc',l:'Name A→Z'},{v:'name-desc',l:'Name Z→A'},
      {v:'tp-paid-asc',l:'Transport Paid Low → High'},{v:'tp-paid-desc',l:'Transport Paid High → Low'},
      {v:'tp-due-asc',l:'Transport Due Low → High'},{v:'tp-due-desc',l:'Transport Due High → Low'}
    ]
  };
  const opts=sortOptsMap[mode]||sortOptsMap.all;
  const list=document.getElementById('csw_sort_list');
  list.innerHTML=opts.map(o=>`<div class="cust-sel-item" data-value="${o.v}" onclick="custSelPick('csw_sort','${o.v}','${o.l}');renderInventoryHistory()">${o.l}</div>`).join('');
  // If current sort value not in new options, reset to first
  const cur=custSelVal('csw_sort');
  if(!opts.some(o=>o.v===cur)) custSelPick('csw_sort',opts[0].v,opts[0].l);
  if(mode==='date'){
    textSearch.style.display='none';
    dateSearch.style.display='block';
    icon.textContent='📅';
    icon.style.cursor='pointer';
    icon.onclick=function(e){e.stopPropagation();calOpen(dateSearch);};
    dateSearch.onchange=function(){
      if(this._val) renderInventoryHistory();
      else { const v=this.value.trim(); if(v){ this._val=v; renderInventoryHistory(); } }
    };
    dateSearch.onkeydown=function(e){
      if(e.key==='Enter'){ const v=this.value.trim(); if(v){ this._val=v; } renderInventoryHistory(); }
    };
  } else {
    textSearch.style.display='block';
    dateSearch.style.display='none';
    icon.textContent='🔍';
    icon.style.cursor='default';
    icon.onclick=null;
    textSearch.value='';
  }
  renderInventoryHistory();
}

function renderInventoryHistory(){
  const wrap=document.getElementById('invHistoryWrap');
  if(!inventoryHistory.length){
    wrap.innerHTML=`<div class="empty-state"><div class="big">📋</div><p>No inventory entries yet.</p><button class="btn btn-primary" onclick="openAddInvEntry()">+ Record Stock Entry</button></div>`;
    return;
  }
  const mode=custSelVal('csw_mode');
  const isDateMode=mode==='date';
  const q=isDateMode?(document.getElementById('invHistoryDateSearch')?._val||''):(document.getElementById('invHistorySearch')?.value||'').trim();
  let entries=inventoryHistory.slice().reverse();
  if(q){
    const labelMap={all:'',inv:'Inventory No.',product:'Product Name',date:'Date',supplier:'Supplier',transport:'Transport Provider'};
    const modeLabel=labelMap[mode]||'';
    let matched=false;
    const ql=q.toLowerCase();
    if(mode==='all'){
      entries=entries.filter(entry=>{
        if(entry.id.toLowerCase().includes(ql)) return matched=true;
        if(entry.supplier&&entry.supplier.toLowerCase().includes(ql)) return matched=true;
        if(entry.transportProvider&&entry.transportProvider.toLowerCase().includes(ql)) return matched=true;
        if(entry.date&&entry.date.includes(ql)) return matched=true;
        const d=new Date(entry.date);
        const dateStr=d.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'}).toLowerCase();
        if(dateStr.includes(ql)) return matched=true;
        const shortDate=d.toISOString().slice(0,10);
        if(shortDate.includes(ql)) return matched=true;
        if(entry.items&&entry.items.some(item=>item.productName&&item.productName.toLowerCase().includes(ql))) return matched=true;
        if(entry.notes&&entry.notes.toLowerCase().includes(ql)) return matched=true;
        return false;
      });
    } else if(mode==='inv'){
      entries=entries.filter(entry=>{if(entry.id.toLowerCase().includes(ql)){matched=true;return true;}return false;});
    } else if(mode==='product'){
      entries=entries.filter(entry=>{if(entry.items&&entry.items.some(item=>item.productName&&item.productName.toLowerCase().includes(ql))){matched=true;return true;}return false;});
    } else if(mode==='date'){
      entries=entries.filter(entry=>{
        const d=new Date(entry.date);
        const dateStr=d.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'}).toLowerCase();
        const shortDate=d.toISOString().slice(0,10);
        if(dateStr.includes(ql)||shortDate.includes(ql)||(entry.date&&entry.date.includes(ql))){matched=true;return true;}
        return false;
      });
    } else if(mode==='supplier'){
      entries=entries.filter(entry=>{if(entry.supplier&&entry.supplier.toLowerCase().includes(ql)){matched=true;return true;}return false;});
    } else if(mode==='transport'){
      entries=entries.filter(entry=>{if(entry.transportProvider&&entry.transportProvider.toLowerCase().includes(ql)){matched=true;return true;}return false;});
    }
    if(!matched){
      const msg=modeLabel?`Please enter correct input of "${modeLabel}"`:`No entries matching "${q}"`;
      wrap.innerHTML=`<div class="empty-state"><div class="big">⚠️</div><p>${msg}</p></div>`;
      return;
    }
  }
  // Sort
  const sortVal=custSelVal('csw_sort');
  if(sortVal==='inv-asc') entries.sort((a,b)=>a.id.localeCompare(b.id));
  else if(sortVal==='inv-desc') entries.sort((a,b)=>b.id.localeCompare(a.id));
  else if(sortVal==='cost-asc') entries.sort((a,b)=>((a.transportCost??a.transport??0))-((b.transportCost??b.transport??0)));
  else if(sortVal==='cost-desc') entries.sort((a,b)=>((b.transportCost??b.transport??0))-((a.transportCost??a.transport??0)));
  else if(sortVal==='date-asc') entries.sort((a,b)=>new Date(a.date)-new Date(b.date));
  else if(sortVal==='date-desc') entries.sort((a,b)=>new Date(b.date)-new Date(a.date));
  else if(sortVal==='name-asc'){
    const mode=custSelVal('csw_mode');
    if(mode==='supplier') entries.sort((a,b)=>(a.supplier||'').localeCompare(b.supplier||''));
    else if(mode==='transport') entries.sort((a,b)=>(a.transportProvider||'').localeCompare(b.transportProvider||''));
    else if(mode==='product') entries.sort((a,b)=>{const an=a.items[0]?.productName||'';const bn=b.items[0]?.productName||'';return an.localeCompare(bn);});
  }
  else if(sortVal==='name-desc'){
    const mode=custSelVal('csw_mode');
    if(mode==='supplier') entries.sort((a,b)=>(b.supplier||'').localeCompare(a.supplier||''));
    else if(mode==='transport') entries.sort((a,b)=>(b.transportProvider||'').localeCompare(a.transportProvider||''));
    else if(mode==='product') entries.sort((a,b)=>{const an=a.items[0]?.productName||'';const bn=b.items[0]?.productName||'';return bn.localeCompare(an);});
  }
  else if(sortVal==='sb-paid-asc'){
    entries=entries.filter(e=>e.supplierBillStatus==='paid');
    entries.sort((a,b)=>(a.supplierBill||0)-(b.supplierBill||0));
  }
  else if(sortVal==='sb-paid-desc'){
    entries=entries.filter(e=>e.supplierBillStatus==='paid');
    entries.sort((a,b)=>(b.supplierBill||0)-(a.supplierBill||0));
  }
  else if(sortVal==='sb-due-asc'){
    entries=entries.filter(e=>e.supplierBillStatus==='due');
    entries.sort((a,b)=>(a.supplierBill||0)-(b.supplierBill||0));
  }
  else if(sortVal==='sb-due-desc'){
    entries=entries.filter(e=>e.supplierBillStatus==='due');
    entries.sort((a,b)=>(b.supplierBill||0)-(a.supplierBill||0));
  }
  else if(sortVal==='tp-paid-asc'){
    entries=entries.filter(e=>e.transportStatus==='paid');
    entries.sort((a,b)=>((a.transportCost??a.transport??0))-((b.transportCost??b.transport??0)));
  }
  else if(sortVal==='tp-paid-desc'){
    entries=entries.filter(e=>e.transportStatus==='paid');
    entries.sort((a,b)=>((b.transportCost??b.transport??0))-((a.transportCost??a.transport??0)));
  }
  else if(sortVal==='tp-due-asc'){
    entries=entries.filter(e=>e.transportStatus==='due');
    entries.sort((a,b)=>((a.transportCost??a.transport??0))-((b.transportCost??b.transport??0)));
  }
  else if(sortVal==='tp-due-desc'){
    entries=entries.filter(e=>e.transportStatus==='due');
    entries.sort((a,b)=>((b.transportCost??b.transport??0))-((a.transportCost??a.transport??0)));
  }
  wrap.innerHTML=`<div class="inv-hist-wrap">`+entries.map((entry,idx)=>{
    const totalPcs=entry.items.reduce((a,i)=>a+i.totalPcs,0);
    const totalProducts=entry.items.length;
    const dateStr=new Date(entry.date).toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric'});
    const timeStr=new Date(entry.date).toLocaleString('en-IN',{hour:'2-digit',minute:'2-digit'});
    const uid='invBody_'+idx;
    return `<div class="inv-hist-card" id="invCard_${entry.id}" onclick="toggleInvHistCard(this,'${uid}')">
      <div class="inv-hist-header">
        <span class="inv-hist-chevron" id="chevron_${uid}" style="font-size:16px;">▶</span>
        <span class="badge badge-blue" style="font-size:15px;padding:4px 12px;font-weight:700;">${entry.id}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;font-size:14px;">
        <div style="display:flex;align-items:center;gap:6px;color:var(--text);font-weight:600;">📅 ${dateStr} <span style="color:var(--muted);font-size:13px;font-weight:400;">${timeStr}</span></div>
        ${entry.parcelCount?`<div style="display:flex;align-items:center;gap:6px;color:var(--accent2);font-weight:600;">📦 ${entry.parcelCount} parcel${entry.parcelCount>1?'s':''}</div>`:''}
        ${entry.supplier?`<div style="display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:600;">🏭 ${entry.supplier}</div>`:''}
        ${entry.destination?`<div style="display:flex;align-items:center;gap:6px;color:var(--accent2);font-weight:600;">📍 ${entry.destination}</div>`:''}
        ${entry.transportProvider?`<div style="display:flex;align-items:center;gap:6px;color:var(--accent2);font-weight:600;">🚚 ${entry.transportProvider}</div>`:''}
        ${(()=>{const tc=entry.transportCost??entry.transport??0;const tp=entry.transportPaid??0;return entry.transportStatus?`<div style="display:flex;align-items:center;gap:6px;font-weight:600;"><span class="badge ${entry.transportStatus==='paid'?'badge-green':'badge-red'}">🚚 ${entry.transportStatus==='paid'?'Paid':'Due'}</span> ${tc>0?'₹'+fmt(tc):''}${tp>0?' (paid: ₹'+fmt(tp)+')':''}</div>`:tc>0?`<div style="display:flex;align-items:center;gap:6px;color:var(--text);font-weight:600;">🚚 ₹${fmt(tc)}${tp>0?' (paid: ₹'+fmt(tp)+')':''}</div>`:'';})()}
        ${(()=>{const sb=entry.supplierBill||0;const sbp=entry.supplierBillPaid??0;return sb>0?`<div style="display:flex;align-items:center;gap:6px;font-weight:600;"><span class="badge ${entry.supplierBillStatus==='paid'?'badge-green':'badge-red'}">🧾 Bill ${entry.supplierBillStatus==='paid'?'Paid':'Due'}</span> ₹${fmt(sb)}${sbp>0?' (paid: ₹'+fmt(sbp)+')':''}</div>`:'';})()}
        ${entry.notes?`<div style="font-size:12px;color:var(--muted);">📝 ${entry.notes}</div>`:''}
      </div>
      ${entry.transportBillPhoto?(()=>{const m=entry.transportBillPhoto.match(/^data:([^;]+);/);const t=m?m[1]:'';const isImg=t.startsWith('image/');return isImg?`<div style="margin-top:4px;"><img src="${entry.transportBillPhoto}" style="max-width:100%;max-height:100px;border-radius:6px;cursor:pointer;" onclick="event.stopPropagation();window.open('${entry.transportBillPhoto}','_blank')"></div>`:`<div style="margin-top:4px;"><a href="${entry.transportBillPhoto}" download="TransportBill_${entry.id}" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--accent2);padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;text-decoration:none;" onclick="event.stopPropagation();">${t.includes('pdf')?'📄':t.includes('spreadsheet')?'📊':'📁'} Transport Bill (${t.split('/').pop()||'file'})</a></div>`;})():''}
      ${entry.supplierBillPhoto?(()=>{const m=entry.supplierBillPhoto.match(/^data:([^;]+);/);const t=m?m[1]:'';const isImg=t.startsWith('image/');return isImg?`<div style="margin-top:4px;"><img src="${entry.supplierBillPhoto}" style="max-width:100%;max-height:100px;border-radius:6px;cursor:pointer;" onclick="event.stopPropagation();window.open('${entry.supplierBillPhoto}','_blank')"></div>`:`<div style="margin-top:4px;"><a href="${entry.supplierBillPhoto}" download="SupplierBill_${entry.id}" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--accent2);padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;text-decoration:none;" onclick="event.stopPropagation();">${t.includes('pdf')?'📄':t.includes('spreadsheet')?'📊':'📁'} Supplier Bill (${t.split('/').pop()||'file'})</a></div>`;})():''}
      <div style="display:flex;gap:8px;margin-top:auto;padding-top:6px;border-top:1px solid var(--border);">
        <span style="font-size:14px;font-weight:700;color:var(--green);">${totalPcs} pcs</span>
        <span style="font-size:14px;font-weight:700;color:var(--accent2);">${totalProducts} product${totalProducts!==1?'s':''}</span>
        <button class="btn btn-ghost" style="font-size:14px;padding:4px 10px;border:1px solid var(--accent);color:var(--accent);border-radius:6px;margin-left:auto;" onclick="event.stopPropagation();exportSingleInvEntry('${entry.id}')" title="Download this entry">📥</button>
        <button class="btn btn-ghost" style="font-size:14px;padding:4px 10px;border:1px solid var(--red);color:var(--red);border-radius:6px;" onclick="event.stopPropagation();undoInvEntry('${entry.id}')">↩ Undo</button>
      </div>
      <div class="inv-hist-body" id="${uid}">
        ${entry.notes?`<div style="font-size:11px;color:var(--muted);margin-bottom:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">📝 ${entry.notes}</div>`:''}
        <div class="inv-hist-items">
          ${entry.items.map(item=>`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;">
            <div style="font-size:12px;margin-bottom:4px;">${(()=>{const lp=products.find(x=>x.id===item.productId);return lp&&lp.image?`<img src="${lp.image}" style="width:18px;height:18px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:4px;">`:(item.emoji||'📦')+' ';})()}<strong>${item.productName}</strong></div>
            <div style="font-size:11px;color:var(--accent);">${item.noOfBoxes>0?item.noOfBoxes+' box'+(item.noOfBoxes!==1?'es':'')+(item.noOfPieces>0?' + ':''):''}${item.noOfPieces>0?item.noOfPieces+' pcs':''} = <strong>${item.totalPcs} pcs</strong></div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px;">${item.catName}</div>
            ${item.purchasePrice?`<div style="font-size:10px;color:var(--muted);margin-top:1px;">Purc. ₹${fmt(item.purchasePrice)}/pc</div>`:''}
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('')+`</div>`;
}

function toggleInvHistCard(card, uid){
  const body=document.getElementById(uid);
  const chevron=document.getElementById('chevron_'+uid);
  if(!body) return;
  body.classList.toggle('open');
  if(chevron) chevron.classList.toggle('open');
}

function scrollToInvEntry(id){
  document.getElementById('prodDetailModal')?.classList.remove('open');
  navigate('invhistory');
  setTimeout(()=>{
    const card=document.getElementById('invCard_'+id);
    if(!card) return;
    card.scrollIntoView({behavior:'smooth',block:'center'});
    card.style.transition='background .3s';
    card.style.background='rgba(34,197,94,.15)';
    card.style.border='2px solid #22c55e';
    setTimeout(()=>{card.style.background='';card.style.border='';},2500);
  },100);
}

// ── ADVANCE ORDERS ────────────────────────────────────────────────────────────
let _advLocation = null;

function openAdvLocationMap(){
  openMapPicker({
    lat: _advLocation ? _advLocation.lat : null,
    lng: _advLocation ? _advLocation.lng : null,
    address: _advLocation ? _advLocation.address : '',
    onConfirm: r => {
      _advLocation = { lat: r.lat, lng: r.lng, address: r.address };
      document.getElementById('advLocationText').value = r.address;
      document.getElementById('advLocationText').style.color='var(--text)';
      // If a customer with a saved location is selected, offer to use it
      const cust = document.getElementById('advCustName').value.trim();
      if(cust){ linkSavedCustomerLoc(cust); }
    }
  });
}

function clearAdvLocation(){
  _advLocation = null;
  const el = document.getElementById('advLocationText');
  if(el){ el.value=''; el.style.color='var(--muted)'; }
}

function linkSavedCustomerLoc(custName){
  if(!custName || _advLocation) return;
  const ledger = customerLedgers.find(l => l.customerName.toLowerCase() === String(custName).toLowerCase());
  if(ledger && ledger.location && ledger.location.lat){
    _advLocation = { lat: ledger.location.lat, lng: ledger.location.lng, address: ledger.location.address };
    const el = document.getElementById('advLocationText');
    if(el){ el.value = ledger.location.address; el.style.color='var(--text)'; }
    notify('📍 Using customer saved location','success');
  }
}

function openAdvanceOrder(){
  ['advCustName','advPhone','advNotes','advPaid'].forEach(id=>document.getElementById(id).value='');
  clearAdvLocation();
  // Clear pack time fields
  document.getElementById('advPackTime').value='';
  const ad=document.getElementById('advPackDate');
  if(ad){ad.value='';ad._val='';ad.dataset.value='';}
  _advRowCount=0;
  document.getElementById('advRows').innerHTML='';
  document.getElementById('advTotal').textContent='';
  comboClose('advCustWrap');
  addAdvRow();
  document.getElementById('advanceModal').classList.add('open');
  setTimeout(()=>document.getElementById('advCustName').focus(),100);
  if(ad) calBind(ad);
}

function validatePackTime(val){
  if(!val) return false;
  const selected=new Date(val);
  const now=new Date();
  return selected>now; // strictly greater than now
}
function addAdvRow(){
  const idx=_advRowCount++;
  const prodOpts=products.map(p=>`<option value="${p.id}">${p.emoji} ${p.name} — ₹${fmt(p.price)}/pc</option>`).join('');
  const row=document.createElement('div');
  row.id=`advRow_${idx}`;
  row.style.cssText='display:grid;grid-template-columns:2fr 1fr auto;gap:8px;margin-bottom:10px;align-items:end;';
  row.innerHTML=`
    <div class="form-group" style="margin:0;">${idx===0?'<label style="font-size:11px;color:var(--muted);">Product</label>':''}
      <select id="advProd_${idx}" style="width:100%;" onchange="calcAdvTotal()"><option value="">-- Select --</option>${prodOpts}</select>
    </div>
    <div class="form-group" style="margin:0;">${idx===0?'<label style="font-size:11px;color:var(--muted);">Qty</label>':''}
      <input id="advQty_${idx}" type="number" min="1" placeholder="0" oninput="calcAdvTotal()">
    </div>
    <button class="btn btn-danger btn-sm" style="margin-top:${idx===0?'17':'0'}px;" onclick="removeAdvRow(${idx})">✕</button>`;
  document.getElementById('advRows').appendChild(row);
}
function removeAdvRow(idx){ const el=document.getElementById(`advRow_${idx}`); if(el){el.remove();calcAdvTotal();} }
function calcAdvTotal(){
  let total=0;
  for(let i=0;i<_advRowCount;i++){
    const pid=parseInt(document.getElementById(`advProd_${i}`)?.value)||0;
    const qty=parseInt(document.getElementById(`advQty_${i}`)?.value)||0;
    const p=products.find(x=>x.id===pid);
    if(p&&qty>0) total+=p.price*qty;
  }
  document.getElementById('advTotal').textContent=total>0?`Total: ₹${fmt(total)}`:'';
}
function saveAdvanceOrder(){
  const custName=up(document.getElementById('advCustName').value);
  const phone=(document.getElementById('advPhone').value||'').trim();
  const packTimeStr=calGetDt('advPackDate','advPackTime');
  const advPaid=parseFloat(document.getElementById('advPaid').value)||0;
  const notes=(document.getElementById('advNotes').value||'').trim();
  if(!custName){ notify('Customer name is required','error'); return; }
  if(!packTimeStr){ notify('Packing time is required','error'); return; }
  // Validate packing time is strictly in the future (not == current time)
  const packTimeDate=new Date(packTimeStr);
  if(packTimeDate<=new Date()){ notify('Packing time must be AFTER current time!','error'); document.getElementById('advPackDate').focus(); return; }
  const items=[];
  let total=0;
  for(let i=0;i<_advRowCount;i++){
    const pid=parseInt(document.getElementById(`advProd_${i}`)?.value)||0;
    const qty=parseInt(document.getElementById(`advQty_${i}`)?.value)||0;
    const p=products.find(x=>x.id===pid);
    if(p&&qty>0){ items.push({productId:p.id,productName:p.name,emoji:p.emoji,price:p.price,qty}); total+=p.price*qty; }
  }
  if(!items.length){ notify('Add at least one item','error'); return; }
  const order={id:'ADV-'+String(nextAdvId++).padStart(4,'0'),custName,phone,packTime:_localDateStr(packTimeDate),advPaid,notes,location:_advLocation||null,items,total,status:'scheduled',saleId:null,addlPaid:0};
  advanceOrders.push(order);
  scheduleAdvanceReminders(order);
  closeModal('advanceModal'); renderAdvanceOrders(); saveAllData(); notify(`Advance order saved for ${custName}`);
}

function scheduleAdvanceReminders(order){
  const now=new Date();
  const packTime=new Date(order.packTime);
  // Reminder 1hr before
  const msTo1Hr=packTime.getTime()-60*60*1000-now.getTime();
  if(msTo1Hr>0){
    const t1=setTimeout(()=>{
      if(order.status!=='billed'){
        notify(`⏰ 1 Hour Left! Advance order for ${order.custName} (${order.id}) is due in 1 hour!`,'error');
      }
    },msTo1Hr);
    _advReminderTimers.push(t1);
  }
  // Reminder at pack time
  const msToPackTime=packTime.getTime()-now.getTime();
  if(msToPackTime>0){
    const t2=setTimeout(()=>{
      if(order.status!=='billed'){
        notify(`🚨 Time to Pack! Order ${order.id} for ${order.custName} is ready to be packed NOW!`,'error');
        renderAdvanceOrders(); // refresh UI
      }
    },msToPackTime);
    _advReminderTimers.push(t2);
  }
}
function renderAdvanceOrders(){
  const wrap=document.getElementById('advanceOrdersWrap');
  if(!advanceOrders.length){
    wrap.innerHTML=`<div class="empty-state"><div class="big">📋</div><p>No advance orders yet.</p><button class="btn btn-primary" onclick="openAdvanceOrder()">+ New Advance Order</button></div>`;
    return;
  }
  const now=new Date();
  wrap.innerHTML=advanceOrders.slice().reverse().map(o=>{
    const packDate=new Date(o.packTime);
    const isPast=packDate<=now;
    const isHourAway=(packDate.getTime()-now.getTime())<=3600000&&packDate>now;
    const totalPaid=(o.advPaid||0)+(o.addlPaid||0);
    const pending=Math.max(0,o.total-totalPaid);
    // Determine status label
    let statusCls, statusLabel;
    if(o.status==='billed'&&pending>0){
      statusCls='status-udhaar'; statusLabel='💸 Udhaar';
    } else if(o.status==='billed'){
      statusCls='status-billed'; statusLabel='✅ Billed';
    } else if(isPast){
      statusCls='status-ready'; statusLabel='⏰ Ready to pack';
    } else if(isHourAway){
      statusCls='status-urgent'; statusLabel='🔴 Due in 1hr!';
    } else {
      statusCls='status-scheduled'; statusLabel='🕐 Scheduled';
    }
    // Time pending display
    const oldestBillDate=o.bills&&o.bills.length?new Date(o.bills[0].date):null;
    const pendingSince=oldestBillDate?getTimeSince(oldestBillDate):'';
    // Payment breakdown for billed orders
    let payBreakdown='';
    if(o.status==='billed'){
      payBreakdown=`<div style="margin-top:8px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:var(--muted);">Order Total</span><span style="color:var(--accent);font-weight:600;">₹${fmt(o.total)}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:var(--muted);">Advance Paid</span><span style="color:var(--green);">₹${fmt(o.advPaid||0)}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:var(--muted);">Additional Paid (on billing)</span><span style="color:var(--green);">₹${fmt(o.addlPaid||0)}</span></div>
        <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:6px;margin-top:2px;"><span style="color:var(--muted);font-weight:600;">${pending>0?'Balance Pending':'Fully Settled'}</span><span style="color:${pending>0?'var(--red)':'var(--green)'};font-weight:700;">₹${fmt(pending)}${pending<=0?' ✓':''}</span></div>
        ${pendingSince&&pending>0?`<div style="font-size:10px;color:var(--red);margin-top:4px;">⏳ Pending since ${pendingSince}</div>`:''}
      </div>`;
    }
    return `<div class="adv-card">
      <div class="adv-card-header">
        <div>
          <div style="font-family:var(--font-head);font-size:15px;font-weight:700;">👤 ${o.custName}</div>
          ${o.phone?`<div style="font-size:12px;color:var(--muted);">📞 ${o.phone}</div>`:''}
        </div>
        <span class="status-badge ${statusCls}">${statusLabel}</span>
        <span class="badge badge-blue" style="margin-left:auto;">${o.id}</span>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">⏱️ Pack by: <strong style="color:${isPast&&o.status!=='billed'?'var(--red)':'var(--text)'};">${packDate.toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</strong>${isHourAway?'<span style="color:var(--red);margin-left:6px;">⚠️ Due soon!</span>':''}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${o.items.map(i=>`${i.emoji} ${i.productName} ×${i.qty}`).join(' · ')}</div>
      ${o.status!=='billed'?`<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <span>Total: <strong style="color:var(--accent);">₹${fmt(o.total)}</strong></span>
        <span>Advance: <strong style="color:var(--green);">₹${fmt(o.advPaid)}</strong></span>
        <span>Balance: <strong style="color:${pending>0?'var(--red)':'var(--green)'};">₹${fmt(pending)}</strong></span>
      </div>`:payBreakdown}
      ${o.notes?`<div style="font-size:11px;color:var(--muted);">📝 ${o.notes}</div>`:''}
      ${o.location?`<div style="margin-top:6px;font-size:11px;color:var(--accent2);display:flex;align-items:center;gap:6px;">📍 ${escapeHtml(o.location.address||(''+o.location.lat+', '+o.location.lng))} <button class="btn btn-ghost btn-sm" style="padding:1px 8px;font-size:10px;" onclick="openMapFromData(${o.location.lat},${o.location.lng})">Open Map</button></div>`:''}
      ${o.transport?`<div style="margin-top:8px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:11px;color:var(--muted);">
        🚚 <strong style="color:var(--accent2);">Transport</strong>: ${o.transport.location||''}
        ${o.transport.recipient?` · 👤 ${o.transport.recipient}`:''}
        ${o.transport.vehicle?` · 🚛 ${o.transport.vehicle}`:''}
        ${o.transport.driverName?` · Driver: ${o.transport.driverName}`:''}
        ${o.transport.driverPhone?` (${o.transport.driverPhone})`:''}
        ${o.transport.cost>0?` · <span style="color:var(--accent);">₹${fmt(o.transport.cost)} transport cost</span>`:''}
      </div>`:''}
      ${o.status!=='billed'?`<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="openAdvBill('${o.id}')">💰 Bill & Complete</button></div>`:''}
    </div>`;
  }).join('');
}

function getTimeSince(date){
  const diff=Date.now()-new Date(date).getTime();
  const hrs=Math.floor(diff/3600000);
  const days=Math.floor(hrs/24);
  if(days>0) return `${days} day${days!==1?'s':''} ago`;
  if(hrs>0) return `${hrs} hour${hrs!==1?'s':''} ago`;
  return 'just now';
}
function openAdvBill(id){
  const o=advanceOrders.find(x=>x.id===id); if(!o) return;
  const orderTotal=o.total;
  const advPaid=o.advPaid||0;
  const balanceDue=Math.max(0,orderTotal-advPaid);
  const overPaid=advPaid>orderTotal?advPaid-orderTotal:0;
  document.getElementById('advBillOrderId').value=id;
  document.getElementById('advBillPayment').value='';
  document.getElementById('advBillPreview').textContent='';

  // Check if customer has pending udhaar
  const custLow=o.custName.toLowerCase();
  const udRec=udhaarRecords.find(r=>r.name.toLowerCase()===custLow);
  const udPending=udRec?Math.max(0,udRec.totalPending):0;

  // Build summary rows for the order
  let summaryRows=o.items.map(i=>`<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>${i.emoji} ${i.productName} ×${i.qty}</span><span>₹${fmt(i.price*i.qty)}</span></div>`).join('');

  // Build breakdown
  let breakdownHtml='';
  if(overPaid>0){
    // Advance paid > order total — show what happens with the extra
    const udApply=Math.min(overPaid,udPending);
    const returnAmt=overPaid-udApply;
    breakdownHtml=`
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span>Order Total</span><span style="color:var(--accent);font-weight:600;">₹${fmt(orderTotal)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>Advance Paid</span><span style="color:var(--green);">₹${fmt(advPaid)}</span></div>
      ${udApply>0?`<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>Applied to Pending Udhaar</span><span style="color:var(--accent2);">₹${fmt(udApply)}</span></div>`:''}
      ${returnAmt>0.005?`<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600;color:var(--green);"><span>💵 Return to Customer</span><span>₹${fmt(returnAmt)}</span></div>`:''}
      ${udApply>0&&returnAmt<=0.005?`<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--green);"><span>Balance</span><span>₹0.00 ✓</span></div>`:''}`;
  } else {
    breakdownHtml=`
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span>Order Total</span><span style="color:var(--accent);font-weight:600;">₹${fmt(orderTotal)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>Advance Paid</span><span style="color:var(--green);">₹${fmt(advPaid)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600;color:var(--red);"><span>Balance Due</span><span>₹${fmt(balanceDue)}</span></div>`;
  }

  document.getElementById('advBillContent').innerHTML=`
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px;">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">👤 ${o.custName} · ${o.id}</div>
      ${summaryRows}
      <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;">
        ${breakdownHtml}
      </div>
    </div>
    ${overPaid>0?`<div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.25);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--green);margin-bottom:14px;">
      ✅ Advance payment fully covers the order. No additional payment needed.
    </div>`:''}`;

  // If overpaid, disable the additional payment input
  const payInput=document.getElementById('advBillPayment');
  const payInputWrap=document.getElementById('advBillPaymentWrap');
  if(payInputWrap) payInputWrap.style.display=overPaid>0?'none':'block';
  if(payInput){ payInput.disabled=overPaid>0; if(overPaid>0) payInput.value='0'; }
  document.getElementById('advBillModal').classList.add('open');
}
function updateAdvBillPreview(){
  const id=document.getElementById('advBillOrderId').value;
  const o=advanceOrders.find(x=>x.id===id); if(!o) return;
  const pending=Math.max(0,o.total-o.advPaid);
  const nowPay=parseFloat(document.getElementById('advBillPayment').value)||0;
  const still=Math.max(0,pending-nowPay);
  document.getElementById('advBillPreview').textContent=still>0?`After payment: ₹${fmt(still)} will go to Udhaar`:'Fully settled ✓';
}
function finalizeAdvOrder(){
  const id=document.getElementById('advBillOrderId').value;
  const o=advanceOrders.find(x=>x.id===id); if(!o) return;
  const nowPay=parseFloat(document.getElementById('advBillPayment').value)||0;
  const method=document.getElementById('advBillMethod').value;
  const advPaid=o.advPaid||0;
  const orderTotal=o.total;
  const overPaid=advPaid>orderTotal?advPaid-orderTotal:0;
  const saleId='TXN-'+String(nextSaleId++).padStart(6,'0');

  // Finalize: if advance overpaid, total paid = orderTotal (no pending)
  const totalPaid=overPaid>0?orderTotal:(advPaid+nowPay);
  const pending=Math.max(0,orderTotal-totalPaid);
  // Use the advance order's packTime as the sale date
  const saleDate = o.packTime || _localDateStr();
  const sale={
    id:saleId,customerName:o.custName,customerPhone:o.phone||'',
    // Advance orders do not collect tax at the counter, but zeroing the rate here
    // would make the GST engine read a genuinely taxable product as nil-rated.
    // Carry the real rate through so the CRITICAL ""taxable item on a non-GST
    // bill"" check fires instead of a silently wrong return.
    items:o.items.map(i=>{const _p=products.find(x=>x.id===i.productId);return {name:i.productName,qty:i.qty,price:i.price,gst:(_p&&_p.gst)||0,cgst:(_p&&_p.cgst)||0,sgst:(_p&&_p.sgst)||0,igst:(_p&&_p.igst)||0,purchasePrice:(_p&&_p.purchasePrice)||0};}),
    sub:orderTotal,tax:0,total:orderTotal,method,amtPaid:totalPaid,pending,
    date:saleDate,taxApplied:false,payType:pending>0?'partial':'paid',
    // Advance-order bills keep the same document defaults as the checkout screen;
    // the tax error is surfaced by validation rather than hidden here.
    docType:'tax_invoice',supplyType:'domestic',docStatus:'finalised',isInterstate:!isIntrastate()
  };
  sales.push(sale);
  o.items.forEach(item=>{
    const p=products.find(x=>x.id===item.productId); if(!p) return;
    let toDeduct=item.qty;
    const ppb=Math.max(1,p.piecesPerBox||1);
    const fromPcs=Math.min(toDeduct,Math.max(0,p.noOfPieces||0));
    p.noOfPieces=Math.max(0,(p.noOfPieces||0)-fromPcs); toDeduct-=fromPcs;
    if(toDeduct>0&&(p.noOfBoxes||0)>0){
      const btOpen=Math.min(Math.ceil(toDeduct/ppb),p.noOfBoxes||0);
      p.noOfBoxes=Math.max(0,(p.noOfBoxes||0)-btOpen);
      p.noOfPieces=Math.max(0,(p.noOfPieces||0)+btOpen*ppb-toDeduct);
    }
    p.stock=Math.max(0,calcTotalStock(p.noOfBoxes||0,p.noOfPieces||0,ppb));
  });

  // Handle overpaid → apply to customer's udhaar
  if(overPaid>0){
    const custLow=o.custName.toLowerCase();
    const udRec=udhaarRecords.find(r=>r.name.toLowerCase()===custLow);
    const udPending=udRec?Math.max(0,udRec.totalPending):0;
    if(udRec&&udPending>0){
      const udApply=Math.min(overPaid,udPending);
      let toApply=udApply;
      udRec.bills.forEach(b=>{
        if(toApply<=0||b.pending<=0) return;
        const apply=Math.min(toApply,b.pending);
        b.amtPaid+=apply; b.pending=Math.max(0,b.pending-apply);
        b.payments.push({amount:apply,date:_localDateStr(),note:'From advance overpayment '+saleId});
        toApply-=apply;
      });
      recalcUd(udRec);
      const returnAmt=overPaid-udApply;
      if(returnAmt>0.005) notify(`Return ₹${fmt(returnAmt)} to ${o.custName}`,'success');
    } else {
      notify(`Return ₹${fmt(overPaid)} to ${o.custName} (advance exceeded order)`,'success');
    }
  }

  if(pending>0) addUdhaarBill(o.custName,o.phone||'','',sale);
  addLedgerEntry(o.custName, o.phone, saleDate, `Sale ${saleId} - Advance Order ${id}`, sale.total, totalPaid);
  o.status='billed'; o.saleId=saleId; o.addlPaid=nowPay;
  o.bills=pending>0?[{date:_localDateStr(),saleId,totalBill:orderTotal,amtPaid:totalPaid,pending}]:[];
  closeModal('advBillModal'); renderAdvanceOrders(); saveAllData(); showReceipt(sale);
  setTimeout(()=>checkZeroStockAfterSale(sale),1500);
  notify(`Order billed: ${o.custName} · ₹${fmt(orderTotal)}`);
}

// ── DASHBOARD ────────────────────────────────────────────────────────────────
// Profit helper: sum of (sellingPrice - purchasePrice) * qty for all sale items
function calcProfit(salesArr){
  return salesArr.reduce((a,s)=>{
    return a + s.items.reduce((b,i)=>{
      // Use stored purchasePrice from sale item (historical), or lookup from purchasePriceLog
      const cp = i.purchasePrice != null ? i.purchasePrice : getPurchasePriceAtDate(i.name, s.date);
      const sp = i.customPrice != null ? i.customPrice : i.price;
      return b + (sp - cp) * i.qty;
    }, 0);
  }, 0);
}

// Revenue helper: actual collected revenue (excludes pending udhaar)
function calcRevenue(salesArr, includeUdhaar=false){
  return salesArr.reduce((a,s)=>{
    if(includeUdhaar) return a + s.total;
    // Only count what was actually paid (amtPaid), skip pending
    return a + (s.amtPaid != null ? s.amtPaid : s.total);
  }, 0);
}

let _dashUdhaarMode = false; // false = without pending udhaar, true = with

function renderDashboard(){
  const todaySales=sales.filter(s=>new Date(s.date).toDateString()===new Date().toDateString());
  const todayRev = calcRevenue(todaySales, _dashUdhaarMode);
  const totalRev = calcRevenue(sales, _dashUdhaarMode);
  const todayRevWithUd = calcRevenue(todaySales, true);
  const totalRevWithUd = calcRevenue(sales, true);
  const todayProfit = calcProfit(todaySales);
  const totalProfit = calcProfit(sales);
  const todayExpenses = calcPeriodExpenses(new Date(new Date().setHours(0,0,0,0)), new Date());
  const totalExpenses = calcExpenses(sales);
  const netTodayProfit = todayProfit - todayExpenses;
  const netTotalProfit = totalProfit - totalExpenses;
  const lowItems=products.filter(p=>p.stock<=p.low).length;
  const activeOrders=advanceOrders.filter(o=>o.status!=='billed').length;
  const pendingUdhaarCount=udhaarRecords.filter(r=>r.totalPending>0).length;
  const pendingUdhaarAmt=udhaarRecords.reduce((a,r)=>a+r.totalPending,0);
  const udhaarToggleHtml = `<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">
    <span style="font-size:11px;color:var(--muted);">Revenue mode:</span>
    <button class="filter-pill${!_dashUdhaarMode?' active':''}" onclick="_dashUdhaarMode=false;renderDashboard();">Without Pending Udhaar</button>
    <button class="filter-pill${_dashUdhaarMode?' active':''}" onclick="_dashUdhaarMode=true;renderDashboard();">Include Pending Udhaar</button>

  </div>`;
  document.getElementById('dashUdhaarToggleWrap').innerHTML = udhaarToggleHtml;
  document.getElementById('statsRow').innerHTML=`
    <div class="stat-card yellow interactive-card" onclick="showDashDetail('today')" title="Click to see today's sales">
      <div class="stat-label">Today's Revenue <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value yellow">₹${fmt(todayRev)}</div>
      <div class="stat-sub">${todaySales.length} transactions</div>
    </div>
    <div class="stat-card blue interactive-card" onclick="showDashDetail('all')" title="Click to see all sales">
      <div class="stat-label">Total Revenue <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value blue">₹${fmt(totalRev)}</div>
      <div class="stat-sub">${sales.length} all-time</div>
    </div>
    <div class="stat-card green" title="Today's profit minus expenses">
      <div class="stat-label">Today's Profit <span style="font-size:9px;opacity:.6;">↗</span></div>
      <div class="stat-value green">₹${fmt(netTodayProfit)}</div>
      <div class="stat-sub">${todaySales.length} transaction${todaySales.length!==1?'s':''}${todayExpenses>0?' · expenses: -₹'+fmt(todayExpenses):''}</div>
    </div>
    <div class="stat-card green interactive-card" onclick="navigate('inventory')" title="Click to manage products">
      <div class="stat-label">Products <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value green">${products.length}</div>
      <div class="stat-sub">${categories.length} categories → Go to Inventory</div>
    </div>
    <div class="stat-card green" title="Total Profit minus all expenses">
      <div class="stat-label">Total Profit <span style="font-size:9px;opacity:.6;">↗</span></div>
      <div class="stat-value green">₹${fmt(netTotalProfit)}</div>
      <div class="stat-sub">All time · ${totalRev>0?'margin '+(netTotalProfit/totalRev*100).toFixed(1)+'%':''}</div>
    </div>
    <div class="stat-card red interactive-card" onclick="goToLowStock()" title="Click to see low stock items">
      <div class="stat-label">Low Stock <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value red">${lowItems}</div>
      <div class="stat-sub">Need restock → Filter Inventory</div>
    </div>
    <div class="stat-card purple interactive-card" onclick="navigate('advance')" title="Click to see active orders">
      <div class="stat-label">Active Orders <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value purple">${activeOrders}</div>
      <div class="stat-sub">Pending advance orders</div>
    </div>
    <div class="stat-card orange interactive-card" onclick="navigate('udhaar')" title="Click to see udhaar records">
      <div class="stat-label">Pending Udhaar <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value orange">₹${fmt(pendingUdhaarAmt)}</div>
      <div class="stat-sub">${pendingUdhaarCount} customer${pendingUdhaarCount!==1?'s':''}</div>
    </div>`;
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayData=Array(7).fill(0);
  sales.forEach(s=>{dayData[new Date(s.date).getDay()]+=_dashUdhaarMode?s.total:(s.amtPaid||s.total);});
  const maxVal=Math.max(...dayData,1);
  // Build an animated bar chart with proper heights
  document.getElementById('weekChart').innerHTML=dayData.map((v,i)=>{
    const heightPct=v>0?Math.max((v/maxVal*100),4):0;
    return `<div class="bar-col" onclick="showDayDetail(${i})" style="cursor:pointer;" title="₹${fmt(v)} on ${days[i]}">
      <div class="bar-wrap">
        <div class="bar-animated" style="height:${heightPct}%;" data-val="${v}">
          ${v>0?`<span class="bar-tooltip">₹${fmt(v)}</span>`:''}
        </div>
      </div>
      <div class="bar-label">${days[i]}</div>
    </div>`;
  }).join('');
  const low=products.filter(p=>p.stock<=p.low);
  document.getElementById('lowStockList').innerHTML=
    !products.length
      ? '<div style="color:var(--muted);font-size:13px;padding:12px 0;">📦 Inventory is empty — no products added yet</div>'
      : !low.length
        ? '<div style="color:var(--muted);font-size:12px;padding:10px 0;">✓ All items well stocked</div>'
        : low.map(p=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--td-border);cursor:pointer;" onclick="goToLowStock()" title="Click to filter inventory">
            ${p.image?`<img src="${p.image}" style="width:28px;height:28px;object-fit:cover;border-radius:6px;vertical-align:middle;">`:`<span style="font-size:20px;">${p.emoji}</span>`}
            <div style="flex:1;">
              <div style="font-size:13px;font-weight:600;">${p.name} <span class="badge badge-blue" style="font-size:10px;">${getCatName(p.catId)}</span></div>
              ${p.purchasePrice?`<div style="font-size:10px;color:var(--muted);">PC:₹${fmt(p.purchasePrice)}${p.lastPurchaseDate?` · 🛒${p.lastPurchaseDate.slice(0,10)}`:''}</div>`:''}
              <div class="stock-bar"><div class="stock-fill" style="width:${Math.min((p.stock/Math.max(p.low,1))*50,100)}%;background:${p.stock===0?'var(--red)':'var(--accent)'}"></div></div>
            </div>
            <span class="badge badge-red">${p.stock} left</span>
          </div>`).join('');
  const rw=document.getElementById('recentSalesWrap');
  if(!sales.length){rw.innerHTML='<div class="empty-state"><div class="big">🧾</div><p>No sales yet.</p></div>';}
  else {
    rw.innerHTML=`<table><thead><tr><th>ID</th><th>Customer</th><th>Items</th><th>Total</th><th>Method</th><th>Time</th></tr></thead><tbody>${
      sales.slice(-5).reverse().map(s=>`<tr style="cursor:pointer;" onclick="navigate('sales')" title="View all sales">
        <td><span class="badge badge-blue">${s.id}</span></td>
        <td>${s.customerName||'—'}</td>
        <td>${s.items.map(i=>i.name).join(', ')}</td>
        <td style="color:var(--accent);">₹${fmt(s.total)}</td>
        <td><span class="badge badge-${s.method==='Cash'?'green':s.method==='UPI'?'yellow':s.method==='Udhaar'?'red':'blue'}">${s.method}</span></td>
        <td style="color:var(--muted);">${new Date(s.date).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</td>
      </tr>`).join('')
    }</tbody></table>`;
  }
  // Quick Purchase Price Update widget
  const qpWrap = document.getElementById('quickPriceUpdateWrap');
  const qpSel = window._qpSelectedProduct;
  qpWrap.innerHTML = `
    <div style="position:relative;">
      <input id="qpSearchInput" class="search-bar" style="width:100%;" placeholder="Search product..." autocomplete="off"
        oninput="filterQpProducts(this.value)"
        onfocus="filterQpProducts(this.value)"
        onblur="setTimeout(()=>{document.getElementById('qpAcList').style.display='none';},200)">
      <div class="combo-list" id="qpAcList" style="position:absolute;top:100%;left:0;right:0;z-index:10;display:none;"></div>
    </div>
    <div id="qpDetail" style="margin-top:10px;${qpSel?'' : 'display:none;'}">
      ${qpSel ? `
        <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
          <span style="font-size:28px;">${qpSel.emoji}</span>
          <div style="flex:1;">
            <div style="font-size:14px;font-weight:600;">${qpSel.name}</div>
            <div style="font-size:12px;color:var(--muted);">Sell: <span style="color:var(--green);font-weight:600;">₹${fmt(qpSel.price)}</span> · Cost: <span style="color:var(--red);font-weight:600;">₹${fmt(qpSel.purchasePrice)}</span></div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap;">
          <span style="font-size:13px;color:var(--muted);white-space:nowrap;">Sell Price:</span>
          <input id="qpNewSellPrice" type="number" step="0.01" min="0" value="${qpSel.price}" style="flex:1;min-width:80px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--surface1);color:var(--text);">
          <span style="font-size:13px;color:var(--muted);white-space:nowrap;">Cost Price:</span>
          <input id="qpNewCostPrice" type="number" step="0.01" min="0" value="${qpSel.purchasePrice}" style="flex:1;min-width:80px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--surface1);color:var(--text);">
          <button class="btn btn-primary btn-sm" onclick="saveQpPrice()">✓ Update</button>
          <button class="btn btn-ghost btn-sm" onclick="clearQpSelection()">✕ Cancel</button>
        </div>
      ` : ''}
    </div>`;
}

function filterQpProducts(q) {
  const list = document.getElementById('qpAcList');
  const items = q.trim() ? products.filter(p => matchWords(p.name,q.toLowerCase())).slice(0, 8) : [];
  if(!items.length){ list.style.display='none'; return; }
  list.innerHTML = items.map(p => `<div class="combo-item" onmousedown="selectQpProduct(${p.id})">${p.emoji} ${p.name} <span style="color:var(--muted);font-size:11px;">₹${fmt(p.purchasePrice)}</span></div>`).join('');
  list.style.display = 'block';
}
function selectQpProduct(id) {
  window._qpSelectedProduct = products.find(p => p.id === id);
  document.getElementById('qpSearchInput').value = '';
  document.getElementById('qpAcList').style.display = 'none';
  renderDashboard();
}
function saveQpPrice() {
  const p = window._qpSelectedProduct;
  if(!p) return;
  const newSell = parseFloat(document.getElementById('qpNewSellPrice').value);
  const newCost = parseFloat(document.getElementById('qpNewCostPrice').value);
  if(isNaN(newSell) || newSell < 0 || isNaN(newCost) || newCost < 0){ notify('Enter valid prices','error'); return; }
  let changed=[];
  if(p.price !== newSell){ p.price = newSell; changed.push('selling price → ₹'+fmt(newSell)); }
  if(p.purchasePrice !== newCost){
    logPurchasePriceChange(p.name, newCost, 'Dashboard');
    p.purchasePrice = newCost;
    p.lastPurchaseDate = _localDateStr();
    changed.push('cost → ₹'+fmt(newCost));
  }
  window._qpSelectedProduct = null;
  saveAllData();
  renderDashboard();
  if(changed.length) notify(`✓ ${p.name}: ${changed.join(', ')}`);
}
function clearQpSelection() {
  window._qpSelectedProduct = null;
  renderDashboard();
}

function goToLowStock(){
  navigate('inventory');
  _invLowStockFilter=true; // set AFTER navigate (which resets it)
  renderInventory();
}

function showDashDetail(type){
  navigate('sales');
  if(type==='today'){
    _salesFilter='today';
    document.querySelectorAll('.filter-pill').forEach(p=>{
      if(p.dataset.filter==='gst') return;
      p.classList.remove('active');
    });
    document.querySelectorAll('.filter-pill').forEach(p=>{ if(p.textContent.trim()==='Today'||p.dataset.filter==='gst'&&_salesGstOnly) p.classList.add('active'); });
    renderSalesHistory();
  } else {
    _salesFilter='all';
    document.querySelectorAll('.filter-pill').forEach(p=>{
      if(p.dataset.filter==='gst') return;
      p.classList.remove('active');
    });
    document.querySelectorAll('.filter-pill').forEach(p=>{ if(p.textContent.trim()==='All Time'||p.dataset.filter==='gst'&&_salesGstOnly) p.classList.add('active'); });
    renderSalesHistory();
  }
}

// ── SALES HISTORY ─────────────────────────────────────────────────────────────
function showDayDetail(dayIdx){
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const daySales=sales.filter(s=>new Date(s.date).getDay()===dayIdx);
  if(!daySales.length){ notify(`No sales on ${days[dayIdx]}`,'error'); return; }
  const total=daySales.reduce((a,s)=>a+s.total,0);
  const itemsMap={};
  daySales.forEach(s=>s.items.forEach(i=>{itemsMap[i.name]=(itemsMap[i.name]||0)+i.qty;}));
  const topItems=Object.entries(itemsMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
  notify(`${days[dayIdx]}: ₹${fmt(total)} · ${daySales.length} sale${daySales.length!==1?'s':''}`, 'success');
}
function salesSearchInput(val){
  _salesSearchQuery=val.trim().toLowerCase();
  const list=document.getElementById('salesSearchAcList');
  const clearBtn=document.getElementById('salesSearchClearBtn');
  if(clearBtn) clearBtn.style.display=_salesSearchQuery?'inline-block':'none';
  if(!_salesSearchQuery){list.style.display='none';renderSalesHistory();return;}
  // Build autocomplete suggestions
  const mode=document.getElementById('salesSearchMode').value;
  const suggestions=[];
  if(mode==='customer'){
    const seen=new Set();
    sales.forEach(s=>{
      const n=(s.customerName||'').toLowerCase();
      if(n&&matchWords(n,_salesSearchQuery)&&!seen.has(n)){seen.add(n);suggestions.push(s.customerName);}
    });
  } else {
    const seen=new Set();
    sales.forEach(s=>s.items.forEach(i=>{
      const pn=i.name.toLowerCase();
      if(matchWords(pn,_salesSearchQuery)&&!seen.has(pn)){seen.add(pn);suggestions.push(i.name);}
    }));
  }
  list.innerHTML=suggestions.slice(0,8).map(s=>`<div class="autocomplete-item" onclick="selectSalesSuggestion('${s.replace(/'/g,"\\'")}')">${s}</div>`).join('');
  list.style.display=suggestions.length?'block':'none';
  renderSalesHistory();
}
function selectSalesSuggestion(val){
  document.getElementById('salesSearch').value=val;
  _salesSearchQuery=val.toLowerCase();
  document.getElementById('salesSearchAcList').style.display='none';
  const clearBtn=document.getElementById('salesSearchClearBtn');
  if(clearBtn) clearBtn.style.display='inline-block';
  renderSalesHistory();
}
function salesSearchModeChange(val){
  _salesSearchMode=val;
  document.getElementById('salesSearchAcList').style.display='none';
  if(_salesSearchQuery) renderSalesHistory();
}
function clearSalesSearch(){
  _salesSearchQuery='';
  document.getElementById('salesSearch').value='';
  document.getElementById('salesSearchAcList').style.display='none';
  const clearBtn=document.getElementById('salesSearchClearBtn');
  if(clearBtn) clearBtn.style.display='none';
  renderSalesHistory();
}
function setSalesFilter(f,btn){
  if(f==='gst'){
    _salesGstOnly=!_salesGstOnly;
    btn.classList.toggle('active',_salesGstOnly);
    renderSalesHistory();
    return;
  }
  _salesFilter=f;
  _salesMethodFilter=null;
  document.querySelectorAll('.filter-pill').forEach(p=>{
    if(p.dataset.filter==='gst') return;
    p.classList.remove('active');
  });
  btn.classList.add('active');
  const isCustom=f==='custom';
  document.getElementById('salesDateRange').style.display = isCustom?'flex':'none';
  if(isCustom){
    const sf=document.getElementById('salesFrom'); if(sf){ sf._val=''; sf.value=''; }
    const st=document.getElementById('salesTo'); if(st){ st._val=''; st.value=''; }
  }
  renderSalesHistory();
}
function renderSalesHistory(){
  // Sync search input
  const searchEl=document.getElementById('salesSearch');
  if(searchEl&&searchEl.value!==_salesSearchQuery) searchEl.value=_salesSearchQuery;
  const clearBtn=document.getElementById('salesSearchClearBtn');
  if(clearBtn) clearBtn.style.display=_salesSearchQuery?'inline-block':'none';
  const now=new Date();
  let filtered=sales.filter(s=>!s.hidden);
  if(_salesFilter==='month'){const cutoff=new Date(now.getFullYear(),now.getMonth(),1);filtered=filtered.filter(s=>new Date(s.date)>=cutoff);}
  else if(_salesFilter==='week'){const cutoff=new Date(now);cutoff.setDate(cutoff.getDate()-7);filtered=filtered.filter(s=>new Date(s.date)>=cutoff);}
  else if(_salesFilter==='today'){filtered=filtered.filter(s=>new Date(s.date).toDateString()===now.toDateString());}
  else   if(_salesFilter==='custom'){
    const fromVal=document.getElementById('salesFrom')._val||document.getElementById('salesFrom').value;
    const toVal=document.getElementById('salesTo')._val||document.getElementById('salesTo').value;
    if(fromVal){const from=new Date(fromVal+'T00:00:00');filtered=filtered.filter(s=>new Date(s.date)>=from);}
    if(toVal){const to=new Date(toVal+'T23:59:59');filtered=filtered.filter(s=>new Date(s.date)<=to);}
  }
  if(_salesGstOnly) filtered=filtered.filter(s=>s.taxApplied&&s.tax>0);
  if(_salesMethodFilter) filtered=filtered.filter(s=>s.method===_salesMethodFilter);
  if(_salesSearchQuery){
    if(_salesSearchMode==='customer'){
      filtered=filtered.filter(s=>matchWords((s.customerName||'').toLowerCase(),_salesSearchQuery));
    } else {
      const q=_salesSearchQuery;
      filtered=filtered.filter(s=>s.items.some(i=>matchWords(i.name.toLowerCase(),q)));
    }
  }
  const wrap=document.getElementById('salesWrap');
  if(!filtered.length){wrap.innerHTML='<div class="empty-state"><div class="big">🧾</div><p>No sales in this period.</p></div>';document.getElementById('salesCount').textContent='';return;}
  const label=(_salesGstOnly?' GST only':_salesMethodFilter?` ${_salesMethodFilter}`:'')+(_salesSearchQuery?` · search: "${_salesSearchQuery}"`:'');
  document.getElementById('salesCount').textContent = `${filtered.length} sale${filtered.length!==1?'s':''}${label}`;
  const methodColors={Cash:'green',UPI:'yellow',Udhaar:'red'};
  wrap.innerHTML=`<div class="inv-hist-wrap">${
    filtered.slice().reverse().map(s=>{
      const d=new Date(s.date);
      const dateStr=d.toLocaleString('en-CN',{day:'numeric',month:'short',year:'numeric'});
      const timeStr=d.toLocaleString('en-IN',{hour:'2-digit',minute:'2-digit'});
      const itemsStr=s.items.map(i=>`${i.name}×${i.qty}`).join(', ');
      const pending=(s.pending||0)>0;
      const mc=methodColors[s.method]||'blue';
      return `<div class="inv-hist-card" style="cursor:default;">
        <div class="inv-hist-header">
          <span class="badge badge-blue" style="font-size:13px;padding:4px 10px;font-weight:700;cursor:pointer;" onclick="showReceipt(sales.find(x=>x.id==='${s.id}'))">${s.id}</span>
          <span class="badge badge-${mc}" style="font-size:11px;padding:3px 8px;">${s.method}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;font-size:12px;">
          <div style="font-weight:600;color:var(--text);">${s.customerName||'Walk-in'}</div>
          ${s.customerPhone?`<div style="font-size:11px;color:var(--muted);">📞 ${s.customerPhone}</div>`:''}
          <div style="font-size:11px;color:var(--muted);">📅 ${dateStr} <span style="color:var(--muted);">${timeStr}</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px;font-size:11px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Total</span><span style="color:var(--accent);font-weight:700;">₹${fmt(s.total)}</span></div>
          <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Paid</span><span style="color:var(--green);font-weight:600;">₹${fmt(s.amtPaid!=null?s.amtPaid:s.total)}</span></div>
          ${pending?`<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Pending</span><span style="color:var(--red);font-weight:600;">₹${fmt(s.pending||0)}</span></div>`:''}
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:4px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${itemsStr}">🛒 ${itemsStr}</div>
        <div style="display:flex;gap:6px;margin-top:auto;padding-top:6px;border-top:1px solid var(--border);">
          <button class="btn btn-ghost" style="font-size:10px;padding:2px 7px;border:1px solid var(--border);border-radius:5px;" onclick="showReceipt(sales.find(x=>x.id==='${s.id}'))">📄 PDF</button>
          <button class="btn btn-ghost" style="font-size:10px;padding:2px 7px;border:1px solid var(--red);color:var(--red);border-radius:5px;margin-left:auto;" onclick="deleteSingleSale('${s.id}')">🗑️</button>
        </div>
      </div>`;
    }).join('')
  }</div>`;
}

// ── REPORTS ───────────────────────────────────────────────────────────────────
let _reportsFilter = 'all'; // 'today','yesterday','week','month','all','custom'
let _reportsFrom = '', _reportsTo = '';
let _reportsUdhaarMode = false;

function getFilteredSalesForReports(){
  const now = new Date();
  let from, to;
  if(_reportsFilter==='today'){
    from=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    to=new Date(now.getFullYear(),now.getMonth(),now.getDate(),23,59,59,999);
  } else if(_reportsFilter==='yesterday'){
    from=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
    to=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1,23,59,59,999);
  } else if(_reportsFilter==='week'){
    from=new Date(now); from.setDate(from.getDate()-7);
    to=now;
  } else if(_reportsFilter==='month'){
    from=new Date(now.getFullYear(),now.getMonth(),1);
    to=now;
  } else if(_reportsFilter==='custom' && _reportsFrom && _reportsTo){
    from=new Date(_reportsFrom);
    to=new Date(_reportsTo); to.setHours(23,59,59,999);
  } else {
    return sales;
  }
  return sales.filter(s=>{ const d=new Date(s.date); return d>=from&&d<=to; });
}

function renderReports(){
  const filteredSales = getFilteredSalesForReports();
  const totalRev = calcRevenue(filteredSales, _reportsUdhaarMode);
  const totalTax=filteredSales.reduce((a,s)=>a+(s.tax||0),0);
  const avgSale=filteredSales.length?totalRev/filteredSales.length:0;
  const totalItems=filteredSales.reduce((a,s)=>a+s.items.reduce((b,i)=>b+i.qty,0),0);
  // Build filter UI
  const filterHtml = `<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">
    <span style="font-size:11px;color:var(--muted);">Period:</span>
    ${['today','yesterday','week','month','all'].map(f=>`<button class="filter-pill${_reportsFilter===f?' active':''}" onclick="_reportsFilter='${f}';_reportsFrom='';_reportsTo='';renderReports();">${f==='today'?'Today':f==='yesterday'?'Yesterday':f==='week'?'Last 7 Days':f==='month'?'This Month':'All Time'}</button>`).join('')}
    <button class="filter-pill${_reportsFilter==='custom'?' active':''}" onclick="document.getElementById('reportsCustomRange').style.display=_reportsFilter==='custom'?'flex':'flex';_reportsFilter='custom';renderReports();">📅 Custom</button>
    <span style="margin-left:auto;font-size:11px;color:var(--muted);">Revenue:</span>
    <button class="filter-pill${!_reportsUdhaarMode?' active':''}" onclick="_reportsUdhaarMode=false;renderReports();">Paid Only</button>
    <button class="filter-pill${_reportsUdhaarMode?' active':''}" onclick="_reportsUdhaarMode=true;renderReports();">+ Pending Udhaar</button>
  </div>
  <div id="reportsCustomRange" style="display:${_reportsFilter==='custom'?'flex':'none'};gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
    <input type="date" id="rFromDate" value="${_reportsFrom}" onchange="_reportsFrom=this.value;renderReports();" style="padding:7px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;">
    <span style="color:var(--muted);">to</span>
    <input type="date" id="rToDate" value="${_reportsTo}" onchange="_reportsTo=this.value;renderReports();" style="padding:7px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;">
    <span style="font-size:12px;color:var(--muted);">${filteredSales.length} sales in range</span>
  </div>`;
  document.getElementById('reportsFilterWrap').innerHTML = filterHtml;

  const totalProfit = calcProfit(filteredSales);
  const totalPeriodExpenses = calcPeriodExpenses(
    _reportsFilter==='today'?new Date(new Date().setHours(0,0,0,0)):
    _reportsFilter==='yesterday'?new Date(new Date().setDate(new Date().getDate()-1)):null,
    null
  );
  const netProfit = totalProfit - totalPeriodExpenses;
  document.getElementById('reportStats').innerHTML=`
    <div class="stat-card yellow interactive-card" onclick="navigate('sales')" title="Click to view all sales">
      <div class="stat-label">Total Revenue <span style="font-size:9px;opacity:.6;">↗ Sales</span></div>
      <div class="stat-value yellow">₹${fmt(totalRev)}</div>
      <div class="stat-sub">${_reportsUdhaarMode?'incl. pending':'paid only'}</div>
    </div>
    <div class="stat-card green" title="Total Profit minus expenses">
      <div class="stat-label">Net Profit <span style="font-size:9px;opacity:.6;">↗</span></div>
      <div class="stat-value green">₹${fmt(netProfit)}</div>
      <div class="stat-sub">${totalRev>0?'margin '+(netProfit/totalRev*100).toFixed(1)+'%':''}${totalPeriodExpenses>0?' · expenses: -₹'+fmt(totalPeriodExpenses):''}</div>
    </div>
    <div class="stat-card blue interactive-card" onclick="showAvgSaleBreakdown()" title="Click for average sale breakdown">
      <div class="stat-label">Avg Sale <span style="font-size:9px;opacity:.6;">↗ click</span></div>
      <div class="stat-value blue">₹${fmt(avgSale)}</div>
    </div>
    <div class="stat-card green interactive-card" onclick="navigate('inventory')" title="Click to view inventory">
      <div class="stat-label">Items Sold <span style="font-size:9px;opacity:.6;">↗ Inventory</span></div>
      <div class="stat-value green">${totalItems}</div>
    </div>
    <div class="stat-card red" title="GST Collected" onclick="filterSalesGstOnly()" style="cursor:pointer;">
      <div class="stat-label">GST Collected <span style="font-size:9px;opacity:.6;">↗</span></div>
      <div class="stat-value red">₹${fmt(totalTax)}</div>
    </div>`;
  const noData='<div style="color:var(--muted);font-size:12px;padding:10px 0;">No sales data yet.</div>';
  if(!filteredSales.length){['categoryChart','topProducts','bottomProducts','paymentBreakdown'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=noData;});return;}
  const catRev={};
  filteredSales.forEach(s=>s.items.forEach(i=>{const p=products.find(x=>x.name===i.name);const cat=p?getCatName(p.catId):'Other';catRev[cat]=(catRev[cat]||0)+i.price*i.qty;}));
  const catEntries=Object.entries(catRev).sort((a,b)=>b[1]-a[1]);
  const maxCat=catEntries[0]?.[1]||1;
  document.getElementById('categoryChart').innerHTML=catEntries.map(([cat,rev])=>`
    <div style="margin-bottom:12px;cursor:pointer;padding:6px;border-radius:6px;transition:background .2s;" onclick="filterSalesByCat('${cat}')" title="Click to view ${cat} sales">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span>${cat}</span><span style="color:var(--accent);">₹${fmt(rev)} ↗</span></div>
      <div class="stock-bar" style="height:6px;"><div class="stock-fill" style="width:${(rev/maxCat*100)}%;background:var(--accent2)"></div></div>
    </div>`).join('');
  const prodSales={};
  filteredSales.forEach(s=>s.items.forEach(i=>{prodSales[i.name]=(prodSales[i.name]||0)+i.qty;}));
  if(_defaults.showUnsold){
    products.forEach(p=>{if(!(p.name in prodSales)) prodSales[p.name]=0;});
  }
  const allProdEntries=Object.entries(prodSales).sort((a,b)=>b[1]-a[1]);
  const top=allProdEntries.slice(0,5);
  const bottom=allProdEntries.slice(-5).reverse();
  document.getElementById('topProducts').innerHTML=top.map(([name,qty],idx)=>`
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--td-border);cursor:pointer;transition:opacity .2s;" onclick="showProductSalesDetail('${name}')" title="Click for details">
      <span style="font-family:var(--font-head);font-size:18px;color:var(--muted);min-width:24px;">${idx+1}</span>
      <div style="flex:1;font-size:13px;">${name}</div>
      <span class="badge badge-green">${qty} sold ↗</span>
    </div>`).join('');
  // Lowest selling products
  const bottomEl=document.getElementById('bottomProducts');
  if(bottomEl) bottomEl.innerHTML=bottom.map(([name,qty],idx)=>{
    const p=products.find(x=>x.name===name);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--td-border);cursor:pointer;transition:opacity .2s;" onclick="showProductSalesDetail('${name.replace(/'/g,"\\'")}')" title="Click for details">
      <span style="font-family:var(--font-head);font-size:18px;color:var(--red);min-width:24px;">↓</span>
      <div style="flex:1;font-size:13px;">${name}${p&&p.purchasePrice?` <span style="font-size:10px;color:var(--muted);">PC:₹${fmt(p.purchasePrice)}</span>`:''}${p&&p.lastPurchaseDate?` <span style="font-size:10px;color:var(--muted);">🛒${p.lastPurchaseDate.slice(0,10)}</span>`:''}</div>
      <span class="badge badge-red">${qty} sold</span>
    </div>`;
  }).join('');
  const methods={};
  filteredSales.forEach(s=>{methods[s.method]=(methods[s.method]||0)+1;});
  const total=filteredSales.length||1;
  document.getElementById('paymentBreakdown').innerHTML=Object.entries(methods).map(([m,c])=>`
    <div style="text-align:center;cursor:pointer;" onclick="filterSalesByMethod('${m}')" title="Click to view ${m} sales">
      <div style="font-size:28px;font-family:var(--font-head);font-weight:800;color:${m==='Cash'?'var(--green)':m==='UPI'?'var(--accent)':m==='Udhaar'?'var(--red)':'var(--accent2)'};">${c}</div>
      <div style="font-size:12px;color:var(--muted);">${m}</div>
      <div style="font-size:11px;color:var(--muted);">${(c/total*100).toFixed(0)}% ↗</div>
    </div>
    <div style="width:1px;background:var(--border);height:50px;"></div>`).join('').replace(/<div style="width:1px[^>]+><\/div>$$/,'');
  renderPriceChangeLog();
}

function renderPriceChangeLog(){
  const wrap = document.getElementById('priceChangeLogWrap');
  if(!wrap) return;
  // Show changes from Inventory History or Dashboard
  const filteredLog = purchasePriceLog.filter(e => e.source === 'Inventory History' || e.source === 'Dashboard');
  const changes = {};
  filteredLog.forEach(e => {
    if(!changes[e.productName]) changes[e.productName] = [];
    changes[e.productName].push(e);
  });
  // For each product, sort by date desc and compute diff
  const rows = [];
  Object.entries(changes).forEach(([name, entries]) => {
    entries.sort((a,b) => b.date.localeCompare(a.date));
    const lastChange = entries[0];
    const prev = entries.length > 1 ? entries[1].purchasePrice : null;
    const diff = prev != null ? lastChange.purchasePrice - prev : 0;
    const direction = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    rows.push({ name, current: lastChange.purchasePrice, previous: prev, diff, direction, date: lastChange.date.slice(0,10), source: lastChange.source || '—', count: entries.length });
  });
  // Sort by date of last change descending
  rows.sort((a,b) => b.date.localeCompare(a.date));
  if(!rows.length){
    wrap.innerHTML = '<div style="color:var(--muted);padding:8px 0;">No purchase price changes recorded yet.</div>';
    return;
  }
  wrap.innerHTML = `
    <div style="max-height:300px;overflow-y:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--surface2);">
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);">Product</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);">Current</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);">Previous</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);">Diff</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);">Date</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);">Source</th>
        </tr></thead>
        <tbody>${rows.map(r => {
          const p = products.find(x => x.name === r.name);
          const emoji = p ? p.emoji : '📦';
          const diffColor = r.diff > 0 ? 'var(--red)' : r.diff < 0 ? 'var(--green)' : 'var(--muted)';
          return `<tr style="border-bottom:1px solid var(--td-border);">
            <td style="padding:6px 8px;">${emoji} ${r.name}</td>
            <td style="padding:6px 8px;font-weight:600;">₹${fmt(r.current)}</td>
            <td style="padding:6px 8px;color:var(--muted);">${r.previous != null ? '₹'+fmt(r.previous) : '—'}</td>
            <td style="padding:6px 8px;font-weight:600;color:${diffColor};">${r.direction} ${r.previous != null ? '₹'+fmt(Math.abs(r.diff)) : '—'}</td>
            <td style="padding:6px 8px;color:var(--muted);">${r.date}</td>
            <td style="padding:6px 8px;"><span class="badge badge-blue">${r.source}</span></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;
  // Notify if there are any changes newer than today
  const todayStr = _localDateStr().slice(0,10);
  const todayChanges = rows.filter(r => r.date === todayStr && r.diff !== 0);
  if(todayChanges.length){
    const up = todayChanges.filter(r => r.diff > 0).length;
    const down = todayChanges.filter(r => r.diff < 0).length;
    let msg = `📊 ${todayChanges.length} purchase price change(s) today`;
    if(up) msg += ` · ${up} ↑`;
    if(down) msg += ` · ${down} ↓`;
    setTimeout(() => notify(msg), 1000);
  }
}

function showAvgSaleBreakdown(){
  const filteredSales = getFilteredSalesForReports();
  if(!filteredSales.length){ notify('No sales data yet','error'); return; }
  const totalRev=calcRevenue(filteredSales, _reportsUdhaarMode);
  const avg=totalRev/filteredSales.length;
  const max=Math.max(...filteredSales.map(s=>s.total));
  const min=Math.min(...filteredSales.map(s=>s.total));
  notify(`Avg: ₹${fmt(avg)} · Max: ₹${fmt(max)} · Min: ₹${fmt(min)} · ${filteredSales.length} sales total`);
}

function filterSalesGstOnly(){
  _salesGstOnly=!_salesGstOnly;
  navigate('sales');
  document.querySelectorAll('.filter-pill').forEach(p=>p.classList.remove('active'));
  const gstPill=document.querySelector('.filter-pill[data-filter="gst"]');
  if(gstPill) gstPill.classList.add('active');
  // Re-activate current date filter pill
  const dateLabels={month:'This Month',week:'This Week',today:'Today',all:'All Time',custom:'Custom'};
  const lbl=dateLabels[_salesFilter];
  if(lbl) document.querySelectorAll('.filter-pill').forEach(p=>{if(p.textContent.trim()===lbl)p.classList.add('active');});
  renderSalesHistory();
  notify(_salesGstOnly?'Showing only GST-paid sales':'Showing all sales');
}
function downloadAllSales(){
  const now=new Date();
  let src=sales;
  if(_salesFilter==='month'){const cutoff=new Date(now.getFullYear(),now.getMonth(),1);src=sales.filter(s=>new Date(s.date)>=cutoff);}
  else if(_salesFilter==='week'){const cutoff=new Date(now);cutoff.setDate(cutoff.getDate()-7);src=sales.filter(s=>new Date(s.date)>=cutoff);}
  else if(_salesFilter==='today'){src=sales.filter(s=>new Date(s.date).toDateString()===now.toDateString());}
  else if(_salesFilter==='custom'){
    const fromVal=document.getElementById('salesFrom')._val||document.getElementById('salesFrom').value;
    const toVal=document.getElementById('salesTo')._val||document.getElementById('salesTo').value;
    if(fromVal){const from=new Date(fromVal+'T00:00:00');src=src.filter(s=>new Date(s.date)>=from);}
    if(toVal){const to=new Date(toVal+'T23:59:59');src=src.filter(s=>new Date(s.date)<=to);}
  }
  if(_salesGstOnly) src=src.filter(s=>s.taxApplied&&s.tax>0);
  if(_salesMethodFilter) src=src.filter(s=>s.method===_salesMethodFilter);
  if(_salesSearchQuery){
    if(_salesSearchMode==='customer') src=src.filter(s=>matchWords((s.customerName||'').toLowerCase(),_salesSearchQuery));
    else src=src.filter(s=>s.items.some(i=>matchWords(i.name.toLowerCase(),_salesSearchQuery)));
  }
  if(!src.length){ notify('No sales to download','error'); return; }
  const asPdf=confirm('Download as PDF? (Click OK for PDF receipts, Cancel for Excel CSV)');
  if(asPdf){
    // PDF — combined receipts
    const receiptsHtml=src.map(s=>{
      const full=buildFullReceiptHTML(s);
      const start=full.indexOf('<div class="page">');
      const end=full.lastIndexOf('</body>');
      return start>=0&&end>start ? full.substring(start,end) : '';
    }).filter(Boolean).join('<div style="page-break-after:always;margin-bottom:0;"></div>');
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sales_${_localDateStr()}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{background:#f3f4f6;font-family:'Courier New',monospace;font-size:14px;padding:20px;}
      .page{max-width:680px;margin:0 auto 20px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);page-break-after:always;}
      .page:last-child{page-break-after:auto;}
      .head{background:#111;color:#fff;padding:28px 30px;text-align:center;}
      .head h1{font-size:26px;font-weight:900;letter-spacing:-0.5px;color:#f0c040;font-family:Georgia,serif;margin-bottom:4px;}
      .head .sub{color:#aaa;font-size:12px;letter-spacing:2px;text-transform:uppercase;}
      .head .dt{color:#ddd;font-size:13px;margin-top:8px;}
      .cust-wrap{padding:14px 24px;background:#f9f9f9;border-bottom:1px solid #eee;text-align:center;}
      .body{padding:0 0 24px;}
      table.items{width:100%;border-collapse:collapse;}
      table.items thead tr{background:#f4f4f4;border-bottom:2px solid #e0e0e0;}
      table.items th{padding:10px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#555;text-align:left;}
      table.items th.r,table.items td.r{text-align:right;}
      table.items th.c,table.items td.c{text-align:center;}
      table.items td{padding:11px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;vertical-align:middle;}
      .totals-section{margin:0 20px;border-top:1.5px dashed #d0d0d0;padding-top:10px;}
      table.totals{width:100%;border-collapse:collapse;}
      table.totals td{padding:5px 10px;font-size:13px;}
      .tl{color:#666;} .tr{text-align:right;font-weight:600;color:#111;}
      .grand-bar{background:#111;border-radius:8px;margin:12px 20px 0;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;}
      .grand-bar .gl{color:#ddd;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
      .grand-bar .gv{color:#f0c040;font-size:22px;font-weight:900;font-family:Georgia,serif;}
      .footer{text-align:center;padding:18px 24px 24px;border-top:1px dashed #e0e0e0;margin-top:14px;}
      .footer .txn{font-size:12px;color:#999;margin-bottom:6px;}
      .footer .thanks{font-size:14px;color:#333;}
    @media print{@page{margin:0;}body{background:#fff;padding:0;}.page{box-shadow:none;border-radius:0;max-width:100%;min-height:auto;overflow:hidden;}.page,.head,.body,.footer,.totals-section,.grand-bar,.cust-wrap,.items{page-break-inside:avoid;}}
    </style></head><body>${receiptsHtml}</body></html>`;
    const blob=new Blob([html],{type:'text/html;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const win=window.open(url,'_blank');
    if(win){
      win.onload = ()=>{
        setTimeout(()=>{
          win.document.title = `Sales_${_localDateStr()}`;
          win.print();
        }, 800);
      };
    }
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    notify(`Printing ${src.length} sale${src.length!==1?'s':''} — save as PDF`);
  } else {
    // Excel — CSV export
    const rows=[['Sale ID','Customer','Phone','Items','Subtotal','GST','Total','Paid','Pending','Method','PayType','Date','TaxApplied','Reference']];
    src.forEach(s=>{
      rows.push([
        s.id, s.customerName||'', s.customerPhone||'',
        s.items.map(i=>`${i.name}×${i.qty}`).join('; '),
        s.sub||0, s.tax||0, s.total||0, s.amtPaid||0, s.pending||0,
        s.method||'', s.payType||'', s.date||'', s.taxApplied?'Yes':'No', s.reference||''
      ]);
    });
    const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=`Sales_${_localDateStr()}.csv`; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(url),60000);
    notify(`Downloaded ${src.length} sale${src.length!==1?'s':''} as Excel CSV`);
  }
}
function downloadSalePDF(sale){
  if(!sale){ notify('No sale selected','error'); return; }
  const html=buildFullReceiptHTML(sale);
  const blob=new Blob([html],{type:'text/html;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const win=window.open(url,'_blank');
  if(win){
    win.onload = ()=>{
      setTimeout(()=>{
        win.document.title = `Bill_${sale.id}`;
        win.print();
      }, 400);
    };
  }
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function deleteSingleSale(id){
  const s=sales.find(x=>x.id===id);
  if(!s){ notify('Sale not found','error'); return; }
  if(s.pending>0&&!confirm(`⚠️ This sale has ₹${fmt(s.pending)} udhaar still pending!\n\nDeleting will keep the udhaar record unchanged.\n\nContinue anyway?`)) return;
  if(!confirm(`Hide sale ${id} from history? Financial records (revenue/profit/udhaar) will be preserved.`)) return;
  s.hidden=true;
  renderSalesHistory();
  saveAllData();
  notify(`Sale ${id} hidden from history`);
}
function deleteSalesByFilter(){
  const now=new Date();
  let src=sales;
  if(_salesFilter==='month'){const cutoff=new Date(now.getFullYear(),now.getMonth(),1);src=sales.filter(s=>new Date(s.date)>=cutoff);}
  else if(_salesFilter==='week'){const cutoff=new Date(now);cutoff.setDate(cutoff.getDate()-7);src=sales.filter(s=>new Date(s.date)>=cutoff);}
  else if(_salesFilter==='today'){src=sales.filter(s=>new Date(s.date).toDateString()===now.toDateString());}
  else if(_salesFilter==='custom'){
    const fromVal=document.getElementById('salesFrom')._val||document.getElementById('salesFrom').value;
    const toVal=document.getElementById('salesTo')._val||document.getElementById('salesTo').value;
    if(fromVal){const from=new Date(fromVal+'T00:00:00');src=src.filter(s=>new Date(s.date)>=from);}
    if(toVal){const to=new Date(toVal+'T23:59:59');src=src.filter(s=>new Date(s.date)<=to);}
  }
  if(_salesGstOnly) src=src.filter(s=>s.taxApplied&&s.tax>0);
  if(_salesSearchQuery){
    if(_salesSearchMode==='customer') src=src.filter(s=>matchWords((s.customerName||'').toLowerCase(),_salesSearchQuery));
    else src=src.filter(s=>s.items.some(i=>matchWords(i.name.toLowerCase(),_salesSearchQuery)));
  }
  if(!src.length){ notify('No sales to delete','error'); return; }
  const pendCount=src.filter(s=>s.pending>0).length;
  let msg=`Hide ${src.length} sale${src.length!==1?'s':''} from history? Financial records preserved.`;
  if(pendCount) msg=`⚠️ ${pendCount} sale${pendCount!==1?'s':''} ha${pendCount===1?'s':'ve'} pending udhaar.\n\n${msg}`;
  if(!confirm(msg)) return;
  src.forEach(s=>{ s.hidden=true; });
  renderSalesHistory();
  saveAllData();
  notify(`Hidden ${src.length} sale${src.length!==1?'s':''} from history`);
}
function filterSalesByCat(cat){
  navigate('sales');
  notify(`Showing sales — filter by category manually (${cat})`);
}
function filterSalesByMethod(method){
  _salesMethodFilter=method;
  _salesFilter='all';
  _salesGstOnly=false;
  document.querySelectorAll('.filter-pill').forEach(p=>p.classList.remove('active'));
  document.getElementById('salesDateRange').style.display='none';
  navigate('sales');
  renderSalesHistory();
  notify(`Showing only ${method} sales`);
}
function showProductSalesDetail(name, dateFrom, dateTo){
  const p=products.find(x=>x.name===name);
  let productSales=sales.filter(s=>s.items.some(i=>i.name===name));
  if(dateFrom) productSales = productSales.filter(s => new Date(s.date) >= new Date(dateFrom + 'T00:00:00'));
  if(dateTo) productSales = productSales.filter(s => new Date(s.date) <= new Date(dateTo + 'T23:59:59'));
  const totalQty=productSales.reduce((a,s)=>a+s.items.filter(i=>i.name===name).reduce((b,i)=>b+i.qty,0),0);
  const totalRev=productSales.reduce((a,s)=>a+s.items.filter(i=>i.name===name).reduce((b,i)=>b+i.price*i.qty,0),0);
  let totalProfit = 0;
  productSales.forEach(s => {
    s.items.forEach(i => {
      if(i.name === name){
        const sp = i.customPrice != null ? i.customPrice : i.price;
        const cp = i.purchasePrice != null ? i.purchasePrice : getPurchasePriceAtDate(i.name, s.date);
        totalProfit += (sp - cp) * i.qty;
      }
    });
  });
  // Build monthly breakdown
  const monthMap={};
  productSales.forEach(s=>{
    const key=new Date(s.date).toLocaleString('en-IN',{month:'short',year:'numeric'});
    if(!monthMap[key]) monthMap[key]={qty:0,rev:0,profit:0};
    s.items.filter(i=>i.name===name).forEach(i=>{
      const sp = i.customPrice != null ? i.customPrice : i.price;
      const cp = i.purchasePrice != null ? i.purchasePrice : getPurchasePriceAtDate(i.name, s.date);
      monthMap[key].qty+=i.qty;
      monthMap[key].rev+=i.price*i.qty;
      monthMap[key].profit += (sp - cp) * i.qty;
    });
  });
  const months=Object.entries(monthMap).sort((a,b)=>new Date('1 '+b[0])-new Date('1 '+a[0]));
  const maxQty=Math.max(...months.map(([,v])=>v.qty),1);
  const bestMonth=months[0];
  const worstMonth=months[months.length-1];
  // Recent transactions
  const recentTxns=productSales.slice(-5).reverse();
  // Product info
  const purchasePrice=p?p.purchasePrice:0;
  const lastPurchaseDate=p?.lastPurchaseDate||'';
  const daysSincePurchase=lastPurchaseDate?Math.floor((Date.now()-new Date(lastPurchaseDate).getTime())/86400000):null;
  // Last sale
  const lastSale=productSales.length?productSales.sort((a,b)=>new Date(b.date)-new Date(a.date))[0]:null;
  const daysSinceSale=lastSale?Math.floor((Date.now()-new Date(lastSale.date).getTime())/86400000):null;
  const profitPerUnit=p&&p.price?Math.max(0,p.price-p.purchasePrice):0;
  const margin=p&&p.price>0?(profitPerUnit/p.price*100).toFixed(1):0;
  // Inventory update timeline
  const invEntries = p ? inventoryHistory.filter(entry => entry.items.some(item => item.productId === p.id || item.productName === name)) : [];
  // Date filter HTML
  const dfVal = dateFrom || ''; const dtVal = dateTo || '';
  const dateFilterHtml = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
      <input type="text" id="psdFrom" data-calendar value="${dfVal}" readonly placeholder="From..." style="flex:1;min-width:120px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);font-size:12px;color:var(--text);cursor:pointer;">
      <span style="color:var(--muted);font-size:12px;">→</span>
      <input type="text" id="psdTo" data-calendar value="${dtVal}" readonly placeholder="To..." style="flex:1;min-width:120px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface1);font-size:12px;color:var(--text);cursor:pointer;">
      <button class="btn btn-primary btn-sm" onclick="var n='${name.replace(/'/g,"\\'")}';showProductSalesDetail(n,document.getElementById('psdFrom')._val||'',document.getElementById('psdTo')._val||'')">Filter</button>
      ${(dfVal||dtVal)?`<button class="btn btn-ghost btn-sm" onclick="showProductSalesDetail('${name.replace(/'/g,"\\'")}')">✕ Clear</button>`:''}
      <span style="margin-left:auto;font-size:11px;color:var(--muted);">${productSales.length} transaction${productSales.length!==1?'s':''}</span>
    </div>`;
  const html=`<div style="padding:4px 0;">
    ${dateFilterHtml}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">
      <div style="text-align:center;padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">SOLD</div>
        <div style="font-size:18px;font-weight:700;color:var(--green);">${totalQty}</div>
        <div style="font-size:10px;color:var(--muted);">pieces</div>
      </div>
      <div style="text-align:center;padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">REVENUE</div>
        <div style="font-size:18px;font-weight:700;color:var(--accent);">₹${fmt(totalRev)}</div>
      </div>
      <div style="text-align:center;padding:10px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">PROFIT</div>
        <div style="font-size:18px;font-weight:700;color:var(--green);">₹${fmt(totalProfit)}</div>
        <div style="font-size:10px;color:var(--muted);">${totalRev>0?'margin: '+(totalProfit/totalRev*100).toFixed(1)+'%':''}</div>
      </div>
      <div style="text-align:center;padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">TRANSACTIONS</div>
        <div style="font-size:18px;font-weight:700;">${productSales.length}</div>
      </div>
    </div>
    ${p?`<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px;padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">
      <div><span style="font-size:10px;color:var(--muted);">Selling Price</span><div style="font-size:16px;font-weight:700;color:var(--green);">₹${fmt(p.price)}</div></div>
      <div><span style="font-size:10px;color:var(--muted);">Purchase Price</span><div style="font-size:16px;font-weight:700;color:var(--red);">₹${fmt(purchasePrice)}</div></div>
      <div><span style="font-size:10px;color:var(--muted);">Profit per Unit</span><div style="font-size:16px;font-weight:700;color:${profitPerUnit>0?'var(--green)':'var(--muted)'};">₹${fmt(profitPerUnit)} (${margin}%)</div></div>
      <div><span style="font-size:10px;color:var(--muted);">Current Stock</span><div style="font-size:16px;font-weight:700;">${p.stock} pcs</div></div>
      <div><span style="font-size:10px;color:var(--muted);">Last Purchased</span><div style="font-size:14px;font-weight:600;color:${daysSincePurchase!==null&&daysSincePurchase>90?'var(--red)':'var(--text)'};">${lastPurchaseDate?lastPurchaseDate.slice(0,10):'N/A'}${daysSincePurchase!==null?` <span style="font-size:11px;color:var(--muted);font-weight:400;">(${daysSincePurchase}d ago)</span>`:''}</div></div>
      <div><span style="font-size:10px;color:var(--muted);">Last Sale</span><div style="font-size:14px;font-weight:600;color:${daysSinceSale!==null&&daysSinceSale>90?'var(--red)':'var(--text)'};">${lastSale?lastSale.date.slice(0,10):'Never'}${daysSinceSale!==null?` <span style="font-size:11px;color:var(--muted);font-weight:400;">(${daysSinceSale}d ago)</span>`:''}</div></div>
    </div>`:''}
    ${bestMonth?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
      <div style="padding:10px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">🔥 BEST PERIOD</div>
        <div style="font-weight:600;color:var(--green);">${bestMonth[0]}</div>
        <div style="font-size:12px;color:var(--muted);">${bestMonth[1].qty} pcs · ₹${fmt(bestMonth[1].profit)} profit</div>
      </div>
      <div style="padding:10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">📉 SLOWEST PERIOD</div>
        <div style="font-weight:600;color:var(--red);">${worstMonth[0]}</div>
        <div style="font-size:12px;color:var(--muted);">${worstMonth[1].qty} pcs · ₹${fmt(worstMonth[1].profit)} profit</div>
      </div>
    </div>`:''}
    ${months.length>0?`<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Sales by Month</div>
    ${months.slice(0,12).map(([month,v])=>`<div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span>${month}</span><span style="color:var(--accent);">${v.qty} pcs · Rev:₹${fmt(v.rev)} · Profit:₹${fmt(v.profit)}</span></div>
      <div class="stock-bar" style="height:5px;"><div class="stock-fill" style="width:${(v.qty/maxQty*100).toFixed(0)}%;background:var(--accent2);"></div></div>
    </div>`).join('')}`:''}
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:12px;margin-bottom:8px;">Recent Transactions</div>
    ${recentTxns.map(s=>{
      const lineItem = s.items.find(i=>i.name===name);
      const sp = lineItem && lineItem.customPrice != null ? lineItem.customPrice : (lineItem ? lineItem.price : 0);
      const changedPrice = lineItem && lineItem.customPrice != null && lineItem.customPrice !== lineItem.originalPrice;
      return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px solid var(--td-border);cursor:pointer;" onclick="showReceipt(sales.find(x=>x.id==='${s.id}'))">
      <span><span class="badge badge-blue">${s.id}</span> ${s.customerName||'Walk-in'}${changedPrice?` <span style="font-size:10px;color:#d97706;">✏️ ₹${fmt(sp)}/pc</span>`:''}</span>
      <span style="color:var(--muted);">${lineItem?lineItem.qty:0} pcs · ${new Date(s.date).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>
    </div>`;
    }).join('')}
    ${invEntries.length>0?`
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:14px;margin-bottom:8px;">📦 Stock Update History</div>
    ${invEntries.slice().reverse().map(entry => {
      const item = entry.items.find(i => i.productId === p.id || i.productName === name);
      const exists=inventoryHistory.some(e=>e.id===entry.id);
      const tc=entry.transportCost??entry.transport??0;
      const sb=entry.supplierBill||0;
      const extras=[tc>0?'🚚 ₹'+fmt(tc):'',sb>0?'🧾 ₹'+fmt(sb):''].filter(Boolean).join(' · ');
      return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid var(--td-border);">
        <span>${exists?`<span class="badge badge-green" style="cursor:pointer;" onclick="scrollToInvEntry('${entry.id}')">${entry.id}</span>`:`<span class="badge" style="background:var(--surface2);color:var(--muted);text-decoration:line-through;">${entry.id}</span>`} ${entry.supplier||'—'}${extras?` <span style="font-size:11px;color:var(--muted);">${extras}</span>`:''}</span>
        <span style="color:var(--muted);display:flex;align-items:center;gap:4px;">+${item?item.totalPcs:0} pcs · ${entry.date.slice(0,10)}${!exists?` <span style="font-size:10px;color:var(--red);">(deleted)</span>`:''}</span>
      </div>`;
    }).join('')}
    `:''}
  </div>`;
  document.getElementById('prodDetailTitle').textContent = `📊 ${name}`;
  document.getElementById('prodDetailContent').innerHTML = html;
  document.querySelectorAll('#prodDetailContent input[data-calendar]').forEach(el => calBind(el));
  document.getElementById('prodDetailModal').classList.add('open');
}

function filterProductLookup(v){
  const list = document.getElementById('productLookupAcList');
  if(!v.trim()){ list.style.display='none'; return; }
  const q = v.toLowerCase();
  const matches = products.filter(p=>matchWords(p.name,q)).slice(0,8);
  if(!matches.length){ list.style.display='none'; return; }
  list.innerHTML = matches.map(p=>`<div class="autocomplete-item" onmousedown="event.preventDefault();document.getElementById('productLookupSearch').value='${p.name.replace(/'/g,"\\'")}';document.getElementById('productLookupAcList').style.display='none';showProductSalesDetail('${p.name.replace(/'/g,"\\'")}');">
    <span class="ai-icon">${p.image?`<img src="${p.image}" style="width:22px;height:22px;object-fit:cover;border-radius:4px;vertical-align:middle;">`:p.emoji}</span>
    <span class="ai-name">${hlStr(p.name,q)}</span>
    <span class="ai-sub">${getCatName(p.catId)}</span>
  </div>`).join('');
  list.style.display = 'block';
}

function filterPurchasePriceProduct(v){
  const list = document.getElementById('purchasePriceAcList');
  if(!list) return;
  if(!v.trim()){ list.style.display='none'; return; }
  const q = v.toLowerCase();
  const matches = products.filter(p=>matchWords(p.name,q)).slice(0,8);
  if(!matches.length){ list.style.display='none'; return; }
  list.innerHTML = matches.map(p=>`<div class="autocomplete-item" onmousedown="event.preventDefault();document.getElementById('purchasePriceSearch').value='${p.name.replace(/'/g,"\\'")}';document.getElementById('purchasePriceAcList').style.display='none';showPurchasePriceHistory('${p.name.replace(/'/g,"\\'")}');">
    <span class="ai-icon">${p.image?`<img src="${p.image}" style="width:22px;height:22px;object-fit:cover;border-radius:4px;vertical-align:middle;">`:p.emoji}</span>
    <span class="ai-name">${hlStr(p.name,q)}</span>
    <span class="ai-sub">${getCatName(p.catId)}</span>
  </div>`).join('');
  list.style.display = 'block';
}

function showPurchasePriceHistory(name){
  const p = products.find(x => x.name === name);
  if(!p){ notify('Product not found','error'); return; }
  // Gather purchase price changes from inventory history entries
  const entries = [];
  inventoryHistory.forEach(entry => {
    entry.items.forEach(item => {
      if(item.productName === name || (p && item.productId === p.id)){
        entries.push({
          date: entry.date.slice(0,10),
          purchasePrice: item.purchasePrice || 0,
          supplier: entry.supplier || '—',
          source: 'Inventory History'
        });
      }
    });
  });
  // Include purchasePriceLog entries (direct price changes)
  purchasePriceLog.forEach(e => {
    if(e.productName === name){
      entries.push({
        date: e.date.slice(0,10),
        purchasePrice: e.purchasePrice,
        supplier: '—',
        source: e.purchasePrice === p.purchasePrice ? 'Current Price' : (e.source||'Price Update')
      });
    }
  });
  // Sort by date descending
  entries.sort((a,b) => b.date.localeCompare(a.date));
  const wrap = document.getElementById('purchasePriceHistoryWrap');
  if(!entries.length){
    wrap.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:10px 0;">No purchase price history found for "${name}"</div>`;
    return;
  }
  wrap.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:10px;">${p.emoji} ${name} — Purchase Price History</div>
    <table style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead><tr style="background:var(--surface2);">
        <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);">Date</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);">Purchase Price</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);">Supplier</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);">Source</th>
      </tr></thead>
      <tbody>${entries.map(e => `
        <tr style="border-bottom:1px solid var(--td-border);">
          <td style="padding:8px 10px;">${e.date}</td>
          <td style="padding:8px 10px;font-weight:600;color:var(--accent);">₹${fmt(e.purchasePrice)}</td>
          <td style="padding:8px 10px;color:var(--muted);">${e.supplier}</td>
          <td style="padding:8px 10px;"><span class="badge badge-blue">${e.source}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── MODAL UTILS ───────────────────────────────────────────────────────────────
function closeModal(id){ document.getElementById(id).classList.remove('open'); enhanceSelects(); }
document.querySelectorAll('.modal-bg').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open');}));

// ── UDHAAR REMINDER SYSTEM ────────────────────────────────────────────────────
// Intervals stored in minutes. Presets:
const REMINDER_PRESETS=[
  {label:'30 min', min:30},
  {label:'1 hour', min:60},
  {label:'2 hours', min:120},
  {label:'6 hours', min:360},
  {label:'12 hours', min:720},
  {label:'1 day', min:1440},
  {label:'3 days', min:4320},
  {label:'5 days', min:7200},
  {label:'7 days', min:10080},
  {label:'10 days', min:14400},
  {label:'15 days', min:21600},
  {label:'30 days', min:43200},
];

function _loadReminderState(){
  try{
    const v=JSON.parse(localStorage.getItem('shopOS_reminderIntervals'));
    const OLD_DEFAULT=[7200,14400,21600,43200];
    // Ignore the old auto-enabled defaults; only load if the user actually picked intervals.
    if(v&&Array.isArray(v)&&v.length && JSON.stringify(v)!==JSON.stringify(OLD_DEFAULT)) _udhaarReminderIntervals=v;
  }catch(e){}
  try{
    const v=JSON.parse(localStorage.getItem('shopOS_fixedReminders'));
    if(v&&Array.isArray(v)) _udhaarFixedReminders=v;
  }catch(e){}
  try{
    const v=JSON.parse(localStorage.getItem('shopOS_udhaarIntFired'));
    if(v&&typeof v==='object') _udhaarIntFired=v;
  }catch(e){}
  try{
    const v=JSON.parse(localStorage.getItem('shopOS_udhaarIntSetAt'));
    if(v&&typeof v==='object') _udhaarIntSetAt=v;
  }catch(e){}
}
function _saveReminderState(){
  localStorage.setItem('shopOS_reminderIntervals',JSON.stringify(_udhaarReminderIntervals));
  localStorage.setItem('shopOS_fixedReminders',JSON.stringify(_udhaarFixedReminders));
  localStorage.setItem('shopOS_udhaarIntFired',JSON.stringify(_udhaarIntFired));
  localStorage.setItem('shopOS_udhaarIntSetAt',JSON.stringify(_udhaarIntSetAt));
}
let _udhaarReminderIntervals=[]; // default: none set; user adds manually
let _udhaarFixedReminders=[]; // [{id, custName, date, note, fired}]
let _udhaarIntFired={}; // key: recId|intervalMin -> true (reminded once)
let _udhaarIntSetAt={}; // min -> timestamp when this interval was turned ON (countdown starts now)
_loadReminderState();

function fmtInterval(min){
  if(min<60) return min+' min'+(min===1?'':'s');
  if(min<1440) return (min/60)+' hour'+(min/60===1?'':'s');
  const d=min/1440;
  return d+' day'+(d===1?'':'s');
}

function openUdhaarReminderSettings(){
  renderReminderOptions();
  renderActiveReminders();
  renderFixedReminders();
  renderExistingReminders();
  document.getElementById('customReminderVal').value='';
  document.getElementById('udhaarReminderModal').classList.add('open');
}

function renderExistingReminders(){
  const wrap=document.getElementById('remExistingList');
  if(!wrap) return;
  if(!_udhaarFixedReminders.length){ wrap.innerHTML=''; return; }
  const groups={};
  _udhaarFixedReminders.forEach(r=>{
    const k=(r.custName||'').toLowerCase();
    if(!groups[k]) groups[k]={name:r.custName, list:[]};
    groups[k].list.push(r);
  });
  const names=Object.keys(groups);
  wrap.innerHTML=`
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Existing Customer Reminders</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${names.map(k=>{
        const g=groups[k];
        const up=up(g.name);
        return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:12px;">
          <div style="font-weight:700;">👤 ${escapeHtml(g.name)}</div>
          ${g.list.map(r=>{
            const d=new Date(r.date);
            return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-top:3px;">
              <span>⏰ ${d.toLocaleDateString('en-IN')} ${d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})}${r.note?` · ${r.note}`:''}</span>
              <button class="btn btn-ghost btn-sm" style="padding:0 6px;font-size:10px;" onclick="openFixedRemFor('${String(g.name).replace(/'/g,"\\'")}')">➕ Add more</button>
            </div>`;
          }).join('')}
        </div>`;
      }).join('')}
    </div>`;
}

function openFixedRemFor(name){
  document.getElementById('fixRemCustText').value=name;
}

function renderReminderOptions(){
  const wrap=document.getElementById('reminderOptions');
  if(!wrap) return;
  wrap.innerHTML=REMINDER_PRESETS.map(r=>{
    const active=_udhaarReminderIntervals.includes(r.min);
    return `<button class="btn ${active?'btn-primary':'btn-ghost'} btn-sm"
      style="width:100%;justify-content:center;${active?'':'opacity:.7;'}"
      onclick="toggleReminderPreset(${r.min})" id="rPreset_${r.min}">
      ${active?'✓ ':''}${r.label}
    </button>`;
  }).join('');
}

function _clearIntFiredFor(min){
  // Clear previously-fired flags for this interval so a newly set reminder fires fresh
  const suf='|'+min;
  Object.keys(_udhaarIntFired).forEach(k=>{ if(k.endsWith(suf)) delete _udhaarIntFired[k]; });
}

function toggleReminderPreset(min){
  const idx=_udhaarReminderIntervals.indexOf(min);
  if(idx>=0) _udhaarReminderIntervals.splice(idx,1);
  else { _udhaarReminderIntervals.push(min); _udhaarIntSetAt[min]=Date.now(); _clearIntFiredFor(min); }
  _udhaarReminderIntervals.sort((a,b)=>a-b);
  if(!_udhaarReminderIntervals.includes(min)){ delete _udhaarIntSetAt[min]; }
  _saveReminderState();
  renderReminderOptions();
  renderActiveReminders();
  renderUdhaar();
}

function addCustomReminder(){
  const val=parseInt(document.getElementById('customReminderVal').value)||0;
  const unit=document.getElementById('customReminderUnit').value;
  let min=val;
  if(unit==='hours') min=val*60;
  else if(unit==='days') min=val*1440;
  if(min<1||min>129600){ notify('Enter a valid value (1 min to 90 days)','error'); return; }
  if(!_udhaarReminderIntervals.includes(min)){
    _udhaarReminderIntervals.push(min);
    _udhaarReminderIntervals.sort((a,b)=>a-b);
    _udhaarIntSetAt[min]=Date.now();
    _clearIntFiredFor(min);
  }
  _saveReminderState();
  document.getElementById('customReminderVal').value='';
  renderReminderOptions();
  renderActiveReminders();
  renderUdhaar();
}

function removeReminderInterval(min){
  _udhaarReminderIntervals=_udhaarReminderIntervals.filter(m=>m!==min);
  delete _udhaarIntSetAt[min];
  _saveReminderState();
  renderReminderOptions();
  renderActiveReminders();
  renderUdhaar();
}

function renderActiveReminders(){
  const wrap=document.getElementById('activeRemindersWrap');
  if(!wrap) return;
  if(!_udhaarReminderIntervals.length && !_udhaarFixedReminders.length){
    wrap.innerHTML='<div style="font-size:12px;color:var(--muted);padding:8px 0;">No reminders set.</div>';
    return;
  }
  let html='';
  if(_udhaarReminderIntervals.length){
    html+=`<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Active Interval Reminders</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
      ${_udhaarReminderIntervals.map(m=>`
        <div style="display:flex;align-items:center;gap:6px;background:rgba(64,200,240,.1);border:1px solid rgba(64,200,240,.25);border-radius:20px;padding:4px 12px;font-size:12px;color:var(--accent2);">
          ⏰ ${fmtInterval(m)}
          <button onclick="removeReminderInterval(${m})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;line-height:1;" title="Remove">×</button>
        </div>`).join('')}
    </div>`;
  }
  wrap.innerHTML=html;
}

function getFixRemCustItems(q){
  const s=new Set();
  udhaarRecords.filter(r=>r.totalPending>0||(r.credit||0)>0).forEach(r=>s.add(r.name));
  sales.forEach(r=>{const n=r.customerName||'Walk-in';if(n) s.add(n);});
  return [...s].filter(n=>!q||matchWords(n,q.toLowerCase())).slice(0,10).map(n=>{
    const hasRem = _udhaarFixedReminders.some(r => (r.custName||'').toLowerCase() === n.toLowerCase());
    return { icon:'👤', main:n, sub: hasRem ? '⏰ has reminder' : '', display:n, value:n };
  });
}

function addFixedReminder(){
  const name = up(document.getElementById('fixRemCustText').value);
  const dt = calGetDt('fixRemDate','fixRemTime');
  const note = document.getElementById('fixRemNote').value.trim();
  if(!name){ notify('Enter customer name','error'); return; }
  if(!dt){ notify('Select date & time','error'); return; }
  const date = new Date(dt);
  if(date <= new Date()){ notify('Date & time must be in the future','error'); return; }
  _udhaarFixedReminders.push({id:'FR-'+Date.now(), custName:name, date:date.toISOString(), note, fired:false});
  document.getElementById('fixRemCustText').value='';
  const fd=document.getElementById('fixRemDate'); if(fd){ fd._val=''; fd.value=''; }
  document.getElementById('fixRemTime').value='';
  document.getElementById('fixRemNote').value='';
  _saveReminderState();
  notify(`✓ Fixed reminder added for ${name} on ${date.toLocaleString('en-IN')}`);
  renderFixedReminders();
  renderActiveReminders();
  renderUdhaar();
}

function renderFixedReminders(){
  const wrap=document.getElementById('fixedRemindersWrap');
  if(!wrap) return;
  if(!_udhaarFixedReminders.length){
    wrap.innerHTML='';
    return;
  }
  wrap.innerHTML=`
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Fixed Date Reminders</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;">
      ${_udhaarFixedReminders.map((r,i) => {
        const d=new Date(r.date);
        return `<div style="display:flex;align-items:center;gap:6px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:20px;padding:4px 12px;font-size:12px;color:var(--red);${r.fired?'opacity:.4;':''}">
          📅 ${r.custName} — ${d.toLocaleDateString('en-IN')} ${d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})}${r.note?` · ${r.note}`:''}${r.fired?' ✅ Done':''}
          <button onclick="removeFixedReminder(${i})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;line-height:1;" title="Remove">×</button>
        </div>`;
      }).join('')}
    </div>`;
}

function removeFixedReminder(idx){
  _udhaarFixedReminders.splice(idx,1);
  _saveReminderState();
  renderFixedReminders();
  renderActiveReminders();
  renderUdhaar();
}

function saveReminderSettings(){
  _saveReminderState();
  closeModal('udhaarReminderModal');
  checkAndFireUdhaarReminders();
  renderUdhaar();
  updateReminderCount();
  notify(`Reminder settings saved! Checking ${_udhaarReminderIntervals.length} interval${_udhaarReminderIntervals.length!==1?'s':''} and ${_udhaarFixedReminders.length} fixed reminder${_udhaarFixedReminders.length!==1?'s':''}...`);
}

function sendReminderLedgerToWhatsApp(custName, phone){
  // Find udhaar record to get accurate total/phone
  const ud = udhaarRecords.find(r => r.name.toLowerCase() === custName.toLowerCase());
  const displayName = ud ? ud.name : custName;
  const contactPhone = phone || (ud ? ud.phone : '');
  // Build ledger summary from customerLedgers
  const ledger = customerLedgers.find(l => l.customerName.toLowerCase() === custName.toLowerCase());
  let msg = `🏪 *ShopOS Store — ${displayName}'s Ledger*\n━━━━━━━━━━━━━━━━━━\n`;
  if(ud){
    msg += `💰 *Total Billed:* ₹${fmt(ud.totalBill)}\n`;
    msg += `✅ *Total Paid:* ₹${fmt(ud.totalPaid)}\n`;
    msg += `⚠️ *Pending:* ₹${fmt(ud.totalPending)}\n`;
    if(ud.credit>0) msg += `💳 *Credit:* ₹${fmt(ud.credit)}\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
  }
  if(ledger && ledger.entries.length){
    const last10 = ledger.entries.slice(-10);
    msg += `📋 *Recent Transactions:*\n`;
    last10.forEach(e => {
      const d = (e.date||'').slice(0,10);
      const desc = e.description || '';
      const debitStr = e.debit>0 ? ` Dr ₹${fmt(e.debit)}` : '';
      const creditStr = e.credit>0 ? ` Cr ₹${fmt(e.credit)}` : '';
      msg += `• ${d} ${desc}${debitStr}${creditStr} [Bal: ₹${fmt(e.balance)}]\n`;
    });
  } else {
    msg += `📋 No ledger entries found.\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━\n📎 _ShopOS — Automated Ledger Report_`;
  // Open WhatsApp
  const cleanPhone = contactPhone.replace(/\D/g,'');
  let waUrl;
  if(cleanPhone && /^[6-9]\d{9}$/.test(cleanPhone)){
    waUrl = `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(msg)}`;
  } else if(cleanPhone && cleanPhone.length >= 10){
    waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
  } else {
    waUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  }
  window.open(waUrl, '_blank');
}

let _reminderQueue=[];
let _reminderSnoozeTimers=[];
function showReminderPopup(title, body, icon='⏰', snoozeMin=5, customerName='', customerPhone=''){
  // Don't add duplicate if same title+body already in queue
  const dup = _reminderQueue.some(r => r.title===title && r.body===body);
  if(!dup) _reminderQueue.push({title, body, icon, snoozeMin, customerName, customerPhone});
  if(_reminderQueue.length===1) _processReminderQueue();
}
function _processReminderQueue(){
  if(!_reminderQueue.length) return;
  const r=_reminderQueue[0];
  document.getElementById('reminderPopupIcon').textContent=r.icon;
  document.getElementById('reminderPopupTitle').textContent=r.title;
  document.getElementById('reminderPopupBody').innerHTML=r.body;
  document.getElementById('reminderSnoozeBtn').textContent='🔔 Remind in '+r.snoozeMin+' min';
  // Show WhatsApp button if customer info is present
  const actionsEl = document.getElementById('reminderPopupActions');
  if(r.customerName){
    const safeName = r.customerName.replace(/'/g,"\\'");
    const safePhone = (r.customerPhone||'').replace(/'/g,"\\'");
    actionsEl.innerHTML = `
      <button class="btn btn-ghost" onclick="closeReminderPopup()" style="min-width:100px;">Dismiss</button>
      <button class="btn btn-sm" onclick="closeReminderPopup();sendReminderLedgerToWhatsApp('${safeName}','${safePhone}')" style="min-width:130px;background:var(--green);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;">📤 Ledger on WhatsApp</button>
      <button class="btn btn-primary" id="reminderSnoozeBtn" onclick="snoozeReminder()" style="min-width:120px;">🔔 Remind in ${r.snoozeMin} min</button>
    `;
  } else {
    actionsEl.innerHTML = `
      <button class="btn btn-ghost" onclick="closeReminderPopup()" style="min-width:100px;">Dismiss</button>
      <button class="btn btn-primary" id="reminderSnoozeBtn" onclick="snoozeReminder()" style="min-width:120px;">🔔 Remind in ${r.snoozeMin} min</button>
    `;
  }
  document.getElementById('reminderPopupModal').classList.add('open');
}
function closeReminderPopup(){
  // Dismissing / viewing the popup = user has seen it, so complete the bell reminder too
  try{
    const r=_reminderQueue[0];
    if(r&&r.customerName){
      const udRec=udhaarRecords.find(u=>up(u.name)===up(r.customerName));
      if(udRec) markBellDismissed('udhaar', udRec.id);
      const adRec=advanceOrders.find(o=>up(o.custName)===up(r.customerName));
      if(adRec) markBellDismissed('advance', adRec.id);
    }
  }catch(e){}
  document.getElementById('reminderPopupModal').classList.remove('open');
  _reminderQueue.shift();
  setTimeout(_processReminderQueue, 300);
  setTimeout(updateReminderCount, 350);
}
function snoozeReminder(){
  const r=_reminderQueue[0];
  if(!r) return;
  // Just dismiss popup without shifting queue — re-set timeout for same item
  document.getElementById('reminderPopupModal').classList.remove('open');
  const timer = setTimeout(()=>{
    // Re-show the same reminder
    document.getElementById('reminderPopupIcon').textContent=r.icon;
    document.getElementById('reminderPopupTitle').textContent=r.title;
    document.getElementById('reminderPopupBody').innerHTML=r.body;
    document.getElementById('reminderSnoozeBtn').textContent='🔔 Remind in '+r.snoozeMin+' min';
    document.getElementById('reminderPopupModal').classList.add('open');
  }, r.snoozeMin*60*1000);
  _reminderSnoozeTimers.push(timer);
}

function checkAndFireUdhaarReminders(){
  const now=Date.now();
  let reminded=0;
  // Check interval reminders — ONE-SHOT: fires ONCE X days after the reminder was SET (current time),
  // then it's done
  if(_udhaarReminderIntervals.length){
    udhaarRecords.forEach(rec=>{
      if(rec.totalPending<=0) return;
      _udhaarReminderIntervals.forEach((intervalMin)=>{
        let setAt=_udhaarIntSetAt[intervalMin];
        // If active but no persisted start time yet, initialize once (keeps it from drifting on refresh)
        if(!setAt){ setAt=Date.now(); _udhaarIntSetAt[intervalMin]=setAt; _saveReminderState(); }
        const ellapsedMin=Math.floor((now-setAt)/(1000*60));
        if(ellapsedMin>=intervalMin){
          const fk = String(rec.id)+'|'+intervalMin;
          if(_udhaarIntFired[fk]) return; // already reminded once for this interval
          _udhaarIntFired[fk]=true; _saveReminderState();
          if(Object.keys(_udhaarIntFired).length>5000){ _udhaarIntFired={}; _saveReminderState(); }
          const display=intervalMin<1440?fmtInterval(intervalMin):Math.floor(intervalMin/1440)+' day'+(Math.floor(intervalMin/1440)===1?'':'s');
          showReminderPopup(
            '⏰ Udhaar Reminder',
            `<strong>${rec.name}</strong> has <strong>₹${fmt(rec.totalPending)}</strong> pending since ${display}!`,
            '⏰', 5,
            rec.name, rec.phone
          );
          reminded++;
        }
      });
    });
  }
  // Check fixed date reminders
  _udhaarFixedReminders.forEach((r,i)=>{
    if(r.fired) return;
    const d=new Date(r.date);
    if(now >= d.getTime()){
      r.fired=true;
      _saveReminderState();
      setTimeout(()=>{
        const _udRec = udhaarRecords.find(u => u.name.toLowerCase()===r.custName.toLowerCase());
        showReminderPopup(
          '📅 Fixed Reminder',
          `<strong>${r.custName}</strong>${r.note?' — '+r.note:''}`,
          '📅', 5,
          r.custName, _udRec ? _udRec.phone : ''
        );
      }, i*2500);
      reminded++;
    }
  });
  renderFixedReminders();
  // Reminder fired now — update card + bell live (no refresh needed)
  if(reminded>0){ renderUdhaar(); updateReminderCount(); }
}

function scheduleUdhaarReminderCheck(){
  checkAndFireUdhaarReminders();
  setInterval(()=>{
    checkAndFireUdhaarReminders();
    updateReminderCount(); // keep bell/count live without refresh
  }, 30*1000); // check every 30s
  // Also re-check when the tab regains focus (immediate if it was due while away)
  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden){ checkAndFireUdhaarReminders(); updateReminderCount(); }
  });
  window.addEventListener('focus', ()=>{ checkAndFireUdhaarReminders(); updateReminderCount(); });
}

// ── CUSTOMER LEDGER ────────────────────────────────────────────────────────────
function getOrCreateLedger(customerName, phone){
  customerName=up(customerName);
  const key = (customerName||'Walk-in').toLowerCase();
  let ledger = customerLedgers.find(l => l.customerName.toLowerCase() === key);
  if(!ledger){
    ledger = { id: _nextLedgerId++, customerName: customerName||'Walk-in', phone: phone||'', entries: [] };
    customerLedgers.push(ledger);
  } else if(phone && !ledger.phone) {
    ledger.phone = phone;
  }
  return ledger;
}

function addLedgerEntry(customerName, phone, date, description, debit, credit){
  if(!customerName) return;
  const ledger = getOrCreateLedger(customerName, phone);
  const entries = ledger.entries;
  const lastBal = entries.length ? entries[entries.length-1].balance : 0;
  const balance = lastBal + (debit||0) - (credit||0);
  entries.push({ date: date||_localDateStr(), description: description||'', debit: debit||0, credit: credit||0, balance: Math.round(balance*100)/100 });
  saveAllData();
}

// ── DATA SYNC ──────────────────────────────────────────────────────────────────
function mapSale(s){
  const extraUd=Number(s.extra_udhaar_amount||0);
  let actualTotal=s.actual_total!=null?Number(s.actual_total):undefined;
  if(actualTotal==null) actualTotal=Number(s.sub)+Number(s.tax)+extraUd;
  // `intra` used to be recomputed from the location box at billing time only, so a
  // reloaded sale had no supply-type flag and the tax split came back wrong. It is
  // now persisted as sales.is_interstate; derive the flag from whichever is set.
  const interstate = s.is_interstate!=null ? !!s.is_interstate : !!(s.intra===false);
  return { id:s.id, customerName:s.customer_name||'', customerPhone:s.customer_phone||'',
    customerLocation:s.customer_location||'', intra:!interstate, isInterstate:interstate,
    items:s.items||[], sub:Number(s.sub), tax:Number(s.tax), total:Number(s.total),
    method:s.method||'Cash', amtPaid:Number(s.amt_paid), pending:Number(s.pending||0),
    date:s.date, taxApplied:s.tax_applied||false, payType:s.pay_type||'paid',
    change:Number(s.change_return||0), udhaarIncluded:s.udhaar_included||false,
    extraUdhaarAmount:extraUd,
    actualTotal, hidden:!!s.hidden,
    // ── GST document fields (see gst/classify.js normalizeSale) ──
    docType:s.doc_type||'tax_invoice',
    invoiceNo:s.invoice_no||'', invoiceSeries:s.invoice_series||'',
    custGstin:s.cust_gstin||'',
    placeOfSupply:s.place_of_supply||'',
    supplyType:s.supply_type||'domestic',
    docStatus:s.doc_status||'finalised',
    cancelDate:s.cancel_date||null, cancelReason:s.cancel_reason||'',
    reverseCharge:!!s.reverse_charge,
    nilRatedReason:s.nil_rated_reason||'', exemptReason:s.exempt_reason||'',
    nonGstReason:s.non_gst_reason||'',
    linkedInvoiceNo:s.linked_invoice_no||'', linkedInvoiceId:s.linked_invoice_id||'',
    linkedInvoiceDate:s.linked_invoice_date||null,
    noteReason:s.note_reason||'', exportPaymentType:s.export_payment_type||'',
    originalInvoiceNo:s.original_invoice_no||'',
    originalInvoicePeriod:s.original_invoice_period||'',
    amendmentReason:s.amendment_reason||'' };
}
/**
 * Normalise a purchase-register row from the DB into the camelCase shape the rest
 * of the app uses. Without this, /load left these rows snake_case and the
 * full-payload save (which reads camelCase only) wrote 0 into every GST amount on
 * every save — silently wiping supplier GSTIN and the ITC heads.
 */
function mapInventoryHistory(h){
  return {
    id:h.id, date:h.date,
    destination:h.destination||'', parcelCount:Number(h.parcel_count||0),
    supplier:h.supplier||'',
    supplierBill:Number(h.supplier_bill||0), supplierBillPaid:Number(h.supplier_bill_paid||0),
    supplierBillStatus:h.supplier_bill_status||'paid',
    transportProvider:h.transport_provider||'',
    transportCost:Number(h.transport_cost||0), transportPaid:Number(h.transport_paid||0),
    transportStatus:h.transport_status||'paid',
    notes:h.notes||'', items:h.items||[],
    // ── GST purchase fields (see gst/index.js normalisePurchase) ──
    supplierInvoiceNo:h.supplier_invoice_no||'',
    supplierGstin:h.supplier_gstin||'',
    supplierStateCode:h.supplier_state_code||'',
    purchaseInvoiceDate:h.purchase_invoice_date||null,
    purchaseTaxable:Number(h.purchase_taxable||0),
    purchaseCgst:Number(h.purchase_cgst||0),
    purchaseSgst:Number(h.purchase_sgst||0),
    purchaseIgst:Number(h.purchase_igst||0),
    purchaseCess:Number(h.purchase_cess||0),
    isImport:!!h.is_import,
    reverseCharge:!!h.reverse_charge,
    itcEligible:h.itc_eligible!==false,
    ineligibleReason:h.ineligible_reason||'',
    expenseId:h.expense_id||''
  };
}
/**
 * Purchase-side GST capture. The supplier's invoice number is what a 2B row is
 * matched on, so without it the reconciliation tab matched nothing at all and
 * looked like "no ITC available" rather than "no data captured".
 */
function toggleIeGstFields(){
  const box = document.getElementById('ieGstFields');
  const btn = document.getElementById('ieGstToggle');
  if (!box) return;
  const open = box.style.display === 'none';
  box.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? 'Hide' : 'Show';
  if (open) ieRefreshItcHint();
}

function ieValidateSupplierGstin(){
  const el = document.getElementById('ieSupplierGstin');
  const msg = document.getElementById('ieSupplierGstinMsg');
  const v = (el?.value || '').trim().toUpperCase();
  if (!v){ if (msg) msg.textContent = ''; return; }
  if (!gstLoadConfig) return;
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)){
    if (msg){ msg.textContent = '⚠ Does not look like a GSTIN — 2B will not match without it.'; msg.style.color = 'var(--warn,#c47d00)'; }
    return;
  }
  const known = _gstStates[v.slice(0,2)];
  if (msg){
    msg.textContent = known ? `State ${v.slice(0,2)} — ${known}` : `⚠ Unknown state code ${v.slice(0,2)}`;
    msg.style.color = known ? 'var(--muted)' : 'var(--warn,#c47d00)';
  }
}

/** Cross-field check: the heads should add up to what is left after taxable. */
function ieRefreshItcHint(){
  const hint = document.getElementById('ieItcHint');
  if (!hint) return;
  const num = (id) => parseFloat(document.getElementById(id)?.value) || 0;
  const taxable = num('iePurchaseTaxable');
  const heads = num('iePurchaseIgst') + num('iePurchaseCgst') + num('iePurchaseSgst') + num('iePurchaseCess');
  const invNo = (document.getElementById('ieSupplierInvoiceNo')?.value || '').trim();
  const gstin = (document.getElementById('ieSupplierGstin')?.value || '').trim();
  const bits = [];
  if (!invNo) bits.push('⚠ Without the supplier invoice number this purchase cannot be matched to a 2B row, so its ITC stays unclaimed.');
  if (!gstin) bits.push('⚠ Without the supplier GSTIN the same is true.');
  if (taxable > 0 && heads === 0) bits.push('⚠ Taxable value entered but no tax heads — the ITC will show as zero.');
  if (taxable > 0 && heads > 0){
    const rate = (heads / taxable) * 100;
    bits.push(`Effective rate ${rate.toFixed(2)}% · ITC ₹${fmt(heads)}`);
    if (rate > 28.5) bits.push('⚠ Rate looks too high for a GST slab.');
  }
  const rc = document.getElementById('ieReverseCharge')?.checked;
  if (rc) bits.push('Reverse charge: pay the tax yourself — no 2B credit for this entry.');
  const imp = document.getElementById('ieIsImport')?.checked;
  if (imp) bits.push('Import: reported under 4(A)(1)(a), not matched against 2B.');
  const elig = document.getElementById('ieItcEligible')?.checked;
  const reason = (document.getElementById('ieIneligibleReason')?.value || '').trim();
  const wrap = document.getElementById('ieIneligibleWrap');
  if (wrap) wrap.style.display = elig ? 'none' : 'block';
  if (!elig && !reason) bits.push('⚠ ITC marked not claimable but no reason given.');
  hint.innerHTML = bits.length ? bits.map((b) => `<div>${b}</div>`).join('') : '<div style="color:var(--green)">✓ Enough captured to reconcile this purchase against 2B.</div>';
}

/** Reset the purchase GST block whenever the entry modal opens. */
function resetIeGstFields(){
  for (const id of ['ieSupplierGstin','ieSupplierInvoiceNo','iePurchaseInvoiceDate','iePurchaseTaxable',
                    'iePurchaseIgst','iePurchaseCgst','iePurchaseSgst','iePurchaseCess','ieIneligibleReason']){
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  const imp = document.getElementById('ieIsImport'); if (imp) imp.checked = false;
  const rc = document.getElementById('ieReverseCharge'); if (rc) rc.checked = false;
  const el2 = document.getElementById('ieItcEligible'); if (el2) el2.checked = true;
  const msg = document.getElementById('ieSupplierGstinMsg'); if (msg) msg.textContent = '';
  const box = document.getElementById('ieGstFields'); if (box) box.style.display = 'none';
  const btn = document.getElementById('ieGstToggle'); if (btn) btn.textContent = 'Show';
}

function mapAdvance(o){
  return { id:o.id, custName:o.cust_name, phone:o.phone||'', packTime:o.pack_time,
    advPaid:Number(o.adv_paid||0), notes:o.notes||'', items:o.items||[], total:Number(o.total),
    status:o.status||'scheduled', saleId:o.sale_id, transport:o.transport,
    location:o.location||null,
    taxApplied:o.tax_applied||false, transportCost:Number(o.transport_cost||0),
    addlPaid:Number(o.addl_paid||0), bills:o.bills||[] };
}
function mapUdhaar(r){
  return { id:r.id, name:r.name, phone:r.phone||'', reference:r.reference||'',
    bills:r.bills||[], totalBill:Number(r.total_bill), totalPaid:Number(r.total_paid),
    totalPending:Number(r.total_pending), credit:Number(r.credit||0) };
}

async function loadAllData(){
  try {
    const data = await _api('/load');
    if(data.categories) categories = data.categories;
    if(data.products) products = data.products.map(p => ({
      id:p.id, name:p.name, price:Number(p.price), price5:p.price5?Number(p.price5):null, price10:p.price10?Number(p.price10):null, stock:Number(p.stock),
      catId:p.cat_id, emoji:p.emoji, image:p.image||'', description:p.description||'',
      sku:p.sku||'', low:Number(p.low), noOfBoxes:Number(p.no_of_boxes||0),
      noOfPieces:Number(p.no_of_pieces||0), piecesPerBox:Number(p.pieces_per_box||1),
      gst:Number(p.gst||0), hsn:p.hsn||'', location:p.location||'', cess:Number(p.cess||0),
      purchasePrice:Number(p.purchase_price||0), lastPurchaseDate:p.last_purchase_date||'',
      cgst:Number(p.cgst||0), sgst:Number(p.sgst||0), igst:Number(p.igst||0), unit:p.unit||'', weightPerPrice:Number(p.weight_per_price||0)
    }));
    if(data.sales) sales = data.sales.map(mapSale);
    if(data.inventoryHistory) inventoryHistory = data.inventoryHistory.map(mapInventoryHistory);
    if(data.udhaarRecords) udhaarRecords = data.udhaarRecords.map(mapUdhaar);
    if(data.advanceOrders) advanceOrders = data.advanceOrders.map(mapAdvance);
    _custPhoneCache={sig:'',map:null};
    if(data.notes) notes = data.notes;
    if(data.customerLedgers) customerLedgers = data.customerLedgers.map(l => ({
      id:l.id, customerName:l.customer_name||l.customerName, phone:l.phone||'',
      location:l.location||null, entries:l.entries||[]
    }));
    if(data.purchasePriceLog) purchasePriceLog = data.purchasePriceLog;
    if(data.supplierTransportLog) supplierTransportLog = data.supplierTransportLog;
    if(data.expenses) expenses = data.expenses.map(e => ({
      id:e.id, name:e.name||'', amount:Number(e.amount)||0,
      category:e.category||'', notes:e.notes||'', date:e.date, photo:e.photo||''
    }));
    if(data.defaults) _defaults = {..._defaults, ...data.defaults};
    // Initialize purchase price log for any products missing an entry
    products.forEach(p => {
      const hasLog = purchasePriceLog.some(e => e.productName === p.name);
      if(!hasLog && p.purchasePrice > 0){
        purchasePriceLog.push({ productName: p.name, purchasePrice: p.purchasePrice, date: '2000-01-01T00:00:00' });
      }
    });
    const state = await _api('/state');
    if(state.nextIds){
      nextProdId = state.nextIds.nextProdId || 1;
      nextCatId = state.nextIds.nextCatId || 1;
      nextSaleId = state.nextIds.nextSaleId || 1;
      nextInvId = state.nextIds.nextInvId || 1;
      nextAdvId = state.nextIds.nextAdvId || 1;
      _nextNoteId = state.nextIds.nextNoteId || 1;
      _nextLedgerId = state.nextIds.nextLedgerId || 1;
      _nextExpId = state.nextIds.nextExpId || 1;
    }
    await loadQrCodes();
    if(!categories.length || !products.length){
      const lsAcc = getAccounts();
      if(lsAcc.length && !data.categories){
        setTimeout(() => migrateOldData(), 500);
      }
    }
    _dataLoaded = true;
    // Reset the delta baseline so the next save sends only what actually changed
    _syncPending = false; _syncSig = {};
    refreshCategoryDropdowns();
    renderCategories();
    renderInventory();
    renderPOS();
    notify('Data loaded from server ✓');
  } catch(e) {
    console.error('Load error:', e);
    notify('Could not load data from server. Make sure the backend is running.','error');
  }
}

function extractAccountData(acc){
  const data = {};
  if(acc.categories && acc.categories.length) data.categories = acc.categories;
  if(acc.products && acc.products.length) data.products = acc.products;
  if(acc.sales && acc.sales.length) data.sales = acc.sales;
  if(acc.inventoryHistory && acc.inventoryHistory.length) data.inventoryHistory = acc.inventoryHistory;
  if(acc.udhaarRecords && acc.udhaarRecords.length) data.udhaarRecords = acc.udhaarRecords;
  if(acc.advanceOrders && acc.advanceOrders.length) data.advanceOrders = acc.advanceOrders;
  if(acc.purchasePriceLog && acc.purchasePriceLog.length) data.purchasePriceLog = acc.purchasePriceLog;
  return data;
}

async function migrateOldData(){
  const all = getAccounts();
  if(!all.length) return;
  let totalItems = 0;
  const merged = { categories:[], products:[], sales:[], inventoryHistory:[], udhaarRecords:[], advanceOrders:[] };
  all.forEach(a => {
    const d = extractAccountData(a);
    Object.keys(d).forEach(k => { merged[k] = merged[k].concat(d[k]); totalItems += d[k].length; });
  });
  if(!totalItems) return;
  categories   = merged.categories;
  products     = merged.products;
  sales        = merged.sales;
  inventoryHistory = merged.inventoryHistory;
  udhaarRecords    = merged.udhaarRecords;
  advanceOrders    = merged.advanceOrders;
  // Recalculate next IDs from merged data
  if(products.length) nextProdId = Math.max(...products.map(p=>p.id))+1;
  if(categories.length) nextCatId = Math.max(...categories.map(c=>c.id))+1;
  if(sales.length){ const ns=sales.map(s=>parseInt(s.id.replace('TXN-',''))||0); nextSaleId=Math.max(...ns)+1; }
  if(inventoryHistory.length){ const ni=inventoryHistory.map(h=>parseInt(h.id.replace('INV-',''))||0); nextInvId=Math.max(...ni)+1; }
  if(advanceOrders.length){ const na=advanceOrders.map(o=>parseInt(o.id.replace('ADV-',''))||0); nextAdvId=Math.max(...na)+1; }
  saveAllData(true);
  renderCategories();
  renderInventory();
  renderPOS();
  notify(`✅ Migrated ${totalItems} records from localStorage to server!`);
}



// ── EXCEL IMPORT ──────────────────────────────────────────────────────────────
function cleanHeader(h){ return String(h==null?'':h).replace(/^\uFEFF/,'').trim(); }
function normHeader(h){ return cleanHeader(h).toLowerCase().replace(/[^a-z0-9]/g,''); }
function parseNum(v){
  if(v == null || v === '') return NaN;
  if(typeof v === 'number') return isNaN(v) ? NaN : v;
  const m = String(v).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);
  const n = m ? parseFloat(m[0]) : NaN;
  return isNaN(n) ? NaN : n;
}
function parseCount(v){
  if(v == null || v === '') return NaN;
  if(typeof v === 'number') return isNaN(v) ? NaN : v;
  const m = String(v).replace(/,/g,'').match(/-?\d+/);
  return m ? parseInt(m[0],10) : NaN;
}

function gstToPercent(v){
  if(v == null || isNaN(v)) return v;
  if(v > 0 && v < 1) return +(v * 100);
  return v;
}

function pickDataSheet(wb){
  let best = null, bestScore = -1, bestRows = 0;
  for(const sname of wb.SheetNames){
    const sheet = wb.Sheets[sname];
    const rows = XLSX.utils.sheet_to_json(sheet, {defval:'', header:1});
    if(!rows.length) continue;
    let score = 0;
    const first = rows[0] || [];
    for(const h of first){
      const norm = normHeader(h);
      if(!norm) continue;
      for(const field of Object.keys(FIELD_MAP)){
        if(FIELD_MAP[field].some(a => normHeader(a) === norm)){ score++; break; }
      }
    }
    const rc = rows.length;
    if(score > bestScore || (score === bestScore && rc > bestRows)){
      bestScore = score; bestRows = rc;
      best = { sname, rows, sheet, json: XLSX.utils.sheet_to_json(sheet, {defval:''}) };
    }
  }
  return best;
}

const FIELD_MAP = {
  name: ['name','productname','product_name','itemname','item_name','product','item'],
  price: ['price','mrp','rate','sellingprice','selling_price','sale_price','unitprice','priceinr','pricers','saleprice','unitrate','price1pc'],
  price5: ['price5pc','price5','sp5pc','pricefor5pc','pricefor5','spfor5pc','prices5pc'],
  price10: ['price10pc','price10','sp10pc','pricefor10pc','pricefor10','spfor10pc','prices10pc'],
  purchasePrice: ['purchaseprice','purchase_price','buyingprice','buying_price','costprice','cost_price','wholesaleprice','landingcost'],
  sku: ['sku','skucode','sku_code','productcode','product_code','code','partno','barcode','skubarcode','skubarcodeno','skunumber'],
  stock: ['stock','quantity','qty','stockqty','stock_qty','inventory','onhand','available','currentstock'],
  description: ['description','desc','productdescription','product_description','details','notes'],
  gst: ['gst','gstrate','gst_rate','tax','taxrate','tax_rate'],
  cgst: ['cgst','cgstrate','cgst_rate'],
  sgst: ['sgst','sgstrate','sgst_rate'],
  igst: ['igst','igstrate','igst_rate'],
  hsn: ['hsn','hsc','hscode','hsncode','hsn_code','sac','saccode','sac_code','hsnsaccode'],
  location: ['location','loc','shelf','rack','aisle','storagelocation','storage_location','godown','warehouse'],
  cess: ['cess','cessrate','cess_rate','cesspct','cess_percent'],
  low: ['low','lowstock','low_stock','alert','minstock','min_stock','threshold','reorder'],
  piecesPerBox: ['piecesperbox','ppb','unitsperbox','pcsperbox','perbox','pieces_per_box','noofpiecein1box'],
  noOfBoxes: ['noofboxes','boxes','box','boxcount','no_of_boxes','noofbox'],
  noOfPieces: ['noofpieces','pieces','pcs','piece','no_of_pieces','noofpcs'],
  emoji: ['emoji','icon','symbol','imageicon'],
  image: ['image','imageurl','image_url','imagelink','image_link','img','photourl','photo_url','picture'],
  category: ['category','cat','categoryname','category_name','catname','cat_name','group'],
  unit: ['unit','uom','measure','measurement','unitofmeasure','unit_of_measure']
};
const FIELD_LABELS = {
  name: 'Product Name', price: 'Selling Price (1pc)', price5: 'SP for 5pc', price10: 'SP for 10pc', purchasePrice: 'Purchase Price',
  sku: 'SKU / Barcode', stock: 'Stock Qty', description: 'Description',
  gst: 'GST %', cgst: 'CGST %', sgst: 'SGST %', igst: 'IGST %',
  hsn: 'HSN / SAC Code', location: 'Location / Shelf',
  cess: 'Cess %', low: 'Low Stock Alert', piecesPerBox: 'Pieces per Box',
  noOfBoxes: 'No. of Boxes', noOfPieces: 'No. of Pieces',
  emoji: 'Emoji / Icon', image: 'Image URL', category: 'Category', unit: 'Unit'
};
let _importData = null;
let _lastImportSnapshot = null;

function openImportModal(){
  _importData = null;
  // Remove old modal if exists
  const old = document.getElementById('importModal');
  if(old) old.remove();
  // Create modal from scratch
  const overlay = document.createElement('div');
  overlay.id = 'importModal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:999999;display:flex;align-items:center;justify-content:center;';
  
  overlay.innerHTML = `
    <div style="background:var(--surface,#1e1e2e);border:1px solid var(--border,#333);border-radius:16px;padding:28px;width:700px;max-width:92vw;max-height:90vh;overflow-y:auto;">
      <div style="font-family:var(--font-head);font-size:18px;font-weight:700;margin-bottom:20px;">📥 Import Products from Excel</div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">Choose File (.xlsx, .xls, .csv)</label>
        <input type="file" id="importFileInput" accept=".xlsx,.xls,.csv" style="width:100%;padding:8px;border:1px solid var(--border,#333);border-radius:6px;background:var(--surface1,#2a2a3e);">
      </div>
      <div id="importPreview" style="display:none;">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Preview <span id="importRowCount" style="font-weight:400;color:var(--muted,#888);"></span></div>
        <div style="max-height:200px;overflow:auto;border:1px solid var(--border,#333);border-radius:6px;margin-bottom:12px;">
          <table style="width:100%;font-size:12px;border-collapse:collapse;" id="importPreviewTable"></table>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Column Mapping <span style="font-weight:400;color:var(--muted,#888);font-size:12px;">(auto-detected — change if needed)</span></div>
        <div id="importMapping" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;"></div>
        <div style="margin-bottom:16px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px;">For products without SKU <span style="font-weight:400;color:var(--muted);font-size:12px;">(auto-generated)</span></div>
          <div class="sku-gen-seg" role="radiogroup" aria-label="Auto-generate for products without SKU">
            <input type="radio" name="importQrChoice" id="iqc_qr" value="qr" ${localStorage.getItem('_qrAutoGenType')==='qr'||!localStorage.getItem('_qrAutoGenType')?'checked':''}>
            <label class="qr-pill" for="iqc_qr">🔲 Generate QR</label>
            <input type="radio" name="importQrChoice" id="iqc_bc" value="barcode" ${localStorage.getItem('_qrAutoGenType')==='barcode'?'checked':''}>
            <label class="qr-pill" for="iqc_bc">🏷️ Generate Barcode</label>
            <input type="radio" name="importQrChoice" id="iqc_none" value="none" ${localStorage.getItem('_qrAutoGenType')==='none'?'checked':''}>
            <label class="qr-pill" for="iqc_none">❌ Nothing</label>
          </div>
          <input type="checkbox" id="importAutoRemember" class="import-remember-input" ${localStorage.getItem('_qrAutoGen') ? 'checked' : ''}>
          <label class="qr-pill qr-remember-pill" for="importAutoRemember">💾 Remember my choice for 1 day</label>
        </div>
        <div class="modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
          <button class="btn btn-ghost" onclick="closeModal2()" style="padding:8px 16px;border:1px solid var(--border,#333);border-radius:8px;background:transparent;color:var(--text,#ddd);cursor:pointer;">Cancel</button>
          <button class="btn btn-primary" id="importBtn" onclick="importProducts()" style="padding:8px 16px;border:none;border-radius:8px;background:var(--accent,#7c3aed);color:#fff;cursor:pointer;">✓ Import Products</button>
        </div>
      </div>
    </div>
  `;
  
  // Prevent closing when clicking inside the modal content
  overlay.addEventListener('click', function(e) {
    if(e.target === this) this.remove();
  });
  
  document.body.appendChild(overlay);
  
  // Reset and set up
  document.getElementById('importFileInput').value = '';
  document.getElementById('importFileInput').onchange = handleImportFile;
}

function closeModal2(){
  const el = document.getElementById('importModal');
  if(el) el.remove();
}

function handleImportFile(){
  const fileInput = document.getElementById('importFileInput');
  if(!fileInput){ notify('Import file input not found','error'); return; }
  const file = fileInput.files[0];
  if(!file){ notify('No file selected','error'); return; }
  const reader = new FileReader();
  reader.onload = function(e){
    try {
      if(typeof XLSX === 'undefined'){ notify('XLSX library not loaded','error'); return; }
      const ab = e.target.result;
      const data = new Uint8Array(ab);
      const workbook = XLSX.read(data, {type:'array'});
      if(!workbook.SheetNames.length){ notify('File has no sheets','error'); return; }
      // Pick the sheet that actually contains product data (skip chart/empty sheets)
      const picked = pickDataSheet(workbook);
      if(!picked || !picked.json || !picked.json.length){
        const details = workbook.SheetNames.map(s => {
          const sheet = workbook.Sheets[s];
          return s+'(ref:'+(sheet['!ref']||'none')+')';
        }).join(', ');
        notify('No data found in any sheet: '+details,'error');
        return;
      }
      let json = picked.json;
      json = json.map(row => {
        const clean = {};
        for(const k of Object.keys(row)){
          const ck = cleanHeader(k);
          if(ck) clean[ck] = row[k];
        }
        return clean;
      });
      _importData = json;
      showImportPreview(json);
    } catch(err){
      notify('Failed to parse file: '+err.message,'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function showImportPreview(rows){
  const headers = Object.keys(rows[0]);
  const preview = rows.slice(0,5);
  let html = '<thead><tr>'+headers.map(h=>'<th style="padding:6px 8px;text-align:left;background:var(--surface2);border-bottom:1px solid var(--border);">'+escHtml(h)+'</th>').join('')+'</tr></thead><tbody>';
  preview.forEach(r => {
    html += '<tr>'+headers.map(h=>'<td style="padding:4px 8px;border-bottom:1px solid var(--border);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escHtml(String(r[h]||''))+'</td>').join('')+'</tr>';
  });
  html += '</tbody>';
  document.getElementById('importPreviewTable').innerHTML = html;
  document.getElementById('importRowCount').textContent = '— '+rows.length+' row(s) found, showing first '+preview.length;
  buildMapping(headers);
  document.getElementById('importPreview').style.display = 'block';
}

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildMapping(headers){
  const container = document.getElementById('importMapping');
  container.innerHTML = '';
  const targetFields = Object.keys(FIELD_MAP);
  headers.forEach(hRaw => {
    const h = cleanHeader(hRaw);
    const norm = normHeader(h);
    let matched = null;
    for(const field of targetFields){
      if(FIELD_MAP[field].some(a => normHeader(a) === norm)){
        matched = field;
        break;
      }
    }
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
    div.innerHTML = `<span style="font-size:12px;font-weight:600;color:var(--muted);">${escHtml(h)}</span>
      <select style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface1);font-size:12px;" data-header="${escHtml(h)}">
        <option value="">— Skip —</option>
        ${targetFields.map(f => `<option value="${f}" ${matched===f?'selected':''}>${FIELD_LABELS[f]||f}</option>`).join('')}
      </select>`;
    container.appendChild(div);
  });
}

async function importProducts(){
  const qrChoice = (document.querySelector('input[name="importQrChoice"]:checked')||{}).value || 'qr';
  const rememberChk = document.getElementById('importAutoRemember');
  if(rememberChk && rememberChk.checked){
    localStorage.setItem('_qrAutoGen', Date.now());
    localStorage.setItem('_qrAutoGenType', qrChoice);
  }
  const selects = document.querySelectorAll('#importMapping select');
  const mapping = {};
  const skippedHeaders = [];
  selects.forEach(sel => {
    if(sel.value){
      if(!mapping[sel.value]) mapping[sel.value] = [];
      mapping[sel.value].push(sel.dataset.header);
    } else {
      skippedHeaders.push(sel.dataset.header);
    }
  });
  if(!Object.keys(mapping).length){ notify('Map at least one column','error'); return; }
  // Check for duplicate names and warn
  const nameField = mapping.name ? mapping.name[0] : null;
  if(nameField){
    const dupNames = _importData.map(row => String(row[nameField]||'').trim().toLowerCase()).filter(Boolean);
    const foundDups = dupNames.filter(n => products.some(p => p.name.toLowerCase() === n));
    if(foundDups.length){
      const proceed = confirm(`⚠️ ${foundDups.length} product(s) already exist by name.\n\nClick OK to import with stock-only update for these.\nCancel to abort.`);
      if(!proceed){ notify('Import cancelled'); return; }
    }
  }
  const btn = document.getElementById('importBtn');
  // Snapshot pre-import state for undo
  _lastImportSnapshot = { products: JSON.parse(JSON.stringify(products)), nextProdId };
  btn.disabled = true; btn.textContent = '⏳ Importing...';
  let imported = 0, updated = 0, errors = 0, skipped = 0, skippedSkus = [], autoSkuProducts = [];
  const catCache = {};
  categories.forEach(c => catCache[c.name.toLowerCase()] = c.id);
  _importData.forEach((row, idx) => {
    try {
      const rawName = mapping.name ? String(row[mapping.name[0]]||'').trim() : null;
      const name = rawName ? rawName.toUpperCase() : ('Imported #'+(idx+1));
      const price = mapping.price ? parseNum(row[mapping.price[0]]) : null;
      const price5 = mapping.price5 ? parseNum(row[mapping.price5[0]]) : null;
      const price10 = mapping.price10 ? parseNum(row[mapping.price10[0]]) : null;
      const stockVal = mapping.stock ? parseCount(row[mapping.stock[0]]) : null;
      const skuRaw = mapping.sku ? String(row[mapping.sku[0]]||'').trim() : '';
      const purchasePrice = mapping.purchasePrice ? parseNum(row[mapping.purchasePrice[0]]) : null;
      const gst = mapping.gst ? gstToPercent(parseNum(row[mapping.gst[0]])) : null;
      let cgst = mapping.cgst ? gstToPercent(parseNum(row[mapping.cgst[0]])) : null;
      let sgst = mapping.sgst ? gstToPercent(parseNum(row[mapping.sgst[0]])) : null;
      let igst = mapping.igst ? gstToPercent(parseNum(row[mapping.igst[0]])) : null;
      // Apply defaults for empty cells
      if(cgst==null || isNaN(cgst)) cgst = getDefVal('cgst', null);
      if(sgst==null || isNaN(sgst)) sgst = getDefVal('sgst', null);
      if(igst==null || isNaN(igst)) igst = getDefVal('igst', null);
      const effGst = (cgst||0) + (sgst||0) || gst || 0;
      let hsn = mapping.hsn ? String(row[mapping.hsn[0]]||'').trim() : '';
      let location = mapping.location ? String(row[mapping.location[0]]||'').trim() : '';
      let cess = mapping.cess ? gstToPercent(parseNum(row[mapping.cess[0]])) : null;
      let low = mapping.low ? parseCount(row[mapping.low[0]]) : null;
      let ppb = mapping.piecesPerBox ? Math.max(1,parseCount(row[mapping.piecesPerBox[0]])) : null;
      let boxes = mapping.noOfBoxes ? Math.max(0,parseCount(row[mapping.noOfBoxes[0]])) : null;
      let pcs = mapping.noOfPieces ? Math.max(0,parseCount(row[mapping.noOfPieces[0]])) : null;
      let description = null;
      // Apply defaults for empty cells
      if(!hsn) hsn = getDefVal('hsn','') || '';
      if(!location) location = getDefVal('location','') || '';
      if(cess==null || isNaN(cess)) cess = getDefVal('cess', null);
      if(low==null || isNaN(low)) low = getDefVal('low', null);
      if(ppb==null || isNaN(ppb) || ppb<1) ppb = getDefVal('ppb', null);
      if(!description && !skippedHeaders.length) description = getDefVal('description','') || null;
      if(mapping.description){
        description = mapping.description.map(h => {
          const v = row[h];
          if(v === '' || v === null || v === undefined) return null;
          return h+' = '+String(v).trim();
        }).filter(Boolean).join(', ');
      }
      if(skippedHeaders.length){
        const extra = skippedHeaders.map(h => {
          const v = row[h];
          if(v === '' || v === null || v === undefined) return null;
          return h+' = '+String(v).trim();
        }).filter(Boolean).join(', ');
        if(extra) description = description ? description+', '+extra : extra;
      }
      let catId = null;
      if(mapping.category){
        const catName = String(row[mapping.category[0]]||'').trim().toUpperCase();
        if(catName){
          const catKey = catName.toLowerCase();
          if(catCache[catKey]){ catId = catCache[catKey]; }
          else {
            catId = nextCatId++;
            const newCat = { id:catId, name:catName, emoji:'📦' };
            categories.push(newCat);
            catCache[catKey] = catId;
          }
        }
      }
      // Apply default category if none mapped
      if(!catId && _defaults.category_on && _defaults.category){
        catId = parseInt(_defaults.category) || null;
      }
      // Check if product already exists by SKU or name
      let finalSku = skuRaw;
      let existing = finalSku ? products.find(p => p.sku && p.sku.toLowerCase() === finalSku.toLowerCase()) : null;
      if(!existing && name) existing = products.find(p => p.name.toLowerCase() === name.toLowerCase());
      if(existing){
        if(stockVal !== null && !isNaN(stockVal)) existing.stock = stockVal;
        if(mapping.price && price !== null && !isNaN(price)) existing.price = price;
        if(mapping.price5 && price5 !== null && !isNaN(price5)) existing.price5 = price5;
        if(mapping.price10 && price10 !== null && !isNaN(price10)) existing.price10 = price10;
        if(mapping.cess && cess !== null && !isNaN(cess)) existing.cess = cess;
        if(mapping.purchasePrice && purchasePrice !== null && !isNaN(purchasePrice)) existing.purchasePrice = purchasePrice;
        if(mapping.gst || mapping.cgst || mapping.sgst || mapping.igst){
          existing.gst = effGst; existing.cgst = cgst||0; existing.sgst = sgst||0; existing.igst = igst||0;
        }
        if(mapping.hsn && hsn) existing.hsn = hsn;
        if(mapping.location && location) existing.location = location;
        if(mapping.low && low !== null && !isNaN(low)) existing.low = low;
        if(mapping.piecesPerBox && ppb !== null && !isNaN(ppb)) existing.piecesPerBox = ppb;
        if(mapping.noOfBoxes && boxes !== null && !isNaN(boxes)) existing.noOfBoxes = boxes;
        if(mapping.noOfPieces && pcs !== null && !isNaN(pcs)) existing.noOfPieces = pcs;
        if(catId) existing.catId = catId;
        if(mapping.unit){
          const u = String(row[mapping.unit[0]]||'').trim();
          if(u) existing.unit = u;
        }
        updated++;
        return;
      }
      // New product: auto-generate SKU if missing
      const wasAutoSku = !finalSku;
      if(wasAutoSku){
        let attempts = 0;
        do {
          finalSku = 'AUTO-'+Math.random().toString(36).substring(2,8).toUpperCase();
          attempts++;
        } while(attempts < 100 && products.some(p => p.sku === finalSku));
      }
      if(finalSku && products.some(p => p.sku && p.sku === finalSku)){ skipped++; skippedSkus.push(finalSku); return; }
      const calcStock = (boxes||0) * (ppb||1) + (pcs||0);
      const finalStock = (mapping.stock && stockVal !== null && !isNaN(stockVal)) ? stockVal : (calcStock || 0);
      const prodId = nextProdId++;
      products.push({
        id: prodId, name, price, price5, price10, stock: finalStock,
        catId, emoji:'', image:'', description, sku: finalSku, low,
        noOfBoxes: boxes, noOfPieces: pcs, piecesPerBox: ppb, gst:effGst, cgst:cgst||0, sgst:sgst||0, igst:igst||0, hsn, location, cess, purchasePrice, lastPurchaseDate: '', unit: mapping.unit ? String(row[mapping.unit[0]]||'').trim() : ''
      });
      if(wasAutoSku) autoSkuProducts.push({ sku: finalSku, name, id: prodId });
      imported++;
    } catch(e){ errors++; console.error('Import row '+idx+' error:', e); if(errors===1) notify('⚠️ Row error: '+e.message,'error'); }
  });
  btn.disabled = false; btn.textContent = '✓ Import Products';
  closeModal2();
  refreshCategoryDropdowns();
  saveAllData(true);
  const skipMsg = skipped ? `, ${skipped} skipped (${skippedSkus.join(', ')})` : '';
  let msg = `${imported} new, ${updated} updated`+skipMsg+(errors?`, ${errors} error(s)`:'');
  _importData = null;
  // Auto-generate QR/barcode for new auto-SKU products (skip if QR already exists for that name)
  if(autoSkuProducts.length){
    let qrCount = 0;
    if(qrChoice !== 'none'){
      autoSkuProducts.forEach(p => {
        if(qrCodes.some(q => q.product_name && q.product_name.toLowerCase() === p.name.toLowerCase())) return;
        saveQrCode({ sku: p.sku, product_name: p.name, product_id: p.id, qr_data: p.sku, barcode_type: qrChoice });
        qrCount++;
      });
    }
    if(qrCount) msg += ` · ${qrCount} ${qrChoice==='qr'?'QR(s)':'barcode(s)'} auto-generated`;
  }
  renderInventory();
  notify(`✅ ${msg}`);
}

function undoLastImport(){
  if(!_lastImportSnapshot) return;
  products.length = 0;
  products.push(..._lastImportSnapshot.products);
  nextProdId = _lastImportSnapshot.nextProdId;
  _lastImportSnapshot = null;
  renderInventory();
  refreshCategoryDropdowns();
  saveAllData(true);
  notify('Import undone — products restored to pre-import state');
}

// ── EXPORT ──────────────────────────────────────────────────────────────────────
function exportStockExcel(){
  if(!products.length){ notify('No products to export','error'); return; }
  const wb=XLSX.utils.book_new();
  const data=products.map(p=>({
    Name:p.name, SKU:p.sku||'', Price:p.price, Stock:p.stock,
    Category:getCatName(p.catId), CGST:(p.cgst||0)+'%', SGST:(p.sgst||0)+'%', IGST:(p.igst||0)+'%', LowAlert:p.low,
    Boxes:p.noOfBoxes||0, Pieces:p.noOfPieces||0, PiecesPerBox:p.piecesPerBox||1,
    Unit:p.unit||'', Description:p.description||''
  }));
  const ws=XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb,ws,'Inventory');
  const cols=[{wch:25},{wch:15},{wch:10},{wch:8},{wch:15},{wch:8},{wch:8},{wch:8},{wch:8},{wch:12},{wch:10},{wch:30}];
  ws['!cols']=cols;
  const fName='ShopOS_Inventory_'+new Date().toISOString().slice(0,10)+'.xlsx';
  XLSX.writeFile(wb,fName);
  notify('📊 Exported '+products.length+' products to '+fName);
}

function exportStockPDF(){
  if(!products.length){ notify('No products to export','error'); return; }
  const totalStock=products.reduce((s,p)=>s+p.stock,0);
  const totalValue=products.reduce((s,p)=>s+p.stock*p.price,0);
  let rows='<tr style="background:var(--surface2);font-weight:600;"><td style="padding:8px;border:1px solid #ccc;">#</td><td style="padding:8px;border:1px solid #ccc;">Product</td><td style="padding:8px;border:1px solid #ccc;">SKU</td><td style="padding:8px;border:1px solid #ccc;">Price</td><td style="padding:8px;border:1px solid #ccc;">Stock</td><td style="padding:8px;border:1px solid #ccc;">Value</td></tr>';
  products.forEach((p,i)=>{
    rows+=`<tr><td style="padding:6px 8px;border:1px solid #ccc;">${i+1}</td>
      <td style="padding:6px 8px;border:1px solid #ccc;">${escHtml(p.name)}</td>
      <td style="padding:6px 8px;border:1px solid #ccc;">${escHtml(p.sku||'—')}</td>
      <td style="padding:6px 8px;border:1px solid #ccc;">₹${fmt(p.price)}</td>
      <td style="padding:6px 8px;border:1px solid #ccc;">${p.stock}</td>
      <td style="padding:6px 8px;border:1px solid #ccc;">₹${fmt(p.stock*p.price)}</td></tr>`;
  });
  const html=`
    <html><head><meta charset="utf-8"><title>ShopOS Inventory</title>
    <style>body{font-family:Arial,sans-serif;padding:20px;}
    h1{font-size:18px;margin-bottom:4px;}.sub{font-size:12px;color:#666;margin-bottom:16px;}
    table{width:100%;border-collapse:collapse;font-size:12px;}
    .total-row td{font-weight:700;padding:8px;border:1px solid #ccc;background:#f5f5f5;}</style></head>
    <body>
    <h1>ShopOS — Inventory Report</h1>
    <div class="sub">Generated: ${new Date().toLocaleString('en-IN')} | Total: ${products.length} products | Stock: ${totalStock} pcs | Value: ₹${fmt(totalValue)}</div>
    <table>${rows}
      <tr class="total-row"><td colspan="3"></td><td>Total</td><td>${totalStock}</td><td>₹${fmt(totalValue)}</td></tr>
    </table></body></html>`;
  const win=window.open('','_blank');
  if (!win) { notify('Please allow popups for this site','error'); return; }
  win.document.write(html);
  win.document.title='ShopOS Inventory Report';
  win.print();
  notify('📄 PDF print dialog opened');
}

// ── CART RESIZE ───────────────────────────────────────────────────────────────
function initCartResize(){
  const cart = document.getElementById('cartPanel');
  if (!cart) return;
  const savedW = localStorage.getItem('shopOS_cartWidth');
  const savedH = localStorage.getItem('shopOS_cartHeight');
  if (savedW) applyCartWidth(parseInt(savedW));
  if (savedH) cart.style.height = savedH + 'px';
  window.addEventListener('resize', function(){
    if (window.innerWidth <= 900) {
      const layout = document.querySelector('.pos-layout');
      if (layout) layout.style.gridTemplateColumns = '';
    } else {
      const w = localStorage.getItem('shopOS_cartWidth');
      if (w) applyCartWidth(parseInt(w));
    }
  });
  ['W','H','C'].forEach(function(suffix){
    const handle = document.getElementById('cartResize' + suffix);
    if (!handle) return;
    handle.addEventListener('mousedown', function(e){
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startW = cart.offsetWidth, startH = cart.offsetHeight;
      function onMove(ev){
        let w = startW, h = startH;
        if (suffix === 'W') {
          w = Math.min(700, Math.max(260, startW + startX - ev.clientX));
        } else if (suffix === 'H') {
          h = Math.min(700, Math.max(200, startH + ev.clientY - startY));
        } else {
          w = Math.min(700, Math.max(260, startW + startX - ev.clientX));
          h = Math.min(700, Math.max(200, startH + ev.clientY - startY));
        }
        if (w !== startW) applyCartWidth(w);
        if (h !== startH) cart.style.height = h + 'px';
      }
      function onUp(){
        localStorage.setItem('shopOS_cartWidth', cart.offsetWidth);
        localStorage.setItem('shopOS_cartHeight', cart.offsetHeight);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}
function applyCartWidth(w){
  document.getElementById('cartPanel').style.width = w + 'px';
  if (window.innerWidth <= 900) return;
  const layout = document.querySelector('.pos-layout');
  if (layout) layout.style.gridTemplateColumns = '1fr ' + w + 'px';
}

// ── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT') return;
  if(!e.altKey) return;
  const shortcuts = {
    'd':'dashboard', 'b':'pos', 'a':'advance', 'u':'udhaar',
    'i':'inventory', 'c':'categories', 's':'sales', 'h':'invhistory',
    'l':'customers', 'r':'reports', 'g':'gst',
    'x':'expenses', 'f':'defaults', 'n':'notes', 'q':'qr', 'z':'scanadd'
  };
  const key = e.key.toLowerCase();
  if(shortcuts[key]){
    e.preventDefault();
    navigate(shortcuts[key]);
  }
});

// ── INIT ──────────────────────────────────────────────────────────────────────
// Save data on tab/browser close
window.addEventListener('beforeunload', function(){
  try {
    fetch(API_BASE+'/save', {
      method:'POST', headers:_authHeaders(),
      body:JSON.stringify({categories,products,sales,inventoryHistory,udhaarRecords,advanceOrders,notes,customerLedgers,purchasePriceLog,supplierTransportLog,expenses}),
      keepalive:true
    });
  } catch(e){}
});

initCartResize();
navigate('dashboard');
setTimeout(scheduleUdhaarReminderCheck, 2000); // check 2s after load
// Also try to load data if token exists but checkSession hasn't run yet
if(_token){
  // loadAllData will be called from checkSession
} else {
  const lsAcc = getAccounts();
  if(lsAcc.length){
    // Local accounts exist but no token — offer to log in
    notify('Sign in to sync data with the server');
  }
}

// ── DELETE ALL DATA ────────────────────────────────────────────────────────────
async function deleteAllData(){
  if(!_token){ notify('Please login first','error'); return; }
  const pw = prompt('⚠️ DELETE ALL DATA?\n\nEnter your password to confirm:');
  if(!pw) return;
  try {
    const res = await _api('/delete-all', {
      method: 'POST',
      body: JSON.stringify({ password: pw })
    });
    if(res.success){
      // Clear in-memory data
      categories = []; products = []; sales = []; inventoryHistory = []; udhaarRecords = []; advanceOrders = []; qrCodes = [];
      notes = []; expenses = []; customerLedgers = []; purchasePriceLog = [];
      nextProdId = 1; nextCatId = 1; nextSaleId = 1; nextInvId = 1; nextAdvId = 1;
      _nextNoteId = 1; _nextLedgerId = 1; _nextExpId = 1;
      renderInventory(); renderCategories(); renderPOS(); renderSalesHistory();
      renderInventoryHistory(); renderUdhaar(); renderCustomers(); renderDashboard();
      notify('✅ All data deleted permanently');
    }
  } catch(e) {
    notify('Error: '+e.message, 'error');
  }
}

// ── QR & BARCODE GENERATOR ─────────────────────────────────────────────────────
let _qrMode = 'qr';
let _lastGeneratedUrl = '';
let _lastGeneratedText = '';
let _existingQrMode = 'qr';

function switchQrTab(mode){
  _qrMode = mode;
  const qrBtn = document.getElementById('qrTabBtn');
  const barBtn = document.getElementById('barcodeTabBtn');
  if(qrBtn){ qrBtn.style.background = mode==='qr' ? 'var(--accent)' : 'var(--surface2)';
    qrBtn.style.color = mode==='qr' ? '#fff' : 'var(--text)'; }
  if(barBtn){ barBtn.style.background = mode==='barcode' ? 'var(--accent)' : 'var(--surface2)';
    barBtn.style.color = mode==='barcode' ? '#fff' : 'var(--text)'; }
  const sizeRow = document.getElementById('qrSizeRow');
  if(sizeRow) sizeRow.style.display = mode==='qr' ? 'flex' : 'none';
  const barRow = document.getElementById('barcodeOptsRow');
  if(barRow) barRow.style.display = mode==='barcode' ? 'flex' : 'none';
  const genBtn = document.getElementById('generateBtn');
  if(genBtn) genBtn.textContent = mode==='qr' ? '🔲 Generate' : '🏷️ Generate';
  const res = document.getElementById('qrResult');
  if(res) res.style.display = 'none';
  const saveBtn = document.getElementById('saveQrBtn');
  if(saveBtn) saveBtn.style.display = 'none';
  document.getElementById('qrAddInvSection').style.display = 'none';
}

function switchExistQrTab(mode){
  _existingQrMode = mode;
  const qrBtn = document.getElementById('existQrTabBtn');
  const barBtn = document.getElementById('existBarcodeTabBtn');
  if(qrBtn){ qrBtn.style.background = mode==='qr' ? 'var(--accent)' : 'var(--surface2)';
    qrBtn.style.color = mode==='qr' ? '#fff' : 'var(--text)'; }
  if(barBtn){ barBtn.style.background = mode==='barcode' ? 'var(--accent)' : 'var(--surface2)';
    barBtn.style.color = mode==='barcode' ? '#fff' : 'var(--text)'; }
  const barRow = document.getElementById('existBarcodeOptsRow');
  if(barRow) barRow.style.display = mode==='barcode' ? 'flex' : 'none';
  const genBtn = document.getElementById('genExistingBtn');
  if(genBtn) genBtn.textContent = mode==='qr' ? '🔲 Generate QR' : '🏷️ Generate Barcode';
  document.getElementById('qrExistingResult').style.display = 'none';
  document.getElementById('saveExistingBtn').style.display = 'none';
}

function generateQR(){
  const text = document.getElementById('qrInput').value.trim();
  if(!text){ notify('Enter some text or URL first','error'); return; }
  const wrap = document.getElementById('qrCodeImageWrap');
  const btn = document.getElementById('generateBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  let url;
  if(_qrMode === 'qr'){
    const size = document.getElementById('qrSize').value;
    const color = document.getElementById('qrColor').value.replace('#','');
    const bg = document.getElementById('qrBgColor').value.replace('#','');
    url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&color=${color}&bgcolor=${bg}`;
    wrap.innerHTML = `<img src="${url}" alt="QR Code" style="width:${size}px;height:${size}px;border-radius:4px;" id="qrImage">`;
  } else {
    const type = document.getElementById('barcodeType').value;
    const height = document.getElementById('barcodeHeight').value;
    url = `https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(text)}&code=${type}&dpi=96&imagetype=png&translate-esc=true&height=${height}`;
    wrap.innerHTML = `<img src="${url}" alt="Barcode" style="max-width:100%;border-radius:4px;" id="qrImage">`;
  }
  btn.disabled = false; btn.textContent = _qrMode==='qr' ? '🔲 Generate' : '🏷️ Generate';
  document.getElementById('qrResult').style.display = 'block';
  document.getElementById('saveQrBtn').style.display = '';
  _lastGeneratedUrl = url;
  _lastGeneratedText = text;
  // Check if SKU/name already exists
  const exists = products.some(p => p.sku === text || p.name.toLowerCase() === text.toLowerCase());
  const statusEl = document.getElementById('qrSkuStatus');
  if(statusEl) statusEl.textContent = exists
    ? '⚠️ This SKU/name already exists in inventory — overwrite not allowed'
    : '✅ New — you can register this as a product';
  document.getElementById('qrAddInvSection').style.display = 'block';
}

async function downloadAsFile(url, filename){
  try {
    const res = await fetch(url, { mode: 'cors' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch(e){
    // fallback: open in new tab
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

function downloadQR(){
  const img = document.getElementById('qrImage');
  if(!img) return;
  const filename = _qrMode==='qr' ? 'qrcode.png' : 'barcode.png';
  downloadAsFile(img.src, filename);
}

function printQR(){
  const img = document.getElementById('qrImage');
  if(!img) return;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Print</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;}img{max-width:95vw;max-height:95vh;}</style></head><body><img src="${img.src}" onload="setTimeout(()=>{window.print();window.close()},300)"></body></html>`);
  w.document.close();
}

function downloadQrFromHistory(idx){
  const q = qrCodes[idx];
  if(!q) return;
  const isQr = q.barcode_type === 'qr';
  const imgUrl = isQr
    ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(q.qr_data||q.sku)}`
    : `https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(q.qr_data||q.sku)}&code=${q.barcode_type||'Code128'}&dpi=96&imagetype=png&translate-esc=true&height=80`;
  const filename = q.product_name
    ? (isQr ? q.product_name+'_qrcode.png' : q.product_name+'_barcode.png')
    : (isQr ? 'qrcode.png' : 'barcode.png');
  downloadAsFile(imgUrl, filename);
}

function printQrFromHistory(idx){
  const q = qrCodes[idx];
  if(!q) return;
  const isQr = q.barcode_type === 'qr';
  const imgUrl = isQr
    ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(q.qr_data||q.sku)}`
    : `https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(q.qr_data||q.sku)}&code=${q.barcode_type||'Code128'}&dpi=96&imagetype=png&translate-esc=true&height=80`;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Print ${q.product_name||'QR'}</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;}img{max-width:95vw;max-height:95vh;}</style></head><body><img src="${imgUrl}" onload="setTimeout(()=>{window.print();window.close()},300)"></body></html>`);
  w.document.close();
}

async function saveGeneratedQr(){
  if(!_lastGeneratedText) return;
  const pName = prompt('Product name (optional):') || '';
  await saveQrCode({ sku: _lastGeneratedText, product_name: pName, product_id: null, qr_data: _lastGeneratedText, barcode_type: _qrMode });
  document.getElementById('saveQrBtn').style.display = 'none';
  renderQrPage();
}

function addQrProductToInventory(){
  if(!_lastGeneratedText) return;
  openAddProduct({ sku: _lastGeneratedText, name: '' });
}

async function deleteAllQrCodes(){
  if(!qrCodes.length) return;
  if(!confirm(`Delete all ${qrCodes.length} saved QR codes? This cannot be undone.`)) return;
  if(!_token) return;
  try {
    await _api('/qr/delete-all', { method: 'DELETE' });
    qrCodes = [];
    renderQrPage();
    notify('All QR codes deleted');
  } catch(e) {
    notify('Failed to delete QR codes','error');
  }
}

function exportAllQrCodes(){
  if(!qrCodes.length){ notify('No QR codes to export','error'); return; }
  let csv = 'Product Name,SKU,QR Data,Type,Created On\n';
  qrCodes.forEach(q => {
    const name = (q.product_name||'').replace(/,/g,' ');
    const sku = (q.sku||'').replace(/,/g,' ');
    const data = (q.qr_data||'').replace(/,/g,' ');
    const type = q.barcode_type||'qr';
    const date = q.created_at ? new Date(q.created_at).toLocaleDateString('en-IN') : '';
    csv += `"${name}","${sku}","${data}",${type},"${date}"\n`;
  });
  const blob = new Blob(['\uFEFF'+csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'All_QR_Codes_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
  URL.revokeObjectURL(url);
  notify('📥 QR codes exported');
}

async function saveQrCode(data){
  if(!_token) return;
  try {
    const res = await _api('/qr/save', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    if(res.id) qrCodes.unshift(res);
    return res;
  } catch(e) {
    notify('Failed to save QR code','error');
  }
}

async function loadQrCodes(){
  if(!_token) return;
  try {
    const res = await _api('/qr/list');
    qrCodes = res || [];
  } catch(e) {
    qrCodes = [];
  }
}

async function deleteQrCode(id){
  if(!_token) return;
  try {
    await _api('/qr/delete/'+id, { method: 'DELETE' });
    qrCodes = qrCodes.filter(q => q.id !== id);
    renderQrPage();
    notify('QR code deleted');
  } catch(e) {
    notify('Failed to delete QR code','error');
  }
}

function renderQrPage(){
  document.getElementById('qrExistingSearch').value = '';
  document.getElementById('qrExistingProduct').value = '';
  document.getElementById('qrExistingAcList').style.display = 'none';
  const preview = document.getElementById('qrExistingPreview');
  if(preview) { preview.style.display = 'none'; }
  const btn = document.getElementById('genExistingBtn');
  if(btn) btn.disabled = true;
  // Render history
  const wrap = document.getElementById('qrHistoryWrap');
  if(!wrap) return;
  if(!qrCodes.length){
    wrap.innerHTML = '<div class="empty-state" style="padding:30px 0;text-align:center;color:var(--muted);">No QR codes saved yet.</div>';
    document.getElementById('qrCount').textContent = '';
    return;
  }
  document.getElementById('qrCount').textContent = qrCodes.length+' saved';
  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">';
  qrCodes.forEach((q, idx) => {
    const isQr = q.barcode_type === 'qr';
    const imgUrl = isQr
      ? `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(q.qr_data||q.sku)}`
      : `https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(q.qr_data||q.sku)}&code=${q.barcode_type||'Code128'}&dpi=72&imagetype=png&translate-esc=true&height=60`;
    html += `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;">
      <div style="background:#fff;border-radius:6px;padding:6px;display:inline-block;margin-bottom:8px;">
        <img src="${imgUrl}" alt="" style="max-width:150px;max-height:120px;display:block;">
      </div>
      <div style="font-size:12px;font-weight:600;margin-bottom:2px;">${escHtml(q.product_name || '(No name)')}</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">SKU: ${escHtml(q.sku||'')}</div>
      <div style="font-size:10px;color:var(--muted);">${new Date(q.created_at).toLocaleDateString()}</div>
      <div style="display:flex;gap:4px;justify-content:center;margin-top:6px;">
        <button class="btn btn-ghost btn-sm" onclick="downloadQrFromHistory(${idx})" style="font-size:10px;">⬇️ Download</button>
        <button class="btn btn-ghost btn-sm" onclick="printQrFromHistory(${idx})" style="font-size:10px;">🖨️ Print</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteQrCode(${q.id})" style="font-size:10px;color:var(--red);">✕ Delete</button>
      </div>
    </div>`;
  });
  html += '</div>';
  wrap.innerHTML = html;
}

function filterQrExistingProducts(v){
  const list = document.getElementById('qrExistingAcList');
  const hidden = document.getElementById('qrExistingProduct');
  if(!v.trim()){
    list.style.display = 'none';
    hidden.value = '';
    document.getElementById('qrExistingPreview').style.display = 'none';
    document.getElementById('genExistingBtn').disabled = true;
    return;
  }
  const q = v.toLowerCase();
  const matches = products.filter(p => matchWords(p.name,q) || matchWords(p.sku||'',q) || matchWords(getCatName(p.catId),q)).slice(0, 8);
  if(!matches.length){
    list.innerHTML = '<div class="autocomplete-item" style="color:var(--muted);cursor:default;">No products found</div>';
    list.style.display = 'block';
    hidden.value = '';
    document.getElementById('qrExistingPreview').style.display = 'none';
    document.getElementById('genExistingBtn').disabled = true;
    return;
  }
  list.innerHTML = matches.map(p => `<div class="autocomplete-item" onmousedown="event.preventDefault();selectQrExistingProduct(${p.id},'${escHtml(p.name).replace(/'/g,"\\'")}')">
    <span class="ai-icon">${p.image?`<img src="${p.image}" style="width:22px;height:22px;object-fit:cover;border-radius:4px;vertical-align:middle;">`:p.emoji}</span>
    <span class="ai-name">${hlStr(p.name,q)}</span>
    <span class="ai-sub">${p.sku ? escHtml(p.sku)+' · ':''}${getCatName(p.catId)} · ₹${fmt(p.price)}</span>
  </div>`).join('');
  list.style.display = 'block';
}

function selectQrExistingProduct(id, name){
  document.getElementById('qrExistingSearch').value = name;
  document.getElementById('qrExistingProduct').value = id;
  document.getElementById('qrExistingAcList').style.display = 'none';
  prefillQrFromProduct();
}

function prefillQrFromProduct(){
  const pid = parseInt(document.getElementById('qrExistingProduct').value);
  const prod = products.find(p => p.id === pid);
  const preview = document.getElementById('qrExistingPreview');
  const btn = document.getElementById('genExistingBtn');
  if(!prod){
    preview.style.display = 'none';
    btn.disabled = true;
    return;
  }
  preview.style.display = 'block';
  preview.innerHTML = `<strong>${escHtml(prod.name)}</strong> &middot; SKU: ${escHtml(prod.sku||'—')} &middot; ₹${prod.price}`;
  btn.disabled = false;
  document.getElementById('saveExistingBtn').style.display = 'none';
  document.getElementById('qrExistingResult').style.display = 'none';
  btn.textContent = _existingQrMode==='qr' ? '🔲 Generate QR' : '🏷️ Generate Barcode';
}

function generateQrForExisting(){
  const pid = parseInt(document.getElementById('qrExistingProduct').value);
  const prod = products.find(p => p.id === pid);
  if(!prod){ notify('Select a product first','error'); return; }
  const text = prod.sku || String(prod.id);
  const wrap = document.getElementById('qrExistingImageWrap');
  const btn = document.getElementById('genExistingBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  let url;
  if(_existingQrMode === 'qr'){
    const size = document.getElementById('qrSize').value || '200';
    const color = document.getElementById('qrColor').value.replace('#','') || '000000';
    const bg = document.getElementById('qrBgColor').value.replace('#','') || 'ffffff';
    url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&color=${color}&bgcolor=${bg}`;
    wrap.innerHTML = `<img src="${url}" alt="QR Code" style="width:${Math.min(size,180)}px;border-radius:4px;" id="existingQrImg">`;
  } else {
    const type = document.getElementById('existBarcodeType').value;
    const height = document.getElementById('existBarcodeHeight').value;
    url = `https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(text)}&code=${type}&dpi=96&imagetype=png&translate-esc=true&height=${height}`;
    wrap.innerHTML = `<img src="${url}" alt="Barcode" style="max-width:100%;border-radius:4px;" id="existingQrImg">`;
  }
  btn.disabled = false; btn.textContent = _existingQrMode==='qr' ? '🔲 Generate QR' : '🏷️ Generate Barcode';
  document.getElementById('qrExistingResult').style.display = 'block';
  document.getElementById('saveExistingBtn').style.display = '';
  _lastExistingProd = prod;
}

async function saveExistingQr(){
  if(!_lastExistingProd) return;
  const text = _lastExistingProd.sku || String(_lastExistingProd.id);
  await saveQrCode({ sku: text, product_name: _lastExistingProd.name, product_id: _lastExistingProd.id, qr_data: text, barcode_type: _existingQrMode });
  document.getElementById('saveExistingBtn').style.display = 'none';
  renderQrPage();
  notify('✅ QR code saved');
}

let _lastExistingProd = null;

// ── Date Picker ─────────────────────────────────────────────────────────────────
const _cal = { input: null, view: new Date(), selected: null, max: new Date() };
function calGetDt(dateId, timeId) {
  const d = (document.getElementById(dateId)?._val || '');
  const t = (document.getElementById(timeId)?.value || '');
  return d ? d + 'T' + t : '';
}
function calInit() {
  document.querySelectorAll('input[data-calendar]').forEach(el => calBind(el));
}
function calBind(el) {
  if(!el) return;
  if(el.hasAttribute('readonly')){el.style.cursor='pointer';}
  if(el._calBound){ return; }
  el._calBound = true;
  el.addEventListener('click', () => calOpen(el));
  el.addEventListener('keydown', e => { if(e.key==='Enter') calOpen(el); });
  if (el.value) { el._val = el.value; el.value = calFmt(el.value); }
}
function calFmt(val) {
  if (!val) return '';
  try { return new Date(val + 'T00:00:00').toLocaleDateString('en-IN', { month:'short', day:'numeric', year:'numeric' }); }
  catch(e) { return val; }
}
function calOpen(input) {
  _cal.input = input;
  _cal.viewMode = 'day';
  _cal.selected = input._val ? new Date(input._val + 'T00:00:00') : null;
  _cal.view = input._val ? new Date(input._val + 'T00:00:00') : new Date();
  _cal.max = new Date('2099-12-31'); _cal.max.setHours(23,59,59,999);
  calRender(); calSyncPreset();
  document.getElementById('calOverlay').style.display = 'flex';
}
function calClose() { document.getElementById('calOverlay').style.display = 'none'; _cal.input = null; }
function calCycleView(){
  const modes=['day','month','year'];
  const idx=modes.indexOf(_cal.viewMode);
  _cal.viewMode=modes[(idx+1)%modes.length];
  calRender();
}
function calSyncPreset() {
  const s = _cal.selected; if (!s) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = c => { const r = new Date(c); r.setHours(0,0,0,0); return r.getTime(); };
  const sd = d(s), td = d(today);
  let name = sd===td ? 'today' : sd===d(new Date(today.setDate(today.getDate()-1))) ? 'yesterday'
    : (sd >= d(new Date(new Date().setDate(new Date().getDate()-7)))) && sd < td ? 'week'
    : (s.getMonth()===new Date().getMonth()-1 && s.getFullYear()===new Date().getFullYear()) ? 'month' : '';
  document.querySelectorAll('.cal-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
}
function calRender() {
  const d = _cal.view, year = d.getFullYear(), month = d.getMonth();
  const labelEl=document.getElementById('calLabel');
  const grid = document.getElementById('calGrid'); grid.innerHTML = '';
  if(_cal.viewMode==='month'){
    labelEl.textContent = year;
    labelEl.style.cursor='pointer';
    labelEl.onclick=()=>{_cal.viewMode='year';calRender();};
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const selMon = _cal.selected ? _cal.selected.getMonth() : -1;
    const selYr = _cal.selected ? _cal.selected.getFullYear() : -1;
    grid.style.gridTemplateColumns='repeat(4,1fr)';
    months.forEach((m,i)=>{
      const div=document.createElement('div');
      div.className='cal-month';
      if(i===selMon && year===selYr) div.classList.add('cal-selected');
      div.textContent=m;
      div.onclick=()=>{
        _cal.view.setMonth(i);
        _cal.viewMode='day';
        calRender();
      };
      grid.appendChild(div);
    });
    return;
  }
  if(_cal.viewMode==='year'){
    const base=Math.floor(year/20)*20;
    labelEl.textContent = base+'–'+(base+19);
    labelEl.style.cursor='pointer';
    labelEl.onclick=()=>{_cal.viewMode='day';calRender();};
    const selYr = _cal.selected ? _cal.selected.getFullYear() : -1;
    grid.style.gridTemplateColumns='repeat(5,1fr)';
    for(let y=base-1; y<=base+20; y++){
      const div=document.createElement('div');
      div.className='cal-year';
      if(y<base || y>base+19) div.classList.add('cal-outside');
      if(y===selYr) div.classList.add('cal-selected');
      div.textContent=y;
      if(y>=1900 && y<=2099) div.onclick=()=>{
        _cal.view.setFullYear(y);
        _cal.viewMode='month';
        calRender();
      };
      grid.appendChild(div);
    }
    return;
  }
  // Day mode
  labelEl.textContent = d.toLocaleString('en-US', { month:'long', year:'numeric' });
  labelEl.style.cursor='pointer';
  labelEl.onclick=()=>{_cal.viewMode='month';calRender();};
  grid.style.gridTemplateColumns='repeat(7,1fr)';
  const firstDay = new Date(year, month, 1).getDay();
  const dim = new Date(year, month + 1, 0).getDate();
  const dip = new Date(year, month, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);
  const sel = _cal.selected ? new Date(_cal.selected).setHours(0,0,0,0) : null;
  const max = _cal.max.getTime();
  const cell = (n, date, out) => {
    const div = document.createElement('div');
    div.className = 'cal-day' + (out ? ' cal-outside' : '');
    const ts = date.getTime();
    if (ts === today.getTime()) div.classList.add('cal-today');
    if (sel && ts === sel) div.classList.add('cal-selected');
    if (ts > max) div.classList.add('cal-disabled');
    div.textContent = n;
    if (ts <= max) div.onclick = () => calPick(date);
    grid.appendChild(div);
  };
  for (let i = firstDay - 1; i >= 0; i--) cell(dip - i, new Date(year, month - 1, dip - i), true);
  for (let d = 1; d <= dim; d++) cell(d, new Date(year, month, d), false);
  const total = Math.ceil((firstDay + dim) / 7) * 7;
  for (let d = 1; d <= total - firstDay - dim; d++) cell(d, new Date(year, month + 1, d), true);
}
function calNav(dir) {
  if(_cal.viewMode==='year') _cal.view.setFullYear(_cal.view.getFullYear() + dir*20);
  else _cal.view.setMonth(_cal.view.getMonth() + dir);
  calRender();
}
function calPick(date) {
  const y = date.getFullYear(), m = String(date.getMonth()+1).padStart(2,'0'), d = String(date.getDate()).padStart(2,'0');
  const val = `${y}-${m}-${d}`;
  const inp = _cal.input;
  if (inp) {
    inp._val = val; inp.value = calFmt(val); inp.dataset.value = val;
    if (inp.onchange) inp.onchange();
    if (inp._onChange) inp._onChange(val);
  }
  document.getElementById('calOverlay').style.display = 'none';
}
function calPreset(name) {
  const today = new Date(); today.setHours(0,0,0,0);
  let date = new Date(today);
  if (name === 'yesterday') date.setDate(date.getDate() - 1);
  else if (name === 'week') date.setDate(date.getDate() - 7);
  else if (name === 'month') date.setMonth(date.getMonth() - 1);
  else if (name === 'year') date.setFullYear(date.getFullYear() - 1);
  calPick(date);
}



// -- MAP PICKER (OpenStreetMap + Leaflet, 100% free, no API key) -------------
let _mapPickerMap = null;
let _mapPickerMarker = null;
let _mapPickerCb = null;
let _mapPickerInitLat = 20.5937;
let _mapPickerInitLng = 78.9629;

function openMapPicker(opts){
  opts = opts || {};
  _mapPickerCb = opts.onConfirm || null;
  const lat = (opts.lat != null) ? opts.lat : _mapPickerInitLat;
  const lng = (opts.lng != null) ? opts.lng : _mapPickerInitLng;
  if(window.L && L.Icon && L.Icon.Default){
    L.Icon.Default.mergeOptions({
      iconUrl: 'marker-icon.png',
      iconRetinaUrl: 'marker-icon-2x.png',
      shadowUrl: 'marker-shadow.png'
    });
  }
  const addrEl = document.getElementById('mapPickedAddress');
  const latEl  = document.getElementById('mapPickedLat');
  const lngEl  = document.getElementById('mapPickedLng');
  if(latEl) latEl.value = lat;
  if(lngEl) lngEl.value = lng;
  if(addrEl) addrEl.innerHTML = opts.address ? `<span style="color:var(--accent);font-weight:600;">??</span> ${escapeHtml(opts.address)}` : '<span style="color:var(--muted);">Select a location...</span>';
  document.getElementById('mapPickerModal').classList.add('open');
  if(!_mapPickerMap){
    _mapPickerMap = L.map('mapPickerDiv', { scrollWheelZoom: true }).setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: ['a','b','c'],
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(_mapPickerMap);
    _mapPickerMap.on('click', e => {
      setMapPick(e.latlng.lat, e.latlng.lng);
    });
    _mapPickerMap.on('popupopen', e => e.target.invalidateSize());
    setTimeout(() => _mapPickerMap.invalidateSize(), 250);
    setTimeout(() => _mapPickerMap.invalidateSize(), 600);
  } else {
    _mapPickerMap.setView([lat, lng], 13);
    setTimeout(() => _mapPickerMap.invalidateSize(), 250);
    setTimeout(() => _mapPickerMap.invalidateSize(), 600);
  }
  setMapPick(lat, lng, opts.address || '');
}

function setMapPick(lat, lng, addrLabel){
  const latEl = document.getElementById('mapPickedLat');
  const lngEl = document.getElementById('mapPickedLng');
  const addrEl = document.getElementById('mapPickedAddress');
  if(latEl) latEl.value = lat;
  if(lngEl) lngEl.value = lng;
  if(_mapPickerMap){
    if(_mapPickerMarker) _mapPickerMap.removeLayer(_mapPickerMarker);
    _mapPickerMarker = L.marker([lat, lng]).addTo(_mapPickerMap);
  }
  if(!addrLabel){
    loadMapAddress(lat, lng);
  } else if(addrEl){
    addrEl.innerHTML = `<span style="color:var(--accent);font-weight:600;">??</span> ${addrLabel}`;
  }
}

function loadMapAddress(lat, lng){
  const addrEl = document.getElementById('mapPickedAddress');
  if(addrEl) addrEl.innerHTML = '<span class="muted-span" style="color:var(--muted);">Fetching address...</span>';
  fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&namedetails=1&accept-language=en`)
    .then(r => r.json())
    .then(d => {
      let disp = '';
      if(d && d.display_name){
        disp = d.display_name;
        if(d.address && d.address.amenity) disp = d.address.amenity + ', ' + disp;
      } else {
        disp = `${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`;
      }
      if(addrEl) addrEl.innerHTML = `<span style="color:var(--accent);font-weight:600;">📍</span> ${escapeHtml(disp)}`;
    })
    .catch(() => {
      if(addrEl) addrEl.innerHTML = `<span style="color:var(--muted);">${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}</span>`;
    });
}

function searchMapPlace(){
  const q = document.getElementById('mapSearchInput').value.trim();
  const list = document.getElementById('mapSearchList');
  if(!q){ list.style.display='none'; return; }
  fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=15&viewbox=68.0,37.0,97.0,6.0&bounded=1&accept-language=en`)
    .then(r => r.json())
    .then(d => {
      if(!d || !d.length){ list.innerHTML='<div style="padding:8px 12px;color:var(--muted);font-size:12px;">No places found</div>'; list.style.display='block'; return; }
      list.innerHTML = d.map((p,i)=>`<div class="map-search-item" style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border);" onmousedown="event.preventDefault();pickMapSearch(${i})">${escapeHtml(p.display_name)}</div>`).join('');
      list._results = d;
      list.style.display='block';
    })
    .catch(()=>{ list.style.display='none'; });
}

let _mapSearchTimer = null;
function debouncedMapSearch(val){
  clearTimeout(_mapSearchTimer);
  const list = document.getElementById('mapSearchList');
  if(!val.trim()){ list.style.display='none'; return; }
  _mapSearchTimer = setTimeout(() => searchMapPlace(), 400);
}

function pickMapSearch(idx){
  const list = document.getElementById('mapSearchList');
  const res = (list._results||[])[idx];
  list.style.display='none';
  if(!res) return;
  const lat = parseFloat(res.lat), lng = parseFloat(res.lon);
  if(_mapPickerMap) _mapPickerMap.setView([lat, lng], 17);
  setMapPick(lat, lng, res.display_name);
}

function useMyLocation(){
  if(!navigator.geolocation){ notify('Geolocation not supported','error'); return; }
  notify('Detecting your location...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      if(_mapPickerMap) _mapPickerMap.setView([lat, lng], 17);
      setMapPick(lat, lng);
    },
    err => { notify('Could not get location: '+ (err.message||'denied'),'error'); }
  );
}

function confirmMapPick(){
  const lat = document.getElementById('mapPickedLat').value;
  const lng = document.getElementById('mapPickedLng').value;
  const addr = document.getElementById('mapPickedAddress').innerText.trim();
  const result = { lat: parseFloat(lat), lng: parseFloat(lng), address: addr };
  closeMapPicker();
  if(_mapPickerCb) _mapPickerCb(result);
}

function closeMapPicker(){
  document.getElementById('mapPickerModal').classList.remove('open');
  const list = document.getElementById('mapSearchList');
  if(list) list.style.display='none';
}

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function openMapFromData(lat, lng){
  if(!lat || !lng) return;
  window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`, '_blank');
}

function locBtnLabel(loc){
  if(!loc) return '?? Add Location';
  return loc.address ? '?? '+loc.address : '?? '+parseFloat(loc.lat).toFixed(5)+', '+parseFloat(loc.lng).toFixed(5);
}
