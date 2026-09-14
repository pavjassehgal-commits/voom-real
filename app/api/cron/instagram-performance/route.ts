import { runInstagramPerformanceSync } from "@/lib/performance/sync";

export const runtime = "nodejs";
/** Matches the other workers; the sync also enforces its own wall-clock budget. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Read-only Instagram performance collection worker.
 *
 * It measures only content VOOM ALREADY PUBLISHED (a publish queue row in
 * status 'published' carrying a real Meta media id) and writes normalized
 * performance snapshots. It can never publish, never create a container,
 * never modify media or captions, and never start a paid generation — see
 * lib/performance/sync.ts for the full guarantees.
 *
 * Auth follows the existing worker pattern exactly: the Supabase Cron job
 * calls this route with `Authorization: Bearer <CRON_SECRET>` (secret held in
 * Supabase Vault). Running it twice concurrently is safe: snapshots are keyed
 * by (owner, media id, collection window), so a second run in the same window
 * refreshes the same rows instead of duplicating them.
 *
 * NOT registered in vercel.json and NOT scheduled by this change: the intended
 * production schedule (a few times a day) is configured in Supabase Cron by an
 * operator, exactly like the publishing and media-generation workers. No cron
 * entry is added or triggered by this repository change.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Performance collection is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await runInstagramPerformanceSync();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Performance collection could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
