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
 *
 * Every row belongs to a user. Accounts carry user_id; transactions inherit
 * it through their account. Nothing is fetched without a user_id in the
 * WHERE clause — that scoping is the only thing keeping two people who share
 * one install from seeing each other's money.
 */

const DB_PATH = resolve(process.env.LEDGER_DB ?? "data/ledger.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
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
    source       TEXT    NOT NULL DEFAULT 'manual',
    dedupe_key   TEXT,
    created_at   TEXT    NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_dedupe
    ON transactions(account_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/* ---------- migrations ---------- */

const columns = (table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/* accounts.user_id — added when single-user installs grew logins. */
if (!columns("accounts").includes("user_id")) {
  db.exec("ALTER TABLE accounts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
}

/* accounts.kind — checking | savings | credit. Purely for display and for
   guessing which imported rows are card payments. */
if (!columns("accounts").includes("kind")) {
  db.exec("ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'checking'");
}

/* transactions.is_transfer — money moving between the user's own accounts.
   Kept in the ledger but excluded from every spending/income total, so paying
   a credit card from checking doesn't double-count as spending. */
if (!columns("transactions").includes("is_transfer")) {
  db.exec("ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0");
}

/* Sessions gained a user_id. Rebuilding just signs everyone out, which is
   harmless, and avoids a nullable column we'd have to defend against forever. */
const sessionCols = columns("sessions");
if (sessionCols.length && !sessionCols.includes("user_id")) {
  db.exec("DROP TABLE sessions");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id)");

/**
 * Older installs kept a single passphrase in `settings` and had no users.
 * Convert that into a real account rather than stranding anyone's data.
 */
(function migrateLegacyPassphrase() {
  const legacyHash = db.prepare("SELECT value FROM settings WHERE key = 'passphrase_hash'").get();
  if (!legacyHash) return;

  const legacySalt = db.prepare("SELECT value FROM settings WHERE key = 'passphrase_salt'").get();
  const txnCount = db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n;

  if (txnCount === 0) {
    // Nothing to preserve — let the next launch set up a proper username.
    db.exec("DELETE FROM settings WHERE key IN ('passphrase_hash','passphrase_salt')");
    db.exec("DELETE FROM accounts WHERE user_id IS NULL");
    return;
  }

  // There is real data. Keep the existing passphrase and give it a username.
  db.prepare(
    "INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)"
  ).run("me", legacySalt.value, legacyHash.value, new Date().toISOString());

  const userId = db.prepare("SELECT id FROM users WHERE username = 'me'").get().id;
  db.prepare("UPDATE accounts SET user_id = ? WHERE user_id IS NULL").run(userId);
  db.exec("DELETE FROM settings WHERE key IN ('passphrase_hash','passphrase_salt')");

  console.log('  Migrated your existing passphrase to the username "me".');
})();

/* ---------- users ---------- */

export function userCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

export function findUser(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) ?? null;
}

export function findUserById(id) {
  return db.prepare("SELECT id, username FROM users WHERE id = ?").get(id) ?? null;
}

export function insertUser({ username, salt, hash }) {
  const info = db
    .prepare("INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)")
    .run(username, salt, hash, new Date().toISOString());

  const userId = Number(info.lastInsertRowid);

  // Every user starts with one account so the app is never half-set-up.
  db.prepare(
    "INSERT INTO accounts (name, currency, opening_balance_cents, user_id) VALUES (?, ?, ?, ?)"
  ).run("Checking", "USD", 0, userId);

  return userId;
}

/* ---------- accounts ---------- */

export function listAccounts(userId) {
  return db.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY id").all(userId);
}

export function createAccount(userId, { name, kind, opening_balance_cents }) {
  const info = db
    .prepare(
      "INSERT INTO accounts (name, kind, currency, opening_balance_cents, user_id) VALUES (?, ?, 'USD', ?, ?)"
    )
    .run(name, kind ?? "checking", opening_balance_cents ?? 0, userId);
  return Number(info.lastInsertRowid);
}

export function updateAccount(userId, id, { name, kind, opening_balance_cents }) {
  db.prepare(
    "UPDATE accounts SET name = ?, kind = ?, opening_balance_cents = ? WHERE id = ? AND user_id = ?"
  ).run(name, kind ?? "checking", opening_balance_cents, id, userId);
}

/** Refuses to delete the last account, so a user is never left with none. */
export function deleteAccount(userId, id) {
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?")
    .get(userId).n;

  if (remaining <= 1) return { error: "You need at least one account." };

  const info = db
    .prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return { deleted: info.changes };
}

/* ---------- transactions ---------- */

export function listTransactions(userId) {
  return db
    .prepare(
      `SELECT t.id, t.account_id, t.date, t.payee, t.memo, t.category,
              t.amount_cents, t.source, t.is_transfer,
              a.name AS account_name, a.kind AS account_kind
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.user_id = ?
        ORDER BY t.date DESC, t.id DESC`
    )
    .all(userId);
}

export function addTransaction(userId, txn) {
  // Resolve the account through the user, so a forged account_id can't write
  // into somebody else's ledger.
  const account = db
    .prepare("SELECT id FROM accounts WHERE user_id = ? AND id = ?")
    .get(userId, txn.account_id) ?? listAccounts(userId)[0];

  if (!account) throw new Error("No account for this user.");

  const info = db
    .prepare(
      `INSERT INTO transactions
         (account_id, date, payee, memo, category, amount_cents, source, dedupe_key, is_transfer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      account.id,
      txn.date,
      txn.payee,
      txn.memo ?? "",
      txn.category ?? "Uncategorized",
      txn.amount_cents,
      txn.source ?? "manual",
      txn.dedupe_key ?? null,
      txn.is_transfer ? 1 : 0,
      new Date().toISOString()
    );

  return Number(info.lastInsertRowid);
}

export function updateTransaction(userId, id, fields) {
  // account_id is validated against the user before it's written, so an edit
  // can move a transaction between the user's own accounts but nowhere else.
  const account = db
    .prepare("SELECT id FROM accounts WHERE user_id = ? AND id = ?")
    .get(userId, fields.account_id);

  const setAccount = account ? ", account_id = " + account.id : "";

  db.prepare(
    `UPDATE transactions
        SET date = ?, payee = ?, memo = ?, category = ?, amount_cents = ?, is_transfer = ?${setAccount}
      WHERE id = ?
        AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`
  ).run(
    fields.date,
    fields.payee,
    fields.memo ?? "",
    fields.category,
    fields.amount_cents,
    fields.is_transfer ? 1 : 0,
    id,
    userId
  );
}

/** Toggle just the transfer flag — used by the quick inline control. */
export function setTransferFlag(userId, id, isTransfer) {
  db.prepare(
    `UPDATE transactions
        SET is_transfer = ?
      WHERE id = ?
        AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`
  ).run(isTransfer ? 1 : 0, id, userId);
}

/**
 * Categories are free text on each transaction rather than rows in their own
 * table, so renaming one means rewriting every transaction that carries it.
 * Returns how many were changed.
 */
export function renameCategory(userId, from, to) {
  const info = db
    .prepare(
      `UPDATE transactions
          SET category = ?
        WHERE category = ?
          AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`
    )
    .run(to, from, userId);

  return info.changes;
}

export function deleteTransaction(userId, id) {
  db.prepare(
    `DELETE FROM transactions
      WHERE id = ?
        AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`
  ).run(id, userId);
}
