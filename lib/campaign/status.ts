/**
 * Pure lifecycle derivation for Automated Campaigns.
 *
 * The campaign's overall status is NEVER a manual toggle. It is computed from
 * the real states of its actions, which themselves are derived from:
 *   - email actions: the child email campaign's approval state and its
 *     provider-confirmed delivery rows,
 *   - Instagram actions: the content draft's state and the durable Instagram
 *     publish queue (only Meta-confirmed media reads as Published).
 *
 * No provider, no database, no "server-only" — the Node suite executes this.
 */

import {
  actionChannelFamily,
  CAMPAIGN_LIFECYCLE_LABELS,
  LEGACY_DEFAULT_CAMPAIGN_CHANNELS,
  type CampaignActionChannel,
  type CampaignActionStatus,
  type CampaignChannel,
  type CampaignLifecycle,
  type CampaignTimeline,
  type CampaignTimelineBucket,
  type CampaignTimelineEntry,
} from "./types";

/** Live, derived execution state for one timeline action. */
export type ActionExecutionState =
  | "proposed"
  | "needs_approval"
  | "approved"
  | "scheduled"
  | "executing"
  | "executed"
  | "failed"
  | "skipped"
  /**
   * Multi-Social Core: the content is ready on Voom's side but its channel's
   * provider is not connected (TikTok/YouTube today), so it truthfully cannot
   * execute. Blocked is never "published" and never silently dropped.
   */
  | "blocked";

export const ACTION_EXECUTION_LABELS: Record<ActionExecutionState, string> = {
  proposed: "Draft",
  needs_approval: "Needs approval",
  approved: "Approved",
  scheduled: "Scheduled",
  executing: "In progress",
  executed: "Done",
  failed: "Needs attention",
  skipped: "Skipped",
  blocked: "Blocked — provider not connected",
};

export interface EmailActionFacts {
  kind: "email";
  /** Persisted plan status from voom_campaign_actions. */
  planStatus: CampaignActionStatus;
  /** Child voom_campaigns.status, or null if the child is missing. */
  childStatus: "draft" | "approved" | "rejected" | null;
  /** Latest campaign_sends.internal_status for the child, if any. */
  sendStatus: "queued" | "sending" | "accepted" | "delivered" | "failed" | "skipped" | null;
  scheduledFor: string;
}

export interface InstagramActionFacts {
  kind: "instagram";
  planStatus: CampaignActionStatus;
  /** mara_drafts.status, or null when the draft is missing. */
  draftStatus: "draft" | "approved" | "rejected" | null;
  /** Whether the draft has the required visual/media asset. */
  hasVisual?: boolean;
  /** instagram_publish_queue.status for the draft, if any. */
  queueStatus:
    | "scheduled"
    | "waiting_for_media"
    | "permission_required"
    | "publishing"
    | "published"
    | "failed"
    | "cancelled"
    | null;
  scheduledFor: string;
}

/**
 * Multi-Social Core facts for a TikTok or YouTube action.
 *
 * There is deliberately NO queue status: no TikTok/YouTube provider
 * integration exists, so there is no execution machinery to derive from. An
 * approved item is truthfully `blocked` (provider not connected) — it can
 * never read as scheduled-for-execution, executing, or executed.
 */
export interface SocialActionFacts {
  kind: "social";
  channel: "tiktok" | "youtube";
  planStatus: CampaignActionStatus;
  /** mara_drafts.status, or null when the draft is missing. */
  draftStatus: "draft" | "approved" | "rejected" | null;
  /** Whether the draft has its video asset stored. */
  hasAsset?: boolean;
  scheduledFor: string;
}

export type ActionFacts = EmailActionFacts | InstagramActionFacts | SocialActionFacts;

/**
 * How long after an action's proposed time it is "late" rather than still
 * waiting. Mirrors the Instagram workflow's 20-minute missed grace.
 */
export const ACTION_MISSED_GRACE_MINUTES = 20;

export function deriveActionState(facts: ActionFacts): ActionExecutionState {
  if (facts.kind === "email") return deriveEmailState(facts);
  if (facts.kind === "social") return deriveSocialState(facts);
  return deriveInstagramState(facts);
}

/**
 * TikTok/YouTube derivation. Truthfulness rules:
 *   - a missing draft is a real failure (the plan references nothing);
 *   - a rejected draft is skipped;
 *   - an unapproved draft follows the plan status (needs approval / draft);
 *   - an APPROVED draft is `blocked`: everything on Voom's side is done, and
 *     the honest reason it cannot run is that the provider is not connected.
 *     It never becomes scheduled/executing/executed, and it is never faked.
 */
function deriveSocialState(facts: SocialActionFacts): ActionExecutionState {
  if (!facts.draftStatus) return "failed";
  if (facts.draftStatus === "rejected") return "skipped";
  if (facts.draftStatus === "approved") return "blocked";
  return facts.planStatus === "needs_approval" ? "needs_approval" : "proposed";
}

function deriveEmailState(facts: EmailActionFacts): ActionExecutionState {
  // A missing child means the plan references something that never existed —
  // the timeline must not pretend it is fine.
  if (!facts.childStatus) return "failed";
  if (facts.sendStatus === "sending" || facts.sendStatus === "queued") return "executing";
  if (facts.sendStatus === "accepted" || facts.sendStatus === "delivered") return "executed";
  if (facts.sendStatus === "failed") return "failed";
  if (facts.sendStatus === "skipped" || facts.childStatus === "rejected") return "skipped";
  if (facts.childStatus === "approved") {
    // Approved and timed in the future: scheduled to the user's explicit send.
    // Email is never auto-sent in any mode, so "Approved · ready to send" is
    // surfaced as scheduled once its time is within its day.
    return "approved";
  }
  return facts.planStatus === "needs_approval" ? "needs_approval" : "proposed";
}

function deriveInstagramState(facts: InstagramActionFacts): ActionExecutionState {
  if (!facts.draftStatus) return "failed";
  // An approved draft without its required visual is not publish-ready and
  // must not appear as Approved in Campaigns. A real queue row remains the
  // truthful source for in-flight/waiting-media states.
  if (facts.hasVisual === false && facts.queueStatus === null && facts.draftStatus === "approved") return "needs_approval";
  switch (facts.queueStatus) {
    case "published": return "executed";
    case "publishing": return "executing";
    case "failed": return "failed";
    case "cancelled": return "skipped";
    case "scheduled":
    case "waiting_for_media":
    case "permission_required":
      return "scheduled";
    default:
  }
  if (facts.draftStatus === "rejected") return "skipped";
  if (facts.draftStatus === "approved") return "approved";
  return facts.planStatus === "needs_approval" ? "needs_approval" : "proposed";
}

const TERMINAL: ReadonlySet<ActionExecutionState> = new Set(["executed", "skipped"]);
const PENDING_APPROVAL: ReadonlySet<ActionExecutionState> = new Set(["proposed", "needs_approval"]);

export interface CampaignLifecycleFacts {
  actions: ActionFacts[];
  startAt: string | null;
  endAt: string | null;
  /** True only while the build request is in flight (client-side reality). */
  building?: boolean;
  now?: Date;
}

export function deriveCampaignLifecycle(facts: CampaignLifecycleFacts): CampaignLifecycle {
  const now = facts.now ?? new Date();

  // "Building" is the one transient value: it reflects a real in-flight build
  // request rather than a persisted toggle.
  if (facts.building) return "building";
  if (facts.actions.length === 0) return "draft";

  const states = facts.actions.map((action) => deriveActionState(action));

  if (states.includes("failed")) return "needs_attention";

  // An overdue action that has not run is attention-worthy.
  if (states.some((state, i) => isOverdue(states[i], facts.actions[i].scheduledFor, now))) {
    return "needs_attention";
  }

  if (states.every((state) => TERMINAL.has(state))) return "completed";

  const anyExecuted = states.includes("executed") || states.includes("executing");
  const beforeStart = facts.startAt ? now.getTime() < Date.parse(facts.startAt) - ACTION_MISSED_GRACE_MINUTES * 60_000 : true;
  // `endAt` is persisted as the local campaign day's end, not the start of a
  // grace day. Waiting until +24h made a finished campaign report the wrong
  // lifecycle for an entire extra day.
  const afterEnd = facts.endAt ? now.getTime() > Date.parse(facts.endAt) : false;

  if (anyExecuted) return afterEnd && states.every((s) => TERMINAL.has(s) || s === "failed") ? "completed" : "active";

  if (states.some((state) => PENDING_APPROVAL.has(state))) return "needs_approval";

  // Everything is approved/scheduled (or honestly blocked on an unconnected
  // provider) and nothing has run yet.
  if (states.every((state) => state === "approved" || state === "scheduled" || state === "blocked")) {
    return beforeStart ? "scheduled" : "active";
  }

  return "needs_approval";
}

function isOverdue(state: ActionExecutionState, scheduledFor: string, now: Date): boolean {
  if (state !== "proposed" && state !== "needs_approval" && state !== "approved") return false;
  const due = Date.parse(scheduledFor);
  if (!Number.isFinite(due)) return false;
  return due + ACTION_MISSED_GRACE_MINUTES * 60_000 < now.getTime();
}

export function lifecycleLabel(status: CampaignLifecycle): string {
  return CAMPAIGN_LIFECYCLE_LABELS[status];
}

// ─── Campaigns v3: the unified timeline projection ─────────────────────────

/** The minimal action shape the timeline projection needs. */
export interface TimelineActionInput {
  id: string;
  slot: number;
  channel: CampaignActionChannel;
  title: string;
  scheduled_for: string;
  executionState: ActionExecutionState;
  canEditContent: boolean;
  email_campaign_id: string | null;
  draft_id: string | null;
}

/**
 * Which timeline bucket a derived execution state belongs to.
 *
 * `proposed` sits with `needs_approval`: in Manual mode a proposal is exactly
 * that — an item waiting on the user. Nothing here is stored, so the buckets
 * can never disagree with the real send/publish state they are derived from.
 */
export const TIMELINE_BUCKET_FOR_STATE: Record<ActionExecutionState, CampaignTimelineBucket> = {
  executed: "done",
  skipped: "done",
  executing: "active",
  proposed: "needs_approval",
  needs_approval: "needs_approval",
  approved: "scheduled",
  scheduled: "scheduled",
  failed: "attention",
  // An approved item on an unconnected provider is surfaced in the attention
  // group: the user should see plainly that it cannot run yet.
  blocked: "attention",
};

const TIMELINE_ORDER: readonly CampaignTimelineBucket[] = [
  "done",
  "active",
  "needs_approval",
  "scheduled",
  "attention",
];

/**
 * Projects the campaign's actions into ONE chronological timeline across Email
 * and Instagram: what happened → what is running → what needs approval → what
 * comes next.
 *
 * Pure and deterministic. It duplicates no state: every bucket is a view over
 * the already-derived execution states, so a client can render the whole
 * campaign from one payload instead of reconstructing the email delivery and
 * Instagram publish systems itself.
 */
export function buildCampaignTimeline(actions: TimelineActionInput[]): CampaignTimeline {
  const entries: CampaignTimelineEntry[] = [...actions]
    .sort((a, b) => Date.parse(a.scheduled_for) - Date.parse(b.scheduled_for) || a.slot - b.slot)
    .map((action) => {
      const bucket = TIMELINE_BUCKET_FOR_STATE[action.executionState] ?? "needs_approval";
      return {
        actionId: action.id,
        slot: action.slot,
        channel: action.channel,
        channelFamily: (actionChannelFamily(action.channel) ?? "instagram") as CampaignChannel,
        title: action.title,
        scheduledFor: action.scheduled_for,
        executionState: action.executionState,
        executionLabel: ACTION_EXECUTION_LABELS[action.executionState],
        bucket,
        canEditContent: action.canEditContent,
        emailCampaignId: action.email_campaign_id,
        draftId: action.draft_id,
      };
    });

  const inBucket = (bucket: CampaignTimelineBucket) => entries.filter((entry) => entry.bucket === bucket);
  const pending = entries.filter((entry) => entry.bucket === "active" || entry.bucket === "scheduled" || entry.bucket === "needs_approval");

  return {
    entries,
    done: inBucket("done"),
    active: inBucket("active"),
    needsApproval: inBucket("needs_approval"),
    scheduled: inBucket("scheduled"),
    attention: inBucket("attention"),
    next: pending.length ? pending[0] : null,
  };
}

/**
 * The campaign's authoritative channels, tolerating historical NULL rows.
 *
 * A row with no stored selection falls back to the LEGACY Instagram + Email
 * default — never to the full four-channel list — so a pre-Multi-Social
 * campaign is never retroactively claimed to include TikTok or YouTube.
 */
export function campaignChannelsOf(stored: readonly string[] | null | undefined): CampaignChannel[] {
  const selected = (stored ?? []).filter((channel): channel is CampaignChannel =>
    (LEGACY_DEFAULT_CAMPAIGN_CHANNELS.concat(["tiktok", "youtube"]) as readonly string[]).includes(channel),
  );
  return selected.length ? selected : [...LEGACY_DEFAULT_CAMPAIGN_CHANNELS];
}

/** Presentation order for the timeline groups: past → present → future. */
export const TIMELINE_GROUP_ORDER = TIMELINE_ORDER;

export function lifecycleTone(status: CampaignLifecycle): string {
  switch (status) {
    case "completed": return "t-green";
    case "active": return "t-blue";
    case "scheduled": return "t-blue";
    case "needs_attention": return "t-red";
    case "needs_approval": return "t-amber";
    case "building": return "t-brand";
    default: return "t-grey";
  }
}

export function actionStateTone(state: ActionExecutionState): string {
  switch (state) {
    case "executed": return "t-green";
    case "executing":
    case "scheduled": return "t-blue";
    case "approved": return "t-blue";
    case "failed": return "t-red";
    case "needs_approval": return "t-amber";
    case "blocked": return "t-amber";
    case "skipped": return "t-grey";
    default: return "t-grey";
  }
}
