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
 *   planned           the slot exists; production has not started
 *   needs_content     production is expected but no usable visual exists yet
 *   generating        MARA media generation is queued/running
 *   waiting_for_media approved and scheduled, but the queue is held truthfully
 *                     in 'waiting_for_media' because no visual exists yet —
 *                     never derived as plain "Scheduled"
 *   media_delayed     an in-flight generation has been queued/generating/
 *                     processing beyond the stale threshold but is still
 *                     inside the video job's hard timeout — explicit
 *                     Retry / Upload replacement / Cancel schedule actions
 *   media_timed_out   an asynchronous video generation is beyond its hard
 *                     timeout (still active, or already stopped with
 *                     provider_timeout) — it can never complete on its own, so
 *                     the explicit actions are Retry as new generation /
 *                     Upload replacement / Cancel schedule
 *   ready_for_review  media is stored; the item can be reviewed and approved
 *   needs_approval    an approval action is open (Assisted stops here)
 *   scheduled         approved and queued for its publish time
 *   publishing        the publishing worker is executing it right now
 *   published         Meta confirmed the media id — terminal
 *   missed            the scheduled time passed without a successful publish
 *   failed            media or publishing failed, or the item was rejected
 */

// The durable video job's own lifetime rules (pure module — no I/O, no
// secrets), so the workflow derivation and the job state machine can never
// disagree about what "timed out" means.
import {
  VIDEO_JOB_TIMEOUT_MINUTES,
  isBeyondVideoJobHardTimeout,
  isTimedOutVideoGeneration,
} from "@/lib/mara/video-job";

export const WORKFLOW_STATUSES = [
  "planned",
  "needs_content",
  "generating",
  "waiting_for_media",
  "media_delayed",
  "media_timed_out",
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
  waiting_for_media: "Waiting for media",
  media_delayed: "Media generation delayed",
  media_timed_out: "Generation timed out",
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
  mediaStatus: "queued" | "generating" | "processing" | "completed" | "failed" | "cancelled" | "pending_confirmation" | null;
  /** updated_at of that latest generation, for stale-generation derivation. */
  mediaUpdatedAt?: string | null;
  /** created_at of that latest generation — the video job's lifetime anchor. */
  mediaCreatedAt?: string | null;
  /** error_code of that latest generation, e.g. 'provider_timeout'. */
  mediaErrorCode?: string | null;
  /** media_type of that latest generation ('image' | 'video'). */
  mediaType?: string | null;
  /** Latest instagram_publish_queue status for this draft, if any. */
  publishStatus: PublishStatusFact | null;
  /** True when an approval action is still open for this item. */
  awaitingApproval: boolean;
  /** The absolute UTC publish instant (draft proposed_publish_at / queue row). */
  publishAt?: string | null;
  /** Current instant, for the missed-schedule derivation. */
  now?: Date;
}

/**
 * How long a media generation may sit in an active state (queued / generating
 * / processing) with no progress before the item is derived as
 * `media_delayed`. Deliberately under the video job's 30-minute hard timeout,
 * so the user can act (retry / upload / cancel) while the job would still be
 * self-timing-out — and far above any healthy image or video generation.
 */
export const MEDIA_GENERATION_STALE_MINUTES = 15;

/** Media-generation states in which a paid attempt may still be running. */
export const ACTIVE_MEDIA_STATUSES = ["queued", "generating", "processing"] as const;

export function isActiveMediaStatus(status: string | null | undefined): boolean {
  return status === "queued" || status === "generating" || status === "processing";
}

/**
 * True when the latest generation is in an active state but has made no
 * progress beyond the stale threshold. A generation that is NOT active
 * (completed / failed / cancelled / pending_confirmation) is never stale —
 * those are finished attempts, not stuck ones.
 */
export function isStaleMediaGeneration(
  status: string | null | undefined,
  updatedAt: string | null | undefined,
  now: Date,
  staleMinutes: number = MEDIA_GENERATION_STALE_MINUTES,
): boolean {
  if (!isActiveMediaStatus(status)) return false;
  if (!updatedAt) return false;
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at > staleMinutes * 60_000;
}

/**
 * The hard lifetime limit of an ASYNCHRONOUS video generation. This is the
 * video job state machine's own limit (lib/mara/video-job.ts) re-exported so
 * the workflow view can never invent a second, different number: past it, the
 * job cannot complete and the item must stop claiming "Generating".
 */
export const MEDIA_GENERATION_HARD_TIMEOUT_MINUTES = VIDEO_JOB_TIMEOUT_MINUTES;

/** What the hard-timeout derivation needs from one generation row. */
export interface MediaGenerationTimingFacts {
  status: string | null | undefined;
  errorCode?: string | null | undefined;
  mediaType?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
}

function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * True when an asynchronous video generation is beyond Voom's hard timeout:
 * either it was already stopped with `provider_timeout` (the terminal state
 * the retry path persists) or it is STILL active although its lifetime
 * exceeded the limit — in which case nothing can ever complete it and every
 * screen must say "Generation timed out" instead of "Generating".
 *
 * Images are synchronous: a dead image attempt stays `media_delayed` and its
 * explicit retry replaces it, so the hard-timeout rule never applies to them.
 */
export function isMediaGenerationTimedOut(media: MediaGenerationTimingFacts, now: Date): boolean {
  if (media.mediaType === "image") return false;
  if (isTimedOutVideoGeneration(media.status ?? null, media.errorCode ?? null)) return true;
  const createdAtMs = parseInstant(media.createdAt ?? media.updatedAt);
  if (createdAtMs === null) return false;
  return isBeyondVideoJobHardTimeout(media.status ?? null, { nowMs: now.getTime(), createdAtMs });
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
 *
 * The PRODUCTION INCIDENT THIS BRANCH FIXES: an approved item scheduled while
 * its visual was still generating held its queue row truthfully in
 * 'waiting_for_media', but this function fell through to `scheduled` — every
 * screen (Marketing Plan / Today / Calendar) showed "Voom will publish it at
 * the scheduled time" for an item with NO visual that no worker could ever
 * publish. The queue state now wins: approved + waiting_for_media + no stored
 * visual derives `waiting_for_media` (or `media_delayed` / `media_timed_out` /
 * `missed` once the generation is stale, beyond its hard timeout, or the time
 * has passed), never plain "Scheduled".
 *
 * THE FOLLOW-UP INCIDENT: an asynchronous video job that outlived its hard
 * timeout was still derived as `media_delayed` (or, while its provider kept
 * the row's updated_at fresh, as plain `generating`) forever — the UI promised
 * a generation that could never complete. Beyond the hard timeout the item now
 * derives `media_timed_out` whether or not the terminal state is persisted
 * yet, so no screen ever claims work is still in flight when it is not.
 */
export function deriveWorkflowStatus(facts: WorkflowFacts): WorkflowStatus {
  const now = facts.now ?? new Date();
  // Beyond the hard timeout the generation can never complete on its own. A
  // stored visual always wins: the timed-out job simply did not replace it.
  const mediaTimedOut = !facts.hasMedia && isMediaGenerationTimedOut({
    status: facts.mediaStatus,
    errorCode: facts.mediaErrorCode,
    mediaType: facts.mediaType,
    createdAt: facts.mediaCreatedAt,
    updatedAt: facts.mediaUpdatedAt,
  }, now);

  if (facts.publishStatus === "published") return "published";
  if (facts.publishStatus === "publishing") return "publishing";
  if (facts.publishStatus === "failed" || facts.publishStatus === "permission_required") return "failed";
  // A stopped video generation keeps the precedence a media failure always
  // had — it is only named truthfully when the reason was the hard timeout.
  if (facts.mediaStatus === "failed" && !facts.hasMedia) return mediaTimedOut ? "media_timed_out" : "failed";
  if (facts.draftStatus === "rejected") return "failed";

  // Approved + the queue held in 'waiting_for_media' + no stored visual: the
  // schedule is real but the item CANNOT publish yet. Truthful order:
  //  1. the scheduled time already passed without media -> missed (the user
  //     decides: post now / reschedule / cancel),
  //  2. the generation is beyond its hard timeout -> media_timed_out (only an
  //     explicit "Retry as new generation", an upload or a cancel can move it),
  //  3. the generation is active but stale -> media_delayed (explicit
  //     retry / upload replacement / cancel schedule),
  //  4. otherwise -> waiting_for_media, self-healing the moment the visual is
  //     stored (the late-media sync flips the row to 'scheduled').
  if (facts.draftStatus === "approved" && facts.publishStatus === "waiting_for_media" && !facts.hasMedia) {
    if (isPast(facts.publishAt ?? null, now)) return "missed";
    if (mediaTimedOut) return "media_timed_out";
    if (isStaleMediaGeneration(facts.mediaStatus, facts.mediaUpdatedAt, now)) return "media_delayed";
    return "waiting_for_media";
  }

  // A generation beyond its hard timeout, or one that has been
  // queued/generating/processing beyond the stale threshold, cannot make
  // progress on its own, in ANY stage (not only the approved queue): it
  // derives media_timed_out / media_delayed instead of sitting as
  // "Generating" forever with no way to act on it.
  if (mediaTimedOut) return "media_timed_out";
  if (!facts.hasMedia && isStaleMediaGeneration(facts.mediaStatus, facts.mediaUpdatedAt, now)) return "media_delayed";

  if (facts.mediaStatus === "queued" || facts.mediaStatus === "generating" || facts.mediaStatus === "processing") return "generating";

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
  return status === "failed" || status === "missed" || status === "media_delayed" || status === "media_timed_out";
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

/**
 * The stage that failed, for a truthful "what broke" message.
 *
 * PRECEDENCE: a missing visual outranks a publish failure. When media
 * generation failed and Voom owns no bytes, the publish attempt could only
 * ever fail — it is the SYMPTOM, not the cause. Reporting "publishing failed"
 * there sends the user to "Post now", which cannot work without media and
 * simply fails again. Naming the media failure points at the one action that
 * actually fixes the item: retry the generation or upload a replacement.
 */
export function failureStage(facts: WorkflowFacts): "media" | "publishing" | "rejected" | null {
  if (facts.mediaStatus === "failed" && !facts.hasMedia) return "media";
  if (facts.publishStatus === "failed" || facts.publishStatus === "permission_required") return "publishing";
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
