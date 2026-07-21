import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * All money is stored as an integer number of cents. Never a float —
 * 0.1 + 0.2 !== 0.3 in binary floating point, and those errors accumulate
 * across running balances until a reconciliation is off by a few cents
 * with no way to find out why.
 *
 * Sign convention: negative = money out, positive = money in.
 */

const DB_PATH = resolve(process.env.LEDGER_DB ?? "data/ledger.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    opening_balance_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date         TEXT    NOT NULL,           -- YYYY-MM-DD, no timezone games
    payee        TEXT    NOT NULL,
    memo         TEXT    NOT NULL DEFAULT '',
    category     TEXT    NOT NULL DEFAULT 'Uncategorized',
    amount_cents INTEGER NOT NULL,
    source       TEXT    NOT NULL DEFAULT 'manual',  -- 'manual' | 'import'
    dedupe_key   TEXT,
    created_at   TEXT    NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_dedupe
    ON transactions(account_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
`);

/* A fresh install gets one account so nothing is ever in a half-set-up state. */
const accountCount = db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
if (accountCount === 0) {
  db.prepare(
    "INSERT INTO accounts (name, currency, opening_balance_cents) VALUES (?, ?, ?)"
  ).run("Checking", "USD", 0);
}

/* ---------- settings ---------- */

export function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/* ---------- accounts ---------- */

export function listAccounts() {
  return db.prepare("SELECT * FROM accounts ORDER BY id").all();
}

export function updateAccount(id, { name, opening_balance_cents }) {
  db.prepare("UPDATE accounts SET name = ?, opening_balance_cents = ? WHERE id = ?")
    .run(name, opening_balance_cents, id);
}

/* ---------- transactions ---------- */

export function listTransactions() {
  return db
    .prepare(
      `SELECT id, account_id, date, payee, memo, category, amount_cents, source
         FROM transactions
        ORDER BY date DESC, id DESC`
    )
    .all();
}

export function addTransaction(txn) {
  const info = db
    .prepare(
      `INSERT INTO transactions
         (account_id, date, payee, memo, category, amount_cents, source, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      txn.account_id,
      txn.date,
      txn.payee,
      txn.memo ?? "",
      txn.category ?? "Uncategorized",
      txn.amount_cents,
      txn.source ?? "manual",
      txn.dedupe_key ?? null,
      new Date().toISOString()
    );
  return Number(info.lastInsertRowid);
}

export function updateTransaction(id, fields) {
  db.prepare(
    `UPDATE transactions
        SET date = ?, payee = ?, memo = ?, category = ?, amount_cents = ?
      WHERE id = ?`
  ).run(fields.date, fields.payee, fields.memo ?? "", fields.category, fields.amount_cents, id);
}

export function deleteTransaction(id) {
  db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
}

export function listCategories() {
  return db
    .prepare("SELECT DISTINCT category FROM transactions ORDER BY category")
    .all()
    .map((r) => r.category);
}
