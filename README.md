# ShopOS — Retail Manager & GST Returns

Billing and inventory for a single-store retailer, with offline GSTR-1 / GSTR-3B
generation and GSTR-2B reconciliation built in.

The front end is plain HTML, CSS and vanilla JavaScript — no framework, no build
step. The back end is Node + Express + PostgreSQL.

```
shopOS_index.html    single page shell (every screen is a "page" section)
shopOS_app.js        all POS / inventory / reports behaviour
shopOS_style.css     styling
gst_ui.js            the GST Returns screen (loaded after shopOS_app.js)
gst/                 the GST rules engine — pure, framework-free, unit-tested
backend/             Express API + PostgreSQL schema
```

---

## Running it

```bash
cd backend
npm install
node server.js
```

Database connection details come from `backend/.env`. Migrations run
automatically on boot and are **additive only** — no table or column is ever
dropped, so upgrading is always safe.

Open the printed URL, sign up, and press **Alt+G** for the GST screen.

### Tests

```bash
# 132 unit tests, no database needed
node --test "gst/tests/config.test.js" "gst/tests/money.test.js" \
          "gst/tests/classify.test.js" "gst/tests/gstin.test.js" \
          "gst/tests/gstr1.test.js" "gst/tests/gstr3b.test.js" \
          "gst/tests/validate.test.js" "gst/tests/reconcile.test.js" \
          "gst/tests/schema.test.js"

# API + delta-save suites — these spawn their own server and need the database.
# They must run from backend/ because dotenv reads .env relative to the cwd.
cd backend
node ../gst/tests/api.test.js      # 34 checks — HTTP surface, workflow, audit
node ../gst/tests/delta.test.js    # 18 checks — partial save, upsert/delete
node ../gst/tests/verify-schema.js # asserts every GST column/table exists
```

There are no extra test dependencies — it is `node --test` and nothing else.
Each API suite starts its own server on port 3111/3112, creates a throwaway
account, and deletes it again when it finishes.

---

## GST Returns

Press **Alt+G**. The screen has seven tabs: Overview, Validation, GSTR-1,
GSTR-3B, 2B Recon, Books vs Return, and Filing.

### The two ideas the rest follows from

**1. The report engine is separate from the screen.** Everything that decides
what goes into a return lives in `gst/`, as pure functions over plain objects.
`gst_ui.js` only renders what it is handed. That is why the rules can be tested
without a browser and why the test fixtures in `gst/tests/fixtures.js` are enough
to exercise the whole return.

**2. Nothing legal is written in code.** Every rate slab, threshold, due date,
HSN digit rule, reason code, set-off pair and schema version lives in
`gst/config.js` and can be overridden per business from the GST screen
(**Advanced config**), which persists to the `gst_config` table. Changing the law
means editing config, not code. See the warning at the end of this section.

### Rules implemented

**Which documents are in scope.** Only *finalised* GST documents appear.
Estimates, quotations and delivery challans are stored but excluded from every
table (Core Rule 1), and their presence in a return period is reported as a
blocker so they cannot leak in unnoticed. Drafts are excluded; cancelled
invoices reverse their original. There is deliberately **no** feature to exclude a
taxable sale from a return — if tax was charged, it is reported.

**Classification.** B2B is a registered buyer (GSTIN present, recipient
registered, not composition, not UIN); everything else is B2C. B2C Large is
unregistered **and** inter-state **and** invoice value at or above
`thresholds.b2cLargeInvoiceValue`. Inter-state is decided by comparing the
place-of-supply state code against the business state code — never by a
free-text city name. HSN summary tables and the 4-digit/6-digit/8-digit
requirement scale with turnover from `hsn.digitsByTurnover`.

**Bill of Supply, exempt, nil-rated and non-GST supplies are all included.**
They go into the GSTR-1 Nil/Exempt tables and GSTR-3B 3.1(c), 3.1(d) and
3.1(e) rather than being dropped. Nil/exempt/non-GST declarations require a
reason; without one they are a warning, so the omission is visible.

**Core Rule 3.** A bill flagged as non-GST that contains an item whose master
record carries a non-zero rate is a **blocker**, not a rounding artefact. This
is the single most common way a shop's books silently diverge from its returns.

**Credit and debit notes** reduce (or increase) liability and must link to the
invoice they adjust; an unlinked one is a blocker.

**Money.** All amounts are integer paise held in `BigInt` (`gst/money.js`). No
floats anywhere in the arithmetic — 0.1 + 0.2 problems in a tax return are not
rounding differences, they are wrong filings.

**Tie-out.** GSTR-3B is cross-checked against GSTR-1 on every build. Every
return shows the difference, and a non-zero difference is surfaced rather than
hidden. 3.2 is a memorandum disclosure of supplies already counted in 3.1(a) and
3.1(b), so it is deliberately *not* added into totals.

**Set-off order** comes from `setOffOrder` in config, expressed as
`[creditHead, liabilityHead]` pairs. Cess first; then IGST credit against IGST,
then CGST, then SGST; CGST credit against CGST then IGST; SGST credit against
SGST then IGST. CGST credit is never applied to SGST liability and vice versa.

**2B reconciliation.** Upload a 2B file, and each row is matched against your
books. Three buckets appear: `matched`, `value_mismatch`, `missing_in_books`,
`missing_in_2b`. Doubful rows default to **`pending`** — nothing is claimed
automatically. Only `matched` and `matched_tolerance` (within
`reconciliation.toleranceRupees`) count as `accept` and feed GSTR-3B Table 4.
This is deliberate: auto-claiming a doubtful credit is how input tax gets
reversed with interest.

**Workflow.** `draft → validated → exported → filed → locked`. Illegal jumps are
rejected by the API, not just hidden in the UI. An ARN is mandatory at `filed`.
Locking a period flips its sales to `doc_status='cancelled'`, after which the
period is read-only and edits surface as a blocker. Every export, mark-filed,
period lock, 2B upload and 2B decision is written to `gst_audit_log`.

### Capturing GST data at the counter

The report engine can only be as good as what billing recorded. The checkout
screen has a **🧾 GST document details** block, collapsed by default so the normal
billing flow is unchanged. It captures document type, invoice number and series,
buyer GSTIN, place of supply, reverse charge, the linked invoice for credit and
debit notes, export payment status, and a non-GST / nil / exempt reason.

Place of supply is derived from the cart location box the counter already fills
in, so it does not have to be typed twice; picking it in the dropdown overrides
that. **The chosen place of supply decides intra-state vs inter-state** — a bill
placed in Karnataka on a Maharashtra shop charges IGST, and the CGST/SGST/IGST
split, the saved `is_interstate`, and the printed invoice all agree.

Document types and reason codes are read from config at runtime rather than
hardcoded in the screen, so adding one is a config change.



All in `gst/config.js`, all overridable per business from **Advanced config**:

| Key | Meaning |
| --- | --- |
| `schemaVersion` | GSTR-1 offline JSON schema version — `gstr1-offline-1.4` |
| `business.*` | GSTIN, PAN, legal/trade name, state code, constitution |
| `filing.frequency`, `filing.qrmpType`, `filing.iffMonths` | Monthly vs QRMP, IFF months |
| `financialYear.startMonth` / `startDay` | 1 April by default |
| `gstin.checksum.enforced` | See the checksum note below |
| `rates`, `cess.default` | Allowed rate slabs and default cess |
| `hsn.minDigits`, `hsn.digitsByTurnover` | HSN digit requirement by turnover |
| `thresholds.b2cLargeInvoiceValue` | ₹1,00,000 |
| `thresholds.eInvoiceTurnoverRupees` | ₹5 crore — drives the e-invoice warning |
| `thresholds.compositionDeemedExport` | Composition deemed-export value |
| `dueDates.*` | GSTR-1/3B/2B/QRMP due days |
| `reconciliation.toleranceRupees` | 2B match tolerance, ₹1 |
| `reconciliation.invoiceNumberStripChars` | Characters ignored when matching invoice numbers |
| `setOffOrder` | Credit/liability set-off pairs |
| `exemptions.nilRatedReasons`, `exemptions.nonGstReasons` | Reason code pickers |
| `nilRated.*` | Nil/exempt invoice-type codes (INB / INC …) |
| `documents` | Document types offered on the billing screen |
| `exports.withPayment` / `withoutPayment` | WPAY / WOPAY |
| `uqcDefault` | Unit quantity code default (`NOS`) |

### GSTIN checksum is a warning, not a block

`gstin.checksum.enforced` defaults to **`false`**. A checksum mismatch is
reported as a warning so you can see it, but it does not stop a filing, and it
does **not** change how the sale is classified. A well-formed GSTIN in a real
state code is treated as a B2B recipient even if the check digit does not
verify — demoting it to B2C Small would quietly produce a wrong GSTR-1.

The reason enforcement is off by default is asymmetry: a false negative blocks a
legitimate return that the shop can file perfectly well today, and the mod-36
check digit has edge cases around the GSTN's own state-code handling. Turn
enforcement on per business in **Advanced config** once you have verified the
algorithm against the GSTN specification for your real GSTINs.

### Two data notes

**Test fixtures use synthetic GSTINs.** The GSTINs in `gst/tests/fixtures.js`
are generated by `gst/tests/make-gstin.js`, which computes the check digit with
the same algorithm the validator uses. They are structurally valid and
self-consistent, not real registrations. Never use them to file.

**Historical invoices cannot be back-filled.** GSTIN, place of supply and
document type were not captured before this feature existed. For bills already
in the system you have two options: start filing from the month this goes live,
or enter the missing GSTINs for past customers by hand. Retroactively inventing
place-of-supply values to make an old period tie out would be falsification, so
the app does not offer it — an old period simply validates with blockers.

---

## ⚠️ Verify before you file

The defaults in `gst/config.js` encode the law as it was understood when this
was written. **Rates, thresholds, due dates, HSN digit rules and the GSTR-1
offline schema version all change by government notification** — several times a
year, and sometimes with almost no notice.

Before you generate a file you intend to upload:

1. Check rates, thresholds, due dates and the HSN digit rule against the
   **current CBIC / GSTN notifications** and your State GST department.
2. Check `schemaVersion` against **gst.gov.in → Utilities → Offline Tools**,
   which publishes the schema you must match.
3. Check the invoice numbering rules and B2C e-invoicing thresholds against the
   latest notifications.
4. Have a CA or your tax consultant review the first real return.

This software produces a **draft**. It is not legal advice and it does not file
anything with the portal — you upload the file yourself.