import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmountToCents, parseDate, parseBankCsv } from "../src/import.js";

/* Every case below is a shape some real bank export actually produces. */

test("amounts parse to integer cents", () => {
  assert.equal(parseAmountToCents("24.50"), 2450);
  assert.equal(parseAmountToCents("$1,234.56"), 123456);
  assert.equal(parseAmountToCents("-1950.00"), -195000);
  assert.equal(parseAmountToCents("(45.00)"), -4500, "parentheses mean negative");
  assert.equal(parseAmountToCents("85.00 DR"), -8500, "DR marker means debit");
  assert.equal(parseAmountToCents("85.00 CR"), 8500, "CR marker means credit");
  assert.equal(parseAmountToCents("1.234,56"), 123456, "European decimal comma");
  assert.equal(parseAmountToCents("1,50"), 150, "lone comma as decimal mark");
  assert.equal(parseAmountToCents("1,500"), 150000, "lone comma as thousands mark");
  assert.equal(parseAmountToCents("100"), 10000, "no decimal part");
  assert.equal(parseAmountToCents(""), null);
  assert.equal(parseAmountToCents("not a number"), null);
});

test("no float ever touches the amount path", () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point. Cents are exact, so these
  // sum to a round number rather than 30.000000000000004.
  const total = parseAmountToCents("0.10") + parseAmountToCents("0.20");
  assert.equal(total, 30);
});

test("dates respect the declared field order", () => {
  assert.equal(parseDate("07/15/2026", "MDY"), "2026-07-15");
  assert.equal(parseDate("15/07/2026", "DMY"), "2026-07-15");

  // The genuinely ambiguous case: same input, different answer by declared
  // order. This is why the format is a parameter and never a guess.
  assert.equal(parseDate("03/04/2026", "MDY"), "2026-03-04");
  assert.equal(parseDate("03/04/2026", "DMY"), "2026-04-03");

  assert.equal(parseDate("2026-07-15"), "2026-07-15", "already ISO");
  assert.equal(parseDate("7/5/26", "MDY"), "2026-07-05", "two-digit year, no padding");
  assert.equal(parseDate("garbage"), null);
});

test("skips the summary preamble and finds the real header", () => {
  const csv = [
    "Description,,Summary Amt.",
    'Beginning balance as of 07/01/2026,,"$4,863.00"',
    "",
    "Date,Description,Amount,Running Bal.",
    '07/01/2026,"SUNNYSIDE APARTMENTS",-1950.00,"2,913.00"',
    '07/10/2026,"MERIDIAN DESIGN","4,125.00","6,950.58"',
  ].join("\n");

  const { rows, skipped } = parseBankCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 0);
  assert.equal(rows[0].amount_cents, -195000);
  assert.equal(rows[1].amount_cents, 412500);
});

test("handles a UTF-8 BOM without corrupting the first header", () => {
  const csv = "﻿Date,Description,Amount\n07/01/2026,Rent,-1950.00\n";
  const { rows } = parseBankCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payee, "Rent");
});

test("detects a semicolon delimiter", () => {
  const csv = "Date;Description;Amount\n01/07/2026;Kopi;-45,50\n";
  const { rows } = parseBankCsv(csv, { dateOrder: "DMY" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2026-07-01");
  assert.equal(rows[0].amount_cents, -4550);
});

test("same-day identical charges stay distinct", () => {
  const csv = [
    "Date,Description,Amount",
    "07/02/2026,Philz Coffee,-4.50",
    "07/02/2026,Philz Coffee,-4.50",
  ].join("\n");

  const { rows } = parseBankCsv(csv);
  assert.equal(rows.length, 2);
  assert.notEqual(
    rows[0].dedupe_key,
    rows[1].dedupe_key,
    "two real coffees must not collapse into one"
  );
});

test("re-parsing the same file yields the same dedupe keys", () => {
  const csv = "Date,Description,Amount\n07/01/2026,Rent,-1950.00\n";
  const a = parseBankCsv(csv).rows[0].dedupe_key;
  const b = parseBankCsv(csv).rows[0].dedupe_key;
  assert.equal(a, b, "import must be idempotent across runs");
});

test("unreadable rows are counted, not silently dropped", () => {
  const csv = [
    "Date,Description,Amount",
    "07/01/2026,Rent,-1950.00",
    "not-a-date,Broken,abc",
  ].join("\n");

  const { rows, skipped } = parseBankCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(skipped, 1);
});

test("a statement summary with no transaction table is rejected clearly", () => {
  const csv = "Description,,Summary Amt.\nBeginning balance,,\"$4,863.00\"\n";
  assert.throws(() => parseBankCsv(csv), /header row/i);
});
