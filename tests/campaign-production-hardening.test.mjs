import "./helpers/server-only-shim.mjs";

import { futureCampaignFixture } from "./helpers/future-campaign-fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const plannerReady = import("../lib/campaign/planner.ts");
const strategyReady = import("../lib/campaign/strategy.ts");
const scheduleReady = import("../lib/voom/schedule-guard.ts");
const statusReady = import("../lib/campaign/status.ts");

const NOW = new Date("2026-09-20T18:30:00.000Z"); // 22:30 in Asia/Dubai
const BRIEF = { name: "Late launch", goal: "drive_sales", startAt: "2026-09-20", endAt: "2026-09-20" };

function localParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

test("same-day deterministic scheduling uses business-local now plus ten minutes and end-of-day bounds", async () => {
  const { planCampaign } = await plannerReady;
  const plan = planCampaign({ brief: BRIEF, timeZone: "Asia/Dubai", now: NOW });
  assert.ok(plan.actions.length > 0 && plan.actions.length < 4, "late windows reduce the mix instead of compressing it");
  const earliest = NOW.getTime() + 10 * 60_000;
  for (const action of plan.actions) {
    assert.ok(Date.parse(action.scheduledFor) >= earliest, `${action.channel} is not before now + 10 minutes`);
    const local = localParts(action.scheduledFor, "Asia/Dubai");
    assert.equal(local.date, "2026-09-20");
    assert.ok(local.minutes <= 23 * 60 + 59, "action remains before the local end of day");
  }
  for (let i = 1; i < plan.actions.length; i += 1) {
    assert.ok(Date.parse(plan.actions[i].scheduledFor) - Date.parse(plan.actions[i - 1].scheduledFor) >= 60 * 60_000, "late actions retain sensible spacing");
  }
});

test("a non-Dubai workspace resolves date-only slots in its own timezone", async () => {
  const { planCampaign } = await plannerReady;
  const plan = planCampaign({
    brief: { ...BRIEF, startAt: "2026-09-22", endAt: "2026-09-22" },
    timeZone: "America/New_York",
    now: new Date("2026-09-20T12:00:00.000Z"),
  });
  assert.ok(plan.actions.length > 0);
  for (const action of plan.actions) assert.equal(localParts(action.scheduledFor, "America/New_York").date, "2026-09-22");
});

test("MARA cannot return a past same-day time after the deterministic skeleton is built", async () => {
  const { planCampaign } = await plannerReady;
  const { applyCampaignIntelligence } = await strategyReady;
  const skeleton = planCampaign({ brief: BRIEF, now: NOW }).actions;
  const actions = skeleton.map((base) => ({
    slot: base.slot,
    channel: base.channel,
    title: `MARA ${base.title}`,
    email: base.channel === "email" ? {
      purpose: base.purpose, subject: "A safe subject", previewText: "A safe preview", body: "A useful body that is not a duplicate.",
      cta: "Take a look", ctaUrl: null, audienceNote: "Customers", sendTimeNote: "Keeps the sequence clear.",
      proposedSendAt: "2026-09-20T17:00:00+04:00",
    } : null,
    instagram: base.channel === "email" ? null : {
      format: base.channel === "instagram_reel" ? "reel" : base.channel === "instagram_story" ? "story" : "post",
      purpose: base.purpose, concept: "A distinct concept", hook: "A clear hook", caption: `A distinct caption ${base.slot}`,
      cta: "See more", visualDirection: base.channel === "instagram_reel" ? "Film three simple scenes." : "Use a clean branded visual.",
      script: base.channel === "instagram_reel" ? ["Hook", "Benefit", "CTA"] : [], proposedSendAt: "2026-09-20T17:00:00+04:00",
    },
  }));
  const result = applyCampaignIntelligence({
    skeleton,
    summary: { days: 1, emailCount: 1, postCount: 1, reelCount: 0, storyCount: 0, instagramCount: 1, narrative: "", performanceUsed: false, performanceNote: null },
    brief: BRIEF,
    brand: { brandName: "Test Studio" }, goalLabel: "Drive sales", intelligence: {
      strategy: { objective: "Sell", coreMessage: "Useful", audienceAngle: "Relevant", narrative: "Arc", ctaStrategy: "Clear", sequenceRationale: "Spaced" },
      actions, performanceNote: null,
    },
    timeZone: "Asia/Dubai",
    now: NOW,
  });
  assert.ok(result.actions.every((action) => Date.parse(action.scheduledFor) >= NOW.getTime() + 10 * 60_000));
});

test("schedule guard rejects manual campaign edits into the past using the business timezone", async () => {
  const { checkScheduleInstant } = await scheduleReady;
  const result = checkScheduleInstant("2026-09-20T18:35:00.000Z", NOW, "Asia/Dubai", 10);
  assert.equal(result.ok, false);
  assert.equal(result.field, "time");
});

test("missing Instagram media is not an approved/publish-ready action", async () => {
  const { deriveActionState } = await statusReady;
  assert.equal(deriveActionState({
    kind: "instagram", planStatus: "approved", draftStatus: "approved", hasVisual: false, queueStatus: null,
    scheduledFor: "2026-09-22T15:00:00.000Z",
  }), "needs_approval");
  // A real queue waiting for media remains truthful as a queue state.
  assert.equal(deriveActionState({
    kind: "instagram", planStatus: "approved", draftStatus: "approved", hasVisual: false, queueStatus: "waiting_for_media",
    scheduledFor: "2026-09-22T15:00:00.000Z",
  }), "scheduled");
});

test("campaign detail exposes in-place production, media and purpose editing without Create Content handoff", async () => {
  const modal = await read("components/voom/modals/AutomatedCampaignModal.tsx");
  const actionRoute = await read("app/api/voom/campaigns/[id]/actions/[actionId]/route.ts");
  const server = await read("lib/campaign/server.ts");
  assert.match(modal, /Film it myself/);
  assert.match(modal, /Upload media/);
  assert.match(modal, /Create with MARA/);
  assert.match(modal, /label="Purpose"/);
  assert.match(modal, /label="Format"/);
  assert.doesNotMatch(modal, /\/app\/create-content|\/app\/studio/);
  assert.match(actionRoute, /action: z\.literal\("production"\)/);
  assert.match(actionRoute, /format: z\.enum\(\["post", "reel", "story"\]\)/);
  assert.match(server, /campaign-reel-production:/);
  assert.match(server, /checkScheduleInstant\(scheduledFor, new Date\(\), timeZone, 10\)/);
});

test("campaign generation remains planning-only while explicit media uses the central guard", async () => {
  const build = await read("lib/campaign/server.ts");
  const route = await read("app/api/voom/campaigns/build/route.ts");
  assert.doesNotMatch(build, /guardAndReserveMedia|startPostStudioVideo|createMediaProvider|sendEmail|enqueuePublishItem/);
  assert.match(route, /allowAutomaticPaidMedia/);
  const generation = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(generation, /guardAndReserveMedia/);
  assert.match(generation, /plan_not_allowed|canGenerateExplicitMedia/);
});

test("schedule guard migration protects direct retries and format edits are guarded", async () => {
  const scheduleMigration = await read("supabase/migrations/0037_campaign_action_schedule_guard.sql");
  const formatMigration = await read("supabase/migrations/0038_campaign_instagram_format_edit.sql");
  assert.match(scheduleMigration, /new\.scheduled_for < now\(\) \+ interval '10 minutes'/);
  assert.match(scheduleMigration, /campaign_action_after_campaign_end/);
  assert.match(formatMigration, /v_new_channel/);
  assert.match(formatMigration, /post_draft_assets/);
  assert.match(formatMigration, /update public\.voom_campaign_actions/);
});

test("database trigger rejects a past automated action and the guarded writer keeps format state consistent", async () => {
  const { db } = await createSupabaseLite();
  const owner = "11111111-1111-4111-8111-111111111111";
  await db.exec(`insert into auth.users (id, email) values ('${owner}', 'hardening@example.com');`);
  const start = futureCampaignFixture("2026-09-22T00:00:00+04:00");
  const end = futureCampaignFixture("2026-09-22T23:59:00+04:00");
  const scheduled = futureCampaignFixture("2026-09-22T09:00:00+04:00");
  const payload = {
    campaign: {
      idempotencyKey: "11111111-2222-4333-8444-555555555555", name: "Hardening", goal: "announce",
      startAt: start, endAt: end, offerDetails: "", audience: "", audienceId: "", notes: "",
      summary: "A safe plan", strategy: null, strategySummary: "Plan", generationSource: "deterministic", fallbackSlots: [], performanceUsed: false,
    },
    actions: [{
      slot: 0, channel: "instagram_post", stage: "awareness", title: "Post", purpose: "Announce", scheduledFor: scheduled,
      status: "proposed", concept: "A post", caption: "Caption", hashtags: [], idempotencyKey: "11111111-3333-4333-8444-555555555555",
      contentSource: "deterministic", content: { format: "post" }, safetyBlockers: [],
    }],
  };
  const created = await db.query("select id from public.create_automated_campaign($1::uuid, $2::jsonb)", [owner, JSON.stringify(payload)]);
  const campaignId = created.rows[0].id;
  const action = (await db.query("select id,draft_id from public.voom_campaign_actions where campaign_id = $1", [campaignId])).rows[0];
  const patch = {
    format: "reel", title: "Reel", caption: "Reel caption", queueCaption: "Reel caption",
    content: { format: "reel", concept: "Reel", script: ["Hook"], visualDirection: "Film it" },
    contentSource: "edited", safetyBlockers: [],
  };
  await db.query("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [owner, action.id, JSON.stringify(patch)]);
  const changed = (await db.query("select channel from public.voom_campaign_actions where id = $1", [action.id])).rows[0];
  const draft = (await db.query("select kind from public.mara_drafts where id = $1", [action.draft_id])).rows[0];
  assert.equal(changed.channel, "instagram_reel");
  assert.equal(draft.kind, "reel");

  await db.query("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [owner, action.id, JSON.stringify({
    format: "story", title: "Story", caption: "Story caption", queueCaption: "Story caption",
    content: { format: "story", concept: "Story", script: [] }, contentSource: "edited", safetyBlockers: [],
  })]);
  const story = (await db.query("select channel from public.voom_campaign_actions where id = $1", [action.id])).rows[0];
  const storyDraft = (await db.query("select kind from public.mara_drafts where id = $1", [action.draft_id])).rows[0];
  assert.equal(story.channel, "instagram_story");
  assert.equal(storyDraft.kind, "story");

  await db.query("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [owner, action.id, JSON.stringify({
    format: "post", title: "Post again", caption: "Post caption", queueCaption: "Post caption",
    content: { format: "post", concept: "Post again", script: [] }, contentSource: "edited", safetyBlockers: [],
  })]);
  const postAgain = (await db.query("select channel from public.voom_campaign_actions where id = $1", [action.id])).rows[0];
  const postDraft = (await db.query("select kind from public.mara_drafts where id = $1", [action.draft_id])).rows[0];
  assert.equal(postAgain.channel, "instagram_post");
  assert.equal(postDraft.kind, "instagram_post");

  await assert.rejects(
    db.query("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [owner, action.id, JSON.stringify({ scheduledFor: new Date(Date.now() - 60_000).toISOString(), caption: "Past", queueCaption: "Past", content: { format: "post" }, safetyBlockers: [] })]),
    (error) => error?.code === "23514" && /campaign_action_schedule_in_past/.test(String(error?.message)),
  );

  await db.query(`insert into public.post_draft_assets
    (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size, origin, status)
    values ($1, $2, 'owner/format-lock.png', 'format lock', 'image/png', 10, 'uploaded_asset', 'uploaded')`, [owner, action.draft_id]);
  await assert.rejects(
    db.query("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [owner, action.id, JSON.stringify({
      format: "reel", title: "Locked Reel", caption: "Locked", queueCaption: "Locked",
      content: { format: "reel", script: ["Hook"] }, contentSource: "edited", safetyBlockers: [],
    })]),
    (error) => /instagram_format_locked/.test(String(error?.message)),
  );
});
