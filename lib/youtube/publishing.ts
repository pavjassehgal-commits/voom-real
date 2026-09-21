/**
 * YouTube publishing core — pure, dependency-free, unit testable.
 *
 * Nothing in this module performs I/O. It owns the YouTube publishing state
 * machine, the provider failure taxonomy (quota vs auth vs media vs provider
 * rejection vs ambiguous outcome), the resumable-upload chunk arithmetic and
 * the mapping from Google's documented error reasons onto truthful, safe,
 * actionable states.
 *
 * Truthfulness rules enforced here and in migration 0047:
 *   - scheduled != submitted: a row is `scheduled` until a worker claims it.
 *   - submitted != provider accepted: bytes in flight are `uploading`.
 *   - provider accepted != published: a returned video id is
 *     `provider_processing`; `published` requires YouTube's own
 *     processingDetails.uploadStatus = 'processed' (see complete RPC).
 *   - a YouTube video id is 11 characters of [A-Za-z0-9_-] — anything else
 *     is refused as fabricated, never stored, never displayed.
 *   - policy-sensitive metadata (privacy, made-for-kids) is NEVER guessed:
 *     unresolved declarations park the item in `needs_declaration`.
 *
 * Timing rule: like the Instagram worker, retries are parked on the worker's
 * own cron boundary so the next tick can claim them. Quota exhaustion is
 * special: Google's YouTube Data API quota resets at midnight US Pacific, so
 * a quota hold parks the item at the next Pacific reset WITHOUT consuming
 * the attempt budget — the provider's daily budget is not the item's fault.
 */

/** Durable publishing states persisted on public.youtube_publish_queue. */
export const YOUTUBE_PUBLISH_STATES = [
  "scheduled",
  "waiting_for_media",
  "needs_declaration",
  "permission_required",
  "uploading",
  "provider_processing",
  "published",
  "failed",
  "cancelled",
] as const;
export type YouTubePublishState = (typeof YOUTUBE_PUBLISH_STATES)[number];

export const TERMINAL_YOUTUBE_PUBLISH_STATES: YouTubePublishState[] = ["published", "cancelled"];

export const YOUTUBE_PUBLISH_STATE_LABELS: Record<YouTubePublishState, string> = {
  scheduled: "Scheduled",
  waiting_for_media: "Waiting for media",
  needs_declaration: "Needs audience declaration",
  permission_required: "Needs attention",
  uploading: "Uploading to YouTube",
  provider_processing: "YouTube is processing",
  published: "Published on YouTube",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type YouTubeFormat = "short" | "video";

export const YOUTUBE_FORMAT_LABELS: Record<YouTubeFormat, string> = {
  short: "YouTube Short",
  video: "YouTube Video",
};

/** YouTube's own hard metadata limits (videos.insert). */
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;

export const YOUTUBE_PRIVACY_VALUES = ["public", "private", "unlisted"] as const;
export type YouTubePrivacy = (typeof YOUTUBE_PRIVACY_VALUES)[number];

export const MAX_YOUTUBE_PUBLISH_ATTEMPTS = 5;
/** How long a claimed row may sit in `uploading` before reconciliation resumes it. */
export const YOUTUBE_STALE_CLAIM_MINUTES = 15;
/** Signed media URL lifetime for the storage object being streamed. */
export const YOUTUBE_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * The worker's cron cadence (5 minutes) and serverless ceiling, mirroring
 * the Instagram worker contract. maxDuration in the cron route MUST equal
 * YOUTUBE_WORKER_MAX_DURATION_MS / 1000 (a test asserts the sync).
 */
export const YOUTUBE_WORKER_PERIOD_MS = 5 * 60_000;
export const YOUTUBE_WORKER_MAX_DURATION_MS = 300_000;
export const YOUTUBE_WORKER_SAFETY_BUFFER_MS = 60_000;
export const YOUTUBE_UPLOAD_BUDGET_MS =
  YOUTUBE_WORKER_MAX_DURATION_MS - YOUTUBE_WORKER_SAFETY_BUFFER_MS;
/** Upper bound on one YouTube API call; the client aborts every request. */
export const YOUTUBE_API_CALL_ALLOWANCE_MS = 15_000;

/**
 * Resumable-upload chunk arithmetic. Google's protocol requires every
 * intermediate chunk to be an exact multiple of 256 KiB; the final chunk may
 * be any size. 8 MiB keeps per-chunk memory bounded (a serverless function
 * never buffers a whole video) while staying efficient.
 */
export const RESUMABLE_CHUNK_GRANULARITY_BYTES = 256 * 1024;
export const YOUTUBE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** The largest chunk that fits the granularity and the requested maximum. */
export function chunkSize(maxBytes: number = YOUTUBE_UPLOAD_CHUNK_BYTES): number {
  const granularity = RESUMABLE_CHUNK_GRANULARITY_BYTES;
  const whole = Math.floor(maxBytes / granularity) * granularity;
  return Math.max(whole, granularity);
}

/**
 * The byte window of one chunk. Intermediate windows are exact granularity
 * multiples; the final window ends at totalSize - 1. Returns null when
 * `offset` is already at or past the end (nothing left to send).
 */
export function chunkWindow(offset: number, totalSize: number, maxBytes: number = YOUTUBE_UPLOAD_CHUNK_BYTES): { start: number; end: number; length: number; final: boolean } | null {
  if (!Number.isInteger(offset) || !Number.isInteger(totalSize) || offset < 0 || totalSize <= 0) return null;
  if (offset >= totalSize) return null;
  const size = chunkSize(maxBytes);
  const remaining = totalSize - offset;
  const length = remaining <= size ? remaining : size;
  return { start: offset, end: offset + length - 1, length, final: offset + length >= totalSize };
}

/** The Content-Range header value for one chunk window. */
export function contentRangeFor(window: { start: number; end: number }, totalSize: number): string {
  return `bytes ${window.start}-${window.end}/${totalSize}`;
}

/** The status-query Content-Range value (`bytes * /total`) for a session. */
export function statusQueryRange(totalSize: number): string {
  return `bytes */${totalSize}`;
}

/** Parses a `Range: bytes=0-N` response header into received byte count. */
export function receivedBytesFromRange(header: string | null): number {
  if (!header) return 0;
  const match = /bytes=(\d+)-(\d+)/i.exec(header);
  if (!match) return 0;
  const end = Number(match[2]);
  return Number.isFinite(end) && end >= 0 ? end + 1 : 0;
}

/** A real YouTube video id: exactly 11 URL-safe characters. */
export function isRealYouTubeVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

/** processingDetails.uploadStatus values YouTube itself returns. */
export const PROVIDER_UPLOAD_STATUSES = ["uploaded", "processed", "rejected", "failed", "deleted"] as const;
export type ProviderUploadStatus = (typeof PROVIDER_UPLOAD_STATUSES)[number];

export function isProviderUploadStatus(value: unknown): value is ProviderUploadStatus {
  return typeof value === "string" && (PROVIDER_UPLOAD_STATUSES as readonly string[]).includes(value);
}

/**
 * Which upload statuses constitute authoritative PUBLICATION evidence.
 * `processed` means YouTube finished processing and the video is available
 * per its privacy setting. `uploaded` means accepted but still processing —
 * provider acceptance, NOT publication.
 */
export function isPublishedEvidence(uploadStatus: string | null | undefined): boolean {
  return uploadStatus === "processed";
}

/** Voom can stream these stored mime types to YouTube. */
export function isYouTubePublishableMime(mime: string): boolean {
  return mime === "video/mp4" || mime === "video/quicktime" || mime === "video/webm" || mime === "video/x-matroska";
}

export function truncateYouTubeTitle(title: string): string {
  const value = String(title ?? "").trim();
  return value.length <= YOUTUBE_TITLE_MAX ? value : value.slice(0, YOUTUBE_TITLE_MAX);
}

export function truncateYouTubeDescription(description: string): string {
  const value = String(description ?? "");
  return value.length <= YOUTUBE_DESCRIPTION_MAX ? value : value.slice(0, YOUTUBE_DESCRIPTION_MAX);
}

// ---------------------------------------------------------------------------
// Policy-sensitive declaration resolution — never a silent guess
// ---------------------------------------------------------------------------

export interface AudienceDeclarationInput {
  /** Explicit per-item declaration from the draft's content_meta. */
  itemMadeForKids?: boolean | null;
  itemPrivacy?: string | null;
  /** Owner-level defaults from youtube_connections (explicitly set or null). */
  defaultMadeForKids?: boolean | null;
  defaultPrivacy?: string | null;
}

export type AudienceDeclaration =
  | { ok: true; madeForKids: boolean; privacy: YouTubePrivacy }
  | { ok: false; missing: Array<"made_for_kids" | "privacy"> };

/**
 * Resolves the COPPA audience declaration and privacy for one item.
 *
 * The explicit item declaration wins; the owner's explicit default fills a
 * gap; NOTHING else may. When neither exists the result is `ok: false` and
 * the queue row parks in `needs_declaration` — Voom would rather hold an
 * item visibly than silently pick a policy-sensitive value on the owner's
 * behalf.
 */
export function resolveAudienceDeclaration(input: AudienceDeclarationInput): AudienceDeclaration {
  const missing: Array<"made_for_kids" | "privacy"> = [];
  const madeForKids = typeof input.itemMadeForKids === "boolean"
    ? input.itemMadeForKids
    : typeof input.defaultMadeForKids === "boolean"
      ? input.defaultMadeForKids
      : null;
  if (madeForKids === null) missing.push("made_for_kids");

  const privacyCandidate = typeof input.itemPrivacy === "string" && input.itemPrivacy
    ? input.itemPrivacy
    : typeof input.defaultPrivacy === "string" && input.defaultPrivacy
      ? input.defaultPrivacy
      : null;
  const privacy = privacyCandidate && (YOUTUBE_PRIVACY_VALUES as readonly string[]).includes(privacyCandidate)
    ? privacyCandidate as YouTubePrivacy
    : null;
  if (!privacy) missing.push("privacy");

  if (missing.length || madeForKids === null || !privacy) return { ok: false, missing };
  return { ok: true, madeForKids, privacy };
}

/**
 * The videos.insert request body Voom sends. Only documented fields; the
 * audience declaration is written to `selfDeclaredMadeForKids` (the field
 * Google documents as settable at insert — `madeForKids` is output-only).
 */
export function videoInsertMetadata(input: {
  title: string;
  description: string;
  categoryId: string;
  tags?: string[];
  privacy: YouTubePrivacy;
  madeForKids: boolean;
  /** Explicit synthetic-media disclosure, only when the owner set one. */
  containsSyntheticMedia?: boolean | null;
}): Record<string, unknown> {
  const status: Record<string, unknown> = {
    privacyStatus: input.privacy,
    selfDeclaredMadeForKids: input.madeForKids,
  };
  if (typeof input.containsSyntheticMedia === "boolean") {
    status.containsSyntheticMedia = input.containsSyntheticMedia;
  }
  const snippet: Record<string, unknown> = {
    title: truncateYouTubeTitle(input.title),
    description: truncateYouTubeDescription(input.description),
    categoryId: String(input.categoryId),
  };
  const tags = (input.tags ?? []).filter((tag): tag is string => typeof tag === "string" && tag.length > 0 && tag.length <= 500);
  if (tags.length) snippet.tags = tags.slice(0, 30);
  return { snippet, status };
}

// ---------------------------------------------------------------------------
// Provider failure taxonomy
// ---------------------------------------------------------------------------

export type YouTubeFailureStatus = Extract<
  YouTubePublishState,
  "failed" | "scheduled" | "permission_required" | "waiting_for_media" | "needs_declaration"
>;

export interface YouTubePublishFailure {
  status: YouTubeFailureStatus;
  code: string;
  /** Safe, user-facing. Never tokens, URLs or provider internals. */
  message: string;
  retryable: boolean;
  /** Quota holds park at the next Pacific reset without burning attempts. */
  quotaHold?: boolean;
}

export const YOUTUBE_PUBLISH_FAILURES = {
  not_connected: {
    status: "failed",
    code: "youtube_not_connected",
    message: "YouTube is not connected. Connect a channel to publish.",
    retryable: false,
  },
  authorization_revoked: {
    status: "permission_required",
    code: "authorization_revoked",
    message: "YouTube authorization is no longer valid. Reconnect the channel to resume publishing.",
    retryable: false,
  },
  permission_required: {
    status: "permission_required",
    code: "youtube_publish_permission_required",
    message: "The granted YouTube scopes do not include uploading. Reconnect the channel to grant them.",
    retryable: false,
  },
  needs_declaration: {
    status: "needs_declaration",
    code: "audience_declaration_required",
    message: "This item needs its made-for-kids declaration and privacy before YouTube allows an upload. Set them on the item or in YouTube settings.",
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
    message: "YouTube cannot receive this file type. Use an MP4, MOV, WebM or MKV video.",
    retryable: false,
  },
  media_url_failed: {
    status: "scheduled",
    code: "media_url_failed",
    message: "Voom could not prepare the stored video for upload. It will retry.",
    retryable: true,
  },
  session_failed: {
    status: "scheduled",
    code: "upload_session_failed",
    message: "YouTube did not open an upload session. It will retry.",
    retryable: true,
  },
  upload_interrupted: {
    status: "scheduled",
    code: "upload_interrupted",
    message: "The upload was interrupted. Voom resumes it from the bytes YouTube already received.",
    retryable: true,
  },
  quota_exceeded: {
    status: "scheduled",
    code: "quota_exceeded",
    message: "YouTube's daily quota for this API project is exhausted. Voom will retry after the quota resets (midnight US Pacific) — it does not hammer the API.",
    retryable: true,
    quotaHold: true,
  },
  rate_limited: {
    status: "scheduled",
    code: "rate_limited",
    message: "YouTube rate limited this request. It will retry at the next worker run.",
    retryable: true,
  },
  provider_rejected: {
    status: "failed",
    code: "provider_rejected",
    message: "YouTube rejected this video after processing it.",
    retryable: false,
  },
  provider_processing_failed: {
    status: "failed",
    code: "provider_processing_failed",
    message: "YouTube reported this video failed processing.",
    retryable: false,
  },
  processing_timeout: {
    status: "failed",
    code: "processing_timeout",
    message: "YouTube has not finished processing this video within Voom's polling window. The video id is recorded; reconciliation keeps checking.",
    retryable: false,
  },
  video_unavailable: {
    status: "failed",
    code: "video_unavailable",
    message: "YouTube no longer returns this video. It may have been removed on YouTube.",
    retryable: false,
  },
  upload_ambiguous: {
    // FAIL CLOSED: Voom cannot prove whether the upload completed. It never
    // re-uploads blindly (that could create a duplicate video); recovery is
    // a READ-ONLY search of the channel's uploads for the provider's own id.
    status: "failed",
    code: "upload_ambiguous",
    message: "YouTube's response was ambiguous, so Voom stopped instead of risking a duplicate upload. Reconciliation verifies the channel's uploads read-only and completes this item only with YouTube's own video id.",
    retryable: false,
  },
  unknown: {
    status: "failed",
    code: "youtube_publish_unknown_error",
    message: "YouTube publishing did not complete. Please review this item.",
    retryable: false,
  },
} as const satisfies Record<string, YouTubePublishFailure>;

export type YouTubeFailureKey = keyof typeof YOUTUBE_PUBLISH_FAILURES;

/** After MAX attempts even a retryable failure becomes terminal. */
export function resolveYouTubeFailure(key: YouTubeFailureKey, attempts: number): YouTubePublishFailure {
  const failure: YouTubePublishFailure = { ...YOUTUBE_PUBLISH_FAILURES[key] };
  if (failure.retryable && !failure.quotaHold && attempts >= MAX_YOUTUBE_PUBLISH_ATTEMPTS) {
    return { ...failure, status: "failed", retryable: false };
  }
  return failure;
}

/**
 * Maps a YouTubeApiError classification onto the failure taxonomy. Google's
 * documented error reasons are distinguished exactly: quota exhaustion is
 * NOT an auth failure, a revocation is NOT a media failure, and an unknown
 * 5xx is retryable while a 4xx rejection is not.
 */
export function failureForApiError(error: {
  kind: "quota" | "rate_limited" | "auth" | "not_found" | "invalid_request" | "server" | "network" | "unknown";
  reason?: string | null;
}): YouTubeFailureKey {
  switch (error.kind) {
    case "quota": return "quota_exceeded";
    case "rate_limited": return "rate_limited";
    case "auth": return "authorization_revoked";
    case "server":
    case "network": return "upload_interrupted";
    case "not_found": return "video_unavailable";
    case "invalid_request": return "provider_rejected";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Retry timing — worker cadence alignment and the Pacific quota reset
// ---------------------------------------------------------------------------

const RETRY_SAFETY_MARGIN_MS = 1_000;

function positivePeriod(periodMs: number): number {
  return Number.isFinite(periodMs) && periodMs > 0 ? Math.floor(periodMs) : YOUTUBE_WORKER_PERIOD_MS;
}

export function nextCronBoundaryAfter(at: number, periodMs: number = YOUTUBE_WORKER_PERIOD_MS): number {
  const period = positivePeriod(periodMs);
  return Math.floor(at / period) * period + period;
}

/** When a retry becomes eligible, aligned to the worker's own cron cadence. */
export function retryAt(now: number = Date.now(), periodMs: number = YOUTUBE_WORKER_PERIOD_MS): string {
  const period = positivePeriod(periodMs);
  const boundary = nextCronBoundaryAfter(now, period);
  const margin = Math.min(RETRY_SAFETY_MARGIN_MS, Math.floor(period / 2));
  const withMargin = boundary - margin;
  return new Date(withMargin > now ? withMargin : boundary).toISOString();
}

/**
 * The next YouTube Data API quota reset: midnight US Pacific (where Google
 * documents the daily reset), computed with the real timezone database —
 * never a fixed UTC offset, because Pacific time observes DST.
 */
export function nextQuotaResetAt(now: number = Date.now()): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const pacificWallClock = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  // Offset of Pacific from UTC at this instant (derived, DST-correct).
  const offsetMs = pacificWallClock - Math.floor(now / 1000) * 1000;
  const pacificMidnightUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day), 24, 0, 0,
  ) - offsetMs;
  // If the derived instant already passed (sub-second skew), take the next day.
  return new Date(pacificMidnightUtc > now ? pacificMidnightUtc : pacificMidnightUtc + 86_400_000).toISOString();
}

/** How long YouTube processing may be polled before Voom stops and reports. */
export const PROVIDER_PROCESSING_MAX_HOURS = 72;

export function processingExpired(lastAttemptAt: string | null, now: number = Date.now()): boolean {
  if (!lastAttemptAt) return false;
  const at = Date.parse(lastAttemptAt);
  if (Number.isNaN(at)) return false;
  return now - at > PROVIDER_PROCESSING_MAX_HOURS * 3600_000;
}

/** The durable publish identity for a scheduled item. One per draft, forever. */
export function youTubePublishIdempotencyKey(draftId: string): string {
  return `ytpub_${String(draftId).replace(/-/g, "")}`;
}

/** Which queue states mean "Voom will still act on this without the owner". */
export function willAutoPublish(status: string): boolean {
  return status === "scheduled" || status === "uploading" || status === "waiting_for_media" || status === "provider_processing";
}

export function youTubePublishStatusTone(status: string): "green" | "amber" | "red" | "grey" {
  if (status === "published") return "green";
  if (status === "uploading" || status === "scheduled" || status === "provider_processing" || status === "waiting_for_media") return "amber";
  if (status === "failed" || status === "permission_required" || status === "needs_declaration") return "red";
  return "grey";
}

/**
 * The truthful performance-window instant: the start of the hourly window
 * containing `now`. Deterministic, so two sync runs inside one window write
 * the SAME collected_at and refresh the same snapshot row (idempotency),
 * and unavailable metrics are simply absent — never a stored zero.
 */
export const YOUTUBE_PERFORMANCE_WINDOW_MS = 60 * 60 * 1000;

export function performanceWindowStart(now: number = Date.now()): string {
  return new Date(Math.floor(now / YOUTUBE_PERFORMANCE_WINDOW_MS) * YOUTUBE_PERFORMANCE_WINDOW_MS).toISOString();
}
