/**
 * TikTok publishing core — pure, dependency-free, unit testable.
 *
 * Nothing in this module performs I/O. It owns the TikTok publishing state
 * machine, the provider failure taxonomy (rate limit vs auth vs media vs
 * unaudited-client restriction vs privacy-option withdrawal vs provider
 * rejection vs ambiguous outcome), the Content Posting API chunk arithmetic
 * and the mapping from TikTok's documented error codes onto truthful, safe,
 * actionable states.
 *
 * Provider facts encoded here (verified against the current official TikTok
 * for Developers documentation — see the header of lib/tiktok/client.ts):
 *   - scheduled != submitted: a row is `scheduled` until a worker claims it.
 *   - submitted != provider accepted: a returned publish_id (with bytes in
 *     flight) is `posting`, NOT published.
 *   - provider accepted != published: `published` requires TikTok's own
 *     post-status answer `PUBLISH_COMPLETE` (see the complete RPC).
 *   - the creator's privacy options come from the LIVE creator-info query:
 *     a privacy choice that TikTok no longer offers for this creator is a
 *     real failure, never silently substituted.
 *   - unaudited API clients may only post in SELF_ONLY viewership (TikTok
 *     Content Sharing Guidelines). The provider's refusal is recorded
 *     truthfully; Voom never retries a different privacy on the creator's
 *     behalf and never claims a public publication that did not happen.
 *
 * Timing rule: like the Instagram and YouTube workers, retries park on the
 * worker's own cron boundary so the next tick can claim them. No aggressive
 * retry loop exists anywhere in this flow.
 */

/** Durable publishing states persisted on public.tiktok_publish_queue. */
export const TIKTOK_PUBLISH_STATES = [
  "scheduled",
  "waiting_for_media",
  "needs_declaration",
  "permission_required",
  "posting",
  "provider_processing",
  "published",
  "failed",
  "cancelled",
] as const;
export type TikTokPublishState = (typeof TIKTOK_PUBLISH_STATES)[number];

export const TERMINAL_TIKTOK_PUBLISH_STATES: TikTokPublishState[] = ["published", "cancelled"];

export const TIKTOK_PUBLISH_STATE_LABELS: Record<TikTokPublishState, string> = {
  scheduled: "Scheduled",
  waiting_for_media: "Waiting for media",
  needs_declaration: "Needs privacy declaration",
  permission_required: "Needs attention",
  posting: "Posting to TikTok",
  provider_processing: "TikTok is processing",
  published: "Published on TikTok",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * The privacy levels TikTok's Content Posting API documents. A post's
 * privacy_level MUST be one of the values returned for THIS creator by the
 * creator-info query (public accounts: PUBLIC_TO_EVERYONE /
 * MUTUAL_FOLLOW_FRIENDS / SELF_ONLY; private accounts: FOLLOWER_OF_CREATOR /
 * MUTUAL_FOLLOW_FRIENDS / SELF_ONLY). Nothing here may be invented.
 */
export const TIKTOK_PRIVACY_VALUES = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY_VALUES)[number];

export const TIKTOK_PRIVACY_LABELS: Record<TikTokPrivacy, string> = {
  PUBLIC_TO_EVERYONE: "Public to everyone",
  MUTUAL_FOLLOW_FRIENDS: "Mutual friends",
  FOLLOWER_OF_CREATOR: "Followers of creator",
  SELF_ONLY: "Only me (private)",
};

export function isTikTokPrivacy(value: unknown): value is TikTokPrivacy {
  return typeof value === "string" && (TIKTOK_PRIVACY_VALUES as readonly string[]).includes(value);
}

export const MAX_TIKTOK_PUBLISH_ATTEMPTS = 5;
/** How long a claimed row may sit in `posting` before reconciliation resumes it. */
export const TIKTOK_STALE_CLAIM_MINUTES = 15;
/** Signed media URL lifetime for the storage object being streamed. */
export const TIKTOK_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * The worker's cron cadence (5 minutes) and serverless ceiling, mirroring the
 * Instagram/YouTube worker contract. maxDuration in the cron routes MUST
 * equal TIKTOK_WORKER_MAX_DURATION_MS / 1000 (a test asserts the sync).
 */
export const TIKTOK_WORKER_PERIOD_MS = 5 * 60_000;
export const TIKTOK_WORKER_MAX_DURATION_MS = 300_000;
export const TIKTOK_WORKER_SAFETY_BUFFER_MS = 60_000;
export const TIKTOK_UPLOAD_BUDGET_MS =
  TIKTOK_WORKER_MAX_DURATION_MS - TIKTOK_WORKER_SAFETY_BUFFER_MS;
/** Upper bound on one TikTok API call; the client aborts every request. */
export const TIKTOK_API_CALL_ALLOWANCE_MS = 15_000;

/** The caption/title limit TikTok documents for video posts. */
export const TIKTOK_TITLE_MAX = 2200;

export function truncateTikTokTitle(title: string): string {
  const value = String(title ?? "").trim();
  return value.length <= TIKTOK_TITLE_MAX ? value : value.slice(0, TIKTOK_TITLE_MAX);
}

// ---------------------------------------------------------------------------
// Media transfer — TikTok Content Posting API "Media Transfer Guide"
// ---------------------------------------------------------------------------

/** Maximum video size TikTok accepts (Media Transfer Guide: 4GB). */
export const TIKTOK_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * The chunk plan TikTok's documented rules require:
 *   - a video smaller than 5 MB is uploaded whole (one chunk = full size);
 *   - otherwise each chunk is at least 5 MB and at most 64 MB, the FINAL
 *     chunk may be larger (up to 128 MB) to absorb the trailing bytes;
 *   - total_chunk_count must equal floor(video_size / chunk_size);
 *   - 1..1000 chunks, uploaded sequentially.
 *
 * Voom sends 64 MB chunks for videos ≥ 64 MB (a 4 GB video is 64 chunks —
 * far under the 1000 ceiling) and the whole file as a single chunk for
 * smaller videos (which is the documented "whole upload" path).
 */
export const TIKTOK_CHUNK_MIN_BYTES = 5 * 1024 * 1024;
export const TIKTOK_CHUNK_MAX_BYTES = 64 * 1024 * 1024;
export const TIKTOK_FINAL_CHUNK_MAX_BYTES = 128 * 1024 * 1024;
export const TIKTOK_MAX_CHUNK_COUNT = 1000;

export interface TikTokChunkPlan {
  /** The chunk_size Voom declares to TikTok in source_info. */
  chunkSize: number;
  /** total_chunk_count: floor(video_size / chunk_size), per the docs. */
  totalChunkCount: number;
}

/**
 * The documented chunk plan for one video size, or null when the video
 * violates TikTok's hard size restriction (over 4 GB).
 */
export function tiktokChunkPlan(videoSize: number): TikTokChunkPlan | null {
  if (!Number.isInteger(videoSize) || videoSize <= 0) return null;
  if (videoSize > TIKTOK_MAX_VIDEO_BYTES) return null;
  if (videoSize < TIKTOK_CHUNK_MIN_BYTES) {
    // Whole upload: one chunk, equal to the entire file.
    return { chunkSize: videoSize, totalChunkCount: 1 };
  }
  const chunkSize = Math.min(TIKTOK_CHUNK_MAX_BYTES, videoSize);
  const totalChunkCount = Math.floor(videoSize / chunkSize);
  if (totalChunkCount < 1 || totalChunkCount > TIKTOK_MAX_CHUNK_COUNT) return null;
  const finalSize = videoSize - (totalChunkCount - 1) * chunkSize;
  if (finalSize > TIKTOK_FINAL_CHUNK_MAX_BYTES) return null;
  return { chunkSize, totalChunkCount };
}

/**
 * The byte window of one chunk of the plan. Chunks are sequential; the final
 * chunk ends at videoSize - 1 and may exceed chunkSize (trailing bytes).
 * Returns null when `index` is past the end (nothing left to send).
 */
export function tiktokChunkWindow(plan: TikTokChunkPlan, videoSize: number, index: number): { start: number; end: number; length: number; final: boolean } | null {
  if (!Number.isInteger(index) || index < 0 || index >= plan.totalChunkCount) return null;
  const start = index * plan.chunkSize;
  const length = index === plan.totalChunkCount - 1
    ? videoSize - start
    : plan.chunkSize;
  if (length <= 0) return null;
  return { start, end: start + length - 1, length, final: index === plan.totalChunkCount - 1 };
}

/** The Content-Range header value for one chunk window. */
export function tiktokContentRangeFor(window: { start: number; end: number }, totalSize: number): string {
  return `bytes ${window.start}-${window.end}/${totalSize}`;
}

/**
 * Parses TikTok's upload response header `Content-Range: bytes 0-N/total`
 * into the number of bytes TikTok says it has received (N + 1). TikTok's
 * documented way of telling the client the actual upload progress — the
 * value the flow trusts over its own bookkeeping.
 */
export function uploadedBytesFromRange(header: string | null): number {
  if (!header) return 0;
  // Tolerant of both the standard `bytes 0-99/1000` and TikTok's documented
  // `bytes=0-99/1000` spelling of the progress header.
  const match = /bytes=?\s*(\d+)-(\d+)/i.exec(header);
  if (!match) return 0;
  const end = Number(match[2]);
  return Number.isFinite(end) && end >= 0 ? end + 1 : 0;
}

/** Voom can stream these stored mime types to TikTok (Media Transfer Guide). */
export const TIKTOK_PUBLISHABLE_MIMES = ["video/mp4", "video/webm", "video/quicktime"] as const;

export function isTikTokPublishableMime(mime: string): boolean {
  return (TIKTOK_PUBLISHABLE_MIMES as readonly string[]).includes(mime);
}

/**
 * A real TikTok publish_id: non-empty, at most the documented 64 characters,
 * URL-safe. Anything else is refused as fabricated, never stored.
 */
export function isRealTikTokPublishId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9._~\-]*$/.test(value);
}

// ---------------------------------------------------------------------------
// Provider status vocabulary (the post-status endpoint's own words)
// ---------------------------------------------------------------------------

export const TIKTOK_PROVIDER_STATUSES = [
  "PROCESSING_UPLOAD",
  "PROCESSING_DOWNLOAD",
  "SEND_TO_USER_INBOX",
  "PUBLISH_COMPLETE",
  "FAILED",
] as const;
export type TikTokProviderStatus = (typeof TIKTOK_PROVIDER_STATUSES)[number];

export function isTikTokProviderStatus(value: unknown): value is TikTokProviderStatus {
  return typeof value === "string" && (TIKTOK_PROVIDER_STATUSES as readonly string[]).includes(value);
}

/**
 * The ONLY authoritative PUBLICATION evidence: TikTok's own post-status
 * answer `PUBLISH_COMPLETE`. A returned publish_id is provider tracking,
 * not publication; PROCESSING_* is acceptance/processing, not publication.
 */
export function isTikTokPublishedEvidence(status: string | null | undefined): boolean {
  return status === "PUBLISH_COMPLETE";
}

// ---------------------------------------------------------------------------
// Policy-sensitive declaration resolution — never a silent guess
// ---------------------------------------------------------------------------

export interface TikTokDeclarationInput {
  /** Explicit per-item privacy declaration from the draft's content. */
  itemPrivacy?: string | null;
  /** Owner-level explicit default from tiktok_connections (or null). */
  defaultPrivacy?: string | null;
}

export type TikTokDeclaration =
  | { ok: true; privacy: TikTokPrivacy }
  | { ok: false; missing: Array<"privacy"> };

/**
 * Resolves the privacy choice for one item.
 *
 * The explicit item declaration wins; the owner's explicit default fills a
 * gap; NOTHING else may. TikTok has NO default privacy level — the request
 * fails without one — so an undeclared item parks visibly in
 * `needs_declaration` instead of Voom choosing a policy-sensitive value on
 * the owner's behalf. (Unlike YouTube, there is no "safe" privacy TikTok
 * documents: even SELF_ONLY is a choice the creator must make.)
 */
export function resolveTikTokDeclaration(input: TikTokDeclarationInput): TikTokDeclaration {
  const candidate = input.itemPrivacy || input.defaultPrivacy || null;
  if (isTikTokPrivacy(candidate)) return { ok: true, privacy: candidate };
  return { ok: false, missing: ["privacy"] };
}

/**
 * The post_info body Voom sends to the Direct Post endpoint. Only documented
 * fields. The interaction toggles (comment/duet/stitch) are sent ONLY when
 * the owner explicitly declared them — omitting them leaves TikTok's own
 * defaults in place, which is not Voom inventing a value. The commercial
 * content toggles and the AI-generated label are sent only when the owner
 * explicitly declared them (TikTok's content-sharing guidelines require the
 * UI to offer these disclosures; Voom records them, it never assumes them).
 */
export function tiktokDirectPostMetadata(input: {
  title: string;
  privacy: TikTokPrivacy;
  disableComment?: boolean | null;
  disableDuet?: boolean | null;
  disableStitch?: boolean | null;
  brandContentToggle?: boolean | null;
  brandOrganicToggle?: boolean | null;
  isAigc?: boolean | null;
}): Record<string, unknown> {
  const postInfo: Record<string, unknown> = {
    title: truncateTikTokTitle(input.title),
    privacy_level: input.privacy,
  };
  if (typeof input.disableComment === "boolean") postInfo.disable_comment = input.disableComment;
  if (typeof input.disableDuet === "boolean") postInfo.disable_duet = input.disableDuet;
  if (typeof input.disableStitch === "boolean") postInfo.disable_stitch = input.disableStitch;
  if (typeof input.brandContentToggle === "boolean") postInfo.brand_content_toggle = input.brandContentToggle;
  if (typeof input.brandOrganicToggle === "boolean") postInfo.brand_organic_toggle = input.brandOrganicToggle;
  if (typeof input.isAigc === "boolean") postInfo.is_aigc = input.isAigc;
  return { post_info: postInfo };
}

// ---------------------------------------------------------------------------
// Provider failure taxonomy
// ---------------------------------------------------------------------------

export type TikTokFailureStatus = Extract<
  TikTokPublishState,
  "failed" | "scheduled" | "permission_required" | "waiting_for_media" | "needs_declaration"
>;

export interface TikTokPublishFailure {
  status: TikTokFailureStatus;
  code: string;
  /** Safe, user-facing. Never tokens, URLs or provider internals. */
  message: string;
  retryable: boolean;
}

export const TIKTOK_PUBLISH_FAILURES = {
  not_connected: {
    status: "failed",
    code: "tiktok_not_connected",
    message: "TikTok is not connected. Connect an account to publish.",
    retryable: false,
  },
  authorization_revoked: {
    status: "permission_required",
    code: "authorization_revoked",
    message: "TikTok authorization is no longer valid. Reconnect the account to resume publishing.",
    retryable: false,
  },
  permission_required: {
    status: "permission_required",
    code: "tiktok_publish_permission_required",
    message: "The granted TikTok scopes do not include direct posting (video.publish). Reconnect the account to grant it.",
    retryable: false,
  },
  needs_declaration: {
    status: "needs_declaration",
    code: "privacy_declaration_required",
    message: "This item needs its privacy choice before TikTok allows a post. TikTok has no default privacy — set it on the item or in TikTok settings.",
    retryable: false,
  },
  privacy_not_allowed: {
    status: "needs_declaration",
    code: "privacy_option_not_offered",
    message: "TikTok no longer offers the chosen privacy option for this creator. Choose one of the options TikTok currently returns.",
    retryable: false,
  },
  unaudited_client_restricted: {
    // TikTok's Content Sharing Guidelines: unaudited API clients may only
    // post in SELF_ONLY viewership. This is a real provider restriction —
    // Voom records it truthfully, never re-posts with a different privacy
    // on the creator's behalf, and never claims a public post happened.
    status: "failed",
    code: "unaudited_client_restricted",
    message: "TikTok refused this privacy choice: until Voom's app passes TikTok's content-sharing audit, posts through it are restricted to private (Only me) visibility. Re-choose 'Only me (private)' to publish privately, or complete the audit for other options.",
    retryable: false,
  },
  draft_unavailable: {
    status: "scheduled",
    code: "draft_unavailable",
    message: "Voom could not confirm this item's approval just now. It will retry.",
    retryable: true,
  },
  not_approved: {
    status: "failed",
    code: "not_approved",
    message: "This item is not approved, so Voom will not publish it.",
    retryable: false,
  },
  media_missing: {
    status: "waiting_for_media",
    code: "media_missing",
    message: "This item has no stored video yet.",
    retryable: true,
  },
  media_unsupported: {
    status: "failed",
    code: "media_unsupported",
    message: "TikTok cannot receive this file type. Use an MP4, WebM or MOV video.",
    retryable: false,
  },
  media_too_large: {
    status: "failed",
    code: "media_too_large",
    message: "TikTok's maximum video size is 4 GB. This file is larger than TikTok accepts.",
    retryable: false,
  },
  media_url_failed: {
    status: "scheduled",
    code: "media_url_failed",
    message: "Voom could not prepare the stored video for upload. It will retry.",
    retryable: true,
  },
  post_init_failed: {
    status: "scheduled",
    code: "post_init_failed",
    message: "TikTok did not start this post. It will retry at the next worker run.",
    retryable: true,
  },
  upload_interrupted: {
    status: "scheduled",
    code: "upload_interrupted",
    message: "The upload was interrupted. Voom resumes it from the progress TikTok recorded — nothing is re-sent from the start.",
    retryable: true,
  },
  upload_task_gone: {
    // FAIL CLOSED: TikTok's upload task no longer exists (404) and Voom
    // cannot tell from the upload URL alone whether the post was created.
    // The publish_id is persisted; reconciliation asks TikTok's post-status
    // endpoint (read-only) and only a real status answer completes this
    // item. Voom never re-initializes a second post blindly.
    status: "failed",
    code: "upload_task_gone",
    message: "TikTok's upload task disappeared mid-upload. Voom stopped instead of risking a duplicate post; reconciliation verifies the post status read-only and completes this item only with TikTok's own answer.",
    retryable: false,
  },
  rate_limited: {
    status: "scheduled",
    code: "rate_limited",
    message: "TikTok rate limited this request. It will retry at the next worker run — Voom never hammers the API.",
    retryable: true,
  },
  posting_cap: {
    status: "failed",
    code: "posting_cap_reached",
    message: "TikTok refused this post: the creator's daily posting limit (or the app-level active-creator cap) is in effect. TikTok's cap varies by creator and resets on TikTok's schedule — reschedule the item for a later day.",
    retryable: false,
  },
  provider_rejected: {
    status: "failed",
    code: "provider_rejected",
    message: "TikTok rejected this post after receiving it.",
    retryable: false,
  },
  post_unavailable: {
    status: "failed",
    code: "post_unavailable",
    message: "TikTok no longer returns this post. It may have been removed on TikTok.",
    retryable: false,
  },
  processing_timeout: {
    status: "failed",
    code: "processing_timeout",
    message: "TikTok has not finished this post within Voom's polling window. The publish id is recorded; reconciliation keeps checking.",
    retryable: false,
  },
  publish_ambiguous: {
    // FAIL CLOSED: Voom cannot determine whether TikTok created the post.
    // It never re-submits blindly (that could create a duplicate post);
    // recovery is the READ-ONLY post-status query on the persisted id.
    status: "failed",
    code: "publish_ambiguous",
    message: "TikTok's response was ambiguous, so Voom stopped instead of risking a duplicate post. Reconciliation verifies the post status read-only and completes this item only with TikTok's own answer.",
    retryable: false,
  },
  unknown: {
    status: "failed",
    code: "tiktok_publish_unknown_error",
    message: "TikTok publishing did not complete. Please review this item.",
    retryable: false,
  },
} as const satisfies Record<string, TikTokPublishFailure>;

export type TikTokFailureKey = keyof typeof TIKTOK_PUBLISH_FAILURES;

/** After MAX attempts even a retryable failure becomes terminal. */
export function resolveTikTokFailure(key: TikTokFailureKey, attempts: number): TikTokPublishFailure {
  const failure: TikTokPublishFailure = { ...TIKTOK_PUBLISH_FAILURES[key] };
  if (failure.retryable && attempts >= MAX_TIKTOK_PUBLISH_ATTEMPTS) {
    return { ...failure, status: "failed", retryable: false };
  }
  return failure;
}

export type TikTokApiErrorKind =
  | "rate_limited"
  | "auth"
  | "not_found"
  | "invalid_request"
  | "server"
  | "network"
  | "unknown";

/**
 * Maps a TikTokApiError classification onto the failure taxonomy.
 * Distinguished exactly: a rate limit is NOT an auth failure, a revocation
 * is NOT a media failure, an unaudited-client restriction is NOT a generic
 * 403, and an unknown 5xx is retryable while a documented 4xx refusal is not.
 */
export function failureForApiError(error: {
  kind: TikTokApiErrorKind;
  reason?: string | null;
}): TikTokFailureKey {
  switch (error.kind) {
    case "rate_limited": return "rate_limited";
    case "auth": return "authorization_revoked";
    case "server":
    case "network": return "upload_interrupted";
    case "not_found": return "post_unavailable";
    case "invalid_request":
      // The client tags the two documented privacy/audit 403s with their
      // own reasons so the taxonomy can tell them apart from generic 400s.
      if (error.reason === "unaudited_client_can_only_post_to_private_accounts") return "unaudited_client_restricted";
      if (error.reason === "privacy_level_option_mismatch") return "privacy_not_allowed";
      return "post_init_failed";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Retry timing — worker cadence alignment
// ---------------------------------------------------------------------------

const RETRY_SAFETY_MARGIN_MS = 1_000;

function positivePeriod(periodMs: number): number {
  return Number.isFinite(periodMs) && periodMs > 0 ? Math.floor(periodMs) : TIKTOK_WORKER_PERIOD_MS;
}

export function nextTikTokCronBoundaryAfter(at: number, periodMs: number = TIKTOK_WORKER_PERIOD_MS): number {
  const period = positivePeriod(periodMs);
  return Math.floor(at / period) * period + period;
}

/** When a retry becomes eligible, aligned to the worker's own cron cadence. */
export function tiktokRetryAt(now: number = Date.now(), periodMs: number = TIKTOK_WORKER_PERIOD_MS): string {
  const period = positivePeriod(periodMs);
  const boundary = nextTikTokCronBoundaryAfter(now, period);
  const margin = Math.min(RETRY_SAFETY_MARGIN_MS, Math.floor(period / 2));
  const withMargin = boundary - margin;
  return new Date(withMargin > now ? withMargin : boundary).toISOString();
}

/** How long TikTok processing may be polled before Voom stops and reports. */
export const PROVIDER_PROCESSING_MAX_HOURS = 72;

export function tiktokProcessingExpired(lastAttemptAt: string | null, now: number = Date.now()): boolean {
  if (!lastAttemptAt) return false;
  const at = Date.parse(lastAttemptAt);
  if (Number.isNaN(at)) return false;
  return now - at > PROVIDER_PROCESSING_MAX_HOURS * 3600_000;
}

/** The durable publish identity for a scheduled item. One per draft, forever. */
export function tiktokPublishIdempotencyKey(draftId: string): string {
  return `ttpub_${String(draftId).replace(/-/g, "")}`;
}

/** Which queue states mean "Voom will still act on this without the owner". */
export function tiktokWillAutoPublish(status: string): boolean {
  return status === "scheduled" || status === "posting" || status === "waiting_for_media" || status === "provider_processing";
}

export function tiktokPublishStatusTone(status: string): "green" | "amber" | "red" | "grey" {
  if (status === "published") return "green";
  if (status === "posting" || status === "scheduled" || status === "provider_processing" || status === "waiting_for_media") return "amber";
  if (status === "failed" || status === "permission_required" || status === "needs_declaration") return "red";
  return "grey";
}
