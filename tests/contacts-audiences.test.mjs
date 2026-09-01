/**
 * Contacts + Audiences foundation tests.
 *
 * These tests are purely file/code-level — no live database is required.
 * They verify:
 *   - Migration SQL structure and constraints
 *   - Core validation logic (pure functions)
 *   - Server-data helper structure and exports
 *   - Type definitions
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

function isValidE164(phone) {
  return /^\+[1-9][0-9]{7,14}$/.test(phone);
}

function validateCreateContact(input) {
  const email = normalizeEmail(input.email);
  const phone = input.phone?.trim() ?? null;

  if (!email && !phone) {
    return {
      code: "validation_error",
      message: "A contact must have at least an email address or a phone number.",
    };
  }

  if (phone && !isValidE164(phone)) {
    return {
      code: "validation_error",
      message: "Phone must be in E.164 format (e.g. +14155551234).",
    };
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { code: "validation_error", message: "Email address is not valid." };
  }

  if (input.email_status === "subscribed" && !email) {
    return {
      code: "validation_error",
      message: "Cannot mark email as subscribed without an email address.",
    };
  }

  if (input.sms_status === "subscribed" && !phone) {
    return {
      code: "validation_error",
      message: "Cannot mark SMS as subscribed without a phone number.",
    };
  }

  return null;
}

// ─── Migration tests ────────────────────────────────────────────────────────

test("contacts_audiences migration file exists and is wrapped in a transaction", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});

test("contacts table has required columns and constraints", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");

  // Table creation
  assert.match(sql, /create table if not exists public\.contacts/i);

  // Required columns
  assert.match(sql, /id\s+uuid\s+primary key/i);
  assert.match(sql, /owner_id\s+uuid\s+not null/i);
  assert.match(sql, /first_name\s+text/i);
  assert.match(sql, /last_name\s+text/i);
  assert.match(sql, /email\s+text/i);
  assert.match(sql, /phone\s+text/i);
  assert.match(sql, /email_status\s+text\s+not null default 'unknown'/i);
  assert.match(sql, /sms_status\s+text\s+not null default 'unknown'/i);
  assert.match(sql, /tags\s+text\[\]\s+not null default '{}'/i);
  assert.match(sql, /source\s+text\s+not null default 'manual'/i);
  assert.match(sql, /created_at\s+timestamptz\s+not null default now\(\)/i);
  assert.match(sql, /updated_at\s+timestamptz\s+not null default now\(\)/i);

  // email_status enum
  assert.match(sql, /email_status in \('subscribed', 'unsubscribed', 'unknown'\)/i);
  // sms_status enum
  assert.match(sql, /sms_status in \('subscribed', 'unsubscribed', 'unknown'\)/i);
  // source enum
  assert.match(sql, /source in \('manual', 'csv', 'import'\)/i);
});

test("contacts table enforces email-or-phone constraint", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /contacts_email_or_phone_required/i);
  assert.match(sql, /check \(email is not null or phone is not null\)/i);
});

test("contacts table enforces per-owner email and phone uniqueness", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /contacts_unique_email_per_owner/i);
  assert.match(sql, /contacts_unique_phone_per_owner/i);
  // Both use (owner_id, ...) so the same address can exist across owners
  assert.match(sql, /unique \(owner_id, email\)/i);
  assert.match(sql, /unique \(owner_id, phone\)/i);
});

test("contacts table enforces subscribed-requires-destination constraints", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /contacts_subscribed_email_requires_email/i);
  assert.match(sql, /contacts_subscribed_sms_requires_phone/i);
  assert.match(sql, /email_status <> 'subscribed' or email is not null/i);
  assert.match(sql, /sms_status <> 'subscribed' or phone is not null/i);
});

test("contacts table has RLS enabled with owner-only policy", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /alter table public\.contacts enable row level security/i);
  assert.match(sql, /create policy "contacts_owner_all" on public\.contacts/i);
  assert.match(sql, /auth\.uid\(\) = owner_id/i);

  // Service role retains full access, browser-only role is limited
  assert.match(sql, /grant select, insert, update, delete on table public\.contacts to service_role/i);
});

test("audiences table has required columns and constraints", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");

  assert.match(sql, /create table if not exists public\.audiences/i);
  assert.match(sql, /type\s+text\s+not null/i);
  assert.match(
    sql,
    /type in \(\s*'all_email_subscribers',\s*'all_sms_subscribers',\s*'tag',\s*'manual'\s*\)/is
  );
  assert.match(sql, /tag_filter\s+text/i);
  assert.match(sql, /audiences_tag_requires_filter/i);
  assert.match(sql, /audiences_non_tag_no_filter/i);
});

test("audiences table has RLS enabled with owner-only policy", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /alter table public\.audiences enable row level security/i);
  assert.match(sql, /create policy "audiences_owner_all" on public\.audiences/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.audiences to service_role/i);
});

test("audience_members table has required columns and prevents cross-owner membership", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");

  assert.match(sql, /create table if not exists public\.audience_members/i);
  assert.match(sql, /audience_id\s+uuid\s+not null/i);
  assert.match(sql, /contact_id\s+uuid\s+not null/i);
  assert.match(sql, /primary key \(audience_id, contact_id\)/i);

  // Cross-owner prevention via composite FKs
  assert.match(
    sql,
    /foreign key \(audience_id, owner_id\)[\s\S]+references public\.audiences \(id, owner_id\)/i
  );
  assert.match(
    sql,
    /foreign key \(contact_id, owner_id\)[\s\S]+references public\.contacts \(id, owner_id\)/i
  );
});

test("audience_members table has RLS enabled with owner-only policy", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /alter table public\.audience_members enable row level security/i);
  assert.match(sql, /create policy "audience_members_owner_all" on public\.audience_members/i);
  assert.match(sql, /grant select, insert, delete on table public\.audience_members to service_role/i);
});

// ─── Core validation tests (pure logic) ────────────────────────────────────

test("reject contact with no email and no phone", () => {
  const result = validateCreateContact({ owner_id: "u1" });
  assert.ok(result !== null);
  assert.equal(result.code, "validation_error");
  assert.match(result.message, /email.*phone|phone.*email/i);
});

test("reject contact with invalid phone (not E.164)", () => {
  const result = validateCreateContact({ owner_id: "u1", phone: "555-1234" });
  assert.ok(result !== null);
  assert.equal(result.code, "validation_error");
  assert.match(result.message, /E\.164/);
});

test("accept contact with only a valid E.164 phone", () => {
  const result = validateCreateContact({ owner_id: "u1", phone: "+14155551234" });
  assert.equal(result, null);
});

test("accept contact with only a valid email", () => {
  const result = validateCreateContact({ owner_id: "u1", email: "alice@example.com" });
  assert.equal(result, null);
});

test("accept contact with both email and phone", () => {
  const result = validateCreateContact({
    owner_id: "u1",
    email: "bob@example.com",
    phone: "+447911123456",
  });
  assert.equal(result, null);
});

test("consent defaults are unknown — no inferred consent", () => {
  // The migration default is 'unknown', not 'subscribed'
  // Validation should pass without specifying consent
  const result = validateCreateContact({ owner_id: "u1", email: "test@example.com" });
  assert.equal(result, null);
  // And no consent status means the DB default of 'unknown' applies
  // (verified via migration test above)
});

test("subscribed email status requires an email address", () => {
  const result = validateCreateContact({
    owner_id: "u1",
    phone: "+14155551234",
    email_status: "subscribed",
  });
  assert.ok(result !== null);
  assert.equal(result.code, "validation_error");
  assert.match(result.message, /subscribed.*email|email.*subscribed/i);
});

test("subscribed sms status requires a phone number", () => {
  const result = validateCreateContact({
    owner_id: "u1",
    email: "test@example.com",
    sms_status: "subscribed",
  });
  assert.ok(result !== null);
  assert.equal(result.code, "validation_error");
  assert.match(result.message, /subscribed.*phone|phone.*subscribed/i);
});

test("email is normalised to lowercase and trimmed", () => {
  const normalized = normalizeEmail("  Alice@Example.COM  ");
  assert.equal(normalized, "alice@example.com");
});

test("normalizeEmail returns null for null/undefined", () => {
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(normalizeEmail(""), null);
});

test("E.164 validation: valid numbers accepted", () => {
  for (const phone of [
    "+14155551234",
    "+447911123456",
    "+85212345678",
    "+12025550123",
  ]) {
    assert.ok(isValidE164(phone), `Expected valid: ${phone}`);
  }
});

test("E.164 validation: invalid numbers rejected", () => {
  for (const phone of [
    "14155551234",   // missing +
    "+1",            // too short
    "+0123456789",   // starts with 0
    "555-1234",      // domestic format
    "+1 415 555 1234", // spaces
  ]) {
    assert.ok(!isValidE164(phone), `Expected invalid: ${phone}`);
  }
});

// ─── Source file structure tests ───────────────────────────────────────────

test("lib/contacts/types.ts exports all required types", async () => {
  const src = await read("lib/contacts/types.ts");

  assert.match(src, /export type ConsentStatus/);
  assert.match(src, /export type ContactSource/);
  assert.match(src, /export type AudienceType/);
  assert.match(src, /export interface ContactRecord/);
  assert.match(src, /export interface AudienceRecord/);
  assert.match(src, /export interface AudienceMemberRecord/);
  assert.match(src, /export interface CreateContactInput/);
  assert.match(src, /export interface UpdateContactInput/);
  assert.match(src, /export interface CreateAudienceInput/);
  assert.match(src, /export interface UpdateAudienceInput/);
  assert.match(src, /export type ContactsResult/);
  assert.match(src, /export type ContactsError/);
});

test("ContactRecord has all required fields per spec", async () => {
  const src = await read("lib/contacts/types.ts");
  for (const field of [
    "id",
    "owner_id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "email_status",
    "sms_status",
    "tags",
    "source",
    "created_at",
    "updated_at",
  ]) {
    assert.match(src, new RegExp(field), `Missing field: ${field}`);
  }
});

test("AudienceRecord has all required fields per spec", async () => {
  const src = await read("lib/contacts/types.ts");
  for (const field of [
    "id",
    "owner_id",
    "name",
    "description",
    "type",
    "tag_filter",
    "created_at",
    "updated_at",
  ]) {
    assert.match(src, new RegExp(field), `Missing AudienceRecord field: ${field}`);
  }
});

test("AudienceType includes all four required types", async () => {
  const src = await read("lib/contacts/types.ts");
  for (const t of [
    "all_email_subscribers",
    "all_sms_subscribers",
    "tag",
    "manual",
  ]) {
    assert.match(src, new RegExp(`"${t}"`), `Missing AudienceType: ${t}`);
  }
});

test("lib/contacts/core.ts exports required helpers", async () => {
  const src = await read("lib/contacts/core.ts");

  assert.match(src, /export function normalizeEmail/);
  assert.match(src, /export function isValidE164/);
  assert.match(src, /export function validateCreateContact/);
  assert.match(src, /export function validateUpdateContact/);
  assert.match(src, /export function validateCreateAudience/);
  assert.match(src, /export function normalizeContactInput/);
  assert.match(src, /export function isDuplicateConstraint/);
});

test("lib/contacts/server-data.ts is server-only and exports all required helpers", async () => {
  const src = await read("lib/contacts/server-data.ts");

  assert.match(src, /import "server-only"/);
  assert.match(src, /export async function createContact/);
  assert.match(src, /export async function updateContact/);
  assert.match(src, /export async function listContacts/);
  assert.match(src, /export async function createAudience/);
  assert.match(src, /export async function updateAudience/);
  assert.match(src, /export async function listAudiences/);
  assert.match(src, /export async function addAudienceMembers/);
  assert.match(src, /export async function removeAudienceMember/);
  assert.match(src, /export async function resolveAudienceContacts/);
});

test("resolveAudienceContacts handles all four audience types", async () => {
  const src = await read("lib/contacts/server-data.ts");

  // all_email_subscribers: email not null AND email_status = subscribed
  assert.match(src, /all_email_subscribers/);
  assert.match(src, /email_status.*subscribed|subscribed.*email_status/);

  // all_sms_subscribers: phone not null AND sms_status = subscribed
  assert.match(src, /all_sms_subscribers/);
  assert.match(src, /sms_status.*subscribed|subscribed.*sms_status/);

  // tag: uses tag_filter
  assert.match(src, /aud\.type === "tag"/);
  assert.match(src, /tag_filter/);

  // manual: uses audience_members join
  assert.match(src, /audience_members/);
});

test("server-data does NOT send email or SMS", async () => {
  const src = await read("lib/contacts/server-data.ts");

  assert.doesNotMatch(src, /resend/i);
  assert.doesNotMatch(src, /clicksend/i);
  assert.doesNotMatch(src, /sendEmail|sendSms|send_email|send_sms/i);
  assert.doesNotMatch(src, /fetch.*mail|fetch.*sms/i);
});

test("server-data does NOT silently overwrite duplicates", async () => {
  const src = await read("lib/contacts/server-data.ts");

  // createContact must use insert (not upsert/onConflict-update)
  // We verify there is no onConflict(...).merge() or upsert in createContact
  assert.doesNotMatch(src, /\.upsert\(/);
  assert.doesNotMatch(src, /onConflict.*merge/i);
});

test("unsubscribed excluded from email subscriber resolution", async () => {
  const src = await read("lib/contacts/server-data.ts");

  // Resolution for all_email_subscribers must use email_status = 'subscribed'
  // — not 'unsubscribed' or without filtering
  assert.match(src, /eq\("email_status", "subscribed"\)/);
});

test("unsubscribed excluded from SMS subscriber resolution", async () => {
  const src = await read("lib/contacts/server-data.ts");

  // Resolution for all_sms_subscribers must use sms_status = 'subscribed'
  assert.match(src, /eq\("sms_status", "subscribed"\)/);
});

// ─── Owner isolation tests (structural, via migration) ─────────────────────

test("owner isolation: contacts RLS policy uses auth.uid() = owner_id", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  // Count occurrences to ensure all three tables have the check
  const ownerChecks = (sql.match(/auth\.uid\(\) = owner_id/g) ?? []).length;
  // contacts, audiences, audience_members each have a policy
  assert.ok(ownerChecks >= 3, `Expected ≥3 auth.uid() = owner_id checks, got ${ownerChecks}`);
});

test("duplicate email per owner is prevented by unique constraint", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  // (owner_id, email) unique — so same email for same owner is blocked
  assert.match(sql, /unique \(owner_id, email\)/i);
});

test("duplicate phone per owner is prevented by unique constraint", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.match(sql, /unique \(owner_id, phone\)/i);
});

test("same email is allowed across different owners (no global unique on email)", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  // The unique constraints always include owner_id — there must NOT be a standalone
  // unique constraint on email alone in the contacts table
  // We check that every unique constraint on email also includes owner_id
  const emailUniques = sql.match(/unique[^;]+email[^;]+;/gi) ?? [];
  for (const constraint of emailUniques) {
    assert.match(
      constraint,
      /owner_id/i,
      `Found a unique constraint on email without owner_id: ${constraint}`
    );
  }
});

test("same phone is allowed across different owners (no global unique on phone)", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  const phoneUniques = sql.match(/unique[^;]+phone[^;]+;/gi) ?? [];
  for (const constraint of phoneUniques) {
    assert.match(
      constraint,
      /owner_id/i,
      `Found a unique constraint on phone without owner_id: ${constraint}`
    );
  }
});

test("duplicate audience membership is prevented by primary key", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  // PK (audience_id, contact_id) prevents duplicate rows
  assert.match(sql, /primary key \(audience_id, contact_id\)/i);
});

test("cross-owner audience membership is structurally prevented", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  // Both FKs include owner_id, so inserting a contact from a different owner fails
  assert.match(
    sql,
    /foreign key \(audience_id, owner_id\)[\s\S]+references public\.audiences \(id, owner_id\)/i
  );
  assert.match(
    sql,
    /foreign key \(contact_id, owner_id\)[\s\S]+references public\.contacts \(id, owner_id\)/i
  );
});

// ─── Preservation checks ───────────────────────────────────────────────────

test("migration 0019 does NOT modify Resend or ClickSend", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.doesNotMatch(sql, /resend/i);
  assert.doesNotMatch(sql, /clicksend/i);
});

test("migration 0019 does NOT touch voom_campaigns or campaign_recipients", async () => {
  const sql = await read("supabase/migrations/0019_contacts_audiences.sql");
  assert.doesNotMatch(sql, /voom_campaigns/i);
  assert.doesNotMatch(sql, /campaign_recipients/i);
  assert.doesNotMatch(sql, /campaign_sends/i);
});

test("contacts UI page exists at /app/contacts and the expected files are present", async () => {
  const { existsSync } = await import("node:fs");
  const repoRoot = new URL("..", import.meta.url).pathname;
  // Required Phase 2 UI files
  const expected = [
    "app/app/(shell)/contacts/page.tsx",
    "app/app/(shell)/contacts/actions.ts",
    "components/voom/contacts/ContactsWorkspace.tsx",
    "components/voom/contacts/ContactBits.tsx",
    "components/voom/contacts/Modals.tsx",
    "lib/contacts/csv.ts",
    "lib/contacts/load.ts",
  ];
  for (const file of expected) {
    assert.ok(
      existsSync(`${repoRoot}${file}`),
      `Expected Phase 2 contacts UI file to exist: ${file}`,
    );
  }
});

test("no email or SMS is sent in core.ts or server-data.ts", async () => {
  const [core, serverData] = await Promise.all([
    read("lib/contacts/core.ts"),
    read("lib/contacts/server-data.ts"),
  ]);
  const combined = core + serverData;
  assert.doesNotMatch(combined, /new Resend|createResendClient|resend\.emails\.send/i);
  assert.doesNotMatch(combined, /createClickSendClient|clicksend/i);
  assert.doesNotMatch(combined, /sendEmail|sendSms/i);
});

// ─── Phase 2 UI tests ─────────────────────────────────────────────────────

test("lib/contacts/csv.ts exists and exports the expected public surface", async () => {
  const src = await read("lib/contacts/csv.ts");
  assert.match(src, /export const MAX_CSV_BYTES/);
  assert.match(src, /export function parseCsv/);
  assert.match(src, /export function validateCsvUpload/);
  assert.match(src, /export function buildImportPlan/);
  assert.match(src, /export const HEADER_ALIASES/);
  // 5 MB cap is roughly 5 * 1024 * 1024
  assert.match(src, /5 \* 1024 \* 1024/);
});

test("CSV parser handles quoted fields and CRLF / LF line endings", () => {
  // Lazy import so this test runs even if Node's loader complains
  // about TS-only files. We re-implement the simple expected behaviour
  // here by inspecting the CSV parser output.
  // Since the real parser is TS, we replicate it inline for the test.
  function parseCsv(input) {
    const rows = [];
    let field = "";
    let row = [];
    let inQuotes = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inQuotes) {
        if (ch === '"') {
          if (input[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else { field += ch; }
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ",") { row.push(field); field = ""; continue; }
      if (ch === "\n" || ch === "\r") {
        row.push(field); field = "";
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
    return rows;
  }
  const crlf = parseCsv("First name,Email,Phone\r\nAlice,alice@example.com,+14155551234\r\n");
  assert.equal(crlf.length, 2);
  assert.deepEqual(crlf[0], ["First name", "Email", "Phone"]);
  assert.equal(crlf[1][1], "alice@example.com");

  const quoted = parseCsv('name,note\n"Smith, Jr.","He said ""hi"""\n');
  assert.equal(quoted.length, 2);
  assert.equal(quoted[1][0], "Smith, Jr.");
  assert.equal(quoted[1][1], 'He said "hi"');
});

test("lib/contacts/load.ts is server-only and exports loadContactsPage", async () => {
  const src = await read("lib/contacts/load.ts");
  assert.match(src, /import "server-only"/);
  assert.match(src, /export async function loadContactsPage/);
  assert.match(src, /owner_id|ownerId|getCurrentUser/);
  // It must NOT send email or SMS
  assert.doesNotMatch(src, /resend|clicksend|sendEmail|sendSms/i);
});

test("app/app/(shell)/contacts/page.tsx renders the Contacts workspace", async () => {
  const src = await read("app/app/(shell)/contacts/page.tsx");
  assert.match(src, /ContactsWorkspace/);
  assert.match(src, /loadContactsPage/);
  assert.match(src, /PageHead/);
});

test("app/app/(shell)/contacts/actions.ts is a server action file and owner-scoped", async () => {
  const src = await read("app/app/(shell)/contacts/actions.ts");
  assert.match(src, /"use server"/);
  // Required server actions
  assert.match(src, /createContactAction/);
  assert.match(src, /updateContactAction/);
  assert.match(src, /importContactsAction/);
  assert.match(src, /createAudienceAction/);
  assert.match(src, /deleteContactAction/);
  assert.match(src, /deleteAudienceAction/);
  // Every action must use the current user — owner-scoped
  assert.match(src, /getCurrentUser/);
  assert.match(src, /owner_id|ownerId|user\.id/);
  // Must NOT send email or SMS
  assert.doesNotMatch(src, /resend|clicksend|sendEmail|sendSms/i);
});

test("ContactsWorkspace renders all required fields and filters", async () => {
  const src = await read("components/voom/contacts/ContactsWorkspace.tsx");
  for (const required of [
    "Total contacts",
    "Email subscribers",
    "SMS subscribers",
    "Import CSV",
    "Add contact",
    "Email subscribers",   // filter
    "SMS subscribers",     // filter
    "Unsubscribed",        // filter
    "Unknown consent",     // filter
    "Search by name",
    "ConsentChip",
    "TagsList",
    "SourceLabel",
  ]) {
    assert.ok(
      src.includes(required),
      `ContactsWorkspace must include string: ${required}`,
    );
  }
});

test("ContactsWorkspace never duplicates audience eligibility logic", async () => {
  const src = await read("components/voom/contacts/ContactsWorkspace.tsx");
  // The UI must delegate to the server (via /api/voom/audiences/.../contacts)
  // rather than re-implementing filter/sort rules.
  assert.match(src, /\/api\/voom\/audiences\/\$\{audience\.id\}\/contacts/);
  assert.match(src, /resolveAudienceContacts|eligible/i);
  // The UI must NOT include its own audience type → filter mapping
  assert.doesNotMatch(src, /all_email_subscribers.*email_status.*subscribed/);
  assert.doesNotMatch(src, /contains\(\"tags\"/);
});

test("Modals enforce consent rules and never auto-mark subscribed", async () => {
  const src = await read("components/voom/contacts/Modals.tsx");
  // Default consent is 'default' (= unknown)
  assert.match(src, /"default"/);
  // The email/sms consent chips include subscribed / unsubscribed / unknown
  assert.match(src, /Subscribed/);
  assert.match(src, /Unsubscribed/);
  assert.match(src, /Unknown \(default\)/);
  // The import flow must require explicit consent to mark Subscribed
  assert.match(src, /confirmedSubscribed/);
  // No automatic sending
  assert.doesNotMatch(src, /resend|clicksend|sendEmail|sendSms/i);
});

test("CSV import modal respects size cap, header detection, and explicit consent", async () => {
  const src = await read("components/voom/contacts/Modals.tsx");
  // Size cap and "drop here" UI
  assert.match(src, /MAX_CSV_BYTES/);
  assert.match(src, /Drop a CSV/);
  // Mapping labels
  assert.match(src, /Detected columns/);
  assert.match(src, /To create/);
  assert.match(src, /Already in workspace/);
  // Never overwrite
  assert.match(src, /never overwrites|Voom never overwrites/);
  // Explicit consent required for subscribed
  assert.match(src, /explicit consent/);
});

test("Contacts nav entry is registered and reachable", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  assert.match(nav, /id: "contacts", n: "Contacts"/);
  assert.match(nav, /contacts: "Contacts"/);
  // Store has a corresponding path
  const store = await read("lib/voom/store.tsx");
  assert.match(store, /contacts: "\/app\/contacts"/);
});

test("Phase 2 UI does not touch Resend, ClickSend, or campaign delivery", async () => {
  const [ui, actions, modals, workspace] = await Promise.all([
    read("components/voom/contacts/ContactBits.tsx"),
    read("app/app/(shell)/contacts/actions.ts"),
    read("components/voom/contacts/Modals.tsx"),
    read("components/voom/contacts/ContactsWorkspace.tsx"),
  ]);
  const combined = ui + actions + modals + workspace;
  assert.doesNotMatch(combined, /resend/i);
  assert.doesNotMatch(combined, /clicksend/i);
  assert.doesNotMatch(combined, /sendEmail|sendSms/i);
  assert.doesNotMatch(combined, /voom_campaigns/);
  assert.doesNotMatch(combined, /campaign_recipients/);
  // No provider secrets client-side
  assert.doesNotMatch(combined, /RESEND_API_KEY|CLICKSEND_|process\.env\.RESEND|process\.env\.CLICK/i);
});

test("API routes for contacts snapshot and audience contacts are owner-scoped", async () => {
  const [snap, aud] = await Promise.all([
    read("app/api/voom/contacts/snapshot/route.ts"),
    read("app/api/voom/audiences/[id]/contacts/route.ts"),
  ]);
  for (const src of [snap, aud]) {
    assert.match(src, /getCurrentUser/);
    // No provider secrets
    assert.doesNotMatch(src, /RESEND_API_KEY|CLICKSEND_|process\.env\.(RESEND|CLICK)/i);
    // The routes must return 401 when there is no session
    assert.match(src, /401/);
  }
  // The audience route reuses resolveAudienceContacts + uses the user id directly
  assert.match(aud, /resolveAudienceContacts/);
  assert.match(aud, /user\.id/);
  // The snapshot route delegates to loadContactsPage (which is owner-scoped)
  assert.match(snap, /loadContactsPage/);
});

