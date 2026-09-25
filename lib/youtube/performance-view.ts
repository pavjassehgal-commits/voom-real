import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ONE read of real YouTube performance: the latest snapshot per published
 * video from `youtube_performance_snapshots` (populated read-only by the
 * existing performance worker from the official Data API `statistics` part).
 *
 * This mirrors the owner-scoped read `GET /api/integrations/youtube/performance`
 * already serves to the browser (same table, same columns, same
 * `.eq("owner_user_id", …)` filter) so the executive Performance view renders
 * the SAME stored snapshots instead of computing numbers of its own. The
 * latest-per-video rule lives in one place here. RLS restricts every row to
 * the owner; an absent metric stays absent (it is never turned into a zero)
 * and no token or monetary figure is read.
 */
export interface YouTubePerformanceVideo {
  videoId: string;
  contentType: string;
  publishedAt: string | null;
  collectedAt: string | null;
  metrics: Record<string, number>;
}

export async function loadYouTubePerformanceVideos(
  db: SupabaseClient,
  ownerId: string,
): Promise<YouTubePerformanceVideo[]> {
  const { data, error } = await db.from("youtube_performance_snapshots")
    .select("youtube_video_id,content_type,published_at,collected_at,metrics")
    .eq("owner_user_id", ownerId)
    .order("collected_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("youtube_performance_read_failed");
  // Latest snapshot per video (the query is collected_at-descending).
  const latest = new Map<string, YouTubePerformanceVideo>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const videoId = String(row.youtube_video_id ?? "");
    if (!videoId || latest.has(videoId)) continue;
    latest.set(videoId, {
      videoId,
      contentType: String(row.content_type ?? "video"),
      publishedAt: row.published_at ? String(row.published_at) : null,
      collectedAt: row.collected_at ? String(row.collected_at) : null,
      metrics: (row.metrics && typeof row.metrics === "object" ? row.metrics : {}) as Record<string, number>,
    });
  }
  return [...latest.values()];
}
