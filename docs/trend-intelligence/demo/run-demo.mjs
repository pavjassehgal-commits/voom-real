/**
 * Runs the Trend Intelligence end-to-end demo locally.
 *
 * Simulated model reply (no network, no cost):
 *   node docs/trend-intelligence/demo/run-demo.mjs
 *   → docs/trend-intelligence/demo/DEMO-OUTPUT.md
 *
 * ONE real MARA model request (billable; only after explicit approval):
 *   node --env-file=<your env file> docs/trend-intelligence/demo/run-demo.mjs --live --approved-one-request \
 *     [--price-in-per-million=<USD>] [--price-out-per-million=<USD>]
 *   → docs/trend-intelligence/demo/DEMO-OUTPUT-LIVE.md
 *   Uses MARA's existing provider (AI_PROVIDER / AI_API_KEY / AI_MODEL / AI_BASE_URL).
 *
 * Database: local PGlite only. No staging/production database, no social APIs.
 */
import { writeFileSync } from "node:fs";

import { DEMO_MERCHANT, runDemo } from "../../../tests/helpers/trend-demo.mjs";
import { appendMaraPlannerReport, safeProviderResponseDiagnostic } from "./demo-report.mjs";

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const price = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = arg ? Number(arg.split("=")[1]) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
};

let provider;
const usage = { attempts: 0, requests: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, models: new Set(), statuses: [], diagnostics: [] };
if (live) {
  if (!args.has("--approved-one-request")) {
    console.error("Refusing: a live run makes a billable request. Re-run with --approved-one-request after approval.");
    process.exit(2);
  }
  const { createAiProvider } = await import("../../../lib/ai/index.ts");
  const { getAiConfig } = await import("../../../lib/ai/config.ts");
  let config;
  try {
    config = getAiConfig();
    provider = createAiProvider();
  } catch {
    console.error("Refusing: MARA's AI provider is not configured (AI_PROVIDER, AI_API_KEY, AI_MODEL).");
    process.exit(2);
  }
  console.error(`Live run: provider=${config.provider} model=${config.model} host=${new URL(config.baseUrl).host}`);
  // Observe (never alter) provider traffic to report usage. The key is never read or printed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/chat/completions")) {
      if (usage.attempts >= 1) throw new Error("Live demo one-request limit reached; automatic retry refused.");
      usage.attempts += 1;
    }
    const response = await realFetch(input, init);
    if (String(input).endsWith("/chat/completions")) {
      usage.requests += 1;
      usage.statuses.push(response.status);
      try {
        const body = await response.clone().json();
        const diagnostic = safeProviderResponseDiagnostic(body);
        usage.diagnostics.push(diagnostic);
        usage.promptTokens += diagnostic.promptTokens;
        usage.completionTokens += diagnostic.completionTokens;
        usage.reasoningTokens += diagnostic.reasoningTokens;
        if (body?.model) usage.models.add(body.model);
      } catch { /* non-JSON error body: counted, no usage */ }
    }
    return response;
  };
}

const startedAt = new Date().toISOString();
const t = await runDemo(provider ? { provider } : {});
const r = t.recommendation;
const o = t.evidence.observation;

const lines = [
  "# Trend Intelligence — demo run",
  "",
  `Run at ${startedAt} (local PGlite; real proposed schema; no remote database; ${live ? "ONE live request to MARA's configured AI provider" : "no network or model — the model reply is simulated"}).`,
  "",
  "## Input",
  "",
  `**Evidence** (${t.evidence.label})`,
  "",
  `- Topic: ${o.subject.text} · market ${o.market.country}/${o.market.language} · platform ${o.platform} · source \`${o.sourceId}\``,
  `- Reported: ${o.window.end} · recorded by ${t.evidence.provenance.recordedBy} at ${t.evidence.provenance.recordedAt}`,
  ...o.evidence.map((e) => `- ${e.attribution} — ${e.url}`),
  "",
  `**Test business (SYNTHETIC):** ${DEMO_MERCHANT.name} — ${DEMO_MERCHANT.industry}; ${DEMO_MERCHANT.description}`,
  "",
  "## Pipeline",
  "",
  `1. Validation: ${t.validation.ok ? "passed" : `FAILED ${JSON.stringify(t.validation.issues)}`}`,
  `2. Store RPC: ${t.stored.status} (id ${t.stored.observationId}, revision ${t.stored.revision}, delete after ${t.stored.deleteAfter})`,
  `3. Replay of the same evidence: ${t.replay.status}`,
  `4. Read RPC (web/AE/en): ${t.read.status}, ${t.read.count} usable observation(s), permitted sources ${t.read.permittedSourceIds.join(", ")}`,
  `5. Recommendation: ${r.status}${r.status === "recommended" ? ` · confidence ${r.confidence.level} (${r.confidence.reasons.join(", ")}) · freshness ${r.freshness}` : ` (${r.reason})`}`,
  `6. Control business (${"Marina Contract Lawyers, legal services"}): ${t.control.status} (${t.control.reason})`,
  "",
];

if (r.status === "recommended") {
  lines.push(
    "## Output — MARA's recommendation for the test business",
    "",
    `**${r.headline}**`,
    "",
    `**Why now (verified facts):** ${r.whyNow}`,
    "",
    `**What to do:** ${r.suggestedAction}`,
    "",
    "**Content ideas:**",
    ...r.contentIdeas.map((idea) => `- ${idea}`),
    "",
    `**Timing:** start posting ${r.timing.startPostingOn}; event ${r.timing.eventStart} → ${r.timing.eventEnd}; evidence usable until ${r.timing.evidenceUsableUntil}`,
    "",
    "**Sources:**",
    ...r.citations.map((c) => `- ${c.publisher} — ${c.url} (retrieved ${c.retrievedAt})`),
    "",
    `**Relevance:** matched on ${r.relevance.matchedOn.join(", ")} — ${r.relevance.rationale} (${r.relevance.reviewer})`,
    "",
    "**Caveats:**",
    ...r.caveats.map((c) => `- ${c}`),
    "",
    `**Approval required:** ${r.approvalRequired ? "yes — nothing is scheduled or published by this recommendation" : "no"}`,
    "",
  );
  appendMaraPlannerReport(lines, t);
} else if (t.generation?.validation && !t.generation.validation.ok) {
  lines.push(`Generation failed MARA's validation: ${t.generation.validation.error}`, "");
}

if (live) {
  const pin = price("price-in-per-million");
  const pout = price("price-out-per-million");
  const cost = pin !== null && pout !== null ? (usage.promptTokens * pin + usage.completionTokens * pout) / 1e6 : null;
  lines.push(
    "## Live request accounting",
    "",
    `- HTTP attempts permitted by the demo circuit breaker: ${usage.attempts}/1`,
    `- HTTP requests to the provider: ${usage.requests} (statuses ${usage.statuses.join(", ") || "none"})`,
    `- Model reported by provider: ${[...usage.models].join(", ") || "not reported"}`,
    `- Tokens (provider-reported): prompt ${usage.promptTokens}, completion ${usage.completionTokens}`,
    `- Reasoning tokens (provider-reported): ${usage.reasoningTokens}`,
    ...usage.diagnostics.map((diagnostic, index) =>
      `- Response ${index + 1} shape: final content ${diagnostic.finalContentExists ? "present" : "absent"}, length ${diagnostic.finalContentLength}; finish reason ${diagnostic.finishReason}; reasoning ${diagnostic.reasoningPresent ? "present" : "absent"}; prompt/completion/reasoning tokens ${diagnostic.promptTokens}/${diagnostic.completionTokens}/${diagnostic.reasoningTokens}`),
    `- Cost: ${cost === null ? "not computed (pass --price-in-per-million and --price-out-per-million from your provider's price list)" : `USD ${cost.toFixed(6)} at USD ${pin}/M input and USD ${pout}/M output`}`,
    "",
  );
}

const output = lines.join("\n");
writeFileSync(new URL(live ? "./DEMO-OUTPUT-LIVE.md" : "./DEMO-OUTPUT.md", import.meta.url), output);
console.log(output);
