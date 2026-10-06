'use strict';
/**
 * The dashboard week chart must agree with the stat cards printed directly above
 * it. It used not to, in two independent ways:
 *
 *  1. Revenue was accumulated inline as `amtPaid || total`. A sale taken entirely
 *     on credit has amtPaid === 0, and `0 || total` is the total, so the whole
 *     amount was counted as revenue even with "include pending udhaar" switched
 *     OFF. calcRevenue uses `amtPaid != null ? amtPaid : total`, which is the
 *     opposite for zero.
 *  2. The loop iterated every sale and never applied inFinancials, so sales the
 *     user had removed from the financial records still grew a bar.
 *
 * Both made the caption total higher than the "Total Revenue" card. Measured on a
 * fixture with a 5,000 credit sale and a hidden 3,000 sale, the chart read
 * 24,800 while the card read 16,800.
 *
 * renderWeekChart runs here for real against a DOM stub: the bars and the caption
 * are parsed back out of the generated HTML, so the assertions are on the numbers
 * a user would actually see rather than on a reimplementation.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', '..', 'shopOS_app.js');
const src = fs.readFileSync(APP, 'utf8');

/** Lift a top-level function (or const) out of the app source. */
function extract(name) {
  const fn = src.indexOf(`function ${name}(`);
  if (fn >= 0) {
    let i = src.indexOf('{', fn), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { i++; break; }
    }
    return src.slice(fn, i);
  }
  const cx = src.indexOf(`const ${name} =`);
  if (cx >= 0) {
    const end = src.indexOf(';', cx) + 1;
    return src.slice(cx, end);
  }
  throw new Error(`${name} not found in shopOS_app.js`);
}

const NEEDED = [
  'fmt', 'inFinancials', 'calcRevenue', 'calcProfit', 'getPurchasePriceAtDate',
  'weekWindowStart', 'weekWindowEnd', '_localDateStr', 'renderWeekChart',
  'WEEK_DAYS', 'WEEK_DAYS_FULL', 'WEEK_LOOKBACK_MAX',
];

/** Run renderWeekChart over the given sales and return what the user would see. */
function renderChart(sales, udhaarMode) {
  const els = {};
  const chart = {
    id: 'weekChart',
    innerHTML: '',
    parentElement: { appendChild() {} },
  };
  const title = { id: 'weekChartTitle', innerHTML: '' };
  const cap = { id: 'weekChartCap', innerHTML: '' };
  els.weekChart = chart;
  els.weekChartTitle = title;

  const sb = {
    console,
    sales,
    _dashUdhaarMode: !!udhaarMode,
    _weekChartOffset: 0,
    WEEK_LOOKBACK_MAX: 23,
    notify() {},
    document: {
      getElementById: (id) => (id === 'weekChartCap' ? cap : els[id] || null),
      createElement: () => cap,
    },
  };
  const c = vm.createContext(sb);
  vm.runInContext(NEEDED.map(extract).join('\n'), c);
  c.renderWeekChart();

  // The bars carry their value in data-val; sum them the way the eye would.
  let barsTotal = 0;
  let barCount = 0;
  for (const m of chart.innerHTML.matchAll(/class="bar-animated"[^>]*data-val="([\d.]+)"/g)) {
    barsTotal += Number(m[1]);
    barCount++;
  }
  let billCount = 0;
  for (const m of chart.innerHTML.matchAll(/class="bar-empty"[^>]*data-val="0"/g)) billCount++;

  const capText = cap.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const m = capText.match(/(\d+)\s+bills?/);
  return {
    barsTotal: Math.round(barsTotal * 100) / 100,
    barCount,
    totalColumns: barCount + billCount,
    captionBills: m ? Number(m[1]) : null,
    capText,
    cardRevenue: c.calcRevenue(sales, !!udhaarMode),
  };
}

function sale(o) {
  return {
    tax: 0, taxApplied: false, docType: 'bill_of_supply', pending: 0,
    items: [], ...o,
  };
}

/** Today at noon, so the sale always lands inside the rolling 7-day window. */
function todayAtNoon() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T12:00:00`;
}

const TODAY = todayAtNoon();

test('the chart agrees with the revenue card when udhaar mode is off', () => {
  const list = [
    sale({ id: 'S1', total: 1000, amtPaid: 1000, date: TODAY }),
    // fully on credit: amtPaid is 0, so this must contribute nothing
    sale({ id: 'S2', total: 5000, amtPaid: 0, pending: 5000, date: TODAY }),
    // removed from the financial records: must not appear at all
    sale({ id: 'S3', total: 3000, amtPaid: 3000, date: TODAY, excludeFinancials: true }),
  ];
  const r = renderChart(list, false);
  assert.strictEqual(r.cardRevenue, 1000);
  assert.strictEqual(r.barsTotal, r.cardRevenue,
    `chart shows ${r.barsTotal} but the card shows ${r.cardRevenue}`);
});

test('the chart agrees with the revenue card when udhaar mode is on', () => {
  const list = [
    sale({ id: 'S1', total: 1000, amtPaid: 1000, date: TODAY }),
    sale({ id: 'S2', total: 5000, amtPaid: 0, pending: 5000, date: TODAY }),
    sale({ id: 'S3', total: 3000, amtPaid: 3000, date: TODAY, excludeFinancials: true }),
  ];
  const r = renderChart(list, true);
  assert.strictEqual(r.cardRevenue, 6000, '1000 collected + 5000 on credit');
  assert.strictEqual(r.barsTotal, r.cardRevenue,
    `chart shows ${r.barsTotal} but the card shows ${r.cardRevenue}`);
});

test('a fully-credit sale is not counted as revenue with udhaar mode off', () => {
  // The exact regression: `amtPaid || total` makes this 5000 instead of 0.
  const r = renderChart([sale({ id: 'S2', total: 5000, amtPaid: 0, pending: 5000, date: TODAY })], false);
  assert.strictEqual(r.barsTotal, 0, 'nothing was collected, so nothing is revenue');
  assert.strictEqual(r.barCount, 0, 'and no bar should be drawn');
});

test('a hidden sale never grows a bar', () => {
  const r = renderChart([sale({ id: 'S3', total: 3000, amtPaid: 3000, date: TODAY, excludeFinancials: true })], true);
  assert.strictEqual(r.barsTotal, 0);
  assert.strictEqual(r.barCount, 0);
  assert.match(r.capText, /no sales in these 7 days/);
});

test('the caption bill count excludes hidden sales', () => {
  const list = [
    sale({ id: 'S1', total: 1000, amtPaid: 1000, date: TODAY }),
    sale({ id: 'S3', total: 3000, amtPaid: 3000, date: TODAY, excludeFinancials: true }),
  ];
  const r = renderChart(list, false);
  assert.strictEqual(r.captionBills, 1, 'only the visible sale is a bill');
  assert.strictEqual(r.totalColumns, 7, 'the window is still seven days wide');
});

test('all seven days are always rendered', () => {
  const r = renderChart([], false);
  assert.strictEqual(r.totalColumns, 7);
  assert.match(r.capText, /no sales in these 7 days/);
});

test('the caption total matches the sum of the bars', () => {
  const list = [
    sale({ id: 'S1', total: 450, amtPaid: 450, date: TODAY }),
    sale({ id: 'S2', total: 1200, amtPaid: 1200, date: TODAY }),
    sale({ id: 'S3', total: 9800, amtPaid: 5000, pending: 4800, date: TODAY }),
  ];
  for (const mode of [false, true]) {
    const r = renderChart(list, mode);
    const shown = Number(r.capText.match(/₹([\d,.]+)\s+revenue/)[1].replace(/,/g, ''));
    assert.strictEqual(shown, r.barsTotal,
      `udhaarMode=${mode}: caption says ${shown}, bars sum to ${r.barsTotal}`);
    assert.strictEqual(shown, r.cardRevenue, `udhaarMode=${mode}: caption vs card`);
  }
});

// ── static guards: the shape that caused it must not come back ─────────────────
test('static: the chart delegates revenue to calcRevenue', () => {
  const b = src.slice(src.indexOf('function renderWeekChart('));
  assert.match(b, /b\.revenue\s*=\s*calcRevenue\(b\.list,\s*_dashUdhaarMode\)/,
    'one shared formula, or the chart drifts from the cards again');
  assert.ok(!/b\.revenue\s*\+=/.test(b),
    'inline accumulation is what let a zero amtPaid fall through to total');
  assert.ok(!/amtPaid\)\s*\|\|/.test(b),
    '`amtPaid || total` counts an uncollected credit sale as revenue');
});

test('static: the chart applies the same inFinancials filter as the cards', () => {
  const b = src.slice(src.indexOf('function renderWeekChart('));
  assert.match(b, /sales\.filter\(inFinancials\)\.forEach/,
    'hidden sales must not reach a bar');
});

test('static: profit and revenue come from the same helpers the cards use', () => {
  const b = src.slice(src.indexOf('function renderWeekChart('));
  assert.match(b, /b\.profit\s*=\s*calcProfit\(b\.list\)/);
});
