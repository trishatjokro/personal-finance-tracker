# Roadmap

Ordered by value ÷ cost, from research into what users of small self-hosted
trackers (ExpenseOwl, WYGIWYH, Wallos, Actual Budget, Firefly III, Lunch Money)
actually ask for and actually abandon apps over.

The organising principle: **this is an expense tracker, not a budgeting app.**
Users say so explicitly — *"For people looking for budgeting tools, there are
mature solutions, but there aren't any great expense tracking tools."*

---

## Now — bugs and near-free wins

### 1. Search only looks inside the current month  ← bug

`visible()` filters `monthTxns(key)` first, so searching "Uber" can't find last
March. Global search is the single most-requested feature in small trackers.

Should also cover: **amount** search ("what was that $87 charge"), and a
**summed total** of results — a filtered list without a total is half a feature.

*Cost: small. Decouple search from the month selector.*

### 2. The entry form resets the date  ← bug

`openEntry()` always sets the date to today. A user described exactly this
failure: *"every time I need to go back 3 months to add an entry, this eventually
leads to an 'auto pilot' where I missed some dates and added to current month
instead."*

That's silent data corruption, not friction. **Keep the last-used date after
saving**, and keep the form open for the next entry.

*Cost: tiny.*

### 3. Categories can't be renamed

You can create a category but never rename it. Real reported pain: *"I added a
'Car' category… then had the idea of putting motorcycle expenses on it too… but
I can't rename it to 'Vehicles', just deleting it and adding another one."*

Because categories are free-text on `transactions`, this is one statement:
`UPDATE transactions SET category = ? WHERE category = ? AND account_id IN (…)`.

*Cost: ~15 lines including UI. Best ratio on this list.*

### 4. Payee autocomplete

Typing "Trader Joe's" in full every week is the friction that ends manual entry.
Autocomplete from past payees, and when one is chosen, **pre-fill its usual
category**.

*Cost: small — the data is already loaded client-side.*

---

## Next — the categorization problem

Currently every imported row is `Uncategorized` and must be fixed one at a time.
Fine at 7 transactions; unusable at 200.

### 5. Bulk edit

Filter → select all → set category, in one action. Actual Budget's flow is the
benchmark: filter, `Ctrl+A`, `C`, type, Enter — four keystrokes for N rows.

*Cost: moderate. The highest-impact item for real imports.*

### 6. Payee normalization

`ETT*HubLAColiseumRENT 07/15 PURCHASE 801-8775491 TX` → `Hub LA Coliseum Rent`.

An ordered regex pipeline (~60 lines): strip trailing state code, phone numbers,
embedded dates, redacted card digits, `PURCHASE`/`POS` noise words, trailing
store numbers; split known payment-processor prefixes (`SQ*`, `TST*`, `ETT*`);
split camelCase; title-case.

Store the result as an indexed `normalized_key` column, keeping the raw string
immutable. Everything downstream — learning, grouping, "N similar" — is a lookup
on that key.

**Don't ship a city list.** Anchoring to a city gazetteer is where these
pipelines break (`BARBRI` → `BARB` + state `RI`). Consistency matters more than
correctness: the same input must always produce the same key.

### 7. Learn categories from history

After a payee is categorized the same way 3 of the last 5 times (within 180
days), apply it automatically to future imports.

Crucially, **write the learned association down as a visible, editable rule** —
not a hidden model. That transparency is why Actual's approach beats GnuCash's
opaque Bayes table: you can see why something was categorized and correct it.

**Do not build a classifier.** Measured accuracy for naive Bayes on personal-scale
data (~500 transactions, 30+ categories) is ~56%; a linear SVM ~76%. A
payee-keyed lookup is near-100% precise on the recurring merchants that dominate
transaction volume, and it's explainable.

### 8. Rules

Manual rules for what learning misses. The minimum that captures ~90% of the
value is one condition (`payee contains X`) and one action (`set category`).

Two details worth copying from Actual: **auto-rank rules by specificity** rather
than making users drag them into order (exact matches score higher than
`contains`); and **always preview a retroactive apply** — show which N
transactions will change and let the user deselect.

One bug of Actual's *not* to copy: it lowercases both the regex and the subject
string, which silently breaks any pattern using uppercase classes. Use
`new RegExp(pattern, "i")` against the original string.

---

## Then — "my totals are lying to me"

These are all the same complaint: the numbers on screen are wrong.

### 9. More than one account

The schema already has an `accounts` table with `user_id`, but the UI only ever
uses `accounts[0]`. Adding a second account — a credit card, savings, a second
bank — needs UI, not migration.

Worth doing properly rather than via tags. There's a documented pattern where
maintainers refuse accounts, offer tags as a generic escape hatch, and users
immediately reinvent structure on top (`account:paypal`, then AND/OR filters).
The escape hatch buys about one release cycle.

### 10. Transfers between accounts

Nobody asks for transfers as such; they report *"a quick glance at the expense
and income summaries doesn't actually tell you the value you had for that month
if you had any account transfers."* Moving ₱5,000 from checking to savings is
neither income nor expense, but currently counts as both.

Needs #9 first.

### 11. Splits and reimbursements

*"You have a €200 dinner with 3 friends. You pay the whole bill and get €150 back
later. Firefly would tell you you spent €200 on restaurants instead of €50."*

The cheap 80% version, given the flat schema: let a transaction carry a
`reimbursed_cents` amount that nets out of the category breakdown. No parent/child
rows.

### 12. "Exclude from statistics" flag

One boolean, excluded from totals and the breakdown. Useful on its own, and it's
the poor-man's version of #10 and #11 — WYGIWYH shipped exactly this as the
stopgap before real transfers.

---

## Also worth doing

- **Mobile entry.** The #2 abandonment cause: *"It didn't really stick for me,
  because of no mobile app so I can't add transactions on the go."* The mechanism
  matters — *"if I let a few days build up it becomes a more annoying 5–10 minute
  effort."* A backlog is what makes people quit. The layout is already
  responsive; the work is a PWA manifest plus reaching the laptop from a phone
  (same wifi, or Tailscale).
- **CSV/JSON export.** Self-hosters treat "can I get my data out" as
  non-negotiable. The PDF is a report, not an export.
- **Trends across months.** A pie chart of one month is widely criticised as
  unactionable: *"if the reporting doesn't tell me anything actionable then
  there's no point."* Spending per category over 6 months is the ask.
- **Subcategories**, cheaply, as `Parent:Child` naming rather than a schema change.

---

## Deliberately not building

- **Budgets.** Users actively ask small trackers not to. It's also where apps
  break: rent landing on the 31st vs the 1st produces a double-rent month, and
  people abandon over it.
- **Streaks, badges, gamification.** Research finds users optimise the streak
  rather than their finances.
- **Red/green "over budget" dashboards.** Documented driver of disengagement.
- **Subscription tracking with reminders.** Wallos's issue tracker is now almost
  entirely notification bugs — webhook, email, Pushover, ntfy, Discord,
  timezones. Shipping "tell me before it's due" means signing up for a
  notification subsystem. Recurring transactions that merely *materialize* into
  the ledger avoid this.
- **Bank API sync.** Unavailable to individual developers in this region;
  GoCardless closed to new signups, SEA aggregators are all B2B.
- **An ML classifier.** See #7.

## Housekeeping: DESIGN.md no longer describes this app

`DESIGN.md` was written before any code existed and the build diverged from it.
It currently claims:

| DESIGN.md says | Actually shipped |
|---|---|
| Double-entry postings, zero-sum invariant | Flat transactions |
| TypeScript, React, Drizzle, Hono | Vanilla JS, no build step, Hono |
| Multi-currency as the differentiator | USD only |
| Multi-user "explicitly out of scope" | Multi-user, shipped and tested |

Its v1 checklist is also entirely unticked despite several items being done.
Anyone reading the repo will trust the design doc and be wrong. Either reconcile
it with reality or move it to `docs/original-design.md` and label it as the
starting point rather than the plan.

Two factual corrections to its competitive section:

- Maybe is listed as archived, full stop. The active community fork
  [Sure](https://github.com/we-promise/sure) has ~9,100 stars and shipped v0.7.2
  in July 2026, with transfer matching and tags. It weakens the "only serious
  TS-native option" framing.
- [Econumo](https://github.com/econumo/econumo) is the closest peer to what this
  actually became — explicit categories-vs-tags model, and cross-currency
  transfers that record both amounts. Worth reading before building accounts and
  transfers.

## Positioning: say the small codebase out loud

Self-hosters read "few dependencies" and "will still work in three years" as the
same claim:

> *"I fear any tool with a large codebase/many deps because a simple tool I can
> keep it myself if the upstream vanishes, a complex one I can't."*

Three npm dependencies, no build step, and one SQLite file are a selling point,
not an apology for missing features. Worth stating in the README.

The counterpart is the **simplicity ratchet** — the arc every small tracker
follows: ship minimal → users ask for accounts → maintainer refuses on
philosophy → maintainer relents with a generic escape hatch (tags) → users
demand structure on top of the hatch (`account:paypal`, then AND/OR filters).
The escape hatch buys about one release cycle. Since the `accounts` table already
exists, building #9 properly is *cheaper* than the tag workaround, and it doesn't
ratchet.

## The entry-speed target

What "fast" concretely means, from someone describing their ideal:

> *"App opens into entry mode with default category already selected, number pad
> up and ready to go, and the cursor on the entry. So all I have to do is enter
> the price and hit enter."*

Two fields and one keystroke. Worth measuring the current flow against that.

## One thing worth knowing about imports

More import features are not the answer to "I stopped using it":

> *"All of those accounts have 2FA, so logging into each one, navigating to the
> download screen, and downloading it into the right spot easily adds up to
> fifteen minutes of work. Ironically, I've found that since I started to rely
> more on downloading the CSVs and importing them, I've been entering things less
> regularly because of the increased start up time."*

Import moves friction rather than removing it. The importer is already good; the
marginal return is in entry speed.
