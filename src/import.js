import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";

/**
 * Bank CSV exports are messy in remarkably consistent ways. Each guard below
 * exists because some real bank does the thing it defends against.
 */

const DATE_HEADERS = ["date", "posted date", "posting date", "transaction date"];
const PAYEE_HEADERS = ["description", "payee", "name", "merchant", "details"];
const AMOUNT_HEADERS = ["amount", "amount (usd)", "transaction amount"];
const MEMO_HEADERS = ["memo", "notes", "note", "reference number"];

/** Excel writes a UTF-8 BOM that silently corrupts the first header name. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Banks outside the US often use ';' because ',' is their decimal separator.
 * Guess from whichever candidate appears most on the busiest line.
 */
function sniffDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const counts = [",", ";", "\t", "|"].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * BofA (and others) prepend an account-summary block before the real table,
 * so the header is not row 0. Find the first row that looks like a header.
 */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map((c) => String(c ?? "").trim().toLowerCase());
    const hasDate = cells.some((c) => DATE_HEADERS.includes(c));
    const hasAmount = cells.some((c) => AMOUNT_HEADERS.includes(c));
    if (hasDate && hasAmount) return i;
  }
  return -1;
}

function columnIndex(header, candidates) {
  for (const candidate of candidates) {
    const i = header.indexOf(candidate);
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Parse a money string straight to integer cents.
 *
 * Deliberately never routes through parseFloat — not even "just for a moment" —
 * because that is exactly where the precision we designed for gets thrown away.
 * Handles: $1,234.56 · 1.234,56 · (45.00) for negative · trailing CR/DR.
 */
export function parseAmountToCents(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;

  let negative = false;

  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/(^|\s)DR$/i.test(s)) negative = true;
  if (/(^|\s)CR$/i.test(s)) negative = false;

  s = s.replace(/\s*(CR|DR)\s*$/i, "");
  s = s.replace(/[^\d.,+-]/g, ""); // drop currency symbols and spaces

  // Without this, text with no digits strips to "" and Number("") is 0 —
  // an unreadable cell would import as a real zero-value transaction.
  if (!/\d/.test(s)) return null;

  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Whichever separator appears last is the decimal mark.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimalSep = null;

  if (lastComma !== -1 && lastDot !== -1) {
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma !== -1) {
    // A lone comma is a decimal mark only when it looks like one: 1,50 not 1,500
    decimalSep = s.length - lastComma - 1 <= 2 ? "," : null;
  } else if (lastDot !== -1) {
    decimalSep = s.length - lastDot - 1 <= 2 ? "." : null;
  }

  let whole = s;
  let frac = "";

  if (decimalSep) {
    const at = s.lastIndexOf(decimalSep);
    whole = s.slice(0, at);
    frac = s.slice(at + 1);
  }

  whole = whole.replace(/[.,]/g, "");
  frac = (frac + "00").slice(0, 2);

  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;

  const cents = Number(whole || "0") * 100 + Number(frac || "0");
  return negative ? -cents : cents;
}

/**
 * Parse a date into YYYY-MM-DD.
 *
 * 03/04/2026 is genuinely ambiguous — March 4 or April 3 depending on the bank —
 * and no amount of cleverness resolves it from the data. So the format is a
 * parameter of the import, not a guess.
 */
export function parseDate(raw, order = "MDY") {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const parts = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!parts) return null;

  let [, a, b, y] = parts;
  let month, day;

  if (order === "DMY") {
    day = a;
    month = b;
  } else {
    month = a;
    day = b;
  }

  if (y.length === 2) y = String(2000 + Number(y));

  const mm = String(Number(month)).padStart(2, "0");
  const dd = String(Number(day)).padStart(2, "0");

  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${y}-${mm}-${dd}`;
}

/**
 * CSV gives us no stable transaction id, so we synthesize one. The occurrence
 * counter is what keeps two genuine same-day, same-amount coffees from
 * collapsing into one row.
 */
function dedupeKey(date, cents, payee, occurrence) {
  const normalized = payee.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha1")
    .update(`${date}|${cents}|${normalized}|${occurrence}`)
    .digest("hex")
    .slice(0, 20);
}

/**
 * Very conservative guess at whether a row is money moving between the user's
 * own accounts rather than real spending — a credit-card payment or a
 * savings transfer. Only fires on unambiguous BofA descriptors; anything
 * marked here stays fully editable, so a false positive is one click to undo.
 */
const TRANSFER_PATTERNS = [
  /online banking transfer/i,
  /\btransfer\s+(to|from)\b/i,
  /crdcard|cred(it)?\s*card\s*(bill|pmt|payment)/i,
  /payment\s*-?\s*thank you/i,
  /\bbank of america credit card\b/i,
  /\bpymt\b/i,
];

export function looksLikeTransfer(payee) {
  return TRANSFER_PATTERNS.some((re) => re.test(payee));
}

/**
 * Parse a bank CSV into transaction rows. Returns { rows, skipped, headers }.
 * Nothing is written here — the caller decides what to persist.
 */
export function parseBankCsv(text, { dateOrder = "MDY" } = {}) {
  const clean = stripBom(text);
  const delimiter = sniffDelimiter(clean);

  const raw = parse(clean, {
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
  });

  const headerRow = findHeaderRow(raw);
  if (headerRow === -1) {
    throw new Error(
      "Could not find a header row with a date and an amount column. " +
        "Check that this is a transaction export rather than a statement summary."
    );
  }

  const header = raw[headerRow].map((c) => String(c ?? "").trim().toLowerCase());
  const iDate = columnIndex(header, DATE_HEADERS);
  const iPayee = columnIndex(header, PAYEE_HEADERS);
  const iAmount = columnIndex(header, AMOUNT_HEADERS);
  const iMemo = columnIndex(header, MEMO_HEADERS);

  const rows = [];
  const seen = new Map();
  let skipped = 0;

  for (let i = headerRow + 1; i < raw.length; i++) {
    const cells = raw[i];

    // Some exports repeat the header mid-file.
    if (String(cells[iDate] ?? "").trim().toLowerCase() === header[iDate]) continue;

    const date = parseDate(cells[iDate], dateOrder);
    const cents = parseAmountToCents(cells[iAmount]);

    if (date === null || cents === null) {
      skipped++;
      continue;
    }

    const payee = String(cells[iPayee] ?? "").trim() || "(no description)";
    const memo = iMemo !== -1 ? String(cells[iMemo] ?? "").trim() : "";

    const signature = `${date}|${cents}|${payee.toLowerCase()}`;
    const occurrence = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, occurrence);

    rows.push({
      date,
      payee,
      memo,
      amount_cents: cents,
      category: "Uncategorized",
      source: "import",
      is_transfer: looksLikeTransfer(payee),
      dedupe_key: dedupeKey(date, cents, payee, occurrence),
    });
  }

  return { rows, skipped, headers: header };
}
