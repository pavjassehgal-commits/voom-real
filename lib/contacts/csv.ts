// Pure CSV parser + mapper for the Contacts import flow.
// Side-effect free. No network. No AI. No third-party processing.
//
// The parser supports a small subset of CSV that is sufficient for contact
// imports: a header row, comma separators, optional double-quoted fields
// with escaped quotes (""), and CRLF or LF line endings.
//
// The mapper takes the parsed rows and:
//   - detects columns by header alias
//   - normalizes email + phone
//   - validates each row (per `validateCreateContact` rules)
//   - splits rows into valid / invalid / duplicate / already-existing
//
// The result is a complete review-ready plan. Nothing is written to the
// database here.

import { isValidE164, normalizeEmail } from "./core";

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
  /** Total number of data rows (excluding header). */
  rowCount: number;
}

export interface CsvImportRow {
  /** 1-based source row number (excluding header). */
  sourceRow: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  errors: string[];
}

export interface CsvImportPlan {
  /** Headers detected in the CSV (lower-cased + trimmed). */
  detectedHeaders: string[];
  /** Map of field → detected header name (or null if not found). */
  mapping: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    tags: string | null;
  };
  valid: CsvImportRow[];
  invalid: CsvImportRow[];
  duplicate: CsvImportRow[];
  /** Rows that are valid but whose email/phone already exists in DB. */
  alreadyExisting: CsvImportRow[];
  /** Number of rows that would be created on import (= valid - alreadyExisting). */
  toCreate: number;
}

export const HEADER_ALIASES: Record<keyof CsvImportPlan["mapping"], string[]> = {
  first_name: ["first name", "first", "firstname", "given name", "given"],
  last_name: ["last name", "last", "lastname", "surname", "family name", "family"],
  email: ["email", "email address", "e-mail", "e-mail address", "mail"],
  phone: ["phone", "mobile", "cell", "cellphone", "telephone", "phone number", "mobile number"],
  tags: ["tags", "tag", "labels", "label"],
};

export const MAX_CSV_BYTES = 5 * 1024 * 1024; // ~5 MB

// ─── CSV parsing ──────────────────────────────────────────────────────────

/**
 * Parse a CSV string. Supports:
 *   - comma separators
 *   - double-quoted fields with "" escapes
 *   - CRLF / LF / CR line endings
 *   - empty trailing newline
 */
export function parseCsv(input: string): CsvParseResult {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      // ignore the LF half of CRLF
      if (ch === "\r" && input[i + 1] === "\n") i++;
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  if (rows.length === 0) {
    return { headers: [], rows: [], rowCount: 0 };
  }

  const [headers, ...body] = rows;
  return {
    headers: headers.map((h) => h.trim()),
    rows: body,
    rowCount: body.length,
  };
}

/**
 * Light validation: confirm the upload is plain text and within the size cap.
 * Does NOT attempt to parse or pre-judge content.
 */
export function validateCsvUpload(file: { name: string; size: number }): { ok: true } | { ok: false; error: string } {
  if (file.size <= 0) return { ok: false, error: "The file is empty." };
  if (file.size > MAX_CSV_BYTES) {
    return {
      ok: false,
      error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). The limit is ${MAX_CSV_BYTES / 1024 / 1024} MB.`,
    };
  }
  if (!/\.csv$/i.test(file.name)) {
    return { ok: false, error: "Only .csv files are supported." };
  }
  return { ok: true };
}

// ─── Column detection ─────────────────────────────────────────────────────

function normaliseHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, " ");
}

function detectMapping(headers: string[]): CsvImportPlan["mapping"] {
  const norm = headers.map(normaliseHeader);
  const mapping: CsvImportPlan["mapping"] = {
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    tags: null,
  };
  (Object.keys(HEADER_ALIASES) as (keyof CsvImportPlan["mapping"])[]).forEach((field) => {
    for (const alias of HEADER_ALIASES[field]) {
      const idx = norm.indexOf(alias);
      if (idx >= 0) {
        mapping[field] = headers[idx];
        break;
      }
    }
  });
  return mapping;
}

// ─── Row mapping + validation ─────────────────────────────────────────────

function splitTags(value: string): string[] {
  return value
    .split(/[;,|]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function mapRow(
  headers: string[],
  values: string[],
  sourceRow: number,
  mapping: CsvImportPlan["mapping"],
): CsvImportRow {
  const get = (header: string | null): string => {
    if (!header) return "";
    const idx = headers.indexOf(header);
    if (idx < 0) return "";
    return (values[idx] ?? "").trim();
  };

  const firstRaw = get(mapping.first_name);
  const lastRaw = get(mapping.last_name);
  const emailRaw = get(mapping.email);
  const phoneRaw = get(mapping.phone);
  const tagsRaw = get(mapping.tags);

  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  const phone = phoneRaw ? phoneRaw : null;
  const tags = tagsRaw ? splitTags(tagsRaw) : [];

  const errors: string[] = [];
  if (!email && !phone) {
    errors.push("A contact needs at least an email or a phone number.");
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Email is not valid.");
  }
  if (phone && !isValidE164(phone)) {
    errors.push("Phone must be in E.164 format (e.g. +14155551234).");
  }

  return {
    sourceRow,
    first_name: firstRaw || null,
    last_name: lastRaw || null,
    email: email || null,
    phone: phone || null,
    tags,
    errors,
  };
}

// ─── Public plan builder ──────────────────────────────────────────────────

/**
 * Build an import plan from raw CSV text. The plan can be displayed to the
 * user for review, then handed to the server action for actual creation.
 *
 * @param existingEmails   emails already in the owner's contacts (lowercase)
 * @param existingPhones   phones already in the owner's contacts (E.164)
 */
export function buildImportPlan(
  rawCsv: string,
  existingEmails: string[] = [],
  existingPhones: string[] = [],
): CsvImportPlan {
  const parsed = parseCsv(rawCsv);
  if (parsed.headers.length === 0) {
    return {
      detectedHeaders: [],
      mapping: { first_name: null, last_name: null, email: null, phone: null, tags: null },
      valid: [],
      invalid: [],
      duplicate: [],
      alreadyExisting: [],
      toCreate: 0,
    };
  }

  const mapping = detectMapping(parsed.headers);

  // Required: at least email or phone detected
  if (!mapping.email && !mapping.phone) {
    return {
      detectedHeaders: parsed.headers,
      mapping,
      valid: [],
      invalid: parsed.rows.map((_, i) => ({
        sourceRow: i + 1,
        first_name: null,
        last_name: null,
        email: null,
        phone: null,
        tags: [],
        errors: ["No email or phone column detected in the CSV header."],
      })),
      duplicate: [],
      alreadyExisting: [],
      toCreate: 0,
    };
  }

  const emailSet = new Set(existingEmails.map((e) => normalizeEmail(e)).filter(Boolean) as string[]);
  const phoneSet = new Set(existingPhones.filter(Boolean) as string[]);

  const valid: CsvImportRow[] = [];
  const invalid: CsvImportRow[] = [];
  const seenInFile = { email: new Set<string>(), phone: new Set<string>() };

  parsed.rows.forEach((values, idx) => {
    const row = mapRow(parsed.headers, values, idx + 1, mapping);
    if (row.errors.length > 0) {
      invalid.push(row);
      return;
    }
    // Within-file duplicates
    let dup = false;
    if (row.email) {
      if (seenInFile.email.has(row.email)) dup = true;
      else seenInFile.email.add(row.email);
    }
    if (row.phone) {
      if (seenInFile.phone.has(row.phone)) dup = true;
      else seenInFile.phone.add(row.phone);
    }
    if (dup) {
      // Attach a duplicate marker without including in `valid`
      invalid.push({ ...row, errors: ["Duplicate row in this file."] });
      return;
    }
    // Already-existing in DB?
    const existsEmail = row.email ? emailSet.has(row.email) : false;
    const existsPhone = row.phone ? phoneSet.has(row.phone) : false;
    if (existsEmail || existsPhone) {
      valid.push(row); // keeps it as a "valid row" the user already has
      return;
    }
    valid.push(row);
  });

  const alreadyExisting = valid.filter(
    (r) =>
      (r.email ? emailSet.has(r.email) : false) ||
      (r.phone ? phoneSet.has(r.phone) : false),
  );
  const toCreate = valid.length - alreadyExisting.length;

  return {
    detectedHeaders: parsed.headers,
    mapping,
    valid,
    invalid,
    duplicate: invalid.filter((r) => /Duplicate row/.test(r.errors[0] ?? "")),
    alreadyExisting,
    toCreate,
  };
}
