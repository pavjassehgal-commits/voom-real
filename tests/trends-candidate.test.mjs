/**
 * Trend Intelligence — Stage 2E: the integration candidate migration
 * (supabase/proposed/0055_trend_intelligence.sql), its rollback, and the
 * staging scripts under docs/trend-intelligence/staging/.
 *
 * Local PGlite only. Proves: the candidate is exactly the reviewed
 * components; it is equivalent to applying them in sequence; it is
 * idempotent with data present; it changes no existing object; its rollback
 * restores the exact prior schema; and the staging scripts run cleanly
 * (preflight, verify, self-rolling-back synthetic tests, cleanup).
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";
import { assembleCandidate, CANDIDATE_NAME } from "./helpers/trend-candidate.mjs";
import {
  CANDIDATE_ROLLBACK_SQL,
  CANDIDATE_SQL,
  createTrendDb,
  GOVERNANCE_SQL,
  rpcClient,
  STORAGE_SQL,
  SUPABASE_DEFAULT_PRIVILEGES,
} from "./helpers/trend-db.mjs";

const STAGING = new URL("../docs/trend-intelligence/staging/", import.meta.url);
const staging = (name) => readFileSync(new URL(name, STAGING), "utf8");

/** Every schema fact that matters, for one name pattern (trend or non-trend). */
async function catalog(db, { trend }) {
  const like = trend ? "like" : "not like";
  const { rows } = await db.query(`
    select 'rel:' || c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text as k
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname ${like} 'trend\\_%'
    union all select 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') || ':' || coalesce(generation_expression, '')
      from information_schema.columns where table_schema = 'public' and table_name ${like} 'trend\\_%'
    union all select 'con:' || conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text ${like} 'trend\\_%'
    union all select 'idx:' || indexrelid::regclass::text || ':' || pg_get_indexdef(indexrelid)
      from pg_index where indrelid::regclass::text ${like} 'trend\\_%' and indrelid::regclass::text not like 'pg\\_%' and indrelid::regclass::text not like 'information\\_schema%'
    union all select 'pol:' || tablename || '.' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
      from pg_policies where schemaname = 'public' and tablename ${like} 'trend\\_%'
    union all select 'fn:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') || ':' || p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ';'), '')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname ${like} 'trend\\_%'
    union all select 'trg:' || tgrelid::regclass::text || '.' || tgname || ':' || pg_get_triggerdef(oid)
      from pg_trigger where not tgisinternal and tgrelid::regclass::text ${like} '%trend\\_%'
    ${trend
      ? `union all select 'row:trend_sources:' || to_jsonb(s)::text from public.trend_sources s
         union all select 'row:trend_metric_definitions:' || to_jsonb(d)::text from public.trend_metric_definitions d`
      : `union all select 'defacl:' || defaclrole::regrole::text || ':' || defaclobjtype::text || ':' || defaclacl::text from pg_default_acl`}
    order by 1`);
  return rows.map((r) => r.k);
}

async function baseDb() {
  const { db } = await createSupabaseLite({ stopBefore: "0055" });
  await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  return db;
}

/* ──────────────────────────────────────────────────────────────
   The candidate file
   ────────────────────────────────────────────────────────────── */

test("the candidate is exactly the reviewed components, in one transaction", () => {
  assert.equal(CANDIDATE_SQL, assembleCandidate(), "regenerate with: node tests/helpers/trend-candidate.mjs --write");
  const lines = CANDIDATE_SQL.split("\n");
  assert.deepEqual([lines.filter((l) => l === "begin;").length, lines.filter((l) => l === "commit;").length], [1, 1]);
  assert.doesNotMatch(CANDIDATE_SQL, /trend_storage_reapply_after_governance/, "component-only guard removed");
  // Released: supabase/migrations holds byte-identical copies of the reviewed files.
  for (const name of ["0055_trend_intelligence.sql", "0056_trend_mara_workflow_context.sql", "0057_wikidata_event_source.sql"]) {
    assert.equal(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"), readFileSync(new URL(`../supabase/proposed/${name}`, import.meta.url), "utf8"), name);
  }
  assert.equal(readdirSync(new URL("../supabase/migrations/", import.meta.url)).some((f) => f.includes("rollback")), false, "no rollback file is ever a migration");
  assert.equal(CANDIDATE_NAME, "0055_trend_intelligence.sql");
});

test("the candidate contains no schedule, network, extension or non-trend changes", () => {
  const code = (sql) => sql.replace(/--[^\n]*/g, "");
  for (const sql of [CANDIDATE_SQL, CANDIDATE_ROLLBACK_SQL].map(code)) {
    assert.doesNotMatch(sql, /cron\.|pg_cron|pg_net|net\.http|http_(get|post)|vault\.|create extension|alter default privileges|alter role|grant\s+\w+\s+to\s+(anon|authenticated|service_role)\s*;/i);
    assert.doesNotMatch(sql, /\b(admin_|mara_|businesses|profiles|auth\.users)\w*/, "references only trend_ objects");
    // Every object it names in public is a trend_ object.
    for (const [, name] of sql.matchAll(/public\.([a-z_][a-z0-9_]*)/g)) assert.match(name, /^trend_/, name);
  }
});

test("the staging plan records the candidate's current hash", () => {
  const sha = createHash("sha256").update(CANDIDATE_SQL).digest("hex");
  const plan = readFileSync(new URL("../docs/trend-intelligence/STAGE-2E-STAGING.md", import.meta.url), "utf8");
  assert.ok(plan.includes(sha), `STAGE-2E-STAGING.md must quote sha256 ${sha}`);
  const rollbackSha = createHash("sha256").update(CANDIDATE_ROLLBACK_SQL).digest("hex");
  assert.ok(plan.includes(rollbackSha), `STAGE-2E-STAGING.md must quote rollback sha256 ${rollbackSha}`);
});

/* ──────────────────────────────────────────────────────────────
   Applying it
   ────────────────────────────────────────────────────────────── */

test("applying the candidate equals applying the two components in sequence", async () => {
  const single = await baseDb();
  await single.exec(CANDIDATE_SQL);
  const pair = await baseDb();
  await pair.exec(STORAGE_SQL);
  await pair.exec(GOVERNANCE_SQL);
  assert.deepEqual(await catalog(single, { trend: true }), await catalog(pair, { trend: true }));
});

test("the candidate changes no existing object, and its rollback restores the exact prior schema", async () => {
  const db = await baseDb();
  const before = await catalog(db, { trend: false });
  await db.exec(CANDIDATE_SQL);
  assert.deepEqual(await catalog(db, { trend: false }), before, "non-trend schema unchanged by apply");
  await db.exec(CANDIDATE_ROLLBACK_SQL);
  assert.deepEqual(await catalog(db, { trend: false }), before, "non-trend schema unchanged by rollback");
  const { rows } = await db.query(
    `select (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'trend\\_%')
          + (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'trend\\_%') as n`,
  );
  assert.equal(rows[0].n, 0);
  await db.exec(CANDIDATE_SQL);
  assert.equal((await db.query("select count(*)::int as n from public.trend_sources")).rows[0].n, 4, "re-applies after rollback");
});

test("re-applying the candidate with data present is harmless", async () => {
  const { db } = await createTrendDb();
  await db.exec(`
    insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('youtube_data_api', 'approved', now() - interval '1 minute', 'owner:test', 'REF');
    insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values ('youtube_data_api', 'youtube', 'AE', 'verified', now() - interval '1 minute', 'x', 'owner:test');`);
  const t = new Date(Date.now() - 3_600_000).toISOString();
  const { data } = await rpcClient(db).rpc("trend_store_observation", { p_observation: {
    source_id: "youtube_data_api", platform: "youtube", country: "AE", language: "und", subject_kind: "video", subject_text: "Reapply",
    subject_normalized: "reapply", provider_item_id: "reapply0001", window_start: t, window_end: t, retrieved_at: t,
    metrics: {
      chart_rank: { status: "measured", value: "1", definition_version: "youtube_data_api.chart_rank.v1" },
      view_count: { status: "measured", value: "7", definition_version: "youtube_data_api.view_count.v2" },
      like_count: { status: "unavailable", unavailable_reason: "not_collected" },
      comment_count: { status: "unavailable", unavailable_reason: "not_collected" },
    },
    evidence: [{ source_id: "youtube_data_api", url: null, attribution: "YouTube", retrieved_at: t }],
  }, p_replaces: null });
  assert.equal(data.status, "stored");
  const snapshot = async () => (await db.query(
    `select (select count(*) from public.trend_observations) || '/' || (select count(*) from public.trend_observation_metrics) || '/' ||
            (select count(*) from public.trend_evidence) || '/' || (select count(*) from public.trend_audit_events) || '/' ||
            (select count(*) from public.trend_source_authorizations) as k`)).rows[0].k;
  const before = [await snapshot(), await catalog(db, { trend: true })];
  await db.exec(CANDIDATE_SQL);
  assert.deepEqual([await snapshot(), await catalog(db, { trend: true })], before);
  assert.equal((await db.query("select has_table_privilege('service_role', 'public.trend_observations', 'INSERT') as ok")).rows[0].ok, false);
});

/* ──────────────────────────────────────────────────────────────
   The staging scripts
   ────────────────────────────────────────────────────────────── */

const MULTI_DB_ONLY = new Set([
  "admin migrations 0052-0054 present (staging only)",
  "admin tables untouched (still 4)",
  "running as the schema owner role",
  "current user can act as each API role (for the role tests)",
]);

async function runChecks(db, sql) {
  const results = await db.exec(sql);
  const rows = results.at(-1).rows;
  assert.ok(rows.length > 5);
  for (const row of rows) {
    if (MULTI_DB_ONLY.has(row.check_name)) continue; // need the Supabase/staging environment
    assert.equal(row.ok, true, `${row.check_name}: got ${row.value}, expected ${row.expected}`);
  }
  return rows;
}

test("staging preflight and verify scripts pass locally", async () => {
  const db = await baseDb();
  await runChecks(db, staging("01-preflight.sql"));
  await db.exec(CANDIDATE_SQL);
  await runChecks(db, staging("03-verify.sql"));
  for (const name of ["01-preflight.sql", "03-verify.sql"]) {
    assert.doesNotMatch(staging(name), /\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b\s/i, `${name} is read-only`);
  }
});

test("the synthetic staging test suite passes and leaves no trace", async () => {
  const db = await baseDb();
  await db.exec(CANDIDATE_SQL);
  const before = await catalog(db, { trend: true });
  const counts = async () => (await db.query(
    `select (select count(*) from public.trend_observations) + (select count(*) from public.trend_audit_events)
          + (select count(*) from public.trend_source_authorizations) + (select count(*) from public.trend_source_coverage)
          + (select count(*) from public.trend_purge_runs) as n`)).rows[0].n;
  assert.equal(Number(await counts()), 0);
  const results = await db.exec(staging("04-synthetic-tests.sql"));
  const passed = results.find((r) => r.rows?.[0]?.result);
  assert.equal(passed.rows[0].result, "ALL TREND STAGING SYNTHETIC CHECKS PASSED");
  assert.equal(Number(await counts()), 0, "rolled back: no synthetic rows remain");
  assert.deepEqual(await catalog(db, { trend: true }), before, "schema unchanged (trigger re-enabled, nothing created)");
});

test("the synthetic suite stops on a broken guarantee", async () => {
  const db = await baseDb();
  await db.exec(CANDIDATE_SQL);
  // Simulate a privilege regression: anon can read observations.
  await db.exec("grant select on public.trend_observations to anon");
  await assert.rejects(db.exec(staging("04-synthetic-tests.sql")), /FAILED: anon can read trend_observations/);
  await db.exec("rollback");
});

test("cleanup removes committed synthetic data and refuses when real data exists", async () => {
  const db = await baseDb();
  await db.exec(CANDIDATE_SQL);
  await db.exec(staging("05-seed-decisions.sql"));
  const t = new Date(Date.now() - 3_600_000).toISOString();
  const { data } = await rpcClient(db).rpc("trend_store_observation", { p_observation: {
    source_id: "youtube_data_api", platform: "youtube", country: "AE", language: "und", subject_kind: "video",
    subject_text: "STAGING-TEST concurrency", subject_normalized: "staging-test concurrency", provider_item_id: "stgconc0001",
    window_start: t, window_end: t, retrieved_at: t,
    metrics: {
      chart_rank: { status: "measured", value: "1", definition_version: "youtube_data_api.chart_rank.v1" },
      view_count: { status: "measured", value: "18446744073709551615", definition_version: "youtube_data_api.view_count.v2" },
      like_count: { status: "unavailable", unavailable_reason: "not_collected" },
      comment_count: { status: "unavailable", unavailable_reason: "not_collected" },
    },
    evidence: [{ source_id: "youtube_data_api", url: null, attribution: "STAGING-TEST", retrieved_at: t }],
  }, p_replaces: null });
  assert.equal(data.status, "stored");

  // A non-synthetic decision blocks cleanup entirely.
  await db.query("insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values ('youtube_data_api', 'youtube', 'IN', 'verified', now(), 'real check', 'owner:real')");
  await assert.rejects(db.exec(staging("06-cleanup.sql")), /TREND CLEANUP REFUSED/);
  await db.exec("rollback");
  assert.equal((await db.query("select count(*)::int as n from public.trend_observations")).rows[0].n, 1, "nothing deleted");

  await db.exec("select set_config('trend.purge', 'on', false); delete from public.trend_source_coverage where country = 'IN'; select set_config('trend.purge', 'off', false);");
  const results = await db.exec(staging("06-cleanup.sql"));
  const summary = results.find((r) => r.rows?.[0] && "observations" in r.rows[0]).rows[0];
  assert.ok(Object.values(summary).every((n) => Number(n) === 0), JSON.stringify(summary));
  await db.exec(staging("03-verify.sql")); // the schema is intact and clean again
});

test("several store calls in one transaction each complete (constraint mode never leaks)", async () => {
  const { db } = await createTrendDb();
  await db.exec(`
    insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('youtube_data_api', 'approved', now() - interval '1 minute', 'owner:test', 'REF');
    insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values ('youtube_data_api', 'youtube', 'AE', 'verified', now() - interval '1 minute', 'x', 'owner:test');`);
  const t = new Date(Date.now() - 3_600_000).toISOString();
  const payload = (id) => JSON.stringify({
    source_id: "youtube_data_api", platform: "youtube", country: "AE", language: "und", subject_kind: "video", subject_text: id,
    subject_normalized: id, provider_item_id: id, window_start: t, window_end: t, retrieved_at: t,
    metrics: {
      chart_rank: { status: "measured", value: "1", definition_version: "youtube_data_api.chart_rank.v1" },
      view_count: { status: "measured", value: "7", definition_version: "youtube_data_api.view_count.v2" },
      like_count: { status: "unavailable", unavailable_reason: "not_collected" },
      comment_count: { status: "unavailable", unavailable_reason: "not_collected" },
    },
    evidence: [{ source_id: "youtube_data_api", url: null, attribution: "YouTube", retrieved_at: t }],
  });
  const statuses = await db.transaction(async (tx) => {
    await tx.query("set local role service_role");
    const out = [];
    for (const id of ["multitx0001", "multitx0002", "multitx0003"]) {
      out.push((await tx.query("select public.trend_store_observation($1::jsonb) as r", [payload(id)])).rows[0].r.status);
    }
    return out;
  });
  assert.deepEqual(statuses, ["stored", "stored", "stored"]);
  assert.equal((await db.query("select count(*)::int as n from public.trend_evidence")).rows[0].n, 3);
});
