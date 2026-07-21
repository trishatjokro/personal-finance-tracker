import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, getSetting, setSetting } from "./db.js";

/**
 * Single-user auth, deliberately hand-rolled.
 *
 * This app is one person's copy of their own data on their own machine, so the
 * whole surface is: hash a passphrase, hand out a session token, check it.
 * Everything uses node:crypto — no dependency, nothing to keep patched, and
 * small enough to read end to end.
 */

const KEY_LEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function isConfigured() {
  return getSetting("passphrase_hash") !== null;
}

export function setPassphrase(passphrase) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(passphrase, salt, KEY_LEN).toString("hex");
  setSetting("passphrase_salt", salt);
  setSetting("passphrase_hash", hash);
}

export function verifyPassphrase(passphrase) {
  const salt = getSetting("passphrase_salt");
  const expected = getSetting("passphrase_hash");
  if (!salt || !expected) return false;

  const actual = scryptSync(passphrase, salt, KEY_LEN).toString("hex");

  // Constant-time compare so a wrong guess can't be timed against a right one.
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSession() {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, created_at) VALUES (?, ?)").run(
    token,
    new Date().toISOString()
  );
  return token;
}

export function isValidSession(token) {
  if (!token) return false;
  const row = db.prepare("SELECT created_at FROM sessions WHERE token = ?").get(token);
  if (!row) return false;

  if (Date.now() - new Date(row.created_at).getTime() > SESSION_TTL_MS) {
    destroySession(token);
    return false;
  }
  return true;
}

export function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
