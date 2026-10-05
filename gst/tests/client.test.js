/**
 * Static checks on the two hand-written browser scripts.
 *
 * shopOS_app.js is ~8700 lines loaded as a plain <script>, so nothing type-checks
 * it, nothing lints it, and the 245 engine/API/delta tests never execute it. Two
 * real bugs got through that way:
 *
 *  - `const totalExpenses = totalExpenses()` shadowed the function inside its own
 *    temporal dead zone, so the dashboard threw on every visit. `node --check`
 *    parses it happily; only running it catches it.
 *  - Renaming a function to reuse its slot deleted `deleteSingleSale` outright,
 *    and every 🗑️ button in the UI silently did nothing.
 *
 * These are deliberately narrow, targeted regexes rather than a parser: they
 * encode the two mistakes that actually happened, so they stay cheap and
 * dependency-free.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Strip comments and the contents of string/template literals, keeping line
 * numbers intact.
 *
 * Without this the scans below match prose: a comment explaining the very bug
 * being checked for reads as the bug, which is the kind of false positive that
 * makes a guard get switched off.
 */
function code(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (two === '/*') {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== '*/') { if (src[i] === '\n') out += '\n'; i++; }
      i++; continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        if (src[i] === '\n') out += '\n';
        i++;
      }
      out += q; continue;
    }
    out += c;
  }
  return out;
}

const APP_RAW = fs.readFileSync(path.join(ROOT, 'shopOS_app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'shopOS_index.html'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'gst_ui.js'), 'utf8');
const APP = code(APP_RAW);

// ── 1. self-referential declarations ──────────────────────────────────────────
// `const totalExpenses = totalExpenses()` reads the identifier before its own
// initialiser has run. Legal syntax, guaranteed ReferenceError at runtime.
test('no declaration initialises itself from the name it declares', () => {
  const bad = [];
  const re = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\1\s*\(/g;
  let m;
  while ((m = re.exec(APP)) !== null) {
    const line = APP.slice(0, m.index).split('\n').length;
    bad.push(`shopOS_app.js:${line} const ${m[1]} = ${m[1]}(...)`);
  }
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

// A local shadowing a global function of the same name is the same trap even
// without the self-call, since the local wins inside its own scope.
test('no local declaration shadows a top-level function name', () => {
  const topLevel = new Set();
  const fnRe = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = fnRe.exec(APP)) !== null) topLevel.add(m[1]);

  const bad = [];
  // locals inside a function body: indentation of 2+ spaces keeps this to locals
  const localRe = /^\s{2,}const\s+([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = localRe.exec(APP)) !== null) {
    const name = m[1];
    if (topLevel.has(name)) {
      const line = APP.slice(0, m.index).split('\n').length;
      bad.push(`shopOS_app.js:${line} local "${name}" shadows the top-level function`);
    }
  }
  assert.deepStrictEqual(bad, [], bad.join('\n'));
});

// ── 2. every handler the UI calls must exist ─────────────────────────────────
// Catches a renamed or clobbered function: the markup keeps calling the old name
// and the button does nothing, with no error anywhere. `deleteSingleSale` was
// clobbered exactly this way and only a manual browser pass noticed.
//
// Scanned over the RAW source, not the stripped one — most of this app's buttons
// are built inside template literals, so scanning the HTML alone misses them.
test('every function called from an inline handler is defined', () => {
  const defined = new Set();
  const collect = (src) => {
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) defined.add(m[1]);
    // `window.foo = function` / `foo = (...) =>` style definitions
    const re2 = /(?:^|[;{\s])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/gm;
    while ((m = re2.exec(src)) !== null) defined.add(m[1]);
  };
  collect(APP_RAW);
  collect(UI);

  const called = new Set();
  const ID = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  const scan = (src) => {
    const callRe = /(?:onclick|onchange|oninput|onsubmit)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = callRe.exec(src)) !== null) {
      const body = m[1] != null ? m[1] : m[2];
      const r = new RegExp(ID.source, 'g');
      let c;
      while ((c = r.exec(body)) !== null) called.add(c[1]);
    }
  };
  scan(HTML);
  scan(APP_RAW);
  scan(UI);

  // Browser and JS globals the page legitimately uses.
  const BUILTIN = new Set([
    'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout',
    'clearInterval', 'requestAnimationFrame', 'parseInt', 'parseFloat', 'Number',
    'String', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON', 'window',
    'document', 'console', 'encodeURIComponent', 'decodeURIComponent', 'if',
    'for', 'while', 'switch', 'return', 'typeof', 'new', 'function', 'fetch',
    'isNaN', 'isFinite', 'structuredClone', 'Intl', 'URL', 'Blob', 'print',
  ]);

  const missing = [...called].filter((n) => !defined.has(n) && !BUILTIN.has(n));
  assert.deepStrictEqual(missing, [],
    `called from a handler but not defined: ${missing.join(', ')}`);
});

// ── 3. cache-busting ──────────────────────────────────────────────────────────
// A stale ?v= silently serves yesterday's JS, which looks exactly like "my fix
// did nothing" and cost real time during development. Vendored third-party
// bundles are excluded: they never change, so a cache-buster buys nothing.
const VENDOR = /xlsx|html2canvas|jspdf|leaflet|jquery|chart/i;

test('every first-party script and stylesheet carries a version tag', () => {
  const tags = [...HTML.matchAll(/<(?:script src|link[^>]*href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:)?\/\//.test(u) && !VENDOR.test(u));
  const missing = tags.filter((u) => !/\?v=\d+/.test(u));
  assert.deepStrictEqual(missing, [],
    `no ?v= cache-buster on: ${missing.join(', ')}`);
});
