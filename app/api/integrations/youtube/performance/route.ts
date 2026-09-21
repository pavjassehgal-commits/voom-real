import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

/**
 * Read-only YouTube performance for the owner's own published videos: the
 * latest snapshot per video from youtube_performance_snapshots (populated by
 * the read-only performance worker from the official Data API statistics
 * part). RLS restricts this to the owner's rows; no token, no monetary
 * metric, no invented zero — absent metrics mean YouTube did not return
 * them.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const db = await createClient();
    const { data, error } = await db.from("youtube_performance_snapshots")
      .select("youtube_video_id,content_type,published_at,collected_at,metrics")
      .eq("owner_user_id", user.id)
      .order("collected_at", { ascending: false })
      .limit(200);
    if (error) throw new Error("youtube_performance_read_failed");
    // Latest snapshot per video (the query is collected_at-descending).
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const videoId = String(row.youtube_video_id ?? "");
      if (videoId && !latest.has(videoId)) latest.set(videoId, row);
    }
    return Response.json({
      videos: [...latest.values()].map((row) => ({
        videoId: String(row.youtube_video_id),
        contentType: String(row.content_type ?? "video"),
        publishedAt: row.published_at ? String(row.published_at) : null,
        collectedAt: row.collected_at ? String(row.collected_at) : null,
        metrics: (row.metrics && typeof row.metrics === "object" ? row.metrics : {}) as Record<string, number>,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "YouTube performance is temporarily unavailable." }, { status: 503 });
  }
}
