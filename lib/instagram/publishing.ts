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
/** Reel container polling. Meta transcodes asynchronously. */
export const REEL_POLL_ATTEMPTS = 20;
export const REEL_POLL_INTERVAL_MS = 6_000;
export const IMAGE_POLL_ATTEMPTS = 5;
export const IMAGE_POLL_INTERVAL_MS = 3_000;

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

/** Backoff for a retryable failure, as an ISO timestamp. */
export function retryAt(attempts: number, now: number = Date.now()): string {
  const minutes = Math.min(60, 5 * Math.max(attempts, 1));
  return new Date(now + minutes * 60_000).toISOString();
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
