'use strict';
/**
 * GSTIN / state-code / place-of-supply helpers.
 * All rules (length, pattern, checksum, state list) come from config.
 */
const { STATE_CODES } = require('./config');

const _ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // base-36 alphabet

function charValue(ch) {
  const i = _ALPHA.indexOf(ch);
  return i < 0 ? -1 : i;
}

/**
 * Validate a GSTIN.
 * @returns {{valid:boolean, reason?:string, stateCode?:string, pan?:string, entity?:string}}
 */
function validateGSTIN(gstin, cfg) {
  const config = cfg || require('./config').DEFAULT_CONFIG;
  const raw = String(gstin || '').trim().toUpperCase();
  if (!raw) return { valid: false, structurallyValid: false, reason: 'EMPTY' };

  const re = new RegExp(config.gstin.pattern);
  if (raw.length !== config.gstin.length) {
    return { valid: false, structurallyValid: false, reason: 'LENGTH', expected: config.gstin.length, got: raw.length };
  }
  if (!re.test(raw)) return { valid: false, structurallyValid: false, reason: 'FORMAT', value: raw };

  const stateCode = raw.slice(0, 2);
  if (!STATE_CODES[stateCode]) return { valid: false, structurallyValid: false, reason: 'STATE_CODE', value: stateCode };

  // From here the string is a well-formed GSTIN naming a real state. That is what
  // decides B2B vs B2C, so it must NOT depend on the check digit — which is only
  // advisory unless checksum.enforced is on. Getting this wrong silently moved a
  // B2B sale into B2C Small because of a warning we were not even blocking on.
  const structural = {
    structurallyValid: true,
    stateCode,
    pan: raw.slice(2, 12),
    entity: raw[12],
    registered: raw[12] !== 'Z', // 'Z' = unregistered/ordinary; composition = 'C'
    composition: raw[12] === 'C',
    value: raw,
  };

  if (config.gstin.checksum && config.gstin.checksum.enabled) {
    if (!checksumOk(raw, config)) return { ...structural, valid: false, reason: 'CHECKSUM' };
  }
  return { ...structural, valid: true };
}

/**
 * GSTIN check digit (base-36, 14-character factor table).
 *
 * NOTE: implemented from the commonly published GSTIN check-digit algorithm.
 * Because a false negative here would BLOCK a legitimate filing, the validator
 * treats a checksum failure as a WARNING unless config.gstin.checksum.enforced
 * is switched on. VERIFY against the GSTN / CBIC specification before enabling
 * enforcement.
 */
const CHECKSUM_FACTORS = [1, 2, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 59, 67];

function checksumOk(gstin, config) {
  if (CHECKSUM_FACTORS.length !== 14) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = charValue(gstin[i]);
    if (v < 0) return false;
    let addend = (v * CHECKSUM_FACTORS[i]) % config.gstin.checksum.base;
    if (addend > 9) addend = Math.floor(addend / 10) + addend;
    sum += addend;
  }
  const codePoint = (config.gstin.checksum.base - (sum % config.gstin.checksum.base)) % config.gstin.checksum.base;
  return _ALPHA[codePoint] === gstin[14];
}

/** Extract the 2-digit state code from a GSTIN (or '' if not parseable). */
function stateCodeOf(gstin) {
  const raw = String(gstin || '').trim().toUpperCase();
  return /^[0-9]{2}/.test(raw) ? raw.slice(0, 2) : '';
}

/** Human-readable state name from a code. */
function stateName(code) {
  return STATE_CODES[String(code || '')] || '';
}

/** Build a reverse map name(lower) → code, for matching free-text addresses. */
function stateNameToCode() {
  const m = {};
  for (const [code, name] of Object.entries(STATE_CODES)) {
    m[name.toLowerCase()] = code;
    // also allow the pre-2019 "Dadra and Nagar Haveli" / "Daman and Diu" names
    if (code === '26') { m['dadra and nagar haveli'] = '26'; m['daman and diu'] = '26'; }
  }
  m['orissa'] = '21';
  m['pondicherry'] = '34';
  return m;
}

/**
 * Resolve a free-text place-of-supply string to a state code.
 * Deterministic: exact name match first, then token containment.
 */
function resolveStateCode(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return '';
  if (/^\d{2}$/.test(t)) return STATE_CODES[t] ? t : '';
  const map = stateNameToCode();
  if (map[t]) return map[t];
  // split on commas / whitespace and try each token, longest first
  const parts = t.split(/[,;|]|\s+/).map((s) => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const p of parts) {
    if (map[p]) return map[p];
  }
  for (const p of parts) {
    if (p.length < 4) continue;
    const hit = Object.keys(map).find((name) => name.length >= 4 && p.includes(name));
    if (hit) return map[hit];
  }
  return '';
}

/** True when the two state codes represent the same jurisdiction. */
function isSameState(a, b) {
  return !!a && !!b && String(a) === String(b);
}

/** True when supply is inter-state (IGST) — different or unknown jurisdiction. */
function isInterState(homeStateCode, placeOfSupply) {
  const h = String(homeStateCode || '').trim();
  const p = String(placeOfSupply || '').trim();
  if (!h || !p) return false; // unknown → treat as intra (safer, flagged by validator)
  return h !== p;
}

module.exports = {
  validateGSTIN,
  checksumOk,
  stateCodeOf,
  stateName,
  stateNameToCode,
  resolveStateCode,
  isSameState,
  isInterState,
};