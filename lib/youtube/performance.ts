import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { YouTubeClient } from "./client.ts";
import { readYouTubeConfig, youTubeKeyRing, type YouTubeConfig } from "./config.ts";
import { getYouTubeServerCredentials } from "./data.ts";
import { performanceWindowStart, YOUTUBE_UPLOAD_BUDGET_MS } from "./publishing.ts";
import { YOUTUBE_QUEUE_COLUMNS } from "./publish-queue.ts";
import type { YouTubeQueueRow } from "./types.ts";

/**
 * The durable YouTube performance sync.
 *
 * WHAT IT DOES
 *   For every YouTube item VOOM ITSELF PUBLISHED (a youtube_publish_queue row
 *   in status 'published' carrying a real video id), it reads that video's
 *   PUBLIC statistics through the official YouTube Data API v3 videos.list
 *   `statistics` part (viewCount, likeCount, commentCount), normalizes them
 *   into Voom's performance model and upserts ONE snapshot per (owner, video,
 *   hourly collection window).
 *
 * WHAT IT CAN NEVER DO
 *   - publish anything: the queue is only SELECTed, never claimed or written,
 *   - read content that is not already published: the source query is
 *     `status = 'published'` plus a non-null video id, which the database
 *     guarantees only exists after YouTube returned the id and its own
 *     'processed' status,
 *   - modify any video, caption or metadata: only GET requests exist here,
 *   - cross owners: every credential read is keyed by the row's own
 *     owner_user_id, and every snapshot carries that same owner,
 *   - invent metrics or write a fake zero: a metric is stored ONLY when
 *     YouTube actually returned that number; anything else is absent
 *     (unavailable != zero),
 *   - touch monetary data: the YouTube Analytics (revenue) APIs and scopes
 *     are not used anywhere in Voom.
 *
 * Idempotency: collected_at is the deterministic start of the hourly window,
 * so re-running inside a window refreshes the same row via the
 * (owner, video, collected_at) unique key instead of duplicating it.
 */

/** How far back Voom keeps refreshing metrics for published videos. */
export const YOUTUBE_PERFORMANCE_LOOKBACK_DAYS = 30;
/** Published items measured per run (bounded work per cron invocation). */
export const YOUTUBE_PERFORMANCE_LIMIT = 25;

export const YOUTUBE_SNAPSHOT_TABLE = "youtube_performance_snapshots";

export type YouTubePerformanceOutcome = "stored" | "refreshed" | "video_unavailable" | "statistics_unavailable" | "connection_unavailable";

export interface YouTubePerformanceItemResult {
  ownerId: string;
  youtubeVideoId: string;
  draftId: string | null;
  outcome: YouTubePerformanceOutcome;
  /** Only the metrics YouTube really returned (never a filled-in zero). */
  storedMetrics: string[];
}

export interface YouTubePerformanceRunResult {
  measured: number;
  stored: number;
  unavailable: number;
  skipped: number;
  items: YouTubePerformanceItemResult[];
}

export interface YouTubePerformanceDeps {
  db?: SupabaseClient;
  config?: YouTubeConfig | null;
  clientFor?: (config: YouTubeConfig) => YouTubeClient;
  now?: () => Date;
  limit?: number;
  budgetMs?: number;
}

export async function runYouTubePerformanceSync(deps: YouTubePerformanceDeps = {}): Promise<YouTubePerformanceRunResult> {
  const db = deps.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  const config = deps.config !== undefined ? deps.config : readYouTubeConfig();
  const now = deps.now ?? (() => new Date());
  const result: YouTubePerformanceRunResult = { measured: 0, stored: 0, unavailable: 0, skipped: 0, items: [] };

  if (!config) {
    result.skipped += 1;
    return result;
  }

  const deadlineAt = now().getTime() + (deps.budgetMs ?? YOUTUBE_UPLOAD_BUDGET_MS);
  const client = (deps.clientFor ?? ((value: YouTubeConfig) => new YouTubeClient(value)))(config);
  const keyRing = youTubeKeyRing(config);
  const collectedAt = performanceWindowStart(now().getTime());
  const lookbackStart = new Date(now().getTime() - YOUTUBE_PERFORMANCE_LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data } = await db.from("youtube_publish_queue").select(YOUTUBE_QUEUE_COLUMNS)
    .eq("status", "published")
    .not("youtube_video_id", "is", null)
    .gte("published_at", lookbackStart)
    .order("published_at", { ascending: false })
    .limit(deps.limit ?? YOUTUBE_PERFORMANCE_LIMIT);
  const rows = (Array.isArray(data) ? data : []) as YouTubeQueueRow[];
  if (!rows.length) return result;

  // Per-owner credentials, resolved once. A disconnected/revoked owner is
  // skipped truthfully — no provider call is attempted and no snapshot lies.
  const credentialsByOwner = new Map<string, { accessToken: string } | null>();
  const businessByOwner = new Map<string, string | null>();

  for (const row of rows) {
    if (Date.now() > deadlineAt) break;
    if (!row.youtube_video_id) continue;
    result.measured += 1;

    if (!credentialsByOwner.has(row.owner_user_id)) {
      try {
        const credentials = await getYouTubeServerCredentials(db, row.owner_user_id, keyRing, client);
        credentialsByOwner.set(row.owner_user_id, { accessToken: credentials.accessToken });
      } catch {
        credentialsByOwner.set(row.owner_user_id, null);
      }
      const { data: business } = await db.from("businesses").select("id").eq("owner_user_id", row.owner_user_id).maybeSingle();
      businessByOwner.set(row.owner_user_id, business?.id ? String(business.id) : null);
    }
    const credentials = credentialsByOwner.get(row.owner_user_id);
    if (!credentials) {
      result.unavailable += 1;
      result.items.push({ ownerId: row.owner_user_id, youtubeVideoId: row.youtube_video_id, draftId: row.draft_id, outcome: "connection_unavailable", storedMetrics: [] });
      continue;
    }

    let read;
    try {
      read = await client.getVideo(credentials.accessToken, row.youtube_video_id);
    } catch {
      read = undefined;
    }
    if (read === undefined) {
      // A refused read is NOT a zero. Nothing is stored; the outcome is said.
      result.unavailable += 1;
      result.items.push({ ownerId: row.owner_user_id, youtubeVideoId: row.youtube_video_id, draftId: row.draft_id, outcome: "statistics_unavailable", storedMetrics: [] });
      continue;
    }
    if (!read) {
      result.unavailable += 1;
      result.items.push({ ownerId: row.owner_user_id, youtubeVideoId: row.youtube_video_id, draftId: row.draft_id, outcome: "video_unavailable", storedMetrics: [] });
      continue;
    }

    const metrics: Record<string, number> = {};
    const sources: Record<string, string> = {};
    if (typeof read.statistics.views === "number") { metrics.views = read.statistics.views; sources.views = "data_api_statistics"; }
    if (typeof read.statistics.likes === "number") { metrics.likes = read.statistics.likes; sources.likes = "data_api_statistics"; }
    if (typeof read.statistics.comments === "number") { metrics.comments = read.statistics.comments; sources.comments = "data_api_statistics"; }

    if (!Object.keys(metrics).length) {
      result.unavailable += 1;
      result.items.push({ ownerId: row.owner_user_id, youtubeVideoId: row.youtube_video_id, draftId: row.draft_id, outcome: "statistics_unavailable", storedMetrics: [] });
      continue;
    }

    const snapshot = {
      owner_user_id: row.owner_user_id,
      business_id: businessByOwner.get(row.owner_user_id) ?? null,
      draft_id: row.draft_id,
      calendar_item_id: row.calendar_item_id,
      publish_queue_id: row.id,
      youtube_video_id: row.youtube_video_id,
      content_type: row.youtube_format,
      published_at: row.published_at ?? collectedAt,
      collected_at: collectedAt,
      metrics,
      metric_sources: sources,
    };
    const { error } = await db.from(YOUTUBE_SNAPSHOT_TABLE).upsert(snapshot, {
      onConflict: "owner_user_id,youtube_video_id,collected_at",
    });
    if (error) {
      result.unavailable += 1;
      result.items.push({ ownerId: row.owner_user_id, youtubeVideoId: row.youtube_video_id, draftId: row.draft_id, outcome: "statistics_unavailable", storedMetrics: [] });
      continue;
    }
    result.stored += 1;
    result.items.push({ ownerId: row.owner_user_id, youtubeVideoId: row.youtube_video_id, draftId: row.draft_id, outcome: "stored", storedMetrics: Object.keys(metrics) });
  }

  return result;
}
