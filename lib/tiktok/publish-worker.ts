import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { TikTokClient } from "./client.ts";
import { readTikTokConfig, tikTokKeyRing, type TikTokConfig } from "./config.ts";
import { getTikTokServerCredentials } from "./data.ts";
import { runTikTokPublishFlow, type TikTokFlowItem, type TikTokFlowPorts } from "./publish-flow.ts";
import {
  claimDueTikTokPosts,
  completeTikTokPublishJob,
  failTikTokPublishJob,
  recordTikTokProviderStatus,
  recordTikTokPublish,
  recordTikTokUploadProgress,
  resetTikTokPublishForResubmit,
  setTikTokProviderProcessing,
  type TikTokQueueRow,
} from "./publish-queue.ts";
import {
  TIKTOK_UPLOAD_BUDGET_MS,
  TIKTOK_SIGNED_URL_TTL_SECONDS,
} from "./publishing.ts";

const ASSET_BUCKET = "mara-media";

export interface TikTokPublishRunResult {
  claimed: number;
  published: number;
  processing: number;
  failed: number;
  retrying: number;
  skipped: number;
  results: { id: string; outcome: string; code?: string }[];
}

export interface TikTokWorkerDeps {
  db?: SupabaseClient;
  config?: TikTokConfig | null;
  clientFor?: (config: TikTokConfig) => TikTokClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limit?: number;
  /** Wall-clock upload/polling budget for the whole invocation. */
  budgetMs?: number;
  /** Structured diagnostics sink. Never receives tokens or upload URLs. */
  timeline?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * The scheduled TikTok publishing worker (posting phase).
 *
 * Every due item is claimed atomically inside PostgreSQL (`for update skip
 * locked`) before any TikTok call happens, so a duplicate cron run, a retry
 * or a redeploy can never produce a second post. `published` is written
 * only by complete_tiktok_publish_job, which the database itself restricts
 * to a persisted publish id plus TikTok's own PUBLISH_COMPLETE status.
 *
 * Videos never buffer in the function: bytes stream from the private
 * storage object (HTTP Range reads against a short-lived signed URL)
 * straight into TikTok's upload task with the documented sequential
 * Content-Range chunks, and the publish id + byte progress are persisted
 * before / during the transfer so an interrupted upload resumes instead of
 * restarting (and can never initialize a second post).
 */
export async function runTikTokPublishing(deps: TikTokWorkerDeps = {}): Promise<TikTokPublishRunResult> {
  const db = deps.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  const config = deps.config !== undefined ? deps.config : readTikTokConfig();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeline = deps.timeline ?? (() => undefined);
  const result: TikTokPublishRunResult = { claimed: 0, published: 0, processing: 0, failed: 0, retrying: 0, skipped: 0, results: [] };

  if (!config) {
    // Nothing is claimed when TikTok is not configured, so a misconfigured
    // deployment can never burn a scheduled item's attempts.
    result.skipped += 1;
    result.results.push({ id: "-", outcome: "skipped", code: "tiktok_not_configured" });
    return result;
  }

  const startedAt = now().getTime();
  const budgetMs = deps.budgetMs ?? TIKTOK_UPLOAD_BUDGET_MS;
  const deadlineAt = startedAt + budgetMs;
  const remainingBudgetMs = () => deadlineAt - Date.now();

  const items = await claimDueTikTokPosts(db, deps.limit ?? 5, now());
  result.claimed = items.length;
  timeline("tiktok_run_started", { claimed: items.length, budgetMs });

  const client = (deps.clientFor ?? ((value: TikTokConfig) => new TikTokClient(value)))(config);
  const keyRing = tikTokKeyRing(config);
  // One signed URL per storage object per invocation (TTL is an hour; the
  // function ceiling is five minutes).
  const signedUrls = new Map<string, string>();

  for (const row of items) {
    const item = toTikTokFlowItem(row);
    timeline("tiktok_claimed", { itemId: row.id, ownerUserId: row.owner_user_id, draftId: row.draft_id, attempt: row.attempts, hasPublishId: Boolean(row.tiktok_publish_id) });
    const ports = buildTikTokFlowPorts(db, client, keyRing, config, sleep, signedUrls, { remainingBudgetMs, timeline });
    try {
      const outcome = await runTikTokPublishFlow(item, ports);
      if (outcome.outcome === "published") result.published += 1;
      else if (outcome.outcome === "processing") result.processing += 1;
      else if (outcome.outcome === "retrying") result.retrying += 1;
      else result.failed += 1;
      result.results.push({ id: row.id, outcome: outcome.outcome, code: outcome.code });
      timeline("tiktok_item_done", { itemId: row.id, outcome: outcome.outcome, code: outcome.code });
    } catch {
      await failTikTokPublishJob(db, row.id, row.owner_user_id, {
        code: "tiktok_publish_unknown_error",
        message: "TikTok publishing did not complete. Please review this item.",
        status: "failed",
      }).catch(() => undefined);
      result.failed += 1;
      result.results.push({ id: row.id, outcome: "failed", code: "tiktok_publish_unknown_error" });
    }
  }
  return result;
}

export function toTikTokFlowItem(row: TikTokQueueRow): TikTokFlowItem {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    draftId: row.draft_id,
    status: row.status,
    title: row.title,
    privacyLevel: row.privacy_level,
    disableComment: row.disable_comment,
    disableDuet: row.disable_duet,
    disableStitch: row.disable_stitch,
    brandContentToggle: row.brand_content_toggle,
    brandOrganicToggle: row.brand_organic_toggle,
    isAigc: row.is_aigc,
    attempts: Number(row.attempts ?? 0),
    publishId: row.tiktok_publish_id,
    uploadUrl: row.upload_url,
    contentLength: row.upload_content_length === null || row.upload_content_length === undefined ? null : Number(row.upload_content_length),
    bytesSent: Number(row.upload_bytes_sent ?? 0),
    lastAttemptAt: row.last_attempt_at,
    providerPostId: row.provider_post_id,
  };
}

export function buildTikTokFlowPorts(
  db: SupabaseClient,
  client: TikTokClient,
  keyRing: ReturnType<typeof tikTokKeyRing>,
  config: TikTokConfig,
  sleep: (ms: number) => Promise<void>,
  signedUrls: Map<string, string>,
  options: {
    remainingBudgetMs?: () => number;
    timeline?: (event: string, detail?: Record<string, unknown>) => void;
  } = {},
): TikTokFlowPorts {
  const remainingBudgetMs = options.remainingBudgetMs;

  async function signedUrlFor(storagePath: string): Promise<string | null> {
    const cached = signedUrls.get(storagePath);
    if (cached) return cached;
    const { data } = await db.storage.from(ASSET_BUCKET).createSignedUrl(storagePath, TIKTOK_SIGNED_URL_TTL_SECONDS);
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
      const { data } = await db.from("tiktok_connections").select("status,scopes")
        .eq("owner_user_id", ownerId).maybeSingle();
      if (!data) return null;
      return {
        status: String(data.status ?? ""),
        scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : [],
      };
    },
    async loadCredentials(ownerId) {
      const credentials = await getTikTokServerCredentials(db, ownerId, keyRing, client);
      return { openId: credentials.openId, accessToken: credentials.accessToken };
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
    async queryCreatorInfo(accessToken) {
      return client.queryCreatorInfo(accessToken);
    },
    async initDirectPost(accessToken, metadata, sourceInfo) {
      const started = await client.initDirectPost(accessToken, metadata, {
        source: "FILE_UPLOAD",
        video_size: sourceInfo.videoSize,
        chunk_size: sourceInfo.chunkSize,
        total_chunk_count: sourceInfo.totalChunkCount,
      });
      return started;
    },
    async putChunk(input) {
      return client.uploadChunk(input.uploadUrl, input.body, input.contentType, input.contentRange, input.contentLength);
    },
    async fetchPostStatus(accessToken, publishId) {
      return client.fetchPostStatus(accessToken, publishId);
    },
    async persistPublish(item, publishId, uploadUrl, contentLength) {
      await recordTikTokPublish(db, item.id, item.ownerUserId, publishId, uploadUrl, contentLength);
    },
    async persistProgress(item, bytesSent) {
      await recordTikTokUploadProgress(db, item.id, item.ownerUserId, bytesSent);
    },
    async recordProviderStatus(item, input) {
      await recordTikTokProviderStatus(db, item.id, item.ownerUserId, {
        providerStatus: input.providerStatus,
        providerPostId: input.providerPostId,
        failReason: input.failReason,
        checkedAt: new Date(input.checkedAt).toISOString(),
      });
    },
    async enterProviderProcessing(item) {
      await setTikTokProviderProcessing(db, item.id, item.ownerUserId);
    },
    async markPublished(item, providerPostId, note) {
      await completeTikTokPublishJob(db, item.id, item.ownerUserId, {
        providerPostId,
        providerNote: note,
      });
    },
    async markFailed(item, input) {
      await failTikTokPublishJob(db, item.id, item.ownerUserId, {
        code: input.code,
        message: input.message,
        status: input.status,
        retryAt: input.retryAt === null ? null : new Date(input.retryAt).toISOString(),
        resetAttempts: input.resetAttempts,
      });
    },
    async reArmForResubmit(item) {
      await resetTikTokPublishForResubmit(db, item.id, item.ownerUserId);
    },
    sleep,
    now: () => Date.now(),
    ...(remainingBudgetMs ? { remainingBudgetMs } : {}),
    appAudited: config.appAudited,
  };
}
