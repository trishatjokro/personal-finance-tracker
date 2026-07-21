# Girl Math 🎀

A self-hosted personal finance tracker you run on your own computer. Your
transactions live in a single file on your machine — no account to create, no
server to trust, nothing uploaded anywhere.

```bash
git clone https://github.com/trishatjokro/personal-finance-tracker.git
cd personal-finance-tracker
npm install
npm start
```

Then open **http://localhost:3000** and create a username and password. That's the
whole setup.

---

## Why this exists

There are good self-hosted finance apps already — [Actual Budget][actual] and
[Firefly III][firefly] are both excellent and far more mature than this.

They're also a lot of app. Firefly III wants a database server and asks you to
learn source and destination accounts before you can log a coffee. Actual is
built around envelope budgeting, which is a whole methodology to adopt.

Girl Math is for the case where you just want to see where your money went. Type in
what you spent, or drop in your bank's CSV. One file, one command, no
methodology to buy into.

If you want budgets, forecasting, or multi-currency reporting, use one of the
two above — they do it properly.

## What it does

- **Type transactions in by hand** — works from day one, no bank export needed,
  and it's the only thing that catches cash spending
- **Import a bank CSV** — column layout is detected, and re-importing the same
  file is safe
- **Categorize** anything, with categories you invent as you go
- **Filter and sort** by month, category, spending vs income, or free text
- **See the shape of a month** — spending by category, running balance, and how
  this month compares to the last
- **Export a month as a PDF** — real selectable text, not a screenshot
- **Several logins on one computer**, each with completely separate books
- **Light and dark**, both designed rather than one flipped into the other

## Several people, one copy

Anyone can create an account from the sign-in screen, and each person gets their
own accounts, transactions, and categories. Nobody can see anyone else's — every
query is scoped by user, and asking for a transaction that isn't yours returns
nothing rather than someone else's data.

This is separate books on shared hardware, not a shared household budget. Two
people tracking one joint account would each need to import it themselves.

Worth being clear about the threat model: this protects your partner or roommate
from casually opening your ledger. It does **not** protect the database file
itself — anyone with access to the folder can read `data/ledger.db` directly. If
that matters, use macOS FileVault or an encrypted volume.

## Your data

Everything is stored in `data/ledger.db`, a plain SQLite file in the project
folder. That file is your data.

- **Back it up** by copying it. That's a complete backup.
- **Move it** to another computer by copying it there.
- **Read it** with any SQLite tool if you ever want out. Nothing is proprietary.
- `data/` is gitignored, so your finances never get committed by accident.

Passwords are hashed with scrypt and never stored. **There is no reset** — if you
forget yours, that account's data is unreachable. Write it down somewhere real.

## Importing from your bank

Export **transactions**, not a statement. A statement is a PDF meant for humans;
the transaction export is the raw data.

- **Bank of America** — sign in on a desktop browser, open the account, and use
  the download icon above the transaction list. Choose CSV. (The mobile app has
  no export at all.)
- **Most other banks** — look for "Download", "Export", or a download arrow on
  the account activity page.

The importer handles the things bank exports actually do: summary rows before
the real header, `$` and thousands separators, `(45.00)` for negatives, `CR`/`DR`
markers, semicolon delimiters, and Excel's byte-order mark.

**Dates are read as US-style month/day/year.** If your bank writes day/month/year,
change `dateOrder` to `"DMY"` in the import call — `03/04/2026` is genuinely
ambiguous and guessing it wrong silently corrupts your history.

Re-importing a file you've already imported adds nothing. Each row gets a
fingerprint from its date, amount, and description, and duplicates are rejected
at the database level — while two genuinely separate same-day charges for the
same amount stay separate.

## How the money is stored

Every amount is an **integer number of cents**. Never a floating-point number.

In binary floating point `0.1 + 0.2` is `0.30000000000000004`, and those errors
accumulate across a running balance until a reconciliation is off by a few cents
with no way to trace it. Integers are exact, so a balance either matches your
bank or is provably wrong.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `LEDGER_DB` | `data/ledger.db` | Where the database file lives |
| `NODE_ENV` | — | Set to `production` to require HTTPS for the session cookie |

## Running it on a real domain

It's built to run on `localhost`, which is the safest place for it. If you put it
on the public internet so you can reach it from a phone, note that the login is
the only thing between the internet and your complete financial history — so use
a long passphrase, put it behind HTTPS, and set `NODE_ENV=production`.

## Requirements

Node 22 or newer. Nothing else — no database server, no build step, and no
native modules to compile.

## Development

```bash
npm run dev    # restarts on change
npm test       # parser and import tests
```

## License

MIT

[actual]: https://github.com/actualbudget/actual
[firefly]: https://github.com/firefly-iii/firefly-iii
