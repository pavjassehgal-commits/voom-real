/**
 * Wikidata activation records (docs/trend-intelligence/staging/08-wikidata-activation.sql)
 * validated against the real 0055 -> 0056 -> 0057 schema in local PGlite.
 * The Wikidata response is a fixture of the two rows the public Query Service
 * returned on 2026-10-12; no network, staging or production access.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";
import { rpcClient, sqlPort, SUPABASE_DEFAULT_PRIVILEGES } from "./helpers/trend-db.mjs";

const { runWikidataEventDiscovery } = await import("../lib/trends/discovery.ts");
const { loadTrendMarketPolicy, permittedSources } = await import("../lib/trends/policy-store.ts");
const { listUsableTrendObservationsRpc } = await import("../lib/trends/read-model.ts");

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const ACTIVATION = read("../docs/trend-intelligence/staging/08-wikidata-activation.sql");

/**
 * The two UAE events Wikidata held on 2026-10-12, in the connector's response
 * shape, with the statements observed that day (Q136192068 carries two
 * conflicting day-precision date ranges; Q115910679 one).
 */
const WDQS_2026_10_12 = { results: { bindings: [
  { event: { value: "http://www.wikidata.org/entity/Q136192068" }, label: { value: "2026 Judo Grand Slam Abu Dhabi" },
    starts: { value: "2026-10-16T00:00:00Z|11;2026-10-29T00:00:00Z|11" }, ends: { value: "2026-10-18T00:00:00Z|11;2026-10-31T00:00:00Z|11" } },
  { event: { value: "http://www.wikidata.org/entity/Q115910679" }, label: { value: "2026 Abu Dhabi Grand Prix" },
    starts: { value: "2026-12-04T00:00:00Z|11" }, ends: { value: "2026-12-06T00:00:00Z|11" } },
] } };
const fixtureFetch = async () => ({ ok: true, async json() { return WDQS_2026_10_12; } });

async function stagingLikeDb() {
  const { db } = await createSupabaseLite({ stopBefore: "0055" });
  await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  for (const file of ["0055_trend_intelligence.sql", "0056_trend_mara_workflow_context.sql", "0057_wikidata_event_source.sql"]) {
    await db.exec(read(`../supabase/proposed/${file}`));
  }
  return db;
}

test("the activation script is editor-safe and within the schema's text limits", () => {
  assert.doesNotMatch(ACTIVATION, /\$/, "no dollar quoting");
  assert.ok([...ACTIVATION].every((c) => c.charCodeAt(0) < 128), "ASCII only (no clipboard encoding risk)");
  assert.equal(ACTIVATION.split("\n").filter((l) => l === "begin;").length, 1);
  assert.equal(ACTIVATION.split("\n").filter((l) => l === "commit;").length, 1);
});

test("before activation the source stays disabled: collection stores nothing", async () => {
  const db = await stagingLikeDb();
  const run = await runWikidataEventDiscovery({ client: rpcClient(db), now: new Date(), fetch: fixtureFetch });
  assert.equal(run.status, "completed");
  assert.equal(run.discovered, 2);
  assert.deepEqual([run.storage.counts.stored, run.storage.counts.rejected], [0, 2]);
  assert.ok(run.storage.results.every((r) => r.code === "source_not_authorized"));
  assert.equal(Number((await db.query("select count(*) n from public.trend_observations")).rows[0].n), 0);
});

test("the proposed records satisfy the schema, the governance rules and the audit trail", async () => {
  const db = await stagingLikeDb();
  const results = await db.exec(ACTIVATION);
  const row = results.find((r) => r.rows?.[0]?.source_id).rows[0];
  assert.deepEqual([row.source_id, row.authorization, row.coverage, row.country, row.platform], ["wikidata_events", "approved", "verified", "AE", "web"]);
  assert.equal(new Date(row.checked_at).toISOString(), "2026-10-12T16:09:00.000Z");

  const auth = (await db.query("select decided_by, reference, length(reference) as len from public.trend_source_authorizations where source_id = 'wikidata_events'")).rows[0];
  assert.equal(auth.decided_by, "owner:pavjassehgal-commits");
  assert.ok(auth.len <= 1000, `reference length ${auth.len}`);
  assert.match(auth.reference, /CC0 1\.0/);
  assert.match(auth.reference, /Review by \d{4}-\d{2}-\d{2} \(database-enforced\)\./);
  const cov = (await db.query("select checked_by, evidence, length(evidence) as len from public.trend_source_coverage where source_id = 'wikidata_events'")).rows[0];
  assert.ok(cov.len <= 1000, `evidence length ${cov.len}`);
  assert.match(cov.evidence, /PARTIAL coverage only/);
  assert.match(cov.evidence, /does not represent all UAE events or any trend popularity/);

  // Existing policy loader: approved and verified, within review periods.
  const loaded = await loadTrendMarketPolicy(sqlPort(db), { now: Date.now() });
  assert.equal(loaded.complete, true);
  assert.deepEqual(loaded.issues, []);
  assert.deepEqual(permittedSources(loaded.policy, "web", "AE"), ["wikidata_events"]);

  // Both decisions are in the append-only audit trail with their actors.
  const audit = (await db.query("select event_type, actor from public.trend_audit_events where source_id = 'wikidata_events' order by seq")).rows;
  assert.deepEqual(audit, [
    { event_type: "authorization_recorded", actor: "owner:pavjassehgal-commits" },
    { event_type: "coverage_recorded", actor: "reviewer:claude-trend-research" },
  ]);
});

test("after activation the first collection stores and serves the two real event records", async () => {
  const db = await stagingLikeDb();
  await db.exec(ACTIVATION);
  const run = await runWikidataEventDiscovery({ client: rpcClient(db), now: new Date(), fetch: fixtureFetch });
  assert.deepEqual([run.storage.counts.stored, run.storage.counts.rejected], [2, 0]);
  const served = await listUsableTrendObservationsRpc(rpcClient(db), { platform: "web", country: "AE", language: "en" });
  assert.equal(served.status, "ok");
  assert.deepEqual(served.observations.map((o) => o.subject.text).sort(), ["2026 Abu Dhabi Grand Prix", "2026 Judo Grand Slam Abu Dhabi"]);
  assert.ok(served.observations.every((o) => o.evidence[0].attribution === "Wikidata (CC0)" && /^https:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(o.evidence[0].url)));
  assert.ok(served.observations.every((o) => Object.keys(o.metrics).length === 0), "no metrics");
  // Nothing reaches MARA without a separately reviewed context.
  assert.equal(Number((await db.query("select count(*) n from public.trend_mara_contexts")).rows[0].n), 0);
});

test("re-running the activation refuses and changes nothing", async () => {
  const db = await stagingLikeDb();
  await db.exec(ACTIVATION);
  await assert.rejects(db.exec(ACTIVATION), /08 refuses: a wikidata_events decision already exists/);
  await db.exec("rollback");
  assert.equal(Number((await db.query("select count(*) n from public.trend_audit_events where source_id = 'wikidata_events'")).rows[0].n), 2);
});
