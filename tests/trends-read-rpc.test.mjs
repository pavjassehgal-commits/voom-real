/**
 * Trend Intelligence — Stage 2D: the production read RPC
 * (trend_list_usable_observations), its server-only adapter, governance
 * settings, and the two proposed SQL files applied together.
 *
 * Local PGlite with the real proposed SQL only. No network, provider,
 * credential, schedule or remote database.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";
import {
  createTrendDb,
  GOVERNANCE_ROLLBACK_SQL,
  GOVERNANCE_SQL,
  rpcClient,
  sqlPort,
  STORAGE_SQL,
  SUPABASE_DEFAULT_PRIVILEGES,
} from "./helpers/trend-db.mjs";

const { parseTrendObservation } = await import("../lib/trends/schema.ts");
const { storeTrendObservation } = await import("../lib/trends/storage.ts");
const { invalidateTrendObservation } = await import("../lib/trends/governance.ts");
const { listUsableTrendObservations, listUsableTrendObservationsRpc } = await import("../lib/trends/read-model.ts");
const { POLICY_REVIEW_PERIODS } = await import("../lib/trends/policy-store.ts");
const { TREND_GOVERNANCE_SETTINGS } = await import("../lib/trends/types.ts");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

let db;
async function setup() {
  if (!db) {
    ({ db } = await createTrendDb());
    await db.exec(`
      insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values
        ('youtube_data_api', 'approved', now() - interval '1 hour', 'owner:test', 'REF-1'),
        ('manual_research', 'approved', now() - interval '1 hour', 'owner:test', 'REF-1');
      insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values
        ('youtube_data_api', 'youtube', 'AE', 'verified', now() - interval '1 hour', 'fixture', 'owner:test'),
        ('youtube_data_api', 'youtube', 'IN', 'verified', now() - interval '1 hour', 'fixture', 'owner:test'),
        ('youtube_data_api', 'youtube', 'TR', 'verified', now() - interval '1 hour', 'fixture', 'owner:test'),
        ('manual_research', 'youtube', 'AE', 'verified', now() - interval '1 hour', 'fixture', 'owner:test'),
        ('manual_research', 'tiktok', 'AE', 'verified', now() - interval '1 hour', 'fixture', 'owner:test');
    `);
  }
  return db;
}
const rpc = (role = "service_role") => rpcClient(db, role);
const one = async (sql, params = []) => (await (await setup()).query(sql, params)).rows[0];

let seq = 0;
function youtube(videoId, { country = "AE", endAgo = HOUR, metrics } = {}) {
  seq += 1;
  const end = Date.now() - endAgo - seq * 1000;
  const result = parseTrendObservation({
    id: `yt-${seq}`, sourceId: "youtube_data_api", platform: "youtube", market: { country, language: "und" },
    subject: { kind: "video", text: `Video ${videoId}`, providerItemId: videoId },
    window: { start: iso(end), end: iso(end) }, retrievedAt: iso(end),
    metrics: metrics ?? { chart_rank: { status: "measured", value: 4 }, view_count: { status: "measured", value: 12_345 } },
    evidence: [{ sourceId: "youtube_data_api", url: `https://www.youtube.com/watch?v=${videoId}`, attribution: "YouTube", retrievedAt: iso(end) }],
  }, { now: Date.now() });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function store(obs) {
  await setup();
  const result = await storeTrendObservation(rpc(), obs, { now: Date.now() });
  assert.equal(result.status, "stored", JSON.stringify(result));
  return result;
}
const readRpc = async (query = {}, role = "service_role") => {
  await setup();
  return listUsableTrendObservationsRpc(rpc(role), { platform: "youtube", country: "AE", limit: 200, ...query });
};
const visibleIds = async (query) => (await readRpc(query)).observations.map((o) => o.storageId);

/** Owner-only fixture: a row whose timestamps the RPC would never accept. */
async function seedRaw({ videoId, retrievedAt, expiresAt, deleteAfter }) {
  await setup();
  return db.transaction(async (tx) => {
    await tx.query("alter table public.trend_observations disable trigger trend_observations_guard_insert");
    const [row] = (await tx.query(
      `insert into public.trend_observations (source_id, platform, country, language, subject_kind, subject_text, subject_normalized, provider_item_id,
         window_start, window_end, retrieved_at, fresh_until, stale_after, expires_at, freshness_basis, delete_after)
       values ('youtube_data_api', 'youtube', 'AE', 'und', 'video', $1, $1, $1, $2, $2, $2, $2, $2, $3, 'provisional_product_default', $4) returning id`,
      [videoId, retrievedAt, expiresAt, deleteAfter],
    )).rows;
    for (const [key, value, unit, version] of [["chart_rank", "1", "rank", "youtube_data_api.chart_rank.v1"], ["view_count", "1", "count", "youtube_data_api.view_count.v2"]]) {
      await tx.query("insert into public.trend_observation_metrics (observation_id, metric_key, status, value, unit, definition_version) values ($1, $2, 'measured', $3, $4, $5)",
        [row.id, key, value, unit, version]);
    }
    await tx.query("insert into public.trend_evidence (observation_id, source_id, attribution, url, retrieved_at) values ($1, 'youtube_data_api', 'YouTube', null, $2)", [row.id, iso(Math.min(Date.parse(retrievedAt), Date.now()))]);
    await tx.query("set constraints all immediate");
    await tx.query("alter table public.trend_observations enable trigger trend_observations_guard_insert");
    return row.id;
  });
}

/* ──────────────────────────────────────────────────────────────
   Governance settings
   ────────────────────────────────────────────────────────────── */

test("governance periods are defined once and identical in TypeScript and SQL", async () => {
  await setup();
  const row = await one(`select
    extract(epoch from public.trend_authorization_review_period()) / 86400 as auth,
    extract(epoch from public.trend_coverage_review_period()) / 86400 as coverage,
    extract(epoch from public.trend_audit_retention_period()) / 86400 as audit,
    extract(epoch from public.trend_purge_run_retention_period()) / 86400 as runs`);
  assert.deepEqual([Number(row.auth), Number(row.coverage), Number(row.audit), Number(row.runs)], [365, 180, 730, 90]);
  assert.deepEqual(TREND_GOVERNANCE_SETTINGS, {
    basis: "provisional_product_default", authorizationReviewDays: 365, coverageReviewDays: 180, auditRetentionDays: 730, purgeRunRetentionDays: 90,
  });
  assert.equal(POLICY_REVIEW_PERIODS.authorizationMs, 365 * DAY);
  assert.equal(POLICY_REVIEW_PERIODS.coverageMs, 180 * DAY);
  // No other copy of these numbers is left in the SQL functions.
  assert.doesNotMatch(GOVERNANCE_SQL.replace(/create or replace function public\.trend_\w+_period\(\)[\s\S]*?\$\$;/g, ""), /interval '(365|180|730|90) days'/);
  // Source content retention is unchanged: YouTube at most 30 days.
  assert.equal((await one("select max_retention_days from public.trend_sources where source_id = 'youtube_data_api'")).max_retention_days, 30);
});

/* ──────────────────────────────────────────────────────────────
   Both proposed files together
   ────────────────────────────────────────────────────────────── */

test("applying storage after governance is refused instead of regressing privileges", async () => {
  const { db: fresh } = await createSupabaseLite({ stopBefore: "0055" });
  await fresh.exec(SUPABASE_DEFAULT_PRIVILEGES);
  await fresh.exec(STORAGE_SQL);
  await fresh.exec(STORAGE_SQL); // idempotent on its own
  await fresh.exec(GOVERNANCE_SQL);
  await fresh.exec(GOVERNANCE_SQL); // idempotent on its own
  await assert.rejects(fresh.exec(STORAGE_SQL), /trend_storage_reapply_after_governance/);
  await fresh.exec("rollback");
  assert.equal((await fresh.query("select has_table_privilege('service_role', 'public.trend_observations', 'INSERT') as ok")).rows[0].ok, false, "still RPC-only");
  // The documented rollback path still works: governance rollback, then storage.
  await fresh.exec(GOVERNANCE_ROLLBACK_SQL);
  await fresh.exec(STORAGE_SQL);
  await fresh.exec(GOVERNANCE_SQL);
  assert.equal((await fresh.query("select count(*)::int as n from pg_proc where proname = 'trend_list_usable_observations'")).rows[0].n, 1);
});

test("privilege inventory: exactly the intended grants exist on trend objects", async () => {
  await setup();
  const tableGrants = (await db.query(
    `select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
       from information_schema.role_table_grants
      where table_schema = 'public' and table_name like 'trend\\_%' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
      group by grantee, table_name order by grantee, table_name`,
  )).rows;
  assert.ok(tableGrants.every((g) => g.grantee === "service_role" && g.privileges === "SELECT"), JSON.stringify(tableGrants));
  assert.equal(tableGrants.length, 10);
  const routineGrants = (await db.query(
    `select r.grantee, r.routine_name from information_schema.role_routine_grants r
      where r.routine_schema = 'public' and r.routine_name like 'trend\\_%' and r.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
      order by 1, 2`,
  )).rows.map((r) => `${r.grantee}:${r.routine_name}`);
  assert.deepEqual(routineGrants, [
    "service_role:trend_list_usable_observations",
    "service_role:trend_retention_status",
    "service_role:trend_run_retention_purge",
    "service_role:trend_store_observation",
  ]);
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal((await one("select has_sequence_privilege($1, 'public.trend_audit_events_seq_seq', 'USAGE') as ok", [role])).ok, false);
  }
});

/* ──────────────────────────────────────────────────────────────
   Read RPC: what it returns
   ────────────────────────────────────────────────────────────── */

test("the read RPC returns exactly what the Stage 2B read model returns", async () => {
  for (const id of ["parity00001", "parity00002", "parity00003"]) await store(youtube(id));
  const viaRpc = await readRpc();
  const viaSql = await listUsableTrendObservations(sqlPort(db), { platform: "youtube", country: "AE", now: Date.now(), limit: 200 });
  assert.equal(viaRpc.status, "ok");
  assert.deepEqual(viaRpc.permittedSourceIds, viaSql.permittedSourceIds);
  const byId = (list) => Object.fromEntries(list.map((o) => [o.storageId, o]));
  assert.deepEqual(byId(viaRpc.observations), byId(viaSql.observations));
  assert.ok(viaRpc.observations.length >= 3);
});

test("rows have a fixed, sanitized shape with exact values and attribution", async () => {
  const { observationId } = await store(youtube("shape000001", { metrics: {
    chart_rank: { status: "measured", value: 1 }, view_count: { status: "measured", value: 0 }, like_count: { status: "unavailable", reason: "hidden_by_owner" },
  } }));
  const { data } = await rpc().rpc("trend_list_usable_observations", { p_platform: "youtube", p_country: "AE", p_limit: 200 });
  assert.deepEqual(Object.keys(data).sort(), ["next_cursor", "observations", "permitted_source_ids", "status"]);
  const row = data.observations.find((o) => o.storage_id === observationId);
  assert.deepEqual(Object.keys(row).sort(), [
    "country", "delete_after", "evidence", "expires_at", "fresh_until", "freshness_basis", "item_key", "language", "metrics", "platform",
    "provider_item_id", "retrieved_at", "revision", "source_id", "stale_after", "storage_id", "subject_kind", "subject_normalized",
    "subject_text", "topic_key", "trend_key", "window_end", "window_start",
  ]);
  assert.deepEqual(row.metrics.view_count, { status: "measured", value: "0", unit: "count", definition_version: "youtube_data_api.view_count.v2", unavailable_reason: null });
  assert.deepEqual(row.metrics.like_count, { status: "unavailable", value: null, unit: "count", definition_version: null, unavailable_reason: "hidden_by_owner" });
  assert.deepEqual(Object.keys(row.evidence[0]).sort(), ["attribution", "retrieved_at", "source_id", "url"]);
  const adapted = (await readRpc()).observations.find((o) => o.storageId === observationId);
  assert.deepEqual(adapted.metrics.like_count, { status: "unavailable", reason: "hidden_by_owner", unit: "count" });
  assert.equal(adapted.metrics.view_count.value, 0);
  assert.equal(adapted.evidence[0].attribution, "YouTube");
});

test("large values keep full precision through the read RPC", async () => {
  const obs = youtube("precise0001");
  const { data } = await rpc().rpc("trend_store_observation", { p_observation: {
    source_id: obs.sourceId, platform: "youtube", country: "AE", language: "und", subject_kind: "video",
    subject_text: obs.subject.text, subject_normalized: obs.subject.normalized, provider_item_id: "precise0001",
    window_start: obs.window.start, window_end: obs.window.end, retrieved_at: obs.retrievedAt,
    metrics: {
      chart_rank: { status: "measured", value: "1", definition_version: "youtube_data_api.chart_rank.v1" },
      view_count: { status: "measured", value: "18446744073709551615", definition_version: "youtube_data_api.view_count.v2" },
      like_count: { status: "unavailable", unavailable_reason: "not_collected" },
      comment_count: { status: "unavailable", unavailable_reason: "not_collected" },
    },
    evidence: [{ source_id: "youtube_data_api", url: null, attribution: "YouTube", retrieved_at: obs.retrievedAt }],
  }, p_replaces: null });
  assert.equal(data.status, "stored");
  const found = (await readRpc()).observations.find((o) => o.storageId === data.observation_id);
  assert.equal(found.metrics.view_count.exactValue, "18446744073709551615");
});

/* ──────────────────────────────────────────────────────────────
   Read RPC: what it excludes
   ────────────────────────────────────────────────────────────── */

test("invalidated, expired, overdue and not-yet-retrieved observations are excluded", async () => {
  const live = await store(youtube("exclude0001"));
  const invalidated = await store(youtube("exclude0002"));
  await invalidateTrendObservation(rpcClient(db, "owner"), { observationId: invalidated.observationId, reason: "wrong_item", reference: "T-1" },
    { authorizeCorrection: async () => ({ ok: true, actorId: "staff:test" }) });
  const expired = await seedRaw({ videoId: "exclude0003", retrievedAt: iso(Date.now() - 8 * DAY), expiresAt: iso(Date.now() - DAY), deleteAfter: iso(Date.now() + DAY) });
  const overdue = await seedRaw({ videoId: "exclude0004", retrievedAt: iso(Date.now() - 2 * DAY), expiresAt: iso(Date.now() + DAY), deleteAfter: iso(Date.now() - HOUR) });
  const future = await seedRaw({ videoId: "exclude0005", retrievedAt: iso(Date.now() + HOUR), expiresAt: iso(Date.now() + 2 * DAY), deleteAfter: iso(Date.now() + 2 * DAY) });
  const ids = await visibleIds();
  assert.ok(ids.includes(live.observationId));
  for (const [name, id] of [["invalidated", invalidated.observationId], ["expired", expired], ["overdue", overdue], ["not yet retrieved", future]]) {
    assert.equal(ids.includes(id), false, name);
  }
});

test("revoked sources, expired approvals and unverified or expired coverage are excluded", async () => {
  const ae = await store(youtube("policy00001"));
  const tr = await store(youtube("policy00002", { country: "TR" }));
  const update = (sql) => db.query(sql);
  try {
    await update("update public.trend_source_authorizations set status = 'not_approved', decided_at = now() - interval '30 minutes', reference = 'REVOKE-1' where source_id = 'youtube_data_api'");
    const revoked = await readRpc();
    assert.deepEqual([revoked.status, revoked.observations.filter((o) => o.sourceId === "youtube_data_api").length], ["ok", 0]);
    assert.equal(revoked.permittedSourceIds.includes("youtube_data_api"), false);
    await update("update public.trend_source_authorizations set status = 'approved', decided_at = now() - interval '366 days', reference = 'OLD-1' where source_id = 'youtube_data_api'");
    assert.equal((await visibleIds()).includes(ae.observationId), false, "approval older than the review period");
  } finally {
    await update("update public.trend_source_authorizations set status = 'approved', decided_at = now() - interval '20 minutes', reference = 'REF-2' where source_id = 'youtube_data_api'");
  }
  assert.ok((await visibleIds()).includes(ae.observationId), "re-approval restores");
  try {
    await update("update public.trend_source_coverage set checked_at = now() - interval '181 days' where source_id = 'youtube_data_api' and country = 'TR'");
    assert.equal((await visibleIds({ country: "TR" })).includes(tr.observationId), false, "coverage older than the review period");
    await update("update public.trend_source_coverage set status = 'unverified', checked_at = null, evidence = null, checked_by = null where source_id = 'youtube_data_api' and country = 'TR'");
    assert.deepEqual((await readRpc({ country: "TR" })).observations, []);
  } finally {
    await update("update public.trend_source_coverage set status = 'verified', checked_at = now() - interval '10 minutes', evidence = 'recheck', checked_by = 'owner:test' where source_id = 'youtube_data_api' and country = 'TR'");
  }
  assert.ok((await visibleIds({ country: "TR" })).includes(tr.observationId));
});

test("countries and languages never mix", async () => {
  const ae = await store(youtube("market00001", { country: "AE" }));
  const inn = await store(youtube("market00001", { country: "IN" }));
  assert.equal((await visibleIds({ country: "IN" })).includes(ae.observationId), false);
  assert.equal((await visibleIds({ country: "AE" })).includes(inn.observationId), false);
  const end = Date.now() - HOUR;
  for (const language of ["en", "ar"]) {
    const parsed = parseTrendObservation({
      id: `snd-${language}`, sourceId: "manual_research", platform: "tiktok", market: { country: "AE", language },
      subject: { kind: "sound", text: "Original sound", providerItemId: "7001" },
      window: { start: iso(end), end: iso(end) }, retrievedAt: iso(end),
      evidence: [{ sourceId: "manual_research", url: "https://www.tiktok.com/music/x-7001", attribution: "Reviewer", retrievedAt: iso(end) }],
    }, { now: Date.now() });
    await store(parsed.value);
  }
  const arabic = await readRpc({ platform: "tiktok", language: "ar" });
  assert.deepEqual(arabic.observations.map((o) => o.market.language), ["ar"]);
});

/* ──────────────────────────────────────────────────────────────
   Pagination, validation and access
   ────────────────────────────────────────────────────────────── */

test("keyset pagination is bounded, complete and never repeats a row", async () => {
  for (let i = 0; i < 7; i += 1) await store(youtube(`pagexxxxx0${i}`, { country: "IN" }));
  const all = (await readRpc({ country: "IN" })).observations.map((o) => o.storageId);
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await readRpc({ country: "IN", limit: 3, cursor });
    assert.equal(page.status, "ok");
    assert.ok(page.observations.length <= 3);
    seen.push(...page.observations.map((o) => o.storageId));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 20);
  assert.deepEqual(seen, all, "same rows, same order, no gaps or repeats");
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(pages, Math.ceil(all.length / 3));
});

test("queries are validated in the adapter and again in the database", async () => {
  await setup();
  for (const [query, reason] of [
    [{ limit: 0 }, "invalid_limit"], [{ limit: 201 }, "invalid_limit"], [{ country: "ae" }, "invalid_country"],
    [{ country: "AE' or '1'='1" }, "invalid_country"], [{ language: "english" }, "invalid_language"], [{ platform: "myspace" }, "invalid_platform"],
    [{ cursor: { windowEnd: "yesterday", id: "00000000-0000-4000-8000-000000000000" } }, "invalid_cursor"],
    [{ cursor: { windowEnd: iso(Date.now()), id: "x'; drop table public.trend_evidence; --" } }, "invalid_cursor"],
  ]) {
    assert.deepEqual(await readRpc(query), { status: "invalid_query", reason }, JSON.stringify(query));
  }
  const direct = async (args) => (await rpc().rpc("trend_list_usable_observations", { p_platform: "youtube", p_country: "AE", ...args })).data;
  assert.deepEqual(await direct({ p_limit: 5000 }), { status: "invalid_query", reason: "invalid_limit" });
  assert.deepEqual(await direct({ p_country: "AE' or '1'='1" }), { status: "invalid_query", reason: "invalid_country" });
  assert.deepEqual(await direct({ p_after_window_end: iso(Date.now()) }), { status: "invalid_query", reason: "invalid_cursor" }, "half a cursor");
  assert.ok((await one("select to_regclass('public.trend_evidence') is not null as ok")).ok);
});

test("browser roles cannot read, and the adapter fails closed on anything unexpected", async () => {
  await store(youtube("closed00001"));
  for (const role of ["anon", "authenticated"]) assert.deepEqual(await readRpc({}, role), { status: "unavailable", code: "storage_failed" });

  const real = (await rpc().rpc("trend_list_usable_observations", { p_platform: "youtube", p_country: "AE", p_limit: 5 })).data;
  const tamper = (mutate) => {
    const copy = structuredClone(real);
    mutate(copy);
    return { rpc: async () => ({ data: copy, error: null }) };
  };
  const cases = {
    "row from another country": (d) => { d.observations[0].country = "IN"; },
    "unavailable metric with a value": (d) => { const m = Object.values(d.observations[0].metrics).find((x) => x.status === "unavailable"); m.value = "0"; },
    "measured metric without a version": (d) => { d.observations[0].metrics.chart_rank.definition_version = null; },
    "non-decimal value": (d) => { d.observations[0].metrics.chart_rank.value = "1e3"; },
    "insecure evidence link": (d) => { d.observations[0].evidence[0].url = "http://example.com"; },
    "source not permitted": (d) => { d.permitted_source_ids = ["manual_research"]; },
    "too many rows": (d) => { d.observations = Array(6).fill(d.observations[0]); },
    "missing evidence": (d) => { d.observations[0].evidence = []; },
    "bad cursor": (d) => { d.next_cursor = { window_end: "x", id: "y" }; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    assert.deepEqual(await listUsableTrendObservationsRpc(tamper(mutate), { platform: "youtube", country: "AE", limit: 5 }),
      { status: "unavailable", code: "storage_failed" }, name);
  }
  const down = { rpc: () => Promise.reject(new Error("connection refused: secret-host:5432")) };
  assert.deepEqual(await listUsableTrendObservationsRpc(down, { platform: "youtube", country: "AE" }), { status: "unavailable", code: "storage_failed" });
});
