/**
 * The YouTube publish sequence, expressed against small injected ports.
 *
 * This module performs no I/O of its own and imports nothing server-only, so
 * the real publishing behaviour — resumable session handling, chunked
 * streaming, provider-evidence completion, duplicate protection and the
 * fail-closed ambiguous-outcome path — is exercised directly by the test
 * suite with fake ports instead of touching YouTube.
 *
 * lib/youtube/publish-worker.ts wires the real Supabase + Google API
 * implementations into these ports.
 *
 * Provider truth encoded here:
 *   - `published` is returned ONLY when YouTube's own videos.list reports
 *     processingDetails.uploadStatus = 'processed' for a real video id.
 *   - a completed upload (200/201 + video id) is provider ACCEPTANCE —
 *     the row moves to provider_processing, never straight to published.
 *   - an ambiguous outcome (session gone, unreadable completion) FAILS
 *     CLOSED: recovery is a READ-ONLY scan of the channel's uploads for
 *     YouTube's own video id. Voom never re-uploads blindly, because a
 *     completed-but-unrecorded session plus a fresh upload would create a
 *     duplicate video on the customer's channel.
 */

import {
  chunkWindow,
  contentRangeFor,
  failureForApiError,
  isPublishedEvidence,
  isRealYouTubeVideoId,
  nextQuotaResetAt,
  processingExpired,
  resolveYouTubeFailure,
  retryAt,
  videoInsertMetadata,
  YOUTUBE_API_CALL_ALLOWANCE_MS,
  type YouTubeFailureKey,
} from "./publishing.ts";

export interface YouTubeFlowItem {
  id: string;
  ownerUserId: string;
  draftId: string;
  format: "short" | "video";
  title: string;
  description: string;
  /** NULL = the owner has not declared it (row parks in needs_declaration). */
  privacyStatus: string | null;
  madeForKids: boolean | null;
  categoryId: string;
  /** Explicit synthetic-media disclosure from the draft, when set. */
  containsSyntheticMedia?: boolean | null;
  attempts: number;
  sessionUrl: string | null;
  contentLength: number | null;
  bytesSent: number;
  videoId: string | null;
  lastAttemptAt: string | null;
}

export interface YouTubeFlowPorts {
  /** Server-side re-resolution of the draft (approval is re-checked, never trusted from the snapshot). */
  loadDraft(ownerId: string, draftId: string): Promise<{ status: string } | null>;
  /** Server-side re-resolution of the connection. */
  loadConnection(ownerId: string): Promise<{ status: string; scopes: string[] } | null>;
  /** Decrypted credentials (refresh handled inside). Throwing = not connected. */
  loadCredentials(ownerId: string): Promise<{ channelId: string; accessToken: string; uploadsPlaylistId: string | null }>;
  /** The private stored asset for this draft, including its exact byte size. */
  loadAsset(ownerId: string, draftId: string): Promise<{ storagePath: string; mimeType: string; status: string; byteSize: number | null } | null>;
  /**
   * Opens a byte-range read of the stored object as a STREAM. The flow never
   * holds a whole video in memory — each chunk is piped from storage to the
   * provider session (the Vercel-safe path for large files).
   */
  openMediaRange(storagePath: string, start: number, end: number): Promise<ReadableStream<Uint8Array> | Uint8Array | null>;
  /** Phase 1 of the resumable protocol: POST metadata → session URI. */
  initiateSession(input: { accessToken: string; metadata: Record<string, unknown>; contentType: string; contentLength: number }): Promise<string>;
  /** Phase 2: PUT one chunk window. */
  putChunk(input: { sessionUrl: string; body: ReadableStream<Uint8Array> | Uint8Array; contentType: string; contentRange: string; contentLength: number }): Promise<ChunkOutcome>;
  /** Ask the session what it received (`Content-Range: bytes * /size`). */
  querySession(sessionUrl: string, totalSize: number): Promise<ChunkOutcome>;
  /** READ-ONLY provider evidence for one video id. */
  getVideo(accessToken: string, videoId: string): Promise<VideoEvidence | null>;
  /** READ-ONLY recovery scan of the channel's recent uploads. */
  listRecentUploads(accessToken: string, uploadsPlaylistId: string): Promise<Array<{ videoId: string; title: string | null; publishedAt: string | null }>>;
  persistSession(item: YouTubeFlowItem, sessionUrl: string, contentLength: number): Promise<void>;
  persistProgress(item: YouTubeFlowItem, bytesSent: number): Promise<void>;
  recordVideoId(item: YouTubeFlowItem, videoId: string, uploadStatus: string | null, privacyStatus: string | null): Promise<void>;
  markPublished(item: YouTubeFlowItem, privacyStatus: string | null, note: string | null): Promise<void>;
  markFailed(item: YouTubeFlowItem, input: { code: string; message: string; status: string; retryAt: string | null; resetAttempts?: boolean }): Promise<void>;
  sleep(ms: number): Promise<void>;
  now?(): number;
  /** Remaining wall-clock milliseconds for this serverless invocation. */
  remainingBudgetMs?(): number;
  /** Whether the Google API project passed the Compliance Audit (affects only the truthful provider note, never the outcome). */
  projectAudited?: boolean;
}

export type ChunkOutcome =
  | { outcome: "continue"; receivedBytes: number }
  | { outcome: "complete"; videoId: string; uploadStatus: string | null; privacyStatus: string | null }
  | { outcome: "gone" };

export interface VideoEvidence {
  videoId: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  rejectionReason: string | null;
  failureReason: string | null;
}

export type YouTubeFlowResult =
  | { outcome: "published"; videoId: string }
  | { outcome: "processing"; videoId: string; code: string }
  | { outcome: "failed"; code: string }
  | { outcome: "retrying"; code: string };

/** How long the flow keeps polling processing INSIDE one invocation. */
const IN_RUN_PROCESSING_POLLS = 3;
const IN_RUN_PROCESSING_POLL_INTERVAL_MS = 10_000;

export async function runYouTubePublishFlow(item: YouTubeFlowItem, ports: YouTubeFlowPorts): Promise<YouTubeFlowResult> {
  const now = () => (ports.now ? ports.now() : Date.now());
  const remainingBudgetMs = () => (ports.remainingBudgetMs ? ports.remainingBudgetMs() : Number.POSITIVE_INFINITY);

  // 0) Provider acceptance already recorded: skip straight to the evidence
  //    phase. A rerun after publication is handled by the caller (published
  //    rows are never claimed), and re-recording is structurally refused by
  //    the database anyway.
  if (item.videoId && isRealYouTubeVideoId(item.videoId)) {
    return finishFromProviderEvidence(item, ports, now, remainingBudgetMs);
  }

  // 1) Approval is re-checked server-side; a rejected/un-approved draft never
  //    uploads. An unreadable draft is a transient fact, not a withdrawal.
  let draft: { status: string } | null;
  try {
    draft = await ports.loadDraft(item.ownerUserId, item.draftId);
  } catch {
    return fail(item, ports, now, "draft_unavailable");
  }
  if (!draft) return fail(item, ports, now, "draft_unavailable");
  if (draft.status !== "approved") return fail(item, ports, now, "not_approved");

  // 2) Connection + the upload scope Google actually granted.
  const connection = await ports.loadConnection(item.ownerUserId);
  if (!connection || connection.status !== "connected") return fail(item, ports, now, "not_connected");
  if (!connection.scopes.includes("https://www.googleapis.com/auth/youtube.upload")) {
    return fail(item, ports, now, "permission_required");
  }

  // 3) Policy-sensitive metadata is NEVER guessed. A missing audience
  //    declaration or privacy parks the item visibly for the owner.
  const privacy = item.privacyStatus === "public" || item.privacyStatus === "private" || item.privacyStatus === "unlisted"
    ? item.privacyStatus
    : null;
  if (privacy === null || typeof item.madeForKids !== "boolean") {
    return fail(item, ports, now, "needs_declaration");
  }

  let credentials: { channelId: string; accessToken: string; uploadsPlaylistId: string | null };
  try {
    credentials = await ports.loadCredentials(item.ownerUserId);
  } catch {
    return fail(item, ports, now, "not_connected");
  }

  // 4) The stored video asset. YouTube needs real bytes with a known size.
  const asset = await ports.loadAsset(item.ownerUserId, item.draftId);
  if (!asset || asset.status !== "uploaded" || !asset.byteSize || asset.byteSize <= 0) {
    return fail(item, ports, now, "media_missing");
  }
  const mimeSupported = asset.mimeType === "video/mp4" || asset.mimeType === "video/quicktime" || asset.mimeType === "video/webm" || asset.mimeType === "video/x-matroska";
  if (!mimeSupported) return fail(item, ports, now, "media_unsupported");
  const totalSize = asset.byteSize;

  // 5) Session continuity — the duplicate-upload protection.
  //
  // A persisted session whose declared content length still matches the
  // stored asset is RESUMED (after asking YouTube what actually arrived),
  // never re-created. A session for a different byte length (the asset was
  // replaced) or a session YouTube says is gone goes through the READ-ONLY
  // recovery scan first: if the upload actually completed, its video id is
  // recovered from the channel's uploads; only when the scan proves no video
  // was created is a fresh session safe to open.
  let sessionUrl = item.sessionUrl;
  let offset = item.bytesSent;

  if (sessionUrl && item.contentLength === totalSize) {
    let queried: ChunkOutcome;
    try {
      queried = await ports.querySession(sessionUrl, totalSize);
    } catch {
      return fail(item, ports, now, "upload_interrupted");
    }
    if (queried.outcome === "complete") {
      return acceptProviderVideo(item, ports, now, queried, credentials, privacy);
    }
    if (queried.outcome === "continue") {
      // Trust YouTube's own byte count over the local bookkeeping.
      offset = Math.max(queried.receivedBytes, 0);
    } else {
      const recovered = await recoverCompletedUpload(item, ports, credentials);
      if (recovered === "ambiguous") return fail(item, ports, now, "upload_ambiguous");
      if (recovered) return recovered;
      sessionUrl = null;
      offset = 0;
    }
  } else if (sessionUrl) {
    // Stale session for replaced bytes: recover read-only, then start fresh.
    const recovered = await recoverCompletedUpload(item, ports, credentials);
    if (recovered === "ambiguous") return fail(item, ports, now, "upload_ambiguous");
    if (recovered) return recovered;
    sessionUrl = null;
    offset = 0;
  }

  if (!sessionUrl) {
    const metadata = videoInsertMetadata({
      title: item.title,
      description: item.description,
      categoryId: item.categoryId,
      privacy,
      madeForKids: item.madeForKids === true,
      containsSyntheticMedia: item.containsSyntheticMedia,
    });
    let started: string;
    try {
      started = await ports.initiateSession({
        accessToken: credentials.accessToken, metadata, contentType: asset.mimeType, contentLength: totalSize,
      });
    } catch (cause) {
      return failFromApiError(item, ports, now, cause, "session_failed");
    }
    if (!started) return fail(item, ports, now, "session_failed");
    // Persist BEFORE the first byte: a crash mid-upload resumes this session
    // instead of creating a second video.
    await ports.persistSession(item, started, totalSize);
    sessionUrl = started;
    offset = 0;
  }

  // 6) Chunked streaming upload, bounded by the invocation's wall clock.
  for (;;) {
    if (remainingBudgetMs() < YOUTUBE_API_CALL_ALLOWANCE_MS) {
      // Out of time: park on the next cron boundary. The session persists;
      // the next run resumes from YouTube's own received-byte count.
      return park(item, ports, now, "upload_interrupted");
    }
    const window = chunkWindow(offset, totalSize);
    if (!window) break; // every byte is with YouTube
    let body: ReadableStream<Uint8Array> | Uint8Array | null;
    try {
      body = await ports.openMediaRange(asset.storagePath, window.start, window.end);
    } catch {
      body = null;
    }
    if (!body) return fail(item, ports, now, "media_url_failed");

    let result: ChunkOutcome;
    try {
      result = await ports.putChunk({
        sessionUrl,
        body,
        contentType: asset.mimeType,
        contentRange: contentRangeFor(window, totalSize),
        contentLength: window.length,
      });
    } catch (cause) {
      return failFromApiError(item, ports, now, cause, "upload_interrupted");
    }

    if (result.outcome === "complete") {
      return acceptProviderVideo(item, ports, now, result, credentials, privacy);
    }
    if (result.outcome === "gone") {
      // Session vanished mid-upload: ambiguous. Fail closed unless the
      // read-only scan proves no video was created.
      const recovered = await recoverCompletedUpload(item, ports, credentials);
      if (recovered === "ambiguous") return fail(item, ports, now, "upload_ambiguous");
      if (recovered) return recovered;
      return park(item, ports, now, "upload_interrupted");
    }
    const received = Math.max(result.receivedBytes, offset);
    if (received <= offset && !window.final) {
      // YouTube accepted nothing for this chunk; retry the same window once
      // the next boundary arrives instead of spinning.
      await ports.persistProgress(item, offset).catch(() => undefined);
      return park(item, ports, now, "upload_interrupted");
    }
    offset = received;
    await ports.persistProgress(item, offset).catch(() => undefined);
    if (window.final && offset >= totalSize) break;
  }

  // All bytes were accepted but no completion arrived in-band. Ask the
  // session itself — the authoritative answer.
  let finalQuery: ChunkOutcome;
  try {
    finalQuery = await ports.querySession(sessionUrl, totalSize);
  } catch {
    return park(item, ports, now, "upload_interrupted");
  }
  if (finalQuery.outcome === "complete") {
    return acceptProviderVideo(item, ports, now, finalQuery, credentials, privacy);
  }
  if (finalQuery.outcome === "continue") {
    await ports.persistProgress(item, Math.max(finalQuery.receivedBytes, offset)).catch(() => undefined);
    return park(item, ports, now, "upload_interrupted");
  }
  const recovered = await recoverCompletedUpload(item, ports, credentials);
  if (recovered === "ambiguous") return fail(item, ports, now, "upload_ambiguous");
  if (recovered) return recovered;
  return park(item, ports, now, "upload_interrupted");
}

/**
 * Provider-evidence phase: the video id exists (provider ACCEPTANCE); only
 * YouTube's own `processed` upload status may establish publication.
 */
async function finishFromProviderEvidence(
  item: YouTubeFlowItem,
  ports: YouTubeFlowPorts,
  now: () => number,
  remainingBudgetMs: () => number,
): Promise<YouTubeFlowResult> {
  const videoId = item.videoId as string;
  let credentials: { accessToken: string };
  try {
    credentials = await ports.loadCredentials(item.ownerUserId);
  } catch {
    return fail(item, ports, now, "not_connected");
  }

  for (let poll = 0; poll <= IN_RUN_PROCESSING_POLLS; poll += 1) {
    if (poll > 0) {
      if (remainingBudgetMs() < YOUTUBE_API_CALL_ALLOWANCE_MS + IN_RUN_PROCESSING_POLL_INTERVAL_MS) break;
      await ports.sleep(IN_RUN_PROCESSING_POLL_INTERVAL_MS);
    }
    let evidence: VideoEvidence | null;
    try {
      evidence = await ports.getVideo(credentials.accessToken, videoId);
    } catch (cause) {
      const key = failureForApiError(toApiErrorShape(cause));
      if (key === "quota_exceeded") return parkQuota(item, ports, now);
      if (key === "authorization_revoked") return fail(item, ports, now, "authorization_revoked");
      // A transient read failure never rewrites provider evidence.
      return { outcome: "retrying", code: "evidence_read_failed" };
    }
    if (!evidence) {
      // YouTube returns no item: propagation lag early on, removal later.
      if (processingExpired(item.lastAttemptAt, now())) return fail(item, ports, now, "video_unavailable");
      return { outcome: "retrying", code: "video_not_yet_listed" };
    }
    if (isPublishedEvidence(evidence.uploadStatus)) {
      await ports.markPublished(item, evidence.privacyStatus, privacyNote(item, evidence.privacyStatus, ports.projectAudited === true));
      return { outcome: "published", videoId };
    }
    if (evidence.uploadStatus === "rejected") {
      return fail(item, ports, now, "provider_rejected", evidence.rejectionReason ? `YouTube rejected this video (${evidence.rejectionReason}).` : undefined);
    }
    if (evidence.uploadStatus === "failed") {
      return fail(item, ports, now, "provider_processing_failed", evidence.failureReason ? `YouTube could not process this video (${evidence.failureReason}).` : undefined);
    }
    if (evidence.uploadStatus === "deleted") {
      return fail(item, ports, now, "video_unavailable");
    }
    // 'uploaded' (or an unrecognized status): still processing.
    if (processingExpired(item.lastAttemptAt, now())) {
      return fail(item, ports, now, "processing_timeout");
    }
  }
  return { outcome: "processing", videoId, code: "provider_processing" };
}

/** The truthful note when YouTube's applied privacy differs from requested. */
function privacyNote(item: YouTubeFlowItem, providerPrivacy: string | null, projectAudited: boolean): string | null {
  const requested = item.privacyStatus;
  if (!requested || !providerPrivacy || providerPrivacy === requested) return null;
  if (providerPrivacy === "private" && !projectAudited) {
    return "YouTube locked this upload to private: the API project has not passed the YouTube API Services Compliance Audit.";
  }
  return `YouTube applied '${providerPrivacy}' privacy instead of the requested '${requested}'.`;
}

/**
 * Records provider acceptance (a REAL video id from YouTube's own response)
 * and immediately attempts the evidence phase inside the same invocation.
 */
async function acceptProviderVideo(
  item: YouTubeFlowItem,
  ports: YouTubeFlowPorts,
  now: () => number,
  result: Extract<ChunkOutcome, { outcome: "complete" }>,
  credentials: { accessToken: string },
  privacy: string,
): Promise<YouTubeFlowResult> {
  if (!isRealYouTubeVideoId(result.videoId)) {
    // Structural refusal: a "video id" that is not a real 11-character
    // YouTube id is never stored and never displayed.
    return fail(item, ports, now, "upload_ambiguous");
  }
  await ports.recordVideoId(item, result.videoId, result.uploadStatus ?? "uploaded", result.privacyStatus ?? privacy);
  const withVideo: YouTubeFlowItem = { ...item, videoId: result.videoId, lastAttemptAt: new Date(now()).toISOString() };
  if (isPublishedEvidence(result.uploadStatus)) {
    await ports.markPublished(withVideo, result.privacyStatus ?? privacy, privacyNote(withVideo, result.privacyStatus ?? privacy, ports.projectAudited === true));
    return { outcome: "published", videoId: result.videoId };
  }
  // Provider acceptance != publication. Poll for the provider's own
  // 'processed' evidence with whatever budget this invocation still has.
  void credentials;
  return finishFromProviderEvidence(withVideo, ports, now, () => 0);
}

/**
 * READ-ONLY recovery for an ambiguous outcome. Returns:
 *   - a flow result when YouTube's own uploads list proves the video exists
 *     (completed with its real id — recorded, then evidence-polled),
 *   - null when the scan proves NO matching video was created (a fresh
 *     session is then safe: an incomplete resumable session never produces
 *     a video),
 *   - "ambiguous" when the scan itself could not run or could not decide —
 *     the item FAILS CLOSED instead of risking a duplicate upload.
 */
async function recoverCompletedUpload(
  item: YouTubeFlowItem,
  ports: YouTubeFlowPorts,
  credentials: { accessToken: string; uploadsPlaylistId: string | null },
): Promise<YouTubeFlowResult | "ambiguous" | null> {
  if (!credentials.uploadsPlaylistId) return "ambiguous";
  let uploads: Array<{ videoId: string; title: string | null; publishedAt: string | null }>;
  try {
    uploads = await ports.listRecentUploads(credentials.accessToken, credentials.uploadsPlaylistId);
  } catch {
    return "ambiguous";
  }
  const match = findRecoveredUpload(uploads, item.title, item.lastAttemptAt);
  if (!match) return null;
  // YouTube's own uploads list proves the video exists: record the real id
  // as provider acceptance and run the evidence phase on it.
  const now = () => Date.now();
  await ports.recordVideoId(item, match, "uploaded", item.privacyStatus);
  const withVideo: YouTubeFlowItem = { ...item, videoId: match, lastAttemptAt: new Date(now()).toISOString() };
  return finishFromProviderEvidence(withVideo, ports, now, () => 0);
}

/**
 * Pure recovery matching: an upload counts as THIS item's video only when
 * YouTube's own title matches exactly and the upload appeared no earlier
 * than this item's last attempt (minus a small clock-skew margin). Multiple
 * matches take the newest. No match → null (never a guess).
 */
export function findRecoveredUpload(
  uploads: Array<{ videoId: string; title: string | null; publishedAt: string | null }>,
  title: string,
  lastAttemptAt: string | null,
  skewMs: number = 10 * 60_000,
): string | null {
  const wanted = String(title ?? "").trim();
  if (!wanted) return null;
  const notBefore = lastAttemptAt ? Date.parse(lastAttemptAt) - skewMs : NaN;
  let best: { videoId: string; at: number } | null = null;
  for (const upload of uploads) {
    if (!isRealYouTubeVideoId(upload.videoId)) continue;
    if (String(upload.title ?? "").trim() !== wanted) continue;
    const at = upload.publishedAt ? Date.parse(upload.publishedAt) : NaN;
    if (Number.isFinite(notBefore) && (Number.isNaN(at) || at < notBefore)) continue;
    if (!best || (Number.isFinite(at) && at > best.at)) best = { videoId: upload.videoId, at: Number.isFinite(at) ? at : 0 };
  }
  return best ? best.videoId : null;
}

// ---------------------------------------------------------------------------
// Failure plumbing
// ---------------------------------------------------------------------------

type ApiErrorShape = { kind: "quota" | "rate_limited" | "auth" | "not_found" | "invalid_request" | "server" | "network" | "unknown"; reason?: string | null };

function toApiErrorShape(cause: unknown): ApiErrorShape {
  if (cause && typeof cause === "object") {
    const record = cause as { kind?: unknown; reason?: unknown };
    if (typeof record.kind === "string") {
      return { kind: record.kind as ApiErrorShape["kind"], reason: typeof record.reason === "string" ? record.reason : null };
    }
  }
  return { kind: "network" };
}

function failFromApiError(
  item: YouTubeFlowItem,
  ports: YouTubeFlowPorts,
  now: () => number,
  cause: unknown,
  fallbackKey: YouTubeFailureKey,
): Promise<YouTubeFlowResult> {
  const key = failureForApiError(toApiErrorShape(cause));
  if (key === "quota_exceeded") return parkQuota(item, ports, now);
  if (key === "authorization_revoked") return fail(item, ports, now, "authorization_revoked");
  return fail(item, ports, now, key === "unknown" ? fallbackKey : key);
}

/**
 * Quota exhaustion is the provider's DAILY budget, not this item's fault:
 * the retry parks at the next Pacific reset and the attempt counter is
 * reset, so a quota day never burns an item's retry allowance. No aggressive
 * blind retry exists anywhere in this flow.
 */
async function parkQuota(item: YouTubeFlowItem, ports: YouTubeFlowPorts, now: () => number): Promise<YouTubeFlowResult> {
  const failure = resolveYouTubeFailure("quota_exceeded", item.attempts);
  await ports.markFailed(item, {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    retryAt: nextQuotaResetAt(now()),
    resetAttempts: true,
  });
  return { outcome: "retrying", code: failure.code };
}

/** Parks a retryable interruption on the next worker cron boundary. */
async function park(item: YouTubeFlowItem, ports: YouTubeFlowPorts, now: () => number, key: YouTubeFailureKey): Promise<YouTubeFlowResult> {
  const failure = resolveYouTubeFailure(key, item.attempts);
  await ports.markFailed(item, {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    retryAt: failure.retryable ? retryAt(now()) : null,
  });
  return { outcome: "retrying", code: failure.code };
}

async function fail(
  item: YouTubeFlowItem,
  ports: YouTubeFlowPorts,
  now: () => number,
  key: YouTubeFailureKey,
  messageOverride?: string,
): Promise<YouTubeFlowResult> {
  const failure = resolveYouTubeFailure(key, item.attempts);
  await ports.markFailed(item, {
    code: failure.code,
    message: messageOverride ?? failure.message,
    status: failure.status,
    retryAt: failure.retryable && failure.status === "scheduled" ? retryAt(now()) : null,
  });
  return { outcome: "failed", code: failure.code };
}
