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
import {
  accountTimezone,
  isoToLocalDate,
  localDate,
  localToUtcIso,
} from "@/lib/voom/timezone";
import { CAMPAIGN_MIN_LEAD_MINUTES, enforceCampaignTiming } from "./planner";
import {
  MAX_CAMPAIGN_ACTIONS,
  type CampaignBrandContext,
  type CampaignBrief,
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

export const campaignActionContentSchema = z.object({
  /** The skeleton slot this content belongs to. MARA may not invent slots. */
  slot: z.number().int().min(0).max(MAX_CAMPAIGN_ACTIONS - 1),
  channel: z.enum(["email", "instagram_post", "instagram_reel", "instagram_story"]),
  title: z.string().min(1).max(160),
  email: campaignEmailContentSchema.nullable(),
  instagram: campaignInstagramContentSchema.nullable(),
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
          required: ["slot", "channel", "title", "email", "instagram"],
          properties: {
            slot: { type: "integer", minimum: 0, maximum: MAX_CAMPAIGN_ACTIONS - 1, description: "The skeleton slot index this content fills." },
            channel: { type: "string", enum: ["email", "instagram_post", "instagram_reel", "instagram_story"], description: "Copy the slot's channel exactly." },
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
          },
        },
      },
      performanceNote: { type: ["string", "null"], maxLength: 500, description: "One short sentence on how the supplied real performance evidence shaped the plan, or null when none was supplied." },
    },
  },
} as const;

// ─── Prompt ────────────────────────────────────────────────────────────────

export const CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager. You are filling in ONE already-designed campaign for the authenticated user's own business.

The campaign STRUCTURE is already decided and is not yours to change. You receive a skeleton: an ordered list of slots, each with a fixed channel (email, instagram_post, instagram_reel or instagram_story), a fixed campaign day and a proposed time. Your job is the strategy and the content inside that structure.

Return JSON only, matching the requested schema exactly.

Hard rules:
- Return exactly one action object per skeleton slot, with the SAME slot index and the SAME channel. Never add slots, never drop slots, never change a channel, never reorder.
- Only fill "email" for email slots and only fill "instagram" for Instagram slots; the other must be null.
- Write like this specific business. Never invent prices, discounts, offers, opening hours, locations, statistics, reviews, awards, guarantees or claims that are not in the supplied context.
- ctaUrl must be a real destination that appears in the supplied context, otherwise null. Never invent a URL.
- Email and Instagram must complement each other, not repeat. An Instagram caption must never restate an email body, and two actions must never carry the same caption, body or CTA. Vary the angle per stage: announce, then explain the benefit, then proof, then a final clear next step.
- Every email needs a specific subject (never a bare teaser), a preview text that extends it, a concise plain-text body of 80-250 words, and one clear CTA.
- Every Instagram action needs a concept, a hook, a full caption and a CTA. For a Reel, "script" must be a short shot-by-shot sequence (3-6 lines) and "visualDirection" must describe what to film. For Posts and Stories "script" must be an empty array. Instagram Stories carry no hashtags-heavy essay: keep them short.
- proposedSendAt, when you set one, must stay inside the same campaign day as that slot's proposed time. Otherwise return null and the proposed time is kept.
- recentPerformance, when present, is EVIDENCE from this business's own already-published Instagram content. It is advisory: bias one or two choices toward what measurably worked, keep the sequence diverse, never repeat an old winner verbatim, and never invent metrics. When it is absent, say nothing about performance.
- Nothing you write is sent or published by this step. Never claim an email was sent, a post was published, or a visual was generated. This is a draft for the user to review.
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
      channelsAllowed: ["email", "instagram_post", "instagram_reel", "instagram_story"],
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
  /** Instagram format, present for Instagram actions. */
  format?: CampaignInstagramFormat;
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

  const bySlot = new Map<number, MaraCampaignActionContent>();
  for (const action of intelligence?.actions ?? []) {
    if (!bySlot.has(action.slot)) bySlot.set(action.slot, action);
  }

  const usedCopy: string[] = [];
  const usedCtas = new Map<string, number>();

  const merged: EnrichedCampaignAction[] = skeleton.map((base) => {
    const candidate = bySlot.get(base.slot);
    const deterministic = withSafety(enrichDeterministic(base), now);

    // A missing slot, a channel MARA changed, or a payload for the wrong
    // channel: the deterministic draft stands.
    if (!candidate || candidate.channel !== base.channel) {
      fallbackSlots.push(base.slot);
      return deterministic;
    }

    const scheduledFor = resolveProposedTime(
      base.channel === "email" ? candidate.email?.proposedSendAt : candidate.instagram?.proposedSendAt,
      base,
      now,
      input.timeZone,
    );

    if (base.channel === "email") {
      const email = candidate.email;
      if (!email || candidate.instagram) {
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

    const instagram = candidate.instagram;
    const expectedFormat = INSTAGRAM_FORMAT_FOR_CHANNEL[base.channel];
    if (!instagram || candidate.email || instagram.format !== expectedFormat) {
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
    ...(base.channel === "email" ? {} : { format: INSTAGRAM_FORMAT_FOR_CHANNEL[base.channel] }),
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
  const instagramCount = input.skeleton.length - emailCount;
  const reelCount = input.skeleton.filter((action) => action.channel === "instagram_reel").length;
  const storyCount = input.skeleton.filter((action) => action.channel === "instagram_story").length;

  const moves = [
    instagramCount ? "Instagram carries the announcement" : "",
    reelCount ? "a Reel explains the benefit" : "",
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
