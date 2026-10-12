/**
 * Trend Intelligence — Stage 2A storage, real-database coverage.
 *
 * Applies every repository migration to an embedded PostgreSQL (PGlite), then
 * the PROPOSED, unnumbered storage migration
 * (supabase/proposed/trend_intelligence_storage.sql) exactly as written.
 * Before applying it, Supabase's default privileges are reproduced (new
 * tables and functions granted to anon/authenticated/service_role), so the
 * test proves the migration's own revokes close that door.
 *
 * Covers: unauthorized access, duplicate prevention, immutability, source
 * authorization and coverage gates, country/language separation, metric
 * validation, retention caps, cascade deletion, bounded purge, migration
 * correctness and rollback. No provider, network, credential or remote
 * database is touched.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const { TREND_SOURCES } = await import("../lib/trends/types.ts");

const MIGRATION = readFileSync(new URL("../supabase/proposed/trend_intelligence_storage.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/proposed/trend_intelligence_storage.rollback.sql", import.meta.url), "utf8");

const TABLES = [
  "trend_sources",
  "trend_metric_definitions",
  "trend_source_authorizations",
  "trend_source_coverage",
  "trend_observations",
  "trend_observation_metrics",
  "trend_evidence",
];

const SUPABASE_DEFAULT_PRIVILEGES = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

let state;
async function setup() {
  if (state) return state;
  const lite = await createSupabaseLite({ stopBefore: "0055" });
  await lite.db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  await lite.db.exec(MIGRATION);
  // Owner decisions (as the migration owner, never as the app).
  await lite.db.exec(`
    insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values
      ('youtube_data_api', 'approved', now(), 'test owner', 'test fixture'),
      ('manual_research', 'approved', now(), 'test owner', 'test fixture'),
      ('google_trends_web', 'approved', now(), 'test owner', 'test fixture'),
      ('google_trends_api', 'approved', now(), 'test owner', 'test fixture');
    insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence) values
      ('youtube_data_api', 'youtube', 'AE', 'verified', now(), 'fixture'),
      ('youtube_data_api', 'youtube', 'IN', 'verified', now(), 'fixture'),
      ('youtube_data_api', 'youtube', 'CN', 'unavailable', now(), 'fixture'),
      ('manual_research', 'youtube', 'AE', 'verified', now(), 'fixture'),
      ('manual_research', 'tiktok', 'AE', 'verified', now(), 'fixture'),
      ('manual_research', 'google_search', 'AE', 'verified', now(), 'fixture'),
      ('google_trends_web', 'google_search', 'AE', 'verified', now(), 'fixture'),
      ('google_trends_api', 'google_search', 'AE', 'verified', now(), 'fixture');
  `);
  state = lite;
  return state;
}

async function all(sql, params = []) {
  const { db } = await setup();
  return (await db.query(sql, params)).rows;
}

/** Runs `fn(tx)` in one transaction as `role` (null = migration owner). */
async function asRole(role, fn) {
  const { db } = await setup();
  return db.transaction(async (tx) => {
    if (role) await tx.query(`set local role ${role}`);
    return fn(tx);
  });
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.match(String(error?.message), pattern);
    return true;
  });
}

const VID_A = "aaaaaaaaaa1";
const VID_B = "bbbbbbbbbb2";

const DEFAULT_METRICS = {
  youtube_data_api: [
    { metric_key: "chart_rank", status: "measured", value: 1, unit: "rank", definition_version: "youtube_data_api.chart_rank.v1" },
    { metric_key: "view_count", status: "measured", value: 5000, unit: "count", definition_version: "youtube_data_api.view_count.v2" },
  ],
  google_trends_web: [
    { metric_key: "interest_index", status: "measured", value: 50, unit: "relative_index", definition_version: "google_trends_web.interest_index.v1" },
  ],
  google_trends_api: [
    { metric_key: "scaled_interest", status: "measured", value: 12.5, unit: "scaled_interest", definition_version: "google_trends_api.scaled_interest.alpha" },
  ],
  manual_research: [],
};

let windowCounter = 0;
/** A valid observation row; every test passes what it varies. */
function observation(overrides = {}) {
  const rest = { ...overrides };
  delete rest.retrievedMs;
  const retrieved = overrides.retrievedMs ?? Date.now() - HOUR - (windowCounter += 1000);
  const source = rest.source_id ?? "youtube_data_api";
  const defaults = {
    youtube_data_api: { platform: "youtube", subject_kind: "video", provider_item_id: VID_A, language: "und" },
    manual_research: { platform: "youtube", subject_kind: "video", provider_item_id: VID_A, language: "und" },
    google_trends_web: { platform: "google_search", subject_kind: "search_query", provider_item_id: null, language: "und" },
    google_trends_api: { platform: "google_search", subject_kind: "search_query", provider_item_id: null, language: "und" },
  }[source];
  return {
    source_id: source,
    country: "AE",
    subject_text: "Eid outfit ideas",
    subject_normalized: "eid outfit ideas",
    window_start: iso(retrieved),
    window_end: iso(retrieved),
    retrieved_at: iso(retrieved),
    fresh_until: iso(retrieved + DAY),
    stale_after: iso(retrieved + 3 * DAY),
    expires_at: iso(retrieved + 7 * DAY),
    freshness_basis: "provisional_product_default",
    delete_after: iso(retrieved + 29 * DAY),
    ...defaults,
    ...rest,
  };
}

async function insertRows(tx, table, row) {
  const cols = Object.keys(row);
  const { rows } = await tx.query(
    `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    cols.map((c) => row[c]),
  );
  return rows[0];
}

/** Stores an observation with its metrics and evidence in one transaction. */
async function store(row, { metrics, evidence, role = "service_role" } = {}) {
  return asRole(role, async (tx) => {
    const obs = await insertRows(tx, "trend_observations", row);
    for (const metric of metrics ?? DEFAULT_METRICS[row.source_id]) {
      await insertRows(tx, "trend_observation_metrics", { observation_id: obs.id, ...metric });
    }
    for (const entry of evidence ?? [{ url: "https://example.com/evidence" }]) {
      await insertRows(tx, "trend_evidence", {
        observation_id: obs.id,
        source_id: row.source_id,
        attribution: "Test attribution",
        retrieved_at: row.retrieved_at,
        ...entry,
      });
    }
    return obs;
  });
}

const count = async (table, where = "true", params = []) =>
  Number((await all(`select count(*)::int as n from public.${table} where ${where}`, params))[0].n);

/* ──────────────────────────────────────────────────────────────
   Migration correctness
   ────────────────────────────────────────────────────────────── */

test("the proposed migration applies after every repository migration and is not itself a numbered migration", async () => {
  const { applied } = await setup();
  assert.equal(applied[applied.length - 1], "0051_ai_request_rate_limits.sql", "repository migrations unchanged");
  assert.equal(applied.some((name) => name.includes("trend")), false, "not picked up by the Supabase migration directory");
  const tables = (await all(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'trend\\_%' order by 1",
  )).map((r) => r.table_name);
  assert.deepEqual(tables, [...TABLES].sort());
});

test("the migration is idempotent, and the rollback removes everything and re-applies cleanly", async () => {
  const { db } = await createSupabaseLite({ stopBefore: "0055" });
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  await db.exec(ROLLBACK);
  const left = await db.query(
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname like 'trend\\_%'
     union all
     select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'trend\\_%'`,
  );
  assert.deepEqual(left.rows.map((r) => r.n), [0, 0]);
  await db.exec(MIGRATION);
  assert.equal((await db.query("select count(*)::int as n from public.trend_sources")).rows[0].n, 4);
});

test("the base storage migration mirrors the sources that existed before connector migrations", async () => {
  const sources = await all("select * from public.trend_sources order by source_id");
  const baseSources = Object.values(TREND_SOURCES).filter((source) => source.id !== "wikidata_events");
  assert.deepEqual(sources.map((s) => s.source_id), baseSources.map((source) => source.id).sort());
  for (const row of sources) {
    const source = TREND_SOURCES[row.source_id];
    assert.deepEqual(row.platforms, [...source.platforms], row.source_id);
    assert.deepEqual(row.subject_kinds, [...source.subjectKinds], row.source_id);
    assert.equal(row.language_scope, source.languageScope, row.source_id);
    assert.equal(row.requires_evidence_url, source.requiresEvidenceUrl, row.source_id);
  }
  assert.equal(sources.find((s) => s.source_id === "youtube_data_api").max_retention_days, 30);

  const definitions = await all("select * from public.trend_metric_definitions order by version_id");
  const expected = [];
  for (const source of baseSources) {
    for (const metric of source.metrics) {
      for (const version of metric.versions) {
        expected.push({
          version_id: version.id,
          source_id: source.id,
          metric_key: metric.key,
          unit: metric.unit,
          effective_from: version.effectiveFrom,
          effective_until: version.effectiveUntil,
          min_value: String(metric.min),
          max_value: metric.max === null ? null : String(metric.max),
          integer_only: metric.integer,
          required: metric.required,
        });
      }
    }
  }
  const actual = definitions.map((d) => ({
    ...d,
    effective_from: d.effective_from ? new Date(d.effective_from).toISOString().replace(".000Z", "Z") : null,
    effective_until: d.effective_until ? new Date(d.effective_until).toISOString().replace(".000Z", "Z") : null,
    min_value: String(d.min_value),
    max_value: d.max_value === null ? null : String(d.max_value),
  }));
  assert.deepEqual(actual, expected.sort((a, b) => (a.version_id < b.version_id ? -1 : 1)));
});

test("no merchant or customer data can live in trend storage, and nothing is scheduled", async () => {
  const columns = (await all(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name like 'trend\\_%'",
  )).map((r) => r.column_name);
  for (const forbidden of ["owner_user_id", "user_id", "business_id", "email", "phone", "name"]) {
    assert.equal(columns.includes(forbidden), false, forbidden);
  }
  const foreignTargets = (await all(
    `select distinct ccu.table_schema || '.' || ccu.table_name as target
       from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_name like 'trend\\_%'`,
  )).map((r) => r.target).sort();
  assert.deepEqual(foreignTargets, ["public.trend_observations", "public.trend_sources"]);
  assert.doesNotMatch(MIGRATION, /cron\.schedule|pg_cron|net\.http/i);
  assert.doesNotMatch(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"), /trend/i);
});

/* ──────────────────────────────────────────────────────────────
   Unauthorized access
   ────────────────────────────────────────────────────────────── */

test("RLS is on with zero policies on every trend table", async () => {
  const rows = await all(
    `select c.relname, c.relrowsecurity,
            (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1)`,
    [TABLES],
  );
  assert.equal(rows.length, TABLES.length);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, row.relname);
    assert.equal(row.policies, 0, row.relname);
  }
});

test("anon and authenticated have no privilege on any table or function, despite Supabase defaults", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const table of TABLES) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const [{ allowed }] = await all("select has_table_privilege($1, $2, $3) as allowed", [role, `public.${table}`, privilege]);
        assert.equal(allowed, false, `${role} ${privilege} ${table}`);
      }
      await rejects(asRole(role, (tx) => tx.query(`select * from public.${table}`)), /permission denied/);
    }
    await rejects(asRole(role, (tx) => tx.query("select public.trend_purge_expired(10)")), /permission denied/);
    await rejects(asRole(role, async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true)");
      return tx.query("select count(*) from public.trend_observations");
    }), /permission denied/);
    await rejects(store(observation({ provider_item_id: "anonanonan1" }), { role }), /permission denied/);
  }
});

test("service_role has only the minimum privileges", async () => {
  const grants = {};
  for (const table of TABLES) {
    grants[table] = [];
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      const [{ allowed }] = await all("select has_table_privilege('service_role', $1, $2) as allowed", [`public.${table}`, privilege]);
      if (allowed) grants[table].push(privilege);
    }
  }
  assert.deepEqual(grants, {
    trend_sources: ["SELECT"],
    trend_metric_definitions: ["SELECT"],
    trend_source_authorizations: ["SELECT"],
    trend_source_coverage: ["SELECT"],
    trend_observations: ["SELECT", "INSERT"],
    trend_observation_metrics: ["SELECT", "INSERT"],
    trend_evidence: ["SELECT", "INSERT"],
  });
  // The app can never approve a source or mark coverage verified.
  await rejects(asRole("service_role", (tx) => tx.query(
    "insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence) values ('youtube_data_api', 'youtube', 'SG', 'verified', now(), 'x')",
  )), /permission denied/);
  await rejects(asRole("service_role", (tx) => tx.query(
    "update public.trend_source_authorizations set status = 'approved' where source_id = 'google_trends_api'",
  )), /permission denied/);
  await rejects(asRole("service_role", (tx) => tx.query("delete from public.trend_observations")), /permission denied/);
  for (const fn of ["trend_guard_observation_insert", "trend_guard_metric_insert", "trend_guard_evidence_insert", "trend_guard_immutable", "trend_check_observation_complete"]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const [{ allowed }] = await all("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, `public.${fn}()`]);
      assert.equal(allowed, false, `${role} ${fn}`);
    }
  }
  const [{ allowed }] = await all("select has_function_privilege('service_role', 'public.trend_purge_expired(integer)', 'EXECUTE') as allowed");
  assert.equal(allowed, true);
});

/* ──────────────────────────────────────────────────────────────
   Source authorization and coverage
   ────────────────────────────────────────────────────────────── */

async function setAuthorization(sourceId, status) {
  const { db } = await setup();
  await db.query("delete from public.trend_source_authorizations where source_id = $1", [sourceId]);
  if (status) {
    await db.query(
      "insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ($1, $2, now(), 'test owner', 'test fixture')",
      [sourceId, status],
    );
  }
}

test("observations are stored only for an explicitly approved source", async () => {
  const row = () => observation({ source_id: "google_trends_api", subject_text: "eid gifts", subject_normalized: "eid gifts" });
  try {
    for (const status of [null, "under_review", "not_approved"]) {
      await setAuthorization("google_trends_api", status);
      await rejects(store(row()), /trend_source_not_authorized/);
    }
    await setAuthorization("google_trends_api", "approved");
    await store(row());
  } finally {
    await setAuthorization("google_trends_api", "approved");
  }
});

test("authorization records must say when, by whom and where", async () => {
  const { db } = await setup();
  await rejects(db.query("insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by) values ('google_trends_web', 'approved', now(), 'x')"), /check constraint|duplicate key/);
  await db.query("delete from public.trend_source_authorizations where source_id = 'manual_research'");
  try {
    await rejects(db.query("insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('manual_research', 'approved', now(), 'x', null)"), /check constraint/);
    await rejects(db.query("insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('manual_research', 'not_approved', null, 'x', 'r')"), /check constraint/);
    await rejects(db.query("insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('manual_research', 'approved', now(), '   ', 'r')"), /check constraint/);
    await rejects(db.query("insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('tiktok_research', 'approved', now(), 'x', 'r')"), /foreign key/);
    await rejects(db.query("insert into public.trend_source_coverage (source_id, platform, country, status) values ('manual_research', 'instagram', 'AE', 'verified')"), /check constraint/);
    await db.query("insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values ('manual_research', 'under_review', null, null, null)");
  } finally {
    await setAuthorization("manual_research", "approved");
  }
});

test("approved sources still need verified coverage for the exact platform and country", async () => {
  await rejects(store(observation({ country: "SG", provider_item_id: "cccccccccc3" })), /trend_coverage_not_verified/, "no coverage row");
  await rejects(store(observation({ country: "CN", provider_item_id: "cccccccccc3" })), /trend_coverage_not_verified/, "unavailable");
  await rejects(store(observation({ source_id: "manual_research", platform: "instagram", subject_kind: "hashtag", provider_item_id: null, subject_text: "#eid", subject_normalized: "eid" })), /trend_coverage_not_verified/, "other platform");
});

test("source capabilities are enforced: platform, subject kind and language scope", async () => {
  await rejects(store(observation({ platform: "tiktok", provider_item_id: "123456" })), /trend_platform_not_supported_by_source/);
  await rejects(store(observation({ source_id: "google_trends_web", subject_kind: "hashtag" })), /trend_subject_kind_not_supported_by_source/);
  await rejects(store(observation({ language: "en", provider_item_id: "dddddddddd4" })), /trend_language_must_be_undetermined/);
  await rejects(store(observation({ source_id: "nope" })), /foreign key|trend_unknown_source|Cannot read/);
});

/* ──────────────────────────────────────────────────────────────
   Identity, duplicates and market separation
   ────────────────────────────────────────────────────────────── */

test("the database computes item, topic and trend identity; callers cannot supply it", async () => {
  const stored = await store(observation({ provider_item_id: "eeeeeeeeee5" }));
  assert.equal(stored.item_key, "item|youtube|video|eeeeeeeeee5");
  assert.equal(stored.topic_key, "topic|youtube|AE|und|video|eid outfit ideas");
  assert.equal(stored.trend_key, "item|youtube|AE|und|video|eeeeeeeeee5");
  await rejects(store(observation({ provider_item_id: "eeeeeeeeee6", trend_key: "forged" })), /generated column|cannot insert/i);
  const topic = await store(observation({ source_id: "google_trends_web", subject_text: "Eid Gifts", subject_normalized: "eid gifts" }));
  assert.equal(topic.item_key, null);
  assert.equal(topic.trend_key, topic.topic_key);
});

test("duplicate observation identities are rejected", async () => {
  const row = observation({ provider_item_id: "fffffffff01" });
  await store(row);
  await rejects(store(row), /trend_observations_identity_key/);
  // A retitled copy of the same video, same source and window, is still a duplicate.
  await rejects(store({ ...row, subject_text: "EID OUTFITS!!", subject_normalized: "eid outfits!!" }), /trend_observations_identity_key/);
  // The same video in another window, or from another source, is a new observation.
  const later = Date.parse(row.retrieved_at) + 1000;
  await store({ ...row, window_start: iso(later), window_end: iso(later), retrieved_at: iso(later) });
  await store({ ...row, source_id: "manual_research" });
  assert.equal(await count("trend_observations", "item_key = $1", ["item|youtube|video|fffffffff01"]), 3);
});

test("different videos with identical titles are separate trends", async () => {
  const a = await store(observation({ provider_item_id: VID_A }));
  const b = await store(observation({ provider_item_id: VID_B, window_start: a.window_start, window_end: a.window_end, retrieved_at: a.retrieved_at }));
  assert.equal(a.topic_key, b.topic_key);
  assert.notEqual(a.trend_key, b.trend_key);
});

test("the same id on different platforms is never the same item", async () => {
  const sharedId = "12345678901";
  const yt = await store(observation({ source_id: "manual_research", provider_item_id: sharedId }));
  const tt = await store(observation({ source_id: "manual_research", platform: "tiktok", provider_item_id: sharedId, window_start: yt.window_start, window_end: yt.window_end, retrieved_at: yt.retrieved_at }));
  assert.notEqual(yt.item_key, tt.item_key);
  assert.notEqual(yt.trend_key, tt.trend_key);
});

test("countries and languages stay separate, even for the same item", async () => {
  const base = observation({ provider_item_id: "ggggggggg01" });
  const ae = await store(base);
  const inn = await store({ ...base, country: "IN" });
  assert.equal(ae.item_key, inn.item_key);
  assert.notEqual(ae.trend_key, inn.trend_key);
  const sound = { source_id: "manual_research", platform: "tiktok", subject_kind: "sound", provider_item_id: "7001", subject_text: "Original sound", subject_normalized: "original sound" };
  const keys = [];
  for (const language of ["en", "ar", "und"]) {
    keys.push((await store(observation({ ...sound, language, window_start: base.window_start, window_end: base.window_end, retrieved_at: base.retrieved_at }))).trend_key);
  }
  assert.equal(new Set(keys).size, 3);
});

test("provider item id rules follow the subject kind and the platform", async () => {
  await rejects(store(observation({ provider_item_id: null })), /trend_observations_item_by_kind/);
  await rejects(store(observation({ source_id: "google_trends_web", provider_item_id: "abc" })), /trend_observations_item_by_kind/);
  await rejects(store(observation({ provider_item_id: "short" })), /trend_observations_item_by_platform/);
  await rejects(store(observation({ source_id: "manual_research", platform: "tiktok", provider_item_id: "12ab" })), /trend_observations_item_by_platform/);
  await rejects(store(observation({ source_id: "manual_research", platform: "google_search", subject_kind: "sound", provider_item_id: "abc" })), /trend_observations_item_by_platform/);
});

/* ──────────────────────────────────────────────────────────────
   Immutability and completeness
   ────────────────────────────────────────────────────────────── */

test("observations, metrics and evidence are immutable, even for the owner", async () => {
  const { db } = await setup();
  const obs = await store(observation({ provider_item_id: "hhhhhhhhh01" }));
  await rejects(db.query("update public.trend_observations set subject_text = 'changed' where id = $1", [obs.id]), /trend_rows_are_immutable/);
  await rejects(db.query("update public.trend_observation_metrics set value = 0 where observation_id = $1", [obs.id]), /trend_rows_are_immutable/);
  await rejects(db.query("update public.trend_evidence set url = null where observation_id = $1", [obs.id]), /trend_rows_are_immutable/);
  await rejects(asRole("service_role", (tx) => tx.query("update public.trend_observations set country = 'IN' where id = $1", [obs.id])), /permission denied/);
});

test("metrics and evidence cannot be added to an observation after it was committed", async () => {
  const obs = await store(observation({ provider_item_id: "hhhhhhhhh02" }));
  await rejects(asRole("service_role", (tx) => insertRows(tx, "trend_observation_metrics", {
    observation_id: obs.id, metric_key: "like_count", status: "measured", value: 10, unit: "count", definition_version: "youtube_data_api.like_count.v1",
  })), /trend_observation_is_sealed/);
  await rejects(asRole("service_role", (tx) => insertRows(tx, "trend_evidence", {
    observation_id: obs.id, source_id: "youtube_data_api", attribution: "late", url: null, retrieved_at: obs.retrieved_at,
  })), /trend_observation_is_sealed/);
});

test("an observation without evidence or a required metric is never committed", async () => {
  const before = await count("trend_observations");
  await rejects(store(observation({ provider_item_id: "iiiiiiiii01" }), { evidence: [] }), /trend_observation_missing_evidence/);
  await rejects(store(observation({ provider_item_id: "iiiiiiiii02" }), { metrics: [DEFAULT_METRICS.youtube_data_api[0]] }), /trend_observation_missing_required_metric/);
  // A required metric reported as unavailable is complete and honest.
  await store(observation({ provider_item_id: "iiiiiiiii03" }), {
    metrics: [
      DEFAULT_METRICS.youtube_data_api[0],
      { metric_key: "view_count", status: "unavailable", unit: "count", unavailable_reason: "hidden_by_owner" },
    ],
  });
  assert.equal(await count("trend_observations"), before + 1);
});

test("evidence must come from the observation's own source and carry a URL where the source requires one", async () => {
  await rejects(store(observation({ provider_item_id: "jjjjjjjjj01" }), { evidence: [{ source_id: "manual_research", url: null }] }), /trend_evidence_source_mismatch/);
  await rejects(store(observation({ source_id: "manual_research", provider_item_id: "jjjjjjjjj02" }), { evidence: [{ url: null }] }), /trend_evidence_url_required/);
  await rejects(store(observation({ provider_item_id: "jjjjjjjjj03" }), { evidence: [{ url: "http://example.com/x" }] }), /check constraint/);
  await rejects(store(observation({ provider_item_id: "jjjjjjjjj04" }), { evidence: [{ url: "https://user:pw@example.com/x" }] }), /check constraint/);
  await rejects(store(observation({ provider_item_id: "jjjjjjjjj05" }), { evidence: [{ attribution: "   " }] }), /check constraint/);
  await store(observation({ provider_item_id: "jjjjjjjjj06" }), { evidence: [{ url: null }] });
});

/* ──────────────────────────────────────────────────────────────
   Metric validation
   ────────────────────────────────────────────────────────────── */

const yt = (id, metric) => store(observation({ provider_item_id: id }), { metrics: [DEFAULT_METRICS.youtube_data_api[0], metric] });
const view = (extra) => ({ metric_key: "view_count", status: "measured", value: 100, unit: "count", definition_version: "youtube_data_api.view_count.v2", ...extra });

test("an unavailable metric can never become a number", async () => {
  await rejects(yt("kkkkkkkkk01", { metric_key: "view_count", status: "unavailable", value: 0, unit: "count", unavailable_reason: "not_collected" }), /trend_metrics_status_shape/);
  await rejects(yt("kkkkkkkkk02", { metric_key: "view_count", status: "unavailable", unit: "count", definition_version: "youtube_data_api.view_count.v2", unavailable_reason: "not_collected" }), /trend_metrics_status_shape/);
  await rejects(yt("kkkkkkkkk03", { metric_key: "view_count", status: "unavailable", unit: "count" }), /trend_metrics_status_shape/);
  await rejects(yt("kkkkkkkkk04", view({ value: null })), /trend_metrics_status_shape/);
  await rejects(yt("kkkkkkkkk05", view({ value: "NaN" })), /trend_metrics_value_finite/);
  const obs = await yt("kkkkkkkkk06", { metric_key: "view_count", status: "unavailable", unit: "count", unavailable_reason: "below_reporting_threshold" });
  const [metric] = await all("select value, definition_version from public.trend_observation_metrics where observation_id = $1 and metric_key = 'view_count'", [obs.id]);
  assert.deepEqual(metric, { value: null, definition_version: null });
});

test("measured metrics need a definition version that exists and was in force at retrieval", async () => {
  await rejects(yt("lllllllll01", view({ definition_version: null })), /trend_unknown_metric_definition|trend_metrics_status_shape/);
  await rejects(yt("lllllllll02", view({ definition_version: "youtube_data_api.view_count.v3" })), /trend_unknown_metric_definition/);
  await rejects(yt("lllllllll03", view({ definition_version: "youtube_data_api.like_count.v1" })), /trend_unknown_metric_definition/);
  await rejects(yt("lllllllll04", view({ definition_version: "youtube_data_api.view_count.v1" })), /trend_metric_definition_not_in_effect/, "pre-2026-08-24 definition for current data");
});

test("metrics must belong to the source, use its unit and respect its bounds", async () => {
  await rejects(yt("mmmmmmmmm01", { metric_key: "favorite_count", status: "measured", value: 0, unit: "count", definition_version: "x.y.z" }), /trend_unknown_metric/);
  await rejects(yt("mmmmmmmmm02", view({ unit: "relative_index" })), /trend_metric_unit_mismatch/);
  await rejects(yt("mmmmmmmmm03", view({ value: -1 })), /trend_metric_out_of_range/);
  await rejects(yt("mmmmmmmmm04", view({ value: 10.5 })), /trend_metric_not_integer/);
  await rejects(store(observation({ provider_item_id: "mmmmmmmmm05" }), { metrics: [{ ...DEFAULT_METRICS.youtube_data_api[0], value: 0 }, view()] }), /trend_metric_out_of_range/, "rank starts at 1");
  await yt("mmmmmmmmm06", view({ value: "18446744073709551615" })); // YouTube unsigned long, exact

  const gt = (source, metric, n) => store(observation({ source_id: source, subject_text: `q${n}`, subject_normalized: `q${n}` }), { metrics: [metric] });
  const webIndex = (value) => ({ metric_key: "interest_index", status: "measured", value, unit: "relative_index", definition_version: "google_trends_web.interest_index.v1" });
  const apiScale = (value) => ({ metric_key: "scaled_interest", status: "measured", value, unit: "scaled_interest", definition_version: "google_trends_api.scaled_interest.alpha" });
  await rejects(gt("google_trends_web", webIndex(101), 1), /trend_metric_out_of_range/);
  await rejects(gt("google_trends_web", webIndex(50.5), 2), /trend_metric_not_integer/);
  await rejects(gt("google_trends_api", webIndex(50), 3), /trend_unknown_metric/, "website index is not an API metric");
  await rejects(gt("google_trends_web", apiScale(50), 4), /trend_unknown_metric/, "API scale is not a website metric");
  await gt("google_trends_api", apiScale(1234.5), 5);
});

/* ──────────────────────────────────────────────────────────────
   Retention
   ────────────────────────────────────────────────────────────── */

test("YouTube rows must be deleted within 30 days of retrieval; other sources within their cap", async () => {
  const at = Date.now() - HOUR;
  const ytRow = (days, id) => observation({ provider_item_id: id, retrievedMs: at, delete_after: iso(at + days * DAY) });
  await rejects(store(ytRow(31, "nnnnnnnnn01")), /trend_retention_exceeds_source_limit/);
  await rejects(store(observation({ provider_item_id: "nnnnnnnnn02", retrievedMs: at, delete_after: iso(at + 30 * DAY + 1000) })), /trend_retention_exceeds_source_limit/);
  await store(ytRow(30, "nnnnnnnnn03"));
  const web = (days, n) => observation({ source_id: "google_trends_web", subject_text: `r${n}`, subject_normalized: `r${n}`, retrievedMs: at, delete_after: iso(at + days * DAY) });
  await rejects(store(web(366, 1)), /trend_retention_exceeds_source_limit/);
  await store(web(365, 2));
});

test("every row has a future deletion deadline and a plausible retrieval time", async () => {
  const at = Date.now() - 2 * DAY;
  await rejects(store(observation({ provider_item_id: "ooooooooo01", retrievedMs: at, delete_after: iso(at - 1) })), /trend_retention_deadline_passed|trend_observations_delete_after_retrieval/);
  await rejects(store(observation({ provider_item_id: "ooooooooo02", retrievedMs: at, delete_after: iso(at + DAY) })), /trend_retention_deadline_passed/);
  await rejects(store(observation({ provider_item_id: "ooooooooo03", retrievedMs: Date.now() + HOUR })), /trend_retrieved_in_future/);
  await rejects(store(observation({ provider_item_id: "ooooooooo04", delete_after: null })), /not-null|null value/);
  const row = observation({ provider_item_id: "ooooooooo05" });
  await rejects(store({ ...row, window_start: iso(Date.parse(row.window_end) + 1) }), /trend_observations_window_order/);
  await rejects(store({ ...row, fresh_until: iso(Date.parse(row.stale_after) + 1) }), /trend_observations_freshness_order/);
});

/* ──────────────────────────────────────────────────────────────
   Purge and cascade deletion
   ────────────────────────────────────────────────────────────── */

/** Seeds an observation whose deadline already passed (owner-only fixture path). */
async function seedOverdue(daysOverdue, n) {
  const { db } = await setup();
  const retrieved = Date.now() - 60 * DAY;
  const row = observation({
    source_id: "google_trends_web",
    subject_text: `purge ${n}`,
    subject_normalized: `purge ${n}`,
    retrievedMs: retrieved,
    delete_after: iso(Date.now() - daysOverdue * DAY),
  });
  await db.exec("alter table public.trend_observations disable trigger trend_observations_guard_insert");
  try {
    return await store(row, { role: null });
  } finally {
    await db.exec("alter table public.trend_observations enable trigger trend_observations_guard_insert");
  }
}

const purge = (limit, role = "service_role") =>
  asRole(role, async (tx) => (await tx.query("select public.trend_purge_expired($1) as n", [limit])).rows[0].n);

test("the purge is bounded, deletes overdue rows oldest-deadline first, and cascades", async () => {
  const notDue = await count("trend_observations");
  const overdue = [];
  for (let i = 0; i < 5; i += 1) overdue.push(await seedOverdue(10 - i, i)); // deadlines 10, 9, 8, 7, 6 days ago
  const ids = overdue.map((o) => o.id);
  assert.equal(await count("trend_observation_metrics", "observation_id = any($1)", [ids]), 5);
  assert.equal(await count("trend_evidence", "observation_id = any($1)", [ids]), 5);

  assert.equal(await purge(2), 2);
  const remaining = (await all("select id from public.trend_observations where id = any($1)", [ids])).map((r) => r.id).sort();
  assert.deepEqual(remaining, ids.slice(2).sort(), "the two oldest deadlines went first");
  assert.equal(await count("trend_observation_metrics", "observation_id = any($1)", [ids.slice(0, 2)]), 0, "metrics cascade");
  assert.equal(await count("trend_evidence", "observation_id = any($1)", [ids.slice(0, 2)]), 0, "evidence cascades");

  assert.equal(await purge(1000), 3);
  assert.equal(await purge(1000), 0);
  assert.equal(await count("trend_observations"), notDue, "rows not yet due are untouched");
  assert.equal(await count("trend_observation_metrics", "observation_id = any($1)", [ids]), 0);
  assert.equal(await count("trend_evidence", "observation_id = any($1)", [ids]), 0);
});

test("the purge refuses unbounded or invalid limits and is not callable by browser roles", async () => {
  for (const limit of [0, -1, 1001, null]) await rejects(purge(limit), /trend_invalid_purge_limit/);
  for (const role of ["anon", "authenticated"]) await rejects(purge(10, role), /permission denied/);
  const [{ definer, args }] = await all(
    "select p.prosecdef as definer, pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.proname = 'trend_purge_expired'",
  );
  assert.equal(definer, true);
  assert.equal(args, "p_limit integer", "no caller-supplied clock");
});
