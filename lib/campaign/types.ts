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
 * Multi-Social Campaigns — the authoritative CHANNELS one campaign runs on.
 *
 * A campaign selects any non-empty combination of Instagram, TikTok, YouTube
 * and Email. Every action inside it must belong to one of its selected
 * channels; the database enforces the same rule (migrations 0045 + 0046), so
 * an invalid combination fails server-side rather than being silently
 * dropped.
 *
 * Only these four values exist. Marketing messaging that Voom has retired can
 * never be selected here, never appears in this list, and can never be written
 * to `voom_campaigns.channels`: the allowlist below is the single authority
 * the routes, the planner and the build RPC all consult.
 *
 * Selecting TikTok or YouTube grants PLANNING only. Publishing there requires
 * a real provider connection that does not exist yet — the publisher boundary
 * (lib/social/publisher.ts) truthfully refuses, and nothing in the campaign
 * layer can bypass it.
 */
export const CAMPAIGN_CHANNELS = ["instagram", "tiktok", "youtube", "email"] as const;

export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CAMPAIGN_CHANNEL_LABELS: Record<CampaignChannel, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  email: "Email",
};

/**
 * Backward-compat alias: the channel selection choices are now any non-empty
 * subset of `CAMPAIGN_CHANNELS` (a multi-select), so this list only names the
 * selectable channels in product display order.
 */
export const CAMPAIGN_CHANNEL_CHOICES: ReadonlyArray<{
  id: CampaignChannel;
  channels: readonly CampaignChannel[];
  label: string;
}> = CAMPAIGN_CHANNELS.map((channel) => ({
  id: channel,
  channels: [channel] as readonly CampaignChannel[],
  label: CAMPAIGN_CHANNEL_LABELS[channel],
}));

/**
 * The legacy default selection for callers that make no explicit choice:
 * Instagram + Email, exactly as Campaigns v3 behaved. TikTok and YouTube are
 * never planned unless the user actively selects them — a channel whose
 * provider is not connected is never chosen silently.
 */
export const LEGACY_DEFAULT_CAMPAIGN_CHANNELS: readonly CampaignChannel[] = ["instagram", "email"];

/**
 * Campaigns v3 — HOW a campaign was created.
 *
 * This is a separate concept from the workspace AUTOMATION MODE
 * (Manual / Assisted / Autopilot, `lib/voom/automation`) and must never be
 * conflated with it:
 *
 *   creationMethod  who planned the campaign's actions  ('mara' | 'self')
 *   automationMode  who is allowed to execute them      ('manual' | 'assisted' | 'autopilot')
 *
 * The value is deliberately NOT called "manual": Voom's Manual automation mode
 * already means "the user controls execution", and a MARA-created campaign can
 * run in Manual mode just as a self-created campaign can run in Autopilot.
 * Neither creation method grants any execution permission on its own — the
 * existing mode/entitlement/safety gating is the only thing that does.
 */
export const CAMPAIGN_CREATION_METHODS = ["mara", "self"] as const;

export type CampaignCreationMethod = (typeof CAMPAIGN_CREATION_METHODS)[number];

export const CAMPAIGN_CREATION_METHOD_LABELS: Record<CampaignCreationMethod, string> = {
  mara: "Created with MARA",
  self: "Created by you",
};

/**
 * The campaign action channels Multi-Social Campaigns plan: every valid
 * channel+format pair from the ONE canonical vocabulary (lib/social/channels)
 * plus email. Retired messaging channels are intentionally absent: they were
 * removed from the active Voom product. Historical rows remain readable
 * through the legacy campaign surfaces, but no new action can carry such a
 * channel.
 */
export const CAMPAIGN_ACTION_CHANNELS = [
  "email",
  "instagram_post",
  "instagram_reel",
  "instagram_story",
  "tiktok_video",
  "youtube_short",
  "youtube_video",
] as const;

export type CampaignActionChannel = (typeof CAMPAIGN_ACTION_CHANNELS)[number];

export const ACTION_CHANNEL_LABELS: Record<CampaignActionChannel, string> = {
  email: "Email",
  instagram_post: "Instagram Post",
  instagram_reel: "Reel",
  instagram_story: "Instagram Story",
  tiktok_video: "TikTok Video",
  youtube_short: "YouTube Short",
  youtube_video: "YouTube Video",
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
  /**
   * Campaigns v3: the campaign's authoritative channel selection. Absent or
   * null means no explicit choice, so the planner keeps deriving the mix from
   * the goal and dates across BOTH active channels (the v2 behaviour).
   */
  channels?: readonly CampaignChannel[] | null;
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

  // TikTok / YouTube deliverable (Multi-Social Core) -------------------------
  //
  // A YouTube Video is a first-class long-form deliverable: it carries a real
  // title, a full description and a script/outline — never "a Reel renamed".
  // Planning these never triggers expensive media generation.
  /** Long-form description (YouTube Video/Short). */
  description?: string;
  /** Script / outline lines (YouTube Video, TikTok-native beat, Reels). */
  script?: string[];

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
  /** Multi-Social Core: TikTok Video count. */
  tiktokCount?: number;
  /** Multi-Social Core: YouTube Short count. */
  youtubeShortCount?: number;
  /** Multi-Social Core: full YouTube Video count. */
  youtubeVideoCount?: number;
  /** Multi-Social Core: total YouTube actions. */
  youtubeCount?: number;
  /** Campaigns v3: the channel selection this plan was built inside. */
  channels?: CampaignChannel[];
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

/**
 * Maps one action channel to the campaign channel it belongs to.
 *
 * The mapping is derived from the ONE canonical vocabulary
 * (lib/social/channels.parseActionChannel), so `tiktok_video` → tiktok,
 * `youtube_short`/`youtube_video` → youtube and any invented or retired
 * identifier returns `null` and is rejected by every caller.
 */
export function actionChannelFamily(channel: unknown): CampaignChannel | null {
  if (channel === "email") return "email";
  if (typeof channel !== "string") return null;
  if (!(CAMPAIGN_ACTION_CHANNELS as readonly string[]).includes(channel)) return null;
  const separator = channel.lastIndexOf("_");
  const family = separator > 0 ? channel.slice(0, separator) : "";
  return (CAMPAIGN_CHANNELS as readonly string[]).includes(family) ? (family as CampaignChannel) : null;
}

export type CampaignChannelsResult =
  | { ok: true; channels: CampaignChannel[] }
  | { ok: false; reason: "empty" | "unknown_channel" | "duplicate_channel" };

/**
 * Validates a campaign's authoritative channel selection against the allowlist.
 *
 * `null`/`undefined` means "the caller made no explicit choice": the result is
 * the LEGACY DEFAULT (Instagram + Email) — exactly what Campaigns v2/v3
 * callers received before TikTok/YouTube existed. A channel whose provider is
 * not connected is never planned silently; the user must actively select it.
 *
 * Anything else must be a non-empty subset of `CAMPAIGN_CHANNELS` with no
 * repeats — a retired or invented channel is refused here, in the routes, and
 * again in the database.
 *
 * The returned order is always the canonical `CAMPAIGN_CHANNELS` order, so the
 * same selection always produces the same stored array.
 */
export function normalizeCampaignChannels(value: unknown): CampaignChannelsResult {
  if (value === undefined || value === null) return { ok: true, channels: [...LEGACY_DEFAULT_CAMPAIGN_CHANNELS] };
  if (!Array.isArray(value)) return { ok: false, reason: "unknown_channel" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > CAMPAIGN_CHANNELS.length) return { ok: false, reason: "duplicate_channel" };
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return { ok: false, reason: "unknown_channel" };
    const channel = entry.trim().toLowerCase();
    if (!(CAMPAIGN_CHANNELS as readonly string[]).includes(channel)) {
      return { ok: false, reason: "unknown_channel" };
    }
    if (seen.has(channel)) return { ok: false, reason: "duplicate_channel" };
    seen.add(channel);
  }
  return { ok: true, channels: CAMPAIGN_CHANNELS.filter((channel) => seen.has(channel)) };
}

/** Creation method: 'mara' by default, 'self' only when explicitly asked. */
export function normalizeCampaignCreationMethod(value: unknown): CampaignCreationMethod {
  return value === "self" ? "self" : "mara";
}

/** True when an action channel is allowed by a campaign's channel selection. */
export function isActionChannelAllowed(
  channel: unknown,
  channels: readonly CampaignChannel[],
): boolean {
  const family = actionChannelFamily(channel);
  return family !== null && channels.includes(family);
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
  /**
   * v3: the campaign's authoritative channel selection (migration 0045).
   * NULL only on historical rows that predate v3 and were never backfilled —
   * every campaign container has one.
   */
  channels: CampaignChannel[] | null;
  /**
   * v3: how the campaign was created — 'mara' (planned by MARA) or 'self'
   * (the user wrote the actions). Independent of the automation mode.
   */
  creation_method: CampaignCreationMethod;
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
  /**
   * The canonical format. Instagram keeps post/reel/story; the Multi-Social
   * Core adds TikTok's `video` and YouTube's `short`/`video`.
   */
  format?: "post" | "reel" | "story" | "video" | "short";
  concept?: string;
  hook?: string;
  cta?: string;
  ctaUrl?: string | null;
  visualDirection?: string;
  script?: string[];
  hashtags?: string[];
  audienceNote?: string;
  sendTimeNote?: string;
  /** Multi-Social Core: the long-form description (YouTube Video/Short). */
  description?: string;
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
  /**
   * Multi-Social Core deliverable, present for TikTok and YouTube actions.
   *
   * A YouTube Video is a first-class long-form deliverable (title +
   * description + concept + script/outline + video asset relationship), not a
   * renamed short. `publishState` is the canonical social lifecycle state,
   * derived truthfully: while no real TikTok/YouTube provider integration
   * exists, an approved item reads `connection_required` — never `published`.
   */
  social?: {
    draftId: string;
    channel: "tiktok" | "youtube";
    format: "video" | "short";
    title: string;
    caption: string;
    description: string | null;
    concept: string | null;
    script: string[];
    draftStatus: "draft" | "approved" | "rejected";
    /** Canonical lifecycle state from lib/social/publish-state. */
    publishState: string;
    publishStateLabel: string;
    /** Real provider reference only; null until a provider confirms. */
    providerRef: string | null;
    needsAsset: boolean;
    media: {
      previewUrl: string | null;
      mimeType: string;
      displayName: string;
      origin: string;
    } | null;
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

/**
 * Campaigns v3 — one entry of the unified campaign timeline.
 *
 * The timeline is DERIVED, never stored: it is the same action rows the read
 * model already returns, ordered chronologically across Email and Instagram and
 * bucketed by what the derived execution state actually means. There is no
 * second copy of the state to go stale.
 */
export type CampaignTimelineBucket =
  /** What already happened: sent/published, or deliberately skipped. */
  | "done"
  /** What is in flight right now: a send or a publish is running. */
  | "active"
  /** What needs the user's approval before it can run. */
  | "needs_approval"
  /** What is approved/scheduled and has not run yet. */
  | "scheduled"
  /** What failed and needs attention. */
  | "attention";

export interface CampaignTimelineEntry {
  actionId: string;
  slot: number;
  channel: CampaignActionChannel;
  /** The campaign channel this action belongs to. */
  channelFamily: CampaignChannel;
  title: string;
  scheduledFor: string;
  executionState: import("./status").ActionExecutionState;
  executionLabel: string;
  bucket: CampaignTimelineBucket;
  canEditContent: boolean;
  /** Durable execution identity for Performance Intelligence linkage. */
  emailCampaignId: string | null;
  draftId: string | null;
}

export interface CampaignTimeline {
  /** Every action, chronological; `slot` is the deterministic tie-breaker. */
  entries: CampaignTimelineEntry[];
  done: CampaignTimelineEntry[];
  active: CampaignTimelineEntry[];
  needsApproval: CampaignTimelineEntry[];
  scheduled: CampaignTimelineEntry[];
  attention: CampaignTimelineEntry[];
  /** The next thing that will happen, or null when nothing is pending. */
  next: CampaignTimelineEntry | null;
}

/** The campaign detail's resolved business timezone. */
export interface AutomatedCampaignView {
  /** Business timezone used to render and edit every proposed time. */
  timeZone: string;
  campaign: CampaignContainerRecord;
  /** v3: the campaign's authoritative channel selection. */
  channels: CampaignChannel[];
  /** v3: 'mara' (planned by MARA) or 'self' (written by the user). */
  creationMethod: CampaignCreationMethod;
  /** MARA's campaign strategy, or the deterministic fallback block (v2). */
  strategy: CampaignStrategyRecord | null;
  actions: CampaignActionView[];
  /** v3: the unified chronological timeline across Email and Instagram. */
  timeline: CampaignTimeline;
  lifecycle: CampaignLifecycle;
  lifecycleLabel: string;
  counts: {
    total: number;
    email: number;
    instagram: number;
    /** Multi-Social Core: TikTok actions. */
    tiktok: number;
    /** Multi-Social Core: YouTube actions (Shorts + Videos). */
    youtube: number;
    approved: number;
    executed: number;
    needingApproval: number;
    failed: number;
  };
}
