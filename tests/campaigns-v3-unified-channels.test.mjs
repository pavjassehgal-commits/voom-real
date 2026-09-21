/**
 * Campaigns v3 — the unified multichannel campaign engine.
 *
 * The pure modules (`lib/campaign/types.ts`, `lib/campaign/planner.ts`,
 * `lib/campaign/strategy.ts`, `lib/campaign/status.ts`) are executed for real
 * through the server-only/@ alias shim. Provider-touching layers
 * (`lib/campaign/server.ts`, the routes, migration 0045) are asserted on source
 * text, matching the rest of this suite; the real-database guarantees live in
 * campaigns-v3-pglite.test.mjs.
 *
 * Nothing here calls a provider: no AI, no Resend, no Meta, no OpenRouter, no
 * cron, no paid media, no credit ledger.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const typesReady = import("../lib/campaign/types.ts");
const plannerReady = import("../lib/campaign/planner.ts");
const strategyReady = import("../lib/campaign/strategy.ts");
const statusReady = import("../lib/campaign/status.ts");

/** Comments are documentation, not code paths: provider checks scan code only. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*(\/\/|--).*$/gm, "");

const NOW = new Date("2026-09-20T12:00:00.000Z");
const BRAND = {
  brandName: "SynraPay",
  brandDescription: "Payments for small merchants.",
  industry: "Fintech",
  targetCustomer: ["Small merchants"],
  brandPersonality: ["plain-spoken"],
  mainGoal: "Adopt the new dashboard",
};
const BRIEF = {
  name: "Summer Sale",
  goal: "drive_sales",
  startAt: "2026-09-22",
  endAt: "2026-10-01",
  offerDetails: "",
  targetAudience: "Existing customers",
  notes: "",
};

// ─── 1. The channel model ───────────────────────────────────────────────────

test("a campaign has authoritative channels: the four Multi-Social Core channels", async () => {
  const { CAMPAIGN_CHANNELS, CAMPAIGN_CHANNEL_CHOICES, CAMPAIGN_CHANNEL_LABELS, actionChannelFamily } = await typesReady;

  // Multi-Social Core: one campaign model, four selectable channels.
  assert.deepEqual([...CAMPAIGN_CHANNELS], ["instagram", "tiktok", "youtube", "email"], "the four active channels");
  assert.equal(CAMPAIGN_CHANNELS.length, 4, "no fifth channel product");
  for (const channel of CAMPAIGN_CHANNELS) assert.ok(CAMPAIGN_CHANNEL_LABELS[channel], "every channel has a label");

  // The user-facing choices are the selectable channels themselves — any
  // non-empty combination is a valid campaign, not a fixed set of bundles.
  assert.deepEqual(CAMPAIGN_CHANNEL_CHOICES.map((choice) => choice.id), ["instagram", "tiktok", "youtube", "email"]);
  for (const choice of CAMPAIGN_CHANNEL_CHOICES) {
    for (const channel of choice.channels) assert.ok(CAMPAIGN_CHANNELS.includes(channel));
  }

  // Every action channel maps to exactly one campaign channel.
  assert.equal(actionChannelFamily("email"), "email");
  assert.equal(actionChannelFamily("instagram_post"), "instagram");
  assert.equal(actionChannelFamily("instagram_reel"), "instagram");
  assert.equal(actionChannelFamily("instagram_story"), "instagram");
  assert.equal(actionChannelFamily("tiktok_video"), "tiktok");
  assert.equal(actionChannelFamily("youtube_short"), "youtube");
  assert.equal(actionChannelFamily("youtube_video"), "youtube");
  assert.equal(actionChannelFamily("nonsense"), null, "an invented channel has no family");
});

test("channel validation is one allowlist: empty, unknown, retired and repeated values are refused", async () => {
  const { normalizeCampaignChannels, CAMPAIGN_CHANNELS, LEGACY_DEFAULT_CAMPAIGN_CHANNELS } = await typesReady;

  // Multi-Social Core: no explicit choice keeps the Campaigns v3 behaviour —
  // Instagram + Email. TikTok/YouTube are never selected silently, because a
  // channel whose provider is not connected must be an active user choice.
  assert.deepEqual(normalizeCampaignChannels(undefined), { ok: true, channels: [...LEGACY_DEFAULT_CAMPAIGN_CHANNELS] });
  assert.deepEqual(normalizeCampaignChannels(null), { ok: true, channels: [...LEGACY_DEFAULT_CAMPAIGN_CHANNELS] });
  assert.deepEqual([...LEGACY_DEFAULT_CAMPAIGN_CHANNELS], ["instagram", "email"], "the legacy default is unchanged");

  assert.deepEqual(normalizeCampaignChannels(["instagram"]), { ok: true, channels: ["instagram"] });
  assert.deepEqual(normalizeCampaignChannels(["email"]), { ok: true, channels: ["email"] });
  assert.deepEqual(normalizeCampaignChannels(["tiktok"]), { ok: true, channels: ["tiktok"] });
  assert.deepEqual(normalizeCampaignChannels(["youtube"]), { ok: true, channels: ["youtube"] });
  assert.deepEqual(normalizeCampaignChannels(["email", "instagram"]), { ok: true, channels: ["instagram", "email"] },
    "the stored order is canonical, so the same selection always looks the same");
  assert.deepEqual(normalizeCampaignChannels([" Email ", "INSTAGRAM"]), { ok: true, channels: ["instagram", "email"] },
    "values are normalised, not string-matched blindly");
  assert.deepEqual(
    normalizeCampaignChannels(["youtube", "tiktok", "email", "instagram"]),
    { ok: true, channels: ["instagram", "tiktok", "youtube", "email"] },
    "any non-empty combination of the four channels is one campaign, canonically ordered",
  );

  assert.equal(normalizeCampaignChannels([]).ok, false, "an empty selection is refused");
  assert.equal(normalizeCampaignChannels([]).reason, "empty");
  assert.equal(normalizeCampaignChannels(["instagram", "instagram"]).ok, false, "a repeat is refused");
  assert.equal(normalizeCampaignChannels(["instagram", "email", "email"]).ok, false, "a repeat is refused in a longer list");
  assert.equal(normalizeCampaignChannels(["instagram", "tiktok", "youtube", "email", "instagram"]).ok, false, "more than the four channels is refused");
  assert.equal(normalizeCampaignChannels("instagram").ok, false, "a non-array is refused");
  assert.equal(normalizeCampaignChannels([null]).ok, false, "a null entry is refused");

  // The retired messaging channel is refused by the allowlist itself: it is not
  // a member of CAMPAIGN_CHANNELS, so it can never be selected, planned, stored
  // or executed. There is no denylist to keep in sync.
  const retired = normalizeCampaignChannels(["sms"]);
  assert.equal(retired.ok, false, "the retired channel cannot be selected");
  assert.equal(retired.reason, "unknown_channel");
  assert.equal(normalizeCampaignChannels(["instagram", "sms"]).ok, false);
  assert.equal(normalizeCampaignChannels(["text_message"]).ok, false);
  assert.ok(!CAMPAIGN_CHANNELS.includes("sms"), "the allowlist has no retired channel");
});

test("an action is only allowed on a channel its campaign selected", async () => {
  const { isActionChannelAllowed } = await typesReady;

  assert.equal(isActionChannelAllowed("email", ["instagram", "email"]), true);
  assert.equal(isActionChannelAllowed("instagram_reel", ["instagram"]), true);
  assert.equal(isActionChannelAllowed("email", ["instagram"]), false, "an email action cannot join an Instagram-only campaign");
  assert.equal(isActionChannelAllowed("instagram_post", ["email"]), false, "an Instagram action cannot join an email-only campaign");
  assert.equal(isActionChannelAllowed("sms", ["instagram", "email"]), false, "a retired action channel is never allowed");
  assert.equal(isActionChannelAllowed("", ["instagram"]), false);
  assert.equal(isActionChannelAllowed(null, ["instagram"]), false);
});

test("creation method is modelled separately from the automation mode", async () => {
  const {
    CAMPAIGN_CREATION_METHODS,
    CAMPAIGN_CREATION_METHOD_LABELS,
    normalizeCampaignCreationMethod,
  } = await typesReady;
  const automation = await import("../lib/voom/automation.ts");

  assert.deepEqual([...CAMPAIGN_CREATION_METHODS], ["mara", "self"]);
  // The two vocabularies never overlap: 'manual' is an AUTOMATION MODE, never a
  // creation method, so "Create myself" cannot be confused with Manual mode.
  assert.ok(!CAMPAIGN_CREATION_METHODS.includes("manual"), "creation method never reuses the Manual mode word");
  assert.deepEqual([...automation.AUTOMATION_MODES], ["manual", "assisted", "autopilot"]);
  assert.ok(!automation.AUTOMATION_MODES.includes("self") && !automation.AUTOMATION_MODES.includes("mara"));

  assert.equal(normalizeCampaignCreationMethod("self"), "self");
  assert.equal(normalizeCampaignCreationMethod("mara"), "mara");
  assert.equal(normalizeCampaignCreationMethod(undefined), "mara", "the default is the existing MARA builder");
  assert.equal(normalizeCampaignCreationMethod("manual"), "mara", "an automation-mode word is not a creation method");
  for (const method of CAMPAIGN_CREATION_METHODS) assert.ok(CAMPAIGN_CREATION_METHOD_LABELS[method]);
});

// ─── 2. Planning inside the selected channels ───────────────────────────────

test("an Instagram-only campaign plans Instagram actions and no emails", async () => {
  const { planCampaign, channelMix } = await plannerReady;
  const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["instagram"], now: NOW });

  assert.ok(plan.actions.length >= 4, "the campaign still has a real sequence");
  for (const action of plan.actions) {
    assert.notEqual(action.channel, "email", "no email action is planned");
    assert.ok(action.channel.startsWith("instagram_"), `${action.channel} is an Instagram action`);
  }
  assert.equal(plan.summary.emailCount, 0);
  assert.ok(plan.summary.instagramCount >= 4);
  assert.deepEqual(plan.summary.channels, ["instagram"]);
  assert.match(plan.summary.narrative, /on Instagram/, "the summary says which channel it runs on");
  assert.doesNotMatch(plan.summary.narrative, /and \d+ emails?/, "and never claims email coverage");

  const mix = channelMix("drive_sales", 10, ["instagram"]);
  assert.equal(mix.email, 0);
  assert.ok(mix.posts + mix.reels + mix.stories >= 4, "the freed email slots become Instagram presence");
});

test("an email-only campaign plans emails and no Instagram actions", async () => {
  const { planCampaign, channelMix } = await plannerReady;
  const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["email"], now: NOW });

  assert.ok(plan.actions.length >= 2, "the campaign still has a real sequence");
  for (const action of plan.actions) assert.equal(action.channel, "email");
  assert.equal(plan.summary.instagramCount, 0);
  assert.ok(plan.summary.emailCount >= 2);
  assert.ok(plan.summary.emailCount <= 4, "the no-inbox-flood cap still holds");
  assert.deepEqual(plan.summary.channels, ["email"]);
  assert.match(plan.summary.narrative, /by email/);
  assert.doesNotMatch(plan.summary.narrative, /Instagram action/, "and never claims Instagram coverage");

  // Every email is a complete draft, exactly as in a multichannel campaign.
  for (const action of plan.actions) {
    assert.ok((action.subject ?? "").length > 3, "subject present");
    assert.ok((action.body ?? "").length > 40, "body present");
    assert.match(action.body, /CTA:\s*\S+/, "body carries an explicit CTA line");
    assert.ok((action.cta ?? "").length > 0, "structured CTA present");
  }

  const mix = channelMix("drive_sales", 10, ["email"]);
  assert.deepEqual({ posts: mix.posts, reels: mix.reels, stories: mix.stories }, { posts: 0, reels: 0, stories: 0 });
  assert.ok(mix.email >= 1 && mix.email <= 4);
});

test("an Instagram + Email campaign plans BOTH, exactly as v2 did", async () => {
  const { planCampaign } = await plannerReady;
  const explicit = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["instagram", "email"], now: NOW });
  const implicit = planCampaign({ brief: BRIEF, brand: BRAND, now: NOW });

  // v3 with no explicit choice is byte-identical to v2: existing behaviour is
  // preserved rather than renamed.
  assert.deepEqual(implicit, explicit, "an omitted selection plans both channels");
  assert.ok(implicit.actions.some((action) => action.channel === "email"));
  assert.ok(implicit.actions.some((action) => action.channel.startsWith("instagram_")));
  assert.deepEqual(implicit.summary.channels, ["instagram", "email"]);
});

test("a retired channel can never be planned, whatever a caller passes", async () => {
  const { planCampaign, resolvePlanChannels } = await plannerReady;
  const { CAMPAIGN_ACTION_CHANNELS } = await typesReady;

  assert.deepEqual(resolvePlanChannels(["sms"]), ["instagram", "email"], "an invalid selection is refused, not honoured");
  assert.deepEqual(resolvePlanChannels([]), ["instagram", "email"]);
  assert.deepEqual(resolvePlanChannels(null, { ...BRIEF, channels: ["email"] }), ["email"], "the brief's own selection is used");

  for (const channels of [["instagram"], ["email"], ["instagram", "email"], ["sms"], []]) {
    const plan = planCampaign({ brief: { ...BRIEF, channels }, brand: BRAND, now: NOW });
    for (const action of plan.actions) {
      assert.ok(CAMPAIGN_ACTION_CHANNELS.includes(action.channel), `${action.channel} is an active action channel`);
      assert.notEqual(action.channel, "sms");
      assert.ok(!/sms|text message/i.test(`${action.title} ${action.purpose}`), "no retired channel is mentioned");
    }
    assert.ok(plan.actions.length >= 1, "every valid selection still produces a plan");
    assert.ok(plan.actions.length <= 16, "the action cap holds on every channel mix");
  }
});

test("planning stays deterministic per channel selection", async () => {
  const { planCampaign } = await plannerReady;
  for (const channels of [["instagram"], ["email"], ["instagram", "email"]]) {
    const a = planCampaign({ brief: BRIEF, brand: BRAND, channels, now: NOW });
    const b = planCampaign({ brief: { ...BRIEF }, brand: BRAND, channels: [...channels], now: new Date(NOW.getTime()) });
    assert.deepEqual(b, a, `${channels.join("+")} is reproducible`);
  }
});

test("a single-channel campaign keeps the same timing and slot guarantees", async () => {
  const { planCampaign } = await plannerReady;
  for (const channels of [["instagram"], ["email"], ["instagram", "email"]]) {
    const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels, now: NOW });
    plan.actions.forEach((action, index) => assert.equal(action.slot, index, "slots are contiguous"));
    const times = plan.actions.map((action) => Date.parse(action.scheduledFor));
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] >= times[i - 1], "the timeline is ordered earliest-first");
    }
    for (const action of plan.actions) {
      assert.ok(Date.parse(action.scheduledFor) > NOW.getTime(), "no action is proposed in the past");
      assert.ok(["awareness", "consideration", "conversion", "retention"].includes(action.stage));
      assert.equal(typeof action.autopilotSafe, "boolean", "the existing safety evaluation still runs");
    }
  }
});

// ─── 3. Coordinated multichannel MARA output ────────────────────────────────

test("a two-channel campaign is ONE coordinated sequence, not two unrelated plans", async () => {
  const { planCampaign } = await plannerReady;
  const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["instagram", "email"], now: NOW });
  const families = plan.actions.map((action) => (action.channel === "email" ? "email" : "instagram"));

  // The brief's own example: awareness Instagram content -> email announcement
  // -> reminder Instagram content -> follow-up email.
  assert.equal(families[0], "instagram", "the sequence opens with a visible Instagram moment");
  assert.ok(families.indexOf("email") > 0, "the announcement email follows it");
  assert.ok(families.lastIndexOf("instagram") > families.indexOf("email"), "Instagram carries a reminder after the email");
  assert.ok(families.lastIndexOf("email") > families.indexOf("instagram"), "and email closes with a follow-up");

  // Interleaved, not blocked: at least one switch in each direction.
  const switches = families.filter((family, index) => index > 0 && family !== families[index - 1]).length;
  assert.ok(switches >= 2, `the channels alternate (found ${switches} switches)`);

  // Every stage of the funnel is covered by the campaign as a whole.
  const stages = new Set(plan.actions.map((action) => action.stage));
  assert.ok(stages.has("awareness") && stages.has("conversion"), "the coordinated sequence covers the funnel");
});

test("MARA is told which channels the campaign runs on", async () => {
  const { planCampaign } = await plannerReady;
  const { buildCampaignIntelligenceContext, CAMPAIGN_CHANNEL_RULES } = await strategyReady;

  const contextFor = (channels) => {
    const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels, now: NOW });
    return buildCampaignIntelligenceContext({
      businessName: BRAND.brandName,
      brand: BRAND,
      brief: { ...BRIEF, channels },
      goalLabel: "Drive sales",
      audiences: [],
      selectedAudience: null,
      automationMode: "assisted",
      skeleton: plan.actions,
      summary: plan.summary,
      performance: null,
      channels,
      now: NOW,
    });
  };

  const both = contextFor(["instagram", "email"]);
  assert.deepEqual(both.campaign.selectedChannels, ["instagram", "email"]);
  assert.equal(both.campaign.channelPlan, "multichannel");
  assert.match(both.campaign.channelRules, /ONE coordinated sequence/i);
  assert.deepEqual(both.skeleton.channelsAllowed, ["email", "instagram_post", "instagram_reel", "instagram_story"]);

  const instagramOnly = contextFor(["instagram"]);
  assert.deepEqual(instagramOnly.campaign.selectedChannels, ["instagram"]);
  assert.equal(instagramOnly.campaign.channelPlan, "instagram_only");
  assert.deepEqual(instagramOnly.skeleton.channelsAllowed, ["instagram_post", "instagram_reel", "instagram_story"]);
  assert.ok(instagramOnly.skeleton.slots.every((slot) => slot.channel !== "email"));
  assert.match(instagramOnly.campaign.channelRules, /Instagram ONLY/);
  assert.match(instagramOnly.campaign.channelRules, /Never mention an email/);

  const emailOnly = contextFor(["email"]);
  assert.equal(emailOnly.campaign.channelPlan, "email_only");
  assert.deepEqual(emailOnly.skeleton.channelsAllowed, ["email"]);
  assert.ok(emailOnly.skeleton.slots.every((slot) => slot.channel === "email"));
  assert.match(emailOnly.campaign.channelRules, /email ONLY/);

  // The system prompt binds MARA to the selection and to the coordination rule.
  const { CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT } = await strategyReady;
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /AUTHORITATIVE CHANNELS/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /campaign\.selectedChannels/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /ONE coordinated sequence, not separate plans/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /Follow campaign\.channelRules and campaign\.platformRules exactly/);
  // Multi-Social Core: the prompt teaches platform-native writing — the four
  // channels, never per-platform products, and never a retired channel.
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /PLATFORM DIFFERENCES ARE REAL/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /tiktok_video, youtube_short or youtube_video/);
  assert.doesNotMatch(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /\bsms\b/i, "the prompt never offers a retired channel");
  // Multi-Social Core: one rule set per single-channel plan plus the
  // coordinated multichannel rule — never one rule set per channel PRODUCT.
  assert.ok(Object.keys(CAMPAIGN_CHANNEL_RULES).length === 5);
  for (const key of ["multichannel", "instagram_only", "email_only", "tiktok_only", "youtube_only"]) {
    assert.ok(CAMPAIGN_CHANNEL_RULES[key], `${key} has a rule`);
  }
});

test("MARA can never widen a campaign's channels in the merge", async () => {
  const { planCampaign } = await plannerReady;
  const { applyCampaignIntelligence } = await strategyReady;
  const skeleton = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["instagram"], now: NOW }).actions;

  // A response that tries to turn an Instagram slot into an email slot.
  const hostile = {
    strategy: {
      objective: "Sell the summer collection.",
      coreMessage: "The sale is live.",
      audienceAngle: "Existing customers already know the range.",
      narrative: "Announce, prove, close.",
      ctaStrategy: "One clear shop link.",
      sequenceRationale: "Open wide, then narrow to the offer.",
    },
    actions: skeleton.map((action) => ({
      slot: action.slot,
      channel: "email",
      title: `Replaced ${action.slot}`,
      email: {
        purpose: "Trying to move an Instagram slot onto email.",
        subject: "Unexpected email",
        previewText: "This channel was not selected.",
        body: "Hi,\n\nThis slot belongs to Instagram.\n\nCTA: Shop now",
        cta: "Shop now",
        ctaUrl: null,
        audienceNote: "",
        sendTimeNote: "",
        proposedSendAt: null,
      },
      instagram: null,
    })),
    performanceNote: null,
  };

  const merged = applyCampaignIntelligence({
    skeleton,
    summary: { days: 10, emailCount: 0, postCount: 0, reelCount: 0, storyCount: 0, instagramCount: skeleton.length, narrative: "", performanceUsed: false, performanceNote: null },
    brief: BRIEF,
    brand: BRAND,
    goalLabel: "Drive sales",
    intelligence: hostile,
    channels: ["instagram"],
    now: NOW,
  });

  assert.equal(merged.actions.length, skeleton.length, "no slot was added or dropped");
  for (const action of merged.actions) {
    assert.notEqual(action.channel, "email", "the skeleton's channel wins");
    assert.ok(action.channel.startsWith("instagram_"));
  }
  assert.equal(merged.fallbackSlots.length, skeleton.length, "every refused slot fell back deterministically");
});

test("a deterministic fallback still respects the selected channels", async () => {
  const { planCampaign } = await plannerReady;
  const { applyCampaignIntelligence } = await strategyReady;

  for (const channels of [["instagram"], ["email"], ["instagram", "email"]]) {
    const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels, now: NOW });
    const merged = applyCampaignIntelligence({
      skeleton: plan.actions,
      summary: plan.summary,
      brief: BRIEF,
      brand: BRAND,
      goalLabel: "Drive sales",
      intelligence: null, // the provider was unavailable
      channels,
      now: NOW,
    });
    assert.equal(merged.source, "deterministic");
    assert.equal(merged.actions.length, plan.actions.length);
    for (const action of merged.actions) {
      assert.equal(action.contentSource, "deterministic");
      const family = action.channel === "email" ? "email" : "instagram";
      assert.ok(channels.includes(family), `${action.channel} belongs to a selected channel`);
    }
  }
});

// ─── 4. The unified timeline ────────────────────────────────────────────────

test("the timeline is one chronological list across both channels, bucketed by real state", async () => {
  const { buildCampaignTimeline, TIMELINE_BUCKET_FOR_STATE } = await statusReady;

  const actions = [
    { id: "a3", slot: 2, channel: "instagram_post", title: "Reminder post", scheduled_for: "2026-09-26T15:00:00.000Z", executionState: "approved", canEditContent: true, email_campaign_id: null, draft_id: "d3" },
    { id: "a1", slot: 0, channel: "instagram_reel", title: "Launch reel", scheduled_for: "2026-09-22T14:00:00.000Z", executionState: "executed", canEditContent: false, email_campaign_id: null, draft_id: "d1" },
    { id: "a2", slot: 1, channel: "email", title: "Announcement email", scheduled_for: "2026-09-23T06:00:00.000Z", executionState: "needs_approval", canEditContent: true, email_campaign_id: "c2", draft_id: null },
    { id: "a4", slot: 3, channel: "email", title: "Follow-up email", scheduled_for: "2026-09-28T07:00:00.000Z", executionState: "failed", canEditContent: true, email_campaign_id: "c4", draft_id: null },
  ];

  const timeline = buildCampaignTimeline(actions);
  assert.deepEqual(timeline.entries.map((entry) => entry.actionId), ["a1", "a2", "a3", "a4"], "chronological across both channels");
  assert.deepEqual(timeline.entries.map((entry) => entry.channelFamily), ["instagram", "email", "instagram", "email"]);
  assert.deepEqual(timeline.done.map((entry) => entry.actionId), ["a1"], "what happened");
  assert.deepEqual(timeline.needsApproval.map((entry) => entry.actionId), ["a2"], "what needs approval");
  assert.deepEqual(timeline.scheduled.map((entry) => entry.actionId), ["a3"], "what is scheduled");
  assert.deepEqual(timeline.attention.map((entry) => entry.actionId), ["a4"], "what failed");
  assert.deepEqual(timeline.active, []);
  assert.equal(timeline.next.actionId, "a2", "what comes next is the earliest pending item");

  // Durable identity for Performance Intelligence: campaign -> action -> channel
  // -> external result stays addressable from the timeline alone.
  for (const entry of timeline.entries) {
    assert.ok(entry.actionId, "the action keeps its own identity");
    assert.ok(entry.channel, "and its channel");
    assert.equal(entry.channelFamily === "email" ? Boolean(entry.emailCampaignId) : Boolean(entry.draftId), true,
      "and the external execution identity for its channel");
  }

  // Buckets are a pure projection of the derived execution state.
  assert.equal(TIMELINE_BUCKET_FOR_STATE.executed, "done");
  assert.equal(TIMELINE_BUCKET_FOR_STATE.skipped, "done");
  assert.equal(TIMELINE_BUCKET_FOR_STATE.executing, "active");
  assert.equal(TIMELINE_BUCKET_FOR_STATE.proposed, "needs_approval");
  assert.equal(TIMELINE_BUCKET_FOR_STATE.needs_approval, "needs_approval");
  assert.equal(TIMELINE_BUCKET_FOR_STATE.approved, "scheduled");
  assert.equal(TIMELINE_BUCKET_FOR_STATE.scheduled, "scheduled");
  assert.equal(TIMELINE_BUCKET_FOR_STATE.failed, "attention");

  const empty = buildCampaignTimeline([]);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.next, null, "an empty campaign has nothing next");

  // A slot edit cannot reorder the timeline: time wins, slot breaks the tie.
  const tied = buildCampaignTimeline([
    { id: "b", slot: 5, channel: "email", title: "B", scheduled_for: "2026-09-22T06:00:00.000Z", executionState: "proposed", canEditContent: true, email_campaign_id: "cb", draft_id: null },
    { id: "a", slot: 1, channel: "email", title: "A", scheduled_for: "2026-09-22T06:00:00.000Z", executionState: "proposed", canEditContent: true, email_campaign_id: "ca", draft_id: null },
  ]);
  assert.deepEqual(tied.entries.map((entry) => entry.actionId), ["a", "b"], "slot is the deterministic tie-breaker");
});

test("provider truth is preserved: accepted is not delivered, and publishing is not published", async () => {
  const { deriveActionState, buildCampaignTimeline } = await statusReady;

  const accepted = deriveActionState({
    kind: "email", planStatus: "approved", childStatus: "approved", sendStatus: "accepted", scheduledFor: "2026-09-22T06:00:00.000Z",
  });
  const delivered = deriveActionState({
    kind: "email", planStatus: "approved", childStatus: "approved", sendStatus: "delivered", scheduledFor: "2026-09-22T06:00:00.000Z",
  });
  assert.equal(accepted, "executed", "a provider acceptance reads as executed…");
  assert.equal(delivered, "executed", "…and so does a confirmed delivery");
  assert.notEqual(accepted, "delivered", "but the word delivered is never invented");

  const publishing = deriveActionState({
    kind: "instagram", planStatus: "approved", draftStatus: "approved", hasVisual: true, queueStatus: "publishing", scheduledFor: "2026-09-22T06:00:00.000Z",
  });
  const published = deriveActionState({
    kind: "instagram", planStatus: "approved", draftStatus: "approved", hasVisual: true, queueStatus: "published", scheduledFor: "2026-09-22T06:00:00.000Z",
  });
  assert.equal(publishing, "executing", "publishing is in progress, not done");
  assert.equal(published, "executed", "only a Meta-confirmed publication reads as done");

  const timeline = buildCampaignTimeline([
    { id: "p", slot: 0, channel: "instagram_post", title: "P", scheduled_for: "2026-09-22T06:00:00.000Z", executionState: publishing, canEditContent: false, email_campaign_id: null, draft_id: "dp" },
  ]);
  assert.equal(timeline.entries[0].bucket, "active", "an in-flight publish is not reported as finished");
  assert.equal(timeline.done.length, 0);
});

// ─── 5. Server-side enforcement (source of truth) ───────────────────────────

test("migration 0045 stores the channels, refuses invalid combinations and is additive", async () => {
  const sql = (await read("supabase/migrations/0045_campaigns_v3_unified_channels.sql")).toLowerCase();

  // The authoritative column and its allowlist.
  assert.match(sql, /add column if not exists channels text\[\]/);
  assert.match(sql, /voom_campaigns_channels_check/);
  assert.match(sql, /channels <@ array\['instagram', 'email'\]::text\[\]/);
  assert.match(sql, /voom_campaigns_container_channels_check/);
  assert.match(sql, /check \(kind <> 'multi' or channels is not null\)/);

  // Creation method is its own column with its own vocabulary.
  assert.match(sql, /add column if not exists creation_method text not null default 'mara'/);
  assert.match(sql, /check \(creation_method in \('mara', 'self'\)\)/);
  assert.doesNotMatch(sql, /creation_method in \([^)]*'manual'/, "creation method never stores an automation-mode word");

  // The database itself refuses an action on an unselected channel.
  assert.match(sql, /guard_campaign_action_channel/);
  assert.match(sql, /campaign_action_channel_not_selected/);
  assert.match(sql, /before insert or update of channel, campaign_id, owner_user_id/);

  // The append path for a self-created campaign.
  assert.match(sql, /create or replace function public\.add_campaign_action\(/);
  assert.match(sql, /grant execute on function public\.add_campaign_action\(uuid, uuid, jsonb\) to service_role/);
  assert.match(sql, /revoke all on function public\.add_campaign_action\(uuid, uuid, jsonb\) from public, anon, authenticated/);

  // A self-created campaign is neither MARA nor a fallback in the audit trail.
  assert.match(sql, /check \(provider in \('mara', 'fallback', 'self'\)\)/);
  assert.match(sql, /check \(kind in \('build', 'action_regenerate', 'action_add'\)\)/);

  // Deterministic backfill keeps every existing campaign readable.
  assert.match(sql, /where c\.kind = 'multi'/);
  assert.match(sql, /from public\.voom_campaign_actions a/);
  assert.match(sql, /set channels = array\['email'\]::text\[\]/);
  assert.match(sql, /set creation_method = 'self'/);

  // Additive only.
  assert.doesNotMatch(sql, /drop table/);
  assert.doesNotMatch(sql, /drop column/);
  assert.doesNotMatch(sql, /truncate/);
  assert.doesNotMatch(sql, /alter column [a-z_]+ type/);
  assert.doesNotMatch(sql, /delete from public\./);
  assert.doesNotMatch(sql, /drop constraint if exists voom_campaigns_kind_check/, "the historical kind values stay readable");

  // Nothing external happens.
  assert.doesNotMatch(sql, /insert into public\.instagram_publish_queue/);
  assert.doesNotMatch(sql, /campaign_sends/);
  assert.doesNotMatch(sql, /mara_media_generations|voom_credit_ledger/);
  assert.doesNotMatch(sql, /pg_cron|cron\.schedule/);
  assert.doesNotMatch(sql, /resend|meta\.com|openrouter/i);
  assert.doesNotMatch(sql, /alter table public\.voom_email_flow/, "Email Automation is untouched");
  assert.doesNotMatch(sql, /5\s*(credits|voom credits)|40\s*(credits|voom credits)/i, "media costs are untouched");
});

test("migrations 0001–0045 are untouched and 0046–0047 are the only new ones", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(new URL("supabase/migrations/", root))).filter((name) => name.endsWith(".sql")).sort();

  // The Multi-Social Core (0046) and the YouTube provider (0047) are the only
  // migrations after Campaigns v3; production is still through 0045 until
  // 0046 and 0047 are deliberately applied.
  assert.equal(files[files.length - 1], "0047_youtube_provider.sql", "0047 (YouTube provider) is the newest migration");
  assert.equal(files[files.length - 2], "0046_multi_social_core.sql", "0046 (Multi-Social Core) precedes it");
  assert.equal(files[files.length - 3], "0045_campaigns_v3_unified_channels.sql", "production is still through 0045");
  for (const expected of [
    "0033_automated_campaigns.sql",
    "0034_automated_campaign_shape_check_fix.sql",
    "0036_mara_campaign_intelligence.sql",
    "0037_campaign_action_schedule_guard.sql",
    "0038_campaign_instagram_format_edit.sql",
  ]) assert.ok(files.includes(expected), `${expected} is unchanged and still applied`);
});

test("one creation endpoint serves both paths; a retired channel is refused server-side", async () => {
  const route = await read("app/api/voom/campaigns/build/route.ts");

  // ONE endpoint, two creation paths, one campaign model.
  assert.match(route, /creationMethod: z\.enum\(\["mara", "self"\]\)/);
  assert.match(route, /buildAutomatedCampaign\(/, "the MARA path");
  assert.match(route, /createSelfCampaign\(/, "the create-myself path");
  assert.match(route, /\/api\/voom\/campaigns\/build|export async function POST/);
  assert.doesNotMatch(route, /campaigns\/self|campaigns\/manual|campaigns\/mara/, "no second or third campaign product");

  // Channel validation goes through the one allowlist, never a denylist.
  assert.match(route, /normalizeCampaignChannels\(data\.channels \?\? null\)/);
  assert.match(route, /campaign_channels_invalid/);
  assert.match(route, /\{ status: 422 \}/);
  assert.doesNotMatch(route, /sms|SMS/, "the route never names a retired channel: it is refused by the allowlist");

  // Nothing external is reachable from campaign creation.
  const code = stripComments(route);
  assert.doesNotMatch(code, /sendEmailCampaign|createResendClient|claim_campaign_send/);
  assert.doesNotMatch(code, /enqueuePublish|instagram_publish_queue\s*\(|insertPublish|publish_instagram/i);
  assert.doesNotMatch(code, /openrouter|generateMedia|mara_media_generations|paid_media|spend_media|media_budget/i);
  assert.doesNotMatch(code, /pg_cron|cron\.schedule/i);
});

test("the create-myself path is planning-free, gated like the MARA path, and grants no execution", async () => {
  const server = stripComments(await read("lib/campaign/server.ts"));

  assert.match(server, /export async function createSelfCampaign\(/);
  assert.match(server, /creationMethod: "self"/);
  // The identical automation-mode gating expression is used on both paths, so a
  // self-created campaign gains no approval and no execution permission.
  const gating = /mode === "autopilot" && safe\s*\?\s*"approved"\s*:\s*mode === "manual"\s*\?\s*"proposed"\s*:\s*"needs_approval"/;
  assert.match(server, gating, "create-myself uses the same gating rule");
  assert.match(server, /autopilotEntitled/, "and the same plan/entitlement gate");
  assert.match(server, /evaluateAutopilotRecommendation/, "and the same safety evaluator");

  // Invalid channel/campaign combinations fail server-side, before any write.
  assert.match(server, /isActionChannelAllowed\(action\.channel, channels\)/);
  assert.match(server, /channel_not_selected/);
  assert.match(server, /schedule_outside_campaign/);
  assert.match(server, /checkScheduleInstant\(/, "the existing schedule guard runs on user-written times");

  // No strategy and no generation source is invented for a self-created campaign.
  assert.match(server, /generation_source|No generation layer ran/);
  assert.doesNotMatch(server, /createSelfCampaign[\s\S]{0,4000}generateCampaignIntelligence/, "create-myself calls no provider");

  // Nothing external is reachable.
  assert.doesNotMatch(server, /sendEmailCampaign|createResendClient|claim_campaign_send/);
  assert.doesNotMatch(server, /enqueuePublish|instagram_publish_queue\s*\(|insertPublish|publish_instagram/i);
  assert.doesNotMatch(server, /openrouter|generateMedia|mara_media_generations|paid_media|spend_media|media_budget/i);
  assert.doesNotMatch(server, /guardAndReserveMedia|reserveCredits/, "campaign creation never touches the credit guard");
  assert.doesNotMatch(server, /pg_cron|cron\.schedule/i);
});

test("adding an action reuses the campaign's stored channels and the guarded RPC", async () => {
  const route = await read("app/api/voom/campaigns/[id]/actions/route.ts");
  const server = stripComments(await read("lib/campaign/server.ts"));

  assert.match(route, /addCampaignAction\(/);
  assert.match(route, /channel_not_selected/);
  assert.match(route, /z\.enum\(CAMPAIGN_ACTION_CHANNELS\)/, "only active action channels are accepted");
  assert.match(server, /admin\.rpc\("add_campaign_action"/);
  assert.match(server, /campaignChannelsOf\(container\.channels\)/, "the container's own selection is authoritative");
  assert.match(server, /mode === "autopilot" && safe\s*\?\s*"approved"\s*:\s*mode === "manual"\s*\?\s*"proposed"\s*:\s*"needs_approval"/);
  assert.doesNotMatch(stripComments(route), /sendEmailCampaign|enqueuePublish|guardAndReserveMedia|pg_cron/);
});

test("the read model exposes the channels, the creation method and one unified timeline", async () => {
  const server = await read("lib/campaign/server.ts");
  assert.match(server, /channels,creation_method/, "the container select carries the v3 columns");
  assert.match(server, /buildCampaignTimeline\(/);
  assert.match(server, /creationMethod: normalizeCampaignCreationMethod\(container\.creation_method\)/);
  assert.match(server, /channels: campaignChannelsOf\(container\.channels\)/);

  const timelineRoute = await read("app/api/voom/campaigns/[id]/timeline/route.ts");
  assert.match(timelineRoute, /readAutomatedCampaign\(db, user\.id, id\)/);
  assert.match(timelineRoute, /timeline: view\.timeline/, "one request returns the whole campaign timeline");
  assert.match(timelineRoute, /channels: view\.channels/);
  assert.match(timelineRoute, /creationMethod: view\.creationMethod/);
  assert.doesNotMatch(timelineRoute, /resend|meta\.com|openrouter/i);
});

test("campaign email execution stays on the one Branded Email Engine", async () => {
  const delivery = stripComments(await read("lib/voom/campaign-delivery.ts"));
  const server = stripComments(await read("lib/campaign/server.ts"));

  // The existing engine is the only sender: no second renderer, no second
  // delivery system, and no lifecycle-flow enrolment for a finite campaign.
  assert.match(delivery, /prepareBrandedSend/);
  assert.match(delivery, /dispatchBrandedEmail/);
  assert.match(delivery, /from "@\/lib\/email\/branded\/dispatch"/);
  assert.doesNotMatch(delivery, /createResendClient/);
  assert.doesNotMatch(server, /email-flows|enrollFlow|voom_email_flow_enrollments/,
    "campaign emails never enrol in a Welcome/Re-engagement flow");

  // Campaign email actions keep the child-campaign delivery lifecycle.
  const migration = (await read("supabase/migrations/0045_campaigns_v3_unified_channels.sql")).toLowerCase();
  assert.match(migration, /insert into public\.voom_campaigns/, "an email action is still a child email campaign");
  assert.doesNotMatch(migration, /voom_email_flow/, "and is never routed through an automation flow");
});

test("campaign Instagram execution stays on the existing publishing architecture", async () => {
  const server = stripComments(await read("lib/campaign/server.ts"));
  const migration = (await read("supabase/migrations/0045_campaigns_v3_unified_channels.sql")).toLowerCase();

  // An Instagram action is still an ordinary Post Studio draft.
  assert.match(migration, /insert into public\.mara_drafts/);
  // Approval reuses the Post Studio gate; the only queue call is a cancel.
  assert.match(server, /postApprovalBlockers/);
  assert.match(server, /approvePostDraft/);
  assert.match(server, /cancelPublishItem/);
  assert.doesNotMatch(server, /enqueue|instagram_publish_queue\s*\(/);
  // Connection, tokens, signed media URLs and idempotency are never re-implemented.
  assert.doesNotMatch(server, /instagram_connections|access_token|signedUrl|graph\.facebook\.com/i);
  assert.doesNotMatch(migration, /instagram_publish_queue/);
  assert.doesNotMatch(migration, /instagram_connections|access_token/);
});

test("paid media and credits are untouched by every campaign path", async () => {
  const sources = await Promise.all([
    read("lib/campaign/server.ts"),
    read("lib/campaign/planner.ts"),
    read("lib/campaign/strategy.ts"),
    read("app/api/voom/campaigns/build/route.ts"),
    read("app/api/voom/campaigns/[id]/actions/route.ts"),
    read("app/api/voom/campaigns/[id]/timeline/route.ts"),
    read("supabase/migrations/0045_campaigns_v3_unified_channels.sql"),
  ]);
  for (const source of sources) {
    const code = stripComments(source);
    assert.doesNotMatch(code, /guardAndReserveMedia|reserveCredits|settleCredits|voom_credit_ledger/, "never touches the credit guard or ledger");
    assert.doesNotMatch(code, /openrouter|seedream|seedance|mara_media_generations/i, "never reaches a media provider");
  }
  // Phase 1 costs are unchanged.
  const credits = await read("lib/billing/credits.ts");
  assert.match(credits, /image:\s*5/);
  assert.match(credits, /video:\s*40/);
});

test("one campaign workspace, not one product per channel mix", async () => {
  const page = await read("app/app/(shell)/campaigns/page.tsx");
  const modal = await read("components/voom/modals/BuildCampaignModal.tsx");

  // A single list and a single creation modal.
  assert.match(page, /Your campaigns/);
  assert.match(page, /BuildCampaignModal/);
  assert.equal((page.match(/New campaign/g) ?? []).length >= 1, true);
  assert.doesNotMatch(page, /Instagram campaigns|Email campaigns|Multichannel campaigns/, "no per-channel sections");

  // Both creation paths live in the same modal.
  assert.match(modal, /Create with MARA/);
  assert.match(modal, /Create myself/);
  assert.match(modal, /Build campaign with MARA/);
  assert.match(modal, /Instagram \+ Email/);
  assert.match(modal, /\/api\/voom\/campaigns\/build/, "and both post to the one endpoint");
  assert.doesNotMatch(modal, /\bSMS\b|\bsms\b|phone|Twilio|ClickSend/, "no retired channel is offered");
  assert.doesNotMatch(modal, /type="checkbox"/, "channels are a segmented choice, not a multi-select");
  assert.doesNotMatch(modal, /Manual Campaign|manual campaign/, "creation method never borrows an automation-mode word");

  // The campaign workspace shows the selection and who wrote it.
  const workspace = await read("components/voom/modals/AutomatedCampaignModal.tsx");
  assert.match(workspace, /channelLabel\(view\.channels\)/);
  assert.match(workspace, /CAMPAIGN_CREATION_METHOD_LABELS\[view\.creationMethod\]/);
});
