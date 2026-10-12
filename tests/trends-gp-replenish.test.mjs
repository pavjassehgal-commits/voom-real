/**
 * First end-to-end MARA test with a collected event (2026 Abu Dhabi Grand
 * Prix): the proposed 09 setup, the production context loader, and MARA's
 * real generation validation with the deterministic AI fixture.
 * Local PGlite only; no network, staging or production access.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";
import { rpcClient, SUPABASE_DEFAULT_PRIVILEGES } from "./helpers/trend-db.mjs";
import { deterministicTrendProvider, GP_TOPIC, summarizeCaptured, TEST_OWNER_EMAIL } from "../scripts/trends/gp-trend-fixture.mjs";

const { runWikidataEventDiscovery } = await import("../lib/trends/discovery.ts");
const { loadOwnerTrendPromptContext } = await import("../lib/trends/workflow-context.ts");
const service = await import("../lib/voom/workflow/service.ts");
const timezone = await import("../lib/voom/timezone.ts");

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const SETUP = read("../docs/trend-intelligence/staging/09-gp-replenish-setup.sql");
const ACTIVATION = read("../docs/trend-intelligence/staging/08-wikidata-activation.sql");
const STAGING_OBSERVATION_ID = "5d32a918-4af0-455c-8ae4-0e19f0253aaa";

/** Staging-like local database with the real Grand Prix observation collected through the real path. */
async function setupDb() {
  const { db } = await createSupabaseLite({ stopBefore: "0055" });
  await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  for (const f of ["0055_trend_intelligence.sql", "0056_trend_mara_workflow_context.sql", "0057_wikidata_event_source.sql"]) await db.exec(read(`../supabase/proposed/${f}`));
  await db.exec(ACTIVATION);
  const gp = { results: { bindings: [{ event: { value: "http://www.wikidata.org/entity/Q115910679" }, label: { value: GP_TOPIC },
    starts: { value: "2026-12-04T00:00:00Z|11" }, ends: { value: "2026-12-06T00:00:00Z|11" } }] } };
  const run = await runWikidataEventDiscovery({ client: rpcClient(db), now: new Date(), fetch: async () => ({ ok: true, async json() { return gp; } }) });
  assert.equal(run.storage.counts.stored, 1);
  const localId = run.storage.results[0].observationId;
  await db.query("insert into auth.users (id, email) values ('99999999-9999-4999-8999-999999999999', $1)", [TEST_OWNER_EMAIL]);
  // The proposed SQL names the staging observation id; locally the same observation has another id.
  return { db, sql: SETUP.replaceAll(STAGING_OBSERVATION_ID, localId) };
}

/** The production loader's client shape, backed by the local database (rows as PostgREST JSON). */
function workflowClient(db) {
  const rpc = rpcClient(db);
  return {
    rpc: rpc.rpc,
    from() {
      const filters = {};
      const query = {
        select() { return query; },
        eq(column, value) { filters[column] = value; return query; },
        gt(column, value) { filters[`${column}>`] = value; return query; },
        order() { return query; },
        limit() { return query; },
        async maybeSingle() {
          const { rows } = await db.query(
            `select to_jsonb(c) as row from public.trend_mara_contexts c
              where owner_user_id = $1 and status = $2 and valid_until > $3 order by valid_until limit 1`,
            [filters.owner_user_id, filters.status, filters["valid_until>"]]);
          return { data: rows[0]?.row ?? null, error: null };
        },
      };
      return query;
    },
  };
}

test("the 09 setup is editor-safe and creates exactly one reviewed, expiring context for the synthetic owner", async () => {
  assert.doesNotMatch(SETUP, /\$/);
  assert.ok([...SETUP].every((c) => c.charCodeAt(0) < 128), "ASCII only");
  const { db, sql } = await setupDb();
  await db.exec(sql);
  const { rows: [ctx] } = await db.query("select to_jsonb(c) as c from public.trend_mara_contexts c");
  assert.equal(ctx.c.topic, GP_TOPIC);
  assert.equal(ctx.c.status, "approved");
  assert.equal(ctx.c.reviewed_by, "owner:pavjassehgal-commits");
  assert.deepEqual([ctx.c.event_start, ctx.c.event_end], ["2026-12-04", "2026-12-06"]);
  assert.equal(new Date(ctx.c.valid_until).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(ctx.c.facts.length, 2);
  assert.ok(ctx.c.facts.every((f) => f.sources.length >= 2 && f.sources.every((s) => s.length <= 200) && f.statement.length <= 300));
  assert.ok(ctx.c.caveats.length <= 4 && ctx.c.caveats.every((c) => c.length <= 400));
  const { rows: [biz] } = await db.query("select automation_level, allow_automatic_paid_media, monthly_media_budget_usd::text as budget from public.businesses");
  assert.deepEqual(biz, { automation_level: "manual", allow_automatic_paid_media: false, budget: "0.00" });
  await assert.rejects(db.exec(sql), /09 refuses: the synthetic user already has a business/);
  await db.exec("rollback");
});

test("the production loader returns the context only while its observation is usable", async () => {
  const { db, sql } = await setupDb();
  await db.exec(sql);
  const owner = "99999999-9999-4999-8999-999999999999";
  const ctx = await loadOwnerTrendPromptContext(workflowClient(db), owner, new Date());
  assert.equal(ctx.topic, GP_TOPIC);
  assert.deepEqual(ctx.eventWindow, { start: "2026-12-04", end: "2026-12-06" });
  assert.equal(ctx.facts.length, 2);
  assert.equal(await loadOwnerTrendPromptContext(workflowClient(db), "11111111-1111-4111-8111-111111111111", new Date()), null, "other owners get nothing");
  // Invalidating the observation removes the context from MARA immediately.
  await db.query("select public.trend_invalidate_observation((select id from public.trend_observations limit 1), 'wrong_item', 'staff:test', 'T-1')");
  assert.equal(await loadOwnerTrendPromptContext(workflowClient(db), owner, new Date()), null);
});

test("the deterministic fixture passes MARA's real grounding and claim checks for every planned format", async () => {
  const { db, sql } = await setupDb();
  await db.exec(sql);
  const trendOpportunity = await loadOwnerTrendPromptContext(workflowClient(db), "99999999-9999-4999-8999-999999999999", new Date());
  const captured = [];
  const provider = deterministicTrendProvider(captured);
  const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const business = {
    brand_name: "Gulf Gloss Auto Detailing (TEST)",
    brand_description: "SYNTHETIC TEST BUSINESS. Premium hand car detailing, paint correction and ceramic coating in Abu Dhabi and Dubai.",
    industry: "Premium car detailing",
    target_customer: ["Car owners in Abu Dhabi and Dubai who care about how their car looks"],
  };
  for (const [channel, format, contentType] of [["instagram", "post", "post"], ["instagram", "reel", "reel"], ["tiktok", "video", "video"], ["youtube", "short", "short"], ["youtube", "video", "video"]]) {
    const content = await service.generateWorkflowPlannedContent({
      business, goal: "Get more detailing bookings in the weeks before December", cadence: "3x_week", timeZone: "Asia/Dubai",
      slot: { date, slotKey: `${date}|${channel}_${format}`, index: 0, channel, format, contentType, publishAt: timezone.localToUtcIso(date, 18 * 60, "Asia/Dubai") },
      plannedConcepts: [], performance: null, trendOpportunity, provider,
    });
    assert.match(`${content.concept} ${content.caption}`, /2026 Abu Dhabi Grand Prix/, `${channel}:${format}`);
  }
  const summary = summarizeCaptured(captured);
  assert.deepEqual([summary.requests, summary.allCarriedTrendSection, summary.topics], [5, true, [GP_TOPIC]]);
  // Without the reviewed context the fixture refuses: a run can't silently pass without the loader.
  await assert.rejects(provider.structured({ messages: [{ content: "" }, { content: JSON.stringify({ assignedSocialSlot: { channel: "instagram", format: "post" } }) }], parse: (v) => v }), /fixture_missing_trend_context/);
});

test("the staging Replenish command refuses without its flags or outside voom-staging", () => {
  const script = new URL("../scripts/trends/replenish-staging-test.mjs", import.meta.url).pathname;
  const run = (argv, env) => spawnSync(process.execPath, [script, ...argv], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 60_000 });
  assert.match(run([], {}).stderr, /REFUSED \(project_flag_missing\)/);
  assert.match(run(["--project=qcdpegwjofrqnfudyrqq"], {}).stderr, /REFUSED \(not_approved\)/);
  const prod = run(["--project=qcdpegwjofrqnfudyrqq", "--approved-staging-replenish"], { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEY: "not-a-real-key" });
  assert.equal(prod.status, 2);
  assert.match(prod.stderr, /REFUSED \(wrong_project\)/);
  assert.doesNotMatch(prod.stderr + prod.stdout, /not-a-real-key/);
});
