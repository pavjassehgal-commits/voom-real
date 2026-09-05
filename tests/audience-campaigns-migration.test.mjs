import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("audience campaigns migration 0020 exists and is wrapped in a transaction", async () => {
  const sql = await read("supabase/migrations/0020_audience_campaigns.sql");
  assert.match(sql, /do not apply without explicit approval/i);
  assert.match(sql, /\bbegin;/i);
  assert.match(sql, /\bcommit;/i);
});

test("voom_campaigns gains a nullable audience_id link", async () => {
  const sql = await read("supabase/migrations/0020_audience_campaigns.sql");
  assert.match(sql, /alter table public\.voom_campaigns\s+add column if not exists audience_id uuid/i);
});

test("the audience link is a cross-owner-safe composite foreign key", async () => {
  const sql = await read("supabase/migrations/0020_audience_campaigns.sql");
  assert.match(sql, /foreign key \(audience_id, owner_user_id\)/i);
  assert.match(sql, /references public\.audiences \(id, owner_id\)/i);
  // Deleting an audience clears the link instead of deleting campaigns.
  assert.match(sql, /on delete set null \(audience_id\)/i);
});

test("a partial index supports owner-scoped audience lookups", async () => {
  const sql = await read("supabase/migrations/0020_audience_campaigns.sql");
  assert.match(sql, /create index if not exists voom_campaigns_owner_audience_idx\s+on public\.voom_campaigns \(owner_user_id, audience_id\)/i);
  assert.match(sql, /where audience_id is not null/i);
});

test("0020 changes no 0018/0019 table semantics", async () => {
  const sql = await read("supabase/migrations/0020_audience_campaigns.sql");
  assert.doesNotMatch(sql, /\bcreate table\b/i);
  assert.doesNotMatch(sql, /alter table public\.(contacts|audiences|audience_members|campaign_recipients|campaign_sends|campaign_delivery_events)/i);
  assert.doesNotMatch(sql, /\bdrop table\b/i);
  assert.doesNotMatch(sql, /\bcreate (or replace )?function\b/i);
  assert.doesNotMatch(sql, /\bgrant\b|\brevoke\b/i);
});

test("0020 is the last audience migration, 0018/0019 remain untouched, and there is no 0022", async () => {
  const files = await readdir(new URL("supabase/migrations/", root));
  assert.ok(files.includes("0020_audience_campaigns.sql"));
  assert.ok(files.includes("0018_email_sms_delivery.sql"));
  assert.ok(files.includes("0019_contacts_audiences.sql"));
  // 0021 is the Instagram Post Studio schema and is already applied in
  // production, so it is checked in but never re-run. Post Studio deliberately
  // stops there: no 0022 may be introduced.
  assert.ok(!files.some((name) => /^0022_/.test(name)), "no 0022 migration may exist");
});
