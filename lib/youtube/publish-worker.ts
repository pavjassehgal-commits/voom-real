import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { YouTubeClient } from "./client.ts";
import { readYouTubeConfig, youTubeKeyRing, type YouTubeConfig } from "./config.ts";
import { getYouTubeServerCredentials } from "./data.ts";
import { runYouTubePublishFlow, type YouTubeFlowItem, type YouTubeFlowPorts } from "./publish-flow.ts";
import {
  claimDueYouTubeUploads,
  completeYouTubePublishJob,
  failYouTubePublishJob,
  recordYouTubeUploadProgress,
  recordYouTubeUploadSession,
  recordYouTubeVideoId,
  type YouTubeQueueRow,
} from "./publish-queue.ts";
import { YOUTUBE_UPLOAD_BUDGET_MS, YOUTUBE_SIGNED_URL_TTL_SECONDS } from "./publishing.ts";

const ASSET_BUCKET = "mara-media";

export interface YouTubePublishRunResult {
  claimed: number;
  published: number;
  processing: number;
  failed: number;
  retrying: number;
  skipped: number;
  results: { id: string; outcome: string; code?: string }[];
}

export interface YouTubeWorkerDeps {
  db?: SupabaseClient;
  config?: YouTubeConfig | null;
  clientFor?: (config: YouTubeConfig) => YouTubeClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limit?: number;
  /** Wall-clock upload/polling budget for the whole invocation. */
  pollingBudgetMs?: number;
  /** Structured diagnostics sink. Never receives tokens or session URLs' query secrets. */
  timeline?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * The scheduled YouTube publishing worker (upload phase).
 *
 * Every due item is claimed atomically inside PostgreSQL (`for update skip
 * locked`) before any Google call happens, so a duplicate cron run, a retry
 * or a redeploy can never produce a second YouTube video. `published` is
 * written only by complete_youtube_publish_job, which the database itself
 * restricts to a real video id plus YouTube's own uploadStatus='processed'.
 *
 * Large videos never buffer in the function: bytes stream from the private
 * storage object (HTTP Range reads against a short-lived signed URL)
 * straight into Google's resumable session in 8 MiB chunks, and the session
 * URL is persisted before the first byte so an interrupted upload resumes
 * instead of restarting.
 */
export async function runYouTubePublishing(deps: YouTubeWorkerDeps = {}): Promise<YouTubePublishRunResult> {
  const db = deps.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  const config = deps.config !== undefined ? deps.config : readYouTubeConfig();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeline = deps.timeline ?? (() => undefined);
  const result: YouTubePublishRunResult = { claimed: 0, published: 0, processing: 0, failed: 0, retrying: 0, skipped: 0, results: [] };

  if (!config) {
    // Nothing is claimed when YouTube is not configured, so a misconfigured
    // deployment can never burn a scheduled item's attempts.
    result.skipped += 1;
    result.results.push({ id: "-", outcome: "skipped", code: "youtube_not_configured" });
    return result;
  }

  const startedAt = now().getTime();
  const budgetMs = deps.pollingBudgetMs ?? YOUTUBE_UPLOAD_BUDGET_MS;
  const deadlineAt = startedAt + budgetMs;
  const remainingBudgetMs = () => deadlineAt - Date.now();

  const items = await claimDueYouTubeUploads(db, deps.limit ?? 5, now());
  result.claimed = items.length;
  timeline("youtube_run_started", { claimed: items.length, budgetMs });

  const client = (deps.clientFor ?? ((value: YouTubeConfig) => new YouTubeClient(value)))(config);
  const keyRing = youTubeKeyRing(config);
  // One signed URL per storage object per invocation (TTL is an hour; the
  // function ceiling is five minutes).
  const signedUrls = new Map<string, string>();

  for (const row of items) {
    const item = toYouTubeFlowItem(row);
    timeline("youtube_claimed", { itemId: row.id, ownerUserId: row.owner_user_id, draftId: row.draft_id, format: row.youtube_format, attempt: row.attempts });
    const ports = buildYouTubeFlowPorts(db, client, keyRing, config, sleep, signedUrls, { remainingBudgetMs, timeline });
    try {
      const outcome = await runYouTubePublishFlow(item, ports);
      if (outcome.outcome === "published") result.published += 1;
      else if (outcome.outcome === "processing") result.processing += 1;
      else if (outcome.outcome === "retrying") result.retrying += 1;
      else result.failed += 1;
      result.results.push({ id: row.id, outcome: outcome.outcome, code: "code" in outcome ? outcome.code : undefined });
      timeline("youtube_item_done", { itemId: row.id, outcome: outcome.outcome, code: "code" in outcome ? outcome.code : undefined });
    } catch {
      await failYouTubePublishJob(db, row.id, row.owner_user_id, {
        code: "youtube_publish_unknown_error",
        message: "YouTube publishing did not complete. Please review this item.",
        status: "failed",
      }).catch(() => undefined);
      result.failed += 1;
      result.results.push({ id: row.id, outcome: "failed", code: "youtube_publish_unknown_error" });
    }
  }
  return result;
}

export function toYouTubeFlowItem(row: YouTubeQueueRow): YouTubeFlowItem {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    draftId: row.draft_id,
    format: row.youtube_format,
    title: row.title,
    description: row.description ?? "",
    privacyStatus: row.privacy_status,
    madeForKids: row.made_for_kids,
    categoryId: row.category_id ?? "22",
    attempts: row.attempts,
    sessionUrl: row.upload_session_url,
    contentLength: row.upload_content_length === null || row.upload_content_length === undefined ? null : Number(row.upload_content_length),
    bytesSent: Number(row.upload_bytes_sent ?? 0),
    videoId: row.youtube_video_id,
    lastAttemptAt: row.last_attempt_at,
  };
}

export function buildYouTubeFlowPorts(
  db: SupabaseClient,
  client: YouTubeClient,
  keyRing: ReturnType<typeof youTubeKeyRing>,
  config: YouTubeConfig,
  sleep: (ms: number) => Promise<void>,
  signedUrls: Map<string, string>,
  options: {
    remainingBudgetMs?: () => number;
    timeline?: (event: string, detail?: Record<string, unknown>) => void;
  } = {},
): YouTubeFlowPorts {
  const remainingBudgetMs = options.remainingBudgetMs;

  async function signedUrlFor(storagePath: string): Promise<string | null> {
    const cached = signedUrls.get(storagePath);
    if (cached) return cached;
    const { data } = await db.storage.from(ASSET_BUCKET).createSignedUrl(storagePath, YOUTUBE_SIGNED_URL_TTL_SECONDS);
    if (!data?.signedUrl) return null;
    signedUrls.set(storagePath, data.signedUrl);
    return data.signedUrl;
  }

  return {
    async loadDraft(ownerId, draftId) {
      const { data } = await db.from("mara_drafts").select("status")
        .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
      return data ? { status: String(data.status ?? "") } : null;
    },
    async loadConnection(ownerId) {
      const { data } = await db.from("youtube_connections").select("status,scopes")
        .eq("owner_user_id", ownerId).maybeSingle();
      if (!data) return null;
      return {
        status: String(data.status ?? ""),
        scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : [],
      };
    },
    async loadCredentials(ownerId) {
      const credentials = await getYouTubeServerCredentials(db, ownerId, keyRing, client);
      return { channelId: credentials.channelId, accessToken: credentials.accessToken, uploadsPlaylistId: null };
    },
    async loadAsset(ownerId, draftId) {
      const { data } = await db.from("post_draft_assets").select("storage_path,mime_type,status,byte_size")
        .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
      if (!data || typeof data.storage_path !== "string") return null;
      const byteSize = data.byte_size === null || data.byte_size === undefined ? null : Number(data.byte_size);
      return {
        storagePath: data.storage_path,
        mimeType: String(data.mime_type ?? ""),
        status: String(data.status ?? ""),
        byteSize: Number.isFinite(byteSize) ? byteSize : null,
      };
    },
    async openMediaRange(storagePath, start, end) {
      // HTTP Range read of the PRIVATE object through a short-lived signed
      // URL, streamed straight through — the function never holds the whole
      // video, only the chunk in flight.
      const url = await signedUrlFor(storagePath);
      if (!url) return null;
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (!response.ok && response.status !== 206) return null;
      return response.body;
    },
    async initiateSession({ accessToken, metadata, contentType, contentLength }) {
      const { sessionUrl } = await client.initiateUploadSession(accessToken, metadata, contentType, contentLength);
      return sessionUrl;
    },
    async putChunk({ sessionUrl, body, contentType, contentRange, contentLength }) {
      return client.uploadChunk(sessionUrl, body, contentType, contentRange, contentLength);
    },
    async querySession(sessionUrl, totalSize) {
      return client.queryUploadStatus(sessionUrl, totalSize);
    },
    async getVideo(accessToken, videoId) {
      const read = await client.getVideo(accessToken, videoId);
      if (!read) return null;
      return {
        videoId: read.videoId,
        uploadStatus: read.uploadStatus,
        privacyStatus: read.privacyStatus,
        rejectionReason: read.rejectionReason,
        failureReason: read.failureReason,
      };
    },
    async listRecentUploads(accessToken, uploadsPlaylistId) {
      // The uploads playlist id is YouTube's own (channels.list
      // contentDetails.relatedPlaylists.uploads); it is resolved read-only at
      // recovery time rather than stored.
      const channel = await client.getMyChannel(accessToken);
      const playlistId = channel.uploadsPlaylistId ?? uploadsPlaylistId;
      if (!playlistId) return [];
      return client.listRecentUploads(accessToken, playlistId, 10);
    },
    async persistSession(item, sessionUrl, contentLength) {
      await recordYouTubeUploadSession(db, item.id, item.ownerUserId, sessionUrl, contentLength);
    },
    async persistProgress(item, bytesSent) {
      await recordYouTubeUploadProgress(db, item.id, item.ownerUserId, bytesSent);
    },
    async recordVideoId(item, videoId, uploadStatus, privacyStatus) {
      await recordYouTubeVideoId(db, item.id, item.ownerUserId, videoId, uploadStatus, privacyStatus);
    },
    async markPublished(item, privacyStatus, note) {
      await completeYouTubePublishJob(db, item.id, item.ownerUserId, { privacyStatus, providerNote: note });
    },
    async markFailed(item, input) {
      await failYouTubePublishJob(db, item.id, item.ownerUserId, input);
    },
    sleep,
    ...(remainingBudgetMs ? { remainingBudgetMs } : {}),
    projectAudited: config.projectAudited,
  };
}
