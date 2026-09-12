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
 * facts.
 */

export const WORKFLOW_STATUSES = [
  "planned",
  "generating",
  "needs_approval",
  "scheduled",
  "publishing",
  "published",
  "failed",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  planned: "Planned",
  generating: "Generating",
  needs_approval: "Needs approval",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Needs attention",
};

export interface WorkflowFacts {
  /** mara_drafts.status */
  draftStatus: "draft" | "approved" | "rejected";
  /** True once Voom owns the stored bytes for the visual. */
  hasMedia: boolean;
  /** Latest mara_media_generations status for this draft, if any. */
  mediaStatus: "queued" | "processing" | "completed" | "failed" | "cancelled" | "pending_confirmation" | null;
  /** Latest instagram_publish_queue status for this draft, if any. */
  publishStatus: string | null;
  /** True when an approval action is still open for this item. */
  awaitingApproval: boolean;
}

/**
 * Derives the one status shown everywhere. Publishing facts win over planning
 * facts: once Meta has confirmed a media id the item is Published and can
 * never regress.
 */
export function deriveWorkflowStatus(facts: WorkflowFacts): WorkflowStatus {
  if (facts.publishStatus === "published") return "published";
  if (facts.publishStatus === "publishing") return "publishing";
  if (facts.publishStatus === "failed" || facts.publishStatus === "permission_required") return "failed";
  if (facts.mediaStatus === "failed" && !facts.hasMedia) return "failed";
  if (facts.mediaStatus === "queued" || facts.mediaStatus === "processing") return "generating";
  if (facts.draftStatus === "rejected") return "failed";
  if (facts.draftStatus === "approved") return "scheduled";
  if (facts.awaitingApproval) return "needs_approval";
  return "planned";
}

/** Only genuinely actionable statuses belong on the Approvals screen. */
export function requiresApproval(status: WorkflowStatus): boolean {
  return status === "needs_approval";
}

/** Statuses the user can safely retry without risking a duplicate charge/post. */
export function isRetryable(status: WorkflowStatus): boolean {
  return status === "failed";
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
