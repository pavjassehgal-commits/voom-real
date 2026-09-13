import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InstagramClient } from "./client";
import { instagramKeyRing, readInstagramConfig, type InstagramConfig } from "./config";
import { getInstagramServerCredentials } from "./data";
import { runPublishFlow, type FlowItem, type FlowPorts } from "./publish-flow";
import {
  claimDueItems,
  completePublishItem,
  failPublishItem,
  recordContainerId,
  type PublishQueueRow,
} from "./publish-queue";
import {
  logPublishTimeline,
  type PublishTimelineEvent,
  type PublishTimelineInput,
} from "./publish-timeline";
import {
  PUBLISH_POLLING_BUDGET_MS,
  PUBLISH_SIGNED_URL_TTL_SECONDS,
  type PublishState,
} from "./publishing";

const ASSET_BUCKET = "mara-media";

export interface PublishRunResult {
  claimed: number;
  published: number;
  failed: number;
  retrying: number;
  skipped: number;
  results: { id: string; outcome: string; code?: string }[];
}

export interface WorkerDeps {
  db?: SupabaseClient;
  config?: InstagramConfig | null;
  clientFor?: (config: InstagramConfig) => InstagramClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limit?: number;
  /**
   * Wall-clock polling budget for the whole invocation. Defaults to
   * PUBLISH_POLLING_BUDGET_MS, which is derived from the cron route's
   * maxDuration. Shared by every claimed item — it is what stops a batch of
   * slow videos from overrunning the serverless function.
   */
  pollingBudgetMs?: number;
  timeline?: (event: PublishTimelineEvent, input?: PublishTimelineInput) => void;
}

/**
 * The scheduled Instagram auto-publishing worker.
 *
 * Every due item is claimed atomically inside PostgreSQL before any Instagram
 * call happens, so a duplicate cron run, a retry, or a redeploy cannot produce
 * a second Instagram post. `published` is written only with a media id Meta
 * returned from media_publish.
 *
 * TIMING CONTRACT. Items are processed sequentially inside one serverless
 * invocation with a hard runtime ceiling, so readiness polling is bounded by
 * a deadline shared across the whole batch rather than per item. When Meta is
 * still working, the item is parked for the NEXT CRON BOUNDARY (see retryAt in
 * ./publishing.ts) so the following tick claims it — never `now + 5 minutes`,
 * which lands after the tick and costs a whole cadence.
 */
export async function runInstagramPublishing(deps: WorkerDeps = {}): Promise<PublishRunResult> {
  const db = deps.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  const config = deps.config !== undefined ? deps.config : readInstagramConfig();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeline = deps.timeline ?? ((event: PublishTimelineEvent, input?: PublishTimelineInput) => logPublishTimeline(event, input));
  const result: PublishRunResult = { claimed: 0, published: 0, failed: 0, retrying: 0, skipped: 0, results: [] };

  if (!config) {
    // Nothing is claimed when Instagram is not configured, so a misconfigured
    // deployment can never burn a scheduled item's attempts.
    result.skipped += 1;
    result.results.push({ id: "-", outcome: "skipped", code: "instagram_not_configured" });
    return result;
  }

  const startedAt = now().getTime();
  const budgetMs = deps.pollingBudgetMs ?? PUBLISH_POLLING_BUDGET_MS;
  // One deadline for the entire batch, measured in wall-clock time.
  const deadlineAt = startedAt + budgetMs;
  const remainingBudgetMs = () => deadlineAt - Date.now();

  const items = await claimDueItems(db, deps.limit ?? 10, now());
  result.claimed = items.length;
  timeline("run_started", { budgetMs });
  const client = (deps.clientFor ?? ((value: InstagramConfig) => new InstagramClient(value)))(config);
  const ports = buildPorts(db, client, config, sleep, { remainingBudgetMs, timeline });

  for (const row of items) {
    const item = toFlowItem(row);
    timeline("claimed", {
      itemId: row.id, ownerUserId: row.owner_user_id, draftId: row.draft_id,
      mediaKind: row.media_kind, attempt: row.attempts,
      containerId: row.container_id, budgetMs: remainingBudgetMs(),
    });
    try {
      const outcome = await runPublishFlow(item, ports);
      if (outcome.outcome === "published") {
        result.published += 1;
        await db.from("content_calendar_items").update({ status: "scheduled" })
          .eq("owner_user_id", row.owner_user_id).eq("source_draft_id", row.draft_id);
      } else if (outcome.outcome === "retrying") result.retrying += 1;
      else result.failed += 1;
      result.results.push({ id: row.id, outcome: outcome.outcome, code: outcome.code });
    } catch {
      await failPublishItem(db, row.id, row.owner_user_id, {
        code: "publish_unknown_error",
        message: "Instagram publishing did not complete. Please review this item.",
        status: "failed",
      }).catch(() => undefined);
      timeline("failed", {
        itemId: row.id, ownerUserId: row.owner_user_id, draftId: row.draft_id,
        mediaKind: row.media_kind, attempt: row.attempts, code: "publish_unknown_error",
      });
      result.failed += 1;
      result.results.push({ id: row.id, outcome: "failed", code: "publish_unknown_error" });
    }
  }
  return result;
}

export function toFlowItem(row: PublishQueueRow): FlowItem {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    draftId: row.draft_id,
    mediaKind: row.media_kind,
    caption: row.caption,
    attempts: row.attempts,
    containerId: row.container_id,
    instagramMediaId: row.instagram_media_id,
  };
}

export function buildPorts(
  db: SupabaseClient,
  client: InstagramClient,
  config: InstagramConfig,
  sleep: (ms: number) => Promise<void>,
  options: {
    remainingBudgetMs?: () => number;
    timeline?: (event: PublishTimelineEvent, input?: PublishTimelineInput) => void;
  } = {},
): FlowPorts {
  const timeline = options.timeline;
  return {
    async loadDraft(ownerId, draftId) {
      const { data } = await db.from("mara_drafts").select("status,content")
        .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
      return data ? { status: String(data.status ?? ""), content: String(data.content ?? "") } : null;
    },
    async loadConnection(ownerId) {
      const { data } = await db.from("instagram_connections").select("status,scopes,token_expires_at")
        .eq("owner_user_id", ownerId).maybeSingle();
      if (!data) return null;
      return {
        status: String(data.status ?? ""),
        scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : [],
        tokenExpiresAt: data.token_expires_at ? String(data.token_expires_at) : null,
      };
    },
    async loadCredentials(ownerId) {
      const credentials = await getInstagramServerCredentials(db, ownerId, instagramKeyRing(config));
      return { igUserId: credentials.userId, accessToken: credentials.accessToken };
    },
    async loadAsset(ownerId, draftId) {
      const { data } = await db.from("post_draft_assets").select("storage_path,mime_type,status")
        .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
      if (!data || typeof data.storage_path !== "string") return null;
      return { storagePath: data.storage_path, mimeType: String(data.mime_type ?? ""), status: String(data.status ?? "") };
    },
    async signMediaUrl(storagePath) {
      // Short-lived, scoped to exactly this object. The bucket stays private.
      const { data } = await db.storage.from(ASSET_BUCKET).createSignedUrl(storagePath, PUBLISH_SIGNED_URL_TTL_SECONDS);
      return data?.signedUrl ?? null;
    },
    async createContainer(input) {
      if (input.kind === "story") {
        // Meta's only Story form: a media_type=STORIES container. No caption —
        // Instagram does not support captions on Stories.
        return client.createStoryContainer({
          accessToken: input.accessToken,
          igUserId: input.igUserId,
          mediaUrl: input.mediaUrl,
          video: input.video,
        });
      }
      return input.kind === "reel"
        ? client.createReelContainer({ accessToken: input.accessToken, igUserId: input.igUserId, videoUrl: input.mediaUrl, caption: input.caption })
        : client.createImageContainer({ accessToken: input.accessToken, igUserId: input.igUserId, imageUrl: input.mediaUrl, caption: input.caption });
    },
    async containerStatus(accessToken, containerId) {
      return (await client.getContainerStatus(accessToken, containerId)).statusCode;
    },
    async publishContainer(input) {
      return client.publishContainer(input);
    },
    async findPublishedMediaId(accessToken, caption) {
      const needle = caption.trim().slice(0, 60);
      if (!needle) return null;
      return client.findRecentMediaId(accessToken, (media) =>
        typeof media.caption === "string" && media.caption.trim().startsWith(needle));
    },
    async persistContainerId(item, containerId) {
      await recordContainerId(db, item.id, item.ownerUserId, containerId);
    },
    async markPublished(item, instagramMediaId, containerId) {
      await completePublishItem(db, item.id, item.ownerUserId, instagramMediaId, containerId);
    },
    async markFailed(item, input) {
      await failPublishItem(db, item.id, item.ownerUserId, {
        code: input.code,
        message: input.message,
        status: input.status as PublishState,
        retryAt: input.retryAt,
      });
    },
    sleep,
    ...(options.remainingBudgetMs ? { remainingBudgetMs: options.remainingBudgetMs } : {}),
    ...(timeline ? { timeline: (event: PublishTimelineEvent, input: PublishTimelineInput) => timeline(event, input) } : {}),
  };
}
