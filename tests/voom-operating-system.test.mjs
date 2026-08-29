import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("MARA chat is preserved but removed from navigation and redirected", async () => {
  const [nav, route, legacy] = await Promise.all([read("components/voom/shell/nav.ts"), read("app/app/(shell)/mara/page.tsx"), read("components/voom/mara/LegacyMaraChat.tsx")]);
  assert.doesNotMatch(nav, /n: "MARA"/);
  assert.match(route, /redirect\("\/app\/today"\)/);
  assert.match(legacy, /LegacyMaraChat/);
  assert.match(legacy, /fetch\("\/api\/mara"/);
  assert.match(legacy, /pendingActions/);
});

test("marketing plans are owner-scoped, anonymous-blocked, and server-written", async () => {
  const migration = await read("supabase/migrations/0009_marketing_plans.sql");
  assert.match(migration, /^begin;/m); assert.match(migration, /^commit;/m);
  assert.match(migration, /alter table public\.marketing_plans enable row level security/);
  assert.match(migration, /revoke all on table public\.marketing_plans from anon, authenticated/);
  assert.match(migration, /grant select on table public\.marketing_plans to authenticated/);
  assert.match(migration, /grant select, insert, update on table public\.marketing_plans to service_role/);
  assert.match(migration, /auth\.uid\(\)\) = owner_user_id/);
  assert.doesNotMatch(migration, /grant .*insert.*authenticated/);
});

test("planning is server-only, structured, grounded, and never creates chat messages", async () => {
  const [service, route] = await Promise.all([read("lib/mara/planning.ts"), read("app/api/plan/route.ts")]);
  assert.match(service, /import "server-only"/);
  assert.match(service, /provider\.structured/);
  for (const source of ["getBrandProfile", "listCalendarItems", "listCampaigns", "getInstagramConnection", "instagram_insight_snapshots"]) assert.match(service, new RegExp(source));
  assert.doesNotMatch(service + route, /from\("mara_messages"\).*insert/s);
  assert.match(route, /getCurrentUser/);
  assert.match(route, /owner_user_id: user\.id/);
});

test("automation modes preserve confirmation safety", async () => {
  const [route, page] = await Promise.all([read("app/api/automation-mode/route.ts"), read("app/app/(shell)/automations/page.tsx")]);
  for (const mode of ["manual", "assisted", "autopilot"]) assert.match(route, new RegExp(`"${mode}"`));
  assert.match(page, /No mode can publish externally, send a campaign, delete content, or spend advertising money/);
  assert.match(route, /externalActionsRequirePermission: true/);
});

test("Today summarizes real owner-scoped weekly workflow data without side effects", async () => {
  const [page, data] = await Promise.all([read("app/app/(shell)/today/page.tsx"), read("lib/voom/operating-data.ts")]);
  for (const section of ["Needs your approval", "Next scheduled content", "Marketing plan", "Voom recommendation"]) assert.match(page, new RegExp(section));
  assert.match(data, /mara_pending_actions/);
  assert.match(data, /content_calendar_items/);
  assert.match(data, /marketing_plans/);
  assert.match(data, /eq\("owner_user_id", user\.id\)/);
  assert.match(data, /eq\("tool_name", "propose_calendar_item"\)/);
  assert.match(data, /in\("status", \["approved", "scheduled"\]\)/);
  assert.match(page, /timeZone: "Asia\/Dubai"/);
  assert.match(page, /No marketing plan yet/);
  assert.match(page, /Nothing scheduled yet/);
  assert.doesNotMatch(page + data, /fetch\(|provider\.|prepareInstagramPlanWorkflow|insert\(|upsert\(|update\(/);
});

test("weekly planning automation is server-scheduled, mode-aware, and idempotent", async () => {
  const [automation, persistence, cron, migration, vercel, planRoute] = await Promise.all([
    read("lib/voom/weekly-automation.ts"), read("lib/mara/plan-persistence.ts"), read("app/api/cron/weekly-plans/route.ts"),
    read("supabase/migrations/0014_weekly_plan_automation.sql"), read("vercel.json"), read("app/api/plan/route.ts"),
  ]);
  assert.match(automation, /\["assisted", "autopilot"\]/);
  assert.doesNotMatch(automation, /"manual"/);
  assert.match(automation, /automation_week_key/);
  assert.match(automation, /for \(const business of businesses/);
  assert.match(persistence, /insert\.error\.code === "23505"/);
  assert.match(persistence, /prepareInstagramPlanWorkflow/);
  assert.match(migration, /unique index[\s\S]*owner_user_id, automation_week_key/);
  assert.match(migration, /where automation_week_key is not null/);
  assert.match(cron, /Bearer \$\{secret\}/);
  assert.match(cron, /runWeeklyPlanAutomation/);
  assert.match(vercel, /0 3 \* \* \*/);
  assert.match(planRoute, /export async function POST/);
  assert.doesNotMatch(automation + persistence + cron, /instagram_publish_jobs|META_|spend|send_campaign/);
});

test("Dubai weekly cycle changes once on Monday", async () => {
  const { dubaiWeek } = await import("../lib/voom/weekly-cycle.ts");
  assert.equal(dubaiWeek(new Date("2026-08-30T19:30:00Z")).weekKey, "2026-08-24");
  assert.equal(dubaiWeek(new Date("2026-08-30T21:30:00Z")).weekKey, "2026-08-31");
  assert.equal(dubaiWeek(new Date("2026-09-06T19:59:00Z")).weekKey, "2026-08-31");
  assert.equal(dubaiWeek(new Date("2026-09-06T20:00:00Z")).weekKey, "2026-09-07");
});

test("Autopilot safety blocks risky content and accepts only valid routine recommendations", async () => {
  const { evaluateAutopilotRecommendation } = await import("../lib/mara/autopilot-safety.ts");
  const now = new Date("2026-08-29T08:00:00Z");
  const base = { title: "A quiet afternoon at the café", content: "Take a slow afternoon break with a freshly prepared coffee. Visit us this week. #DubaiCafe", publishAt: "2026-08-31T14:00:00+04:00" };
  assert.equal(evaluateAutopilotRecommendation(base, now).safe, true);
  const blocked = [
    ["unsupported_offer", "Get 20% off every coffee today"],
    ["unsupported_claim", "We guarantee the best coffee in Dubai"],
    ["giveaway_or_contest", "Enter our giveaway to win a prize"],
    ["unsupported_price", "Your next latte is AED 15"],
  ];
  for (const [reason, content] of blocked) {
    const result = evaluateAutopilotRecommendation({ ...base, content }, now);
    assert.equal(result.safe, false);
    assert.ok(result.blockers.includes(reason), `${content} should be blocked as ${reason}`);
  }
  assert.equal(evaluateAutopilotRecommendation({ ...base, content: "" }, now).safe, false);
  assert.equal(evaluateAutopilotRecommendation({ ...base, publishAt: "2026-08-29T11:00:00+04:00" }, now).safe, false);
});

test("Autopilot approval reuses the owned idempotent internal calendar action", async () => {
  const [automation, approval, tools, migration, board] = await Promise.all([
    read("lib/voom/weekly-automation.ts"), read("lib/mara/autopilot-approval.ts"), read("lib/mara/tools.ts"),
    read("supabase/migrations/0015_autopilot_internal_approval.sql"), read("components/voom/operating/ApprovalsBoard.tsx"),
  ]);
  assert.match(automation, /business\.automation_level === "autopilot"/);
  assert.match(approval, /executeConfirmedAction/);
  assert.match(approval, /eq\("owner_user_id", ownerId\)/);
  assert.match(approval, /in\("status", \["pending", "failed"\]\)/);
  assert.match(approval, /deterministicSafetyChecks: "passed"/);
  assert.match(approval, /resultingCalendarItemId/);
  assert.match(tools, /onConflict: "owner_user_id,source_draft_id"|createCalendarItem/);
  assert.match(migration, /grant insert, update on table public\.content_calendar_items to service_role/);
  assert.doesNotMatch(migration, /grant[^;]+\b(?:anon|authenticated)\b/i);
  assert.match(board, /Autopilot approved/);
  assert.doesNotMatch(approval, /instagram_publish_jobs|META_|send_campaign|ad spend/i);
});

test("Reel production capability is conservative and requests exact real-world assets", async () => {
  const { classifyReelProduction } = await import("../lib/mara/reel-production.ts");
  const educational = classifyReelProduction({ concept: "Three coffee storage tips", script: "An educational text-led explainer." });
  assert.deepEqual(educational.availableMethods, ["create_with_mara", "upload_asset", "film_yourself"]);
  assert.equal(educational.recommendedMethod, "create_with_mara");
  assert.equal(educational.missingAssetRequest, null);

  const storefront = classifyReelProduction({ concept: "Show our real storefront", script: "Walk viewers through our location." });
  assert.deepEqual(storefront.availableMethods, ["film_yourself", "upload_asset"]);
  assert.doesNotMatch(storefront.availableMethods.join(" "), /create_with_mara/);
  assert.match(storefront.missingAssetRequest, /storefront and entrance/);

  const testimonial = classifyReelProduction({ concept: "Real customer testimonial", script: "A customer explains their visit." });
  assert.deepEqual(testimonial.availableMethods, ["film_yourself", "upload_asset"]);
  assert.match(testimonial.missingAssetRequest, /real customer.*permission/);

  const product = classifyReelProduction({ concept: "Dessert being cut open", script: "Reveal the centre." });
  assert.match(product.missingAssetRequest, /5–8 second close-up clip.*cut open/);
});

test("Reel choices reuse persisted drafts and approval actions without generation or scheduling", async () => {
  const [planning, workflow, tools, route, board, today, automation] = await Promise.all([
    read("lib/mara/planning.ts"), read("lib/mara/plan-workflow.ts"), read("lib/mara/tools.ts"),
    read("app/api/mara/actions/[id]/route.ts"), read("components/voom/operating/ApprovalsBoard.tsx"),
    read("lib/voom/operating-data.ts"), read("lib/mara/autopilot-approval.ts"),
  ]);
  assert.match(planning, /contentType: z\.enum\(\["feed", "reel"\]\)/);
  assert.match(planning, /Reel recommendations need a script/);
  assert.match(workflow, /kind: post\.contentType === "reel" \? "reel"/);
  assert.match(tools, /classifyReelProduction/);
  assert.match(workflow, /"choose_reel_production"/);
  assert.match(tools, /choose_reel_production/);
  assert.match(route, /productionStatusFor/);
  assert.match(route, /eq\("owner_user_id", user\.id\)/);
  assert.match(board, /Create with MARA/);
  assert.match(board, /No Reel has been generated or published/);
  assert.match(today, /reelTaskCount/);
  assert.match(automation, /eq\("tool_name", "propose_calendar_item"\)/);
  assert.doesNotMatch(route + workflow, /generateVideo|mara_media_generations|instagram_publish_jobs/);
});

test("Reel assets are signature-validated and use one private owner-scoped record", async () => {
  const { detectReelAsset, REEL_ASSET_MAX_BYTES, safeAssetName } = await import("../lib/media/reel-asset.ts");
  assert.equal(detectReelAsset(Uint8Array.from([0xff, 0xd8, 0xff]))?.mimeType, "image/jpeg");
  assert.equal(detectReelAsset(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))?.mimeType, "image/png");
  assert.equal(detectReelAsset(new TextEncoder().encode("RIFFxxxxWEBP"))?.mimeType, "image/webp");
  assert.equal(detectReelAsset(Uint8Array.from([0,0,0,0,...new TextEncoder().encode("ftypqt  ")]))?.mimeType, "video/quicktime");
  assert.equal(detectReelAsset(new TextEncoder().encode("not media")), null);
  assert.equal(REEL_ASSET_MAX_BYTES, 4194304);
  assert.equal(safeAssetName("../unsafe/name.mov"), "..-unsafe-name.mov");
  const [route, migration, board, today] = await Promise.all([
    read("app/api/reels/assets/[actionId]/route.ts"), read("supabase/migrations/0016_reel_draft_assets.sql"),
    read("components/voom/operating/ApprovalsBoard.tsx"), read("lib/voom/operating-data.ts"),
  ]);
  assert.match(route, /eq\("owner_user_id", user\.id\)/);
  assert.match(route, /detectReelAsset\(bytes\)/);
  assert.match(route, /createSignedUrl/);
  assert.match(route, /randomUUID\(\)/);
  assert.doesNotMatch(route, /NEXT_PUBLIC.*SECRET|publish|instagram|generateVideo/);
  assert.match(migration, /unique \(owner_user_id, draft_id\)/);
  assert.match(migration, /reel_draft_assets_select_own/);
  assert.match(migration, /revoke all.*anon, authenticated/);
  assert.match(migration, /replace_reel_draft_asset/);
  assert.match(migration, /Ready for future MARA production/);
  assert.match(board, /Replace asset/);
  assert.match(today, /productionStatus !== "ready_for_mara_production"/);
});

test("plan generation persists exactly three distinct Instagram drafts and approvals without chat messages", async () => {
  const [planning, workflow, route, migration, workspace] = await Promise.all([
    read("lib/mara/planning.ts"), read("lib/mara/plan-workflow.ts"), read("app/api/plan/route.ts"),
    read("supabase/migrations/0013_weekly_plan_recommendations.sql"), read("components/voom/operating/PlanWorkspace.tsx"),
  ]);
  assert.match(planning, /complete caption with CTA and hashtags/);
  assert.match(planning, /proposedPublishAt/);
  assert.match(planning, /plannedPosts: z\.array\(plannedPost\)\.length\(3\)/);
  assert.match(planning, /distinct topics/);
  assert.match(planning, /Schedule each recommendation on a different day/);
  assert.match(planning, /time > latest/);
  assert.match(workflow, /posts\.length !== 3/);
  assert.match(workflow, /mara_drafts"\)\.upsert\(draftRows/);
  assert.match(workflow, /source_plan_id: planId/);
  assert.match(workflow, /source_plan_item_key: String\(index\)/);
  assert.match(workflow, /Promise\.all\(posts\.map/);
  assert.match(workflow, /"propose_calendar_item"/);
  assert.match(workflow, /marketing-plan:\$\{planId\}:item:\$\{index\}/);
  assert.match(workflow, /pendingActionIds/);
  assert.doesNotMatch(workflow, /mara_messages/);
  assert.match(route, /prepareInstagramPlanWorkflow/);
  assert.match(migration, /unique \(owner_user_id, source_plan_id, source_plan_item_key\)/);
  assert.match(workspace, /Your 3 Instagram recommendations are ready/);
});

test("approved plan content is independently and idempotently linked to the calendar and never published", async () => {
  const [migration, weeklyMigration, ownerLinks, tools, data] = await Promise.all([
    read("supabase/migrations/0010_plan_to_calendar_workflow.sql"), read("supabase/migrations/0013_weekly_plan_recommendations.sql"),
    read("supabase/migrations/0011_plan_workflow_owner_links.sql"), read("lib/mara/tools.ts"), read("lib/mara/internal-data.ts"),
  ]);
  assert.match(weeklyMigration, /drop constraint if exists mara_drafts_owner_source_plan_key/);
  assert.match(weeklyMigration, /unique \(owner_user_id, source_plan_id, source_plan_item_key\)/);
  assert.match(migration, /unique \(owner_user_id, source_draft_id\)/);
  assert.match(ownerLinks, /foreign key \(source_plan_id, owner_user_id\)/);
  assert.match(ownerLinks, /foreign key \(source_draft_id, owner_user_id\)/);
  assert.match(data, /onConflict: "owner_user_id,source_draft_id"/);
  assert.match(tools, /status: "approved"/);
  assert.match(tools, /Nothing was published/);
  assert.match(tools, /mara_drafts"\)\.update\(\{ status: "approved" \}\)/);
});

test("approval edits persist atomically and confirmation uses the latest owned draft", async () => {
  const [board, route, migration, tools] = await Promise.all([
    read("components/voom/operating/ApprovalsBoard.tsx"), read("app/api/mara/actions/[id]/route.ts"),
    read("supabase/migrations/0012_edit_plan_calendar_approval.sql"), read("lib/mara/tools.ts"),
  ]);
  assert.match(board, /Instagram caption/);
  assert.match(board, /type="datetime-local"/);
  assert.match(route, /edit_mara_calendar_approval/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /owner_user_id = v_owner_id/);
  assert.match(migration, /update public\.mara_drafts/);
  assert.match(migration, /update public\.mara_pending_actions/);
  assert.match(tools, /draft\?\.content \?\? a\.content/);
  assert.match(tools, /draft\?\.proposed_publish_at \?\? a\.publishAt/);
});

test("saved calendar details are read-only, current, sanitized, and owner-scoped", async () => {
  const [page, modal, route, data, migration] = await Promise.all([
    read("app/app/(shell)/calendar/page.tsx"), read("components/voom/modals/SavedCalendarDetailModal.tsx"),
    read("app/api/voom/calendar/[id]/route.ts"), read("lib/mara/internal-data.ts"), read("supabase/migrations/0003_mara_internal_tools.sql"),
  ]);
  assert.match(page, /SavedCalendarDetailModal/);
  assert.match(modal, /Final caption \/ content/);
  assert.match(modal, /Nothing has been published or sent externally/);
  assert.doesNotMatch(modal, /Textarea|>Publish<|>Send</);
  assert.match(route, /getCurrentUser/);
  assert.match(route, /getCalendarItem\(await createClient\(\), user\.id, id\)/);
  assert.match(route, /source: item\.source_draft_id \? "MARA recommendation · approved in Voom" : null/);
  assert.doesNotMatch(route, /owner_user_id:|source_draft_id:/);
  assert.match(data, /eq\("owner_user_id", ownerId\)\.eq\("id", id\)/);
  assert.match(migration, /create policy "calendar_items_own"[\s\S]*auth\.uid\(\)\) = owner_user_id/);
});
