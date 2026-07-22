import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import {
  addTransaction,
  deleteTransaction,
  listAccounts,
  listTransactions,
  updateAccount,
  updateTransaction,
} from "./db.js";
import {
  authenticate,
  createSession,
  destroySession,
  hasAnyUsers,
  registerUser,
  sessionUser,
  validateCredentials,
} from "./auth.js";
import { parseBankCsv } from "./import.js";

const app = new Hono();
const COOKIE = "ledger_session";
const PORT = Number(process.env.PORT ?? 3000);

/* ---------- auth gate ---------- */

const OPEN_ROUTES = ["/api/status", "/api/signup", "/api/login"];

app.use("/api/*", async (c, next) => {
  if (OPEN_ROUTES.includes(c.req.path)) return next();

  const user = sessionUser(getCookie(c, COOKIE));
  if (!user) return c.json({ error: "Not signed in." }, 401);

  // Everything downstream reads the user from here — never from the request
  // body, which the client controls.
  c.set("user", user);
  return next();
});

/* ---------- session ---------- */

app.get("/api/status", (c) => {
  const user = sessionUser(getCookie(c, COOKIE));
  return c.json({
    hasUsers: hasAnyUsers(),
    authenticated: Boolean(user),
    username: user?.username ?? null,
  });
});

app.post("/api/signup", async (c) => {
  const { username, password } = await c.req.json();

  const problem = validateCredentials(username, password);
  if (problem) return c.json({ error: problem }, 400);

  const result = registerUser(username, password);
  if (result.error) return c.json({ error: result.error }, 400);

  issueSession(c, result.userId);
  return c.json({ ok: true, username: username.trim() }, 201);
});

app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json();

  const user = authenticate(username, password);
  if (!user) return c.json({ error: "Wrong username or password." }, 401);

  issueSession(c, user.id);
  return c.json({ ok: true, username: user.username });
});

app.post("/api/logout", (c) => {
  destroySession(getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

function issueSession(c, userId) {
  setCookie(c, COOKIE, createSession(userId), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60,
  });
}

/* ---------- data ---------- */

app.get("/api/accounts", (c) => c.json(listAccounts(c.get("user").id)));

app.patch("/api/accounts/:id", async (c) => {
  const body = await c.req.json();
  updateAccount(c.get("user").id, Number(c.req.param("id")), {
    name: String(body.name ?? "Checking"),
    opening_balance_cents: Math.round(Number(body.opening_balance_cents ?? 0)),
  });
  return c.json({ ok: true });
});

app.get("/api/transactions", (c) => c.json(listTransactions(c.get("user").id)));

app.post("/api/transactions", async (c) => {
  const body = await c.req.json();
  const problem = validate(body);
  if (problem) return c.json({ error: problem }, 400);

  const userId = c.get("user").id;
  const id = addTransaction(userId, {
    account_id: Number(body.account_id ?? listAccounts(userId)[0]?.id),
    date: body.date,
    payee: String(body.payee).trim(),
    memo: String(body.memo ?? "").trim(),
    category: String(body.category ?? "Uncategorized").trim() || "Uncategorized",
    amount_cents: Math.round(Number(body.amount_cents)),
    source: "manual",
  });

  return c.json({ id }, 201);
});

app.patch("/api/transactions/:id", async (c) => {
  const body = await c.req.json();
  const problem = validate(body);
  if (problem) return c.json({ error: problem }, 400);

  updateTransaction(c.get("user").id, Number(c.req.param("id")), {
    date: body.date,
    payee: String(body.payee).trim(),
    memo: String(body.memo ?? "").trim(),
    category: String(body.category ?? "Uncategorized").trim() || "Uncategorized",
    amount_cents: Math.round(Number(body.amount_cents)),
  });

  return c.json({ ok: true });
});

app.delete("/api/transactions/:id", (c) => {
  deleteTransaction(c.get("user").id, Number(c.req.param("id")));
  return c.json({ ok: true });
});

function validate(body) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body?.date ?? "")) return "Pick a valid date.";
  if (!String(body?.payee ?? "").trim()) return "Add who it was paid to.";
  if (!Number.isFinite(Number(body?.amount_cents))) return "Enter a valid amount.";
  if (Number(body.amount_cents) === 0) return "Amount can't be zero.";
  return null;
}

/* ---------- import ---------- */

app.post("/api/import", async (c) => {
  const { csv, dateOrder } = await c.req.json();

  if (typeof csv !== "string" || !csv.trim()) {
    return c.json({ error: "No file contents received." }, 400);
  }

  let parsed;
  try {
    parsed = parseBankCsv(csv, { dateOrder: dateOrder === "DMY" ? "DMY" : "MDY" });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }

  const userId = c.get("user").id;
  const accountId = listAccounts(userId)[0]?.id;
  let added = 0;
  let duplicates = 0;

  for (const row of parsed.rows) {
    try {
      addTransaction(userId, { ...row, account_id: accountId });
      added++;
    } catch (err) {
      // The unique index on (account_id, dedupe_key) is what makes re-importing
      // the same file safe — a repeat row is rejected here rather than doubled up.
      if (String(err.message).includes("UNIQUE")) duplicates++;
      else throw err;
    }
  }

  return c.json({ added, duplicates, skipped: parsed.skipped });
});

/* ---------- static ---------- */

app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\n  Girl Math is running — open http://localhost:${PORT}\n`);
});
