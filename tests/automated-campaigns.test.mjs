/**
 * Automated Campaigns v1 — behavioural + safety suite.
 *
 * Pure modules (planner, status) are executed for real through the
 * server-only/@ alias shim. Provider-touching layers are asserted on source
 * text, matching the rest of this suite — generation must never import a
 * sender, publish queue, media provider, paid media path, or cron.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const plannerReady = import("../lib/campaign/planner.ts");
const statusReady = import("../lib/campaign/status.ts");
const typesReady = import("../lib/campaign/types.ts");

/** Comments are documentation, not code paths: provider checks scan code only. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*(\/\/|--).*$/gm, "");

const NOW = new Date("2026-09-20T12:00:00.000Z");
const START = "2026-09-22";
const END_10 = "2026-10-01";

const brief10 = {
  name: "Autumn Launch",
  goal: "drive_sales",
  startAt: START,
  endAt: END_10,
};

// ─── Generation: dynamic, multi-channel, complete drafts ──────────────────

test("a simple brief builds an ordered, multi-action email + Instagram campaign", async () => {
  const { planCampaign } = await plannerReady;
  const { CAMPAIGN_ACTION_CHANNELS } = await typesReady;
  const plan = planCampaign({ brief: brief10, now: NOW });

  assert.ok(plan.actions.length >= 5, "a 10-day sales campaign has multiple actions");
  const channels = new Set(plan.actions.map((a) => a.channel));
  assert.ok(channels.has("email"), "the plan includes emails");
  assert.ok([...channels].some((c) => c.startsWith("instagram_")), "the plan includes Instagram");
  for (const channel of channels) {
    assert.ok((CAMPAIGN_ACTION_CHANNELS).includes(channel), `planned channel ${channel} is an active channel`);
  }

  // Slots are contiguous and the timeline is strictly time-ordered.
  plan.actions.forEach((action, index) => assert.equal(action.slot, index));
  const times = plan.actions.map((a) => Date.parse(a.scheduledFor));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] >= times[i - 1], "actions are ordered earliest-first");
  }
  for (const action of plan.actions) {
    assert.ok(Number.isFinite(Date.parse(action.scheduledFor)), "every action has a real proposed time");
    assert.ok(["awareness", "consideration", "conversion", "retention"].includes(action.stage));
    assert.ok(action.purpose.length > 0, "every action explains its purpose/stage");
    assert.ok(action.title.length > 0);
  }
});

test("SMS can never be a planned action — active channels are Email + Instagram only", async () => {
  const { planCampaign } = await plannerReady;
  for (const goal of ["promote_product", "drive_sales", "announce", "re_engage", "awareness"]) {
    const plan = planCampaign({ brief: { ...brief10, goal }, now: NOW });
    for (const action of plan.actions) {
      assert.notEqual(action.channel, "sms");
      assert.ok(!/sms|text message/i.test(action.title + action.purpose));
    }
  }
  const types = await read("lib/campaign/types.ts");
  const channelBlock = types.match(/CAMPAIGN_ACTION_CHANNELS = \[[\s\S]*?\]/)?.[0] ?? "";
  assert.match(channelBlock, /"email",\s*\n\s*"instagram_post",\s*\n\s*"instagram_reel",\s*\n\s*"instagram_story"/);
  assert.doesNotMatch(channelBlock, /sms/);
  // The database check constraint allows the same four channels and no SMS.
  const migration = await read("supabase/migrations/0033_automated_campaigns.sql");
  assert.match(migration, /channel in \(\s*'email', 'instagram_post', 'instagram_reel', 'instagram_story'\s*\)/);
  // Historical SMS campaigns stay readable: the container kind check keeps
  // 'sms' (no destructive migration), but the action channel list excludes it.
  assert.match(migration, /check \(kind in \('email', 'sms', 'multi'\)\)/);
});

test("planned emails are complete drafts: subject, preview, body, CTA, audience and timing", async () => {
  const { planCampaign } = await plannerReady;
  const plan = planCampaign({
    brief: { ...brief10, targetAudience: "Dubai boutique shoppers" },
    audiences: [{ id: "11111111-1111-1111-1111-111111111111", name: "VIP", eligibleEmailCount: 4 }],
    now: NOW,
  });
  const emails = plan.actions.filter((a) => a.channel === "email");
  assert.ok(emails.length >= 2);
  for (const email of emails) {
    assert.ok((email.subject ?? "").length > 5, "subject present");
    assert.ok((email.previewText ?? "").length > 0, "preview text present");
    assert.ok((email.body ?? "").length > 40, "real body present");
    assert.match(email.body, /CTA:\s*\S+/, "body carries an explicit CTA line");
    assert.ok((email.cta ?? "").length > 0, "structured CTA present");
    assert.ok(Number.isFinite(Date.parse(email.scheduledFor)), "proposed send time present");
    assert.equal(email.audienceId, "11111111-1111-1111-1111-111111111111", "the owned audience is attached");
  }
});

test("the mix is generated dynamically from goal and timeframe — no hard-coded example", async () => {
  const { planCampaign, channelMix, campaignSpanDays } = await plannerReady;

  assert.equal(campaignSpanDays(START, END_10), 10);

  // Timeframe changes the volume.
  const one = planCampaign({ brief: { ...brief10, startAt: START, endAt: START }, now: NOW });
  const three = planCampaign({ brief: { ...brief10, startAt: START, endAt: "2026-09-24" }, now: NOW });
  const ten = planCampaign({ brief: brief10, now: NOW });
  assert.ok(one.actions.length <= 2, "a 1-day campaign is compact");
  assert.ok(three.actions.length < ten.actions.length, "a 3-day campaign is smaller than a 10-day");

  // Goals produce different mixes (counts come from the rules, not one template).
  const byGoal = Object.fromEntries(
    ["promote_product", "drive_sales", "announce", "re_engage", "awareness"].map((goal) => {
      const plan = planCampaign({ brief: { ...brief10, goal }, now: NOW });
      return [goal, {
        email: plan.actions.filter((a) => a.channel === "email").length,
        instagram: plan.actions.filter((a) => a.channel !== "email").length,
      }];
    }),
  );
  assert.ok(byGoal.re_engage.email >= byGoal.announce.email, "re-engagement leans on email");
  assert.ok(byGoal.awareness.instagram >= byGoal.re_engage.instagram, "awareness leans on Instagram");
  assert.notDeepEqual(byGoal.drive_sales, byGoal.announce);

  // Bounds are respected regardless of span.
  const long = planCampaign({ brief: { ...brief10, startAt: START, endAt: "2026-11-07" }, now: NOW });
  assert.ok(long.actions.length <= 16, "at most MAX_CAMPAIGN_ACTIONS");
  assert.ok(long.actions.filter((a) => a.channel === "email").length <= 4, "at most 4 emails");
  assert.equal(channelMix("drive_sales", 47).email <= 4, true);
});

test("planning is deterministic and idempotent: same brief yields the identical plan", async () => {
  const { planCampaign } = await plannerReady;
  const a = planCampaign({ brief: brief10, now: NOW });
  const b = planCampaign({ brief: { ...brief10 }, now: new Date(NOW.getTime()) });
  assert.deepEqual(b, a);
});

test("performance evidence is advisory and never faked", async () => {
  const { planCampaign } = await plannerReady;
  const without = planCampaign({ brief: brief10, performance: null, now: NOW });
  assert.equal(without.summary.performanceUsed, false);
  assert.equal(without.summary.performanceNote, null);

  const withPerf = planCampaign({
    brief: brief10,
    now: NOW,
    performance: {
      sampleSize: 12,
      confidence: "moderate",
      bestContentTypeLabel: "Reels",
      winnerLabels: ["Reel", "Instagram post"],
      engagementSignals: [],
    },
  });
  assert.equal(withPerf.summary.performanceUsed, true);
  assert.match(withPerf.summary.performanceNote ?? "", /advisory/i);
  // Advisory input never invents channels or breaks the action cap.
  assert.ok(withPerf.actions.length === without.summary.emailCount + without.summary.instagramCount
    || withPerf.actions.length <= 16);
});

test("the compact summary reflects the actual generated structure", async () => {
  const { planCampaign } = await plannerReady;
  const plan = planCampaign({ brief: brief10, now: NOW });
  assert.match(plan.summary.narrative, new RegExp(`MARA created a 10-day`));
  assert.match(plan.summary.narrative, new RegExp(`${plan.summary.instagramCount} Instagram action`));
  assert.match(plan.summary.narrative, new RegExp(`${plan.summary.emailCount} email`));
});

// ─── Autopilot safety is carried through generation ───────────────────────

test("every action carries the existing Autopilot safety evaluation", async () => {
  const { planCampaign } = await plannerReady;

  // A short announcement starting in ~2 days: every action is inside the
  // safety evaluator's scheduling window and the copy is clean.
  const safePlan = planCampaign({
    brief: { name: "Studio news", goal: "announce", startAt: START, endAt: "2026-09-24" },
    now: NOW,
  });
  assert.ok(safePlan.actions.length >= 2);
  for (const action of safePlan.actions) {
    assert.equal(action.autopilotSafe, true, `${action.title} should be autopilot-safe`);
    assert.deepEqual(action.autopilotBlockers, []);
  }

  // An unsupported price offer flags the existing blockers — the build layer
  // must keep those actions in review even in Autopilot.
  const riskyPlan = planCampaign({
    brief: { name: "Autumn Launch", goal: "drive_sales", startAt: START, endAt: "2026-09-24", offerDetails: "50% off everything" },
    now: NOW,
  });
  const blocked = riskyPlan.actions.filter((a) => !a.autopilotSafe);
  assert.ok(blocked.length > 0, "price/discount actions are not autopilot-safe");
  assert.ok(blocked.some((a) => a.autopilotBlockers.includes("unsupported_offer")));
});

test("automation modes gate only approval state — Manual proposes, Assisted gates, Autopilot approves safe actions", async () => {
  const server = await read("lib/campaign/server.ts");
  // The single gating expression encodes all three modes.
  assert.match(server, /mode === "autopilot" && action\.autopilotSafe\s*\?\s*"approved"\s*:\s*mode === "manual"\s*\?\s*"proposed"\s*:\s*"needs_approval"/);
  // Nothing in the build can select an "executed"/"sent"/"published" state.
  assert.doesNotMatch(server, /status:\s*"(executed|sending)"/);
  // Persisted action statuses accepted by the RPC are review states only.
  const migration = await read("supabase/migrations/0033_automated_campaigns.sql");
  assert.match(migration, /v_status not in \('proposed', 'needs_approval', 'approved'\)/);
});

// ─── Lifecycle derivation (pure, provider-free) ───────────────────────────

test("action execution states are derived from real child/queue state, never faked", async () => {
  const { deriveActionState } = await statusReady;
  const emailFacts = (overrides = {}) => ({
    kind: "email", planStatus: "proposed", childStatus: "draft", sendStatus: null,
    scheduledFor: "2026-09-25T09:00:00+04:00", ...overrides,
  });
  assert.equal(deriveActionState(emailFacts()), "proposed");
  assert.equal(deriveActionState(emailFacts({ planStatus: "needs_approval" })), "needs_approval");
  assert.equal(deriveActionState(emailFacts({ childStatus: "approved" })), "approved");
  assert.equal(deriveActionState(emailFacts({ childStatus: "approved", sendStatus: "sending" })), "executing");
  assert.equal(deriveActionState(emailFacts({ childStatus: "approved", sendStatus: "accepted" })), "executed");
  assert.equal(deriveActionState(emailFacts({ childStatus: "approved", sendStatus: "delivered" })), "executed");
  assert.equal(deriveActionState(emailFacts({ childStatus: "approved", sendStatus: "failed" })), "failed");
  assert.equal(deriveActionState(emailFacts({ childStatus: "rejected" })), "skipped");
  assert.equal(deriveActionState(emailFacts({ childStatus: null })), "failed", "a missing child row is not hidden");

  const igFacts = (overrides = {}) => ({
    kind: "instagram", planStatus: "proposed", draftStatus: "draft", queueStatus: null,
    scheduledFor: "2026-09-25T19:00:00+04:00", ...overrides,
  });
  assert.equal(deriveActionState(igFacts()), "proposed");
  assert.equal(deriveActionState(igFacts({ planStatus: "needs_approval" })), "needs_approval");
  assert.equal(deriveActionState(igFacts({ draftStatus: "approved" })), "approved");
  assert.equal(deriveActionState(igFacts({ draftStatus: "approved", queueStatus: "waiting_for_media" })), "scheduled");
  assert.equal(deriveActionState(igFacts({ draftStatus: "approved", queueStatus: "scheduled" })), "scheduled");
  assert.equal(deriveActionState(igFacts({ draftStatus: "approved", queueStatus: "publishing" })), "executing");
  assert.equal(deriveActionState(igFacts({ draftStatus: "approved", queueStatus: "published" })), "executed");
  assert.equal(deriveActionState(igFacts({ draftStatus: "approved", queueStatus: "failed" })), "failed");
  assert.equal(deriveActionState(igFacts({ draftStatus: "approved", queueStatus: "cancelled" })), "skipped");
  assert.equal(deriveActionState(igFacts({ draftStatus: "rejected" })), "skipped");
  assert.equal(deriveActionState(igFacts({ draftStatus: null })), "failed");
});

test("campaign lifecycle is derived from action states — there is no manual lifecycle toggle", async () => {
  const { deriveCampaignLifecycle, lifecycleLabel } = await statusReady;
  const when = "2026-09-25T09:00:00+04:00";
  const email = (state) => {
    const map = {
      proposed: { childStatus: "draft", sendStatus: null },
      needs_approval: { planStatus: "needs_approval", childStatus: "draft", sendStatus: null },
      approved: { childStatus: "approved", sendStatus: null },
      scheduled: { kind: "instagram", draftStatus: "approved", queueStatus: "scheduled" },
      executed: { childStatus: "approved", sendStatus: "delivered" },
      skipped: { childStatus: "rejected", sendStatus: null },
      failed: { childStatus: "approved", sendStatus: "failed" },
    };
    const base = state === "scheduled"
      ? { kind: "instagram", planStatus: "approved", draftStatus: "approved", queueStatus: "scheduled" }
      : { kind: "email", planStatus: "approved", ...map[state] };
    return { scheduledFor: when, ...base };
  };

  assert.equal(deriveCampaignLifecycle({ actions: [], startAt: null, endAt: null }), "draft");
  assert.equal(deriveCampaignLifecycle({ actions: [], startAt: null, endAt: null, building: true }), "building");
  assert.equal(deriveCampaignLifecycle({ actions: [email("needs_approval")], startAt: "2026-10-01T00:00:00+04:00", endAt: "2026-10-10T23:59:00+04:00", now: NOW }), "needs_approval");
  assert.equal(
    deriveCampaignLifecycle({ actions: [email("approved"), email("scheduled")], startAt: "2026-10-01T00:00:00+04:00", endAt: "2026-10-10T23:59:00+04:00", now: NOW }),
    "scheduled",
  );
  const executed = { ...email("executed"), scheduledFor: "2026-09-22T09:00:00+04:00" };
  const upcoming = { ...email("approved"), scheduledFor: "2026-09-28T09:00:00+04:00" };
  assert.equal(
    deriveCampaignLifecycle({
      actions: [executed, upcoming],
      startAt: "2026-09-20T00:00:00+04:00", endAt: "2026-10-10T23:59:00+04:00",
      now: new Date("2026-09-25T12:00:00+04:00"),
    }),
    "active",
  );
  assert.equal(
    deriveCampaignLifecycle({ actions: [email("executed"), email("skipped")], startAt: "2026-09-01T00:00:00+04:00", endAt: "2026-09-10T23:59:00+04:00", now: NOW }),
    "completed",
  );
  assert.equal(
    deriveCampaignLifecycle({ actions: [email("failed"), email("proposed")], startAt: "2026-10-01T00:00:00+04:00", endAt: "2026-10-10T23:59:00+04:00", now: NOW }),
    "needs_attention",
  );
  // An overdue, unhandled proposal is attention-worthy.
  assert.equal(
    deriveCampaignLifecycle({ actions: [{ ...email("proposed"), scheduledFor: "2026-09-05T09:00:00+04:00" }], startAt: "2026-09-01T00:00:00+04:00", endAt: "2026-09-10T23:59:00+04:00", now: NOW }),
    "needs_attention",
  );
  assert.equal(lifecycleLabel("needs_approval"), "Needs approval");
});

// ─── Generation never touches an external provider ────────────────────────

test("the planner module is provider-free: no DB, server-only, email, Meta, AI media, paid media or cron", async () => {
  const source = stripComments(await read("lib/campaign/planner.ts"));
  assert.doesNotMatch(source, /^import "server-only"/m);
  assert.doesNotMatch(source, /@supabase|createClient|createAdminClient/);
  assert.doesNotMatch(source, /lib\/email|sendEmailCampaign|resend/i);
  assert.doesNotMatch(source, /publish-queue|enqueue|instagram_publish_queue|publishDraft/);
  assert.doesNotMatch(source, /openrouter|generateMedia|mara_media|paid_media|media_generation/i);
  assert.doesNotMatch(source, /cron|pg_cron/);
  // Only its own types and the existing pure safety evaluator are imported.
  assert.match(source, /from "@\/lib\/mara\/autopilot-safety"/);
});

test("the build orchestration and build route never send, publish, generate media or spend", async () => {
  const [serverRaw, routeRaw, migrationRaw] = await Promise.all([
    read("lib/campaign/server.ts"),
    read("app/api/voom/campaigns/build/route.ts"),
    read("supabase/migrations/0033_automated_campaigns.sql"),
  ]);
  for (const [name, source] of [["server", stripComments(serverRaw)], ["route", stripComments(routeRaw)], ["migration", stripComments(migrationRaw)]]) {
    assert.doesNotMatch(source, /sendEmailCampaign|createResendClient|claim_campaign_send/, `${name} never sends email`);
    assert.doesNotMatch(source, /enqueuePublish|instagram_publish_queue\s*\(|insertPublish|publish_instagram/i, `${name} never enqueues Instagram publishing`);
    assert.doesNotMatch(source, /openrouter|generateMedia|mara_media_generations|paid_media|spend_media|media_budget/i, `${name} never generates or spends paid media`);
    assert.doesNotMatch(source, /pg_cron|cron\.schedule/i, `${name} never schedules cron`);
  }
  // Instagram drafts are created without assets; approval reuses the existing
  // Post Studio gate, and the only publish-queue call is a CANCEL on reject.
  assert.match(serverRaw, /postApprovalBlockers/);
  assert.match(serverRaw, /cancelPublishItem/);
  assert.doesNotMatch(stripComments(serverRaw), /enqueue/);
  // Calendar mirrors for autopilot-safe IG rows are created as 'approved'
  // drafts, never scheduled into the publish queue.
  assert.match(stripComments(migrationRaw), /'approved'/);
  assert.doesNotMatch(stripComments(migrationRaw), /insert into public\.instagram_publish_queue/);
});

// ─── Idempotency ──────────────────────────────────────────────────────────

test("repeated builds cannot duplicate containers or actions", async () => {
  const migration = await read("supabase/migrations/0033_automated_campaigns.sql");
  const server = await read("lib/campaign/server.ts");

  // Container uniqueness per owner + build key.
  assert.match(migration, /voom_campaigns_build_idempotency_idx[\s\S]*?on public\.voom_campaigns \(owner_user_id, build_idempotency_key\)/);
  // Action uniqueness: slot per campaign, key per owner, one execution link each.
  assert.match(migration, /unique \(owner_user_id, campaign_id, slot\)/);
  assert.match(migration, /unique \(owner_user_id, idempotency_key\)/);
  assert.match(migration, /unique \(owner_user_id, email_campaign_id\)/);
  assert.match(migration, /unique \(owner_user_id, draft_id\)/);
  // The RPC replays: same owner + key returns the existing container.
  assert.match(migration, /Idempotent replay: same owner \+ same key returns the same container/);
  assert.match(migration, /if found then\s*\n\s*return v_existing;/);
  // Per-action keys are derived from the build key + slot, deterministically.
  assert.match(server, /createHash\("sha256"\)\.update\(`campaign-action:\$\{buildKey\}:\$\{slot\}`\)\.digest\("hex"\)\.slice\(0, 32\)/);
  // The route mints a client key and forwards it.
  const buildRoute = await read("app/api/voom/campaigns/build/route.ts");
  assert.match(buildRoute, /newBuildIdempotencyKey/);
  assert.match(buildRoute, /idempotencyKey: z\.string\(\)\.trim\(\)\.uuid\(\)\.optional\(\)/);
});

// ─── Timeline read model ──────────────────────────────────────────────────

test("the timeline read model orders by slot, is owner-scoped and ignores non-containers", async () => {
  const server = await read("lib/campaign/server.ts");
  assert.match(server, /\.eq\("owner_user_id", ownerId\)\.eq\("campaign_id", id\)\.order\("slot", \{ ascending: true \}\)/);
  assert.match(server, /if \(!container \|\| container\.kind !== "multi"\) return null;/);
  // Live execution state is always derived; it is never written by the builder.
  assert.match(server, /deriveActionState\(/);
  assert.match(server, /deriveCampaignLifecycle\(/);
});

test("per-action decisions change approval state only — email still needs its explicit send", async () => {
  const actionRoute = await read("app/api/voom/campaigns/[id]/actions/[actionId]/route.ts");
  assert.match(actionRoute, /z\.enum\(\["approve", "reject"\]\)/);
  assert.match(actionRoute, /Approving\/rejecting a timeline action changes approval STATE only\. It never\s*\n\s*\/\/ sends an email and never publishes to Instagram\./);
  const server = stripComments(await read("lib/campaign/server.ts"));
  // Email approval delegates to the child campaign approval RPC only.
  assert.match(server, /set_campaign_action_email_approval/);
  assert.doesNotMatch(server, /sendEmailCampaign|\/delivery/);
});

// ─── SMS removal from the active product ──────────────────────────────────

test("the campaign builder offers Email + Instagram with no SMS/channel picker at all", async () => {
  const modal = await read("components/voom/modals/BuildCampaignModal.tsx");
  assert.match(modal, /Build campaign with MARA/);
  assert.match(modal, /name/);
  assert.match(modal, /goal/);
  assert.match(modal, /startDate/);
  assert.match(modal, /endDate/);
  assert.doesNotMatch(modal, /\bSMS\b|\bsms\b|phone|Twilio|ClickSend/);
  // There is no multi-select of channels: the plan always covers both active
  // channels based on goal/dates.
  assert.doesNotMatch(modal, /type="checkbox"/);
  assert.match(modal, /\/api\/voom\/campaigns\/build/);
});

test("campaign creation endpoints cannot create SMS campaigns", async () => {
  const listRoute = await read("app/api/voom/campaigns/route.ts");
  assert.match(listRoute, /kind: z\.literal\("email"\)/);
  const buildRoute = await read("app/api/voom/campaigns/build/route.ts");
  assert.doesNotMatch(buildRoute, /sms|SMS/);
  // Historical SMS rows remain readable through ?kind=sms (read-only archive).
  assert.match(listRoute, /kind !== "email" && kind !== "sms"/);
});

test("historical SMS data stays readable but is archived and cannot be edited or sent", async () => {
  const page = await read("app/app/(shell)/campaigns/page.tsx");
  assert.match(page, /Archived SMS campaigns/);
  assert.match(page, /Read-only · SMS retired/);
  assert.match(page, /kept for your records and cannot be edited or sent/);
  // Automated children never appear as top-level campaigns or search targets.
  const listRoute = await read("app/api/voom/campaigns/route.ts");
  assert.match(listRoute, /!row\.parent_campaign_id/);
  const itemRoute = await read("app/api/voom/campaigns/[id]/route.ts");
  assert.match(itemRoute, /existing\.kind === "sms"/);
  const deliveryRoute = await read("app/api/voom/campaigns/[id]/delivery/route.ts");
  assert.match(deliveryRoute, /campaign\.kind === "sms" \|\| campaign\.kind === "multi"/);
  assert.match(deliveryRoute, /\{ status: 410 \}/);
});

test("MARA never drafts or recommends SMS", async () => {
  const prompt = await read("lib/mara/prompt.ts");
  assert.match(prompt, /SMS marketing is not available in Voom: never draft an SMS, never recommend SMS/);
  assert.doesNotMatch(prompt, /one of "sms"|kind": "sms"|draft email and SMS/);
  // Brand context still reaches the model (the SMS scrub must not remove it).
  assert.match(prompt, /BRAND_CONTEXT_JSON:/);
});
