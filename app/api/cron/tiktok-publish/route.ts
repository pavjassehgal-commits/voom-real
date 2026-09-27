import { runTikTokPublishing } from "@/lib/tiktok/publish-worker";
import { bearerMatches } from "@/utils/bearer-auth";

export const runtime = "nodejs";
/**
 * Hard serverless ceiling for one worker invocation, mirroring the YouTube
 * and Instagram workers. The upload budget in lib/tiktok/publishing.ts is
 * derived from this value; a test asserts the two stay in sync. Uploads are
 * streamed in chunks and parked at cron boundaries, never buffered whole.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Scheduled TikTok publishing worker (posting phase).
 *
 * Secured with CRON_SECRET exactly like the YouTube and Instagram workers:
 * the Supabase Cron job calls this endpoint with the Bearer secret from
 * Supabase Vault; no browser can reach it. Running twice concurrently is
 * safe — every item is claimed atomically inside PostgreSQL (`for update
 * skip locked`) before any TikTok call is made, and the provider publish id
 * is persisted before the first byte, so a duplicate run resumes rather
 * than duplicates.
 *
 * NOT scheduled by this repository change: the production cron entry is
 * configured by an operator during the documented rollout.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "TikTok publishing is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await runTikTokPublishing();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "TikTok publishing could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
