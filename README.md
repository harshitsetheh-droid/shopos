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
# 216 unit tests, no database needed
node --test "gst/tests/config.test.js" "gst/tests/money.test.js" \
          "gst/tests/classify.test.js" "gst/tests/gstin.test.js" \
          "gst/tests/gstr1.test.js" "gst/tests/gstr3b.test.js" \
          "gst/tests/validate.test.js" "gst/tests/reconcile.test.js" \
          "gst/tests/schema.test.js" "gst/tests/client.test.js" \
          "gst/tests/advance-orders.test.js"

# API + delta-save + GST opt-in suites — these spawn their own server and need
# the database. They must run from backend/ because dotenv reads .env relative to
# the cwd. Run them directly, NOT via `node --test "gst/tests/*.test.js"`: they
# are self-driving scripts that boot a server and call process.exit(), so the test
# runner reports each whole file as a failure even when every check inside passes.
cd backend
node ../gst/tests/api.test.js        # 40 checks — HTTP surface, workflow, audit
node ../gst/tests/delta.test.js      # 28 checks — partial save, upsert/delete
node ../gst/tests/gst-optin.test.js  # 20 checks — GST-off docs carry no tax
node ../gst/tests/verify-schema.js   # asserts every GST column/table exists
```

`gst/tests/client.test.js` is the odd one out: it statically checks
`shopOS_app.js` and `shopOS_index.html` rather than the GST engine. Those two
files are ~9500 lines loaded as plain `<script>`, so nothing else executes them
and nothing type-checks them. It catches the mistakes that actually happen there:
a declaration initialised from its own name (which throws a ReferenceError at
runtime but parses fine), a local shadowing a top-level function, an `onclick`
naming a function that no longer exists, and a first-party `<script>` that lost
its `?v=` cache-buster. Each of those passed all 245 other tests.

`gst/tests/advance-orders.test.js` follows the same idea but goes further: rather
than pattern-matching the source, it lifts the real functions out of
`shopOS_app.js` and runs them inside a `vm` sandbox with a minimal `document` stub.
A copied reimplementation would keep passing after the shipped code regressed, so
the money tests (excess advance, GST toggle, retained credit) execute the code
that actually runs in the browser.

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
invoice they adjust; an unlinked one is a blocker. When the linked invoice falls
in an earlier period, the note is also reported in the GSTR-1 amendments section
— the original period is resolved from the linked invoice number, since nothing
records it explicitly. Invoice numbers must be unique per series across the
whole financial year, so a number reused in a sibling month is a blocker even
though both periods validate clean on their own.

**Money.** All amounts are integer paise held in `BigInt` (`gst/money.js`). No
floats anywhere in the arithmetic — 0.1 + 0.2 problems in a tax return are not
rounding differences, they are wrong filings.

**Tie-out.** GSTR-3B is cross-checked against GSTR-1 on every build. Every
return shows the difference, and a non-zero difference is surfaced rather than
hidden. 3.2 is a memorandum disclosure of supplies already counted in 3.1(a) and
3.1(b), so it is deliberately *not* added into totals.

**Books vs return** puts your raw documents next to the GSTR-1 and GSTR-3B totals
and shows the difference between all three, plus which excluded, draft and
cancelled documents explain any gap. A credit note reduces both sides by the same
amount, so a period containing one reconciles to zero rather than showing a
phantom gap.

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

**Credit that is not claimed still gets reported.** Two cases reduce Table 4
without disappearing from the return. A purchase you marked ineligible
(`itc_eligible` off, with a reason) goes to **4(C)** — a clean 2B match cannot
override Section 17(5), so accepting that row in the recon screen still will not
claim it. A supplier debit note goes to **4(B)** as credit reversed. Both list
the invoice and the reason underneath the table, so a non-zero 4(B) or 4(C) is
something you can act on rather than a number to wonder about.

The parser accepts both the portal's own field names (`inum`, `taxval`, `iamt`,
`camt`, `samt`, `cessamt`, `invty`) and the longer aliases used by hand-typed
extracts, and invoice dates in `DD/MM/YYYY` as well as ISO. The uploaded payload
is stored as-is and re-parsed on each build, so a config change applies
consistently and the file's real contents stay on record. Still worth a glance
after the first upload: if every row lands in `missing_in_books`, the file is
almost certainly not shaped the way the parser expects.

**Workflow.** `draft → validated → exported → filed → locked`. Illegal jumps are
rejected by the API, not just hidden in the UI. An ARN is mandatory at `filed`.
Locking a period flips its sales to `doc_status='cancelled'`, after which the
period is read-only and edits surface as a blocker.

**Audit trail** (`gst_audit_log`) records business-detail changes, config
changes, validation, 2B uploads, 2B accept/reject decisions, every workflow
transition, and — because the download itself happens in the browser — the
client reports each completed export so the record shows which artefact actually
left the system, with per-table row counts.

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

### Capturing purchase GST (needed for 2B and ITC)

The stock-entry form has a **🧾 Purchase GST details** block, collapsed by
default. It captures the supplier GSTIN, **the supplier's invoice number**, the
invoice date, the taxable value and the four tax heads, plus import / reverse
charge / ITC-eligible flags with a Section 17(5) reason.

The supplier's invoice number is the field a 2B row is matched on, so without it
reconciliation silently matched nothing and looked like "no ITC available" rather
than "no data captured". The block warns about exactly that as you type: a
missing invoice number, a missing GSTIN, taxable value with no tax heads, and an
implausible effective rate.

Everything else the stock-entry form collects — destination, parcel count,
supplier bill and its paid/due state, transport provider, transport cost, paid
and status, and the linked transport expense — is now persisted too, and appears
in the Inventory History export alongside the GST columns. None of it was being
stored before, which meant the "Supplier Bill Paid/Due" reports were sorting on
empty values.

Only credit that reconciliation has *matched or accepted* reaches GSTR-3B Table
4, split into 4(A)(1)(a) import of goods, 4(A)(5) reverse charge and 4(A)(7) all
other ITC.



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

### How much data this handles

The app holds every sale in the browser and re-examines every record on each
save, so there is a ceiling, and it is worth knowing where it is.

| Records | Behaviour |
| --- | --- |
| up to ~100k sales | Comfortable. Partial saves, lists page at 100, reports instant. |
| ~500k sales | Works, but the 10-second autosave costs ~0.5s of CPU. Reports get sluggish. |
| 1M+ sales | Not usable. Autosave alone is over a second, and `/load` returns every sale in one response. |
| 10M (1 crore) | Not supported. This needs a different architecture, not tuning. |

Two things that used to make the ceiling much lower are now fixed: a
`Math.max(...rows)` call threw "Maximum call stack size exceeded" past ~125k
records and killed the app on load (and failed every save server-side), and long
lists rendered every row, so 2,000 advance orders meant 41,000 DOM nodes.

## Advance orders, advances and udhaar

An advance order is a booking, not a sale: nothing enters the books or any GST
return until you bill it. Three things about it are worth knowing because they
were wrong and cost money.

**GST is off unless you turn it on.** Each order carries its own "Apply GST on
this order" checkbox, which is unchecked every time the form opens. With it off,
the invoice is a Bill of Supply: `taxApplied:false`, every item rate zeroed, and
not one paisa of CGST/SGST/IGST/cess is calculated, printed or reported — even
when the product master carries an 18% rate. Nothing is ever inferred from the
item master. A soft, dismissible "This sale may need GST" notice appears when the
box is off but the items do have a rate; it never blocks saving.

A GST-off document still has a turnover, so it is reported in GSTR-1's
nil/exempt/non-GST table and 3.1(e) — omitting it entirely would under-report
revenue. It simply contributes no tax. `gst/tests/gst-optin.test.js` pins this
down end to end: identical products, one order with the box off and one with it
on, and the return must show ₹0 tax for the first and ₹18 for the second.

**Excess advance is kept, not lost.** Bill a ₹1,000 order against a ₹5,000
advance and the ₹4,000 does not leave the shop. It is applied to any udhaar the
customer already owes, and whatever remains is retained on the order as
`advanceUnused` — available against that order's next invoice. Previously the
leftover was announced in a toast that vanished on reload, with nothing recorded.

**Settled udhaar bills are never deleted.** Paying off a record used to collapse
its bills down to the last one, so settling three bills destroyed the first two
and the customer's `totalBill` silently shrank. Settled bills are history.

## Demo data

`devtools/demo-data.js` seeds a plausible small shop — five weeks of bills, busier
weekends, a couple of dead days, a mix of GST-on tax invoices and plain bills of
supply, and some part-paid bills — so the dashboard chart, reports and reminders
can be judged with something on screen. It is not referenced from
`shopOS_index.html`; load it deliberately from the browser console:

```js
fetch('/devtools/demo-data.js').then(r => r.text()).then(eval)
await seedDemoData()      // or seedDemoData({ weeks: 8 })
clearDemoData()           // removes everything it created
```

Everything it writes is tagged (`DEMO ` name prefix, `demo: true` on the row), so
`clearDemoData()` takes all of it back out without touching real records. The
figures are generated from a fixed seed, so the same shop comes back every time and
a real regression cannot be mistaken for a different random draw.

Do not run this against a shop you intend to file from: it is indistinguishable
from real sales in the reports once loaded.

> Verify the treatment of tax on advances and receipts with your CA against the
> notifications current at the time of filing. The rules around tax on advance
> payments differ for goods and for services, and the position on advances has
> changed more than once.

Going beyond ~500k means server-side pagination, so the browser never holds the
whole table, and change tracking (an `updated_at` watermark) so a save sends only
what actually changed instead of diffing every record in memory. That is a
substantial piece of work, not a tweak — worth doing deliberately rather than
pretending the current design scales.

**A customer's whole ledger history is one JSONB row.** The save path merges
rather than overwrites, so a shorter list can never delete entries, and running
balances are recomputed from the debits and credits on every load. A very active
customer still means one large row rewritten per entry; giving entries their own
table is the fix if that ever bites.

### Hiding a sale

Deleting a sale never destroys it — it sets a flag, and the sale stays in the
database. Two decisions are recorded separately, and you are asked for both:

| | Out of the list | Out of revenue & profit |
| --- | --- | --- |
| **Hide from the list only** | yes | no |
| **Also remove from revenue and profit** | yes | yes |

The split matters because the right answer depends on why you are deleting. A
duplicate you still want counted once, or a real sale you just want out of the
way, should leave the money alone. A test bill or a mis-keyed amount should not be
in the totals at all. Previously there was no choice, so a hidden duplicate kept
inflating revenue while quietly vanishing from the list — the worst of both.

Revenue, profit and the transaction counts all honour the second flag. Restore
anything from the **🗂️ Hidden** pill in Sales History, which puts it back in both
the list and the figures.

**Hiding a sale does not change your GST return.** GSTR-1 is a separate statutory
record with its own workflow: to take a document out of a return, cancel it or
raise a credit note. Silently dropping it from GSTR-1 while leaving it in your
books would be worse than leaving it visible, so the dialog says so rather than
guessing.

### Three data notes

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

**Saving is a partial update.** `/api/save` sends only the records that changed,
not the whole dataset, so an edit touches one row instead of rewriting every
row. The full-payload path still exists as a fallback. Two consequences worth
knowing: a save that carries the whole dataset still does *delete-all-then-
reinsert* inside a transaction, so a client holding empty arrays would clear the
table — the transaction means a failure rolls back rather than half-applying; and
record ids are compared as strings internally, because some tables use `SERIAL`
and others use `VARCHAR`.

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