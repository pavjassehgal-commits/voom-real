import { runYouTubePerformanceSync } from "@/lib/youtube/performance";
import { bearerMatches } from "@/utils/bearer-auth";

export const runtime = "nodejs";
/** Matches the other workers; the sync also enforces its own wall-clock budget. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Read-only YouTube performance collection worker.
 *
 * It measures only content VOOM ALREADY PUBLISHED (a youtube_publish_queue
 * row in status 'published' carrying a real video id) through the official
 * YouTube Data API videos.list `statistics` part — views, likes, comments.
 * It can never publish, never modify a video, never touches monetary
 * YouTube Analytics data, and never stores a fake zero: a metric YouTube did
 * not return is absent (unavailable != zero).
 *
 * Auth follows the existing worker pattern exactly (CRON_SECRET Bearer).
 * Running twice inside one hourly window is safe: snapshots are keyed by
 * (owner, video id, deterministic window start), so a second run refreshes
 * the same rows instead of duplicating them.
 *
 * NOT scheduled by this repository change: the production cron entry is
 * configured by an operator during the documented rollout.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "YouTube performance collection is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await runYouTubePerformanceSync();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "YouTube performance collection could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
