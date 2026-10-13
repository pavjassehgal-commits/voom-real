import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CANDIDATE_ROLLBACK_SQL,
  MARA_CONTEXT_ROLLBACK_SQL,
  MARA_CONTEXT_SQL,
  createTrendDb,
} from "./helpers/trend-db.mjs";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const OBSERVATION = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-12T12:00:00.000Z";
const STAGING_VERIFY_SQL = readFileSync(new URL("../docs/trend-intelligence/staging/07-verify-mara-context.sql", import.meta.url), "utf8");

async function asRole(db, role, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    return tx.query(sql, params);
  });
}

const insertContext = (owner, status = "approved", validUntil = "2026-10-20T00:00:00.000Z") => ({
  owner,
  status,
  validUntil,
  reviewedBy: status === "approved" ? "owner:staging-test" : null,
  reviewedAt: status === "approved" ? NOW : null,
});

async function seedContext(db, fixture) {
  await db.query(`
    insert into public.trend_mara_contexts
      (owner_user_id, trend_key, platform, market_country, market_language,
       topic, facts, observed_at, confidence, caveats, observation_ids,
       status, reviewed_by, reviewed_at, valid_until)
    values ($1, 'dubai-fitness-challenge', 'web', 'AE', 'en',
      'Dubai Fitness Challenge',
      '[{"statement":"Dubai Fitness Challenge is scheduled in Dubai.","sources":["Official event source"]}]'::jsonb,
      '2026-10-01T00:00:00Z', 'low', '["Do not imply a partnership."]'::jsonb,
      array[$2::uuid], $3, $4, $5, $6)
  `, [fixture.owner, OBSERVATION, fixture.status, fixture.reviewedBy, fixture.reviewedAt, fixture.validUntil]);
}

test("0056 revokes Supabase defaults and grants service_role SELECT only", async () => {
  const { db } = await createTrendDb();
  try {
    await db.exec(MARA_CONTEXT_SQL);
    const table = (await db.query(`
      select relrowsecurity as rls,
        (select count(*) from pg_policies where schemaname = 'public' and tablename = 'trend_mara_contexts')::int as policies
      from pg_class where oid = 'public.trend_mara_contexts'::regclass
    `)).rows[0];
    assert.deepEqual(table, { rls: true, policies: 0 });

    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(asRole(db, role, "select * from public.trend_mara_contexts"), /permission denied/);
    }
    const grants = (await db.query(`
      select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'trend_mara_contexts'
         and grantee = 'service_role' order by privilege_type
    `)).rows.map((row) => row.privilege_type);
    assert.deepEqual(grants, ["SELECT"]);

    await db.query("insert into auth.users (id, email) values ($1, 'owner-a@example.invalid')", [OWNER_A]);
    await seedContext(db, insertContext(OWNER_A));
    assert.equal((await asRole(db, "service_role", "select count(*)::int as n from public.trend_mara_contexts")).rows[0].n, 1);
    for (const statement of [
      "insert into public.trend_mara_contexts (owner_user_id) values ('11111111-1111-4111-8111-111111111111')",
      "update public.trend_mara_contexts set status = 'revoked'",
      "delete from public.trend_mara_contexts",
    ]) await assert.rejects(asRole(db, "service_role", statement), /permission denied/);
  } finally {
    await db.close();
  }
});

test("the staging 0056 verification script passes against Supabase defaults and Admin 0052-0054 objects", async () => {
  const { db } = await createTrendDb();
  try {
    for (const name of ["admin_memberships", "admin_audit_events", "admin_invitations", "admin_audit_denial_counters"]) {
      await db.exec(`create table public.${name} (id integer primary key)`);
    }
    await db.exec(MARA_CONTEXT_SQL);
    const result = await db.query(STAGING_VERIFY_SQL);
    assert.ok(result.rows.length >= 10);
    assert.ok(result.rows.every((row) => row.ok === true), JSON.stringify(result.rows));
  } finally {
    await db.close();
  }
});

test("owner-scoped application selection excludes other owners, non-approved states, and expired contexts", async () => {
  const { db } = await createTrendDb();
  try {
    await db.exec(MARA_CONTEXT_SQL);
    await db.query("insert into auth.users (id, email) values ($1, 'owner-a@example.invalid'), ($2, 'owner-b@example.invalid')", [OWNER_A, OWNER_B]);
    await seedContext(db, insertContext(OWNER_A));
    await seedContext(db, insertContext(OWNER_B));
    await seedContext(db, insertContext(OWNER_A, "pending_review"));
    await seedContext(db, insertContext(OWNER_A, "rejected"));
    await seedContext(db, insertContext(OWNER_A, "revoked"));
    await seedContext(db, insertContext(OWNER_A, "approved", "2026-10-11T00:00:00.000Z"));

    const selected = await asRole(db, "service_role", `
      select owner_user_id::text as owner from public.trend_mara_contexts
       where owner_user_id = $1 and status = 'approved' and valid_until > $2
    `, [OWNER_A, NOW]);
    assert.deepEqual(selected.rows, [{ owner: OWNER_A }]);
  } finally {
    await db.close();
  }
});

test("0056 rollback removes only its table and permits the 0055 rollback next", async () => {
  const { db } = await createTrendDb();
  try {
    await db.exec("create table public.admin_rollback_sentinel (id integer primary key)");
    await db.exec(MARA_CONTEXT_SQL);
    await db.exec(MARA_CONTEXT_ROLLBACK_SQL);
    assert.equal((await db.query("select to_regclass('public.trend_mara_contexts') as value")).rows[0].value, null);
    assert.equal((await db.query("select to_regclass('public.trend_observations') is not null as value")).rows[0].value, true);
    assert.equal((await db.query("select to_regclass('public.admin_rollback_sentinel') is not null as value")).rows[0].value, true);
    await db.exec(CANDIDATE_ROLLBACK_SQL);
    assert.equal((await db.query("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'trend\\_%'")).rows[0].n, 0);
    assert.equal((await db.query("select to_regclass('public.admin_rollback_sentinel') is not null as value")).rows[0].value, true);
  } finally {
    await db.close();
  }
});

test("runtime loader fails closed for cross-owner, pending, expired, and revoked evidence", async () => {
  const { loadOwnerTrendPromptContext } = await import("../lib/trends/workflow-context.ts");
  const row = {
    owner_user_id: OWNER_A,
    topic: "Dubai Fitness Challenge",
    platform: "web",
    market_country: "AE",
    market_language: "en",
    event_start: "2026-10-31",
    event_end: "2026-11-29",
    facts: [{ statement: "Dubai Fitness Challenge is scheduled in Dubai.", sources: ["Official event source"] }],
    observed_at: "2026-10-01T00:00:00.000Z",
    confidence: "low",
    caveats: ["Do not imply a partnership."],
    observation_ids: [OBSERVATION],
    status: "approved",
    valid_until: "2026-10-20T00:00:00.000Z",
  };
  const client = (stored, observations) => {
    const filters = [];
    const query = {
      eq(column, value) { filters.push(["eq", column, value]); return this; },
      gt(column, value) { filters.push(["gt", column, value]); return this; },
      order() { return this; }, limit() { return this; },
      maybeSingle() {
        const match = stored && filters.every(([op, column, value]) => op === "eq" ? stored[column] === value : stored[column] > value);
        return Promise.resolve({ data: match ? stored : null, error: null });
      },
    };
    return {
      from(table) { assert.equal(table, "trend_mara_contexts"); return { select() { return query; } }; },
      async rpc(name) {
        assert.equal(name, "trend_list_usable_observations");
        return { data: { status: "ok", observations, next_cursor: null, permitted_source_ids: ["manual_research"] }, error: null };
      },
    };
  };
  const usable = [{ storage_id: OBSERVATION, source_id: "manual_research", platform: "web", country: "AE", language: "en", subject_kind: "topic", subject_text: row.topic, subject_normalized: "dubai fitness challenge", provider_item_id: null, trend_key: "key", topic_key: "topic", item_key: "item", window_start: "2026-10-01T00:00:00Z", window_end: "2026-10-01T00:00:00Z", retrieved_at: "2026-10-01T00:00:00Z", fresh_until: "2026-10-15T00:00:00Z", stale_after: "2026-10-18T00:00:00Z", expires_at: "2026-10-20T00:00:00Z", delete_after: "2026-10-21T00:00:00Z", freshness_basis: "source_policy", revision: 1, metrics: {}, evidence: [{ source_id: "manual_research", url: "https://example.invalid/evidence", attribution: "Official event source", retrieved_at: "2026-10-01T00:00:00Z" }] }];

  assert.ok(await loadOwnerTrendPromptContext(client(row, usable), OWNER_A, NOW));
  assert.equal(await loadOwnerTrendPromptContext(client(row, usable), OWNER_B, NOW), null, "cross-owner context is excluded");
  assert.equal(await loadOwnerTrendPromptContext(client({ ...row, status: "pending_review" }, usable), OWNER_A, NOW), null);
  assert.equal(await loadOwnerTrendPromptContext(client({ ...row, valid_until: "2026-10-11T00:00:00.000Z" }, usable), OWNER_A, NOW), null);
  assert.equal(await loadOwnerTrendPromptContext(client(row, []), OWNER_A, NOW), null, "revoked or expired evidence disappears from the usable RPC");
});
