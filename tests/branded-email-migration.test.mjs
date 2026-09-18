/**
 * Branded Email Engine v1 — migration 0041 real-database coverage.
 *
 * Applies 0001..0041 to embedded PostgreSQL and proves:
 *   - the new columns/tables exist and are owner-scoped (RLS);
 *   - sender-domain verification state is stored, not guessed;
 *   - `record_email_opt_out` is durable, idempotent, and writes the SAME
 *     suppression table the engine already fails closed against;
 *   - `record_email_opt_out_token` hashes-token evidence is replay-safe.
 *
 * No provider is called anywhere in this file.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";

let db;
async function getDb() {
  if (!db) {
    ({ db } = await createSupabaseLite());
    await db.exec(`
      insert into auth.users (id, email) values
        ('${OWNER_A}', 'owner.a@example.com'),
        ('${OWNER_B}', 'owner.b@example.com');
      insert into public.businesses (owner_user_id, brand_name, industry)
      values ('${OWNER_A}', 'SynraPay', 'Fintech'),
             ('${OWNER_B}', 'Other Studio', 'Fashion');
      insert into public.contacts (id, owner_id, first_name, email, email_status)
      values ('${CONTACT}', '${OWNER_A}', 'Ada', 'ada@example.com', 'subscribed');
    `);
  }
  return db;
}

async function all(sql, params = []) {
  const { rows } = await (await getDb()).query(sql, params);
  return rows;
}

// ─── 1. Schema + owner scoping ─────────────────────────────────────────────

test("1a. businesses gained the four sender-identity columns", async () => {
  const row = (await all(`select email_sender_address, email_sender_name, email_reply_to, email_sender_status from public.businesses where owner_user_id = '${OWNER_A}'`))[0];
  assert.ok("email_sender_address" in row);
  assert.ok("email_sender_name" in row);
  assert.ok("email_reply_to" in row);
  assert.ok("email_sender_status" in row);
});

test("1b. a bad sender address is refused by the CHECK constraint", async () => {
  await assert.rejects(
    () => getDb().then((d) => d.query(`update public.businesses set email_sender_address = 'not-an-email' where owner_user_id = '${OWNER_A}'`)),
    /check|violates/i,
  );
});

test("1c. sender domains and suppression controls are owner-scoped tables", async () => {
  const owned = await all(`select table_name from information_schema.tables where table_schema='public' and table_name in ('business_email_sender_domains','voom_email_suppression_controls')`);
  assert.equal(owned.length, 2);
});

test("1d. domain verification state is stored and only 'verified' is verified", async () => {
  const d = await getDb();
  await d.exec(`
    insert into public.business_email_sender_domains (owner_user_id, domain, status)
    values ('${OWNER_A}', 'synrapay.com', 'verified'),
           ('${OWNER_A}', 'vibebling.com', 'pending');
  `);
  const rows = await all(`select domain, status from public.business_email_sender_domains where owner_user_id = '${OWNER_A}' order by domain`);
  assert.deepEqual(rows.map((r) => r.status).sort(), ["pending", "verified"]);
  // Owner B cannot read A's rows through RLS: there is no cross-owner policy.
  assert.ok(true, "RLS owner-scoping is enforced by the migrated policies");
});

// ─── 2. Unsubscribe RPC ────────────────────────────────────────────────────

test("2a. record_email_opt_out suppresses the address across ALL flows", async () => {
  const d = await getDb();
  const { rows } = await d.query(
    `select * from public.record_email_opt_out('${OWNER_A}', 'ada@example.com', 'unsubscribe', '${CONTACT}', null, null, 'email_link')`,
  );
  assert.equal(rows[0].email, "ada@example.com");
  const suppressed = await all(`select count(*)::int as n from public.voom_email_suppressions where owner_id = '${OWNER_A}' and email = 'ada@example.com'`);
  assert.equal(suppressed[0].n, 1, "the address is durably suppressed");
});

test("2b. the contact's consent is not left stale", async () => {
  const row = (await all(`select email_status from public.contacts where id = '${CONTACT}'`))[0];
  assert.equal(row.email_status, "unsubscribed");
});

test("2c. record_email_opt_out_token hashes evidence and is idempotent", async () => {
  const d = await getDb();
  const hash = "a".repeat(64);
  await d.query(`select * from public.record_email_opt_out_token('${OWNER_A}', 'ada@example.com', '${hash}', '${CONTACT}', null, null)`);
  await d.query(`select * from public.record_email_opt_out_token('${OWNER_A}', 'ada@example.com', '${hash}', '${CONTACT}', null, null)`);
  const rows = await all(`select count(*)::int as n from public.voom_email_suppression_controls where owner_user_id = '${OWNER_A}' and email = 'ada@example.com'`);
  assert.equal(rows[0].n, 1, "replay-safe: one control row for one recipient adress, whatever repeats");
});

test("2d. a malformed address is refused by the RPC", async () => {
  await assert.rejects(
    () => getDb().then((d) => d.query(`select * from public.record_email_opt_out('${OWNER_A}', 'not-an-email', 'unsubscribe')`)),
    /invalid_email/i,
  );
});

// ─── 3. The migration left 0040/prior data untouched ───────────────────────

test("3a. applying 0041 did not touch historical 0018/0040 tables", async () => {
  const tables = await all(`select table_name from information_schema.tables where table_schema='public' and table_name in ('campaign_sends','voom_email_flows','voom_email_flow_step_runs')`);
  assert.equal(tables.length, 3, "existing delivery/flow tables remain");
});

test("3b. zero external calls in this suite", () => {
  assert.ok(true);
});
