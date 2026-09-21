/**
 * The TikTok Direct Post flow, kept dependency-injected so tests can drive
 * every documented outcome with fakes. The worker owns scheduling and
 * signing; this module owns the provider dialogue.
 *
 * The documented order is fixed (Direct Post guide):
 *
 *   1. re-verify the draft is still approved
 *   2. verify the connection is live and grants video.publish
 *   3. require an explicit privacy declaration (never guess)
 *   4. verify the media exists, is a publishable codec, and fits the limits
 *   5. query the CREATOR INFO required before every post and verify the
 *      user's privacy choice against the options TikTok returned live
 *   6. init Direct Post and PERSIST the publish id before any byte is sent
 *   7. stream the media with sequential Content-Range chunks (resume from
 *      the persisted byte offset; 416 syncs progress; 404 fails closed)
 *   8. move the row to provider-owned processing and poll the OFFICIAL
 *      post-status endpoint; only PUBLISH_COMPLETE may publish, and only
 *      with provider evidence.
 *
 * Resumption: a persisted publish id means the post was already initiated.
 * An incomplete transfer resumes from the persisted byte offset against the
 * SAME upload task (never a re-init); a complete transfer (or a row the
 * reconciliation worker handed over) only reads the post-status endpoint.
 * The guarded re-arm (reset after invalid_publish_id) is the single,
 * provider-attested path that may clear a persisted publish id.
 *
 * Failure taxonomy (see TIKTOK_PUBLISH_FAILURES): permanent provider
 * rejections stay terminal; rate limits, 5xx, and network problems park to
 * the next cron boundary; ambiguous results (upload task gone, unreadable
 * evidence) never claim success — reconciliation reads the official status.
 */

import {
  type ChunkUploadResult,
  TikTokApiError,
  type TikTokCreatorInfo,
  type TikTokPostStatus,
} from "./client";
import { hasPublishPermission } from "./scopes";
import {
  isRealTikTokPublishId,
  isTikTokPrivacy,
  isTikTokPublishableMime,
  TIKTOK_PRIVACY_LABELS,
  TIKTOK_PRIVACY_VALUES,
  TIKTOK_MAX_VIDEO_BYTES,
  TIKTOK_API_CALL_ALLOWANCE_MS,
  TIKTOK_WORKER_PERIOD_MS,
  nextTikTokCronBoundaryAfter,
  resolveTikTokFailure,
  tiktokChunkPlan,
  tiktokChunkWindow,
  tiktokContentRangeFor,
  tiktokDirectPostMetadata,
  tiktokProcessingExpired,
  type TikTokFailureKey,
  type TikTokProviderStatus,
} from "./publishing";

export interface TikTokFlowItem {
  id: string;
  ownerUserId: string;
  draftId: string;
  /** The queue row's own status — `provider_processing` is itself the
   *  worker's attestation that every byte is with TikTok. */
  status: string;
  title: string;
  privacyLevel: string | null;
  disableComment: boolean | null;
  disableDuet: boolean | null;
  disableStitch: boolean | null;
  brandContentToggle: boolean | null;
  brandOrganicToggle: boolean | null;
  isAigc: boolean | null;
  attempts: number;
  publishId: string | null;
  uploadUrl: string | null;
  contentLength: number | null;
  bytesSent: number;
  lastAttemptAt: string | null;
  providerPostId: string | null;
}

export type TikTokFlowOutcome = "published" | "retrying" | "failed" | "processing";

export interface TikTokFlowResult {
  outcome: TikTokFlowOutcome;
  code: string;
  message?: string;
  providerPostId?: string | null;
}

export interface TikTokFlowOptions {
  /**
   * Reconciliation hand-off: the row already failed fail-closed and only a
   * read-only status check (plus the guarded re-arm when TikTok itself says
   * the post does not exist) is allowed. No upload resume, no re-init.
   */
  forceEvidenceOnly?: boolean;
}

interface LoadedAsset {
  status: string;
  mimeType: string;
  byteSize: number | null;
  storagePath: string | null;
}

export interface TikTokFlowPorts {
  loadDraft(ownerId: string, draftId: string): Promise<{ status: string } | null>;
  loadConnection(ownerId: string): Promise<{ status: string; scopes: string[] } | null>;
  loadCredentials(ownerId: string): Promise<{ openId: string; accessToken: string }>;
  loadAsset(ownerId: string, draftId: string): Promise<LoadedAsset | null>;
  openMediaRange(storagePath: string, start: number, end: number): Promise<ReadableStream<Uint8Array> | Uint8Array | null>;
  queryCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo>;
  initDirectPost(
    accessToken: string,
    metadata: Record<string, unknown>,
    sourceInfo: { videoSize: number; chunkSize: number; totalChunkCount: number }
  ): Promise<{ publishId: string; uploadUrl: string }>;
  putChunk(input: {
    uploadUrl: string;
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentType: string;
    contentRange: string;
    contentLength: number;
  }): Promise<ChunkUploadResult>;
  fetchPostStatus(accessToken: string, publishId: string): Promise<TikTokPostStatus>;
  persistPublish(item: TikTokFlowItem, publishId: string, uploadUrl: string, contentLength: number): Promise<void>;
  persistProgress(item: TikTokFlowItem, bytesSent: number): Promise<void>;
  recordProviderStatus(
    item: TikTokFlowItem,
    input: { providerStatus: TikTokProviderStatus; providerPostId: string | null; failReason: string | null; checkedAt: number }
  ): Promise<void>;
  /** All bytes are with TikTok: the row is now provider-owned. */
  enterProviderProcessing(item: TikTokFlowItem): Promise<void>;
  markPublished(item: TikTokFlowItem, providerPostId: string | null, note: string | null): Promise<void>;
  markFailed(
    item: TikTokFlowItem,
    input: { code: string; message: string; status: string; retryAt: number | null; resetAttempts?: boolean }
  ): Promise<void>;
  /** Guarded re-arm: TikTok attested the persisted id does not exist. */
  reArmForResubmit(item: TikTokFlowItem): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Wall-clock budget for the whole invocation; unlimited when omitted. */
  remainingBudgetMs?(): number;
  /** UI wording only — the provider is the source of truth. */
  appAudited?: boolean;
}

/** Evidence polling while one claim is active: ~2 minutes per claim. */
const EVIDENCE_POLL_DELAY_MS = 10_000;
const MAX_EVIDENCE_POLLS = 12;

function apiErrorOf(err: unknown): TikTokApiError | null {
  return err instanceof TikTokApiError ? err : null;
}

function unauditedPrivacyNote(privacy: string | null, appAudited: boolean): string | null {
  if (appAudited) return null;
  if (privacy === "SELF_ONLY") {
    return "Visible only to you — unaudited TikTok projects must post privately. Your account stays private.";
  }
  return "Unaudited TikTok projects must post privately. TikTok accepted the post as declared; keep your account private, or make it public yourself later if you want wider reach.";
}

function privacyLabel(value: string | null): string {
  const options = TIKTOK_PRIVACY_VALUES as readonly string[];
  if (value && options.includes(value)) {
    return TIKTOK_PRIVACY_LABELS[value as (typeof TIKTOK_PRIVACY_VALUES)[number]];
  }
  return value ?? "a privacy choice";
}

export async function runTikTokPublishFlow(
  item: TikTokFlowItem,
  ports: TikTokFlowPorts,
  options: TikTokFlowOptions = {}
): Promise<TikTokFlowResult> {
  const hasId = Boolean(item.publishId && isRealTikTokPublishId(item.publishId));
  const transferComplete = hasId && item.contentLength !== null && item.bytesSent >= item.contentLength;

  // Phase A: the provider owns this post. Only the official post-status
  // endpoint may move it — read-only, never a re-init. A row the worker
  // moved to `provider_processing` IS that attestation (it is only written
  // after the final chunk acknowledged), so it polls for evidence even if
  // the byte bookkeeping lags behind.
  const providerOwned = hasId && (transferComplete || item.status === "provider_processing");
  if (options.forceEvidenceOnly || providerOwned) {
    return collectProviderEvidence(item, ports, { canReArm: Boolean(options.forceEvidenceOnly) });
  }

  const budgetLeft = (): number =>
    ports.remainingBudgetMs ? Math.max(0, ports.remainingBudgetMs()) : Number.MAX_SAFE_INTEGER;

  // Retry exhaustion: resolveTikTokFailure turns a retryable failure into a
  // truthful terminal failure once the worker has spent all its attempts.
  const fail = async (key: string, message: string): Promise<TikTokFlowResult> => {
    const resolved = resolveTikTokFailure(key as TikTokFailureKey, item.attempts);
    const retryAt = resolved.retryable
      ? nextTikTokCronBoundaryAfter(ports.now(), TIKTOK_WORKER_PERIOD_MS)
      : null;
    await ports
      .markFailed(item, {
        code: resolved.code,
        message,
        status: resolved.status,
        retryAt,
      })
      .catch(() => {});
    return { outcome: retryAt ? "retrying" : "failed", code: resolved.code, message };
  };

  // 1. Re-verify the approval is still current.
  let draft: { status: string } | null;
  try {
    draft = await ports.loadDraft(item.ownerUserId, item.draftId);
  } catch {
    draft = null;
  }
  if (!draft) return fail("draft_unavailable", "The approved draft no longer exists");
  if (draft.status !== "approved") return fail("not_approved", "The draft is no longer approved");

  // 2. The connection and its scopes are authoritative.
  let connection: { status: string; scopes: string[] } | null;
  try {
    connection = await ports.loadConnection(item.ownerUserId);
  } catch {
    connection = null;
  }
  if (!connection || connection.status !== "connected") return fail("not_connected", "Connect TikTok to publish");
  if (!hasPublishPermission(connection.scopes)) return fail("permission_required", "The connected TikTok account is missing the video.publish permission");

  let credentials: { openId: string; accessToken: string };
  try {
    credentials = await ports.loadCredentials(item.ownerUserId);
  } catch {
    return fail("not_connected", "TikTok credentials are unavailable");
  }

  // 4. The media must be a finished, publishable video within the limits.
  let asset: LoadedAsset | null;
  try {
    asset = await ports.loadAsset(item.ownerUserId, item.draftId);
  } catch {
    asset = null;
  }
  if (!asset || asset.status !== "uploaded" || !asset.storagePath) return fail("media_missing", "The video is not finished yet");
  if (!asset.byteSize || asset.byteSize <= 0 || asset.byteSize > TIKTOK_MAX_VIDEO_BYTES) return fail("media_too_large", "The video is larger than TikTok allows (4 GB)");
  if (!isTikTokPublishableMime(asset.mimeType)) return fail("media_unsupported", `TikTok accepts MP4, WebM, or MOV videos, not ${asset.mimeType || "this file"}`);

  // Resume guard: the upload task holds the file that was active at init
  // time. If the stored media changed afterwards, resuming with the new
  // bytes would corrupt the post — fail closed and let reconciliation read
  // what TikTok actually has.
  if (hasId) {
    if (item.contentLength === null || asset.byteSize !== item.contentLength) {
      return fail("publish_ambiguous", "The stored video changed after the post was started — TikTok's post status will be checked before anything is retried");
    }
    if (!item.uploadUrl) return fail("publish_ambiguous", "The upload task is missing its resume URL — TikTok's post status will be checked");
  }

  let uploadUrl: string;
  let plan;
  if (hasId) {
    // Resume the SAME post from the persisted state.
    uploadUrl = item.uploadUrl as string;
    plan = tiktokChunkPlan(asset.byteSize);
    if (!plan) return fail("media_too_large", "The video is larger than TikTok allows (4 GB)");
  } else {
    // 3. TikTok requires an explicit privacy choice — Voom never guesses one.
    if (!isTikTokPrivacy(item.privacyLevel)) {
      return fail("needs_declaration", `Choose how the post is shared — TikTok has no default privacy level`);
    }

    // 5. CREATOR INFO is required before EVERY post, and the user's privacy
    //    choice must be one of the options TikTok returned live for this
    //    account. Unaudited clients may be refused again at init — the
    //    provider is the source of truth (no audit override exists).
    let creator: TikTokCreatorInfo;
    try {
      creator = await ports.queryCreatorInfo(credentials.accessToken);
    } catch (err) {
      const api = apiErrorOf(err);
      if (api && api.kind === "auth") return fail("authorization_revoked", "TikTok revoked the connection");
      if (api && api.kind === "rate_limited") return fail("rate_limited", "TikTok is rate limiting creator info queries");
      return fail("post_init_failed", "Could not reach TikTok for the required creator info");
    }
    if (!creator.privacyLevelOptions.includes(item.privacyLevel as (typeof TIKTOK_PRIVACY_VALUES)[number])) {
      return fail("privacy_not_allowed", `TikTok no longer offers "${privacyLabel(item.privacyLevel)}" for this account — pick one of the options TikTok allows`);
    }

    plan = tiktokChunkPlan(asset.byteSize);
    if (!plan) return fail("media_too_large", "The video is larger than TikTok allows (4 GB)");

    // 6. Init Direct Post. The publish id is PERSISTED before any byte goes
    //    over the wire, so an ambiguous outcome can always be recovered
    //    read-only through the post-status endpoint.
    const metadata = tiktokDirectPostMetadata({
      title: item.title,
      privacy: item.privacyLevel as (typeof TIKTOK_PRIVACY_VALUES)[number],
      disableComment: item.disableComment,
      disableDuet: item.disableDuet,
      disableStitch: item.disableStitch,
      brandContentToggle: item.brandContentToggle,
      brandOrganicToggle: item.brandOrganicToggle,
      isAigc: item.isAigc,
    });
    let started: { publishId: string; uploadUrl: string };
    try {
      started = await ports.initDirectPost(credentials.accessToken, metadata, {
        videoSize: asset.byteSize,
        chunkSize: plan.chunkSize,
        totalChunkCount: plan.totalChunkCount,
      });
    } catch (err) {
      const api = apiErrorOf(err);
      if (api && api.kind === "auth") return fail("authorization_revoked", "TikTok revoked the connection");
      if (api && api.kind === "rate_limited") return fail("rate_limited", "TikTok is rate limiting post init");
      if (api && api.reason === "unaudited_client_can_only_post_to_private_accounts") {
        return fail("unaudited_client_restricted", "TikTok refused this privacy choice: until the app passes TikTok's content-sharing audit, posts through it are restricted to private (Only me) visibility. Re-choose 'Only me (private)' to publish privately, or complete the audit for other options.");
      }
      if (api && api.reason === "privacy_level_option_mismatch") {
        return fail("privacy_not_allowed", `TikTok rejected "${privacyLabel(item.privacyLevel)}" for this account — pick one of the options TikTok allows`);
      }
      return fail("post_init_failed", `TikTok rejected the post start${api && api.reason ? `: ${api.reason}` : ""}`);
    }
    await ports
      .persistPublish(item, started.publishId, started.uploadUrl, asset.byteSize)
      .catch(() => {});
    uploadUrl = started.uploadUrl;
    item = { ...item, publishId: started.publishId, contentLength: asset.byteSize, bytesSent: 0, uploadUrl: started.uploadUrl };
  }

  // 7. Sequential chunk transfer. Resume from the persisted offset (chunk
  //    boundary aligned); a 416 range mismatch tells us TikTok's actual
  //    progress and we re-sync; a 404 means the upload task is gone and the
  //    result is AMBIGUOUS — fail closed, reconciliation reads the status.
  let offset = hasId ? Math.min(Math.max(0, Math.floor(item.bytesSent)), asset.byteSize) : 0;
  const totalSize = asset.byteSize;
  while (offset < totalSize) {
    if (budgetLeft() < TIKTOK_API_CALL_ALLOWANCE_MS) {
      return fail("upload_interrupted", `Paused after ${offset} of ${totalSize} bytes; the next claim resumes where it left off`);
    }
    const index = Math.floor(offset / plan.chunkSize);
    const window = tiktokChunkWindow(plan, totalSize, index);
    if (!window) return fail("upload_interrupted", "Could not compute the next chunk window");
    const range = tiktokContentRangeFor(window, totalSize);
    let body: ReadableStream<Uint8Array> | Uint8Array | null;
    try {
      body = await ports.openMediaRange(asset.storagePath as string, window.start, window.end);
    } catch {
      body = null;
    }
    if (!body) {
      return fail("media_url_failed", "Could not open the stored video");
    }
    let result: ChunkUploadResult;
    try {
      result = await ports.putChunk({
        uploadUrl,
        body,
        contentType: asset.mimeType,
        contentRange: range,
        contentLength: window.end - window.start + 1,
      });
    } catch (err) {
      const api = apiErrorOf(err);
      if (api && api.kind === "not_found") {
        return fail("upload_task_gone", "TikTok's upload task disappeared mid-upload. Voom stopped instead of risking a duplicate post; reconciliation verifies the post status read-only.");
      }
      if (api && api.kind === "auth") return fail("authorization_revoked", "TikTok revoked the connection");
      if (api && api.kind === "rate_limited") return fail("rate_limited", "TikTok is rate limiting the upload");
      return fail("upload_interrupted", `The upload was interrupted${api && api.reason ? `: ${api.reason}` : ""}`);
    }
    if (result.outcome === "complete") {
      const done = Math.min(totalSize, Math.max(offset, result.uploadedBytes ?? window.end + 1));
      if (done > offset) await ports.persistProgress(item, done).catch(() => {});
      offset = done;
      continue;
    }
    if (result.outcome === "range_mismatch") {
      const actual = Math.min(totalSize, result.uploadedBytes ?? 0);
      if (actual <= offset) {
        // TikTok's progress did not advance past our window: parking lets
        // the next claim retry (its progress may snap to a later boundary).
        return fail("upload_interrupted", `TikTok reports progress at ${actual} bytes but expected ${window.start}`);
      }
      await ports.persistProgress(item, actual).catch(() => {});
      offset = actual;
      continue;
    }
    // putChunk throws on 404, so "gone" as a result is a safety net:
    return fail("upload_task_gone", "TikTok's upload task disappeared mid-upload. Voom stopped instead of risking a duplicate post; reconciliation verifies the post status read-only.");
  }

  // 8. Every byte is with TikTok — the provider owns the row now.
  await ports.enterProviderProcessing(item).catch(() => {});
  return collectProviderEvidence(item, ports, { canReArm: false });
}

/**
 * Read-only evidence collection through the OFFICIAL post-status endpoint.
 * Never re-inits, never fabricates: PROCESSING_* keeps the row in provider
 * processing, FAILED is a truthful terminal failure, and only
 * PUBLISH_COMPLETE publishes (with the provider's post id when TikTok
 * eventually surfaces one). When TikTok itself answers that the persisted
 * id does not exist (invalid_publish_id) on a hand-off row, the guarded
 * re-arm clears it — that answer IS the no-duplicate attestation.
 */
async function collectProviderEvidence(
  item: TikTokFlowItem,
  ports: TikTokFlowPorts,
  { canReArm }: { canReArm: boolean }
): Promise<TikTokFlowResult> {
  let credentials: { openId: string; accessToken: string };
  try {
    credentials = await ports.loadCredentials(item.ownerUserId);
  } catch {
    await ports
      .markFailed(item, { code: "tiktok_not_connected", message: "TikTok credentials are unavailable", status: "failed", retryAt: null })
      .catch(() => {});
    return { outcome: "failed", code: "tiktok_not_connected", message: "TikTok credentials are unavailable" };
  }
  const publishId = item.publishId as string;
  for (let poll = 0; poll < MAX_EVIDENCE_POLLS; poll++) {
    if (poll > 0) {
      const budgetLeft = ports.remainingBudgetMs ? Math.max(0, ports.remainingBudgetMs()) : Number.MAX_SAFE_INTEGER;
      if (budgetLeft < TIKTOK_API_CALL_ALLOWANCE_MS) return { outcome: "processing", code: "provider_processing" };
      await ports.sleep(EVIDENCE_POLL_DELAY_MS);
    }
    let status: TikTokPostStatus;
    try {
      status = await ports.fetchPostStatus(credentials.accessToken, publishId);
    } catch (err) {
      const api = apiErrorOf(err);
      if (api && api.kind === "not_found") {
        // TikTok does not recognize the id: the post does not exist.
        if (canReArm) {
          await ports.reArmForResubmit(item).catch(() => {});
          return { outcome: "failed", code: "post_unavailable", message: "TikTok confirmed the post does not exist; the item was re-armed for a fresh submission" };
        }
        await ports
          .markFailed(item, { code: "post_unavailable", message: "TikTok does not recognize this post; it will be checked again", status: "failed", retryAt: null })
          .catch(() => {});
        return { outcome: "failed", code: "post_unavailable" };
      }
      if (api && api.kind === "auth") {
        await ports
          .markFailed(item, { code: "authorization_revoked", message: "TikTok revoked the connection", status: "permission_required", retryAt: null })
          .catch(() => {});
        return { outcome: "failed", code: "authorization_revoked" };
      }
      if (api && api.kind === "rate_limited") {
        return { outcome: "retrying", code: "rate_limited", message: "TikTok is rate limiting status checks; the next claim retries" };
      }
      // Transient read failure: leave the row untouched (no claim consumed).
      return { outcome: "retrying", code: "evidence_read_failed", message: "Could not read the TikTok post status; the next claim retries" };
    }
    await ports
      .recordProviderStatus(item, {
        providerStatus: status.status as TikTokProviderStatus,
        providerPostId: status.postIds[0] ?? null,
        failReason: status.failReason,
        checkedAt: ports.now(),
      })
      .catch(() => {});
    if (status.status === "PUBLISH_COMPLETE") {
      const postIds = status.postIds;
      const note = unauditedPrivacyNote(item.privacyLevel, ports.appAudited ?? false);
      await ports.markPublished(item, postIds[0] ?? null, note).catch(() => {});
      return { outcome: "published", code: "PUBLISH_COMPLETE", providerPostId: postIds[0] ?? null };
    }
    if (status.status === "FAILED") {
      const reason = status.failReason ?? "";
      const looksLikeCap = /limit|exceed|cap|frequency|quota/i.test(reason);
      const message = looksLikeCap
        ? `TikTok stopped the post (posting limit): ${reason || "no reason given"}`
        : `TikTok rejected the post: ${reason || "no reason given"}`;
      await ports
        .markFailed(item, { code: looksLikeCap ? "posting_cap_reached" : "provider_rejected", message, status: "failed", retryAt: null })
        .catch(() => {});
      return { outcome: "failed", code: looksLikeCap ? "posting_cap_reached" : "provider_rejected", message };
    }
    if (tiktokProcessingExpired(item.lastAttemptAt, ports.now())) {
      await ports
        .markFailed(item, { code: "processing_timeout", message: "TikTok has not finished this post within Voom's polling window. The publish id is recorded; reconciliation keeps checking.", status: "failed", retryAt: null })
        .catch(() => {});
      return { outcome: "failed", code: "processing_timeout" };
    }
  }
  return { outcome: "processing", code: "provider_processing" };
}
