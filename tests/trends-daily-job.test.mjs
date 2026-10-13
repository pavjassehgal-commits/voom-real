/**
 * Daily Trend Intelligence job + its cron route. Local PGlite (0055 -> 0057
 * + the 08 activation) and deterministic Wikidata fixtures; no network.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";
import { rpcClient, SUPABASE_DEFAULT_PRIVILEGES } from "./helpers/trend-db.mjs";

const { runDailyTrendJob } = await import("../lib/trends/daily-job.ts");

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const FIXTURE = { results: { bindings: [
  { event: { value: "http://www.wikidata.org/entity/Q115910679" }, label: { value: "2026 Abu Dhabi Grand Prix" },
    starts: { value: `${day(50)}T00:00:00Z|11` }, ends: { value: `${day(52)}T00:00:00Z|11` } },
] } };

async function db({ activate = true } = {}) {
  const { db: d } = await createSupabaseLite({ stopBefore: "0055" });
  await d.exec(SUPABASE_DEFAULT_PRIVILEGES);
  for (const f of ["0055_trend_intelligence.sql", "0056_trend_mara_workflow_context.sql", "0057_wikidata_event_source.sql"]) await d.exec(read(`../supabase/proposed/${f}`));
  if (activate) await d.exec(read("../docs/trend-intelligence/staging/08-wikidata-activation.sql"));
  return d;
}
function counter() {
  const state = { calls: 0 };
  state.fetch = async () => { state.calls += 1; return { ok: true, async json() { return FIXTURE; } }; };
  return state;
}

test("first daily run purges, collects once and reports healthy; a second run the same day makes no request", async () => {
  const d = await db();
  const net = counter();
  const first = await runDailyTrendJob({ client: rpcClient(d), now: new Date(), fetch: net.fetch, projectId: "local" });
  assert.equal(first.purge.status, "succeeded");
  assert.equal(first.collection.status, "completed");
  assert.equal(first.collection.storage.stored, 1);
  assert.equal(first.healthy, true);
  assert.equal(first.retention.breach, false);
  const second = await runDailyTrendJob({ client: rpcClient(d), now: new Date(), fetch: net.fetch, projectId: "local" });
  assert.equal(second.collection.status, "skipped_recently_collected");
  assert.equal(net.calls, 1, "rate limited to one Wikidata request per 20 hours");
  assert.equal(Number((await d.query("select count(*) n from public.trend_observations")).rows[0].n), 1);
  assert.equal(Number((await d.query("select count(*) n from public.trend_mara_contexts")).rows[0].n), 0, "never creates contexts");
});

test("without approval and coverage the job collects nothing and is reported unhealthy", async () => {
  const d = await db({ activate: false });
  const net = counter();
  const report = await runDailyTrendJob({ client: rpcClient(d), now: new Date(), fetch: net.fetch, projectId: "local" });
  assert.equal(report.collection.status, "refused_not_authorized");
  assert.equal(net.calls, 0);
  assert.equal(report.healthy, false);
});

test("a Wikidata failure is a safe code, stores nothing, and the job is unhealthy", async () => {
  const d = await db();
  const report = await runDailyTrendJob({ client: rpcClient(d), now: new Date(), fetch: async () => ({ ok: false, async json() { return {}; } }), projectId: "local" });
  assert.deepEqual([report.collection.status, report.collection.code, report.healthy], ["source_failed", "http_error", false]);
  assert.equal(Number((await d.query("select count(*) n from public.trend_observations")).rows[0].n), 0);
});

test("the cron route is disabled by default, requires CRON_SECRET, and fails closed without leaking errors", async () => {
  const { GET } = await import("../app/api/cron/trend-collection/route.ts");
  const saved = { ...process.env };
  const call = (auth) => GET(new Request("https://voom.example/api/cron/trend-collection", { headers: auth ? { authorization: auth } : {} }));
  try {
    delete process.env.TREND_COLLECTION_ENABLED;
    process.env.CRON_SECRET = "test-cron-secret";
    assert.equal((await call("Bearer test-cron-secret")).status, 503, "off unless explicitly enabled");
    process.env.TREND_COLLECTION_ENABLED = "true";
    assert.equal((await call()).status, 401);
    assert.equal((await call("Bearer wrong")).status, 401);
    delete process.env.CRON_SECRET;
    assert.equal((await call("Bearer test-cron-secret")).status, 503, "not configured");
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const failed = await call("Bearer test-cron-secret");
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "Trend collection could not complete safely." });
  } finally {
    for (const k of ["TREND_COLLECTION_ENABLED", "CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test("the route is scheduled exactly once a day by Vercel Cron, with room for its worst case, and nowhere else", () => {
  const vercel = JSON.parse(read("../vercel.json"));
  assert.deepEqual(vercel.crons.filter((c) => /trend/i.test(c.path)), [{ path: "/api/cron/trend-collection", schedule: "0 4 * * *" }]);
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/weekly-plans" && c.schedule === "0 3 * * *"), "weekly-plans schedule preserved");
  assert.doesNotMatch(read("../supabase/ops/schedule-workers.sql"), /trend/i, "no second (pg_cron) trigger");
  assert.match(read("../app/api/cron/trend-collection/route.ts"), /export const maxDuration = 300;/);
});
