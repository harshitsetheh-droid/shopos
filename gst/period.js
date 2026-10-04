'use strict';
/**
 * Return-period and financial-year helpers.
 * Indian financial year: April 1 → March 31 (config-driven).
 */
const { DEFAULT_CONFIG } = require('./config');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "YYYY-MM" of a Date's financial-year start. e.g. 2026-08-15 → "2026-04" */
function financialYearStart(dateStr, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  const d = toDate(dateStr);
  if (!d) return null;
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1..12
  const startMonth = config.financialYear.startMonth; // 4
  const fyStartY = m >= startMonth ? y : y - 1;
  return `${fyStartY}-${String(startMonth).padStart(2, '0')}`;
}

/** Label like "2026-27" */
function financialYearLabel(dateStr, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  const start = financialYearStart(dateStr, config);
  if (!start) return '';
  const sy = Number(start.slice(0, 4));
  return `${sy}-${String(sy + 1).slice(2)}`;
}

/** Return period "YYYY-MM" for a date (a normal return period = calendar month). */
function returnPeriod(dateStr) {
  const d = toDate(dateStr);
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Start date (inclusive) of a return period "YYYY-MM". */
function periodStart(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0, 0);
}

/** End date (exclusive) of a return period. */
function periodEnd(period) {
  const s = periodStart(period);
  if (!s) return null;
  return new Date(s.getFullYear(), s.getMonth() + 1, 1, 0, 0, 0, 0);
}

/** True when `dateStr` falls inside `period`. */
function isInPeriod(dateStr, period) {
  const s = periodStart(period);
  const e = periodEnd(period);
  if (!s || !e) return false;
  const d = toDate(dateStr);
  if (!d) return false;
  return d >= s && d < e;
}

/** Every return period in a financial year, e.g. 2026-04 .. 2027-03 */
function periodsInFY(dateStr, cfg) {
  const start = financialYearStart(dateStr, cfg);
  if (!start) return [];
  const y = Number(start.slice(0, 4));
  const out = [];
  for (let i = 0; i < 12; i++) {
    const m = (y * 12) + i; // month index
    out.push(`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`);
  }
  // financialYearStart is April; build Apr..Mar explicitly
  const out2 = [];
  for (let i = 0; i < 12; i++) {
    const mm = ((3 + i) % 12) + 1;
    const yy = 3 + i >= 12 ? y + 1 : y;
    out2.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return out2;
}

/** Position of a period within its FY (1..12), April = 1. */
function monthIndexInFY(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return 0;
  const mon = Number(m[2]);
  return mon >= 4 ? mon - 3 : mon + 9;
}

/** QRMP quarter (1..4) for a period. */
function quarterOfPeriod(period) {
  const idx = monthIndexInFY(period);
  return Math.floor((idx - 1) / 3) + 1;
}

/** Is IFF (invoice-with-furnish) required for this period? */
function requiresIFF(period, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  if (config.filing.frequency !== 'qrmp') return false;
  if (config.filing.qrmpType !== 'monthly-payment') return false;
  return config.filing.iffMonths.includes(monthIndexInFY(period));
}

/** Due dates for a period (day-of-next-month, unless overridden). */
function dueDatesFor(period, cfg) {
  const config = cfg || DEFAULT_CONFIG;
  const s = periodStart(period);
  if (!s) return {};
  const next = new Date(s.getFullYear(), s.getMonth() + 1, 1);
  const mk = (day) => {
    const d = new Date(next.getFullYear(), next.getMonth(), day);
    return toDateStr(d);
  };
  const out = {
    gstr1: requiresIFF(period, config) ? mk(config.dueDates.gstr1Iff) : mk(config.dueDates.gstr1Monthly),
    gstr3b: mk(config.dueDates.gstr3bMonthly),
    gstr2: mk(config.dueDates.gstr2),
  };
  if (config.filing.frequency === 'qrmp' && config.filing.qrmpType === 'quarterly') {
    out.gstr1 = mk(config.dueDates.gstr1QuarterlyQRMP);
    out.gstr3b = mk(config.dueDates.gstr3bQuarterlyQRMP);
  }
  return out;
}

/** Whole days until a due date (negative = overdue). */
function daysUntil(dueDateStr) {
  const d = toDate(dueDateStr);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

// ── date helpers ──────────────────────────────────────────────────────────────
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v).trim();
  // Treat "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm" as LOCAL time (the app stores local dates)
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    return new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
    );
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function toDateStr(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "01 Aug 2026" style label. */
function formatDate(value) {
  const d = toDate(value);
  if (!d) return '';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Aug 2026" from a "YYYY-MM" period. */
function periodLabel(period) {
  const s = periodStart(period);
  if (!s) return String(period || '');
  return `${MONTHS[s.getMonth()]} ${s.getFullYear()}`;
}

module.exports = {
  MONTHS,
  toDate,
  toDateStr,
  formatDate,
  periodLabel,
  financialYearStart,
  financialYearLabel,
  returnPeriod,
  periodStart,
  periodEnd,
  isInPeriod,
  periodsInFY,
  monthIndexInFY,
  quarterOfPeriod,
  requiresIFF,
  dueDatesFor,
  daysUntil,
};