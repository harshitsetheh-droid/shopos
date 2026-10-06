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
  'weekMonday', 'weekWindowStart', 'weekWindowEnd', 'daysBetween',
  'shiftWeekChart', 'shiftWeekChartDay', 'stepWeekChartWindow', 'resetWeekChart',
  '_localDateStr', 'renderWeekChart',
  'WEEK_DAYS', 'WEEK_DAYS_FULL', 'WEEK_LOOKBACK_MAX',
];

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Run renderWeekChart over the given sales and return what the user would see. */
function renderChart(sales, udhaarMode, startBack = 0) {
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
    _weekChartStartBack: startBack,
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
  let emptyCount = 0;
  for (const m of chart.innerHTML.matchAll(/class="bar-empty[^"]*"[^>]*data-val="0"/g)) emptyCount++;

  // Read the rendered columns back out, exactly as the user sees them.
  const cols = [];
  const colRe = /<div class="bar-col([^"]*)" data-date="([^"]+)"[\s\S]*?<div class="bar-label[^"]*"[^>]*>([A-Za-z]+)<span class="bar-date">(\d+)<\/span>/g;
  for (const m of chart.innerHTML.matchAll(colRe)) {
    cols.push({
      classes: m[1].trim(),
      date: m[2].slice(0, 10),
      weekday: m[3],
      dayNum: Number(m[4]),
    });
  }

  const capText = decodeEntities(cap.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const m = capText.match(/(\d+)\s+bills?/);
  return {
    barsTotal: Math.round(barsTotal * 100) / 100,
    barCount,
    totalColumns: barCount + emptyCount,
    cols,
    captionBills: m ? Number(m[1]) : null,
    capText,
    cardRevenue: c.calcRevenue(sales, !!udhaarMode),
    ctx: c,
  };
}

/** The chart emits HTML entities, so resolve them the way a browser would. */
function decodeEntities(s) {
  return s
    .replace(/&#8377;/g, '\u20b9')
    .replace(/&ndash;/g, '-')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&amp;/g, '&');
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

// ── the day/date mapping ─────────────────────────────────────────────────────
// This was the original defect: the grid walked 7 days back from today and then
// labelled THOSE seven columns Mon..Sun in order, so with today being a Tuesday
// the first column was a Wednesday sitting under a "Mon" label.

/** Every rendered column's weekday name and day number must match its date. */
function assertLabelsMatchDates(cols, ctx) {
  assert.strictEqual(cols.length, 7, 'the chart is always seven days wide');
  for (const c of cols) {
    const d = new Date(`${c.date}T00:00:00`);
    assert.strictEqual(c.weekday, WD[d.getDay()],
      `${c.date} is a ${WD[d.getDay()]} but is labelled ${c.weekday}`);
    assert.strictEqual(c.dayNum, d.getDate(),
      `${c.date} is labelled day ${c.dayNum}`);
  }
}

test('labels match their dates at the default view', () => {
  const r = renderChart([sale({ id: 'S1', total: 1000, amtPaid: 1000, date: TODAY })], false);
  assertLabelsMatchDates(r.cols);
});

test('labels match their dates after every day-scroll', () => {
  for (let back = 0; back <= 8; back++) {
    const r = renderChart([sale({ id: 'S1', total: 1000, amtPaid: 1000, date: TODAY })], false, back);
    assertLabelsMatchDates(r.cols);
  }
});

test('labels match their dates in previous weeks', () => {
  for (const back of [7, 14, 21, 28]) {
    const r = renderChart([], false, back);
    assertLabelsMatchDates(r.cols);
  }
});

test('the default view runs Monday to Sunday', () => {
  const r = renderChart([], false);
  assert.deepStrictEqual(r.cols.map((c) => c.weekday),
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('a week step lands on a Monday-first week again', () => {
  const r = renderChart([], false, 7);
  assert.deepStrictEqual(r.cols.map((c) => c.weekday),
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('a sale keeps its bar under the right day when the window moves', () => {
  // The whole point of the mapping fix: a bar must not drift to another day.
  const s = sale({ id: 'S1', total: 1000, amtPaid: 1000, date: TODAY });
  const day = TODAY.slice(0, 10);
  for (const back of [0, 1, 3, 6, 7, 10]) {
    const r = renderChart([s], false, back);
    assertLabelsMatchDates(r.cols);
    if (r.cols.some((c) => c.date === day)) {
      assert.strictEqual(r.barCount, 1, `back=${back}: sale vanished or duplicated`);
      assert.strictEqual(r.barsTotal, 1000);
    } else {
      assert.strictEqual(r.barCount, 0, `back=${back}: sale shown outside the window`);
    }
  }
});

// ── future days ──────────────────────────────────────────────────────────────

test('days after today are marked future and never carry a bar', () => {
  const today = TODAY.slice(0, 10);
  for (const back of [0, 2, 5, 7, 17]) {
    const r = renderChart([sale({ id: 'S1', total: 1000, amtPaid: 1000, date: TODAY })], false, back);
    for (const c of r.cols) {
      const shouldBeFuture = c.date > today;
      assert.strictEqual(/\bfuture\b/.test(c.classes), shouldBeFuture,
        `${c.date}: future flag wrong at back=${back}`);
    }
  }
});

test('today is never treated as future', () => {
  const r = renderChart([], false);
  const t = r.cols.find((c) => c.date === TODAY.slice(0, 10));
  assert.ok(t, 'today must have a column');
  assert.ok(!/\bfuture\b/.test(t.classes), 'today is not in the future');
});

test('a week entirely in the past has no future days', () => {
  const r = renderChart([], false, 21);
  assert.strictEqual(r.cols.filter((c) => /\bfuture\b/.test(c.classes)).length, 0);
});

// ── day vs week stepping ─────────────────────────────────────────────────────

/** Drive the real shift helpers and report the window after each step. */
function step(startBack, fn) {
  const sb = {
    console, sales: [], _dashUdhaarMode: false,
    _weekChartStartBack: startBack,
    notify() {},
  };
  const c = vm.createContext(sb);
  // renderWeekChart is deliberately NOT loaded here: the shift helpers only call
  // it to repaint, and it needs a DOM. These tests are about the window maths.
  vm.runInContext(NEEDED.filter((n) => n !== 'renderWeekChart').map(extract).join('\n'), c);
  vm.runInContext('function renderWeekChart(){}', c);
  fn(c);
  const start = c.weekWindowStart();
  const p = (n) => String(n).padStart(2, '0');
  return {
    startBack: c._weekChartStartBack,
    start: `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`,
    weekday: WD[start.getDay()],
  };
}

test('one day back moves the window by exactly one day', () => {
  for (let back = 0; back < 8; back++) {
    const a = step(back, (c) => {});
    const b = step(back, (c) => c.shiftWeekChartDay(1));
    const diff = Math.round(
      (new Date(`${b.start}T00:00:00`) - new Date(`${a.start}T00:00:00`)) / 86400000);
    assert.strictEqual(diff, -1, `from startBack=${back} the window moved ${diff} days`);
  }
});

test('day stepping is continuous across the week boundary', () => {
  // The bug this replaced: peeling days off a week meant the step after the peel
  // was exhausted jumped a whole week, so holding "1 day" skipped six days.
  let cur = 0;
  const starts = [step(0, () => {}).start];
  for (let i = 0; i < 14; i++) {
    const r = step(cur, (c) => c.shiftWeekChartDay(1));
    starts.push(r.start);
    cur = r.startBack;
  }
  for (let i = 1; i < starts.length; i++) {
    const diff = Math.round(
      (new Date(`${starts[i]}T00:00:00`) - new Date(`${starts[i - 1]}T00:00:00`)) / 86400000);
    assert.strictEqual(diff, -1, `step ${i} moved the window by ${diff} days, expected -1`);
  }
});

test('a week back moves seven days and keeps Monday first', () => {
  const a = step(0, (c) => c.shiftWeekChart(7));
  assert.strictEqual(a.startBack, 7);
  assert.strictEqual(a.weekday, 'Mon');
  const diff = Math.round(
    (new Date(`${a.start}T00:00:00`) - new Date(`${step(0, () => {}).start}T00:00:00`)) / 86400000);
  assert.strictEqual(diff, -7);
});

test('day stepping never goes past the lookback limit', () => {
  const r = step(28, (c) => c.shiftWeekChartDay(1));
  assert.ok(r.startBack <= 28, `startBack ran past the cap: ${r.startBack}`);
});

test('forward stepping cannot go past the live week', () => {
  for (const fn of ['shiftWeekChartDay', 'shiftWeekChart']) {
    const r = step(0, (c) => c[fn](-1));
    assert.strictEqual(r.startBack, 0, `${fn}: nothing to move, already at the live week`);
  }
  // and forward from a scrolled position walks back towards live
  const r = step(3, (c) => c.shiftWeekChartDay(-1));
  assert.strictEqual(r.startBack, 2);
});

test('reset returns to the live week', () => {
  const r = step(21, (c) => c.resetWeekChart());
  assert.strictEqual(r.startBack, 0);
  assert.strictEqual(r.weekday, 'Mon');
});

test('the lookback cap still spans several whole weeks', () => {
  // A top-level const in the app, so read it out of the source rather than
  // expecting it to be in scope here.
  const declared = extract('WEEK_LOOKBACK_MAX').match(/=\s*(\d+)/);
  assert.ok(declared, 'WEEK_LOOKBACK_MAX must be a plain number');
  assert.ok(Number(declared[1]) >= 28, 'at least four previous weeks must be reachable');
});

test('static: weekday labels come from the date, never from the column index', () => {
  const b = src.slice(src.indexOf('function renderWeekChart('));
  assert.match(b, /const wd = \(date\.getDay\(\) \+ 6\) % 7/,
    'the weekday must be derived from the date');
  assert.ok(!/WEEK_DAYS\.map\(\(label, i\)/.test(b),
    'indexing the day names by column position is the bug that mislabelled every bar');
});

test('static: future days are excluded from the bar height', () => {
  const b = src.slice(src.indexOf('function renderWeekChart('));
  assert.match(b, /const hasBar = !isFuture && b\.revenue > 0/);
});

test('static: both a day and a week control are offered', () => {
  const b = src.slice(src.indexOf('function renderWeekChart('));
  for (const id of ['weekPrevDay', 'weekNextDay', 'weekPrevWeek', 'weekNextWeek']) {
    assert.match(b, new RegExp(id), `missing the ${id} control`);
  }
});

// ── stat cards ───────────────────────────────────────────────────────────────
// A five-figure total needs roughly twice the width of a stat card at its display
// size, and was being cut off mid-number: the dashboard read as a truncated figure
// rather than a large one. Only visible once the numbers got big, which is why a
// screenshot caught it and the arithmetic tests did not.

function runFmt() {
  const sb = { console };
  const c = vm.createContext(sb);
  // fmtCompactRs falls through to fmt for amounts under ten thousand, so both
  // have to be in scope or the small-number cases throw instead of asserting.
  vm.runInContext(`${extract('fmt')}\n${extract('fmtCompactRs')}`, c);
  return c.fmtCompactRs;
}

test('compact amounts: small numbers keep their exact paise', () => {
  const f = runFmt();
  assert.strictEqual(f(0), '0.00');
  assert.strictEqual(f(1234.5), '1234.50');
  assert.strictEqual(f(9999.99), '9999.99');
});

test('compact amounts: thousands, lakhs and crores', () => {
  const f = runFmt();
  assert.strictEqual(f(10000), '10.0K');
  assert.strictEqual(f(47189), '47.2K');
  assert.strictEqual(f(228750.82), '2.29L');
  assert.strictEqual(f(12345678), '1.23Cr');
});

test('compact amounts: the label carries no space, so it cannot wrap', () => {
  const f = runFmt();
  for (const v of [47189, 228750.82, 12345678, -228750.82]) {
    assert.ok(!/\s/.test(f(v)), `"${f(v)}" contains a space and can break onto two lines`);
  }
});

test('compact amounts: negatives keep their sign', () => {
  const f = runFmt();
  assert.strictEqual(f(-228750.82), '-2.29L');
  assert.ok(f(-500).startsWith('-'));
});

test('compact amounts: never longer than the full figure it replaces', () => {
  const f = runFmt();
  for (const v of [0, 99, 1234.5, 10000, 47189, 228750.82, 12345678, 99999999]) {
    assert.ok(f(v).length <= new String(Number(v).toFixed(2)).length,
      `${v}: "${f(v)}" is longer than the raw amount`);
  }
});

test('static: stat values must not wrap, and must be fitted to their card', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'shopOS_style.css'), 'utf8');
  assert.match(css, /\.stat-value\{[^}]*white-space:nowrap/,
    'a wrapping stat value made one card taller than its neighbours');
  assert.match(src, /function fitStatValues\(\)/,
    'the fitter is what keeps an oversized amount from being clipped');
  assert.match(src, /fitStatValues\(\);\s*\n\s*renderWeekChart\(\);/,
    'the fitter must run right after the cards are written');
});

test('static: every money card keeps its exact amount reachable', () => {
  const b = src.slice(src.indexOf("getElementById('statsRow')").innerHTML);
  const money = b.match(/class="stat-value[^"]*"[^>]*>[^<]*</g) || [];
  const compact = money.filter((m) => /fmtCompactRs/.test(m));
  assert.ok(compact.length >= 5, `expected 5 compact money cards, found ${compact.length}`);
  for (const m of compact) {
    assert.match(m, /data-exact=/, `card without an exact-amount tooltip: ${m}`);
  }
});
