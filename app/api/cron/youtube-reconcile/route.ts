import { runYouTubeReconciliation } from "@/lib/youtube/reconcile";
import { bearerMatches } from "@/utils/bearer-auth";
import { createAdminClient } from "@/utils/supabase/admin";
import { cleanupYouTubeUploads } from "@/lib/youtube/upload-server";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Durable YouTube reconciliation worker.
 *
 * Owns every outcome the provider still owes Voom: polls
 * `provider_processing` rows for YouTube's own 'processed' evidence,
 * resumes stale `uploading` sessions through their persisted session URLs,
 * attempts READ-ONLY recovery of ambiguous outcomes (never a blind
 * re-upload), records revoked authorization truthfully, and re-checks
 * published videos once a day so deletion or re-privating on YouTube is
 * visible without rewriting the publication fact.
 *
 * Secured with CRON_SECRET exactly like the other workers; concurrent runs
 * are safe through the same `for update skip locked` claims.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "YouTube reconciliation is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await runYouTubeReconciliation();
    // A storage-cleanup outage must retain media, not interrupt publishing.
    const uploadCleanup = await cleanupYouTubeUploads(createAdminClient()).catch(()=>({deferred:true}));
    return Response.json({...result,uploadCleanup}, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "YouTube reconciliation could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
