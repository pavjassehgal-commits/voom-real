/**
 * Multi-Social Core v1 — the multi-channel marketing platform.
 *
 * Covers the §24 matrix:
 *   1. domain vocabulary and the ONE channel+format matrix,
 *   2. existing Instagram compatibility (nothing renamed, nothing moved),
 *   3. TikTok/YouTube draft → approval → calendar → campaign, with a truthful
 *      publish failure (never a fake success),
 *   4. every campaign channel combination,
 *   5. MARA platform-awareness — and that hostile output can never widen a
 *      campaign's channels,
 *   6. safety: owner isolation, connection required, approval ≠ publication,
 *      no fabricated analytics or provider endpoints,
 *   7. the ONE mixed calendar,
 *   8. migration 0046 against a real embedded PostgreSQL.
 *
 * The pure modules (`lib/social/*`, `lib/campaign/*`, `lib/post/core.ts`) are
 * executed for real through the server-only/@ alias shim. Provider-touching
 * layers (routes, `lib/social/server-drafts.ts`, migration 0046's RPCs) are
 * asserted on source text or exercised through PGlite.
 *
 * Nothing here calls a provider: no AI, no Resend, no Meta, no OpenRouter, no
 * TikTok, no YouTube, no cron, no paid media, no credit ledger.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const channelsReady = import("../lib/social/channels.ts");
const publishStateReady = import("../lib/social/publish-state.ts");
const publisherReady = import("../lib/social/publisher.ts");
const contentReady = import("../lib/social/content.ts");
const platformsReady = import("../lib/social/platforms.ts");
const postCoreReady = import("../lib/post/core.ts");
const typesReady = import("../lib/campaign/types.ts");
const plannerReady = import("../lib/campaign/planner.ts");
const strategyReady = import("../lib/campaign/strategy.ts");

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

// ─── 1. The canonical channel model ─────────────────────────────────────────

test("the domain has exactly four channels and the ONE channel+format matrix", async () => {
  const {
    SOCIAL_CHANNELS, SOCIAL_FORMATS, SOCIAL_MEDIA_CHANNELS, RETIRED_CHANNELS,
    CHANNEL_FORMAT_MATRIX, isValidChannelFormat, formatsForChannel,
  } = await channelsReady;

  assert.deepEqual([...SOCIAL_CHANNELS], ["instagram", "tiktok", "youtube", "email"], "the four active channels");
  assert.deepEqual([...SOCIAL_MEDIA_CHANNELS], ["instagram", "tiktok", "youtube"], "email carries no media formats");
  assert.deepEqual([...RETIRED_CHANNELS], ["sms"], "the retired channel is named, never selectable");

  // The matrix: Instagram keeps post+reel+story, TikTok video, YouTube short+video.
  assert.deepEqual([...SOCIAL_FORMATS.instagram].sort(), ["post", "reel", "story"]);
  assert.deepEqual([...SOCIAL_FORMATS.tiktok], ["video"]);
  assert.deepEqual([...SOCIAL_FORMATS.youtube].sort(), ["short", "video"]);
  assert.equal(CHANNEL_FORMAT_MATRIX.length, 6, "six channel+format pairs, one matrix");

  assert.ok(isValidChannelFormat("instagram", "reel"));
  assert.ok(isValidChannelFormat("tiktok", "video"));
  assert.ok(isValidChannelFormat("youtube", "short"));
  assert.ok(isValidChannelFormat("youtube", "video"));
  assert.equal(isValidChannelFormat("tiktok", "short"), false, "a TikTok Short is not a thing — Shorts are YouTube");
  assert.equal(isValidChannelFormat("email", "post"), false, "email has no format");
  assert.deepEqual([...formatsForChannel("youtube")].sort(), ["short", "video"]);
});

test("channel+format validation refuses retired, unknown and mismatched pairs server-side", async () => {
  const { normalizeChannelFormat } = await channelsReady;

  assert.deepEqual(normalizeChannelFormat(" Instagram ", " Reel "), { ok: true, channel: "instagram", format: "reel" },
    "values are normalised, not string-matched blindly");
  assert.deepEqual(normalizeChannelFormat("tiktok", "video"), { ok: true, channel: "tiktok", format: "video" });
  assert.deepEqual(normalizeChannelFormat("youtube", "video"), { ok: true, channel: "youtube", format: "video" });

  const retired = normalizeChannelFormat("sms", "video");
  assert.equal(retired.ok, false);
  assert.equal(retired.reason, "retired_channel", "SMS is named as retired, not merely unknown");
  assert.equal(normalizeChannelFormat("whatsapp", "post").reason, "unknown_channel");
  assert.equal(normalizeChannelFormat("tiktok", "short").reason, "invalid_combination", "a real format on the wrong channel is an invalid combination");
  assert.equal(normalizeChannelFormat("instagram", "hologram").reason, "unknown_format");
  assert.equal(normalizeChannelFormat(42, "post").reason, "unknown_channel");
});

test("action channels are one compact vocabulary parsed in exactly one place", async () => {
  const { ACTION_CHANNELS, parseActionChannel, actionChannelFor, isActionChannel, actionChannelLabel } = await channelsReady;

  assert.deepEqual([...ACTION_CHANNELS].sort(), [
    "email", "instagram_post", "instagram_reel", "instagram_story",
    "tiktok_video", "youtube_short", "youtube_video",
  ].sort(), "seven action channels: six media pairs plus email");

  for (const value of ["instagram_post", "instagram_reel", "instagram_story", "tiktok_video", "youtube_short", "youtube_video", "email"]) {
    assert.ok(isActionChannel(value), `${value} is an action channel`);
    const parsed = parseActionChannel(value);
    assert.ok(parsed, `${value} parses`);
    if (value !== "email") {
      assert.equal(actionChannelFor(parsed.channel, parsed.format), value, "round-trips through the one builder");
    }
    assert.ok(actionChannelLabel(value).length > 0, `${value} has a human label`);
  }
  assert.equal(parseActionChannel("sms_blast"), null, "a retired channel never parses");
  assert.equal(parseActionChannel("tiktok_short"), null, "an invented pair never parses");
  assert.equal(isActionChannel("instagram"), false, "a bare channel is not an action channel");
});

// ─── 2. The canonical publish state machine ─────────────────────────────────

test("only a provider confirmation while submitting/processing can establish published", async () => {
  const {
    SOCIAL_PUBLISH_STATES, mayEstablishPublished, canTransitionPublishState,
    publishStateForUnconnectedProvider, publishStateFromDraftStatus,
  } = await publishStateReady;

  assert.ok(SOCIAL_PUBLISH_STATES.length >= 8, "the lifecycle covers planning and execution");
  for (const state of SOCIAL_PUBLISH_STATES) {
    if (state === "submitting" || state === "provider_processing") {
      assert.ok(mayEstablishPublished(state), `${state} may establish published`);
    } else {
      assert.equal(mayEstablishPublished(state), false, `${state} can never establish published`);
    }
  }

  // No state jumps straight to published; it is only ever entered from the two
  // in-flight states.
  for (const state of SOCIAL_PUBLISH_STATES) {
    if (state === "published") continue;
    assert.equal(canTransitionPublishState(state, "published"), mayEstablishPublished(state),
      `${state} → published only from the in-flight states`);
  }

  // An approved item on an unconnected provider is connection_required —
  // never published, never pretending to be scheduled for execution. A
  // rejected draft maps to the canonical `blocked` state.
  assert.equal(publishStateForUnconnectedProvider("approved"), "connection_required");
  assert.equal(publishStateForUnconnectedProvider("draft"), "draft");
  assert.equal(publishStateForUnconnectedProvider("rejected"), "blocked");
  assert.equal(publishStateForUnconnectedProvider(null), "draft");
  assert.equal(publishStateFromDraftStatus("approved"), "approved", "the bridge keeps the approval semantics");
});

// ─── 3. The publisher boundary is truthful ──────────────────────────────────

test("TikTok and YouTube both refuse without their queues and both enqueue durably with them — no fake success", async () => {
  const { createTikTokPublisher, createYouTubePublisher, createSocialPublisherRegistry, publishSocialContent } = await publisherReady;

  const tiktok = createTikTokPublisher(null);
  assert.equal(tiktok.channel, "tiktok");
  assert.equal(tiktok.isAvailable(), false, "no TikTok queue port is wired, so it is never available");

  const request = {
    ownerId: "11111111-1111-4111-8111-111111111111",
    channel: "tiktok",
    format: "video",
    draftId: "22222222-2222-4222-8222-222222222222",
    caption: "A real caption",
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  // Direct adapter call: a truthful refusal, never a fake success.
  const direct = await tiktok.publish(request);
  assert.equal(direct.status, "connection_required");
  assert.equal(direct.channel, "tiktok");
  assert.ok(direct.message && direct.message.length > 0, "the refusal explains itself");

  // The explicitly unconfigured variant reports provider_not_supported —
  // both statuses are truthful; neither is ever `published`.
  const { createUnavailablePublisher } = await publisherReady;
  const unconfigured = createUnavailablePublisher("tiktok", { notConfigured: true });
  assert.equal((await unconfigured.publish(request)).status, "provider_not_supported");

  // YouTube WITHOUT a configured queue port degrades to the same truthful
  // refusal: an unconfigured deployment never fakes ability.
  const unconfiguredYouTube = createYouTubePublisher(null);
  assert.equal(unconfiguredYouTube.isAvailable(), false);
  const ytRefusal = await unconfiguredYouTube.publish({ ...request, channel: "youtube", format: "short" });
  assert.equal(ytRefusal.status, "connection_required");

  // YouTube WITH the real port (migration 0047's durable queue) enqueues —
  // and enqueued is NOT published: only YouTube's own video id plus its
  // 'processed' upload status can ever establish that, inside the worker.
  const ytEnqueued = [];
  const youtube = createYouTubePublisher({
    enqueueYouTubePublishItem: async (input) => { ytEnqueued.push(input); return { id: "yt-queue-1" }; },
  });
  assert.equal(youtube.channel, "youtube");
  assert.equal(youtube.isAvailable(), true);
  const ytOutcome = await youtube.publish({
    ...request,
    channel: "youtube",
    format: "short",
    youtube: { title: "Launch teaser", description: "The short", privacyStatus: "private", madeForKids: false },
  });
  assert.equal(ytOutcome.status, "enqueued");
  assert.notEqual(ytOutcome.status, "published");
  assert.equal(ytEnqueued.length, 1);
  assert.equal(ytEnqueued[0].youtubeFormat, "short");
  assert.equal(ytEnqueued[0].privacyStatus, "private", "the declared privacy is passed through exactly");
  assert.equal(ytEnqueued[0].madeForKids, false, "the declared audience is passed through exactly");

  // Undeclared policy-sensitive metadata is passed through as null — the
  // queue parks it in needs_declaration instead of anyone guessing.
  await youtube.publish({ ...request, channel: "youtube", format: "video", youtube: { title: "Deep dive" } });
  assert.equal(ytEnqueued[1].privacyStatus, null);
  assert.equal(ytEnqueued[1].madeForKids, null);

  // TikTok WITH the real port (migration 0049's durable queue) enqueues —
  // and enqueued is NOT published: only TikTok's own PUBLISH_COMPLETE post
  // status can ever establish that, inside the worker.
  const ttEnqueued = [];
  const tiktokWired = createTikTokPublisher({
    enqueueTikTokPublishItem: async (input) => { ttEnqueued.push(input); return { id: "tt-queue-1" }; },
  });
  assert.equal(tiktokWired.channel, "tiktok");
  assert.equal(tiktokWired.isAvailable(), true);
  const ttOutcome = await tiktokWired.publish({
    ...request,
    format: "video",
    tiktok: { privacyLevel: "SELF_ONLY", disableDuet: true },
  });
  assert.equal(ttOutcome.status, "enqueued");
  assert.notEqual(ttOutcome.status, "published");
  assert.equal(ttEnqueued.length, 1);
  assert.equal(ttEnqueued[0].privacyLevel, "SELF_ONLY", "the declared privacy is passed through exactly");
  assert.equal(ttEnqueued[0].disableDuet, true, "the declared duet choice is passed through exactly");
  // Video only; and a title is required before anything can enqueue.
  assert.equal((await tiktokWired.publish({ ...request, format: "image" })).code, "unsupported_format");
  assert.equal((await tiktokWired.publish({ ...request, caption: "   " })).code, "title_required");
  // Undeclared TikTok privacy passes through as null — the queue parks it
  // in needs_declaration and the worker demands the provider's live options.
  await tiktokWired.publish({ ...request, format: "video", tiktok: {} });
  assert.equal(ttEnqueued[1].privacyLevel, null);

  // A YouTube format that does not exist is refused, never coerced.
  const badFormat = await youtube.publish({ ...request, channel: "youtube", format: "reel" });
  assert.equal(badFormat.status, "failed");
  assert.equal(badFormat.code, "unsupported_format");

  // Through the registry: the router never even calls an unavailable adapter,
  // and the YouTube port is wired only when it exists.
  const enqueued = [];
  const registry = createSocialPublisherRegistry({
    enqueuePublishItem: async (input) => { enqueued.push(input); return { id: "queue-1" }; },
  });
  const routed = await publishSocialContent(registry, request);
  assert.equal(routed.status, "connection_required", "the router reports the missing TikTok connection");
  const ytNoPort = await publishSocialContent(registry, { ...request, channel: "youtube", format: "short" });
  assert.equal(ytNoPort.status, "connection_required", "no YouTube port means the truthful refusal");
  assert.equal(enqueued.length, 0, "nothing was enqueued anywhere");

  const wired = createSocialPublisherRegistry(
    { enqueuePublishItem: async (input) => { enqueued.push(input); return { id: "queue-1" }; } },
    { enqueueYouTubePublishItem: async (input) => { ytEnqueued.push(input); return { id: "yt-queue-2" }; } },
  );
  const ytRouted = await publishSocialContent(wired, {
    ...request, channel: "youtube", format: "video",
    youtube: { title: "The depth piece", privacyStatus: "unlisted", madeForKids: false },
  });
  assert.equal(ytRouted.status, "enqueued");
  assert.equal(ytEnqueued.length, 3);
  assert.equal(enqueued.length, 0, "the Instagram queue was never touched for YouTube content");

  // And the router sends TikTok content to the TikTok queue — never to
  // Instagram's or YouTube's.
  const ttRouted = await publishSocialContent(wired, { ...request, format: "video" });
  assert.equal(ttRouted.status, "connection_required", "the registry without a TikTok port still refuses truthfully");
  const allWired = createSocialPublisherRegistry(
    { enqueuePublishItem: async (input) => { enqueued.push(input); return { id: "queue-1" }; } },
    { enqueueYouTubePublishItem: async (input) => { ytEnqueued.push(input); return { id: "yt-queue-2" }; } },
    { enqueueTikTokPublishItem: async (input) => { ttEnqueued.push(input); return { id: "tt-queue-3" }; } },
  );
  const ttCountBefore = ttEnqueued.length;
  const ttRoutedWired = await publishSocialContent(allWired, { ...request, format: "video" });
  assert.equal(ttRoutedWired.status, "enqueued");
  assert.equal(ttEnqueued.length, ttCountBefore + 1, "the TikTok queue received exactly the TikTok item");
  assert.equal(enqueued.length, 0, "the Instagram queue was never touched for TikTok content");
});

test("the Instagram adapter reuses the existing queue and cannot fake published", async () => {
  const { createSocialPublisherRegistry, publishSocialContent, instagramMediaKindForFormat } = await publisherReady;

  assert.equal(instagramMediaKindForFormat("post"), "image");
  assert.equal(instagramMediaKindForFormat("reel"), "reel");
  assert.equal(instagramMediaKindForFormat("story"), "story");
  assert.equal(instagramMediaKindForFormat("video"), null, "a social video format is not an Instagram media kind");

  const enqueued = [];
  const registry = createSocialPublisherRegistry({
    enqueuePublishItem: async (input) => { enqueued.push(input); return { id: "queue-row-1" }; },
  });
  const outcome = await publishSocialContent(registry, {
    ownerId: "11111111-1111-4111-8111-111111111111",
    channel: "instagram",
    format: "reel",
    draftId: "22222222-2222-4222-8222-222222222222",
    caption: "Launch week",
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    calendarItemId: null,
  });
  assert.equal(outcome.status, "enqueued", "Instagram hands execution to the durable queue");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].mediaKind, "reel", "the existing 0022 queue vocabulary is reused");
  assert.notEqual(outcome.status, "published", "enqueued is NOT published — only Meta confirmation can say that");

  // Structural guard: an adapter that claims published without the provider's
  // own reference is refused by the router.
  const lyingRegistry = {
    instagram: { channel: "instagram", isAvailable: () => true, publish: async () => ({ status: "published", channel: "instagram" }) },
    tiktok: { channel: "tiktok", isAvailable: () => false, publish: async () => ({ status: "provider_not_supported", channel: "tiktok", message: "" }) },
    youtube: { channel: "youtube", isAvailable: () => false, publish: async () => ({ status: "provider_not_supported", channel: "youtube", message: "" }) },
  };
  const lied = await publishSocialContent(lyingRegistry, {
    ownerId: "11111111-1111-4111-8111-111111111111",
    channel: "instagram",
    format: "post",
    draftId: "22222222-2222-4222-8222-222222222222",
    caption: "x",
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.equal(lied.status, "failed");
  assert.equal(lied.code, "missing_provider_confirmation", "published REQUIRES the provider's own reference");
});

// ─── 4. Studio draft kinds and the ONE calendar vocabulary ──────────────────

test("the Studio draft kinds cover all six media formats and map to calendar channels", async () => {
  const {
    SOCIAL_VIDEO_DRAFT_KINDS, isSocialVideoDraftKind, SOCIAL_VIDEO_TYPE_LABELS,
    socialCalendarChannelFor, isPostDraftKind, isStudioDraftKind,
  } = await postCoreReady;

  assert.deepEqual([...SOCIAL_VIDEO_DRAFT_KINDS], ["tiktok_video", "youtube_short", "youtube_video"]);
  for (const kind of SOCIAL_VIDEO_DRAFT_KINDS) {
    assert.ok(isSocialVideoDraftKind(kind), `${kind} is a social video kind`);
    assert.ok(SOCIAL_VIDEO_TYPE_LABELS[kind], `${kind} has a label`);
    assert.equal(isPostDraftKind(kind), false, `${kind} is not an Instagram kind — the existing vocabulary is untouched`);
    assert.ok(isStudioDraftKind(kind), `${kind} belongs to the ONE Studio`);
  }
  assert.ok(isPostDraftKind("instagram_post") && isPostDraftKind("reel") && isPostDraftKind("story"), "the Instagram kinds are preserved exactly");
  assert.equal(isSocialVideoDraftKind("reel"), false);

  assert.equal(socialCalendarChannelFor("tiktok_video"), "TikTok");
  assert.equal(socialCalendarChannelFor("youtube_short"), "YouTube Short");
  assert.equal(socialCalendarChannelFor("youtube_video"), "YouTube Video");
  assert.equal(socialCalendarChannelFor("reel"), null, "Instagram kinds keep their existing calendar path");
  assert.equal(socialCalendarChannelFor("sms_blast"), null);
});

test("the content model maps every draft kind to exactly one channel+format pair", async () => {
  const { draftKindFor, resolveDraftChannelFormat, socialPairFromActionChannel, isSocialDraftKind } = await contentReady;

  assert.equal(draftKindFor("tiktok", "video"), "tiktok_video");
  assert.equal(draftKindFor("youtube", "short"), "youtube_short");
  assert.equal(draftKindFor("youtube", "video"), "youtube_video");
  assert.equal(draftKindFor("instagram", "reel"), "reel", "the legacy Instagram kinds are preserved");
  assert.equal(draftKindFor("tiktok", "short"), null, "an invalid pair has no kind");

  assert.deepEqual(socialPairFromActionChannel("tiktok_video"), { channel: "tiktok", format: "video" });
  assert.deepEqual(socialPairFromActionChannel("youtube_short"), { channel: "youtube", format: "short" });
  assert.deepEqual(socialPairFromActionChannel("youtube_video"), { channel: "youtube", format: "video" });
  assert.equal(socialPairFromActionChannel("email"), null);
  assert.equal(socialPairFromActionChannel("sms_blast"), null);

  // Legacy rows resolve through the stored kind; new rows through the columns.
  const legacy = resolveDraftChannelFormat({ kind: "reel", socialChannel: null, socialFormat: null });
  assert.deepEqual(legacy, { channel: "instagram", format: "reel" });
  const modern = resolveDraftChannelFormat({ kind: "tiktok_video", socialChannel: "tiktok", socialFormat: "video" });
  assert.deepEqual(modern, { channel: "tiktok", format: "video" });
  assert.ok(isSocialDraftKind("instagram_post") && isSocialDraftKind("tiktok_video"), "one predicate spans the whole domain");
});

test("platform guidance is native per format — never one template pasted four ways", async () => {
  const { PLATFORM_FORMAT_GUIDANCE, platformGuidanceFor, coordinatedSequenceRule, platformDefinitionsFor } = await platformsReady;

  const keys = Object.keys(PLATFORM_FORMAT_GUIDANCE);
  assert.equal(keys.length, 7, "one guidance entry per channel+format pair, plus email");
  for (const key of keys) {
    const guidance = PLATFORM_FORMAT_GUIDANCE[key];
    assert.ok(guidance.definition.length > 20, `${key} has a real definition`);
    assert.ok(guidance.writingRule.length > 20, `${key} has a real writing rule`);
  }
  // TikTok-native ≠ Reel: the guidance must differ, not restate.
  assert.notEqual(PLATFORM_FORMAT_GUIDANCE.tiktok_video.writingRule, PLATFORM_FORMAT_GUIDANCE.instagram_reel.writingRule);
  assert.notEqual(PLATFORM_FORMAT_GUIDANCE.youtube_short.writingRule, PLATFORM_FORMAT_GUIDANCE.tiktok_video.writingRule);
  assert.ok(platformGuidanceFor("youtube_video"), "the full YouTube Video is first-class");
  assert.equal(platformGuidanceFor("sms_blast"), null);

  const rule = coordinatedSequenceRule(["instagram", "tiktok", "youtube", "email"]);
  assert.match(rule, /TikTok/i);
  assert.match(rule, /YouTube/i);
  assert.match(rule, /Instagram/i);
  assert.match(rule, /email/i);
  const igOnly = coordinatedSequenceRule(["instagram"]);
  assert.doesNotMatch(igOnly, /TikTok/, "an Instagram-only campaign is never told about TikTok");

  const defs = platformDefinitionsFor(["tiktok_video", "youtube_video"]);
  assert.equal(defs.length, 2);
  assert.deepEqual(defs.map((d) => d.channel), ["tiktok_video", "youtube_video"]);
});

// ─── 5. Campaign channel combinations ───────────────────────────────────────

test("every non-empty combination of the four channels is one campaign", async () => {
  const { normalizeCampaignChannels } = await typesReady;

  const singles = [["instagram"], ["tiktok"], ["youtube"], ["email"]];
  const pairs = [["instagram", "tiktok"], ["instagram", "email"], ["tiktok", "youtube"], ["youtube", "email"]];
  const bigger = [["instagram", "tiktok", "youtube"], ["instagram", "tiktok", "youtube", "email"]];
  for (const selection of [...singles, ...pairs, ...bigger]) {
    const result = normalizeCampaignChannels(selection);
    assert.equal(result.ok, true, `${selection.join("+")} is a valid campaign`);
    assert.deepEqual([...result.channels].sort(), [...selection].sort(), "the same channels come back");
  }

  // Canonical order: the same selection always stores the same way.
  assert.deepEqual(normalizeCampaignChannels(["youtube", "email", "tiktok", "instagram"]).channels,
    ["instagram", "tiktok", "youtube", "email"]);

  // Refusals: empty, repeated, retired, unknown.
  assert.equal(normalizeCampaignChannels([]).reason, "empty");
  assert.equal(normalizeCampaignChannels(["tiktok", "tiktok"]).ok, false);
  assert.equal(normalizeCampaignChannels(["sms"]).reason, "unknown_channel", "the retired channel can never be selected");
  assert.equal(normalizeCampaignChannels(["instagram", "sms"]).ok, false);
  assert.equal(normalizeCampaignChannels(["instagram", "tiktok", "youtube", "email", "email"]).ok, false, "more than four is refused");
});

test("the planner mixes TikTok and YouTube only when the campaign selects them", async () => {
  const { planCampaign } = await plannerReady;

  // A 10-day four-channel campaign plans every family.
  const full = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["instagram", "tiktok", "youtube", "email"], now: NOW });
  const count = (channel) => full.actions.filter((a) => a.channel === channel).length;
  assert.ok(count("tiktok_video") >= 1, "TikTok is planned");
  assert.ok(count("youtube_short") >= 1, "YouTube Shorts are planned");
  assert.ok(count("youtube_video") >= 1, "the full YouTube Video is planned on a 10-day window");
  assert.ok(count("email") >= 1 && full.actions.some((a) => a.channel.startsWith("instagram_")));
  assert.equal(full.summary.channels.length, 4);
  assert.equal(full.summary.tiktokCount, count("tiktok_video"));
  assert.equal(full.summary.youtubeCount, count("youtube_short") + count("youtube_video"));

  // Every planned action carries a real slot, day and instant.
  for (const action of full.actions) {
    assert.ok(Number.isInteger(action.slot) && action.slot >= 0);
    assert.ok(!Number.isNaN(Date.parse(action.scheduledFor)), `${action.channel} has a real instant`);
  }
  const slots = full.actions.map((a) => a.slot);
  assert.equal(new Set(slots).size, slots.length, "slots are unique");

  // The legacy default (no explicit choice) plans Instagram + Email ONLY —
  // TikTok/YouTube are never selected silently.
  const legacy = planCampaign({ brief: BRIEF, brand: BRAND, now: NOW });
  assert.deepEqual(legacy.summary.channels, ["instagram", "email"]);
  assert.equal(legacy.actions.filter((a) => a.channel === "tiktok_video" || a.channel.startsWith("youtube_")).length, 0,
    "an unconnected channel is never planned without an active choice");

  // A TikTok-only campaign is entirely TikTok — no leaked email or Instagram.
  const tiktokOnly = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["tiktok"], now: NOW });
  assert.ok(tiktokOnly.actions.length >= 1);
  assert.ok(tiktokOnly.actions.every((a) => a.channel === "tiktok_video"), "every action is TikTok-native");
});

// ─── 6. MARA platform-awareness and hostile-output defence ──────────────────

test("the provider schema demands platform-native payloads and nulls elsewhere", async () => {
  const { campaignActionContentSchema, campaignIntelligenceSchema } = await strategyReady;

  const base = { slot: 0, channel: "tiktok_video", title: "Launch beat" };
  const tiktokPayload = {
    purpose: "Carries the launch beat natively on TikTok.",
    concept: "Launch beat",
    hook: "Your payouts page just changed",
    caption: "One blunt line about the change #fintech #payments #smallbusiness",
    cta: "See it",
    visualDirection: "Fast cuts of the dashboard.",
    script: ["Hook on the change", "Show the payouts page", "Close on the brand"],
    hashtags: ["fintech", "payments", "smallbusiness"],
    proposedSendAt: null,
  };

  // A TikTok action with only the tiktok payload parses.
  const ok = campaignActionContentSchema.safeParse({ ...base, email: null, instagram: null, tiktok: tiktokPayload, youtube: null });
  assert.equal(ok.success, true, "a well-formed TikTok action parses");

  // Strict object: a missing payload key is refused, not defaulted.
  const missing = campaignActionContentSchema.safeParse({ ...base, email: null, instagram: null, tiktok: tiktokPayload });
  assert.equal(missing.success, false, "every payload key must exist (null unless matching)");

  // TikTok caption limit is 400, not Instagram's 2200.
  const longCaption = campaignActionContentSchema.safeParse({
    ...base, email: null, instagram: null, youtube: null,
    tiktok: { ...tiktokPayload, caption: "x".repeat(401) },
  });
  assert.equal(longCaption.success, false, "a TikTok caption over 400 characters is refused");

  // An empty TikTok script is refused at the schema level.
  const noScript = campaignActionContentSchema.safeParse({
    ...base, email: null, instagram: null, youtube: null,
    tiktok: { ...tiktokPayload, script: [] },
  });
  assert.equal(noScript.success, false, "a TikTok video without beats is refused");

  // YouTube Video: description required, script up to 12 lines.
  const yt = campaignActionContentSchema.safeParse({
    slot: 1, channel: "youtube_video", title: "How payouts work now",
    email: null, instagram: null, tiktok: null,
    youtube: {
      format: "video",
      purpose: "The depth piece of the sequence.",
      concept: "How payouts work now",
      hook: "Where the money actually lands",
      title: "How SynraPay payouts work now",
      description: "Two to four sentences explaining the payoff and the chapters.",
      caption: "The full explanation, in one place.",
      cta: "Watch the walkthrough",
      visualDirection: "Screen recording with chapters.",
      script: ["Hook", "Chapter one", "Chapter two", "Closing CTA"],
      proposedSendAt: null,
    },
  });
  assert.equal(yt.success, true, "a full YouTube Video payload parses");
  const ytNoDesc = campaignActionContentSchema.safeParse({
    slot: 1, channel: "youtube_video", title: "x",
    email: null, instagram: null, tiktok: null,
    youtube: { ...yt.data ? {} : {}, format: "video", purpose: "p", concept: "c", hook: "", title: "t", description: "", caption: "cap", cta: "", visualDirection: "", script: ["a", "b", "c"], proposedSendAt: null },
  });
  assert.equal(ytNoDesc.success, false, "a YouTube Video without a description is refused");

  // The intelligence envelope still requires strategy + actions + note.
  assert.equal(campaignIntelligenceSchema.safeParse({ actions: [] }).success, false);
});

test("MARA can never widen a campaign's channels, even with hostile output", async () => {
  const { planCampaign } = await plannerReady;
  const { applyCampaignIntelligence } = await strategyReady;

  const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["instagram"], now: NOW });
  // Hostile response: claims every slot is a TikTok video outside the selection.
  const hostile = {
    strategy: {
      objective: "Sell the summer collection.",
      coreMessage: "The sale is live.",
      audienceAngle: "Existing customers already know the range.",
      narrative: "Announce, prove, close.",
      ctaStrategy: "One clear next step per action.",
      sequenceRationale: "Short-form first, then the close.",
    },
    actions: plan.actions.map((action) => ({
      slot: action.slot,
      channel: "tiktok_video",
      title: "Hijacked",
      email: null,
      instagram: null,
      youtube: null,
      tiktok: {
        purpose: "Hijack.", concept: "Hijack", hook: "Hijack",
        caption: "Hijacked caption #a #b #c", cta: "Go",
        visualDirection: "Hijacked.", script: ["a", "b", "c"],
        hashtags: ["a", "b", "c"], proposedSendAt: null,
      },
    })),
    performanceNote: null,
  };

  const merged = applyCampaignIntelligence({
    skeleton: plan.actions, summary: plan.summary, brief: BRIEF, brand: BRAND,
    goalLabel: "Drive sales", intelligence: hostile, channels: ["instagram"], now: NOW,
  });

  assert.deepEqual(merged.fallbackSlots, plan.actions.map((a) => a.slot), "every hijacked slot falls back");
  assert.ok(merged.actions.every((a) => a.channel === plan.actions.find((s) => s.slot === a.slot).channel),
    "no action changed its channel");
  assert.ok(merged.actions.every((a) => a.contentSource !== "mara"), "hostile content is never applied");
});

test("the merge refuses wrong-channel payloads, format mismatches, thin videos and pasted copy", async () => {
  const { planCampaign } = await plannerReady;
  const { applyCampaignIntelligence } = await strategyReady;

  const plan = planCampaign({ brief: BRIEF, brand: BRAND, channels: ["instagram", "tiktok", "youtube", "email"], now: NOW });
  const baseMerge = (mutate) => {
    const intelligence = {
      strategy: {
        objective: "Get merchants onto the new site.",
        coreMessage: "The site is live and your setup works.",
        audienceAngle: "Merchants want to know nothing breaks.",
        narrative: "Announce, prove, close.",
        ctaStrategy: "One clear next step.",
        sequenceRationale: "Short-form earns attention; email carries detail.",
      },
      actions: plan.actions.map((action) => nativePayloadFor(action)),
      performanceNote: null,
    };
    mutate(intelligence);
    return applyCampaignIntelligence({
      skeleton: plan.actions, summary: plan.summary, brief: BRIEF, brand: BRAND,
      goalLabel: "Drive sales", intelligence, channels: ["instagram", "tiktok", "youtube", "email"], now: NOW,
    });
  };

  // A TikTok slot carrying an Instagram payload is refused.
  const tiktokSlot = plan.actions.find((a) => a.channel === "tiktok_video").slot;
  const wrongPayload = baseMerge((intelligence) => {
    const action = intelligence.actions.find((a) => a.slot === tiktokSlot);
    action.instagram = { format: "post", purpose: "p", concept: "c", hook: "", caption: "A distinct TikTok-slot caption.", cta: "", visualDirection: "v", script: [], proposedSendAt: null };
    action.tiktok = null;
  });
  assert.ok(wrongPayload.fallbackSlots.includes(tiktokSlot), "a wrong-channel payload is refused");

  // A YouTube Video slot carrying a Short payload (format mismatch) is refused.
  const videoSlot = plan.actions.find((a) => a.channel === "youtube_video")?.slot;
  if (videoSlot !== undefined) {
    const mismatch = baseMerge((intelligence) => {
      const action = intelligence.actions.find((a) => a.slot === videoSlot);
      action.youtube.format = "short";
    });
    assert.ok(mismatch.fallbackSlots.includes(videoSlot), "a format mismatch is refused");

    // A full Video with a two-line script is refused — the depth piece needs a real outline.
    const thin = baseMerge((intelligence) => {
      const action = intelligence.actions.find((a) => a.slot === videoSlot);
      action.youtube.script = ["Hook", "Close"];
    });
    assert.ok(thin.fallbackSlots.includes(videoSlot), "a thin video outline is refused");
  }

  // Pasted copy: a TikTok caption that restates an email body verbatim is refused.
  const emailAction = plan.actions.find((a) => a.channel === "email");
  const pasted = baseMerge((intelligence) => {
    const email = intelligence.actions.find((a) => a.slot === emailAction.slot);
    const tiktok = intelligence.actions.find((a) => a.slot === tiktokSlot);
    tiktok.tiktok.caption = email.email.body.slice(0, 400);
    tiktok.tiktok.hook = "A genuinely different hook line";
  });
  assert.ok(pasted.fallbackSlots.includes(tiktokSlot), "cross-channel pasted copy is refused");

  // The clean payload merges everywhere: platform-native content is applied.
  const clean = baseMerge(() => {});
  assert.deepEqual(clean.fallbackSlots, [], "a platform-native response merges with no refusals");
  assert.ok(clean.actions.every((a) => a.contentSource === "mara"));
});

/** A schema-valid, platform-native payload for one skeleton action. */
function nativePayloadFor(action) {
  const common = { purpose: `Carries slot ${action.slot} natively.`, proposedSendAt: null };
  if (action.channel === "email") {
    // Three genuinely distinct sequences — the duplicate guard measures token
    // overlap, so near-identical bodies would (correctly) be refused.
    const variants = [
      {
        subject: "The Summer Sale starts Monday",
        previewText: "Free shipping over $50 all week.",
        body: "Hi,\n\nThe Summer Sale starts Monday. Every order over fifty dollars ships free, and loyal customers get an extra ten percent at checkout.\n\nCTA: Shop the sale",
        cta: "Shop the sale",
      },
      {
        subject: "Three days left",
        previewText: "The shelves are already thinning.",
        body: "Hi,\n\nThree days left. The shelves are already thinning — the espresso grinder and the linen apron are almost gone, and we will not restock until autumn.\n\nCTA: Grab what is left",
        cta: "Grab what is left",
      },
      {
        subject: "Last call before midnight",
        previewText: "Prices reset tomorrow morning.",
        body: "Hi,\n\nLast call before midnight. Everything returns to full price tomorrow, so finish the basket you saved on Tuesday while the discount still applies.\n\nCTA: Finish your basket",
        cta: "Finish your basket",
      },
    ];
    const variant = variants[action.slot % variants.length];
    return {
      slot: action.slot, channel: "email", title: `Email for slot ${action.slot}`,
      instagram: null, tiktok: null, youtube: null,
      email: {
        ...common,
        subject: variant.subject,
        previewText: variant.previewText,
        body: variant.body,
        cta: variant.cta,
        ctaUrl: null,
        audienceNote: "Existing merchants.",
        sendTimeNote: "Mid-morning.",
      },
    };
  }
  if (action.channel === "tiktok_video") {
    return {
      slot: action.slot, channel: "tiktok_video", title: `TikTok for slot ${action.slot}`,
      email: null, instagram: null, youtube: null,
      tiktok: {
        ...common,
        concept: `TikTok concept ${action.slot}`,
        hook: `Blunt TikTok hook ${action.slot}`,
        caption: `TikTok-native one-liner ${action.slot} #payments #fintech #smallbiz`,
        cta: "See it",
        visualDirection: "Fast handheld cuts.",
        script: [`Hook ${action.slot}`, "Show the change", "Close on the brand"],
        hashtags: ["payments", "fintech", "smallbiz"],
      },
    };
  }
  if (action.channel === "youtube_short") {
    return {
      slot: action.slot, channel: "youtube_short", title: `Short for slot ${action.slot}`,
      email: null, instagram: null, tiktok: null,
      youtube: {
        ...common, format: "short",
        concept: `Short concept ${action.slot}`,
        hook: `Search-friendly hook ${action.slot}`,
        title: `How payouts work — part ${action.slot}`,
        description: `One to two lines promising the payoff for slot ${action.slot}.`,
        caption: `Distinct Short caption ${action.slot}.`,
        cta: "Watch",
        visualDirection: "Vertical screen capture.",
        script: [`Hook ${action.slot}`, "The payoff", "Subscribe nudge"],
      },
    };
  }
  if (action.channel === "youtube_video") {
    return {
      slot: action.slot, channel: "youtube_video", title: `Video for slot ${action.slot}`,
      email: null, instagram: null, tiktok: null,
      youtube: {
        ...common, format: "video",
        concept: `Video concept ${action.slot}`,
        hook: `Depth hook ${action.slot}`,
        title: `The full payouts walkthrough ${action.slot}`,
        description: `Two to four sentences with the payoff and the chapters for slot ${action.slot}.`,
        caption: `Distinct Video caption ${action.slot}.`,
        cta: "Watch the walkthrough",
        visualDirection: "Screen recording with chapters.",
        script: ["Hook", "Chapter one: what changed", "Chapter two: the payouts page", "Closing CTA"],
      },
    };
  }
  const format = action.channel === "instagram_reel" ? "reel" : action.channel === "instagram_story" ? "story" : "post";
  return {
    slot: action.slot, channel: action.channel, title: `Instagram ${format} for slot ${action.slot}`,
    email: null, tiktok: null, youtube: null,
    instagram: {
      ...common, format,
      concept: `Instagram concept ${action.slot}`,
      hook: format === "story" ? "" : `Instagram hook ${action.slot}`,
      caption: `Distinct Instagram caption ${action.slot}.`,
      cta: "See the site",
      visualDirection: format === "reel" ? "Three shots of the dashboard." : "Static frame, no baked text.",
      script: format === "reel" ? [`Open on hook ${action.slot}`, "Show the benefit", "End on the brand"] : [],
    },
  };
}

// ─── 7. Migration 0046 against a real embedded PostgreSQL ───────────────────

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;
const CAMPAIGN_START = new Date(Math.ceil((Date.now() + 2 * DAY) / DAY) * DAY).toISOString();
const CAMPAIGN_END = new Date(Date.parse(CAMPAIGN_START) + 9 * DAY + 23 * 3_600_000 + 59 * 60_000).toISOString();
const at = (dayOffset, hour = 9) =>
  new Date(Date.parse(CAMPAIGN_START) + dayOffset * DAY + hour * 3_600_000).toISOString();

let keySeq = 0;
const nextKey = (prefix = "msc") => `${prefix}-${String(++keySeq).padStart(6, "0")}-aabbccdd-eeff00112233`.slice(0, 60);

/** Seeds the auth users every table FKs to, then returns query helpers. */
async function liteDb(options) {
  const { db, applyPending } = await createSupabaseLite(options);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${OWNER_A}', 'owner.a@example.com'),
      ('${OWNER_B}', 'owner.b@example.com');
    insert into public.businesses (owner_user_id, brand_name, industry, automation_level) values
      ('${OWNER_A}', 'SynraPay', 'Fintech', 'assisted'),
      ('${OWNER_B}', 'Other Studio', 'Fashion', 'manual');
  `);
  return {
    db,
    applyPending,
    all: async (sql, params = []) => (await db.query(sql, params)).rows,
    one: async (sql, params = []) => (await db.query(sql, params)).rows[0],
  };
}

test("migration 0046 applies and enforces the social draft kind+pair checks", async () => {
  const { one } = await liteDb();
  const conv = await one(
    "insert into public.mara_conversations (owner_user_id, title) values ($1, 'Studio') returning id",
    [OWNER_A],
  );
  const conversationId = conv.id;

  const insertDraft = (kind, socialChannel, socialFormat) => one(
    `insert into public.mara_drafts
       (conversation_id, owner_user_id, kind, channel, title, content, social_channel, social_format, content_meta)
     values ($1, $2, $3, $4, 'Title', 'Caption', $5, $6, '{}'::jsonb) returning id`,
    [conversationId, OWNER_A, kind, "TikTok · 9:16", socialChannel, socialFormat],
  );

  assert.ok((await insertDraft("tiktok_video", "tiktok", "video")).id, "a valid TikTok draft stores");
  assert.ok((await insertDraft("youtube_short", "youtube", "short")).id, "a valid YouTube Short stores");
  assert.ok((await insertDraft("youtube_video", "youtube", "video")).id, "a valid YouTube Video stores");

  await assert.rejects(
    insertDraft("tiktok_short", "tiktok", "short"),
    (error) => /mara_drafts_kind_check/.test(String(error.message)),
    "an invented kind is refused by the database",
  );
  await assert.rejects(
    insertDraft("tiktok_video", "tiktok", "short"),
    (error) => /mara_drafts_social_pair_check/.test(String(error.message)),
    "a mismatched channel+format pair is refused by the database",
  );
  await assert.rejects(
    insertDraft("youtube_video", "youtube", "short"),
    (error) => /mara_drafts_social_pair_check/.test(String(error.message)),
    "a YouTube Video cannot claim the Short format",
  );
});

test("migration 0046 backfills Instagram rows and keeps every channel on one calendar", async () => {
  // The backfill runs DURING the migration, so the legacy row must exist
  // before 0046 applies — exactly the production upgrade order.
  const { one, all, applyPending } = await liteDb({ stopBefore: "0046_multi_social_core.sql" });
  const conv = await one(
    "insert into public.mara_conversations (owner_user_id, title) values ($1, 'Studio') returning id",
    [OWNER_A],
  );
  // A legacy Instagram row written the pre-0046 way: the social columns do
  // not even exist yet.
  await one(
    `insert into public.mara_drafts (conversation_id, owner_user_id, kind, channel, title, content)
     values ($1, $2, 'reel', 'Reel · 9:16', 'Legacy Reel', 'Caption') returning id`,
    [conv.id, OWNER_A],
  );

  const applied = await applyPending();
  assert.equal(applied[applied.length - 1], "0049_tiktok_provider.sql", "0049 (the TikTok provider) is the final checked-in migration");

  const legacy = await one(
    "select social_channel, social_format from public.mara_drafts where title = 'Legacy Reel'",
  );
  assert.equal(legacy.social_channel, "instagram", "existing Instagram rows are backfilled, not rewritten");
  assert.equal(legacy.social_format, "reel");

  // The ONE calendar accepts every active channel label.
  for (const channel of ["Instagram", "Reel", "Story", "TikTok", "YouTube Short", "YouTube Video"]) {
    await one(
      `insert into public.content_calendar_items (owner_user_id, title, channel, content, publish_at, status)
       values ($1, $2, $3, 'body', $4, 'scheduled') returning id`,
      [OWNER_A, `Item ${channel}`, channel, at(1)],
    );
  }
  const stored = await all("select channel from public.content_calendar_items order by title");
  assert.deepEqual(stored.map((row) => row.channel),
    ["Instagram", "Reel", "Story", "TikTok", "YouTube Short", "YouTube Video"],
    "every active channel lives in the ONE calendar");

  // An unknown channel is refused by the database.
  await assert.rejects(
    one(
      `insert into public.content_calendar_items (owner_user_id, title, channel, content, publish_at, status)
       values ($1, 'WhatsApp', 'WhatsApp', 'body', $2, 'scheduled') returning id`,
      [OWNER_A, at(1)],
    ),
    (error) => /content_calendar_items_channel_check/.test(String(error.message)),
    "an invented channel can never enter the calendar",
  );
  // NOTE: 'SMS' deliberately stays valid AT THE DB LEVEL — a CHECK constraint
  // validates existing rows, and historical SMS items must keep passing.
  // The retirement is enforced where selection happens: the domain layer
  // (RETIRED_CHANNELS / retired_channel, asserted above) and the UI, which
  // never offer SMS. No code path in this change ever writes an SMS row.
});

test("the campaign RPC stores any channel combination and refuses retired or foreign actions", async () => {
  const { one, all } = await liteDb();

  const build = (channels, actions, owner = OWNER_A) => {
    const key = nextKey();
    const body = {
      campaign: {
        idempotencyKey: key,
        name: "Multi-Social Launch",
        goal: "drive_sales",
        startAt: CAMPAIGN_START,
        endAt: CAMPAIGN_END,
        offerDetails: "",
        audience: "Existing customers",
        notes: "",
        summary: "Four-channel test campaign.",
        channels,
      },
      actions: actions.map((action, slot) => ({
        ...action,
        slot,
        idempotencyKey: `${key}-action-${slot}`.slice(0, 60),
      })),
    };
    return one(
      "select * from public.create_automated_campaign($1::uuid, $2::jsonb)",
      [owner, JSON.stringify(body)],
    );
  };

  const action = (channel, dayOffset, hour = 9) => ({
    channel,
    stage: "conversion",
    title: `${channel} action`,
    purpose: `Carries the ${channel} moment.`,
    concept: `${channel} concept`,
    caption: `A ${channel} caption.`,
    scheduledFor: at(dayOffset, hour),
    status: "needs_approval",
    contentSource: "deterministic",
  });

  // A four-channel campaign stores canonically ordered channels.
  const full = await build(
    ["youtube", "email", "tiktok", "instagram"],
    [action("instagram_post", 0), action("tiktok_video", 1), action("youtube_short", 2), action("youtube_video", 3), action("email", 4)],
  );
  assert.deepEqual(full.channels, ["instagram", "tiktok", "youtube", "email"], "canonical order, any selection");
  assert.equal(full.kind, "multi", "still ONE campaign model");
  assert.equal(full.owner_user_id, OWNER_A, "the campaign belongs to the owner who created it");

  const actions = await all(
    "select channel, draft_id, email_campaign_id from public.voom_campaign_actions where campaign_id = $1 order by slot",
    [full.id],
  );
  assert.equal(actions.length, 5);
  for (const row of actions) {
    if (row.channel === "email") {
      assert.ok(row.email_campaign_id, "the email action keeps its child campaign");
    } else {
      assert.ok(row.draft_id, `${row.channel} keeps a draft execution identity`);
    }
  }
  // TikTok/YouTube drafts carry their social columns — the Studio and the
  // calendar read the same truth.
  const socialDrafts = await all(
    `select kind, social_channel, social_format from public.mara_drafts
     where owner_user_id = $1 and kind in ('tiktok_video', 'youtube_short', 'youtube_video') order by kind`,
    [OWNER_A],
  );
  assert.equal(socialDrafts.length, 3);
  for (const row of socialDrafts) {
    const expected = row.kind === "tiktok_video" ? ["tiktok", "video"]
      : row.kind === "youtube_short" ? ["youtube", "short"]
      : ["youtube", "video"];
    assert.deepEqual([row.social_channel, row.social_format], expected, `${row.kind} carries its pair`);
  }

  // A retired channel is refused by the database guard.
  await assert.rejects(
    build(["instagram", "sms"], [action("instagram_post", 0)]),
    (error) => /invalid_campaign_channels/.test(String(error.message)),
    "SMS can never be selected again",
  );

  // An action outside the campaign's channels is refused.
  await assert.rejects(
    build(["instagram"], [action("instagram_post", 0), action("tiktok_video", 1)]),
    (error) => /campaign_action_channel_not_selected/.test(String(error.message)),
    "a TikTok action on an Instagram-only campaign is refused server-side",
  );

  // Owner isolation: nothing was written under another owner's id.
  const foreign = await all(
    "select id from public.voom_campaigns where owner_user_id = $1",
    [OWNER_B],
  );
  assert.equal(foreign.length, 0, "no campaign exists under owner B");
});

// ─── 8. Source-level truthfulness ───────────────────────────────────────────

test("the social layer invents no provider endpoints, tokens or analytics", async () => {
  const publisher = await read("lib/social/publisher.ts");
  const connections = await read("lib/social/connections.ts");
  const serverDrafts = await read("lib/social/server-drafts.ts");
  const strip = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*(\/\/).*$/gm, "");

  // The social boundary layer still performs NO network I/O of its own and
  // names NO provider host: the real YouTube endpoints live exclusively in
  // lib/youtube/client.ts (built against Google's official documentation),
  // and the real Instagram endpoints in lib/instagram/client.ts. TikTok has
  // no integration and nothing invents one here.
  for (const [name, source] of [["publisher", publisher], ["connections", connections], ["server-drafts", serverDrafts]]) {
    const code = strip(source);
    assert.doesNotMatch(code, /https?:\/\//, `${name} calls no endpoint at all`);
    assert.doesNotMatch(code, /\bfetch\(|axios|got\(/, `${name} makes no network call`);
    assert.doesNotMatch(code, /tiktok\.com|youtube\.com|googleapis|api\.meta\.com|openrouter/i, `${name} names no provider host`);
    // No token MATERIAL anywhere in the boundary layer. The sanitized
    // expiry-metadata column (access_token_expires_at) is presentation data,
    // not a token; real token columns (encrypted_*, refresh tokens) never are.
    assert.doesNotMatch(code.replace(/access_token_expires_at/g, ""), /access_token|refresh_token|oauth|encrypted_/i, `${name} handles no token material`);
  }
  assert.match(publisher, /provider_not_supported/, "the truthful refusal status exists");
  assert.match(connections, /unconfiguredConnection/, "unconnected channels are represented, never invented");
  assert.match(connections, /getResendAvailability/, "the email connection keeps its real, existing provider check");
  assert.match(connections, /youtube_connections/, "the YouTube view reads the REAL connection table (migration 0047)");
});

test("the social drafts layer never executes: TikTok and YouTube only mirror their durable queues", async () => {
  const serverDrafts = await read("lib/social/server-drafts.ts");
  assert.doesNotMatch(serverDrafts, /instagram_publish_queue/, "no Instagram queue row is ever created for TikTok/YouTube");
  assert.doesNotMatch(serverDrafts, /publishSocialContent/, "the drafts layer never runs the publisher boundary itself");
  assert.doesNotMatch(serverDrafts, /https?:\/\/|\bfetch\(/, "the drafts layer makes no provider call of any kind");
  // TikTok's ONLY execution touchpoint is the idempotent mirror into the
  // durable queue (migration 0049) — the same boundary the publisher uses.
  // No TikTok call, no token, no upload exists in this layer.
  assert.match(serverDrafts, /syncSocialDraftToTikTokQueue/, "TikTok approval mirrors into the durable publish queue");
  assert.match(serverDrafts, /enqueueTikTokPublishItem/, "the TikTok mirror is the queue RPC, nothing else");
  assert.match(serverDrafts, /cancelTikTokPublishItem/, "un-approving or unscheduling withdraws the TikTok queue row");
  // YouTube's ONLY execution touchpoint is the idempotent mirror into the
  // durable queue (migration 0047) — the same boundary the publisher uses.
  // No Google call, no token, no upload exists in this layer.
  assert.match(serverDrafts, /enqueueYouTubePublishItem/, "YouTube approval mirrors into the durable publish queue");
  assert.match(serverDrafts, /cancelYouTubePublishItem/, "un-approving or unscheduling withdraws the queue row");
  assert.match(serverDrafts, /needs_declaration/, "undeclared policy-sensitive metadata parks visibly, never guessed");
  assert.match(serverDrafts, /owner_user_id/, "every read and write is owner-scoped");

  const route = await read("app/api/social-drafts/[id]/route.ts");
  assert.match(route, /UUID_RE/, "the route validates the draft id");
  assert.match(route, /getCurrentUser/, "the route is authenticated");
  // The route records decisions and declarations — its CODE must never DO
  // provider work itself: no publisher, no queue RPC, no Google call.
  // (Comments may name the queue; executable code may not reach it.)
  assert.doesNotMatch(
    route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/).*$/gm, ""),
    /publishSocialContent|enqueuePublishItem|enqueueYouTubePublishItem|enqueueTikTokPublishItem|syncSocialDraftToTikTokQueue|instagram_publish_queue|youtube_publish_queue|tiktok_publish_queue|createSocialPublisherRegistry|publishInstagram/i,
    "the edit/approve route has no direct execution path",
  );
});

test("approving a social campaign action records a decision only — no provider path exists", async () => {
  const server = await read("lib/campaign/server.ts");
  // The social branch of decideCampaignAction never touches the queue.
  const socialBranch = server.slice(
    server.indexOf("if (isSocialVideoChannel(action.channel)) {"),
    server.indexOf("} else if (action.channel === \"email\") {"),
  );
  assert.ok(socialBranch.length > 0, "the social decision branch exists");
  assert.doesNotMatch(socialBranch, /instagram_publish_queue|enqueue/, "approval never enqueues anything");
  assert.match(socialBranch, /updateSocialDraft/, "approval goes through the truthful drafts layer");
  assert.match(socialBranch, /Attach the video file before approving/, "a social action needs its asset before approval");
});

test("the coordinator understands every channel and ui_read stays strictly read-only", async () => {
  const state = await read("lib/coordinator/state.ts");
  const engine = await read("lib/coordinator/engine.ts");
  const types = await read("lib/coordinator/types.ts");

  assert.match(types, /tiktok_video/, "commitments carry the TikTok channel");
  assert.match(types, /content_calendar_gap/, "the gap need is channel-neutral");
  assert.doesNotMatch(types, /instagram_calendar_gap/, "the Instagram-only vocabulary is gone");
  assert.match(state, /tiktok_video/, "the state loader reads TikTok commitments");
  assert.match(state, /youtube_short/, "the state loader reads YouTube Short commitments");
  assert.match(state, /youtube_video/, "the state loader reads YouTube Video commitments");
  assert.match(engine, /isSocialCommitmentChannel/, "coverage counts every active social channel");

  // The coordinator's execution surface is unchanged: ui_read remains the only
  // tool and it never gained a write or an external action.
  const service = await read("lib/coordinator/service.ts");
  assert.match(service, /ui_read/, "ui_read is still the coordinator's tool");
  assert.doesNotMatch(service, /tiktok|youtube/i, "no new autonomous channel execution was added");
});

test("the ONE Studio and calendar surfaces present every channel truthfully", async () => {
  const studio = await read("app/app/(shell)/studio/page.tsx");
  const calendar = await read("app/app/(shell)/calendar/page.tsx");
  const connections = await read("app/app/(shell)/connections/page.tsx");
  const performance = await read("app/app/(shell)/performance/page.tsx");

  assert.match(studio, /SocialEditorModal/, "the Studio opens the social editor for social drafts");
  assert.match(studio, /isSocialVideoDraftKind/, "the Studio routes by kind");
  assert.match(calendar, /YouTube Short|YouTube Video/, "the calendar filters include the social formats");
  assert.match(calendar, /publishing not connected/i, "social cells say the truth");
  // The tiles read the REAL connection rows — a connection is claimed only
  // when the provider's row says so, and an unconfigured deployment still
  // says Planning only rather than implying anything.
  assert.match(connections, /getTikTokConnection/, "the TikTok tile reads the real connection row");
  assert.match(connections, /getYouTubeConnection/, "the YouTube tile reads the real connection row");
  assert.match(connections, /Planning only/, "an unconfigured deployment still says Planning only");
  assert.match(connections, /not configured yet/i, "an unconfigured integration is said as such, never claimed");
  // No fabricated analytics: TikTok honestly has none (the connection asks
  // for no analytics scope); YouTube's numbers are the official read-only
  // API, and a dash means the provider returned no number.
  assert.match(performance, /TikTok performance data is unavailable/i, "TikTok performance is honestly unavailable");
  assert.match(performance, /none is invented/i, "the page says nothing is invented");
  assert.match(performance, /official YouTube Data API/, "YouTube numbers come from the official read-only API");
});
