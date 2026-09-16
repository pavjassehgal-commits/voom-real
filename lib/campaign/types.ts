/**
 * Voom Automated Campaigns — shared, provider-free types.
 *
 * This module deliberately imports nothing from `server-only`, the database,
 * Resend, Meta, OpenRouter or any media provider, so the planner can be
 * executed directly by the Node test suite. Campaign generation never sends,
 * publishes, enqueues paid media, or spends a credit — it only plans.
 */

/** The five goals a user can choose from in the guided campaign builder. */
export const CAMPAIGN_GOALS = [
  "promote_product",
  "drive_sales",
  "announce",
  "re_engage",
  "awareness",
] as const;

export type CampaignGoal = (typeof CAMPAIGN_GOALS)[number];

export const CAMPAIGN_GOAL_LABELS: Record<CampaignGoal, string> = {
  promote_product: "Promote a product",
  drive_sales: "Drive sales",
  announce: "Announce something",
  re_engage: "Re-engage customers",
  awareness: "Build awareness",
};

/**
 * The only campaign channels Automated Campaigns plan. SMS is intentionally
 * absent: SMS marketing was removed from the active Voom product. Historical
 * SMS rows remain readable through the legacy campaign surfaces, but no new
 * action can carry this channel.
 */
export const CAMPAIGN_ACTION_CHANNELS = [
  "email",
  "instagram_post",
  "instagram_reel",
  "instagram_story",
] as const;

export type CampaignActionChannel = (typeof CAMPAIGN_ACTION_CHANNELS)[number];

export const ACTION_CHANNEL_LABELS: Record<CampaignActionChannel, string> = {
  email: "Email",
  instagram_post: "Instagram Post",
  instagram_reel: "Reel",
  instagram_story: "Instagram Story",
};

/**
 * Durable per-action lifecycle on `voom_campaign_actions.status`. Live
 * execution states (sending/publishing, delivered/published) are DERIVED on
 * read from the email delivery tables and the Instagram publish queue — they
 * are never faked on the action row.
 */
export const CAMPAIGN_ACTION_STATUSES = [
  "proposed",
  "needs_approval",
  "approved",
  "scheduled",
  "executed",
  "failed",
  "skipped",
] as const;

export type CampaignActionStatus = (typeof CAMPAIGN_ACTION_STATUSES)[number];

/**
 * The campaign-level lifecycle. `building` is a real client/request state
 * (MARA is generating right now); every other value is DERIVED from the real
 * states of the campaign's actions — there is no manual lifecycle toggle.
 */
export const CAMPAIGN_LIFECYCLES = [
  "draft",
  "building",
  "needs_approval",
  "scheduled",
  "active",
  "completed",
  "needs_attention",
] as const;

export type CampaignLifecycle = (typeof CAMPAIGN_LIFECYCLES)[number];

export const CAMPAIGN_LIFECYCLE_LABELS: Record<CampaignLifecycle, string> = {
  draft: "Draft",
  building: "Building",
  needs_approval: "Needs approval",
  scheduled: "Scheduled",
  active: "Active",
  completed: "Completed",
  needs_attention: "Needs attention",
};

/** Campaign funnels a single action belongs to. */
export type CampaignStage = "awareness" | "consideration" | "conversion" | "retention";

export const CAMPAIGN_STAGE_LABELS: Record<CampaignStage, string> = {
  awareness: "Awareness",
  consideration: "Consideration",
  conversion: "Conversion",
  retention: "Re-engagement",
};

export interface CampaignBrandContext {
  brandName?: string | null;
  brandDescription?: string | null;
  industry?: string | null;
  targetCustomer?: string[] | null;
  brandPersonality?: string[] | null;
  mainGoal?: string | null;
}

/** One owned audience the planner may target email actions at. */
export interface PlannerAudience {
  id: string;
  name: string;
  /** Real, server-computed count of eligible email destinations, if known. */
  eligibleEmailCount?: number | null;
}

/**
 * Advisory performance evidence. The planner only ever receives evidence
 * built from real, measured Instagram performance. When the account has no
 * usable history this is `null` and the planner invents nothing.
 */
export interface PlannerPerformanceInput {
  sampleSize: number;
  confidence: "low" | "moderate";
  bestContentTypeLabel?: string | null;
  winnerLabels?: string[];
  engagementSignals?: string[];
  /** v2 (MARA Campaign Intelligence): the measured basis, e.g. "reach". */
  basis?: string | null;
  /** v2: how many days of published content the evidence covers. */
  windowDays?: number | null;
  /** v2: the strongest measured topic, when one stands out. */
  strongestTopicLabel?: string | null;
  /** v2: topics that measurably underperformed the account's own baseline. */
  underperformerLabels?: string[] | null;
}

export interface CampaignBrief {
  /** Campaign name or the user's short campaign idea. */
  name: string;
  goal: CampaignGoal;
  /** Inclusive first campaign day (date-only YYYY-MM-DD or full ISO). */
  startAt: string;
  /** Inclusive final campaign day. */
  endAt: string;
  /** Optional offer / discount / details. */
  offerDetails?: string;
  /** Free-text target audience description. */
  targetAudience?: string;
  /** Optional extra notes for MARA. */
  notes?: string;
  /** Optional owned audience id; email actions target it when present. */
  audienceId?: string | null;
}

/** One planned, not-yet-persisted campaign action. */
export interface PlannedAction {
  slot: number;
  channel: CampaignActionChannel;
  /** Whole-day offset from the campaign start date (0 = first day). */
  dayOffset: number;
  /** Proposed time, absolute ISO-8601, in the business timezone. */
  scheduledFor: string;
  stage: CampaignStage;
  title: string;
  /** Why this action exists at this point in the sequence. */
  purpose: string;

  // Email deliverable ------------------------------------------------------
  subject?: string;
  previewText?: string;
  body?: string;
  cta?: string;
  /** Owned audience the email targets (resolved server-side at send time). */
  audienceId?: string | null;

  // Instagram deliverable --------------------------------------------------
  concept?: string;
  caption?: string;
  hashtags?: string[];

  /**
   * Existing Autopilot safety evaluation (lib/mara/autopilot-safety). In
   * Autopilot, only safe actions are auto-approved; anything blocked stays in
   * Needs approval. Manual and Assisted never auto-approve regardless.
   */
  autopilotSafe: boolean;
  autopilotBlockers: string[];
}

export interface PlannedCampaignSummary {
  days: number;
  emailCount: number;
  postCount: number;
  reelCount: number;
  storyCount: number;
  instagramCount: number;
  /** Compact, factual summary built from the real generated structure. */
  narrative: string;
  /** True only when real measured performance shaped the plan. */
  performanceUsed: boolean;
  /** Advisory note when real performance was used; null otherwise. */
  performanceNote: string | null;
}

export interface PlannedCampaign {
  actions: PlannedAction[];
  summary: PlannedCampaignSummary;
}

/** Maximum campaign span the planner accepts (inclusive days). */
export const MAX_CAMPAIGN_DAYS = 60;
/** Upper bound on actions in one generated campaign. */
export const MAX_CAMPAIGN_ACTIONS = 16;
/** At most this many emails in one campaign — no inbox flooding. */
export const MAX_EMAIL_ACTIONS = 4;

export function isCampaignGoal(value: unknown): value is CampaignGoal {
  return typeof value === "string" && (CAMPAIGN_GOALS as readonly string[]).includes(value);
}

// ─── Persisted / read-model shapes ─────────────────────────────────────────

/** Persisted campaign container row (voom_campaigns). */
export interface CampaignContainerRecord {
  id: string;
  kind: "email" | "sms" | "multi";
  is_automated: boolean;
  name: string;
  objective: string;
  audience: string;
  audience_id: string | null;
  subject: string | null;
  preview_text: string | null;
  content: string;
  proposed_send_at: string | null;
  status: "draft" | "approved" | "rejected";
  goal: CampaignGoal | null;
  start_at: string | null;
  end_at: string | null;
  offer_details: string | null;
  campaign_notes: string | null;
  generated_summary: string | null;
  parent_campaign_id: string | null;
  /** v2: the stored strategy object (objective/core message/…). */
  strategy: Record<string, unknown> | null;
  /** v2: the short "MARA's approach" line. */
  strategy_summary: string | null;
  /** v2: which layer produced the campaign content. */
  generation_source: "deterministic" | "mara" | null;
  approved_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Persisted timeline action row (voom_campaign_actions). */
export interface CampaignActionRecord {
  id: string;
  campaign_id: string;
  slot: number;
  channel: CampaignActionChannel;
  stage: CampaignStage;
  title: string;
  purpose: string;
  scheduled_for: string;
  status: CampaignActionStatus;
  email_campaign_id: string | null;
  draft_id: string | null;
  safety_blockers: string[];
  /** v2: the structured MARA content stored with the action. */
  mara_content: Record<string, unknown> | null;
  /** v2: which layer produced the stored content. */
  content_source: "deterministic" | "mara" | "edited";
  created_at: string;
  updated_at: string;
}

/** Which layer produced an action's content. */
export type CampaignContentSource = "deterministic" | "mara" | "edited";

/** The structured MARA content stored on `voom_campaign_actions.mara_content`. */
export interface CampaignActionContentRecord {
  format?: "post" | "reel" | "story";
  concept?: string;
  hook?: string;
  cta?: string;
  ctaUrl?: string | null;
  visualDirection?: string;
  script?: string[];
  hashtags?: string[];
  audienceNote?: string;
  sendTimeNote?: string;
}

/** One timeline row as presented (derived execution state included). */
export interface CampaignActionView extends CampaignActionRecord {
  /** DERIVED from child campaign/queue state — never stored as fake progress. */
  executionState: import("./status").ActionExecutionState;
  executionLabel: string;
  /** Which layer wrote this action's content (v2). */
  contentSource: CampaignContentSource;
  /** Structured content stored with the action (v2). */
  content: CampaignActionContentRecord | null;
  /**
   * True while the content may still be edited or regenerated. False once a
   * real send is in flight/completed or the Instagram item is publishing or
   * published — a sent or published action can never be rewritten.
   */
  canEditContent: boolean;
  /** Email deliverable, present for email actions. */
  email?: {
    subject: string | null;
    previewText: string | null;
    body: string;
    cta: string | null;
    ctaUrl: string | null;
    audienceNote: string | null;
    sendTimeNote: string | null;
    childCampaignId: string;
    childStatus: "draft" | "approved" | "rejected";
    canSendExplicitly: boolean;
  } | null;
  /** Instagram deliverable, present for Instagram actions. */
  instagram?: {
    draftId: string;
    concept: string;
    caption: string;
    format: "post" | "reel" | "story";
    hook: string | null;
    visualDirection: string | null;
    script: string[];
    cta: string | null;
    draftStatus: "draft" | "approved" | "rejected";
    queueStatus: string | null;
    needsVisual: boolean;
    media: {
      previewUrl: string | null;
      mimeType: string;
      displayName: string;
      origin: string;
    } | null;
    /** Supported campaign-contained production choices for this format. */
    availableProductionMethods: ("create_with_mara" | "upload_asset" | "film_yourself")[];
    selectedProductionMethod: "create_with_mara" | "upload_asset" | "film_yourself" | null;
    productionStatus: string | null;
  } | null;
}

/** The campaign strategy block as stored and presented (v2). */
export interface CampaignStrategyRecord {
  objective: string;
  coreMessage: string;
  audienceAngle: string;
  narrative: string;
  ctaStrategy: string;
  sequenceRationale: string;
  /** The short "MARA's approach" line. */
  summary: string;
  /** 'mara' when MARA wrote it, 'deterministic' for the v1 fallback. */
  source: "mara" | "deterministic";
  performanceNote: string | null;
}

/** The campaign detail's resolved business timezone. */
export interface AutomatedCampaignView {
  /** Business timezone used to render and edit every proposed time. */
  timeZone: string;
  campaign: CampaignContainerRecord;
  /** MARA's campaign strategy, or the deterministic fallback block (v2). */
  strategy: CampaignStrategyRecord | null;
  actions: CampaignActionView[];
  lifecycle: CampaignLifecycle;
  lifecycleLabel: string;
  counts: {
    total: number;
    email: number;
    instagram: number;
    approved: number;
    executed: number;
    needingApproval: number;
    failed: number;
  };
}
