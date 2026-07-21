# Personal Finance Tracker — Design Outline

> Status: draft for review. Nothing is built yet.
> Local path: `~/Documents/Finance Tracker`. The GitHub repo name is separate and still open — see §9.

---

## 1. Positioning

**The gap.** Research across Actual Budget, Firefly III, YNAB, Monarch and Copilot shows the
category's largest unmet need is **multi-currency**, not budgeting UI:

- Actual Budget's multi-currency issue has **328 reactions** — 3rd highest in the repo, above
  Plaid integration and subcategories.
- **YNAB does not support it at all.** Official guidance is to create a *separate budget per
  currency*, which breaks the moment you transfer between them.
- **Firefly III** shows per-currency lines but produces **no cross-currency total** — so no
  single net-worth number.
- A user in the Actual thread reports spending **50–80 minutes per week** hand-converting
  balances in Google Sheets.

**Second gap: import correctness.** Across every mature project, user complaints cluster not on
the ledger but on **transfer detection, duplicate handling, and import UX**. Actual's #2 most-
requested feature (354 reactions) is simply *"recognise transfers between accounts."*

**Therefore this project is:** a self-hosted personal finance tracker where **multiple currencies
and messy bank-statement imports are the core design constraint**, not features bolted on later.

**Explicitly not:** a YNAB clone, an envelope-budgeting evangelist, or an investment/portfolio
tracker (Ghostfolio already owns that and does it well).

### Why there's room in Node

| Project | Stars | Stack | Status |
|---|---|---|---|
| Maybe | 54.4k | Ruby on Rails | **Archived Jul 2025** |
| Actual Budget | 27.6k | **TypeScript** | Active — the one to learn from |
| Firefly III | 24.1k | PHP / Laravel | Active |
| Ghostfolio | 9.0k | **TypeScript** | Active, but portfolio-only |

Actual is the only serious TS-native budgeting app — and it's precisely the one that *can't* do
multi-currency. That's the seam.

---

## 2. Core design decisions

### 2.1 Double-entry postings, hidden behind a simple UI

Two philosophies exist in the wild: **flat transactions + parent/child splits** (Actual,
Budgetzero) versus **journal + postings double-entry** (Firefly III, Bigcapital, Beancount).

**Decision: double-entry postings.** The flat model is genuinely simpler — but it is *why* Actual
struggles with multi-currency, transfers and liabilities. Given multi-currency is our
differentiator, we need the model that expresses it.

```
accounts    (id, name, type: asset|liability|income|expense|equity, currency, ...)
transactions(id, date, payee, memo, import_batch_id, external_id)          -- the header
postings    (id, transaction_id, account_id, amount_minor, currency, category_id)
```

**Invariant:** for each `transaction_id`, `SUM(amount_minor) = 0` *per currency*. Enforced by a DB
trigger, not just application code.

What this buys us:

| Problem | Flat model | Postings model |
|---|---|---|
| Transfer between own accounts | Needs a special `transfer` flag every report must exclude | One transaction, two postings netting to zero — naturally invisible to income/expense |
| Credit card | Double-counts spend or loses the debt balance | Card is a liability account; it just works |
| Split transaction | Parent/child row hack | Three postings against one credit |
| Account balance | Stored, can drift | `SUM(amount_minor)` — a query, provably correct |
| FX conversion | Inexpressible | Credit PHP, debit USD, book the difference to an FX gain/loss account |

**The cost, stated honestly:** the UI must *never* show the words debit and credit. You type
"spent ₱500 at 7-Eleven from BPI checking" and the app derives both postings. Budget ~1 day for
that derivation layer. Every serious tool does this.

### 2.2 Money as integer minor units

Never floats — `0.1 + 0.2 !== 0.3`, and the error compounds across running balances until
reconciliation fails by cents with no audit trail.

- Store `amount_minor INTEGER` + `currency TEXT` + **`exponent INTEGER`**.
- **Persist the exponent, don't infer it.** JPY is 0, most are 2, KWD/BHD/TND are 3.
- Domain layer uses **dinero.js 2.0.2** — v2 went stable in March 2026 after 3 years at alpha, so
  most blog advice ("still alpha, avoid") is stale.
- Use dinero's `allocate()` for splits. Dividing and rounding each part independently invents or
  loses cents; allocation distributes the remainder deterministically. Enforce as a constraint:
  split postings must sum to the parent.
- `big.js` only where genuine non-integer precision is needed — FX rates, interest.
- Avoid `currency.js` (float-backed, stable channel effectively unmaintained since 2020).

### 2.3 FX: historical rates, not today's rate

The thing every half-implementation gets wrong. Requirements from the Actual thread:

1. Per-account **and** per-transaction currency, displayed natively.
2. Home-currency rollup for net worth and reports, converted at the **rate on the transaction
   date** — not the current rate. Otherwise last year's spending changes every morning.
3. Cross-currency transfer matching: "100 EUR out, 86 GBP in" reconciles as **one** transfer with
   an implied rate, plus an explicit **fee/slippage** posting.
4. An automatic rate source, with manual override and offline fallback.

```
fx_rates(date, base_currency, quote_currency, rate)   -- cached daily, unique on the triple
```

### 2.4 Import-first ingestion

**Bank aggregation is not available to us.** Verified during research:

- **GoCardless Bank Account Data (ex-Nordigen) is closed to new signups** (since ~Sept 2025) —
  this was *the* free EU option and most tutorials still recommend it.
- Teller (US only, 100 free connections) and SimpleFIN (~$15/yr, US) are the viable self-serve
  options, both US-only.
- **Southeast Asia has no self-serve option at all.** Brankas, Ayoconnect, Brick, Finverse are
  all B2B/KYB-gated. The Philippines' BSP Open Finance framework is a *voluntary pilot*, not a
  PSD2-style mandated right of access. Indonesia's SNAP is payments-first and participant-gated.

So: **file import is the primary interface, designed as such from day one.**

Architecture — `TransactionSource` interface, file-import adapter as the first implementation, so
Teller/SimpleFIN can slot in later without a vendor's transaction shape leaking into the domain.

**Store raw rows immutably alongside normalized output.** Bank exports are messy enough that you
*will* fix a parser bug and need to re-derive. If you only kept the normalized rows, you can't.

```
import_batches(id, filename, source_profile, raw_file_blob, imported_at)
import_rows   (id, batch_id, row_index, raw_json, transaction_id NULL)
```

**Parser pitfalls to handle explicitly** (each has bitten every project in this space):

| # | Pitfall | Handling |
|---|---|---|
| 1 | UTF-8 BOM — Excel CSVs start `EF BB BF`, corrupting the first header name | `csv-parse` with `bom: true` |
| 2 | Delimiter isn't always `,` — EU/PH/ID banks use `;` because `,` is the decimal separator | Sniff from the header line |
| 3 | **Date ambiguity** — `03/04/2026` is unresolvable from data alone | Explicit format **per import profile**. Never guess. |
| 4 | Number formats: `$1,234.56`, `1.234,56`, `(45.00)`, trailing `CR`/`DR` | Normalize in adapter; document sign convention (outflow negative) |
| 5 | Junk preamble — summary blocks, blank rows, repeated mid-file headers | Detect the header row, don't assume row 0 |
| 6 | Dedupe on re-import | OFX gives stable `FITID`. CSV gives nothing → synthetic `hash(account, date, amount, normalized_desc)` + occurrence counter, unique-indexed |
| 7 | Pending → posted transitions shift both date and amount | Match on fuzzy window, not exact key |
| 8 | Precision loss at the boundary | Parse currency strings **straight to integer minor units**. Never via `parseFloat` "just for a moment" |

**Import profiles** are a first-class entity — a saved column mapping + date format + sign
convention per bank, so the second import of a given bank is one click.

### 2.5 Immutable imports, adjusting entries

Imported transactions are immutable; corrections are recorded as adjusting entries rather than
in-place edits. Preserves an audit trail and makes re-import idempotent.

---

## 3. Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node 24 LTS** | Node 26 is *Current* (installed here), LTS only in Oct 2026. Pin via `.nvmrc` + `engines`. |
| Language | **TypeScript**, strict | — |
| API | **Hono 4** | Best TS ergonomics, tiny, portable. Fastify 5 equally defensible. **Not Express** — no meaningful major release in years, no first-class TS. |
| DB | **SQLite** via `better-sqlite3` 12, WAL mode | Single-user self-hosted is exactly SQLite's sweet spot. Backup = `cp`. Zero ops. |
| ORM | **Drizzle 0.45** | SQL-first, no codegen, composes with Zod. Caveat: still pre-1.0 — pin it. (Prisma 7 is the counter-argument if migrations matter more.) |
| Validation | **Zod 4** | Stable; v4 is ~14x faster on strings, 57% smaller core. |
| Testing | **Vitest 4** | Integration tests against in-memory SQLite — real SQL, no mocks. |
| Frontend | **React + Vite**, TanStack Query, Recharts | — |
| Auth | **Hand-rolled** | ~50 lines: one Argon2id hash from env, 256-bit session token, `HttpOnly; Secure; SameSite=Lax` cookie. **Lucia was deprecated Mar 2025**; Better Auth is the framework option but is overkill until there's a 2nd user. |
| Deploy | Docker, single container | `docker run` one-liner is the #1 adoption lever for self-hosted repos. |

---

## 4. Feature scope

### v1 — table stakes (absence = abandonment)

- [ ] Accounts: asset / liability, per-account currency
- [ ] Manual transaction entry (fast path — this must not be tedious)
- [ ] CSV import with saved per-bank profiles
- [ ] Duplicate detection on re-import
- [ ] **Transfer detection between own accounts**, incl. cross-currency
- [ ] Categories with **subcategories** (312 reactions on Actual — don't ship a flat list)
- [ ] Rules engine: user-editable, runs **retroactively** on existing transactions
- [ ] Search + filter across all transactions
- [ ] Split transactions
- [ ] Net worth across all accounts, in home currency, on one screen
- [ ] Data export (self-hosted users treat this as non-negotiable)

### v2 — the differentiators

- [ ] Historical FX + net-worth **trend chart over time** (a one-time snapshot is easy; the
      charted trend is what people actually want — spreadsheet users hit this wall at 4–6 months)
- [ ] Monthly budgets with rollover
- [ ] Recurring transaction detection + manual "mark as recurring" escape hatch
- [ ] **Forward cash-flow projection** — "will this account go negative on the 14th?" Most apps
      only look backward; this is a repeated unmet ask.
- [ ] OFX/QFX import
- [ ] Receipt attachments (189 reactions, almost nobody does this well)
- [ ] Manual/illiquid assets in net worth (house, car) with staleness warnings

### Explicitly out of scope

- Investment cost-basis / portfolio analytics → Ghostfolio's territory
- Multi-user / household → large feature (322 reactions), needs a real user model. Design the
  schema so it's not *blocked*, but don't build it.
- Bank aggregation → unavailable to us; keep the adapter seam and move on
- AI insights — notably **absent** from every top-reacted issue on both major repos
- Gamification (streaks/badges) — research shows users optimize the streak, not the finances
- Red/green "over budget" shaming dashboards — documented driver of disengagement

---

## 5. Milestones

1. **Ledger core** — schema, postings, zero-sum invariant, dinero integration, Vitest suite.
   *Nothing else works if this is wrong.*
2. **Import pipeline** — CSV parse → raw rows → normalize → dedupe → transfer match. Profiles.
3. **API** — Hono routes, Zod schemas at the boundary.
4. **Web UI** — accounts, transaction table, entry form, net worth screen.
5. **FX + multi-currency reporting** — rate cache, historical conversion, home-currency rollup.
6. **Rules + categories**, retroactive application.
7. **Docker + docs + live demo.**

---

## 6. Testing strategy

- Ledger invariants are property-tested: no sequence of operations may break `SUM = 0`.
- Every import pitfall in §2.4 gets a fixture file and a regression test.
- Golden-file tests for each bank profile.
- Integration tests hit real in-memory SQLite, not mocks.

---

## 7. Repo presentation

Measured from the GitHub API across 20 finance repos: **About description median = 79.5 chars**
(68 for >1k stars). The hard limit is 350; nobody comes close.

Conventions observed: noun phrase not verb-first (18/20), sentence case, no emoji (top-5 repos
use zero), **never repeat the repo name** (it renders directly above), and **keep the tech stack
out** — it belongs in topics where it's searchable.

### Candidate descriptions

1. `A local-first personal finance tracker built for multiple currencies.` — 69
2. `A self-hosted finance tracker for people who hold more than one currency.` — 73
3. `Multi-currency personal finance tracker. One container, imports from any bank.` — 78
4. `A personal finance tracker that gets multi-currency and messy bank exports right.` — 80

Recommendation: **#1** — leads with the differentiator, one adjective, clear category noun.

### Topics (use 15–20; new repos should max the free surface area)

`personal-finance` `finance` `finance-tracker` `expense-tracker` `budgeting` `money`
`multi-currency` `self-hosted` `selfhosted` `local-first` `double-entry` `docker` `homelab`
`privacy` `typescript` `nodejs` `sqlite` `hono`

Note: `self-hosted` and `selfhosted` are **separate topics** — tag both. Singular/plural variants
are separate too.

### README structure

1. Logo → H1 → 4–6 badges
2. One-sentence definition matching the About text
3. **Live demo link with published credentials, above the fold** — the highest-leverage asset for
   this category; satisfies HN's "must be tryable" bar and r/selfhosted's replicability bar
4. **"Why this exists"** as the second heading, naming Actual and Firefly III explicitly. In a
   category with 20+ mature competitors, "not another X" positioning is table stakes.
5. Categorized feature bullets
6. Screenshots: desktop + mobile × light + dark, in a table, under `<details>`
7. **`docker run` one-liner first**, then compose, then everything else collapsed
8. Config table → Contributing → License

### License

AGPL-3.0 dominates this category (Firefly III, Maybe, Ghostfolio); MIT for Actual and
ezbookkeeping. **Recommendation: AGPL-3.0** — it's the norm here and prevents a SaaS repackage
without contribution.

---

## 8. Open questions

1. **Which currencies?** Determines the base/home currency and which FX pairs to cache.
2. **Which banks?** Each needs an import profile. Critically: do any of them export **only PDF**?
   That changes the import strategy substantially (PDF table extraction is a different problem).
3. **Repo name.**

## 9. Naming candidates

| Name | Note |
|---|---|
| `cambio` | "exchange" in Spanish/Portuguese — leans into the multi-currency angle |
| `ledgerly` | descriptive, safe |
| `kurs` | "rate" in several languages, short |
| `tally` | clean, but heavily used |
