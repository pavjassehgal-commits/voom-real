/**
 * MARA Campaign Intelligence (v2) — the strategy + copy layer that fills the
 * deterministic v1 skeleton.
 *
 * The pipeline is deliberately one-directional:
 *
 *   deterministic skeleton  →  MARA intelligence  →  validated structured plan
 *
 * `planCampaign()` (lib/campaign/planner) stays the ONLY authority on
 * structure: the date range, the action count, the channels, the allowed
 * action types, the per-day timing boundaries and the Email + Instagram-only
 * channel list. MARA only ever fills content and strategy INSIDE that
 * structure, and every field it returns is schema-validated here before it can
 * reach the database. MARA output is never inserted as-is:
 *
 *   - an action MARA did not return keeps its deterministic v1 content;
 *   - an action MARA invented (extra slot, unknown channel) is dropped;
 *   - a channel MARA changed is refused — the skeleton's channel wins;
 *   - a proposed time outside the skeleton's own campaign day is refused;
 *   - copy that duplicates another action's copy is refused (cross-channel
 *     repetition is a v2 product rule, not a suggestion);
 *   - safety blockers are re-evaluated on the FINAL merged content.
 *
 * Pure module: no database, no provider client, no "server-only". The Node
 * suite executes it for real.
 */

import { z } from "zod";

import { evaluateAutopilotRecommendation } from "@/lib/mara/autopilot-safety";
import { coordinatedSequenceRule, platformDefinitionsFor } from "@/lib/social/platforms";
import {
  accountTimezone,
  isoToLocalDate,
  localDate,
  localToUtcIso,
} from "@/lib/voom/timezone";
import { CAMPAIGN_MIN_LEAD_MINUTES, enforceCampaignTiming, resolvePlanChannels } from "./planner";
import {
  actionChannelFamily,
  CAMPAIGN_ACTION_CHANNELS,
  MAX_CAMPAIGN_ACTIONS,
  type CampaignBrandContext,
  type CampaignBrief,
  type CampaignChannel,
  type PlannedAction,
  type PlannedCampaignSummary,
  type PlannerAudience,
  type PlannerPerformanceInput,
} from "./types";

// ─── MARA's structured response contract ───────────────────────────────────

/** The concise internal strategy MARA reasons out for one campaign. */
export const campaignStrategySchema = z.object({
  objective: z.string().min(1).max(300),
  coreMessage: z.string().min(1).max(400),
  audienceAngle: z.string().min(1).max(400),
  narrative: z.string().min(1).max(600),
  ctaStrategy: z.string().min(1).max(300),
  sequenceRationale: z.string().min(1).max(600),
}).strict();

export type MaraCampaignStrategy = z.infer<typeof campaignStrategySchema>;

export const campaignEmailContentSchema = z.object({
  /** Why this email exists at this point in the sequence (stage/purpose). */
  purpose: z.string().min(1).max(1000),
  subject: z.string().min(1).max(300),
  previewText: z.string().min(1).max(500),
  body: z.string().min(1).max(12000),
  cta: z.string().min(1).max(160),
  /**
   * A real destination URL, or null. MARA is told to leave this null unless
   * the supplied context actually contains the destination — Voom never
   * invents a link, and an unverified link also trips the existing Autopilot
   * safety evaluator, which keeps the item in Needs approval.
   */
  ctaUrl: z.string().min(1).max(500).nullable(),
  /** Who this email is written for (audience reasoning, not a recipient list). */
  audienceNote: z.string().max(500),
  /** Optional short justification for the proposed send time. */
  sendTimeNote: z.string().max(300),
  /** ISO-8601 with offset, or null to keep the skeleton's proposed time. */
  proposedSendAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type MaraCampaignEmailContent = z.infer<typeof campaignEmailContentSchema>;

export const CAMPAIGN_INSTAGRAM_FORMATS = ["post", "reel", "story"] as const;
export type CampaignInstagramFormat = (typeof CAMPAIGN_INSTAGRAM_FORMATS)[number];

export const campaignInstagramContentSchema = z.object({
  format: z.enum(CAMPAIGN_INSTAGRAM_FORMATS),
  purpose: z.string().min(1).max(1000),
  concept: z.string().min(1).max(160),
  hook: z.string().max(300),
  caption: z.string().min(1).max(2200),
  cta: z.string().max(160),
  /** Shot/visual direction for whoever produces the visual. Text only. */
  visualDirection: z.string().max(1200),
  /** Reels only: the short on-screen script / shot sequence. */
  script: z.array(z.string().min(1).max(300)).max(8),
  proposedSendAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type MaraCampaignInstagramContent = z.infer<typeof campaignInstagramContentSchema>;

/**
 * Multi-Social Core: TikTok Video content. The caption is short and the
 * script is a beat list — TikTok-native writing, never a restated Reel
 * caption (the duplicate-copy guard below enforces the difference).
 */
export const campaignTiktokContentSchema = z.object({
  purpose: z.string().min(1).max(1000),
  concept: z.string().min(1).max(160),
  hook: z.string().max(300),
  caption: z.string().min(1).max(400),
  cta: z.string().max(160),
  visualDirection: z.string().max(1200),
  /** The short beat-by-beat sequence (3-6 lines). */
  script: z.array(z.string().min(1).max(300)).min(1).max(8),
  hashtags: z.array(z.string().min(1).max(40)).max(8),
  proposedSendAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type MaraCampaignTiktokContent = z.infer<typeof campaignTiktokContentSchema>;

/**
 * Multi-Social Core: YouTube content. `format` distinguishes the Short from
 * the full Video. A full Video is a first-class long-form deliverable: it
 * must carry a real description and a script/outline — schema-enforced, not
 * optional. Planning it never triggers expensive media generation.
 */
export const CAMPAIGN_YOUTUBE_FORMATS = ["short", "video"] as const;
export type CampaignYoutubeFormat = (typeof CAMPAIGN_YOUTUBE_FORMATS)[number];

export const campaignYoutubeContentSchema = z.object({
  format: z.enum(CAMPAIGN_YOUTUBE_FORMATS),
  purpose: z.string().min(1).max(1000),
  concept: z.string().min(1).max(160),
  hook: z.string().max(300),
  /** Search-friendly video title. */
  title: z.string().min(1).max(160),
  /** 1-2 lines for a Short; a full 2-4 sentence description for a Video. */
  description: z.string().min(1).max(2000),
  caption: z.string().min(1).max(2200),
  cta: z.string().max(160),
  visualDirection: z.string().max(1200),
  /** Shorts: a short beat list. Videos: a real outline/script. */
  script: z.array(z.string().min(1).max(400)).min(1).max(12),
  proposedSendAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type MaraCampaignYoutubeContent = z.infer<typeof campaignYoutubeContentSchema>;

export const campaignActionContentSchema = z.object({
  /** The skeleton slot this content belongs to. MARA may not invent slots. */
  slot: z.number().int().min(0).max(MAX_CAMPAIGN_ACTIONS - 1),
  channel: z.enum([
    "email",
    "instagram_post",
    "instagram_reel",
    "instagram_story",
    "tiktok_video",
    "youtube_short",
    "youtube_video",
  ]),
  title: z.string().min(1).max(160),
  email: campaignEmailContentSchema.nullable(),
  instagram: campaignInstagramContentSchema.nullable(),
  tiktok: campaignTiktokContentSchema.nullable(),
  youtube: campaignYoutubeContentSchema.nullable(),
}).strict();

export type MaraCampaignActionContent = z.infer<typeof campaignActionContentSchema>;

export const campaignIntelligenceSchema = z.object({
  strategy: campaignStrategySchema,
  actions: z.array(campaignActionContentSchema).min(1).max(MAX_CAMPAIGN_ACTIONS),
  /** One short sentence on how real performance shaped the plan, or null. */
  performanceNote: z.string().max(500).nullable(),
}).strict();

export type MaraCampaignIntelligence = z.infer<typeof campaignIntelligenceSchema>;

/**
 * Provider-side structured output contract (strict `json_schema`), mirroring
 * the zod schemas above EXACTLY: `additionalProperties: false`, every property
 * listed in `required`, and optional values expressed as `["type","null"]`
 * unions rather than omitted keys. The zod parse stays the second safety
 * layer — nothing reaches the database without passing both.
 */
export const campaignIntelligenceJsonSchema = {
  name: "mara_campaign_intelligence",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["strategy", "actions", "performanceNote"],
    properties: {
      strategy: {
        type: "object",
        additionalProperties: false,
        required: ["objective", "coreMessage", "audienceAngle", "narrative", "ctaStrategy", "sequenceRationale"],
        properties: {
          objective: { type: "string", minLength: 1, maxLength: 300, description: "One sentence: what this campaign must achieve for the business." },
          coreMessage: { type: "string", minLength: 1, maxLength: 400, description: "The single idea every asset must communicate." },
          audienceAngle: { type: "string", minLength: 1, maxLength: 400, description: "Why this audience should care, in their own terms." },
          narrative: { type: "string", minLength: 1, maxLength: 600, description: "The campaign's story arc across the sequence." },
          ctaStrategy: { type: "string", minLength: 1, maxLength: 300, description: "How the call to action escalates across the sequence." },
          sequenceRationale: { type: "string", minLength: 1, maxLength: 600, description: "Why the actions are ordered this way, naming the channel of each move." },
        },
      },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CAMPAIGN_ACTIONS,
        description: "Exactly one entry per supplied skeleton slot, in the same order. Never add, remove, reorder or re-channel a slot.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slot", "channel", "title", "email", "instagram", "tiktok", "youtube"],
          properties: {
            slot: { type: "integer", minimum: 0, maximum: MAX_CAMPAIGN_ACTIONS - 1, description: "The skeleton slot index this content fills." },
            channel: { type: "string", enum: ["email", "instagram_post", "instagram_reel", "instagram_story", "tiktok_video", "youtube_short", "youtube_video"], description: "Copy the slot's channel exactly." },
            title: { type: "string", minLength: 1, maxLength: 160, description: "Short internal name for this action (max 12 words)." },
            email: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["purpose", "subject", "previewText", "body", "cta", "ctaUrl", "audienceNote", "sendTimeNote", "proposedSendAt"],
              properties: {
                purpose: { type: "string", minLength: 1, maxLength: 1000, description: "Why this email exists at this point in the sequence." },
                subject: { type: "string", minLength: 1, maxLength: 300, description: "Specific to this business and this stage. Never a generic teaser." },
                previewText: { type: "string", minLength: 1, maxLength: 500, description: "Preheader that extends the subject, never repeats it." },
                body: { type: "string", minLength: 1, maxLength: 12000, description: "Plain-text email body, 80-250 words, ending with a clear next step." },
                cta: { type: "string", minLength: 1, maxLength: 160, description: "The button/next-step label, max 8 words." },
                ctaUrl: { type: ["string", "null"], maxLength: 500, description: "A real destination URL from the supplied context, otherwise null." },
                audienceNote: { type: "string", maxLength: 500, description: "Who this email is written for and why." },
                sendTimeNote: { type: "string", maxLength: 300, description: "One short sentence justifying the proposed send time." },
                proposedSendAt: { type: ["string", "null"], description: "ISO-8601 with offset inside this slot's campaign day, or null to keep the proposed time." },
              },
            },
            instagram: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["format", "purpose", "concept", "hook", "caption", "cta", "visualDirection", "script", "proposedSendAt"],
              properties: {
                format: { type: "string", enum: ["post", "reel", "story"], description: "Must match the slot's channel." },
                purpose: { type: "string", minLength: 1, maxLength: 1000, description: "Why this Instagram action exists at this point in the sequence." },
                concept: { type: "string", minLength: 1, maxLength: 160, description: "Short internal name for the asset (max 12 words)." },
                hook: { type: "string", maxLength: 300, description: "The first line / first frame that stops the scroll." },
                caption: { type: "string", minLength: 1, maxLength: 2200, description: "The complete caption. Must NOT restate an email body." },
                cta: { type: "string", maxLength: 160, description: "One short call to action, max 8 words." },
                visualDirection: { type: "string", maxLength: 1200, description: "Text-only shot/visual direction. No paid media is generated from it here." },
                script: { type: "array", maxItems: 8, description: "Reels only: the short on-screen script / shot sequence. Empty for Posts and Stories.", items: { type: "string", minLength: 1, maxLength: 300 } },
                proposedSendAt: { type: ["string", "null"], description: "ISO-8601 with offset inside this slot's campaign day, or null to keep the proposed time." },
              },
            },
            tiktok: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["purpose", "concept", "hook", "caption", "cta", "visualDirection", "script", "hashtags", "proposedSendAt"],
              description: "TikTok Video slots only; null for every other channel.",
              properties: {
                purpose: { type: "string", minLength: 1, maxLength: 1000, description: "Why this TikTok action exists at this point in the sequence." },
                concept: { type: "string", minLength: 1, maxLength: 160, description: "Short internal name for the asset (max 12 words)." },
                hook: { type: "string", maxLength: 300, description: "The blunt, conversational first line. Never the Instagram Reel's hook reworded." },
                caption: { type: "string", minLength: 1, maxLength: 400, description: "One short TikTok caption line. Never a restated Instagram caption or email body." },
                cta: { type: "string", maxLength: 160, description: "One short call to action, max 8 words." },
                visualDirection: { type: "string", maxLength: 1200, description: "Text-only shot direction. No paid media is generated from it here." },
                script: { type: "array", minItems: 1, maxItems: 8, description: "The short beat-by-beat sequence (3-6 lines).", items: { type: "string", minLength: 1, maxLength: 300 } },
                hashtags: { type: "array", maxItems: 8, description: "3-5 TikTok tags without the # symbol.", items: { type: "string", minLength: 1, maxLength: 40 } },
                proposedSendAt: { type: ["string", "null"], description: "ISO-8601 with offset inside this slot's campaign day, or null to keep the proposed time." },
              },
            },
            youtube: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["format", "purpose", "concept", "hook", "title", "description", "caption", "cta", "visualDirection", "script", "proposedSendAt"],
              description: "YouTube Short and YouTube Video slots only; null for every other channel.",
              properties: {
                format: { type: "string", enum: ["short", "video"], description: "Must match the slot's channel: youtube_short is 'short', youtube_video is 'video'." },
                purpose: { type: "string", minLength: 1, maxLength: 1000, description: "Why this YouTube action exists at this point in the sequence." },
                concept: { type: "string", minLength: 1, maxLength: 160, description: "Short internal name for the asset (max 12 words)." },
                hook: { type: "string", maxLength: 300, description: "The opening line that promises the payoff." },
                title: { type: "string", minLength: 1, maxLength: 160, description: "Search-friendly video title; front-load the topic." },
                description: { type: "string", minLength: 1, maxLength: 2000, description: "1-2 lines for a Short. For a full Video: 2-4 sentences with the payoff and chapters." },
                caption: { type: "string", minLength: 1, maxLength: 2200, description: "The complete caption/community post copy. Never a restated email body." },
                cta: { type: "string", maxLength: 160, description: "One short call to action, max 8 words." },
                visualDirection: { type: "string", maxLength: 1200, description: "Text-only shot/outline direction. Planning NEVER generates long-form video." },
                script: { type: "array", minItems: 1, maxItems: 12, description: "Shorts: 3-5 beats. Videos: a real outline (hook, 3-5 sections, closing CTA).", items: { type: "string", minLength: 1, maxLength: 400 } },
                proposedSendAt: { type: ["string", "null"], description: "ISO-8601 with offset inside this slot's campaign day, or null to keep the proposed time." },
              },
            },
          },
        },
      },
      performanceNote: { type: ["string", "null"], maxLength: 500, description: "One short sentence on how the supplied real performance evidence shaped the plan, or null when none was supplied." },
    },
  },
} as const;

// ─── Prompt ────────────────────────────────────────────────────────────────

export const CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager. You are filling in ONE already-designed campaign for the authenticated user's own business.

The campaign STRUCTURE is already decided and is not yours to change. You receive a skeleton: an ordered list of slots, each with a fixed channel (email, instagram_post, instagram_reel, instagram_story, tiktok_video, youtube_short or youtube_video), a fixed campaign day and a proposed time. Your job is the strategy and the content inside that structure.

The campaign also has AUTHORITATIVE CHANNELS in campaign.selectedChannels (any of "instagram", "tiktok", "youtube", "email") and a channelPlan. Those channels are the whole campaign. When channelPlan names a single channel, never write about, promise, or refer to any channel that is not selected. When it is "multichannel", the channels are ONE coordinated sequence, not separate plans.

PLATFORM DIFFERENCES ARE REAL — never paste the same content across platforms:
- Instagram Post: a visual feed moment; scannable caption, benefit-led, hashtags allowed.
- Instagram Reel: short vertical video; scroll-stopping hook, 3-6 shot-by-shot script lines.
- Instagram Story: one overlay line, one sticker idea, no caption essay.
- TikTok Video: TikTok-NATIVE, not a reposted Reel — blunt conversational hook, fast cuts, sound-forward beats, one short caption line, 3-5 tags. Never reuse the Reel's hook or caption wording.
- YouTube Short: search-friendly title front-loading the topic, 1-2 line description, explicit payoff promise; less slang-dependent than TikTok.
- YouTube Video: the campaign's depth piece — a specific title, a 2-4 sentence description with chapters, and a real outline/script (hook, 3-5 sections, closing CTA). It may explain what the short-form pieces teased. Planning it NEVER generates video.
- Email: specific subject, preview text that extends it, 80-250 word body, one clear CTA.
A coordinated multichannel arc typically reads: teaser Reel → TikTok variation → email launch → YouTube Short → deeper YouTube video → Instagram reminder. Each action differs in hook, wording and angle while carrying the same core message. Follow campaign.platformRules for the supplied channels.

Return JSON only, matching the requested schema exactly.

Hard rules:
- Return exactly one action object per skeleton slot, with the SAME slot index and the SAME channel. Never add slots, never drop slots, never change a channel, never reorder.
- Fill ONLY the payload that matches the slot's channel ("email", "instagram", "tiktok" or "youtube"); every other payload must be null.
- Follow campaign.channelRules and campaign.platformRules exactly.
- Write like this specific business. Never invent prices, discounts, offers, opening hours, locations, statistics, reviews, awards, guarantees or claims that are not in the supplied context.
- ctaUrl must be a real destination that appears in the supplied context, otherwise null. Never invent a URL.
- In a multichannel campaign the platforms must complement each other, not repeat: a caption must never restate an email body, and a TikTok caption must never restate a Reel caption. In any campaign, two actions must never carry the same caption, body, script or CTA. Vary the angle per stage: announce, then explain the benefit, then proof, then a final clear next step.
- Every email needs a specific subject (never a bare teaser), a preview text that extends it, a concise plain-text body of 80-250 words, and one clear CTA.
- Every Instagram action needs a concept, a hook, a full caption and a CTA. For a Reel, "script" must be a short shot-by-shot sequence (3-6 lines) and "visualDirection" must describe what to film. For Posts and Stories "script" must be an empty array. Instagram Stories carry no hashtags-heavy essay: keep them short.
- Every TikTok action needs a beat-by-beat "script" (3-6 lines), a blunt hook that is NOT the Reel's hook, and a one-line caption with 3-5 tags.
- Every YouTube action needs "title" and "description". For youtube_video, "description" must be 2-4 sentences with the payoff and chapters, and "script" must be a real outline (hook, 3-5 sections, closing CTA) — a full YouTube video is long-form depth, never a renamed Short.
- proposedSendAt, when you set one, must stay inside the same campaign day as that slot's proposed time. Otherwise return null and the proposed time is kept.
- recentPerformance, when present, is EVIDENCE from this business's own already-published Instagram content. It is advisory: bias one or two choices toward what measurably worked, keep the sequence diverse, never repeat an old winner verbatim, and never invent metrics. When it is absent, say nothing about performance. No TikTok or YouTube performance data exists; never claim any.
- Nothing you write is sent or published by this step. Never claim an email was sent, a post was published, or a visual was generated. This is a draft for the user to review. TikTok and YouTube publishing is not even connected yet: never promise a publish time on those platforms in the copy.
- Plain text only. No markdown.`;

// ─── Context handed to MARA ────────────────────────────────────────────────

/** Compact, bounded performance evidence. Absent entirely when insufficient. */
export interface CampaignPerformanceContext {
  sampleSize: number;
  confidence: "low" | "moderate";
  windowDays: number;
  /** What the comparison is measured on, e.g. "reach (accounts reached)". */
  basis: string | null;
  bestFormat: string | null;
  strongestTopic: string | null;
  weakerTopics: string[];
  engagementSignals: string[];
  guidance: string[];
}

export const CAMPAIGN_PERFORMANCE_GUIDANCE = [
  "recentPerformance is advisory evidence from this business's own published Instagram content, never a rule.",
  "Bias one or two choices toward what measurably worked; keep the sequence diverse and do not repeat an old winner.",
  "Never invent metrics, percentages or results that recentPerformance does not contain.",
];

/**
 * Maps the planner's advisory performance input into the compact context MARA
 * receives. Returns null — and therefore omits `recentPerformance` from the
 * payload entirely — whenever there is not enough real data.
 */
export function buildCampaignPerformanceContext(
  performance: PlannerPerformanceInput | null,
): CampaignPerformanceContext | null {
  if (!performance) return null;
  if (!Number.isFinite(performance.sampleSize) || performance.sampleSize < 3) return null;
  return {
    sampleSize: performance.sampleSize,
    confidence: performance.confidence === "moderate" ? "moderate" : "low",
    windowDays: performance.windowDays ?? 30,
    basis: performance.basis ?? null,
    bestFormat: performance.bestContentTypeLabel ?? null,
    strongestTopic: performance.strongestTopicLabel ?? null,
    weakerTopics: (performance.underperformerLabels ?? []).slice(0, 3),
    engagementSignals: (performance.engagementSignals ?? []).slice(0, 3),
    guidance: [...CAMPAIGN_PERFORMANCE_GUIDANCE],
  };
}

export interface CampaignIntelligenceContextInput {
  businessName: string | null;
  brand: CampaignBrandContext;
  brief: CampaignBrief;
  goalLabel: string;
  audiences: PlannerAudience[];
  selectedAudience: PlannerAudience | null;
  automationMode: string;
  skeleton: PlannedAction[];
  summary: PlannedCampaignSummary;
  performance: PlannerPerformanceInput | null;
  /** Workspace/business timezone used for every proposed instant. */
  timeZone?: string | null;
  /**
   * Campaigns v3: the campaign's authoritative channel selection. MARA is told
   * which channels exist so a single-channel campaign never receives copy that
   * references the other one, and a two-channel campaign is written as ONE
   * coordinated sequence rather than two unrelated plans.
   */
  channels?: readonly CampaignChannel[] | null;
  now: Date;
  /**
   * Present only for a single-action "Regenerate draft with MARA": the action
   * being rewritten plus what its siblings already say, so the new draft
   * complements the rest of the campaign instead of repeating it.
   */
  focus?: {
    slot: number;
    instruction: string;
    siblings: Array<{ channel: string; title: string }>;
  };
}

/**
 * The exact, bounded payload MARA receives. Everything here is real account
 * data or the deterministic skeleton — no media bytes, no recipient lists, no
 * credentials. Text only.
 */
export function buildCampaignIntelligenceContext(input: CampaignIntelligenceContextInput) {
  const performance = buildCampaignPerformanceContext(input.performance);
  const brandVoice = (input.brand.brandPersonality ?? []).filter(Boolean).slice(0, 8);
  const timeZone = accountTimezone(input.timeZone);
  const today = localDate(input.now, timeZone);
  // v3: MARA plans inside the campaign's own channel selection. The skeleton
  // already only contains allowed channels; this makes the selection explicit
  // so the copy never references a channel the campaign does not run on.
  const channels = resolvePlanChannels(input.channels, input.brief);
  const channelsAllowed = CAMPAIGN_ACTION_CHANNELS.filter(
    (channel) => actionChannelFamily(channel) !== null && channels.includes(actionChannelFamily(channel) as CampaignChannel),
  );
  const channelPlan = channels.length > 1 ? "multichannel" : `${channels[0]}_only`;

  return {
    task: "fill_campaign_skeleton",
    currentTime: input.now.toISOString(),
    timeZone,
    schedulingRules: {
      earliestSameDay: `${today} at least ${CAMPAIGN_MIN_LEAD_MINUTES} minutes after currentTime, rounded up to the next minute`,
      latestSameDay: `${today} 23:59 in the business timezone`,
      neverPast: true,
      preserveSpacing: true,
    },
    business: {
      name: (input.businessName ?? input.brand.brandName ?? "").slice(0, 160),
      description: (input.brand.brandDescription ?? "").slice(0, 800),
      industry: (input.brand.industry ?? "").slice(0, 200),
      targetCustomer: (input.brand.targetCustomer ?? []).filter(Boolean).slice(0, 6),
      mainGoal: (input.brand.mainGoal ?? "").slice(0, 300),
    },
    brandVoice: brandVoice.length ? brandVoice : null,
    campaign: {
      idea: input.brief.name.slice(0, 160),
      goal: input.brief.goal,
      goalLabel: input.goalLabel,
      offerDetails: (input.brief.offerDetails ?? "").slice(0, 1000) || null,
      targetAudience: (input.brief.targetAudience ?? "").slice(0, 1000) || null,
      notes: (input.brief.notes ?? "").slice(0, 2000) || null,
      startsOn: input.brief.startAt,
      endsOn: input.brief.endAt,
      timeZone,
      days: input.summary.days,
      /** v3: the campaign's authoritative channels — never wider than this. */
      selectedChannels: channels,
      /** e.g. 'instagram_only' | 'email_only' | 'tiktok_only' | 'multichannel'. */
      channelPlan,
      channelRules: CAMPAIGN_CHANNEL_RULES[channelPlan] ?? CAMPAIGN_CHANNEL_RULES.multichannel,
      /**
       * Multi-Social Core: per-platform native-writing rules and the
       * coordinated-sequence rule, built from the ONE platform vocabulary
       * (lib/social/platforms) for exactly the selected channels.
       */
      platformRules: coordinatedSequenceRule(channels),
      platformFormats: platformDefinitionsFor(channelsAllowed),
      selectedAudience: input.selectedAudience
        ? { name: input.selectedAudience.name.slice(0, 120), eligibleEmailCount: input.selectedAudience.eligibleEmailCount ?? null }
        : null,
      availableAudiences: input.audiences.slice(0, 20).map((audience) => audience.name.slice(0, 120)),
    },
    automationMode: input.automationMode,
    automationModeRules: AUTOMATION_MODE_RULES[input.automationMode] ?? AUTOMATION_MODE_RULES.manual,
    skeleton: {
      days: input.summary.days,
      maxActions: MAX_CAMPAIGN_ACTIONS,
      channelsAllowed,
      slots: input.skeleton.map((action) => ({
        slot: action.slot,
        channel: action.channel,
        stage: action.stage,
        campaignDay: action.dayOffset + 1,
        proposedTime: action.scheduledFor,
        plannedRole: action.purpose.slice(0, 300),
      })),
    },
    ...(performance ? { recentPerformance: performance } : {}),
    ...(input.focus
      ? {
          regenerateSingleAction: {
            slot: input.focus.slot,
            instruction: input.focus.instruction.slice(0, 500),
            otherActionsInThisCampaign: input.focus.siblings.slice(0, 16),
          },
        }
      : {}),
  };
}

/**
 * Campaigns v3 — what each channel selection means for the copy MARA writes.
 *
 * A two-channel campaign is ONE coordinated sequence, not two plans that happen
 * to share dates: Instagram carries the visible moments and email carries the
 * detail and the follow-up, each referencing the other's role without repeating
 * its words.
 */
export const CAMPAIGN_CHANNEL_RULES: Record<string, string> = {
  multichannel:
    "This campaign runs on MULTIPLE channels as ONE coordinated sequence. Order the story across them: short-form video earns attention, email carries detail and the direct next step, long-form YouTube explains in depth, and reminders close. Each channel does what it is best at, natively. Never restate an email body in a caption, a caption in an email body, or a Reel's hook in a TikTok video.",
  instagram_only:
    "This campaign runs on Instagram ONLY. Write every action as an Instagram moment. Never mention an email, a newsletter, an inbox, a subject line, TikTok, YouTube or 'we'll email you'. Carry the whole sequence visually: announce, explain the benefit, prove it, then close.",
  email_only:
    "This campaign runs on email ONLY. Write every action as an email. Never mention a Reel, a Story, a feed post, a caption, TikTok, YouTube or 'see our Instagram'. Carry the whole sequence in the inbox: announce, explain the benefit, then close with one clear next step.",
  tiktok_only:
    "This campaign runs on TikTok ONLY. Write every action TikTok-native: blunt conversational hooks, fast beats, one-line captions, 3-5 tags. Never mention an email, Instagram, YouTube or 'see our profile bio link in bio' style cross-posting. Carry the whole sequence in short-form video: hook, prove, close.",
  youtube_only:
    "This campaign runs on YouTube ONLY. Shorts are discovery moments with search-friendly titles; the full Video is the depth piece with a real description and outline. Never mention an email, Instagram or TikTok. Carry the whole sequence on YouTube: tease with Shorts, explain in the full video, close with one clear next step.",
};

/** Truthful per-mode statement of what this build may and may not do. */
export const AUTOMATION_MODE_RULES: Record<string, string> = {
  manual: "Manual: you are drafting only because the user explicitly asked. Nothing is approved, sent, published or paid for automatically.",
  assisted: "Assisted: you prepare strategy, copy, concepts and a proposed schedule. Nothing is sent, published or paid for automatically — the user approves execution.",
  autopilot: "Autopilot: safe actions may be approved internally after this build. Paid media is still governed by the central plan/credit guard and is never triggered by campaign generation.",
};

// ─── Merge: skeleton authority + validated MARA content ────────────────────

export interface EnrichedCampaignAction extends PlannedAction {
  /** Which layer produced this action's content. */
  contentSource: "mara" | "deterministic";
  /**
   * The canonical format: Instagram post/reel/story, TikTok video, YouTube
   * short/video. Present for every non-email action.
   */
  format?: CampaignInstagramFormat | CampaignYoutubeFormat | "video";
  hook?: string;
  visualDirection?: string;
  script?: string[];
  ctaUrl?: string | null;
  audienceNote?: string;
  sendTimeNote?: string;
}

export interface ApplyIntelligenceInput {
  skeleton: PlannedAction[];
  summary: PlannedCampaignSummary;
  brief: CampaignBrief;
  brand: CampaignBrandContext;
  goalLabel: string;
  /** null when MARA failed, was not configured, or returned nothing usable. */
  intelligence: MaraCampaignIntelligence | null;
  /** Workspace/business timezone; defaults to the account timezone. */
  timeZone?: string | null;
  /**
   * Campaigns v3: the campaign's authoritative channels. Used as a second
   * defence — an action outside the selection keeps its deterministic draft and
   * can never be widened by MARA's reply.
   */
  channels?: readonly CampaignChannel[] | null;
  now?: Date;
}

export interface ApplyIntelligenceResult {
  actions: EnrichedCampaignAction[];
  strategy: MaraCampaignStrategy;
  /** The short, human-readable "MARA's approach" line. */
  strategySummary: string;
  source: "mara" | "deterministic";
  performanceNote: string | null;
  /** Slots whose MARA content was refused and kept the deterministic draft. */
  fallbackSlots: number[];
}

const INSTAGRAM_FORMAT_FOR_CHANNEL: Record<string, CampaignInstagramFormat> = {
  instagram_post: "post",
  instagram_reel: "reel",
  instagram_story: "story",
};

/** Multi-Social Core: the canonical format for every non-email action channel. */
const FORMAT_FOR_ACTION_CHANNEL: Record<string, CampaignInstagramFormat | CampaignYoutubeFormat> = {
  ...INSTAGRAM_FORMAT_FOR_CHANNEL,
  tiktok_video: "video",
  youtube_short: "short",
  youtube_video: "video",
};

/** How similar two pieces of copy may be before they count as duplicates. */
const DUPLICATE_SIMILARITY = 0.9;
/** The same CTA may legitimately appear twice (e.g. open + close), never more. */
const MAX_CTA_REPEATS = 2;

/**
 * Fills the deterministic skeleton with validated MARA content.
 *
 * This is the safety boundary: the skeleton's length, channels, stages, days
 * and timing boundaries always win, and any MARA field that fails a rule is
 * replaced by the deterministic v1 draft for that action (never by nothing).
 */
export function applyCampaignIntelligence(input: ApplyIntelligenceInput): ApplyIntelligenceResult {
  const now = input.now ?? new Date();
  const skeleton = [...input.skeleton].sort((a, b) => a.slot - b.slot);
  const intelligence = input.intelligence;
  const fallbackSlots: number[] = [];
  const channels = resolvePlanChannels(input.channels, input.brief);

  const bySlot = new Map<number, MaraCampaignActionContent>();
  for (const action of intelligence?.actions ?? []) {
    if (!bySlot.has(action.slot)) bySlot.set(action.slot, action);
  }

  const usedCopy: string[] = [];
  const usedCtas = new Map<string, number>();

  const merged: EnrichedCampaignAction[] = skeleton.map((base) => {
    const candidate = bySlot.get(base.slot);
    const deterministic = withSafety(enrichDeterministic(base), now);

    // v3: the campaign's own channel selection is authoritative. An action
    // outside it keeps its deterministic draft — MARA can never widen the
    // channels a campaign runs on.
    const family = actionChannelFamily(base.channel);
    if (!family || !channels.includes(family)) {
      fallbackSlots.push(base.slot);
      return deterministic;
    }

    // A missing slot, a channel MARA changed, or a payload for the wrong
    // channel: the deterministic draft stands.
    if (!candidate || candidate.channel !== base.channel) {
      fallbackSlots.push(base.slot);
      return deterministic;
    }

    const scheduledFor = resolveProposedTime(
      base.channel === "email"
        ? candidate.email?.proposedSendAt
        : base.channel === "tiktok_video"
          ? candidate.tiktok?.proposedSendAt
          : base.channel === "youtube_short" || base.channel === "youtube_video"
            ? candidate.youtube?.proposedSendAt
            : candidate.instagram?.proposedSendAt,
      base,
      now,
      input.timeZone,
    );

    if (base.channel === "email") {
      const email = candidate.email;
      if (!email || candidate.instagram || candidate.tiktok || candidate.youtube) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      if (isDuplicate(email.body, usedCopy)) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      const cta = repeatedCta(email.cta, usedCtas) ? deterministicCtaFor(base) ?? email.cta : email.cta;
      usedCopy.push(normalizeCopy(email.body));
      return withSafety({
        ...deterministic,
        contentSource: "mara",
        scheduledFor,
        title: candidate.title,
        purpose: email.purpose,
        subject: email.subject,
        previewText: email.previewText,
        body: email.body,
        cta,
        ctaUrl: email.ctaUrl,
        audienceNote: email.audienceNote,
        sendTimeNote: email.sendTimeNote,
      }, now);
    }

    // ── Multi-Social Core: TikTok slot ────────────────────────────────────
    if (base.channel === "tiktok_video") {
      const tiktok = candidate.tiktok;
      // Wrong payload shape, or a payload for another channel: refuse.
      if (!tiktok || candidate.email || candidate.instagram || candidate.youtube) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      // A TikTok video must carry real beats — an empty script is refused.
      if (!tiktok.script.length || !tiktok.visualDirection.trim()) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      // Cross-platform duplication guard: a TikTok caption that restates the
      // Reel caption (or any earlier copy) is refused — MARA cannot paste.
      if (isDuplicate(tiktok.caption, usedCopy) || isDuplicate(tiktok.hook, usedCopy)) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      const cta = repeatedCta(tiktok.cta, usedCtas) ? deterministicCtaFor(base) ?? tiktok.cta : tiktok.cta;
      usedCopy.push(normalizeCopy(tiktok.caption));
      usedCopy.push(normalizeCopy(tiktok.hook));
      const hashtags = tiktok.hashtags.slice(0, 5);
      return withSafety({
        ...deterministic,
        contentSource: "mara",
        scheduledFor,
        title: candidate.title,
        purpose: tiktok.purpose,
        concept: tiktok.concept,
        caption: composeCaption(tiktok.caption, cta, hashtags),
        hashtags,
        format: "video",
        hook: tiktok.hook,
        cta,
        visualDirection: tiktok.visualDirection,
        script: tiktok.script,
      }, now);
    }

    // ── Multi-Social Core: YouTube slot (Short or full Video) ─────────────
    if (base.channel === "youtube_short" || base.channel === "youtube_video") {
      const youtube = candidate.youtube;
      const expectedFormat = base.channel === "youtube_short" ? "short" : "video";
      if (!youtube || candidate.email || candidate.instagram || candidate.tiktok || youtube.format !== expectedFormat) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      // Both YouTube formats need a real title, description and outline. The
      // full Video is the depth piece: its script must be a real outline.
      if (!youtube.script.length || !youtube.title.trim() || !youtube.description.trim()) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      if (expectedFormat === "video" && youtube.script.length < 3) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      if (isDuplicate(youtube.caption, usedCopy) || isDuplicate(youtube.description, usedCopy)) {
        fallbackSlots.push(base.slot);
        return deterministic;
      }
      const cta = repeatedCta(youtube.cta, usedCtas) ? deterministicCtaFor(base) ?? youtube.cta : youtube.cta;
      usedCopy.push(normalizeCopy(youtube.caption));
      usedCopy.push(normalizeCopy(youtube.description));
      return withSafety({
        ...deterministic,
        contentSource: "mara",
        scheduledFor,
        title: candidate.title,
        purpose: youtube.purpose,
        concept: youtube.concept,
        caption: composeCaption(youtube.caption, cta, []),
        hashtags: [],
        format: youtube.format,
        hook: youtube.hook,
        cta,
        visualDirection: youtube.visualDirection,
        script: youtube.script,
        description: youtube.description,
      }, now);
    }

    const instagram = candidate.instagram;
    const expectedFormat = INSTAGRAM_FORMAT_FOR_CHANNEL[base.channel];
    if (!instagram || candidate.email || candidate.tiktok || candidate.youtube || instagram.format !== expectedFormat) {
      fallbackSlots.push(base.slot);
      return deterministic;
    }
    // Reels must actually carry a script and shot direction; Posts/Stories must not.
    const wantsScript = expectedFormat === "reel";
    if (wantsScript && (!instagram.script.length || !instagram.visualDirection.trim())) {
      fallbackSlots.push(base.slot);
      return deterministic;
    }
    if (!wantsScript && instagram.script.length) {
      fallbackSlots.push(base.slot);
      return deterministic;
    }
    if (isDuplicate(instagram.caption, usedCopy)) {
      fallbackSlots.push(base.slot);
      return deterministic;
    }
    const cta = repeatedCta(instagram.cta, usedCtas) ? deterministicCtaFor(base) ?? instagram.cta : instagram.cta;
    usedCopy.push(normalizeCopy(instagram.caption));

    return withSafety({
      ...deterministic,
      contentSource: "mara",
      scheduledFor,
      title: candidate.title,
      purpose: instagram.purpose,
      concept: instagram.concept,
      caption: composeCaption(instagram.caption, cta, base.hashtags ?? []),
      hashtags: base.hashtags ?? [],
      format: instagram.format,
      hook: instagram.hook,
      cta,
      visualDirection: instagram.visualDirection,
      script: instagram.script,
    }, now);
  });

  // The timeline is one ordered list: run the same time guard after MARA's
  // content merge, then re-sort and re-slot contiguously. This is the second
  // line of defence if a caller supplies an unsafe skeleton or MARA returns a
  // boundary value the per-slot resolver refused.
  const timed = enforceCampaignTiming(merged, input.brief, now, input.timeZone ?? undefined);
  timed.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  timed.forEach((action, index) => { action.slot = index; });
  const finalActions = timed;

  const source: "mara" | "deterministic" = intelligence ? "mara" : "deterministic";
  const strategy = intelligence ? intelligence.strategy : deterministicStrategy(input);
  const performanceNote = intelligence
    ? (intelligence.performanceNote ?? null)
    : input.summary.performanceNote;

  return {
    actions: finalActions,
    strategy,
    strategySummary: campaignStrategySummary(strategy),
    source,
    performanceNote: source === "mara" ? performanceNote : input.summary.performanceNote,
    fallbackSlots: [...new Set(fallbackSlots)].sort((a, b) => a - b),
  };
}

function enrichDeterministic(base: PlannedAction): EnrichedCampaignAction {
  return {
    ...base,
    contentSource: "deterministic",
    ...(base.channel === "email" ? {} : { format: FORMAT_FOR_ACTION_CHANNEL[base.channel] }),
  };
}

/** Re-runs the existing Autopilot safety evaluation on the FINAL content. */
function withSafety(action: EnrichedCampaignAction, now: Date): EnrichedCampaignAction {
  const content = [action.subject, action.previewText, action.body, action.caption, action.concept].filter(Boolean).join("\n");
  const evaluation = evaluateAutopilotRecommendation(
    { title: action.title, content, topic: action.purpose, publishAt: action.scheduledFor },
    now,
  );
  return { ...action, autopilotSafe: evaluation.safe, autopilotBlockers: evaluation.blockers };
}

/**
 * A proposed time is accepted only when it stays inside the skeleton slot's
 * own campaign day and is at least now plus ten minutes in the business
 * timezone. Anything else keeps the deterministic time.
 */
function resolveProposedTime(
  proposed: string | null | undefined,
  base: PlannedAction,
  now: Date,
  timeZone?: string | null,
): string {
  if (!proposed) return base.scheduledFor;
  const parsed = Date.parse(proposed);
  if (!Number.isFinite(parsed)) return base.scheduledFor;
  const zone = accountTimezone(timeZone);
  const proposedDate = isoToLocalDate(new Date(parsed).toISOString(), zone);
  const baseDate = isoToLocalDate(base.scheduledFor, zone);
  const earliest = now.getTime() + CAMPAIGN_MIN_LEAD_MINUTES * 60_000;
  const end = Date.parse(localToUtcIso(proposedDate, 23 * 60 + 59, zone));
  if (proposedDate === baseDate && parsed >= earliest && parsed <= end) {
    return new Date(parsed).toISOString();
  }
  return base.scheduledFor;
}

function normalizeCopy(text: string): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalizeCopy(text).split(" ").filter(Boolean));
}

/** True when this copy is identical or near-identical to copy already used. */
function isDuplicate(text: string, used: string[]): boolean {
  const normalized = normalizeCopy(text);
  if (!normalized) return false;
  const candidate = tokens(text);
  for (const previous of used) {
    if (!previous) continue;
    if (previous === normalized) return true;
    const other = new Set(previous.split(" ").filter(Boolean));
    if (!candidate.size || !other.size) continue;
    let shared = 0;
    for (const token of candidate) if (other.has(token)) shared += 1;
    const similarity = shared / Math.max(candidate.size, other.size);
    if (similarity >= DUPLICATE_SIMILARITY) return true;
  }
  return false;
}

function repeatedCta(cta: string | undefined, used: Map<string, number>): boolean {
  const key = normalizeCopy(cta ?? "");
  if (!key) return false;
  const count = (used.get(key) ?? 0) + 1;
  used.set(key, count);
  return count > MAX_CTA_REPEATS;
}

/**
 * The deterministic draft's own CTA for this slot.
 *
 * Used when MARA repeated one CTA too often: rather than inventing a new one,
 * Voom falls back to the CTA the deterministic planner already wrote for this
 * channel and stage (an email's structured `cta`, or the closing line of the
 * planned caption for Instagram).
 */
function deterministicCtaFor(base: PlannedAction): string | null {
  const own = base.cta?.trim();
  if (own) return own.slice(0, 160);
  const paragraphs = (base.caption ?? "")
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    // Drop the trailing hashtag block.
    .filter((part) => !/^#\S+(?:\s+#\S+)*$/.test(part));
  const closing = paragraphs.at(-1)?.replace(/\s+/g, " ").trim();
  return closing && closing.length <= 160 ? closing : null;
}

function composeCaption(caption: string, cta: string, hashtags: string[]): string {
  const tags = hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ");
  return [caption.trim(), cta.trim() ? `CTA: ${cta.trim()}` : "", tags].filter(Boolean).join("\n\n").slice(0, 2200);
}

// ─── Strategy presentation ─────────────────────────────────────────────────

/**
 * The short, human-readable summary shown as "MARA's approach". Deliberately
 * compact — the full strategy object is stored separately for the detail
 * block, and no AI essay is ever surfaced to the user.
 */
export function campaignStrategySummary(strategy: MaraCampaignStrategy): string {
  const text = `${strategy.sequenceRationale.trim()} ${strategy.objective.trim()}`.replace(/\s+/g, " ").trim();
  if (text.length <= 320) return text;
  const cut = text.slice(0, 320);
  const lastSentence = cut.lastIndexOf(". ");
  return `${(lastSentence > 120 ? cut.slice(0, lastSentence + 1) : cut).trim()}…`;
}

/**
 * The deterministic v1 fallback strategy. Used when MARA is unavailable or its
 * response was rejected, so a campaign always has an honest, compact strategy
 * block — labelled by `source`, never presented as MARA reasoning.
 */
export function deterministicStrategy(input: Omit<ApplyIntelligenceInput, "intelligence">): MaraCampaignStrategy {
  const goalLabel = input.goalLabel;
  const offer = input.brief.offerDetails?.trim();
  const audience = input.brief.targetAudience?.trim() || input.brand.targetCustomer?.[0] || "your existing audience";
  const emailCount = input.skeleton.filter((action) => action.channel === "email").length;
  const instagramCount = input.skeleton.filter((action) => action.channel.startsWith("instagram_")).length;
  const reelCount = input.skeleton.filter((action) => action.channel === "instagram_reel").length;
  const storyCount = input.skeleton.filter((action) => action.channel === "instagram_story").length;
  const tiktokCount = input.skeleton.filter((action) => action.channel === "tiktok_video").length;
  const youtubeShortCount = input.skeleton.filter((action) => action.channel === "youtube_short").length;
  const youtubeVideoCount = input.skeleton.filter((action) => action.channel === "youtube_video").length;

  const moves = [
    instagramCount ? "Instagram carries the announcement" : "",
    reelCount ? "a Reel explains the benefit" : "",
    tiktokCount ? `TikTok retells the moment natively (${tiktokCount === 1 ? "1 video" : `${tiktokCount} videos`})` : "",
    youtubeShortCount ? `a YouTube Short extends discovery (${youtubeShortCount === 1 ? "1 Short" : `${youtubeShortCount} Shorts`})` : "",
    youtubeVideoCount ? `the full YouTube Video goes deep (${youtubeVideoCount === 1 ? "1 video" : `${youtubeVideoCount} videos`})` : "",
    storyCount ? "a Story keeps it present" : "",
    emailCount ? `email goes into detail and drives the next step (${emailCount === 1 ? "1 email" : `${emailCount} emails`})` : "",
  ].filter(Boolean);

  return {
    objective: `${goalLabel} for ${input.brand.brandName?.trim() || "your business"} over ${input.summary.days} day${input.summary.days === 1 ? "" : "s"}.`,
    coreMessage: input.brief.name.trim() + (offer ? `, with ${offer}.` : "."),
    audienceAngle: `Written for ${audience}, focusing on what changes for them rather than on the business.`,
    narrative: input.summary.narrative,
    ctaStrategy: "One clear next step per action, escalating from interest to a direct visit or reply.",
    sequenceRationale: moves.length ? `Structured sequence: ${moves.join(", ")}.` : input.summary.narrative,
  };
}

/** The stored strategy block: the strategy itself plus how it was produced. */
export interface CampaignStrategyView extends MaraCampaignStrategy {
  summary: string;
  source: "mara" | "deterministic";
  performanceNote: string | null;
}

export function toCampaignStrategyView(result: ApplyIntelligenceResult): CampaignStrategyView {
  return {
    ...result.strategy,
    summary: result.strategySummary,
    source: result.source,
    performanceNote: result.performanceNote,
  };
}
