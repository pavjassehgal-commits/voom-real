/**
 * Trend Intelligence — first working demonstration (end to end) and the
 * MARA integration's safety properties.
 *
 * Real, manually supplied evidence (two dated news reports, linked) →
 * validation → real store RPC → real read RPC → confidence → MARA's
 * evidence-backed recommendation for a SYNTHETIC merchant → MARA's content
 * planner with the flag-gated trend block. Local PGlite only; no model,
 * network, credential or remote database. The model reply is simulated and
 * labelled.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_MERCHANT, DEMO_MERCHANT, runDemo } from "./helpers/trend-demo.mjs";

const { parseTrendObservation } = await import("../lib/trends/schema.ts");
const { trendKey } = await import("../lib/trends/dedupe.ts");
const { createMarketPolicy } = await import("../lib/trends/confidence.ts");
const { recommendTrendOpportunity } = await import("../lib/trends/opportunity.ts");
const prompt = await import("../lib/voom/workflow/prompt.ts");
const { trendContextEnabled } = await import("../lib/voom/workflow/trend-flag.ts");
const { readFileSync } = await import("node:fs");

const evidence = JSON.parse(readFileSync(new URL("../docs/trend-intelligence/demo/evidence-dubai-fitness-challenge-2026.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-10-11T18:00:00Z");

let trace;
test("end to end: real evidence becomes a stored, readable, cited recommendation for the test business", async () => {
  trace = await runDemo();
  assert.deepEqual(trace.validation, { ok: true });
  assert.equal(trace.stored.status, "stored");
  assert.equal(trace.replay.status, "duplicate", "replays never duplicate data");
  assert.deepEqual(trace.read, { status: "ok", count: 1, permittedSourceIds: ["manual_research"] });
  assert.deepEqual(trace.stored_row.metrics, {}, "manual research carries no numbers");

  const r = trace.recommendation;
  assert.equal(r.status, "recommended");
  assert.equal(r.topic, "Dubai Fitness Challenge 2026");
  assert.deepEqual(r.timing, { startPostingOn: "2026-10-24", eventStart: "2026-10-31", eventEnd: "2026-11-29", evidenceUsableUntil: "2026-10-31T17:55:00.000Z" });
  assert.deepEqual(r.citations.map((c) => new URL(c.url).hostname).sort(), ["gulfnews.com", "www.khaleejtimes.com"]);
  assert.equal(r.observedAt, "2026-10-01T17:55:00.000Z", "source date travels with it");
  assert.equal(r.confidence.level, "low", "qualitative, single source type, aging: honestly low");
  assert.deepEqual(r.relevance.matchedOn, ["healthy cafe", "smoothie"]);
  assert.equal(r.approvalRequired, true);
  // Every fact in the recommendation is the reviewer's linked fact, verbatim.
  assert.deepEqual(r.facts.map((f) => f.statement), evidence.note.facts.map((f) => f.statement));
  // No number appears in the generated text except dates and the reported theme.
  const generated = [r.headline, r.suggestedAction, ...r.contentIdeas].join(" ");
  assert.doesNotMatch(generated.replace(/\b(19|20)\d{2}\b|\b\d{1,2} (October|November)\b|\b2026\b/g, ""), /\d/, generated);

  assert.deepEqual(trace.control, { status: "no_recommendation", reason: "no_relevant_trend", rejectedNotes: [] }, "unrelated business gets nothing");
});

test("MARA: flag off by default; with evidence, the real prompt and payload carry only the verified facts", async () => {
  trace ??= await runDemo();
  assert.deepEqual(trace.flag, { defaultEnabled: false, demoEnabled: true });
  assert.equal(trendContextEnabled({ VOOM_TREND_CONTEXT_ENABLED: "1" }), false, "only the exact value 'true' enables it");
  assert.equal(trace.mara.flagOffSystemPromptUnchanged, true);
  assert.equal(trace.mara.flagOffPayloadHasTrend, false);
  assert.match(trace.mara.systemPromptTrendSection, /^TREND EVIDENCE\n- /);
  assert.match(trace.mara.systemPromptTrendSection, /Never add dates, numbers, prizes, prices, partnerships or claims/);
  const t = trace.mara.payloadTrendOpportunity;
  assert.deepEqual(Object.keys(t).sort(), ["caveats", "confidence", "eventWindow", "facts", "market", "observedAt", "topic"]);
  assert.ok(t.facts.every((f) => f.sources.length > 0 && f.sources.every((s) => /1 Oct 2026/.test(s))));
  // The (simulated) reply still went through MARA's real schema validation.
  assert.equal(trace.content.concept, "Getting ready for Dubai Fitness Challenge");
  assert.equal(trace.mara.modelReply, "SIMULATED (no model called)");
  assert.deepEqual(trace.generation, { mode: "simulated", validation: { ok: true, checks: "plannedContentSchema (strict) + Instagram caption length" } });
  assert.deepEqual(trace.claimCheck.findings, [], "the grounded draft passes the unsupported-claim check");
});

test("MARA: with no trend evidence the prompt and payload are exactly as before", () => {
  assert.equal(prompt.plannedContentSystemPrompt({ trendEvidence: false }), prompt.PLANNED_CONTENT_SYSTEM_PROMPT);
  const base = {
    business: { name: "X" }, goal: "g", cadenceLabel: "3 posts a week", channel: "instagram", format: "post",
    localDate: "2026-10-24", localTime: "09:00", timezone: "Asia/Dubai", recentConcepts: [], performance: null,
  };
  assert.deepEqual(prompt.buildPlannedContentPayload(base), prompt.buildPlannedContentPayload({ ...base, trendOpportunity: null }));
  assert.equal("trendOpportunity" in prompt.buildPlannedContentPayload(base), false);
});

/* ── The recommender refuses what it cannot support ─────────────── */

const observation = () => {
  const parsed = parseTrendObservation(evidence.observation, { now: NOW });
  assert.equal(parsed.ok, true);
  return parsed.value;
};
const note = (overrides = {}) => ({ ...evidence.note, trendKey: trendKey(observation()), ...overrides });
const markets = createMarketPolicy({
  authorizations: [{ sourceId: "manual_research", status: "approved", decidedAt: "2026-10-10T00:00:00Z", decidedBy: "owner:test", reference: "TEST" }],
  coverage: [{ sourceId: "manual_research", platform: "web", country: "AE", status: "verified", checkedAt: "2026-10-10T00:00:00Z", evidence: "test" }],
});
const recommend = (input = {}) => recommendTrendOpportunity({ merchant: DEMO_MERCHANT, observations: [observation()], notes: [note()], markets, now: NOW, ...input });

test("a fact not linked to stored evidence rejects the whole note", () => {
  const forged = note({ facts: [...evidence.note.facts, { statement: "Prize money of AED 1 million.", evidenceUrls: ["https://example.com/made-up"] }] });
  const result = recommend({ notes: [forged] });
  assert.equal(result.status, "no_recommendation");
  assert.equal(result.rejectedNotes.length, 1);
});

test("other markets, ended events, expired evidence and unapproved sources produce nothing", () => {
  assert.equal(recommend({ merchant: { ...DEMO_MERCHANT, country: "SG" } }).reason, "no_usable_trend", "other country");
  assert.equal(recommend({ merchant: { ...DEMO_MERCHANT, language: "ar" } }).reason, "no_usable_trend", "other language");
  assert.equal(recommend({ notes: [note({ eventWindow: { start: "2026-09-01", end: "2026-09-30" } })] }).reason, "event_already_over");
  assert.equal(recommend({ now: Date.parse("2026-11-05T00:00:00Z") }).reason, "no_usable_trend", "evidence expired after 30 days");
  assert.equal(recommend({ markets: createMarketPolicy() }).reason, "insufficient_confidence", "no approval: confidence insufficient");
  assert.equal(recommend({ merchant: CONTROL_MERCHANT }).reason, "no_relevant_trend");
  assert.equal(recommend({ notes: [] }).reason, "no_relevant_trend");
});

test("the recommendation is deterministic", () => {
  assert.deepEqual(recommend(), recommend());
});

/* ── Live-mode plumbing (no network): exactly one generation call ── */

test("a provider passed to the demo receives exactly one MARA request, and its output is validated and claim-checked", async () => {
  const requests = [];
  const fake = {
    async structured(request) {
      requests.push(request);
      return request.parse({
        concept: "Dubai Fitness Challenge fuel", hook: "", cta: "Build your active routine.", hashtags: ["DubaiFitnessChallenge"],
        caption: "Plan your Dubai Fitness Challenge routine with an existing Palm Fuel smoothie.",
        description: "", script: [], visualBrief: "Smoothie on a counter at sunrise.",
      });
    },
  };
  const live = await runDemo({ provider: fake });
  assert.equal(requests.length, 1, "one generation call only");
  assert.equal(requests[0].maxAttempts, 1, "the live demo disables adapter retries");
  assert.equal(requests[0].maxTokens, 2200, "the live demo has a bounded structured-output budget");
  assert.equal(requests[0].reasoningEffort, "low", "the live demo minimizes reasoning-token use");
  assert.equal(requests[0].jsonSchema.name, "voom_planned_social_content", "MARA's own structured-output contract");
  assert.match(requests[0].messages[0].content, /TREND EVIDENCE/);
  assert.equal(live.generation.mode, "live");
  assert.equal(live.mara.modelReply, "LIVE (real model)");
  assert.equal(live.claimCheck.clean, true);
});

test("a reply that fails MARA's output validation is reported, not used", async () => {
  const bad = { async structured(request) { return request.parse({ concept: "", caption: "", visualBrief: "" }); } };
  const failed = await runDemo({ provider: bad });
  assert.deepEqual(failed.generation.validation, { ok: false, error: "content_generation_failed" });
  assert.equal(failed.content, undefined);
});
