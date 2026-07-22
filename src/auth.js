import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, findUser, findUserById, insertUser, userCount } from "./db.js";

/**
 * Username + password auth for a self-hosted app that may have a few people
 * on it — you and a partner, say, each with their own separate books.
 *
 * Hand-rolled on node:crypto rather than an auth framework: the whole surface
 * is hash, compare, hand out a token, look the token up. That is small enough
 * to read in one sitting, which is worth more here than a dependency.
 */

const KEY_LEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

export function hasAnyUsers() {
  return userCount() > 0;
}

export function validateCredentials(username, password) {
  if (typeof username !== "string" || !USERNAME_RE.test(username.trim())) {
    return "Usernames can be 2–32 letters, numbers, dots, dashes or underscores.";
  }
  if (typeof password !== "string" || password.length < 8) {
    return "Use a password of at least 8 characters.";
  }
  return null;
}

export function registerUser(username, password) {
  const name = username.trim();

  if (findUser(name)) {
    return { error: "That username is taken." };
  }

  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LEN).toString("hex");

  return { userId: insertUser({ username: name, salt, hash }) };
}

export function authenticate(username, password) {
  const user = findUser(String(username ?? "").trim());

  // Hash regardless of whether the user exists, so a missing username and a
  // wrong password take the same amount of time to reject.
  const salt = user?.salt ?? "0".repeat(32);
  const attempt = scryptSync(String(password ?? ""), salt, KEY_LEN);

  if (!user) return null;

  const expected = Buffer.from(user.hash, "hex");
  if (attempt.length !== expected.length || !timingSafeEqual(attempt, expected)) {
    return null;
  }

  return { id: user.id, username: user.username };
}

export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    new Date().toISOString()
  );
  return token;
}

/** Returns { id, username } for a live session, or null. */
export function sessionUser(token) {
  if (!token) return null;

  const row = db.prepare("SELECT user_id, created_at FROM sessions WHERE token = ?").get(token);
  if (!row) return null;

  if (Date.now() - new Date(row.created_at).getTime() > SESSION_TTL_MS) {
    destroySession(token);
    return null;
  }

  return findUserById(row.user_id);
}

export function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
