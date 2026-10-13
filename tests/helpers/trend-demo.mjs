/**
 * Trend Intelligence — the end-to-end demonstration, as one function.
 *
 *   real, manually supplied evidence (docs/trend-intelligence/demo/*.json)
 *     → Stage 1 validation
 *     → storage through the real store RPC (local PGlite, real proposed SQL)
 *     → read back through the real read RPC (approval, coverage, expiry,
 *       invalidation all enforced by the database)
 *     → confidence classification
 *     → MARA's evidence-backed recommendation for a synthetic merchant
 *     → MARA's content planner, with the trend block (flag-gated) in its real
 *       prompt and payload.
 *
 * What is SIMULATED: the merchant (synthetic), the owner's approval and
 * coverage decisions (labelled DEMO, local database only), and — unless a
 * real provider is passed in — the language model's reply in the last step
 * (built from the recommendation and clearly labelled). With a provider (the
 * live demo passes MARA's own createAiProvider()), exactly ONE generation
 * call is made. Everything else is the real code path.
 */
import "./server-only-shim.mjs";

import { readFileSync } from "node:fs";

import { createTrendDb, rpcClient, sqlPort } from "./trend-db.mjs";

const { parseTrendObservation } = await import("../../lib/trends/schema.ts");
const { trendKey } = await import("../../lib/trends/dedupe.ts");
const { storeTrendObservation } = await import("../../lib/trends/storage.ts");
const { listUsableTrendObservationsRpc, toTrendObservation } = await import("../../lib/trends/read-model.ts");
const { loadTrendMarketPolicy } = await import("../../lib/trends/policy-store.ts");
const { recommendTrendOpportunity, toTrendPromptContext } = await import("../../lib/trends/opportunity.ts");
const { checkTrendGroundedContent } = await import("../../lib/trends/claim-check.ts");
const prompt = await import("../../lib/voom/workflow/prompt.ts");
const service = await import("../../lib/voom/workflow/service.ts");
const { trendContextEnabled } = await import("../../lib/voom/workflow/trend-flag.ts");
const timezone = await import("../../lib/voom/timezone.ts");

export const EVIDENCE_PATH = new URL("../../docs/trend-intelligence/demo/evidence-dubai-fitness-challenge-2026.json", import.meta.url);

/** SYNTHETIC test business (not a real customer). */
export const DEMO_MERCHANT = {
  name: "Palm Fuel Smoothie Bar",
  industry: "Healthy cafe and smoothie bar",
  description: "Smoothies, protein bowls and coffee for people who train in Dubai Marina.",
  city: "Dubai",
  country: "AE",
  language: "en",
  targetCustomer: ["active residents of Dubai Marina"],
};

/** SYNTHETIC control business: same market, unrelated industry. */
export const CONTROL_MERCHANT = {
  name: "Marina Contract Lawyers",
  industry: "Legal services",
  description: "Commercial contract reviews for small companies.",
  city: "Dubai",
  country: "AE",
  language: "en",
  targetCustomer: ["small company founders"],
};

/** The labelled stand-in for a language model's reply (no model is called). */
function simulatedModelReply(recommendation) {
  return {
    concept: "Getting ready for Dubai Fitness Challenge",
    hook: "",
    caption: `${recommendation.topic} runs from 31 October to 29 November: 30 minutes of activity a day for 30 days. `
      + `Planning your 30 minutes? Start or finish it with a smoothie at Palm Fuel in Dubai Marina.`,
    cta: "Register for free on the official Dubai Fitness Challenge website.",
    hashtags: ["DubaiFitnessChallenge", "DubaiMarina", "Smoothies"],
    description: "",
    script: [],
    visualBrief: "A bright smoothie bar counter at sunrise with runners passing outside; fresh fruit and a protein bowl in the foreground. No text or logos.",
  };
}

/**
 * @param {{ now?: number, provider?: { structured: Function } }} [options]
 *   provider: a real MARA AI provider for the live demo; omitted = simulated reply.
 */
export async function runDemo({ now = Date.now(), provider: liveProvider } = {}) {
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
  const trace = { evidence };

  // 1. Validation (Stage 1).
  const parsed = parseTrendObservation(evidence.observation, { now });
  trace.validation = parsed.ok ? { ok: true } : { ok: false, issues: parsed.issues };
  if (!parsed.ok) return trace;
  const observation = parsed.value;
  const note = { ...evidence.note, trendKey: trendKey(observation) };

  // 2. Local database with the real proposed schema; DEMO owner decisions.
  const { db } = await createTrendDb();
  await db.exec(`
    insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference)
    values ('manual_research', 'approved', now() - interval '1 minute', 'owner:demo', 'DEMO-LOCAL-ONLY');
    insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by)
    values ('manual_research', 'web', 'AE', 'verified', now() - interval '1 minute',
            'DEMO: reviewer reads UAE national news sites (Khaleej Times, Gulf News)', 'owner:demo');
  `);
  const service_role = rpcClient(db, "service_role");

  // 3. Storage through the real store RPC (and an idempotent replay).
  trace.stored = await storeTrendObservation(service_role, observation, { now });
  trace.replay = await storeTrendObservation(service_role, observation, { now });

  // 4. Read back through the real read RPC.
  const read = await listUsableTrendObservationsRpc(service_role, { platform: "web", country: "AE", language: "en" });
  trace.read = { status: read.status, count: read.observations?.length ?? 0, permittedSourceIds: read.permittedSourceIds ?? [] };
  if (read.status !== "ok") return trace;
  const usable = read.observations.map(toTrendObservation);
  trace.stored_row = read.observations[0];

  // 5. Current policy (for confidence) and MARA's recommendation.
  const { policy } = await loadTrendMarketPolicy(sqlPort(db), { now });
  trace.recommendation = recommendTrendOpportunity({ merchant: DEMO_MERCHANT, observations: usable, notes: [note], markets: policy, now });
  trace.control = recommendTrendOpportunity({ merchant: CONTROL_MERCHANT, observations: usable, notes: [note], markets: policy, now });
  if (trace.recommendation.status !== "recommended") return trace;

  // 6. MARA's content planner. Flag OFF: unchanged. Flag ON: trend block in the real prompt.
  const trendOpportunity = toTrendPromptContext(trace.recommendation);
  trace.flag = { defaultEnabled: trendContextEnabled({}), demoEnabled: trendContextEnabled({ VOOM_TREND_CONTEXT_ENABLED: "true" }) };
  const date = trace.recommendation.timing.startPostingOn;
  const slot = {
    date, slotKey: `${date}|instagram_post`, index: 0, channel: "instagram", format: "post", contentType: "post",
    publishAt: timezone.localToUtcIso(date, 9 * 60, "Asia/Dubai"),
  };
  const business = {
    brand_name: DEMO_MERCHANT.name, brand_description: DEMO_MERCHANT.description, industry: DEMO_MERCHANT.industry,
    target_customer: DEMO_MERCHANT.targetCustomer, main_goal: "Bring more regulars in during the cooler season", brand_personality: ["energetic", "friendly"],
  };
  const goal = "Bring more regulars in during the cooler season";
  // Flag-off comparison from MARA's own prompt builders: no model call needed.
  const flagOffPayload = prompt.buildPlannedContentPayload({
    business: { name: DEMO_MERCHANT.name }, goal, cadenceLabel: "3 posts a week", channel: "instagram", format: "post",
    localDate: date, localTime: "09:00", timezone: "Asia/Dubai", recentConcepts: [], performance: null,
  });
  // Exactly ONE generation call, through MARA's real generateWorkflowPlannedContent.
  const captured = [];
  const provider = {
    async structured(request) {
      captured.push(request.messages);
      if (liveProvider) {
        try {
          return await liveProvider.structured({
            ...request,
            // Demo-only OpenRouter controls. Production planning keeps its
            // existing 1,500-token budget and bounded retry behavior.
            maxAttempts: 1,
            maxTokens: 2200,
            reasoningEffort: "low",
          });
        } catch (error) {
          trace.generation.diagnostic = {
            code: typeof error?.code === "string" ? error.code : "unknown_error",
            stage: typeof error?.stage === "string" ? error.stage : "unknown_stage",
            transient: error?.transient === true,
          };
          throw error;
        }
      }
      return request.parse(simulatedModelReply(trace.recommendation));
    },
  };
  trace.generation = { mode: liveProvider ? "live" : "simulated" };
  try {
    trace.content = await service.generateWorkflowPlannedContent({
      business, goal, cadence: "3x_week", timeZone: "Asia/Dubai", slot, plannedConcepts: [], performance: null, provider, trendOpportunity,
    });
    trace.generation.validation = { ok: true, checks: "plannedContentSchema (strict) + Instagram caption length" };
  } catch (error) {
    trace.generation.validation = { ok: false, error: error instanceof Error ? error.message : "content_generation_failed" };
    return trace;
  }
  const [withTrend] = captured;
  trace.mara = {
    flagOffSystemPromptUnchanged: prompt.plannedContentSystemPrompt({ trendEvidence: false }) === prompt.PLANNED_CONTENT_SYSTEM_PROMPT,
    flagOffPayloadHasTrend: "trendOpportunity" in flagOffPayload,
    systemPromptTrendSection: withTrend[0].content.slice(prompt.PLANNED_CONTENT_SYSTEM_PROMPT.length).trim(),
    payloadTrendOpportunity: JSON.parse(withTrend[1].content).trendOpportunity,
    requestChars: withTrend.reduce((n, m) => n + m.content.length, 0),
    modelReply: liveProvider ? "LIVE (real model)" : "SIMULATED (no model called)",
  };
  trace.claimCheck = checkTrendGroundedContent(trace.content, trendOpportunity, {
    name: DEMO_MERCHANT.name, description: DEMO_MERCHANT.description, industry: DEMO_MERCHANT.industry, goal,
    targetCustomer: DEMO_MERCHANT.targetCustomer,
  });
  return trace;
}
