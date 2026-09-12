/**
 * The single content workflow state machine.
 *
 * Marketing Plan, Today, Approvals, Content Calendar, media generation and
 * publishing are all views over ONE workflow item. An item is a `mara_drafts`
 * row (the existing draft), optionally mirrored into `content_calendar_items`
 * and, once scheduled, into `instagram_publish_queue`. No screen keeps its own
 * copy of a planned post and no second state machine exists.
 *
 * This module is pure so every screen derives identical status from identical
 * facts. The derived stages, in execution order:
 *
 *   planned          the slot exists; production has not started
 *   needs_content    production is expected but no usable visual exists yet
 *   generating       MARA media generation is queued/running
 *   ready_for_review media is stored; the item can be reviewed and approved
 *   needs_approval   an approval action is open (Assisted stops here)
 *   scheduled        approved and queued for its publish time
 *   publishing       the publishing worker is executing it right now
 *   published        Meta confirmed the media id — terminal
 *   missed           the scheduled time passed without a successful publish
 *   failed           media or publishing failed, or the item was rejected
 */

export const WORKFLOW_STATUSES = [
  "planned",
  "needs_content",
  "generating",
  "ready_for_review",
  "needs_approval",
  "scheduled",
  "publishing",
  "published",
  "missed",
  "failed",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  planned: "Planned",
  needs_content: "Needs content",
  generating: "Generating",
  ready_for_review: "Ready for review",
  needs_approval: "Needs approval",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  missed: "Missed scheduled time",
  failed: "Needs attention",
};

/** How long past the scheduled time an unpublished item is "late", not missed. */
export const MISSED_GRACE_MINUTES = 20;

export type PublishStatusFact =
  | "scheduled" | "waiting_for_media" | "permission_required" | "publishing"
  | "published" | "failed" | "cancelled"
  | string;

export interface WorkflowFacts {
  /** mara_drafts.status */
  draftStatus: "draft" | "approved" | "rejected";
  /** True once Voom owns the stored bytes for the visual. */
  hasMedia: boolean;
  /** Latest mara_media_generations status for this draft, if any. */
  mediaStatus: "queued" | "processing" | "completed" | "failed" | "cancelled" | "pending_confirmation" | null;
  /** Latest instagram_publish_queue status for this draft, if any. */
  publishStatus: PublishStatusFact | null;
  /** True when an approval action is still open for this item. */
  awaitingApproval: boolean;
  /** The absolute UTC publish instant (draft proposed_publish_at / queue row). */
  publishAt?: string | null;
  /** Current instant, for the missed-schedule derivation. */
  now?: Date;
}

function isPast(instance: string | null | undefined, now: Date): boolean {
  if (!instance) return false;
  const value = Date.parse(instance);
  return Number.isFinite(value) && value < now.getTime() - MISSED_GRACE_MINUTES * 60_000;
}

/**
 * Derives the one status shown everywhere. Publishing facts win over planning
 * facts: once Meta has confirmed a media id the item is Published and can
 * never regress.
 *
 * Missed publishing is NEVER silently treated as normally upcoming: an
 * approved item whose scheduled time passed without a successful publish
 * (queue missing, queue cancelled, media missing, worker did not claim, or a
 * schedule mismatch) derives `missed` so every screen shows it truthfully.
 */
export function deriveWorkflowStatus(facts: WorkflowFacts): WorkflowStatus {
  const now = facts.now ?? new Date();
  if (facts.publishStatus === "published") return "published";
  if (facts.publishStatus === "publishing") return "publishing";
  if (facts.publishStatus === "failed" || facts.publishStatus === "permission_required") return "failed";
  if (facts.mediaStatus === "failed" && !facts.hasMedia) return "failed";
  if (facts.draftStatus === "rejected") return "failed";
  if (facts.mediaStatus === "queued" || facts.mediaStatus === "processing") return "generating";

  if (facts.draftStatus === "approved") {
    // Scheduled, but the schedule already expired without a publish: the item
    // must surface as missed rather than sit as a fake "upcoming" schedule.
    if (isPast(facts.publishAt ?? null, now) && facts.publishStatus !== "published") return "missed";
    // A withdrawn queue row (never enqueued, cancelled) is equally a dead
    // schedule: truthfully missed, never silently "upcoming".
    if (facts.publishStatus === "cancelled" && facts.publishAt && isPast(facts.publishAt, now)) return "missed";
    if (facts.publishStatus === "cancelled") return "missed";
    return "scheduled";
  }
  if (facts.awaitingApproval) return "needs_approval";
  if (facts.hasMedia) return "ready_for_review";
  if (facts.mediaStatus === "cancelled" || facts.mediaStatus === "pending_confirmation") return "needs_content";
  return "planned";
}

/** Only genuinely actionable statuses belong on the Approvals screen. */
export function requiresApproval(status: WorkflowStatus): boolean {
  return status === "needs_approval";
}

/** Statuses the user can safely retry without risking a duplicate charge/post. */
export function isRetryable(status: WorkflowStatus): boolean {
  return status === "failed" || status === "missed";
}

/**
 * Why an item missed its schedule, derived from the same facts. Null unless
 * the status is `missed`. Truthful per cause; never guesses a fake reason.
 */
export function missedReason(facts: WorkflowFacts): string | null {
  if (deriveWorkflowStatus(facts) !== "missed") return null;
  if (facts.publishStatus === "cancelled") return "Its publish slot was withdrawn — the schedule had expired or the visual was not ready in time.";
  if (!facts.hasMedia && facts.publishStatus !== "scheduled" && facts.publishStatus !== "waiting_for_media") {
    return "The visual was never stored, so Voom could not publish it.";
  }
  if (facts.publishStatus === "waiting_for_media") return "Voom was still waiting for the visual when the time passed.";
  if (facts.publishStatus === "scheduled") return "The schedule passed but publishing did not run — post it now or pick a new time.";
  if (!facts.publishStatus) return "The schedule passed without an active publish slot — post it now or pick a new time.";
  return "Its scheduled time passed without a successful publish.";
}

/** The stage that failed, for a truthful "what broke" message. */
export function failureStage(facts: WorkflowFacts): "media" | "publishing" | "rejected" | null {
  if (facts.publishStatus === "failed" || facts.publishStatus === "permission_required") return "publishing";
  if (facts.mediaStatus === "failed" && !facts.hasMedia) return "media";
  if (facts.draftStatus === "rejected") return "rejected";
  return null;
}

/** Instagram surface for a planned content type. */
export function draftKindForContentType(contentType: "post" | "reel" | "story"): "instagram_post" | "reel" | "story" {
  return contentType === "post" ? "instagram_post" : contentType;
}

export function contentTypeLabel(contentType: "post" | "reel" | "story"): string {
  return contentType === "post" ? "Instagram Post" : contentType === "reel" ? "Reel" : "Instagram Story";
}

/** Content Calendar channel value for a planned content type (0003 CHECK). */
export function calendarChannelForContentType(contentType: "post" | "reel" | "story"): "Instagram" | "Reel" | "Story" {
  return contentType === "post" ? "Instagram" : contentType === "reel" ? "Reel" : "Story";
}
