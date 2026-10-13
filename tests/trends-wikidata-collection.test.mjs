/**
 * Wikidata event accuracy + the one-off staging collection runner.
 * Deterministic fixtures and a local PGlite database (0055 -> 0056 -> 0057);
 * no network, staging or production access.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";
import { rpcClient, SUPABASE_DEFAULT_PRIVILEGES } from "./helpers/trend-db.mjs";

const { discoverWikidataEvents } = await import("../lib/trends/connectors/wikidata-events.ts");
const { runStagingWikidataCollection } = await import("../lib/trends/collection-runner.ts");
const { verifyStagingTarget } = await import("../scripts/trends/staging-target.mjs");

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const ACTIVATION = read("../docs/trend-intelligence/staging/08-wikidata-activation.sql");
const NOW = new Date();
const inDays = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** One connector binding: claims are [YYYY-MM-DD, precision] pairs. */
const binding = (q, label, starts, ends) => ({
  event: { value: `http://www.wikidata.org/entity/${q}` },
  ...(label === undefined ? {} : { label: { value: label } }),
  starts: { value: starts.map(([d, p]) => `${d}T00:00:00Z|${p}`).join(";") },
  ...(ends ? { ends: { value: ends.map(([d, p]) => `${d}T00:00:00Z|${p}`).join(";") } } : {}),
});
const respond = (bindings) => async () => ({ ok: true, async json() { return { results: { bindings } }; } });
const discover = (bindings) => discoverWikidataEvents({ now: NOW, fetch: respond(bindings) });

const VALID = binding("Q100", "Abu Dhabi Test Festival", [[inDays(20), 11]], [[inDays(22), 11]]);

/* ── Accuracy ─────────────────────────────────────────────────────── */

test("a day-precise event with an English label is accepted with its dates attributed to Wikidata", async () => {
  const result = await discover([VALID]);
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.dateStatus, "recorded");
  assert.deepEqual(event.dateIssues, []);
  assert.deepEqual(event.eventWindow, { start: inDays(20), end: inDays(22) });
  assert.match(event.facts[0].statement, /according to its Wikidata event record\.$/);
  assert.equal(event.observation.evidence[0].attribution, "Wikidata (CC0)");
  assert.deepEqual(event.observation.metrics, {}, "no popularity metric");
});

test("dates without day precision are rejected", async () => {
  const result = await discover([
    binding("Q201", "2027 Abu Dhabi Masters", [[inDays(80), 9]], [[inDays(80), 9]]),   // year precision
    binding("Q202", "Month Only Expo", [[inDays(40), 10]], [[inDays(45), 10]]),          // month precision
  ]);
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.rejectedReasons, { no_day_precision_start: 2 });
});

test("records without a meaningful English label are rejected", async () => {
  const result = await discover([
    binding("Q301", undefined, [[inDays(10), 11]], [[inDays(11), 11]]),
    binding("Q302", "Q302", [[inDays(10), 11]], [[inDays(11), 11]]),
    binding("Q303", "12", [[inDays(10), 11]], [[inDays(11), 11]]),
    binding("Q304", "  ", [[inDays(10), 11]], [[inDays(11), 11]]),
  ]);
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.rejectedReasons, { missing_english_label: 4 });
});

test("conflicting, partly imprecise or incomplete dates are flagged and never presented as confirmed", async () => {
  const result = await discover([
    binding("Q401", "2026 Judo Grand Slam Abu Dhabi", [[inDays(4), 11], [inDays(17), 11]], [[inDays(6), 11], [inDays(19), 11]]),
    binding("Q402", "Mixed Precision Show", [[inDays(30), 11], [inDays(30), 10]], [[inDays(31), 11]]),
    binding("Q403", "Open Ended Fair", [[inDays(12), 11]]),
  ]);
  assert.equal(result.events.length, 3, "kept as review candidates");
  const byLabel = Object.fromEntries(result.events.map((e) => [e.observation.subject.text, e]));
  assert.deepEqual(byLabel["2026 Judo Grand Slam Abu Dhabi"].dateIssues, ["conflicting_start_dates", "conflicting_end_dates"]);
  assert.deepEqual(byLabel["Mixed Precision Show"].dateIssues, ["imprecise_date_claim"]);
  assert.deepEqual(byLabel["Open Ended Fair"].dateIssues, ["end_date_missing"]);
  for (const event of result.events) {
    assert.equal(event.dateStatus, "needs_verification");
    assert.equal(event.eventWindow, null, "no dates offered as a window");
    assert.match(event.facts[0].statement, /dates are uncertain .* must be verified by a person/);
    assert.doesNotMatch(event.facts[0].statement, /\d{4}-\d{2}-\d{2}/, "no date stated as fact");
  }
  assert.deepEqual(byLabel["2026 Judo Grand Slam Abu Dhabi"].dateClaims, { starts: [inDays(4), inDays(17)], ends: [inDays(6), inDays(19)] }, "claims kept for the reviewer");
});

test("ended events, duplicates and overflow beyond 25 records are not used", async () => {
  const ended = binding("Q501", "Last Month Gala", [[inDays(-30), 11]], [[inDays(-28), 11]]);
  const many = Array.from({ length: 28 }, (_, i) => binding(`Q6${String(i).padStart(2, "0")}`, `Event number ${i}`, [[inDays(10 + i), 11]], [[inDays(11 + i), 11]]));
  const result = await discover([VALID, VALID, ended, ...many]);
  assert.equal(result.events.length, 23, "first 25 processed: 25 - duplicate - ended");
  assert.deepEqual(result.rejectedReasons, { over_limit: 6, duplicate_entity: 1, event_ended: 1 });
});

/* ── Runner ───────────────────────────────────────────────────────── */

async function stagingLikeDb() {
  const { db } = await createSupabaseLite({ stopBefore: "0055" });
  await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  for (const file of ["0055_trend_intelligence.sql", "0056_trend_mara_workflow_context.sql", "0057_wikidata_event_source.sql"]) {
    await db.exec(read(`../supabase/proposed/${file}`));
  }
  return db;
}
const count = async (db, sql) => Number((await db.query(sql)).rows[0].n);
const FIXTURE = [VALID, binding("Q401", "2026 Judo Grand Slam Abu Dhabi", [[inDays(4), 11], [inDays(17), 11]], [[inDays(6), 11], [inDays(19), 11]])];

test("only the voom-staging project with a service key is accepted", () => {
  const url = "https://qcdpegwjofrqnfudyrqq.supabase.co";
  assert.deepEqual(verifyStagingTarget({ NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: "x" }), { ok: true, projectId: "qcdpegwjofrqnfudyrqq" });
  assert.equal(verifyStagingTarget({ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEY: "x" }).code, "wrong_project");
  assert.equal(verifyStagingTarget({ NEXT_PUBLIC_SUPABASE_URL: "http://qcdpegwjofrqnfudyrqq.supabase.co", SUPABASE_SECRET_KEY: "x" }).code, "wrong_project");
  assert.equal(verifyStagingTarget({ NEXT_PUBLIC_SUPABASE_URL: "https://qcdpegwjofrqnfudyrqq.supabase.co.evil.com", SUPABASE_SECRET_KEY: "x" }).code, "wrong_project");
  assert.equal(verifyStagingTarget({ NEXT_PUBLIC_SUPABASE_URL: url }).code, "missing_service_key");
  assert.equal(verifyStagingTarget({}).code, "missing_supabase_url");
});

test("without approval and coverage the runner refuses before any Wikidata request", async () => {
  const db = await stagingLikeDb();
  let calls = 0;
  const report = await runStagingWikidataCollection({ client: rpcClient(db), now: NOW, fetch: async () => { calls += 1; return { ok: true, async json() { return {}; } }; } });
  assert.equal(report.status, "refused_not_authorized");
  assert.equal(calls, 0);
  assert.equal(report.wikidataRequests, 0);
  assert.equal(await count(db, "select count(*) n from public.trend_observations"), 0);
});

test("after the 08 activation: one request, governed storage, flagged candidates, no approvals or contexts; a rerun deduplicates", async () => {
  const db = await stagingLikeDb();
  await db.exec(ACTIVATION);
  let calls = 0;
  const fetch = async (...args) => { calls += 1; return respond(FIXTURE)(...args); };
  const first = await runStagingWikidataCollection({ client: rpcClient(db), now: NOW, fetch });
  assert.equal(first.status, "completed");
  assert.equal(calls, 1);
  assert.deepEqual(first.storage, { stored: 2, duplicate: 0, conflict: 0, invalidated: 0, rejected: 0 });
  assert.deepEqual(first.candidates.map((c) => [c.label, c.dateStatus, c.reviewStatus]), [
    ["Abu Dhabi Test Festival", "recorded", "pending_human_review"],
    ["2026 Judo Grand Slam Abu Dhabi", "needs_verification", "pending_human_review"],
  ]);
  assert.equal(first.candidates[1].eventWindow, null);
  assert.deepEqual([first.approvalsCreated, first.contextsCreated], [0, 0]);
  assert.doesNotMatch(JSON.stringify(first), /SECRET|service_role|eyJ|password/i, "no credentials in the report");

  const second = await runStagingWikidataCollection({ client: rpcClient(db), now: NOW, fetch });
  assert.deepEqual(second.storage, { stored: 0, duplicate: 2, conflict: 0, invalidated: 0, rejected: 0 });
  assert.equal(await count(db, "select count(*) n from public.trend_observations"), 2, "no duplicate rows");
  // Nothing approved or promoted: only the 08 owner decision exists, no contexts, no invalidations.
  assert.equal(await count(db, "select count(*) n from public.trend_source_authorizations"), 1);
  assert.equal(await count(db, "select count(*) n from public.trend_mara_contexts"), 0);
  assert.equal(await count(db, "select count(*) n from public.trend_observation_invalidations"), 0);
});

test("a Wikidata failure stores nothing and reports a safe code", async () => {
  const db = await stagingLikeDb();
  await db.exec(ACTIVATION);
  const report = await runStagingWikidataCollection({ client: rpcClient(db), now: NOW, fetch: async () => ({ ok: false, async json() { return {}; } }) });
  assert.deepEqual([report.status, report.code, report.wikidataRequests], ["source_failed", "http_error", 1]);
  assert.equal(await count(db, "select count(*) n from public.trend_observations"), 0);
});

/* ── The command refuses unsafe invocations before any network use ── */

test("the command refuses without its flags, or when the environment is not voom-staging", () => {
  const script = new URL("../scripts/trends/collect-wikidata-staging.mjs", import.meta.url).pathname;
  const run = (args, env) => spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 60_000,
  });
  const flags = ["--project=qcdpegwjofrqnfudyrqq", "--approved-live-run"];
  const noFlags = run([], {});
  assert.equal(noFlags.status, 2);
  assert.match(noFlags.stderr, /REFUSED \(project_flag_missing\)/);
  const noApproval = run(["--project=qcdpegwjofrqnfudyrqq"], {});
  assert.match(noApproval.stderr, /REFUSED \(not_approved\)/);
  const production = run(flags, { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEY: "not-a-real-key" });
  assert.equal(production.status, 2);
  assert.match(production.stderr, /REFUSED \(wrong_project\)/);
  assert.doesNotMatch(production.stderr + production.stdout, /not-a-real-key/, "never echoes the key");
});
