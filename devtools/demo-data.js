/**
 * Demo data for ShopOS — a small-shop week (and a few weeks of history) so the
 * dashboard chart, reports and reminders can be judged with something on screen
 * instead of a single bar.
 *
 * This file is NOT referenced from shopOS_index.html. Load it deliberately:
 *
 *     fetch('/devtools/demo-data.js').then(r => r.text()).then(eval)
 *     seedDemoData()        // add
 *     clearDemoData()       // remove everything this file created
 *
 * Everything it creates is tagged, so clearDemoData can take it all back out
 * without touching real records:
 *   - customers are named "DEMO <name>"
 *   - products are named "DEMO <name>" and carry demo: true
 *   - sales carry demo: true on the row itself
 *
 * Deliberately shaped like a real small shop, not a uniform sample:
 *   - weekends busier than weekdays, which is what makes a week chart readable
 *   - a couple of dead days, so the "no sales" stub is exercised
 *   - a mix of GST-on tax invoices and plain bills of supply, because GST is
 *     opt-in per document in this app
 *   - some bills part-paid, so the chart has to respect amtPaid vs total
 *
 * Money is integer paise until the very last step, so the totals do not drift.
 */
(function () {
  'use strict';

  // ── deterministic pseudo-random, so repeated runs produce the same shop ─────
  // Without this the demo changes every reload and you cannot tell a real
  // regression from a different random draw.
  let _seed = 20261006;
  function rnd() {
    _seed = (_seed * 1664525 + 1013904223) % 4294967296;
    return _seed / 4294967296;
  }
  function rint(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }
  function pick(arr) { return arr[rint(0, arr.length - 1)]; }

  const FIRST = ['Ramesh', 'Sunita', 'Imran', 'Kavita', 'Deepak', 'Meena', 'Suresh', 'Priya',
    'Arjun', 'Farida', 'Vikram', 'Anita', 'Rohit', 'Sneha', 'Manoj', 'Kiran'];
  const LAST = ['Sharma', 'Patel', 'Khan', 'Nair', 'Yadav', 'Joshi', 'Reddy', 'Iyer'];

  // paise per unit, and the GST rate that applies when the document is GST-on
  const CATALOG = [
    { name: 'Rice 5kg', price: 10000, cost: 6000, gst: 0, hsn: '1006' },
    { name: 'Wheat Atta 10kg', price: 28000, cost: 22000, gst: 5, hsn: '1101' },
    { name: 'Sunflower Oil 1L', price: 14500, cost: 12500, gst: 12, hsn: '1512' },
    { name: 'Sugar 1kg', price: 4500, cost: 3900, gst: 0, hsn: '1701' },
    { name: 'Tea Powder 250g', price: 32000, cost: 27500, gst: 5, hsn: '0902' },
    { name: 'Soap Pack of 4', price: 12000, cost: 9000, gst: 18, hsn: '3401' },
    { name: 'Biscuits 200g', price: 6000, cost: 4800, gst: 18, hsn: '1905' },
    { name: 'Batter Mix 1kg', price: 5500, cost: 4200, gst: 12, hsn: '2106' },
  ];

  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Demo products, one per catalogue row. Returns the created array. */
  function seedDemoProducts() {
    const existing = new Set((typeof products !== 'undefined' ? products : []).map((p) => p.name));
    const made = [];
    let nextId = (typeof products !== 'undefined' && products.length)
      ? Math.max.apply(null, products.map((p) => Number(p.id) || 0)) + 1 : 1;

    for (const c of CATALOG) {
      if (existing.has('DEMO ' + c.name)) continue;
      const p = {
        id: nextId++,
        name: 'DEMO ' + c.name,
        price: c.price / 100,
        price5: 0, price10: 0,
        stock: 9999,
        catId: 0,
        emoji: '🛍️',
        image: '',
        description: 'Demo product created by demo-data.js',
        sku: 'DEMO-' + c.hsn,
        low: 0,
        noOfBoxes: 0, noOfPieces: 0, piecesPerBox: 1,
        gst: c.gst, cgst: c.gst ? c.gst / 2 : 0, sgst: c.gst ? c.gst / 2 : 0, igst: 0,
        cess: 0,
        hsn: c.hsn,
        unit: 'pc',
        weightPerPrice: 0,
        purchasePrice: c.cost / 100,
        lastPurchaseDate: dateKey(new Date()),
        demo: true,
      };
      made.push(p);
    }
    if (made.length && typeof products !== 'undefined') products.push(...made);
    return made;
  }

  /** One bill. Everything is accumulated in paise and rounded once, at the end. */
  function buildSale(date, index, demoProducts, opts) {
    const o = opts || {};
    const lineCount = rint(1, 4);
    const chosen = [];
    for (let i = 0; i < lineCount; i++) {
      const p = pick(demoProducts);
      if (!chosen.some((c) => c.p.id === p.id)) chosen.push({ p, qty: rint(1, 6) });
    }

    const lines = chosen.map(({ p, qty }) => {
      const base = Math.round(p.price * 100) * qty;          // paise
      const rate = o.gstOn ? (p.gst || 0) : 0;
      const tax = Math.round(base * rate) / 100;
      const intra = rate > 0;
      return {
        id: p.id,
        name: p.name,
        qty,
        price: p.price,
        customPrice: null,
        gst: rate,
        cgst: intra ? rate / 2 : 0,
        sgst: intra ? rate / 2 : 0,
        igst: intra ? 0 : rate,
        cess: 0,
        hsn: p.hsn,
        uqc: 'NOS',
        purchasePrice: p.purchasePrice,
        taxPaise: tax,
        basePaise: base,
      };
    });

    const subPaise = lines.reduce((a, l) => a + l.basePaise, 0);
    const taxPaise = lines.reduce((a, l) => a + l.taxPaise, 0);
    const totalPaise = subPaise + taxPaise;
    const toR = (paise) => Math.round(paise) / 100;

    // Part-paid bills exist so the chart has to respect amtPaid over total.
    let amtPaidPaise = totalPaise;
    if (o.partPaid) amtPaidPaise = Math.round(totalPaise * (rint(30, 80) / 100));

    const cust = o.customer;
    return {
      id: 'DEMO-' + dateKey(date) + '-' + String(index).padStart(3, '0'),
      demo: true,
      customerName: 'DEMO ' + cust,
      customerPhone: '9' + String(rint(100000000, 999999999)),
      customerLocation: '',
      intra: true,
      isInterstate: false,
      items: lines.map(({ taxPaise: _t, basePaise: _b, ...l }) => l),
      sub: toR(subPaise),
      tax: toR(taxPaise),
      total: toR(totalPaise),
      method: pick(['Cash', 'UPI', 'Card']),
      amtPaid: toR(amtPaidPaise),
      pending: toR(totalPaise - amtPaidPaise),
      date: `${dateKey(date)}T${pad(rint(9, 20))}:${pad(rint(0, 59))}:00`,
      taxApplied: !!o.gstOn,
      payType: amtPaidPaise >= totalPaise ? 'paid' : 'partial',
      change: 0,
      udhaarIncluded: false,
      extraUdhaarAmount: 0,
      hidden: false,
      docType: o.gstOn ? 'tax_invoice' : 'bill_of_supply',
      invoiceNo: o.gstOn ? 'DEMO/' + dateKey(date).replace(/-/g, '') + '/' + String(index).padStart(3, '0') : '',
      invoiceSeries: o.gstOn ? 'DEMO' : '',
      custGstin: '',
      placeOfSupply: o.stateCode || '27',
      supplyType: 'domestic',
      docStatus: 'finalised',
      reverseCharge: false,
    };
  }

  /**
   * Add `weeks` of demo history ending today.
   * Returns a summary rather than the rows, so the caller can print something
   * useful without holding the whole array.
   */
  async function seedDemoData(opts) {
    const o = Object.assign({ weeks: 5, save: true }, opts || {});
    if (typeof sales === 'undefined') throw new Error('not on the ShopOS page');

    _seed = 20261006;                                   // same shop every run
    clearDemoData({ silent: true, forget: true });

    const demoProducts = seedDemoProducts();
    const stateCode = (typeof _authUser === 'object' && _authUser && _authUser.stateCode) || '27';

    const totalDays = o.weeks * 7;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // A real shop rests once in a while. Two dead days makes the "no sales"
    // stub visible instead of theoretical.
    const deadDays = new Set([11, totalDays - 3]);

    const made = [];
    for (let back = totalDays - 1; back >= 0; back--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      if (deadDays.has(back)) continue;

      const dow = d.getDay();                            // 0 Sun .. 6 Sat
      const isWeekend = dow === 0 || dow === 6;
      const bills = isWeekend ? rint(8, 16) : rint(2, 8);

      for (let i = 0; i < bills; i++) {
        const cust = pick(FIRST) + ' ' + pick(LAST);
        made.push(buildSale(d, i, demoProducts, {
          // GST is opt-in per document, so most bills are plain.
          gstOn: rnd() < 0.18,
          partPaid: rnd() < 0.10,
          customer: cust,
          stateCode,
        }));
      }
    }

    sales.push(...made);
    if (o.save) {
      await saveAllData();
      renderDashboard();
    }
    return {
      sales: made.length,
      products: demoProducts.length,
      days: totalDays,
      from: made.length ? made[0].date.slice(0, 10) : null,
      to: made.length ? made[made.length - 1].date.slice(0, 10) : null,
      gstInvoices: made.filter((s) => s.taxApplied).length,
      partPaid: made.filter((s) => s.pending > 0).length,
    };
  }

  /** Remove everything this file created. Safe to call when there is none. */
  function clearDemoData(opts) {
    const o = Object.assign({ silent: false, forget: false }, opts || {});
    if (typeof sales === 'undefined') throw new Error('not on the ShopOS page');

    const before = sales.length;
    sales = sales.filter((s) => !s.demo && !/^DEMO /.test(s.customerName || ''));
    let removedProducts = 0;
    if (!o.forget && typeof products !== 'undefined') {
      const keep = [];
      for (const p of products) {
        if (p.demo || /^DEMO /.test(p.name || '')) removedProducts++;
        else keep.push(p);
      }
      products.length = 0;
      products.push(...keep);
    }
    let removedLedgers = 0;
    if (typeof customerLedgers !== 'undefined') {
      const keep = [];
      for (const l of customerLedgers) {
        if (/^DEMO /.test(l.customerName || '')) removedLedgers++;
        else keep.push(l);
      }
      customerLedgers.length = 0;
      customerLedgers.push(...keep);
    }

    const removed = before - sales.length;
    if (!o.silent && removed) {
      notify(`Removed ${removed} demo sale${removed === 1 ? '' : 's'}`
        + (removedProducts ? `, ${removedProducts} demo products` : ''), 'success');
    }
    return { sales: removed, products: removedProducts, ledgers: removedLedgers };
  }

  window.seedDemoData = seedDemoData;
  window.clearDemoData = clearDemoData;
  if (typeof notify === 'function') {
    notify('demo-data.js loaded — seedDemoData() / clearDemoData()', 'success');
  }
})();