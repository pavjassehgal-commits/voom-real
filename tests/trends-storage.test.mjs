/**
 * Trend Intelligence — storage and read model over the service-role RPC.
 *
 * Runs lib/trends/{storage,policy-store,read-model}.ts against the REAL
 * proposed SQL (storage + governance) in a local PGlite database. Writes go
 * through `trend_store_observation` exactly as the Supabase admin client
 * would call it; reads use the read model as service_role. Observations are
 * simulated through the Stage 1 validator. No network, provider, credential
 * or remote database is touched.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { createTrendDb, rpcClient, sqlPort } from "./helpers/trend-db.mjs";

const { parseTrendObservation } = await import("../lib/trends/schema.ts");
const { storeTrendObservation, storeTrendObservations, storageKeys } = await import("../lib/trends/storage.ts");
const { loadTrendMarketPolicy, permittedSources, POLICY_REVIEW_PERIODS } = await import("../lib/trends/policy-store.ts");
const { listUsableTrendObservations, toTrendObservation } = await import("../lib/trends/read-model.ts");
const { groupObservationsByTrend } = await import("../lib/trends/dedupe.ts");
const { classifyTrendConfidence } = await import("../lib/trends/confidence.ts");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

let db;
async function owner() {
  if (!db) {
    ({ db } = await createTrendDb());
    for (const source of ["youtube_data_api", "manual_research", "google_trends_web"]) await setAuthorization(source, "approved");
    await db.exec(`
      insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values
        ('youtube_data_api', 'youtube', 'AE', 'verified', now(), 'fixture', 'owner:test'),
        ('youtube_data_api', 'youtube', 'IN', 'verified', now(), 'fixture', 'owner:test'),
        ('youtube_data_api', 'youtube', 'CN', 'unavailable', now(), 'fixture', 'owner:test'),
        ('manual_research', 'tiktok', 'AE', 'verified', now(), 'fixture', 'owner:test'),
        ('google_trends_web', 'google_search', 'AE', 'verified', now(), 'fixture', 'owner:test'),
        ('google_trends_api', 'google_search', 'AE', 'verified', now(), 'fixture', 'owner:test');
    `);
  }
  return db;
}

/** A distinct, recent decision time per call (a changed decision needs a new timestamp). */
let decisionTick = 0;
const nextDecisionAt = () => `'${new Date(Date.now() - 60_000 + (decisionTick += 1)).toISOString()}'::timestamptz`;

/** Owner decision (upsert, so the audit trail sees changes). */
async function setAuthorization(source, status, decidedAtSql = nextDecisionAt()) {
  if (status === null) {
    await db.query("delete from public.trend_source_authorizations where source_id = $1", [source]);
  } else if (status === "under_review") {
    await db.query(
      `insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference)
       values ($1, 'under_review', null, null, null)
       on conflict (source_id) do update set status = excluded.status, decided_at = null, decided_by = null, reference = null`,
      [source],
    );
  } else {
    await db.query(
      `insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference)
       values ($1, $2, ${decidedAtSql}, 'owner:test', 'REF-1')
       on conflict (source_id) do update set status = excluded.status, decided_at = excluded.decided_at,
         decided_by = excluded.decided_by, reference = excluded.reference`,
      [source, status],
    );
  }
}

const rpc = () => rpcClient(db, "service_role");
const reader = () => sqlPort(db, "service_role");

async function count(table, where = "true", params = []) {
  await owner();
  return Number((await db.query(`select count(*)::int as n from public.${table} where ${where}`, params)).rows[0].n);
}

let seq = 0;
function youtube({ videoId, country = "AE", title = "Eid outfit ideas", endAgo = HOUR, metrics, evidence } = {}) {
  seq += 1;
  const end = Date.now() - endAgo - seq;
  return parse({
    id: `yt-${seq}`,
    sourceId: "youtube_data_api",
    platform: "youtube",
    market: { country, language: "und" },
    subject: { kind: "video", text: title, providerItemId: videoId },
    window: { start: iso(end), end: iso(end) },
    retrievedAt: iso(end),
    metrics: metrics ?? { chart_rank: { status: "measured", value: 3 }, view_count: { status: "measured", value: 5000 } },
    evidence: evidence ?? [{ sourceId: "youtube_data_api", url: `https://www.youtube.com/watch?v=${videoId}`, attribution: "YouTube", retrievedAt: iso(end) }],
  });
}

function rawYoutube(videoId) {
  const end = Date.now() - HOUR;
  return {
    id: "raw", sourceId: "youtube_data_api", platform: "youtube", market: { country: "AE", language: "und" },
    subject: { kind: "video", text: "x", providerItemId: videoId },
    window: { start: iso(end), end: iso(end) }, retrievedAt: iso(end),
    metrics: { chart_rank: { status: "measured", value: 1 }, view_count: { status: "measured", value: 1 } },
    evidence: [{ sourceId: "youtube_data_api", url: null, attribution: "YouTube", retrievedAt: iso(end) }],
  };
}

function parse(raw) {
  const result = parseTrendObservation(raw, { now: Date.now() });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

const store = async (observation, client) => storeTrendObservation(client ?? (await owner(), rpc()), observation, { now: Date.now() });
const read = async (query) => {
  await owner();
  return listUsableTrendObservations(reader(), { platform: "youtube", country: "AE", now: Date.now(), ...query });
};

/* ──────────────────────────────────────────────────────────────
   Valid insertion and the read model
   ────────────────────────────────────────────────────────────── */

test("a valid observation is stored atomically with every metric and its evidence", async () => {
  const obs = youtube({ videoId: "aaaaaaaaaa1" });
  const result = await store(obs);
  assert.equal(result.status, "stored", JSON.stringify(result));
  assert.equal(result.revision, 1);
  assert.deepEqual(result.keys, storageKeys(obs));
  // The database computes the deadline: YouTube data expires 7 days after the window.
  assert.equal(result.deleteAfter, iso(Date.parse(obs.window.end) + 7 * DAY));
  assert.equal(result.expiresAt, result.deleteAfter);
  const metrics = (await db.query(
    "select metric_key, status, value::text as value, definition_version, unavailable_reason from public.trend_observation_metrics where observation_id = $1 order by metric_key",
    [result.observationId],
  )).rows;
  assert.deepEqual(metrics, [
    { metric_key: "chart_rank", status: "measured", value: "3", definition_version: "youtube_data_api.chart_rank.v1", unavailable_reason: null },
    { metric_key: "comment_count", status: "unavailable", value: null, definition_version: null, unavailable_reason: "not_collected" },
    { metric_key: "like_count", status: "unavailable", value: null, definition_version: null, unavailable_reason: "not_collected" },
    { metric_key: "view_count", status: "measured", value: "5000", definition_version: "youtube_data_api.view_count.v2", unavailable_reason: null },
  ]);
  assert.equal(await count("trend_evidence", "observation_id = $1", [result.observationId]), 1);
});

test("the read model preserves identity, definitions, attribution and unavailable metrics", async () => {
  const obs = youtube({ videoId: "bbbbbbbbbb2", metrics: {
    chart_rank: { status: "measured", value: 1 },
    view_count: { status: "measured", value: 0 },
    like_count: { status: "unavailable", reason: "hidden_by_owner" },
  } });
  const { observationId } = await store(obs);
  const result = await read({ limit: 200 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.permittedSourceIds, ["youtube_data_api"]);
  const found = result.observations.find((o) => o.storageId === observationId);
  assert.equal(found.revision, 1);
  assert.deepEqual(found.item, { platform: "youtube", kind: "video", providerItemId: "bbbbbbbbbb2" });
  assert.deepEqual(found.keys, storageKeys(obs));
  assert.deepEqual(found.metrics.view_count, { status: "measured", value: 0, exactValue: "0", unit: "count", definitionVersion: "youtube_data_api.view_count.v2" }, "a real zero");
  assert.deepEqual(found.metrics.like_count, { status: "unavailable", reason: "hidden_by_owner", unit: "count" }, "not a zero");
  assert.deepEqual(found.metrics.comment_count, { status: "unavailable", reason: "not_collected", unit: "count" });
  assert.deepEqual(found.evidence, obs.evidence);
  const stage1 = toTrendObservation(found);
  assert.deepEqual({ ...stage1, id: obs.id }, obs);
  const [group] = groupObservationsByTrend([stage1]);
  const policy = (await loadTrendMarketPolicy(reader(), { now: Date.now() })).policy;
  assert.equal(classifyTrendConfidence(group, { now: Date.now(), markets: policy }).level, "medium");
});

test("the read model is bounded and validates its query", async () => {
  for (const limit of [0, 201, 1.5]) assert.deepEqual(await read({ limit }), { status: "invalid_query", reason: "invalid_limit" });
  assert.deepEqual(await read({ country: "ae" }), { status: "invalid_query", reason: "invalid_country" });
  assert.deepEqual(await read({ language: "english" }), { status: "invalid_query", reason: "invalid_language" });
  assert.deepEqual(await read({ platform: "myspace" }), { status: "invalid_query", reason: "invalid_platform" });
  assert.deepEqual(await read({ now: "yesterday" }), { status: "invalid_query", reason: "invalid_now" });
  const two = await read({ limit: 2 });
  assert.equal(two.observations.length, 2);
  assert.ok(two.observations[0].window.end >= two.observations[1].window.end, "newest window first");
});

/* ──────────────────────────────────────────────────────────────
   Duplicates and concurrency
   ────────────────────────────────────────────────────────────── */

test("an identical replay is a duplicate; a different payload is a conflict; nothing is overwritten", async () => {
  const obs = youtube({ videoId: "ccccccccc01" });
  const first = await store(obs);
  assert.deepEqual(await store(obs), { status: "duplicate", observationId: first.observationId, revision: 1, keys: first.keys });
  const altered = parse({
    id: "altered",
    sourceId: obs.sourceId, platform: obs.platform, market: obs.market,
    subject: { kind: "video", text: "Retitled!", providerItemId: "ccccccccc01" },
    window: obs.window, retrievedAt: obs.retrievedAt,
    metrics: { chart_rank: { status: "measured", value: 9 }, view_count: { status: "measured", value: 1 } },
    evidence: obs.evidence,
  });
  // A conflict reports the row that is kept (its keys, not the rejected payload's).
  assert.deepEqual(await store(altered), { status: "conflict", observationId: first.observationId, revision: 1, keys: first.keys });
  const [kept] = (await db.query(
    "select o.subject_text, m.value::text as rank from public.trend_observations o join public.trend_observation_metrics m on m.observation_id = o.id and m.metric_key = 'chart_rank' where o.id = $1",
    [first.observationId],
  )).rows;
  assert.deepEqual(kept, { subject_text: "Eid outfit ideas", rank: "3" });
  assert.equal(await count("trend_observation_metrics", "observation_id = $1", [first.observationId]), 4);
});

test("concurrent requests for the same observation store it exactly once", async () => {
  const obs = youtube({ videoId: "ddddddddd01" });
  const results = await Promise.all(Array.from({ length: 6 }, () => store(obs)));
  assert.deepEqual(results.map((r) => r.status).sort(), ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "stored"]);
  assert.equal(new Set(results.map((r) => r.observationId)).size, 1);
  assert.equal(await count("trend_observations", "item_key = $1", ["item|youtube|video|ddddddddd01"]), 1);
  assert.equal(await count("trend_observation_metrics", "observation_id = $1", [results[0].observationId]), 4);
  assert.equal(await count("trend_evidence", "observation_id = $1", [results[0].observationId]), 1);
});

test("concurrent requests for different observations store all of them", async () => {
  const batch = ["eeeeeeeee01", "eeeeeeeee02", "eeeeeeeee03", "eeeeeeeee04"].map((videoId) => youtube({ videoId }));
  const results = await Promise.all(batch.map((obs) => store(obs)));
  assert.deepEqual(results.map((r) => r.status), ["stored", "stored", "stored", "stored"]);
  const { counts } = await storeTrendObservations(rpc(), batch, { now: Date.now() });
  assert.deepEqual(counts, { stored: 0, duplicate: 4, conflict: 0, invalidated: 0, rejected: 0 });
  await assert.rejects(storeTrendObservations(rpc(), Array(201).fill(batch[0]), { now: Date.now() }), RangeError);
});

/* ──────────────────────────────────────────────────────────────
   Authorization (current, deny by default)
   ────────────────────────────────────────────────────────────── */

const gtApi = () => parse({
  id: `gta-${(seq += 1)}`,
  sourceId: "google_trends_api", platform: "google_search", market: { country: "AE", language: "und" },
  subject: { kind: "search_query", text: `eid gifts ${seq}` },
  window: { start: iso(Date.now() - DAY), end: iso(Date.now() - HOUR) }, retrievedAt: iso(Date.now() - HOUR),
  metrics: { scaled_interest: { status: "measured", value: 42.5 } },
  evidence: [{ sourceId: "google_trends_api", url: null, attribution: "Google Trends API (alpha)", retrievedAt: iso(Date.now() - HOUR) }],
});

test("a source with no decision, a pending decision or a refusal cannot store", async () => {
  await owner();
  for (const status of [null, "under_review", "not_approved"]) {
    await setAuthorization("google_trends_api", status);
    assert.deepEqual(await store(gtApi()), { status: "rejected", code: "source_not_authorized" }, String(status));
  }
  assert.equal(await count("trend_observations", "source_id = 'google_trends_api'"), 0);
  await setAuthorization("google_trends_api", null);
});

test("revoking a source blocks new data and hides stored data; re-approval restores visibility", async () => {
  const obs = youtube({ videoId: "fffffffff01" });
  const { observationId } = await store(obs);
  try {
    await setAuthorization("youtube_data_api", "not_approved");
    assert.equal((await store(youtube({ videoId: "fffffffff02" }))).code, "source_not_authorized");
    const hidden = await read({ limit: 200 });
    assert.deepEqual([hidden.status, hidden.observations.length, hidden.permittedSourceIds], ["ok", 0, []]);
    assert.equal(await count("trend_observations", "id = $1", [observationId]), 1, "revocation hides, it does not rewrite history");
  } finally {
    await setAuthorization("youtube_data_api", "approved");
  }
  assert.ok((await read({ limit: 200 })).observations.some((o) => o.storageId === observationId));
});

test("the store RPC locks the approval it relied on until it commits", async () => {
  await owner();
  const obs = youtube({ videoId: "fffffffff03" });
  const locks = await db.transaction(async (tx) => {
    await tx.query("set local role service_role");
    const { rows } = await tx.query("select public.trend_store_observation($1::jsonb) as r", [JSON.stringify({
      source_id: obs.sourceId, platform: obs.platform, country: "AE", language: "und", subject_kind: "video",
      subject_text: obs.subject.text, subject_normalized: obs.subject.normalized, provider_item_id: "fffffffff03",
      window_start: obs.window.start, window_end: obs.window.end, retrieved_at: obs.retrievedAt,
      metrics: {
        chart_rank: { status: "measured", value: "3", definition_version: "youtube_data_api.chart_rank.v1" },
        view_count: { status: "measured", value: "5000", definition_version: "youtube_data_api.view_count.v2" },
        like_count: { status: "unavailable", unavailable_reason: "not_collected" },
        comment_count: { status: "unavailable", unavailable_reason: "not_collected" },
      },
      evidence: [{ source_id: "youtube_data_api", url: null, attribution: "YouTube", retrieved_at: obs.retrievedAt }],
    })]);
    assert.equal(rows[0].r.status, "stored");
    return (await tx.query(
      "select c.relname, l.mode from pg_locks l join pg_class c on c.oid = l.relation where c.relname in ('trend_source_authorizations', 'trend_source_coverage') order by 1",
    )).rows;
  });
  // ROW SHARE table locks are taken by SELECT ... FOR SHARE: a concurrent
  // revocation (UPDATE/DELETE of that row) waits until this insert commits.
  const rowShare = locks.filter((l) => l.mode === "RowShareLock").map((l) => l.relname);
  assert.deepEqual(rowShare, ["trend_source_authorizations", "trend_source_coverage"]);
});

test("approvals expire after the review period and future-dated decisions count for nothing", async () => {
  await owner();
  try {
    await setAuthorization("youtube_data_api", "approved", "now() - interval '400 days'");
    assert.equal((await store(youtube({ videoId: "ggggggggg01" }))).code, "source_not_authorized");
    const loaded = await loadTrendMarketPolicy(reader(), { now: Date.now() });
    assert.ok(loaded.issues.some((i) => i.reason === "authorization_expired" && i.sourceId === "youtube_data_api"));
    await setAuthorization("youtube_data_api", "approved", "now() + interval '1 day'");
    assert.equal((await store(youtube({ videoId: "ggggggggg02" }))).code, "source_not_authorized");
    await setAuthorization("youtube_data_api", "not_approved", "now() - interval '900 days'");
    assert.equal((await store(youtube({ videoId: "ggggggggg03" }))).code, "source_not_authorized");
  } finally {
    await setAuthorization("youtube_data_api", "approved");
  }
  const longer = await loadTrendMarketPolicy(reader(), { now: Date.now() + 400 * DAY, reviewPeriods: { authorizationMs: 10_000 * DAY } });
  assert.equal(longer.policy.authorizations.some((a) => a.status === "approved"), false);
  assert.ok(POLICY_REVIEW_PERIODS.authorizationMs > 0);
});

test("any failure to load the policy or reach the RPC denies", async () => {
  await owner();
  const broken = {
    query: (sql, params) => (sql.includes("trend_source_authorizations") ? Promise.reject(new Error("down")) : reader().query(sql, params)),
    transaction: (fn) => reader().transaction((tx) => fn({
      query: (sql, params) => (sql.includes("trend_source_authorizations") ? Promise.reject(new Error("down")) : tx.query(sql, params)),
    })),
  };
  const loaded = await loadTrendMarketPolicy(broken, { now: Date.now() });
  assert.equal(loaded.complete, false);
  assert.deepEqual(permittedSources(loaded.policy, "youtube", "AE"), []);
  assert.deepEqual(await listUsableTrendObservations(broken, { platform: "youtube", country: "AE", now: Date.now() }), { status: "unavailable", code: "policy_unavailable" });
  const unreachable = { rpc: () => Promise.reject(new Error("network down: secret-host")) };
  assert.deepEqual(await store(youtube({ videoId: "hhhhhhhhh01" }), unreachable), { status: "rejected", code: "storage_failed" });
  const garbage = { rpc: async () => ({ data: { status: "stored", observation_id: "not-a-uuid" }, error: null }) };
  assert.deepEqual(await store(youtube({ videoId: "hhhhhhhhh02" }), garbage), { status: "rejected", code: "storage_failed" });
});

test("browser roles can neither store nor read, and errors never leak database text", async () => {
  await owner();
  for (const role of ["anon", "authenticated"]) {
    const stored = await store(youtube({ videoId: "iiiiiiiii01" }), rpcClient(db, role));
    assert.deepEqual(stored, { status: "rejected", code: "storage_failed" });
    assert.deepEqual(await listUsableTrendObservations(sqlPort(db, role), { platform: "youtube", country: "AE", now: Date.now() }), { status: "unavailable", code: "policy_unavailable" });
  }
  assert.equal(await count("trend_observations", "provider_item_id = 'iiiiiiiii01'"), 0);
});

/* ──────────────────────────────────────────────────────────────
   Market coverage, country and language
   ────────────────────────────────────────────────────────────── */

test("markets without current verified coverage are refused", async () => {
  assert.equal((await store(youtube({ videoId: "jjjjjjjjj01", country: "SG" }))).code, "coverage_not_verified", "no check recorded");
  assert.equal((await store(youtube({ videoId: "jjjjjjjjj02", country: "CN" }))).code, "coverage_not_verified", "unavailable");
  await db.query("update public.trend_source_coverage set checked_at = now() - interval '200 days' where source_id = 'youtube_data_api' and country = 'IN'");
  try {
    assert.equal((await store(youtube({ videoId: "jjjjjjjjj03", country: "IN" }))).code, "coverage_not_verified", "expired check");
    assert.deepEqual((await read({ country: "IN" })).permittedSourceIds, []);
  } finally {
    await db.query("update public.trend_source_coverage set checked_at = clock_timestamp() where source_id = 'youtube_data_api' and country = 'IN'");
  }
});

test("country and language never mix", async () => {
  const ae = await store(youtube({ videoId: "kkkkkkkkk01", country: "AE" }));
  const inn = await store(youtube({ videoId: "kkkkkkkkk01", country: "IN" }));
  assert.equal(ae.keys.itemKey, inn.keys.itemKey);
  assert.notEqual(ae.observationId, inn.observationId);
  assert.equal((await read({ country: "IN", limit: 200 })).observations.some((o) => o.storageId === ae.observationId), false);
  assert.equal((await read({ country: "AE", limit: 200 })).observations.some((o) => o.storageId === inn.observationId), false);

  const wrong = parseTrendObservation({ ...rawYoutube("kkkkkkkkk02"), market: { country: "AE", language: "en" } }, { now: Date.now() });
  assert.equal(wrong.ok, false, "YouTube does not report language");

  const end = Date.now() - HOUR;
  const sound = (language) => parse({
    id: `snd-${language}`, sourceId: "manual_research", platform: "tiktok", market: { country: "AE", language },
    subject: { kind: "sound", text: "Original sound", providerItemId: "7001" },
    window: { start: iso(end), end: iso(end) }, retrievedAt: iso(end),
    evidence: [{ sourceId: "manual_research", url: "https://www.tiktok.com/music/x-7001", attribution: "Reviewer", retrievedAt: iso(end) }],
  });
  for (const language of ["en", "ar"]) assert.equal((await store(sound(language))).status, "stored");
  const arabic = await listUsableTrendObservations(reader(), { platform: "tiktok", country: "AE", language: "ar", now: Date.now() });
  assert.deepEqual(arabic.observations.map((o) => o.market.language), ["ar"]);
});

/* ──────────────────────────────────────────────────────────────
   Expiry, metrics and evidence
   ────────────────────────────────────────────────────────────── */

test("expired observations are never stored and stop being served", async () => {
  assert.equal((await store(youtube({ videoId: "lllllllll01", endAgo: 8 * DAY }))).code, "observation_expired");
  const obs = youtube({ videoId: "lllllllll02" });
  const { observationId } = await store(obs);
  const visible = async (now) => (await read({ now, limit: 200 })).observations.some((o) => o.storageId === observationId);
  assert.equal(await visible(Date.now()), true);
  assert.equal(await visible(Date.parse(obs.window.end) + 7 * DAY + 1000), false, "past expiry and deletion deadline");
});

test("invalid metric definitions are refused before and inside the database", async () => {
  const raw = rawYoutube("mmmmmmmmm01");
  raw.metrics.view_count.definitionVersion = "youtube_data_api.view_count.v1";
  assert.equal(parseTrendObservation(raw, { now: Date.now() }).ok, false, "superseded definition");

  const obs = youtube({ videoId: "mmmmmmmmm02" });
  const tampered = { ...obs, metrics: { ...obs.metrics, view_count: { status: "measured", value: 5000, definitionVersion: "youtube_data_api.view_count.v1" } } };
  assert.equal((await store(tampered)).code, "observation_not_validated");

  await db.query("delete from public.trend_metric_definitions where version_id = 'youtube_data_api.view_count.v2'");
  try {
    const before = await count("trend_observations");
    assert.deepEqual(await store(youtube({ videoId: "mmmmmmmmm03" })), { status: "rejected", code: "metric_rejected", detail: "unknown_metric_definition" });
    assert.equal(await count("trend_observations"), before, "nothing kept");
  } finally {
    await db.query(`insert into public.trend_metric_definitions values
      ('youtube_data_api.view_count.v2', 'youtube_data_api', 'view_count', 'count', '2026-08-24T00:00:00Z', null, 0, null, true, true)`);
  }
});

test("missing metrics are stored and served as unavailable, never invented", async () => {
  const obs = youtube({ videoId: "nnnnnnnnn01", metrics: { chart_rank: { status: "measured", value: 2 } } });
  assert.deepEqual(obs.metrics.view_count, { status: "unavailable", reason: "not_collected" });
  const { observationId } = await store(obs);
  const found = (await read({ limit: 200 })).observations.find((o) => o.storageId === observationId);
  assert.deepEqual(found.metrics.view_count, { status: "unavailable", reason: "not_collected", unit: "count" });
  const withoutKey = { ...youtube({ videoId: "nnnnnnnnn02" }) };
  withoutKey.metrics = { chart_rank: withoutKey.metrics.chart_rank, view_count: withoutKey.metrics.view_count };
  assert.equal((await store(withoutKey)).code, "observation_not_validated");
});

test("a failure midway rolls back the observation, its metrics and its evidence", async () => {
  await owner();
  await db.exec(`
    create function public.test_fail_evidence() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end; $$;
    create trigger test_fail_evidence before insert on public.trend_evidence for each row execute function public.test_fail_evidence();
  `);
  const obs = youtube({ videoId: "ooooooooo01" });
  const before = [await count("trend_observations"), await count("trend_observation_metrics"), await count("trend_evidence")];
  try {
    assert.deepEqual(await store(obs), { status: "rejected", code: "storage_failed" });
    assert.deepEqual([await count("trend_observations"), await count("trend_observation_metrics"), await count("trend_evidence")], before);
  } finally {
    await db.exec("drop trigger test_fail_evidence on public.trend_evidence; drop function public.test_fail_evidence();");
  }
  assert.equal((await store(obs)).status, "stored", "the same observation stores once the fault is gone");
});

test("historical evidence stays exactly as recorded", async () => {
  const first = youtube({ videoId: "ppppppppp01" });
  const { observationId } = await store(first);
  const laterEnd = Date.parse(first.window.end) + 10 * 60_000;
  const later = parse({
    ...rawYoutube("ppppppppp01"), id: "later",
    window: { start: iso(laterEnd), end: iso(laterEnd) }, retrievedAt: iso(laterEnd),
    evidence: [{ sourceId: "youtube_data_api", url: "https://youtu.be/ppppppppp01", attribution: "YouTube (chart)", retrievedAt: iso(laterEnd) }],
  });
  const second = await store(later);
  assert.equal(second.status, "stored");
  const replay = parse({ ...rawYoutube("ppppppppp01"), id: "replay", window: first.window, retrievedAt: first.retrievedAt,
    evidence: [{ sourceId: "youtube_data_api", url: "https://example.com/other", attribution: "Someone else", retrievedAt: first.retrievedAt }] });
  assert.equal((await store(replay)).status, "conflict");
  await assert.rejects(db.query("update public.trend_evidence set attribution = 'edited' where observation_id = $1", [observationId]), /trend_rows_are_immutable/);
  await assert.rejects(reader().query("delete from public.trend_evidence where observation_id = $1", [observationId]), /permission denied/);
  const served = (await read({ limit: 200 })).observations;
  assert.deepEqual(served.find((o) => o.storageId === observationId).evidence, first.evidence);
  assert.deepEqual(served.find((o) => o.storageId === second.observationId).evidence, later.evidence);
});
