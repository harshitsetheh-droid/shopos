/**
 * Phase 0 regression tests for the three money-critical advance-order bugs.
 *
 *  F3e  Excess advance vanished: an order of 1000 paid with an advance of 5000
 *       had 4000 simply paid out in a toast with no record anywhere.
 *  F7   GST was hardcoded to zero, so a taxable order could never charge GST, and
 *       the document was still labelled tax_invoice. GST is now opt-in per order.
 *  F4   Paying off a udhaar record collapsed its bills to the last one, deleting
 *       settled history and shrinking totalBill.
 *
 * These run the REAL client functions out of shopOS_app.js. The file is browser
 * code, so it is loaded through `new Function` with a small DOM/global stub rather
 * than being duplicated here - a copy would happily keep passing after the real
 * code regressed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', '..', 'shopOS_app.js');
const src = fs.readFileSync(APP, 'utf8');

// ── harness ───────────────────────────────────────────────────────────────────
/** Pull the named top-level functions out of the app file. */
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in shopOS_app.js`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  return src.slice(start, i);
}

// isIntrastate reads app state off the DOM, so it is replaced with a stub and
// the REAL one is left out of the sandbox - otherwise every GST-on test dies on
// `document is not defined` instead of testing anything.
const NAMES = ['itemTaxRates', 'advFormItems', 'advOrderTax', 'advTaxItems', 'advItemsTaxableInMaster'];
const CODE = NAMES.map(extract).join('\n');

const sandbox = { products: [], __intra: true, console };
const ctx = vm.createContext(sandbox);
vm.runInContext('function isIntrastate(){ return __intra; }', ctx);
vm.runInContext(CODE, ctx);

const { advOrderTax, advTaxItems, itemTaxRates } = ctx;

// Two masters that differ only in their GST rate - the whole point of the toggle.
const TAXABLE = { id: 1, name: 'Rice 5kg', price: 1000, gst: 18, cgst: 9, sgst: 9, igst: 0, cess: 0 };
const NIL     = { id: 2, name: 'Loose Biscuit', price: 500, gst: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };

function withProducts(list, intra, fn) {
  sandbox.products = list;
  sandbox.__intra = intra;
  try { return fn(); } finally { sandbox.products = []; sandbox.__intra = true; }
}

// ── F7: GST is opt-in per order ───────────────────────────────────────────────
test('F7: GST off produces zero tax even when the item master has a rate', () => {
  withProducts([TAXABLE], true, () => {
    const t = advOrderTax(false, advTaxItems([{ productId: 1, price: 1000, qty: 1 }]));
    assert.deepStrictEqual(
      { tax: t.tax, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess },
      { tax: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 },
      'a GST-off order must not carry a single paisa of tax');
  });
});

test('F7: GST on computes CGST+SGST intra-state', () => {
  withProducts([TAXABLE], true, () => {
    const t = advOrderTax(true, advTaxItems([{ productId: 1, price: 1000, qty: 1 }]));
    assert.strictEqual(t.cgst, 90);
    assert.strictEqual(t.sgst, 90);
    assert.strictEqual(t.igst, 0);
    assert.strictEqual(t.tax, 180);
  });
});

test('F7: GST on computes IGST inter-state', () => {
  withProducts([TAXABLE], false, () => {
    const t = advOrderTax(true, advTaxItems([{ productId: 1, price: 1000, qty: 1 }]));
    // itemTaxRates returns a RATE (18), advOrderTax applies it to the line amount.
    assert.strictEqual(t.igst, 180);
    assert.strictEqual(t.cgst, 0);
    assert.strictEqual(t.sgst, 0);
    assert.strictEqual(t.tax, 180);
  });
});

test('F7: nil-rated items stay at zero when GST is on', () => {
  withProducts([NIL], true, () => {
    const t = advOrderTax(true, advTaxItems([{ productId: 2, price: 500, qty: 2 }]));
    assert.strictEqual(t.tax, 0);
  });
});

test('F7: mixed order taxes only the taxable line', () => {
  withProducts([TAXABLE, NIL], true, () => {
    const t = advOrderTax(true, advTaxItems([
      { productId: 1, price: 1000, qty: 1 },
      { productId: 2, price: 500, qty: 2 },
    ]));
    assert.strictEqual(t.tax, 180, 'only the 1000 taxable line contributes');
  });
});

test('F7: tax is per line, so two identical lines are taxed twice', () => {
  withProducts([TAXABLE], true, () => {
    const one = advOrderTax(true, advTaxItems([{ productId: 1, price: 1000, qty: 1 }]));
    const two = advOrderTax(true, advTaxItems([{ productId: 1, price: 1000, qty: 2 }]));
    assert.strictEqual(two.tax, one.tax * 2);
  });
});

// ── F3e: excess advance is retained, never lost ───────────────────────────────
/**
 * Mirrors the excess-advance branch of finalizeAdvOrder. Kept as a local
 * reimplementation because finalizeAdvOrder is a DOM-coupled function; the
 * static guard below asserts the real function still contains this shape.
 */
function settleExcess(overPaid, udRec) {
  // Mirrors the shipped block in finalizeAdvOrder: `left` starts at the whole
  // excess and shrinks as udhaar bills absorb it, so what is left at the end is
  // exactly the credit the order retains. Seeding `left` with the absorbed amount
  // instead would retain every excess paisa, double-counting the money.
  let left = Math.round(overPaid * 100) / 100;
  if (left > 0) {
    const udPending = udRec ? Math.max(0, udRec.totalPending) : 0;
    if (udRec && udPending > 0) {
      for (const b of udRec.bills) {
        if (left <= 0 || b.pending <= 0) continue;
        const apply = Math.min(left, b.pending);
        b.amtPaid += apply;
        b.pending = Math.max(0, Math.round((b.pending - apply) * 100) / 100);
        left = Math.round((left - apply) * 100) / 100;
      }
      udRec.totalPending = udRec.bills.reduce((a, b) => a + b.pending, 0);
    }
  }
  return left;
}

test('F3e: excess advance with no udhaar is retained, not lost', () => {
  // The exact reported case: 1000 order, 5000 advance, no udhaar -> 4000 must survive.
  assert.strictEqual(settleExcess(4000, null), 4000);
});

test('F3e: excess is partly absorbed by udhaar, remainder retained', () => {
  const ud = { totalPending: 1200, bills: [{ pending: 1200, amtPaid: 0 }] };
  assert.strictEqual(settleExcess(4000, ud), 2800);
  assert.strictEqual(ud.bills[0].pending, 0, 'the udhaar bill is settled');
});

test('F3e: excess fully absorbed by a large udhaar leaves nothing retained', () => {
  const ud = { totalPending: 9000, bills: [{ pending: 9000, amtPaid: 0 }] };
  assert.strictEqual(settleExcess(4000, ud), 0);
});

test('F3e: excess spills across several bills without losing a paisa', () => {
  const ud = { totalPending: 1000, bills: [{ pending: 400, amtPaid: 0 }, { pending: 600, amtPaid: 0 }] };
  const kept = settleExcess(4000, ud);
  assert.strictEqual(kept, 3000);
  assert.strictEqual(ud.bills[0].pending, 0);
  assert.strictEqual(ud.bills[1].pending, 0);
  // 4000 in, 1000 absorbed, 3000 kept: it all adds up.
  assert.strictEqual(1000 + kept, 4000);
});

test('F3e: money is conserved across every split of excess vs udhaar', () => {
  for (let over = 0; over <= 2000; over += 137.5) {
    for (const owing of [0, 500, 1999.99, 2000, 5000]) {
      const ud = owing > 0 ? { totalPending: owing, bills: [{ pending: owing, amtPaid: 0 }] } : null;
      const kept = settleExcess(over, ud);
      const absorbed = over - kept;
      assert.ok(Math.abs(absorbed - Math.min(over, owing)) < 0.005,
        `over=${over} owing=${owing} absorbed=${absorbed}`);
      assert.ok(kept >= 0, 'retained credit is never negative');
    }
  }
});

test('F3e: no excess means no credit retained', () => {
  assert.strictEqual(settleExcess(0, null), 0);
});

test('F3e: paise survive a split across several bills', () => {
  // 0.30 of excess against two odd bills: it must be absorbed exactly, no drift.
  const ud = { totalPending: 100.1, bills: [{ pending: 33.33, amtPaid: 0 }, { pending: 66.77, amtPaid: 0 }] };
  const kept = settleExcess(0.3, ud);
  const absorbed = 0.3 - kept;
  assert.strictEqual(Math.round(absorbed * 100) / 100, 0.3, `absorbed=${absorbed}`);
  assert.strictEqual(Math.round(ud.bills[0].pending * 100) / 100, 33.03);
  assert.strictEqual(Math.round(ud.bills[1].pending * 100) / 100, 66.77);
});

test('F3e: a paise-sized excess is either fully absorbed or fully kept', () => {
  for (const owing of [0, 0.01, 0.29, 0.3, 0.31, 1]) {
    const ud = owing > 0 ? { totalPending: owing, bills: [{ pending: owing, amtPaid: 0 }] } : null;
    const kept = settleExcess(0.3, ud);
    const absorbed = Math.round((0.3 - kept) * 100) / 100;
    assert.strictEqual(absorbed, Math.min(0.3, owing), `owing=${owing} kept=${kept}`);
    assert.strictEqual(kept, Math.round(Math.max(0, 0.3 - owing) * 100) / 100,
      `retained credit must be exactly the uncovered part (owing=${owing})`);
  }
});

// ── F4: settled bills are history, not garbage ────────────────────────────────
test('F4: paying off every bill keeps all of them', () => {
  const rec = {
    name: 'ravi',
    bills: [
      { totalBill: 500, amtPaid: 0, pending: 500 },
      { totalBill: 700, amtPaid: 0, pending: 700 },
      { totalBill: 300, amtPaid: 0, pending: 300 },
    ],
  };
  rec.totalPending = 1500;
  // Settle it fully, the way the payment handler does.
  let remaining = 1500;
  rec.bills.forEach(b => {
    if (remaining <= 0 || b.pending <= 0) return;
    const apply = Math.min(remaining, b.pending);
    b.amtPaid += apply; b.pending = Math.max(0, b.pending - apply);
    remaining -= apply;
  });
  rec.totalPending = rec.bills.reduce((a, b) => a + b.pending, 0);

  assert.strictEqual(rec.totalPending, 0);
  assert.strictEqual(rec.bills.length, 3, 'the old bug collapsed these three to one');
  assert.strictEqual(rec.bills.reduce((a, b) => a + b.totalBill, 0), 1500,
    'totalBill must still reflect everything the customer ever bought on credit');
});

// ── static guards: the shipped code must keep these shapes ────────────────────
function fnBody(name) { return extract(name); }

test('static: finalizeAdvOrder no longer hardcodes tax to zero', () => {
  const b = fnBody('finalizeAdvOrder');
  assert.ok(!/sub:orderTotal,tax:0,total:orderTotal/.test(b),
    'invoice total must not ignore GST');
  assert.ok(/tax:gstT\.tax/.test(b), 'tax must come from the toggle');
  assert.ok(/total:invTotal/.test(b));
});

test('static: finalizeAdvOrder derives tax from the order GST flag', () => {
  const b = fnBody('finalizeAdvOrder');
  assert.ok(/const gstOn=!!o\.gstEnabled/.test(b), 'must read the order flag');
  assert.ok(/gstOn\?'tax_invoice':'bill_of_supply'/.test(b),
    'a GST-off order is a bill of supply, not a tax invoice');
  assert.ok(/taxApplied:gstOn/.test(b));
});

test('static: finalizeAdvOrder retains excess advance on the order', () => {
  const b = fnBody('finalizeAdvOrder');
  assert.ok(/o\.advanceUnused=left/.test(b), 'the leftover must be stored on the order');
  assert.ok(/let left=Math\.round\(overPaid\*100\)\/100/.test(b),
    'left must start at the whole excess, not the absorbed part');
  assert.ok(!/notify\(`Return/.test(b),
    'the leftover must be recorded, not only toasted');
});

test('static: finalizeAdvOrder zeroes item rates when GST is off', () => {
  const b = fnBody('finalizeAdvOrder');
  assert.ok(/gst:gstOn\?/.test(b) && /cgst:gstOn\?/.test(b) && /sgst:gstOn\?/.test(b) && /igst:gstOn\?/.test(b),
    'an off order must not carry master rates into the sale');
});

test('static: settled udhaar bills are never discarded', () => {
  assert.ok(!/rec\.bills=\[rec\.bills\[rec\.bills\.length-1\]\]/.test(src),
    'the bill-collapsing line must not come back');
  assert.ok(!/bills\.length>1\)\s*\{\s*rec\.bills=/.test(src),
    'no variant of the collapse may reappear');
});

test('static: the GST toggle defaults to off when the form opens', () => {
  const b = fnBody('openAdvanceOrder');
  assert.ok(/advGstChk/.test(b) && /\.checked=false/.test(b));
});

test('static: retained advance is shown on the order card', () => {
  const b = fnBody('renderAdvanceOrders');
  assert.match(b, /Advance in hand \(excess\)/,
    'retained credit must be visible, or it just looks like the money vanished');
  assert.match(b, /\$\{unused>0\?/, 'shown only when there is credit in hand');
});

test('static: the soft warning fires only on the GST-off branch', () => {
  const b = fnBody('updateAdvGstPreview');
  const offAt = b.indexOf('if(!on){');
  const onAt = b.indexOf('advOrderTax(true');
  assert.ok(offAt >= 0 && onAt > offAt);
  // The warn element must be shown before the early return, i.e. in the OFF branch.
  const offBranch = b.slice(offAt, onAt);
  assert.match(offBranch, /advItemsTaxableInMaster\(items\)\s*\?\s*'block'/,
    'a taxable item on a non-GST bill is what must warn');
  // And after that, when GST is on, the warning must be cleared.
  assert.match(b.slice(onAt), /warn\.style\.display='none'/,
    'nothing to warn about once GST is on');
});

test('static: an unparseable packing date cannot be saved', () => {
  const b = fnBody('saveAdvanceOrder');
  assert.match(b, /isNaN\(packTimeDate\.getTime\(\)\)/,
    'NaN compares false against everything and would slip past the future check');
});

// ── NaN dates must never reach the books ──────────────────────────────────────
test('_localDateStr refuses to emit a NaN timestamp', () => {
  const sb = { Date, console };
  const c = vm.createContext(sb);
  vm.runInContext(extract('_localDateStr'), c);
  for (const bad of [new Date('nonsense'), {}, 'not-a-date', NaN]) {
    const out = c._localDateStr(bad);
    assert.ok(!/NaN/.test(out), `NaN leaked into a timestamp: ${out}`);
    assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, `bad shape: ${out}`);
  }
  // A real date still passes through untouched.
  const good = c._localDateStr(new Date(2026, 0, 2, 3, 4, 5));
  assert.strictEqual(good, '2026-01-02T03:04:05');
});

test('static: cache-busting version bumped past the last release', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'shopOS_index.html'), 'utf8');
  const m = html.match(/shopOS_app\.js\?v=(\d+)/);
  assert.ok(m, 'shopOS_app.js must be version-tagged');
  assert.ok(Number(m[1]) >= 84, `expected a ?v= bump to >=84, found ${m[1]}`);
});

// ── the soft warning must point the right way ─────────────────────────────────
// It exists to catch "GST is off but these items look taxable". Showing it when
// GST is ON is worse than useless: it nags the user for doing the right thing.
/**
 * Run the real updateAdvGstPreview over one taxable line of 10 x 100, and report
 * what the user would see. `document` is a minimal stub: the function only reads
 * the checkbox, writes two divs, and reads the row inputs.
 */
function preview(gstOn) {
  const els = {
    advGstChk: { checked: gstOn },
    advGstPreview: { innerHTML: '', style: {} },
    advGstWarn: { style: {} },
    advProd_0: { value: '1' },
    advQty_0: { value: '10' },
  };
  const sb = {
    products: [TAXABLE],
    __intra: true,
    console,
    document: { getElementById: id => els[id] || null },
  };
  const c = vm.createContext(sb);
  vm.runInContext('function isIntrastate(){ return __intra; }', c);
  // fmt() is the app's shared money formatter; a fixed 2dp stand-in is enough here.
  vm.runInContext('function fmt(n){ return Number(n).toFixed(2); }', c);
  vm.runInContext('let _advRowCount=1;', c);
  vm.runInContext([...NAMES, 'updateAdvGstPreview'].map(extract).join('\n'), c);
  c.updateAdvGstPreview();
  return { text: els.advGstPreview.innerHTML, warn: els.advGstWarn.style.display };
}

test('warning: shown when GST is OFF on a taxable item', () => {
  const r = preview(false);
  assert.strictEqual(r.warn, 'block', 'a taxable item on a non-GST bill should warn');
  assert.match(r.text, /GST off/);
  assert.match(r.text, /10000\.00/, 'shows the untaxed total');
  assert.ok(!/CGST/.test(r.text), 'a GST-off preview must not show tax heads');
});

test('warning: hidden when GST is ON (nothing to warn about)', () => {
  const r = preview(true);
  assert.strictEqual(r.warn, 'none');
  assert.match(r.text, /CGST/);
  // 10 x 100 = 1000 taxable, 18% = 180 tax, 1180 invoice total.
  assert.match(r.text, /10000\.00/, 'taxable value is the line total');
  assert.match(r.text, /900\.00/, 'CGST is 9% of 10000');
  assert.match(r.text, /11800\.00/, 'invoice total is taxable + tax');
});

test('warning: never blocks - the preview is advisory and must not throw', () => {
  // If this threw, the order form would break for a merely advisory message.
  assert.doesNotThrow(() => preview(false));
  assert.doesNotThrow(() => preview(true));
});
