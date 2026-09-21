import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { YouTubeClient } from "./client.ts";
import { readYouTubeConfig, youTubeKeyRing, type YouTubeConfig } from "./config.ts";
import { getYouTubeServerCredentials } from "./data.ts";
import { findRecoveredUpload, runYouTubePublishFlow, type YouTubeFlowItem, type YouTubeFlowPorts } from "./publish-flow.ts";
import {
  claimYouTubeReconcileJobs,
  listPublishedForVerification,
  recordYouTubeProviderStatus,
  recordYouTubeVideoId,
  failYouTubePublishJob,
  YOUTUBE_QUEUE_COLUMNS,
} from "./publish-queue.ts";
import { buildYouTubeFlowPorts, toYouTubeFlowItem } from "./publish-worker.ts";
import { retryAt, YOUTUBE_UPLOAD_BUDGET_MS } from "./publishing.ts";
import type { YouTubeQueueRow } from "./types.ts";

export interface YouTubeReconcileRunResult {
  claimed: number;
  published: number;
  processing: number;
  failed: number;
  retrying: number;
  verified: number;
  recovered: number;
  skipped: number;
  results: { id: string; outcome: string; code?: string }[];
}

export interface YouTubeReconcileDeps {
  db?: SupabaseClient;
  config?: YouTubeConfig | null;
  clientFor?: (config: YouTubeConfig) => YouTubeClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limit?: number;
  pollingBudgetMs?: number;
  timeline?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * The durable YouTube reconciliation worker.
 *
 * It owns every outcome the provider still owes Voom:
 *
 *   provider_processing   YouTube accepted the bytes and returned a real
 *                         video id, but publication requires YouTube's OWN
 *                         processingDetails.uploadStatus = 'processed'.
 *                         This worker polls that evidence — without
 *                         consuming upload attempts, because waiting for
 *                         the provider is not a failure — and maps
 *                         rejected/failed/deleted onto truthful terminal
 *                         states with Google's own reason recorded.
 *
 *   stale uploading       a worker died mid-upload. The persisted session
 *                         URL is queried (`Content-Range: bytes * /size`):
 *                         partial → resume; completed → record the real
 *                         video id; gone → the READ-ONLY uploads scan
 *                         decides between "completed, recover the id" and
 *                         "never completed, a fresh session is safe".
 *                         An undecided scan FAILS CLOSED (upload_ambiguous)
 *                         — Voom never risks a duplicate video.
 *
 *   ambiguous failures    rows previously parked in upload_ambiguous get
 *                         the same read-only recovery attempt (throttled),
 *                         and only YouTube's own video id can complete them.
 *
 *   published rows        once a day, the video is re-checked read-only:
 *                         deletion, re-privating or a late rejection is
 *                         recorded on the row's provider columns WITHOUT
 *                         rewriting the proven publication fact (the
 *                         database guard forbids that anyway).
 *
 *   revoked authorization an invalid_grant from Google marks the connection
 *                         revoked (inside the credential loader) and stops
 *                         future publishing; historical Voom records and
 *                         the customer's YouTube videos are untouched.
 */
export async function runYouTubeReconciliation(deps: YouTubeReconcileDeps = {}): Promise<YouTubeReconcileRunResult> {
  const db = deps.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  const config = deps.config !== undefined ? deps.config : readYouTubeConfig();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeline = deps.timeline ?? (() => undefined);
  const result: YouTubeReconcileRunResult = { claimed: 0, published: 0, processing: 0, failed: 0, retrying: 0, verified: 0, recovered: 0, skipped: 0, results: [] };

  if (!config) {
    result.skipped += 1;
    result.results.push({ id: "-", outcome: "skipped", code: "youtube_not_configured" });
    return result;
  }

  const startedAt = now().getTime();
  const budgetMs = deps.pollingBudgetMs ?? YOUTUBE_UPLOAD_BUDGET_MS;
  const deadlineAt = startedAt + budgetMs;
  const remainingBudgetMs = () => deadlineAt - Date.now();

  const client = (deps.clientFor ?? ((value: YouTubeConfig) => new YouTubeClient(value)))(config);
  const keyRing = youTubeKeyRing(config);
  const signedUrls = new Map<string, string>();
  const ports = buildYouTubeFlowPorts(db, client, keyRing, config, sleep, signedUrls, { remainingBudgetMs, timeline });

  // 1) Claimed provider-owned work: processing polls and stale uploads.
  const items = await claimYouTubeReconcileJobs(db, deps.limit ?? 10, now());
  result.claimed = items.length;
  for (const row of items) {
    if (remainingBudgetMs() < 5_000) break;
    const item = toYouTubeFlowItem(row);
    try {
      const outcome = await runYouTubePublishFlow(item, ports);
      if (outcome.outcome === "published") result.published += 1;
      else if (outcome.outcome === "processing") result.processing += 1;
      else if (outcome.outcome === "retrying") result.retrying += 1;
      else result.failed += 1;
      result.results.push({ id: row.id, outcome: outcome.outcome, code: "code" in outcome ? outcome.code : undefined });
    } catch {
      await failYouTubePublishJob(db, row.id, row.owner_user_id, {
        code: "youtube_publish_unknown_error",
        message: "YouTube reconciliation did not complete. Please review this item.",
        status: "failed",
      });
      result.failed += 1;
      result.results.push({ id: row.id, outcome: "failed", code: "youtube_publish_unknown_error" });
    }
  }

  // 2) Ambiguous-failure recovery (read-only, throttled to once per hour).
  const ambiguous = await listAmbiguousRows(db, now());
  for (const row of ambiguous) {
    if (remainingBudgetMs() < 5_000) break;
    const recoveredNow = await recoverAmbiguousRow(db, client, keyRing, row, now(), ports);
    if (recoveredNow) result.recovered += 1;
    result.results.push({ id: row.id, outcome: recoveredNow ? "recovered" : "recovery_inconclusive", code: "upload_ambiguous" });
  }

  // 3) Periodic read-only verification of published evidence.
  const publishedRows = await listPublishedForVerification(db, 25, now());
  for (const row of publishedRows) {
    if (remainingBudgetMs() < 5_000) break;
    const verified = await verifyPublishedRow(db, client, keyRing, row, now(), timeline);
    if (verified) result.verified += 1;
  }

  return result;
}

async function listAmbiguousRows(db: SupabaseClient, now: Date): Promise<YouTubeQueueRow[]> {
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const { data } = await db.from("youtube_publish_queue").select(YOUTUBE_QUEUE_COLUMNS)
    .eq("status", "failed")
    .eq("failure_code", "upload_ambiguous")
    .is("youtube_video_id", null)
    .or(`last_provider_check_at.is.null,last_provider_check_at.lt.${hourAgo}`)
    .limit(10);
  return Array.isArray(data) ? (data as YouTubeQueueRow[]) : [];
}

/**
 * One read-only recovery attempt for an ambiguous row: if YouTube's own
 * uploads list contains this item's video (exact title, published no earlier
 * than the attempt window), the real id is recorded and the evidence phase
 * decides publication. Otherwise the row is re-armed for a fresh upload —
 * the scan proved no video exists, so a new session cannot duplicate one.
 * An inconclusive scan leaves the row failed-closed and tries again later.
 */
async function recoverAmbiguousRow(
  db: SupabaseClient,
  client: YouTubeClient,
  keyRing: ReturnType<typeof youTubeKeyRing>,
  row: YouTubeQueueRow,
  now: Date,
  ports: YouTubeFlowPorts,
): Promise<boolean> {
  let credentials: { accessToken: string };
  try {
    credentials = await getYouTubeServerCredentials(db, row.owner_user_id, keyRing, client);
  } catch {
    return false;
  }
  let channel;
  try {
    channel = await client.getMyChannel(credentials.accessToken);
  } catch {
    return false;
  }
  try {
    await db.rpc("record_youtube_provider_status", {
      p_id: row.id, p_owner_user_id: row.owner_user_id,
      p_provider_upload_status: null, p_provider_privacy_status: null, p_provider_note: null,
      p_last_provider_check_at: now.toISOString(),
    });
  } catch { /* throttling bookkeeping is best effort */ }

  if (!channel.uploadsPlaylistId) return false;
  let uploads;
  try {
    uploads = await client.listRecentUploads(credentials.accessToken, channel.uploadsPlaylistId, 15);
  } catch {
    return false;
  }
  const match = findRecoveredUpload(uploads, row.title, row.last_attempt_at);
  if (match) {
    await recordYouTubeVideoId(db, row.id, row.owner_user_id, match, "uploaded", row.privacy_status);
    const item: YouTubeFlowItem = { ...toYouTubeFlowItem(row), videoId: match, lastAttemptAt: now.toISOString() };
    const outcome = await runYouTubePublishFlow(item, ports);
    return outcome.outcome === "published" || outcome.outcome === "processing";
  }
  // Proven: no video was created. Clear the dead session and re-arm the row
  // for a fresh upload attempt through the normal worker.
  try {
    await db.rpc("record_youtube_upload_session", {
      p_id: row.id, p_owner_user_id: row.owner_user_id, p_session_url: null, p_content_length: null,
    });
  } catch { /* the fail-record below is the authoritative re-arm */ }
  await failYouTubePublishJob(db, row.id, row.owner_user_id, {
    code: "session_reset_after_verification",
    message: "Voom verified read-only that no video was created, so the upload will start again cleanly.",
    status: "scheduled",
    retryAt: retryAt(now.getTime()),
  });
  return false;
}

/** Read-only daily re-check of a published row's provider evidence. */
async function verifyPublishedRow(
  db: SupabaseClient,
  client: YouTubeClient,
  keyRing: ReturnType<typeof youTubeKeyRing>,
  row: YouTubeQueueRow,
  now: Date,
  timeline: (event: string, detail?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!row.youtube_video_id) return false;
  let credentials: { accessToken: string };
  try {
    credentials = await getYouTubeServerCredentials(db, row.owner_user_id, keyRing, client);
  } catch {
    // A revoked/expired connection stops verification truthfully; it never
    // rewrites the publication fact.
    timeline("youtube_verify_skipped", { itemId: row.id, reason: "connection_unavailable" });
    return false;
  }
  let read;
  try {
    read = await client.getVideo(credentials.accessToken, row.youtube_video_id);
  } catch {
    timeline("youtube_verify_skipped", { itemId: row.id, reason: "provider_read_failed" });
    return false;
  }
  if (!read) {
    // The video is no longer visible to its own channel token: deleted on
    // YouTube. The publication fact stays; the provider state is recorded.
    await recordYouTubeProviderStatus(db, row.id, row.owner_user_id, {
      uploadStatus: "deleted",
      note: "YouTube no longer returns this video for the connected channel; it may have been deleted on YouTube.",
      checkedAt: now.toISOString(),
    });
    return true;
  }
  await recordYouTubeProviderStatus(db, row.id, row.owner_user_id, {
    uploadStatus: read.uploadStatus,
    privacyStatus: read.privacyStatus,
    note: read.uploadStatus === "rejected" && read.rejectionReason
      ? `YouTube reports this video rejected (${read.rejectionReason}).`
      : null,
    checkedAt: now.toISOString(),
  });
  return true;
}
