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
  const [service, route] = await Promise.all([read("lib/voom/workflow/service.ts"), read("app/api/plan/route.ts")]);
  assert.match(service, /import "server-only"/);
  assert.match(service, /createAiProvider\(\)\.structured/);
  assert.match(service, /evaluateAutopilotRecommendation/);
  assert.doesNotMatch(service + route, /from\("mara_messages"\).*insert/s);
  assert.match(route, /getCurrentUser/);
  assert.match(route, /ownerId: user\.id/);
});

test("automation modes preserve confirmation safety", async () => {
  const [route, page] = await Promise.all([read("app/api/automation-mode/route.ts"), read("app/app/(shell)/automations/page.tsx")]);
  for (const mode of ["manual", "assisted", "autopilot"]) assert.match(route, new RegExp(`"${mode}"`));
  assert.match(page, /No mode can publish externally, send a campaign, delete content, or spend advertising money/);
  assert.match(route, /externalActionsRequirePermission: true/);
});

test("Today is the operational command centre over the one workflow", async () => {
  const [page, data, read_model] = await Promise.all([
    read("app/app/(shell)/today/page.tsx"), read("lib/voom/operating-data.ts"), read("lib/voom/workflow/read.ts"),
  ]);
  for (const section of ["Publishing today", "Needs your approval", "Being generated", "Needs attention", "What happens next"]) {
    assert.match(page, new RegExp(section));
  }
  assert.match(data, /loadWorkflowSnapshot/);
  assert.match(data, /todaySummary/);
  assert.match(read_model, /mara_drafts/);
  assert.match(read_model, /content_calendar_items/);
  assert.match(read_model, /instagram_publish_queue/);
  assert.match(read_model, /eq\("owner_user_id", ownerId\)/);
  // Today never mutates and never hardcodes a date.
  assert.doesNotMatch(page + data, /insert\(|upsert\(|\b20\d\d-\d\d-\d\d\b/);
});

test("rolling plan automation is server-scheduled, cadence-aware, mode-aware, and idempotent", async () => {
  const [automation, service, cron, migration, vercel, planRoute] = await Promise.all([
    read("lib/voom/weekly-automation.ts"), read("lib/voom/workflow/service.ts"), read("app/api/cron/weekly-plans/route.ts"),
    read("supabase/migrations/0029_workflow_timezone_and_slots.sql"), read("vercel.json"), read("app/api/plan/route.ts"),
  ]);
  assert.match(automation, /\["assisted", "autopilot"\]/);
  assert.doesNotMatch(automation, /"manual"/);
  assert.match(automation, /for \(const business of businesses/);
  // The old "exactly 3 per week" rule is gone.
  assert.doesNotMatch(automation + service, /automation_week_key|length\(3\)|!== 3/);
  assert.match(service, /onConflict: "owner_user_id,source_plan_id,source_plan_item_key"/);
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(migration, /add column if not exists timezone/);
  assert.doesNotMatch(migration, /drop table|delete from|truncate/i);
  assert.match(cron, /Bearer \$\{secret\}/);
  assert.match(cron, /runRollingPlanAutomation/);
  assert.match(vercel, /0 3 \* \* \*/);
  assert.match(planRoute, /export async function POST/);
  assert.doesNotMatch(automation + service + cron, /instagram_publish_jobs|META_|spend|send_campaign/);
});

test("every workflow date resolves through the account timezone, never a hardcoded date", async () => {
  const tz = await import("../lib/voom/timezone.ts");
  assert.equal(tz.accountTimezone(null), "Asia/Dubai");
  assert.equal(tz.accountTimezone("  "), "Asia/Dubai");
  assert.equal(tz.accountTimezone("not a zone"), "Asia/Dubai");
  assert.equal(tz.accountTimezone("Europe/London"), "Europe/London");
  // 20:30 UTC is already the next local day in Dubai.
  assert.equal(tz.localDate(new Date("2026-09-12T19:59:00Z")), "2026-09-12");
  assert.equal(tz.localDate(new Date("2026-09-12T20:00:00Z")), "2026-09-13");
  assert.equal(tz.localToUtcIso("2026-09-12", 18 * 60 + 30), "2026-09-12T14:30:00.000Z");
  assert.equal(tz.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(tz.daysBetween("2026-09-12", "2026-09-19"), 7);
  assert.equal(tz.relativeDayLabel("2026-09-12", new Date("2026-09-12T06:00:00Z")), "Today");
  assert.equal(tz.relativeDayLabel("2026-09-13", new Date("2026-09-12T06:00:00Z")), "Tomorrow");
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

test("Autopilot auto-approval runs the one safety evaluator and clears Approvals", async () => {
  const [automation, service, tools, migration, board] = await Promise.all([
    read("lib/voom/weekly-automation.ts"), read("lib/voom/workflow/service.ts"), read("lib/mara/tools.ts"),
    read("supabase/migrations/0015_autopilot_internal_approval.sql"), read("components/voom/operating/ApprovalsBoard.tsx"),
  ]);
  assert.match(service, /evaluateAutopilotRecommendation/);
  assert.match(service, /deterministicSafetyChecks: "passed"/);
  assert.match(service, /eq\("owner_user_id", input\.ownerId\)/);
  // Safely auto-approved items do not stay sitting in Approvals.
  assert.match(service, /status: "confirmed"/);
  // Risky content is never auto-approved; it is held for review.
  assert.match(service, /if \(!safety\.safe\) return \{ approved: false/);
  assert.match(tools, /onConflict: "owner_user_id,source_draft_id"|createCalendarItem/);
  assert.match(migration, /grant insert, update on table public\.content_calendar_items to service_role/);
  assert.match(board, /Autopilot approved/);
  assert.doesNotMatch(service + automation, /META_|send_campaign|ad spend/i);
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

test("Reel choices reuse persisted drafts and approval actions without duplicating state", async () => {
  const [service, tools, route, board, today] = await Promise.all([
    read("lib/voom/workflow/service.ts"), read("lib/mara/tools.ts"),
    read("app/api/mara/actions/[id]/route.ts"), read("components/voom/operating/ApprovalsBoard.tsx"),
    read("lib/voom/operating-data.ts"),
  ]);
  assert.match(service, /draftKindForContentType/);
  assert.match(tools, /classifyReelProduction/);
  assert.match(tools, /choose_reel_production/);
  assert.match(route, /productionStatusFor/);
  assert.match(route, /eq\("owner_user_id", user\.id\)/);
  assert.match(board, /Create with MARA/);
  assert.match(board, /Nothing has been published externally/);
  assert.match(today, /reelTaskCount/);
});

test("Reel assets are signature-validated and use one private owner-scoped record", async () => {
  const { detectReelAsset, REEL_ASSET_MAX_BYTES, safeAssetName } = await import("../lib/media/reel-asset.ts");
  assert.equal(detectReelAsset(Uint8Array.from([0xff, 0xd8, 0xff]))?.mimeType, "image/jpeg");
  assert.equal(detectReelAsset(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))?.mimeType, "image/png");
  assert.equal(detectReelAsset(new TextEncoder().encode("RIFFxxxxWEBP"))?.mimeType, "image/webp");
  // A structurally valid ISO-BMFF container solves the brand vs extension
  // question with the filename, so an Apple `qt`-branded MP4 stays MP4.
  const brand = (s) => { const out = new Uint8Array(4); for (let i = 0; i < 4; i++) out[i] = s.charCodeAt(i) || 0x20; return out; };
  const ftyp = (major, compat = []) => {
    const size = 16 + 4 * compat.length; const bytes = new Uint8Array(size);
    bytes[0] = (size >> 24) & 0xff; bytes[1] = (size >> 16) & 0xff; bytes[2] = (size >> 8) & 0xff; bytes[3] = size & 0xff;
    bytes.set(new TextEncoder().encode("ftyp"), 4); bytes.set(brand(major), 8);
    compat.forEach((c, i) => bytes.set(brand(c), 16 + i * 4)); return bytes;
  };
  const qtMp4 = ftyp("qt  ", ["isom"]);
  assert.equal(detectReelAsset(qtMp4)?.mimeType, "video/mp4", "no .mov hint means MP4, never rewritten to MOV");
  assert.equal(detectReelAsset(qtMp4, { name: "SYNRAPAY_REEL_FINAL.mp4" })?.mimeType, "video/mp4");
  assert.equal(detectReelAsset(qtMp4, { name: "clip.mov" })?.mimeType, "video/quicktime");
  assert.equal(detectReelAsset(new TextEncoder().encode("not media")), null);
  assert.equal(REEL_ASSET_MAX_BYTES, 4194304);
  assert.equal(safeAssetName("../unsafe/name.mov"), "..-unsafe-name.mov");
  const [route, helper, migration, migrationPack, board, today] = await Promise.all([
    read("app/api/reels/assets/[actionId]/route.ts"), read("lib/media/reel-asset-server.ts"),
    read("supabase/migrations/0016_reel_draft_assets.sql"), read("supabase/migrations/0017_reel_asset_pack.sql"),
    read("components/voom/operating/ApprovalsBoard.tsx"), read("lib/voom/operating-data.ts"),
  ]);
  assert.match(route + helper, /eq\("owner_user_id", user\.id\)/);
  assert.match(route, /detectReelAsset\(bytes, \{ name: file\.name \}\)/);
  assert.match(helper, /createSignedUrl/);
  assert.match(route, /randomUUID\(\)/);
  assert.doesNotMatch(route, /NEXT_PUBLIC.*SECRET|publish|instagram|generateVideo/);
  assert.match(migration, /unique \(owner_user_id, draft_id\)/);
  assert.match(migration, /reel_draft_assets_select_own/);
  assert.match(migration, /revoke all.*anon, authenticated/);
  assert.match(migration, /replace_reel_draft_asset/);
  assert.match(migration, /Ready for future MARA production/);
  assert.match(migrationPack, /drop constraint if exists reel_draft_assets_owner_user_id_draft_id_key/);
  assert.match(board, /Replace asset/);
  assert.match(today, /"ready_for_mara_production", "produced"/);
});

test("Create with MARA persists a playable truthful Reel composition without publishing", async () => {
  const { buildReelComposition, isReelComposition } = await import("../lib/mara/reel-composition.ts");
  const textOnly = buildReelComposition({ concept: "Three coffee tips", caption: "Coffee tips", brandName: "Synthetic Café", usesAsset: false, producedAt: "2026-08-29T12:00:00.000Z", viewerCopy: { hook: "Three coffee tips", message: "Store beans airtight.", value: "Keep them away from heat.", cta: "Follow for more tips." } });
  assert.equal(textOnly.aspectRatio, "9:16");
  assert.equal(textOnly.durationMs, 11500);
  assert.equal(textOnly.scenes.length, 4);
  assert.deepEqual(textOnly.scenes.map((scene) => scene.role), ["hook", "message", "value", "cta"]);
  assert.equal(textOnly.scenes[0].role, "hook");
  assert.equal(textOnly.scenes[3].role, "cta");
  assert.equal(textOnly.usesAsset, false);
  assert.equal(isReelComposition(textOnly), true);
  const assisted = buildReelComposition({ concept: "Storefront tour", caption: "Visit us", brandName: "Synthetic Café", usesAsset: true, viewerCopy: { hook: "Come inside", message: "Visit us in store", value: "More from Synthetic Café", cta: "Follow Synthetic Café" } });
  assert.equal(assisted.usesAsset, true);
  const [route, player, board, today] = await Promise.all([
    read("app/api/reels/produce/[actionId]/route.ts"), read("components/voom/operating/ReelCompositionPlayer.tsx"),
    read("components/voom/operating/ApprovalsBoard.tsx"), read("lib/voom/operating-data.ts"),
  ]);
  assert.match(route, /eq\("owner_user_id", user\.id\)/);
  assert.match(route, /reel_draft_assets/);
  assert.match(route, /productionStatus: "preparing"/);
  assert.match(route, /productionStatus: "producing"/);
  assert.match(route, /productionStatus: "produced"/);
  assert.match(route, /already produced and ready for review/);
  assert.doesNotMatch(route + player, /instagram|publish_jobs|generateVideo|setTimeout/);
  assert.match(player, /Live Voom composition/);
  assert.match(player, /Play Reel/);
  assert.match(player, /aspect-\[9\/16\]/);
  assert.match(board, /Ready for review/);
  assert.match(today, /"ready_for_mara_production", "produced"/);
});

test("the rolling plan creates one cadence-driven executable item per slot, never a fixed three", async () => {
  const cadence = await import("../lib/voom/cadence.ts");
  const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
  assert.equal(cadence.normalizeCadence("Daily"), "daily");
  assert.equal(cadence.normalizeCadence("2–3 times a week"), "3x_week");
  assert.equal(cadence.normalizeCadence("A few times a month"), "weekly");
  assert.equal(cadence.normalizeCadence(null), "3x_week");
  assert.equal(cadence.slotDates("2026-09-12", "daily").length, 7);
  assert.equal(cadence.slotDates("2026-09-12", "5x_week").length, 5);
  assert.equal(cadence.slotDates("2026-09-12", "3x_week").length, 3);
  assert.deepEqual(cadence.slotDates("2026-09-12", "weekly"), ["2026-09-12"]);
  // The horizon always begins on the supplied current local date.
  assert.equal(cadence.slotDates("2026-09-12", "3x_week")[0], "2026-09-12");

  const slots = rolling.buildSlots({
    now: new Date("2026-09-12T05:00:00Z"), timeZone: "Asia/Dubai",
    cadence: "daily", mode: "autopilot", goal: "awareness",
  });
  assert.equal(slots.length, 7);
  assert.equal(slots[0].date, "2026-09-12");
  // No slot may be scheduled in the past.
  for (const slot of slots) assert.ok(Date.parse(slot.publishAt) > Date.parse("2026-09-12T05:00:00Z"));

  const [service, route, migration, workspace] = await Promise.all([
    read("lib/voom/workflow/service.ts"), read("app/api/plan/route.ts"),
    read("supabase/migrations/0013_weekly_plan_recommendations.sql"), read("components/voom/operating/PlanWorkspace.tsx"),
  ]);
  assert.match(service, /source_plan_item_key: slot\.date/);
  assert.match(service, /ignoreDuplicates: true/);
  assert.match(route, /runOwnerWorkflow/);
  assert.match(migration, /unique \(owner_user_id, source_plan_id, source_plan_item_key\)/);
  assert.match(workspace, /Posting frequency/);
  assert.doesNotMatch(workspace, /3 Instagram recommendations/);
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
