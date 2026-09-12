/**
 * Instagram auto-publishing core — pure, dependency-free, unit testable.
 *
 * Nothing in this module performs I/O. It owns the publishing state machine,
 * the "is this item due?" decision, capability checks and the mapping from a
 * provider failure onto a truthful, safe, actionable state.
 *
 * Truthfulness rule enforced here and in migration 0022: `published` is only
 * ever reachable with a real Instagram media id returned by Meta's
 * media_publish call. Container creation (provider acceptance) is NOT
 * published.
 *
 * Timing rule: every retry timestamp this module produces is aligned to the
 * worker's own cron cadence, so the next cron run can actually claim it. A
 * retry derived from the attempt clock instead (`now + 5 minutes`) lands after
 * the tick that was supposed to pick it up and silently costs a whole cadence.
 */

/** Durable publishing states persisted on public.instagram_publish_queue. */
export const PUBLISH_STATES = [
  "scheduled",
  "waiting_for_media",
  "permission_required",
  "publishing",
  "published",
  "failed",
  "cancelled",
] as const;
export type PublishState = (typeof PUBLISH_STATES)[number];

/** Terminal states the worker must never touch again. */
export const TERMINAL_PUBLISH_STATES: PublishState[] = ["published", "cancelled"];

export const PUBLISH_STATE_LABELS: Record<PublishState, string> = {
  scheduled: "Scheduled",
  waiting_for_media: "Waiting for media",
  permission_required: "Needs attention",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The one Meta permission Instagram content publishing requires. */
export const INSTAGRAM_PUBLISH_PERMISSION = "instagram_business_content_publish";

/**
 * Media kinds Voom can auto-publish. `story` maps to Meta's
 * media_type=STORIES container (image or video Story) — the only Story form
 * Meta's current publishing API supports.
 */
export type PublishMediaKind = "image" | "reel" | "story";

/** Human labels the publishing queue shows per media kind. */
export const PUBLISH_MEDIA_KIND_LABELS: Record<PublishMediaKind, string> = {
  image: "Instagram Post",
  reel: "Reel",
  story: "Story",
};

export const MAX_PUBLISH_ATTEMPTS = 5;
/** How long a claimed row may sit in `publishing` before it may be reclaimed. */
export const STALE_CLAIM_MINUTES = 15;
/** Signed media URL lifetime. Long enough for Meta to ingest and transcode. */
export const PUBLISH_SIGNED_URL_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Worker cadence and the serverless execution ceiling
//
// These constants are the whole timing contract of the publish worker.
// Everything retry- and polling-related is derived from them, in this module,
// so no call site does its own date math.
// ---------------------------------------------------------------------------

/**
 * The publish worker's cron cadence: the Supabase cron job
 * `voom-instagram-publish-5m` fires `* /5 * * * *`.
 *
 * Modelled as an absolute millisecond period on purpose. A five-minute cadence
 * is defined against UTC/epoch boundaries, not against any business timezone,
 * so the same instants are boundaries in Asia/Dubai (+04:00), UTC or anywhere
 * else — Dubai's offset is a whole number of minutes and therefore never
 * shifts a five-minute boundary. Nothing here reads a timezone.
 */
export const PUBLISH_WORKER_PERIOD_MS = 5 * 60_000;

/**
 * Serverless execution ceiling for ONE worker invocation. This MUST equal
 * `maxDuration` in app/api/cron/instagram-publish/route.ts (300 seconds, which
 * is also the hard Vercel Hobby / Fluid Compute maximum — it cannot be raised
 * on that plan). A test asserts the two values stay in sync.
 */
export const PUBLISH_WORKER_MAX_DURATION_MS = 300_000;

/**
 * Reserved headroom below `maxDuration` that polling may never consume.
 *
 * After the last poll the invocation still has to run `media_publish` (up to
 * PUBLISH_POLL_CALL_ALLOWANCE_MS), the complete/fail RPC, the Content Calendar
 * status update and the JSON response. Being killed in the middle of
 * `media_publish` is the single worst outcome here — it leaves the row stuck in
 * `publishing` until the 15-minute stale-claim window — so the buffer is
 * deliberately generous.
 */
export const PUBLISH_WORKER_SAFETY_BUFFER_MS = 60_000;

/**
 * Wall-clock readiness-polling budget SHARED by every item claimed in one
 * invocation, not a per-item allowance. This is what makes the per-attempt
 * budgets below safe to raise: a batch of ten videos due at once cannot add up
 * past the function's own runtime limit.
 */
export const PUBLISH_POLLING_BUDGET_MS =
  PUBLISH_WORKER_MAX_DURATION_MS - PUBLISH_WORKER_SAFETY_BUFFER_MS;

/**
 * Upper bound on a single Instagram call. `InstagramClient` aborts every
 * request after 15s, so polling refuses to start a call that cannot finish
 * inside the remaining budget.
 */
export const PUBLISH_POLL_CALL_ALLOWANCE_MS = 15_000;

/**
 * Subtracted from a cron boundary when parking a retry.
 *
 * The claim predicate is `scheduled_at <= p_now`, and `p_now` is read from a
 * DIFFERENT invocation's clock, so a retry parked exactly on the boundary can
 * lose the tick to a few hundred milliseconds of skew. One second removes that
 * risk. It is only ever subtracted, never added, and it cannot produce a retry
 * loop: claims happen only at cron ticks and attempts stay capped at
 * MAX_PUBLISH_ATTEMPTS.
 */
export const PUBLISH_RETRY_SAFETY_MARGIN_MS = 1_000;

/**
 * Readiness polling. Meta transcodes video containers asynchronously, so Reels
 * and video Stories need a much longer window than feed images.
 *
 * Budget audit (why these numbers are safe to raise): the cron route runs at
 * `maxDuration = 300`, the hard Hobby/Fluid-Compute ceiling; a single Instagram
 * call aborts at 15s; and readiness polling across a whole invocation is
 * additionally capped by PUBLISH_POLLING_BUDGET_MS. So the worst case is
 * `min(per-attempt budget, shared invocation budget)`, never the sum of the
 * claimed batch. See PUBLISH_POLLING_BUDGET_MS.
 */
export const REEL_POLL_ATTEMPTS = 28;
export const REEL_POLL_INTERVAL_MS = 6_000;
export const IMAGE_POLL_ATTEMPTS = 10;
export const IMAGE_POLL_INTERVAL_MS = 3_000;

/** The readiness polling plan for one attempt, chosen by the asset's nature. */
export interface PollingPlan {
  attempts: number;
  intervalMs: number;
  /** True when Meta transcodes the container asynchronously. */
  video: boolean;
}

/** One polling plan per media shape, so the flow never picks numbers itself. */
export function pollingPlanFor(video: boolean): PollingPlan {
  return video
    ? { attempts: REEL_POLL_ATTEMPTS, intervalMs: REEL_POLL_INTERVAL_MS, video: true }
    : { attempts: IMAGE_POLL_ATTEMPTS, intervalMs: IMAGE_POLL_INTERVAL_MS, video: false };
}

/**
 * Upper bound on the time one attempt's readiness polling spends SLEEPING.
 * The final poll is never followed by a sleep — it would only delay the retry.
 */
export function pollingSleepBudgetMs(plan: PollingPlan): number {
  return Math.max(plan.attempts - 1, 0) * plan.intervalMs;
}

/**
 * Which media kind a stored mime type publishes as.
 *
 * Stories: Meta's current API publishes an image Story (image_url) or a video
 * Story (video_url) through a media_type=STORIES container, so a Story draft's
 * stored asset routes to `story` whether it is an image or an MP4. WebP is
 * still not ingestible by Instagram.
 */
export function publishMediaKindForMime(mime: string, draftKind?: string): PublishMediaKind | null {
  if (draftKind === "story") {
    if (mime === "image/jpeg" || mime === "image/png") return "story";
    if (mime === "video/mp4" || mime === "video/quicktime") return "story";
    return null;
  }
  if (mime === "video/mp4" || mime === "video/quicktime") return "reel";
  if (mime === "image/jpeg" || mime === "image/png") return draftKind === "reel" ? null : "image";
  // Instagram will not ingest webp. Treated as missing media, not a hard fail.
  return null;
}

/**
 * True when Meta transcodes the asset asynchronously (video containers must be
 * polled longer before they report FINISHED). Video Stories transcode like
 * Reels; image Stories settle like feed images.
 */
export function isVideoPublishMime(mime: string): boolean {
  return mime === "video/mp4" || mime === "video/quicktime";
}

/** Meta rejects webp and quicktime source files for publishing. */
export function isPublishableMime(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/png" || mime === "video/mp4";
}

export interface DueCandidate {
  status: string;
  scheduledAt: string | null;
  /** mara_drafts.status — must be 'approved'. */
  draftStatus: string;
  attempts: number;
  instagramMediaId: string | null;
  claimedAt?: string | null;
}

/**
 * The selection predicate the worker (and migration 0022's claim function)
 * agree on. Only approved, scheduled, due, never-published items qualify.
 */
export function isDueForPublishing(candidate: DueCandidate, now: number = Date.now()): boolean {
  if (candidate.instagramMediaId) return false;
  if (candidate.draftStatus !== "approved") return false;
  if (candidate.attempts >= MAX_PUBLISH_ATTEMPTS) return false;
  if (!candidate.scheduledAt) return false;
  const at = Date.parse(candidate.scheduledAt);
  if (Number.isNaN(at) || at > now) return false;
  if (candidate.status === "scheduled") return true;
  // 'waiting_for_media' is a truthful, user-visible status — not a dead end.
  // It carries a future scheduled_at as its retry time, so it becomes
  // claimable again the moment that time is due. This mirrors the claim
  // predicate in claim_due_instagram_publish_jobs (migration 0022).
  if (candidate.status === "waiting_for_media") return true;
  if (candidate.status === "publishing") {
    // Only a demonstrably stale claim may be retried, and only because no
    // Instagram media id was ever recorded for it.
    const claimed = candidate.claimedAt ? Date.parse(candidate.claimedAt) : NaN;
    return !Number.isNaN(claimed) && now - claimed > STALE_CLAIM_MINUTES * 60_000;
  }
  return false;
}

/** True when the connection may publish. */
export function hasPublishPermission(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(INSTAGRAM_PUBLISH_PERMISSION);
}

export interface PublishFailure {
  status: Extract<PublishState, "failed" | "scheduled" | "permission_required" | "waiting_for_media">;
  code: string;
  /** Safe, user-facing. Never contains tokens, URLs or provider internals. */
  message: string;
  retryable: boolean;
}

export const PUBLISH_FAILURES = {
  not_connected: {
    status: "failed",
    code: "instagram_not_connected",
    message: "Instagram is not connected. Reconnect the account to publish.",
    retryable: false,
  },
  permission_required: {
    status: "permission_required",
    code: "publish_permission_required",
    message: `Instagram publishing permission required (${INSTAGRAM_PUBLISH_PERMISSION}).`,
    retryable: false,
  },
  token_expired: {
    status: "failed",
    code: "instagram_token_expired",
    message: "The Instagram connection expired. Reconnect the account to publish.",
    retryable: false,
  },
  media_missing: {
    status: "waiting_for_media",
    code: "media_missing",
    message: "This content has no stored visual yet.",
    retryable: true,
  },
  media_unsupported: {
    status: "failed",
    code: "media_unsupported",
    message: "Instagram cannot publish this file type. Use JPEG or PNG images, or an MP4 video.",
    retryable: false,
  },
  media_url_failed: {
    status: "scheduled",
    code: "media_url_failed",
    message: "Voom could not prepare the media for Instagram. It will retry.",
    retryable: true,
  },
  container_failed: {
    status: "scheduled",
    code: "container_failed",
    message: "Instagram did not accept the media container. It will retry.",
    retryable: true,
  },
  container_error: {
    status: "failed",
    code: "container_error",
    message: "Instagram rejected this media while processing it.",
    retryable: false,
  },
  container_timeout: {
    status: "scheduled",
    code: "container_timeout",
    message: "Instagram is still processing this media. It will retry.",
    retryable: true,
  },
  publish_failed: {
    status: "scheduled",
    code: "publish_failed",
    message: "Instagram did not confirm publication. It will retry safely.",
    retryable: true,
  },
  rate_limited: {
    status: "scheduled",
    code: "rate_limited",
    message: "Instagram rate limited this account. It will retry.",
    retryable: true,
  },
  unknown: {
    status: "failed",
    code: "publish_unknown_error",
    message: "Instagram publishing did not complete. Please review this item.",
    retryable: false,
  },
} as const satisfies Record<string, PublishFailure>;

export type PublishFailureKey = keyof typeof PUBLISH_FAILURES;

/** After MAX_PUBLISH_ATTEMPTS even a retryable failure becomes terminal. */
export function resolveFailure(key: PublishFailureKey, attempts: number): PublishFailure {
  const failure = PUBLISH_FAILURES[key];
  if (failure.retryable && attempts >= MAX_PUBLISH_ATTEMPTS) {
    return { ...failure, status: "failed", retryable: false };
  }
  return { ...failure };
}

// ---------------------------------------------------------------------------
// Retry scheduling, aligned to the worker's own cron
// ---------------------------------------------------------------------------

function positivePeriod(periodMs: number): number {
  return Number.isFinite(periodMs) && periodMs > 0 ? Math.floor(periodMs) : PUBLISH_WORKER_PERIOD_MS;
}

/**
 * The cron boundary at or before `at`, in absolute (UTC/epoch) milliseconds.
 *
 * Pure arithmetic on the epoch: a `* /5 * * * *` cadence has fired at every
 * epoch multiple of 300 000 ms since 1970-01-01T00:00:00Z, so this is correct
 * in every timezone without ever consulting one.
 */
export function cronBoundaryAt(at: number, periodMs: number = PUBLISH_WORKER_PERIOD_MS): number {
  const period = positivePeriod(periodMs);
  return Math.floor(at / period) * period;
}

/** The strictly-next cron boundary after `at`. An exact boundary yields the one after it. */
export function nextCronBoundaryAfter(at: number, periodMs: number = PUBLISH_WORKER_PERIOD_MS): number {
  return cronBoundaryAt(at, periodMs) + positivePeriod(periodMs);
}

/** The margin actually applied for a given cadence; it can never eat the whole period. */
export function retrySafetyMarginMs(periodMs: number = PUBLISH_WORKER_PERIOD_MS): number {
  return Math.min(PUBLISH_RETRY_SAFETY_MARGIN_MS, Math.floor(positivePeriod(periodMs) / 2));
}

/**
 * When a retry becomes eligible, as an ISO timestamp.
 *
 * THE PRODUCTION BUG THIS REPLACES. This used to be `now + 5 * attempts
 * minutes`. An item claimed at 22:15:02.413 was therefore parked until
 * 22:20:02.413 — 2.242 seconds AFTER the 22:20:00.171 cron had already run and
 * found it not yet due. A two-second miss became a five-minute delay.
 *
 * Retries now land on the worker's own cron boundary, so the very next cron
 * run can claim them. The attempt count no longer scales the delay: cadence,
 * not exponential backoff, decides when the worker looks again, and
 * MAX_PUBLISH_ATTEMPTS is what stops a poison item.
 */
export function retryAt(now: number = Date.now(), periodMs: number = PUBLISH_WORKER_PERIOD_MS): string {
  const period = positivePeriod(periodMs);
  const boundary = nextCronBoundaryAfter(now, period);
  const withMargin = boundary - retrySafetyMarginMs(period);
  // The margin is insurance, never a licence to park a retry in the past: an
  // attempt that finishes within the margin of a boundary takes the boundary
  // itself, which the tick at that boundary still claims (`scheduled_at <=
  // p_now`). Invariant: now < retryAt <= nextCronBoundaryAfter(now).
  return new Date(withMargin > now ? withMargin : boundary).toISOString();
}

/** Meta container status_code values. */
export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export function isContainerReady(status: string): boolean {
  return status === "FINISHED";
}
export function isContainerFatal(status: string): boolean {
  return status === "ERROR" || status === "EXPIRED";
}

/** Caption Instagram will accept: 2200 characters maximum. */
export function truncateCaption(caption: string): string {
  const value = String(caption ?? "");
  return value.length <= 2200 ? value : value.slice(0, 2200);
}

/** The durable publish identity for a scheduled item. One per draft, forever. */
export function publishIdempotencyKey(draftId: string): string {
  return `igpub_${String(draftId).replace(/-/g, "")}`;
}

/** Which queue states the Content Calendar should describe as auto-publishing. */
export function willAutoPublish(status: string): boolean {
  return status === "scheduled" || status === "publishing" || status === "waiting_for_media";
}

export function publishStatusTone(status: string): "green" | "amber" | "red" | "grey" {
  if (status === "published") return "green";
  if (status === "publishing" || status === "scheduled") return "amber";
  if (status === "failed" || status === "permission_required") return "red";
  return "grey";
}
