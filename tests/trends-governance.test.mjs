/**
 * Trend Intelligence — Stage 2C governance: RPC access, permission
 * escalation, corrections (invalidation + replacement), source permission
 * history, retention and purge, metric precision, migration correctness.
 *
 * Real proposed SQL (storage + governance) in local PGlite only. No
 * network, provider, credential, schedule or remote database.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTrendDb,
  GOVERNANCE_ROLLBACK_SQL,
  GOVERNANCE_SQL,
  rpcClient,
  sqlPort,
  STORAGE_ROLLBACK_SQL,
  STORAGE_SQL,
} from "./helpers/trend-db.mjs";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const { parseTrendObservation } = await import("../lib/trends/schema.ts");
const { storeTrendObservation, exactDecimal } = await import("../lib/trends/storage.ts");
const { invalidateTrendObservation, correctTrendObservation, runTrendRetentionPurge, getTrendRetentionStatus } = await import("../lib/trends/governance.ts");
const { listUsableTrendObservations } = await import("../lib/trends/read-model.ts");
const { TREND_SOURCES } = await import("../lib/trends/types.ts");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

let db;
async function setup() {
  if (!db) {
    ({ db } = await createTrendDb());
    await db.exec(`
      insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values
        ('youtube_data_api', 'approved', now(), 'owner:test', 'REF-1'),
        ('google_trends_web', 'approved', now(), 'owner:test', 'REF-1');
      insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values
        ('youtube_data_api', 'youtube', 'AE', 'verified', now(), 'fixture', 'owner:test'),
        ('google_trends_web', 'google_search', 'AE', 'verified', now(), 'fixture', 'owner:test');
    `);
  }
  return db;
}
const rpc = (role = "service_role") => rpcClient(db, role);

// TEST-ONLY. Corrections are disabled in the product: no staff authority
// exists yet, the default authorizer denies, and no API role may execute the
// invalidation RPC. These tests exercise the mechanism as the database owner
// with a stand-in authorizer, so it is ready when real staff checks exist.
const STAFF = { authorizeCorrection: async () => ({ ok: true, actorId: "staff:test" }) };
const ownerRpc = () => rpcClient(db, "owner");
const invalidate = (observationId, reason, reference) => invalidateTrendObservation(ownerRpc(), { observationId, reason, reference }, STAFF);
const one = async (sql, params = []) => (await (await setup()).query(sql, params)).rows[0];
const all = async (sql, params = []) => (await (await setup()).query(sql, params)).rows;

let seq = 0;
function youtube(videoId, { endAgo = HOUR, title = "Eid outfit ideas", attribution = "YouTube", url } = {}) {
  seq += 1;
  const end = Date.now() - endAgo - seq;
  const result = parseTrendObservation({
    id: `yt-${seq}`, sourceId: "youtube_data_api", platform: "youtube", market: { country: "AE", language: "und" },
    subject: { kind: "video", text: title, providerItemId: videoId },
    window: { start: iso(end), end: iso(end) }, retrievedAt: iso(end),
    metrics: { chart_rank: { status: "measured", value: 2 }, view_count: { status: "measured", value: 900 } },
    evidence: [{ sourceId: "youtube_data_api", url: url ?? `https://www.youtube.com/watch?v=${videoId}`, attribution, retrievedAt: iso(end) }],
  }, { now: Date.now() });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

/** The exact RPC payload storage.ts sends, for raw RPC tests. */
function payload(obs, overrides = {}) {
  return {
    source_id: obs.sourceId, platform: obs.platform, country: obs.market.country, language: obs.market.language,
    subject_kind: obs.subject.kind, subject_text: obs.subject.text, subject_normalized: obs.subject.normalized,
    provider_item_id: obs.item?.providerItemId ?? null,
    window_start: obs.window.start, window_end: obs.window.end, retrieved_at: obs.retrievedAt,
    metrics: {
      chart_rank: { status: "measured", value: "2", definition_version: "youtube_data_api.chart_rank.v1" },
      view_count: { status: "measured", value: "900", definition_version: "youtube_data_api.view_count.v2" },
      like_count: { status: "unavailable", unavailable_reason: "not_collected" },
      comment_count: { status: "unavailable", unavailable_reason: "not_collected" },
    },
    evidence: obs.evidence.map((e) => ({ source_id: e.sourceId, url: e.url, attribution: e.attribution, retrieved_at: e.retrievedAt })),
    ...overrides,
  };
}
const storeRaw = async (body, replaces = null, role = "service_role") => {
  await setup();
  return rpc(role).rpc("trend_store_observation", { p_observation: body, p_replaces: replaces });
};
const store = async (obs, options = {}) => {
  await setup();
  return storeTrendObservation(rpc(), obs, { now: Date.now(), ...options });
};
const read = async () => listUsableTrendObservations(sqlPort(await setup()), { platform: "youtube", country: "AE", now: Date.now(), limit: 200 });

/** Executable by service_role (and nothing else). */
const RPCS = [
  "trend_store_observation(jsonb, uuid)",
  "trend_list_usable_observations(text, text, text, integer, timestamp with time zone, uuid)",
  "trend_run_retention_purge(integer)",
  "trend_retention_status()",
];
const TABLES = [
  "trend_sources", "trend_metric_definitions", "trend_source_authorizations", "trend_source_coverage",
  "trend_observations", "trend_observation_metrics", "trend_evidence",
  "trend_observation_invalidations", "trend_audit_events", "trend_purge_runs",
];

/* ──────────────────────────────────────────────────────────────
   Migration correctness
   ────────────────────────────────────────────────────────────── */

test("governance applies after storage, is idempotent, and every table has RLS with no policies", async () => {
  await setup();
  await db.exec(GOVERNANCE_SQL);
  const rows = await all(
    `select c.relname, c.relrowsecurity,
            (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'trend\\_%' order by 1`,
  );
  assert.deepEqual(rows.map((r) => r.relname), [...TABLES].sort());
  for (const row of rows) assert.deepEqual([row.relrowsecurity, row.policies], [true, 0], row.relname);
  const [{ cols }] = await all(
    "select array_length(conkey, 1) as cols from pg_constraint where conname = 'trend_observations_identity_key'",
  );
  assert.equal(cols, 5, "identity includes the revision");
});

test("database freshness parameters mirror the Stage 1 registry", async () => {
  const rows = await all(
    `select source_id, extract(epoch from fresh_for) * 1000 as fresh, extract(epoch from stale_after) * 1000 as stale,
            extract(epoch from expires_after) * 1000 as expires from public.trend_sources`,
  );
  for (const row of rows) {
    const f = TREND_SOURCES[row.source_id].freshness;
    assert.deepEqual([Number(row.fresh), Number(row.stale), Number(row.expires)], [f.freshForMs, f.staleAfterMs, f.expiresAfterMs], row.source_id);
  }
});

test("rollback: governance can be removed and re-applied; both files remove everything; corrections block rollback", async () => {
  const { db: fresh } = await createSupabaseLite({ stopBefore: "0055" });
  await fresh.exec(STORAGE_SQL);
  await fresh.exec(GOVERNANCE_SQL);
  await fresh.exec(GOVERNANCE_ROLLBACK_SQL);
  await fresh.exec(STORAGE_SQL); // restores the Stage 2A shape and grants exactly
  const [{ cols }] = (await fresh.query("select array_length(conkey, 1) as cols from pg_constraint where conname = 'trend_observations_identity_key'")).rows;
  assert.equal(cols, 4);
  assert.equal((await fresh.query("select has_table_privilege('service_role', 'public.trend_observations', 'INSERT') as ok")).rows[0].ok, true);
  await fresh.exec(GOVERNANCE_SQL);
  assert.equal((await fresh.query("select has_table_privilege('service_role', 'public.trend_observations', 'INSERT') as ok")).rows[0].ok, false);
  await fresh.exec(GOVERNANCE_ROLLBACK_SQL);
  await fresh.exec(STORAGE_ROLLBACK_SQL);
  const left = (await fresh.query(
    `select (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'trend\\_%')
          + (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'trend\\_%') as n`,
  )).rows[0].n;
  assert.equal(left, 0);

  // With a corrected revision stored, the governance rollback refuses to run.
  await setup();
  const input = youtube("rbrbrbrbr01");
  const original = await store(input);
  await invalidate(original.observationId, "wrong_evidence", "TICKET-1");
  const replacement = await store(input, { replaces: original.observationId });
  assert.equal(replacement.status, "stored");
  await assert.rejects(db.exec(GOVERNANCE_ROLLBACK_SQL), /trend_rollback_blocked_by_corrected_revisions/);
  await db.exec("rollback"); // the script's own transaction is left aborted
  assert.equal((await one("select array_length(conkey, 1) as cols from pg_constraint where conname = 'trend_observations_identity_key'")).cols, 5, "nothing was rolled back");
});

/* ──────────────────────────────────────────────────────────────
   RPC access and permission escalation
   ────────────────────────────────────────────────────────────── */

test("only service_role can execute the trend RPCs; internal functions are executable by no API role", async () => {
  await setup();
  for (const fn of RPCS) {
    for (const role of ["anon", "authenticated", "public"]) {
      const [{ ok }] = await all("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role === "public" ? "anon" : role, `public.${fn}`]);
      assert.equal(ok, false, `${role} ${fn}`);
    }
    assert.equal((await one("select has_function_privilege('service_role', $1, 'EXECUTE') as ok", [`public.${fn}`])).ok, true, fn);
  }
  const internal = await all(
    `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'trend\\_%' and p.oid::regprocedure::text <> all($1)`,
    [RPCS.map((fn) => fn.replace(/, /g, ","))],
  );
  assert.ok(internal.length >= 8);
  for (const { fn } of internal) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await one("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn])).ok, false, `${role} ${fn}`);
    }
  }
  for (const role of ["anon", "authenticated"]) {
    for (const fn of ["trend_store_observation", "trend_list_usable_observations", "trend_invalidate_observation", "trend_run_retention_purge", "trend_retention_status"]) {
      const args = {
        trend_store_observation: { p_observation: {} },
        trend_list_usable_observations: { p_platform: "youtube", p_country: "AE" },
        trend_invalidate_observation: { p_observation_id: "00000000-0000-4000-8000-000000000000", p_reason_code: "wrong_item", p_actor: "a", p_reference: "b" },
        trend_run_retention_purge: { p_limit: 1 },
        trend_retention_status: {},
      }[fn];
      const { data, error } = await rpc(role).rpc(fn, args);
      assert.equal(data, null);
      assert.match(error.message, /permission denied/, `${role} ${fn}`);
    }
  }
});

test("every SECURITY DEFINER function pins its search_path, and no SQL is built dynamically", async () => {
  const definers = await all(
    `select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'trend\\_%' and p.prosecdef`,
  );
  assert.ok(definers.length >= 6);
  for (const { proname, proconfig } of definers) {
    assert.ok((proconfig ?? []).some((c) => /^search_path=pg_catalog, (public, )?pg_temp$/.test(c)), `${proname}: ${proconfig}`);
  }
  for (const sql of [STORAGE_SQL, GOVERNANCE_SQL]) assert.doesNotMatch(sql, /\bexecute\s+(format|'|\$|\w+\s*\|\|)/i, "no dynamic SQL");
});

test("service_role writes only through the RPCs and cannot escalate", async () => {
  await setup();
  const grants = {};
  for (const table of TABLES) {
    grants[table] = [];
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      if ((await one("select has_table_privilege('service_role', $1, $2) as ok", [`public.${table}`, privilege])).ok) grants[table].push(privilege);
    }
  }
  assert.deepEqual(Object.values(grants).every((g) => g.length === 1 && g[0] === "SELECT"), true, JSON.stringify(grants));
  const service = sqlPort(db);
  const attempts = [
    "insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('google_trends_api', 'approved', now(), 'x', 'y')",
    "update public.trend_source_coverage set status = 'verified'",
    "insert into public.trend_observation_invalidations (observation_id, reason_code, actor, reference) select id, 'wrong_item', 'x', 'y' from public.trend_observations limit 1",
    "delete from public.trend_audit_events",
    "update public.trend_audit_events set actor = 'someone else'",
    "delete from public.trend_observations",
    "insert into public.trend_purge_runs (started_at, finished_at, status, batch_limit, remaining_overdue) values (now(), now(), 'succeeded', 1, 0)",
    "select public.trend_purge_expired(1000)",
  ];
  for (const sql of attempts) await assert.rejects(service.query(sql), /permission denied/, sql);
  // Setting the purge flag grants nothing without DELETE privileges.
  await assert.rejects(service.transaction(async (tx) => {
    await tx.query("select set_config('trend.purge', 'on', true)");
    return tx.query("delete from public.trend_observations");
  }), /permission denied/);
});

test("the owner cannot delete observations or audit records outside the purge either", async () => {
  await setup();
  const { observationId } = await store(youtube("owneronly01"));
  await assert.rejects(db.query("delete from public.trend_observations where id = $1", [observationId]), /trend_delete_only_by_purge/);
  await assert.rejects(db.query("delete from public.trend_audit_events"), /trend_delete_only_by_purge/);
  await assert.rejects(db.query("update public.trend_audit_events set actor = 'x'"), /trend_rows_are_immutable/);
});

test("the payload cannot choose deadlines, identity, revisions or extra columns", async () => {
  const obs = youtube("payloadxx01");
  for (const extra of ["delete_after", "expires_at", "fresh_until", "trend_key", "item_key", "revision", "replaces_observation_id", "stored_at", "id"]) {
    const { data } = await storeRaw(payload(obs, { [extra]: "2099-01-01T00:00:00Z" }));
    assert.deepEqual(data, { status: "rejected", code: "invalid_payload" }, extra);
  }
  for (const bad of [null, [], "x", { ...payload(obs), metrics: [] }, { ...payload(obs), evidence: {} }, { ...payload(obs), country: 7 }, { ...payload(obs), window_end: "yesterday" }]) {
    const { data } = await storeRaw(bad);
    assert.equal(data.status, "rejected", JSON.stringify(bad)?.slice(0, 60));
  }
  const { data } = await storeRaw(payload(obs, { metrics: { ...payload(obs).metrics, view_count: { status: "measured", value: 900, definition_version: "youtube_data_api.view_count.v2" } } }));
  assert.deepEqual(data, { status: "rejected", code: "invalid_metrics" }, "values travel as exact decimal strings");
  const extraMetric = await storeRaw(payload(obs, { metrics: { ...payload(obs).metrics, favorite_count: { status: "measured", value: "0", definition_version: "x" } } }));
  assert.deepEqual(extraMetric.data, { status: "rejected", code: "invalid_metrics" });
  const evidenceExtra = await storeRaw(payload(obs, { evidence: [{ ...payload(obs).evidence[0], provider_payload: "x" }] }));
  assert.deepEqual(evidenceExtra.data, { status: "rejected", code: "invalid_evidence" });
});

test("SQL injection attempts are inert data", async () => {
  await setup();
  const hostile = "x'); drop table public.trend_audit_events; --";
  const { data: unknown } = await storeRaw(payload(youtube("injection01"), { source_id: hostile }));
  assert.deepEqual(unknown, { status: "rejected", code: "unknown_source" });
  const obs = youtube("injection02", { title: hostile, attribution: "YouTube'; delete from public.trend_evidence; --" });
  const stored = await store(obs);
  assert.equal(stored.status, "stored");
  const [row] = await all("select subject_text from public.trend_observations where id = $1", [stored.observationId]);
  assert.equal(row.subject_text, hostile);
  assert.ok((await one("select to_regclass('public.trend_audit_events') is not null as ok")).ok);
  assert.ok((await one("select count(*)::int as n from public.trend_evidence")).n > 0);
});

/* ──────────────────────────────────────────────────────────────
   Evidence correction
   ────────────────────────────────────────────────────────────── */

test("invalidation records what, why, when and who, and hides the observation from reads", async () => {
  const obs = youtube("invalid0001");
  const stored = await store(obs);
  assert.ok((await read()).observations.some((o) => o.storageId === stored.observationId));
  const before = Date.now();
  const result = await invalidate(stored.observationId, "wrong_evidence", "TICKET-42");
  assert.equal(result.status, "invalidated");
  assert.ok(Date.parse(result.invalidatedAt) >= before - 5000);
  const [record] = await all("select reason_code, actor, reference from public.trend_observation_invalidations where observation_id = $1", [stored.observationId]);
  assert.deepEqual(record, { reason_code: "wrong_evidence", actor: "staff:test", reference: "TICKET-42" });
  assert.equal((await read()).observations.some((o) => o.storageId === stored.observationId), false);
  // History is preserved, not overwritten.
  assert.equal((await one("select count(*)::int as n from public.trend_evidence where observation_id = $1", [stored.observationId])).n, 1);
  assert.deepEqual(await invalidate(stored.observationId, "wrong_item", "TICKET-43"),
    { status: "already_invalidated", observationId: stored.observationId });
  await assert.rejects(db.query("update public.trend_observation_invalidations set reason_code = 'wrong_item'"), /trend_rows_are_immutable/);
  await assert.rejects(db.query("delete from public.trend_observation_invalidations"), /trend_delete_only_by_purge/);
});

test("invalidation requests are validated; actors come only from the authorizer and cannot carry content", async () => {
  const stored = await store(youtube("invalid0002"));
  const base = { observationId: stored.observationId, reason: "wrong_item", reference: "T-1" };
  for (const bad of [{ reference: "https://youtube.com/watch?v=x" }, { reference: "the title was wrong" }, { reason: "because" }, { observationId: "nope" }]) {
    assert.deepEqual(await invalidateTrendObservation(ownerRpc(), { ...base, ...bad }, STAFF), { status: "rejected", code: "invalid_request" }, JSON.stringify(bad));
  }
  // A request cannot name its own actor.
  const withActor = await invalidateTrendObservation(ownerRpc(), { ...base, actor: "admin:me" }, { authorizeCorrection: async () => ({ ok: false }) });
  assert.deepEqual(withActor, { status: "rejected", code: "staff_authorization_required" });
  // An authorizer returning a non-opaque actor (email, name) is refused.
  for (const actorId of ["jane@example.com", "Jane Doe", ""]) {
    assert.deepEqual(await invalidateTrendObservation(ownerRpc(), base, { authorizeCorrection: async () => ({ ok: true, actorId }) }),
      { status: "rejected", code: "staff_authorization_required" }, actorId);
  }
  // The database enforces the same formats.
  for (const [actor, reference] of [["jane@example.com", "T-1"], ["staff:1", "has spaces"], ["staff:1", "https://x"]]) {
    const { data } = await ownerRpc().rpc("trend_invalidate_observation", { p_observation_id: stored.observationId, p_reason_code: "wrong_item", p_actor: actor, p_reference: reference });
    assert.deepEqual(data, { status: "rejected", code: "invalid_request" });
  }
  assert.deepEqual(await invalidateTrendObservation(ownerRpc(), { ...base, observationId: "00000000-0000-4000-8000-000000000000" }, STAFF), { status: "rejected", code: "not_found" });
});

test("corrections are disabled: the default authorizer denies and no API role can invalidate", async () => {
  const stored = await store(youtube("disabled001"));
  const request = { observationId: stored.observationId, reason: "wrong_item", reference: "T-2" };
  assert.deepEqual(await invalidateTrendObservation(rpc(), request), { status: "rejected", code: "staff_authorization_required" });
  assert.deepEqual(await invalidateTrendObservation(rpc(), request, { authorizeCorrection: async () => { throw new Error("session lookup failed"); } }),
    { status: "rejected", code: "staff_authorization_required" }, "authorizer errors fail closed");
  // Even a server that wrongly claims staff status cannot invalidate through service_role.
  assert.deepEqual(await invalidateTrendObservation(rpc(), request, STAFF), { status: "rejected", code: "storage_failed" });
  for (const role of ["service_role", "anon", "authenticated"]) {
    assert.equal((await one("select has_function_privilege($1, 'public.trend_invalidate_observation(uuid, text, text, text)', 'EXECUTE') as ok", [role])).ok, false, role);
  }
  const corrected = await correctTrendObservation(rpc(), request, youtube("disabled001"), { now: Date.now() });
  assert.deepEqual(corrected, { invalidation: { status: "rejected", code: "staff_authorization_required" } });
  assert.equal((await one("select count(*)::int as n from public.trend_observation_invalidations where observation_id = $1", [stored.observationId])).n, 0);
  assert.ok((await read()).observations.some((o) => o.storageId === stored.observationId));
});

test("a corrected replacement becomes the next revision; a plain replay cannot resurrect the old one", async () => {
  const obs = youtube("correct0001", { url: "https://example.com/wrong-video" });
  const stored = await store(obs);
  const fixed = { ...obs, evidence: [{ ...obs.evidence[0], url: "https://www.youtube.com/watch?v=correct0001" }] };
  const { invalidation, replacement } = await correctTrendObservation(ownerRpc(),
    { observationId: stored.observationId, reason: "wrong_evidence", reference: "T-77" }, fixed, { now: Date.now(), authorizer: STAFF });
  assert.equal(invalidation.status, "invalidated");
  assert.equal(replacement.status, "stored");
  assert.equal(replacement.revision, 2);
  assert.deepEqual(replacement.keys, stored.keys);
  const [chain] = await all("select revision, replaces_observation_id from public.trend_observations where id = $1", [replacement.observationId]);
  assert.deepEqual(chain, { revision: 2, replaces_observation_id: stored.observationId });
  const served = (await read()).observations.filter((o) => o.keys.trendKey === stored.keys.trendKey && o.window.end === obs.window.end);
  assert.deepEqual(served.map((o) => [o.revision, o.evidence[0].url]), [[2, "https://www.youtube.com/watch?v=correct0001"]]);

  // Replaying the original identity reports the live state; it never revives revision 1.
  assert.deepEqual((await store(obs)).status, "conflict");
  // Only one live revision: a second replacement of revision 1 meets revision 2.
  assert.equal((await store(fixed, { replaces: stored.observationId })).status, "duplicate");
  assert.equal((await one("select count(*)::int as n from public.trend_observations where trend_key = $1 and window_end = $2", [stored.keys.trendKey, obs.window.end])).n, 2);
});

test("a plain store for an identity whose latest revision is invalidated reports `invalidated`", async () => {
  const obs = youtube("correct0002");
  const stored = await store(obs);
  await invalidate(stored.observationId, "wrong_metric", "T-78");
  assert.deepEqual(await store(obs), { status: "invalidated", observationId: stored.observationId, revision: 1 });
});

test("corrections cannot bypass approval, coverage, identity or retention", async () => {
  const obs = youtube("correct0003");
  const stored = await store(obs);
  const live = youtube("correct0004");
  const liveStored = await store(live);
  // Replacing an observation that is still valid.
  assert.equal((await store(live, { replaces: liveStored.observationId })).code, "invalid_replacement");
  await invalidate(stored.observationId, "wrong_item", "T-79");
  // A replacement must keep the same identity and window.
  assert.equal((await store(youtube("correct0005"), { replaces: stored.observationId })).code, "invalid_replacement");
  assert.equal((await store(obs, { replaces: "not-a-uuid" })).code, "invalid_replacement");
  // Source revoked: the correction is refused and the wrong data stays hidden.
  await db.query("update public.trend_source_authorizations set status = 'not_approved', decided_at = now() - interval '20 seconds', reference = 'REF-REVOKE' where source_id = 'youtube_data_api'");
  try {
    assert.equal((await store(obs, { replaces: stored.observationId })).code, "source_not_authorized");
  } finally {
    await db.query("update public.trend_source_authorizations set status = 'approved', decided_at = now() - interval '10 seconds', reference = 'REF-1' where source_id = 'youtube_data_api'");
  }
  // Retention is computed by the database for every revision.
  const fixedResult = await store(obs, { replaces: stored.observationId });
  assert.equal(fixedResult.status, "stored");
  assert.equal(fixedResult.deleteAfter, iso(Date.parse(obs.window.end) + 7 * DAY));
  // The revision guard holds even for the owner.
  await assert.rejects(db.query(
    `insert into public.trend_observations (source_id, platform, country, language, subject_kind, subject_text, subject_normalized, provider_item_id,
       window_start, window_end, retrieved_at, fresh_until, stale_after, expires_at, freshness_basis, delete_after, revision, replaces_observation_id)
     select source_id, platform, country, language, subject_kind, subject_text, subject_normalized, provider_item_id,
       window_start, window_end, retrieved_at, fresh_until, stale_after, expires_at, freshness_basis, delete_after, 3, id
     from public.trend_observations where id = $1`, [liveStored.observationId]), /trend_invalid_replacement/);
});

/* ──────────────────────────────────────────────────────────────
   Source permission history
   ────────────────────────────────────────────────────────────── */

test("every approval, revocation and coverage change is recorded with before, after, actor and reference", async () => {
  await setup();
  const since = new Date(0);
  await db.query("insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('manual_research', 'approved', now() - interval '4 minutes', 'owner:alice', 'DEC-1')");
  await db.query("update public.trend_source_authorizations set status = 'not_approved', decided_at = now() - interval '3 minutes', decided_by = 'owner:bob', reference = 'DEC-2' where source_id = 'manual_research'");
  await db.query("insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values ('manual_research', 'tiktok', 'SG', 'verified', now() - interval '2 minutes', 'manual check', 'owner:carol')");
  await db.query("update public.trend_source_coverage set status = 'unavailable', checked_at = now() - interval '1 minute', evidence = 'region dropped', checked_by = 'owner:dan' where source_id = 'manual_research' and country = 'SG'");
  await db.query("delete from public.trend_source_coverage where source_id = 'manual_research' and country = 'SG'");
  const events = await all(
    "select event_type, actor, reference, platform, country, previous, next, db_role from public.trend_audit_events where occurred_at >= $1 and source_id = 'manual_research' and event_type <> 'observation_invalidated' order by seq",
    [since],
  );
  assert.deepEqual(events.map((e) => [e.event_type, e.actor, e.reference, e.country]), [
    ["authorization_recorded", "owner:alice", "DEC-1", null],
    ["authorization_changed", "owner:bob", "DEC-2", null],
    ["coverage_recorded", "owner:carol", "manual check", "SG"],
    ["coverage_changed", "owner:dan", "region dropped", "SG"],
    ["coverage_removed", "postgres", null, "SG"],
  ]);
  assert.equal(events[1].previous.status, "approved");
  assert.equal(events[1].next.status, "not_approved");
  assert.equal(events[3].previous.status, "verified");
  assert.equal(events[4].next, null);
  assert.ok(events.every((e) => e.db_role === "postgres"));
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal((await one("select has_sequence_privilege($1, 'public.trend_audit_events_seq_seq', 'USAGE') as ok", [role])).ok, false, role);
  }
});

test("a changed decision needs its own new timestamp, and audit rows hold no provider content", async () => {
  await assert.rejects(
    db.query("update public.trend_source_authorizations set status = 'approved' where source_id = 'manual_research'"),
    /trend_decision_needs_new_timestamp/,
  );
  await assert.rejects(
    db.query("update public.trend_source_coverage set evidence = 'quietly changed' where source_id = 'youtube_data_api' and country = 'AE'"),
    /trend_decision_needs_new_timestamp/,
  );
  const columns = (await all("select column_name from information_schema.columns where table_name = 'trend_audit_events'")).map((r) => r.column_name);
  for (const forbidden of ["subject_text", "subject_normalized", "provider_item_id", "url", "attribution", "value"]) assert.equal(columns.includes(forbidden), false, forbidden);
  const invalidations = await all("select previous, next, reference from public.trend_audit_events where event_type = 'observation_invalidated'");
  assert.ok(invalidations.length > 0);
  const text = JSON.stringify(invalidations);
  assert.doesNotMatch(text, /youtube\.com|Eid outfit|correct000|invalid000/i, "no titles, item ids or links");
});

/* ──────────────────────────────────────────────────────────────
   Retention and purge
   ────────────────────────────────────────────────────────────── */

/** Owner-only fixture path: an observation already past its deadline. */
async function seedOverdue(sourceId, { retrievedDaysAgo, deadlineDaysAgo, n }) {
  await setup();
  const retrieved = Date.now() - retrievedDaysAgo * DAY;
  return db.transaction(async (tx) => {
    await tx.query("alter table public.trend_observations disable trigger trend_observations_guard_insert");
    const youtubeRow = sourceId === "youtube_data_api";
    const [row] = (await tx.query(
      `insert into public.trend_observations (source_id, platform, country, language, subject_kind, subject_text, subject_normalized, provider_item_id,
         window_start, window_end, retrieved_at, fresh_until, stale_after, expires_at, freshness_basis, delete_after)
       values ($1, $2, 'AE', 'und', $3, $4, $4, $5, $6, $6, $6, $6, $6, $6, 'provisional_product_default', $7) returning id`,
      [sourceId, youtubeRow ? "youtube" : "google_search", youtubeRow ? "video" : "search_query", `purge ${n}`,
       youtubeRow ? `purge${String(n).padStart(6, "0")}`.slice(0, 11) : null, iso(retrieved), iso(Date.now() - deadlineDaysAgo * DAY)],
    )).rows;
    const metrics = youtubeRow
      ? [["chart_rank", "1", "rank", "youtube_data_api.chart_rank.v1"], ["view_count", "5", "count", "youtube_data_api.view_count.v2"]]
      : [["interest_index", "50", "relative_index", "google_trends_web.interest_index.v1"]];
    for (const [key, value, unit, version] of metrics) {
      await tx.query("insert into public.trend_observation_metrics (observation_id, metric_key, status, value, unit, definition_version) values ($1, $2, 'measured', $3, $4, $5)",
        [row.id, key, value, unit, version]);
    }
    await tx.query("insert into public.trend_evidence (observation_id, source_id, attribution, url, retrieved_at) values ($1, $2, 'fixture', 'https://example.com/e', $3)",
      [row.id, sourceId, iso(retrieved)]);
    await tx.query("set constraints all immediate");
    await tx.query("alter table public.trend_observations enable trigger trend_observations_guard_insert");
    return row.id;
  });
}

test("the purge is bounded, oldest deadline first, cascades, and is recorded", async () => {
  await setup();
  // Settle anything already overdue from other tests.
  await runTrendRetentionPurge(rpc(), { limit: 1000 });
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(await seedOverdue("google_trends_web", { retrievedDaysAgo: 60, deadlineDaysAgo: 10 - i, n: i }));
  // One of them was invalidated: its record goes with it.
  await invalidate(ids[0], "wrong_metric", "T-90");

  const first = await runTrendRetentionPurge(rpc(), { limit: 2 });
  assert.deepEqual([first.status, first.observationsDeleted, first.remainingOverdue], ["succeeded", 2, 3]);
  assert.equal(first.oldestOverdueAt, (await one("select min(delete_after) as t from public.trend_observations where delete_after <= now()")).t.toISOString());
  const left = (await all("select id from public.trend_observations where id = any($1)", [ids])).map((r) => r.id).sort();
  assert.deepEqual(left, ids.slice(2).sort());
  for (const table of ["trend_observation_metrics", "trend_evidence", "trend_observation_invalidations"]) {
    assert.equal((await one(`select count(*)::int as n from public.${table} where observation_id = any($1)`, [ids.slice(0, 2)])).n, 0, table);
  }
  // The invalidation's audit event survives, holding only ids and codes.
  assert.equal((await one("select count(*)::int as n from public.trend_audit_events where observation_id = $1", [ids[0]])).n, 1);

  const second = await runTrendRetentionPurge(rpc(), { limit: 1000 });
  assert.deepEqual([second.status, second.observationsDeleted, second.remainingOverdue, second.oldestOverdueAt], ["succeeded", 3, 0, null]);
  const runs = await all("select status, observations_deleted from public.trend_purge_runs order by finished_at desc limit 2");
  assert.deepEqual(runs.map((r) => [r.status, r.observations_deleted]), [["succeeded", 3], ["succeeded", 2]]);
});

test("the purge refuses invalid limits and has no time argument", async () => {
  await setup();
  for (const limit of [0, -1, 1001, 1.5]) assert.deepEqual(await runTrendRetentionPurge(rpc(), { limit }), { status: "rejected", code: "invalid_limit" });
  assert.deepEqual((await rpc().rpc("trend_run_retention_purge", { p_limit: 5000 })).data, { status: "rejected", code: "invalid_limit" });
  const signatures = (await all("select pg_get_function_identity_arguments(oid) as args from pg_proc where proname in ('trend_run_retention_purge', 'trend_purge_expired')")).map((r) => r.args);
  assert.deepEqual(signatures, ["p_limit integer", "p_limit integer"]);
  // Rows not yet due survive any number of runs.
  const due = await store(youtube("notdue00001"));
  for (let i = 0; i < 3; i += 1) await runTrendRetentionPurge(rpc(), { limit: 1000 });
  assert.equal((await one("select count(*)::int as n from public.trend_observations where id = $1", [due.observationId])).n, 1);
});

test("purge failures are detected, recorded and reported without partial deletion", async () => {
  await setup();
  const id = await seedOverdue("youtube_data_api", { retrievedDaysAgo: 31, deadlineDaysAgo: 2, n: 1 });
  await db.exec(`
    create function public.test_block_delete() returns trigger language plpgsql as $$ begin raise exception 'trend_injected_failure'; end; $$;
    create trigger test_block_delete before delete on public.trend_evidence for each row execute function public.test_block_delete();
  `);
  try {
    const failed = await runTrendRetentionPurge(rpc(), { limit: 100 });
    assert.deepEqual([failed.status, failed.code, failed.observationsDeleted], ["failed", "trend_injected_failure", 0]);
    assert.ok(failed.remainingOverdue >= 1);
    assert.equal((await one("select count(*)::int as n from public.trend_observations where id = $1", [id])).n, 1, "rolled back, not half-deleted");
    const health = await getTrendRetentionStatus(rpc());
    assert.equal(health.ok, true);
    assert.equal(health.status.breach, true, "more than 24 hours overdue");
    assert.equal(health.status.youtubePolicyBreach, true, "YouTube row older than 30 days");
    assert.equal(health.status.lastFailureCode, "trend_injected_failure");
  } finally {
    await db.exec("drop trigger test_block_delete on public.trend_evidence; drop function public.test_block_delete();");
  }
  assert.equal((await runTrendRetentionPurge(rpc(), { limit: 100 })).status, "succeeded");
  const healthy = await getTrendRetentionStatus(rpc());
  assert.deepEqual([healthy.status.overdue, healthy.status.breach, healthy.status.youtubePolicyBreach], [0, false, false]);
  assert.ok(healthy.status.lastSuccessAt >= healthy.status.lastFailureAt);
});

test("audit events are kept 730 days and purge records 90 days", async () => {
  await setup();
  await db.exec(`
    insert into public.trend_audit_events (occurred_at, event_type, db_role, actor, source_id) values
      (now() - interval '731 days', 'authorization_changed', 'postgres', 'owner:old', 'google_trends_api'),
      (now() - interval '729 days', 'authorization_changed', 'postgres', 'owner:recent', 'google_trends_api');
    insert into public.trend_purge_runs (started_at, finished_at, status, batch_limit, remaining_overdue) values
      (now() - interval '91 days', now() - interval '91 days', 'succeeded', 1, 0);
  `);
  const result = await runTrendRetentionPurge(rpc(), { limit: 1000 });
  assert.equal(result.auditEventsDeleted, 1);
  assert.deepEqual((await all("select actor from public.trend_audit_events where actor like 'owner:%' and source_id = 'google_trends_api' order by actor")).map((r) => r.actor), ["owner:recent"]);
  assert.equal((await one("select count(*)::int as n from public.trend_purge_runs where finished_at <= now() - interval '90 days'")).n, 0);
});

test("browser roles cannot purge or read retention health", async () => {
  await setup();
  for (const role of ["anon", "authenticated"]) {
    assert.deepEqual(await runTrendRetentionPurge(rpc(role), { limit: 1 }), { status: "rejected", code: "storage_failed" });
    assert.deepEqual(await getTrendRetentionStatus(rpc(role)), { ok: false });
  }
});

/* ──────────────────────────────────────────────────────────────
   Large metric values
   ────────────────────────────────────────────────────────────── */

test("large metric values are stored and served exactly, or refused — never rounded", async () => {
  const max = "18446744073709551615"; // YouTube unsigned long maximum
  const obs = youtube("precision01");
  const { data } = await storeRaw(payload(obs, {
    metrics: { ...payload(obs).metrics, view_count: { status: "measured", value: max, definition_version: "youtube_data_api.view_count.v2" } },
  }));
  assert.equal(data.status, "stored");
  assert.equal((await one("select value::text as v from public.trend_observation_metrics where observation_id = $1 and metric_key = 'view_count'", [data.observation_id])).v, max);
  const served = (await read()).observations.find((o) => o.storageId === data.observation_id);
  assert.equal(served.metrics.view_count.exactValue, max);

  assert.equal(exactDecimal(Number.MAX_SAFE_INTEGER), "9007199254740991");
  assert.equal(exactDecimal(2 ** 53 + 2), null, "already imprecise in JavaScript");
  assert.equal(exactDecimal(0.1), "0.1");
  assert.equal(exactDecimal(1e-7), "0.0000001");
  assert.equal(exactDecimal(-1), null);

  const big = parseTrendObservation({
    id: "big", sourceId: "youtube_data_api", platform: "youtube", market: { country: "AE", language: "und" },
    subject: { kind: "video", text: "Big", providerItemId: "precision02" },
    window: { start: obs.window.start, end: obs.window.end }, retrievedAt: obs.retrievedAt,
    metrics: { chart_rank: { status: "measured", value: 1 }, view_count: { status: "measured", value: 2 ** 60 } },
    evidence: [{ sourceId: "youtube_data_api", url: null, attribution: "YouTube", retrievedAt: obs.retrievedAt }],
  }, { now: Date.now() });
  assert.equal(big.ok, true);
  assert.deepEqual(await store(big.value), { status: "rejected", code: "metric_precision_lost", detail: "view_count" });
  const tooLong = youtube("precision03");
  assert.deepEqual((await storeRaw(payload(tooLong, { metrics: { ...payload(tooLong).metrics, view_count: { status: "measured", value: "1".repeat(41), definition_version: "youtube_data_api.view_count.v2" } } }))).data,
    { status: "rejected", code: "invalid_metrics" });
});
