'use strict';
/**
 * GST Configuration — ALL rates, thresholds, due dates, digit rules and the
 * JSON schema version live here. Nothing in gst/*.js may hardcode these values.
 *
 * VERIFY EVERYTHING IN THIS FILE against the latest CBIC/GSTN notifications
 * before filing. Rates, thresholds, due dates and HSN digit rules change.
 */

// ── JSON schema version used for GSTR-1 offline export ────────────────────────
// NOTE: verify against https://www.gst.gov.in  →  Utilities → Offline Tools
// before generating a file you intend to upload.
const GSTR1_SCHEMA_VERSION = 'gstr1-offline-1.4';

const STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory', '96': 'Other Country',
};

const DEFAULT_CONFIG = {
  schemaVersion: GSTR1_SCHEMA_VERSION,

  // Business identity
  business: {
    gstin: '',
    legalName: '',
    tradeName: '',
    stateCode: '',          // '27' etc — home state / place of supply default
    pan: '',
    constitution: 'proprietorship', // proprietorship|partnership|llp|company|hni|trust|society
    registrationDate: '',
  },

  filing: {
    frequency: 'monthly',        // 'monthly' | 'qrmp'
    qrmpType: 'monthly-payment', // 'monthly-payment' (M-Q) | 'quarterly' (QRMP)
    // IFF (invoice with furnish) applies to B2B in months 1 & 2 of FY under QRMP-M
    iffMonths: [1, 2],
  },

  financialYear: { startMonth: 4, startDay: 1, labelFormat: 'YYYY-YY' },

  gstin: {
    length: 15,
    pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$',
    // GSTIN check digit (mod-36, letters mapped A=10..Z=35)
    checksum: {
      enabled: true,
      // When false, a checksum mismatch is reported as a WARNING only.
      // A false negative here would block a legitimate filing, so enforcement
      // stays opt-in until the algorithm is verified against GSTN's spec.
      enforced: false,
      base: 36,
      mapStart: 10,
    },
  },

  hsn: {
    minDigits: 4,            // floor; actual requirement varies by turnover
    digitsByTurnover: [      // [max turnover in ₹, required HSN digits]
      { upto: 10000000, digits: 4 },        // ≤ 1 crore (10 million)
      { upto: 100000000, digits: 6 },       // ≤ 10 crore (100 million)
      { upto: 1000000000, digits: 6 },      // ≤ 100 crore (1 billion)
      { upto: Infinity, digits: 8 },
    ],
    pattern: '^[0-9]{2,8}$',
    sacPattern: '^[0-9]{4,8}$',
  },

  invoice: {
    maxLength: 16,
    allowedChars: '^[A-Za-z0-9/\\-_.]+$',
    numbering: { padding: 4, includeFy: true, seriesPrefix: '' },
  },

  thresholds: {
    // B2C Large = unregistered customer AND inter-state AND invoice value >=
    b2cLargeInvoiceValue: 100000,   // ₹1,00,000 — VERIFY current notification
    compositionDeemedExport: 0,
    // Turnover (₹) beyond which 8-digit HSN is needed (see hsn.digitsByTurnover)
    turnoverBrackets: [10000000, 100000000, 1000000000],
    // Aggregate turnover (₹ in the financial year) from which e-invoicing
    // (IRN/IRP) becomes applicable. VERIFY against the latest CBIC notification.
    eInvoiceTurnoverRupees: 50000000,   // ₹5 crore
  },

  // Order in which ITC is set off against liability, as [creditHead, liabilityHead].
  // IGST credit first: against IGST, then CGST, then SGST.
  // CGST credit: against CGST, then IGST. NEVER SGST.
  // SGST credit: against SGST, then IGST. NEVER CGST.
  // Cess credit is applied first against cess liability.
  setOffOrder: [
    ['cess', 'cess'],
    ['igst', 'igst'], ['igst', 'cgst'], ['igst', 'sgst'],
    ['cgst', 'cgst'], ['cgst', 'igst'],
    ['sgst', 'sgst'], ['sgst', 'igst'],
  ],

  rates: [0, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28],
  cess: { default: 0 },
  uqcDefault: 'NOS',

  dueDates: {
    // day of following month for monthly filers
    gstr1Monthly: 11,
    gstr1Iff: 13,
    gstr3bMonthly: 20,
    gstr2: 14,
    gstr3QuarterlyQRMP: 25,
    gstr1QuarterlyQRMP: 13,
  },

  reconciliation: {
    toleranceRupees: 1,       // ₹1 — configurable
    fuzzyInvoiceNumber: true, // tolerate leading zeros, '/' vs '-', case
    invoiceNumberStripChars: '/\\-_. ',
  },

  exemptions: {
    // Nil/exempt reason codes are configuration, not code
    nilRatedReasons: [
      'Agricultural produce (unprocessed)',
      'Personal movement / baggage',
      'Exempt goods (Schedule exemption)',
    ],
    nonGstReasons: ['Pure agricultural produce', 'Ungrained paddy', 'Personal movement'],
  },

  exports: { withPayment: 'WPAY', withoutPayment: 'WOPAY' },
  nilRated: { intraB2B: 'INB', interB2B: 'INB', intraB2C: 'INC', interB2C: 'INC' },

  // Document types the billing screen offers, in menu order. `inReturn:false`
  // means the type is kept in the books but excluded from every return table
  // (estimates, delivery challans and the like).
  documents: [
    { value: 'tax_invoice',     label: 'Tax Invoice',           inReturn: true  },
    { value: 'bill_of_supply',  label: 'Bill of Supply',        inReturn: true  },
    { value: 'credit_note',     label: 'Credit Note (refund)',  inReturn: true  },
    { value: 'debit_note',      label: 'Debit Note (addition)', inReturn: true  },
    { value: 'export_invoice',  label: 'Export Invoice',        inReturn: true  },
    { value: 'sez_invoice',     label: 'SEZ Supply Invoice',    inReturn: true  },
    { value: 'estimate',        label: 'Estimate / Quotation',  inReturn: false },
    { value: 'delivery_challan',label: 'Delivery Challan',      inReturn: false },
  ],
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach((k) => deepFreeze(o[k]));
  }
  return o;
}

/**
 * Deep-merge user config over defaults.
 * Objects merge key-by-key; arrays are replaced wholesale.
 * `base` defaults to DEFAULT_CONFIG so a caller that only has overrides still
 * gets the full config — omitting it used to silently return just the overrides.
 */
function mergeConfig(overrides, base) {
  const b = base === undefined ? DEFAULT_CONFIG : base;
  const out = Array.isArray(b) ? b.slice() : { ...(b || {}) };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)
      && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(v, out[k]);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = {
  GSTR1_SCHEMA_VERSION,
  STATE_CODES,
  DEFAULT_CONFIG: deepFreeze(DEFAULT_CONFIG),
  deepFreeze,
  mergeConfig,
};