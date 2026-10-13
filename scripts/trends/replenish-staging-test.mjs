/**
 * ONE staging Replenish run for the synthetic test business, through the real
 * Marketing Plan backend path, with the deterministic AI fixture.
 *
 *   node --env-file=.env.staging.local scripts/trends/replenish-staging-test.mjs \
 *     --project=qcdpegwjofrqnfudyrqq --approved-staging-replenish
 *
 * Requires 09-gp-replenish-setup.sql to have been applied. Refuses unless the
 * flags are present and the environment is voom-staging. Enables
 * VOOM_TREND_CONTEXT_ENABLED for THIS process only, so the production loader
 * (loadOwnerTrendPromptContext) reads the approved context and re-checks the
 * linked observation. Runs runOwnerWorkflow(trigger "replenish", stage
 * "planning_only"): drafts and plan items only — no media provider, no
 * approval, no scheduling, no queueing, no publishing, no OpenRouter.
 * Writes a report (counts, statuses, safe codes; no credentials) to
 * docs/trend-intelligence/staging/runs/.
 */
import "../../tests/helpers/server-only-shim.mjs";

import { mkdirSync, writeFileSync } from "node:fs";

import { deterministicTrendProvider, GP_TOPIC, summarizeCaptured, TEST_BRAND } from "./gp-trend-fixture.mjs";
import { STAGING_PROJECT_ID, verifyStagingTarget } from "./staging-target.mjs";

const args = new Set(process.argv.slice(2));
const refuse = (code, message) => {
  console.error(`REFUSED (${code}): ${message}`);
  process.exit(2);
};
if (!args.has(`--project=${STAGING_PROJECT_ID}`)) refuse("project_flag_missing", `pass --project=${STAGING_PROJECT_ID}`);
if (!args.has("--approved-staging-replenish")) refuse("not_approved", "this run writes drafts to staging; pass --approved-staging-replenish after approval");
const target = verifyStagingTarget(process.env);
if (!target.ok) refuse(target.code, "the environment does not point at voom-staging with a service key");

process.env.VOOM_TREND_CONTEXT_ENABLED = "true"; // this process only

let report;
try {
  const { createAdminClient } = await import("../../utils/supabase/admin.ts");
  const service = await import("../../lib/voom/workflow/service.ts");
  const admin = createAdminClient();
  const { data: business, error } = await admin.from("businesses").select("owner_user_id").eq("brand_name", TEST_BRAND).maybeSingle();
  if (error || !business?.owner_user_id) refuse("test_business_missing", "apply 09-gp-replenish-setup.sql first");
  const ownerId = business.owner_user_id;
  const captured = [];
  const now = new Date();
  const result = await service.runOwnerWorkflow(admin, {
    ownerId, now, trigger: "replenish", stage: "planning_only",
    planningDeps: { provider: deterministicTrendProvider(captured), performanceContext: async () => null },
  });
  const { data: drafts } = await admin.from("mara_drafts").select("id,kind,title,status,created_at")
    .eq("owner_user_id", ownerId).gte("created_at", now.toISOString()).order("created_at", { ascending: true });
  report = {
    runAt: now.toISOString(),
    projectId: STAGING_PROJECT_ID,
    business: TEST_BRAND,
    topic: GP_TOPIC,
    workflow: {
      trigger: result.trigger, stage: result.stage, mode: result.mode, blockedReason: result.blockedReason,
      slots: result.slots, created: result.created, reused: result.reused, mediaQueued: result.mediaQueued,
      awaitingApproval: result.awaitingApproval, autoApproved: result.autoApproved, heldForReview: result.heldForReview,
      failures: result.failures,
    },
    maraRequests: summarizeCaptured(captured),
    drafts: (drafts ?? []).map((d) => ({ id: d.id, kind: d.kind, title: d.title, status: d.status })),
  };
} catch {
  refuse("replenish_failed", "the run failed; inspect staging drafts before retrying");
}

const dir = new URL("../../docs/trend-intelligence/staging/runs/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`replenish-gp-${report.runAt.replace(/[:.]/g, "-")}.json`, dir);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
const w = report.workflow;
console.log(`workflow: ${w.trigger}/${w.stage}/${w.mode} · slots ${w.slots} · created ${w.created} · reused ${w.reused} · media ${w.mediaQueued} · auto-approved ${w.autoApproved} · failures ${w.failures.length}`);
console.log(`MARA requests: ${report.maraRequests.requests} · all carried TREND EVIDENCE: ${report.maraRequests.allCarriedTrendSection} · topics ${JSON.stringify(report.maraRequests.topics)}`);
for (const d of report.drafts) console.log(`- ${d.kind} · ${d.status} · ${d.title}`);
console.log(`report: ${file.pathname}`);
process.exit(w.failures.length === 0 && report.maraRequests.requests > 0 && report.maraRequests.topics.length === 1 && report.maraRequests.topics[0] === GP_TOPIC ? 0 : 1);
