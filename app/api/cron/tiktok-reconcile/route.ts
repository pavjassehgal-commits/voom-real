import { runTikTokReconciliation } from "@/lib/tiktok/reconcile";
import { bearerMatches } from "@/utils/bearer-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Durable TikTok reconciliation worker.
 *
 * Owns every outcome the provider still owes Voom: polls
 * `provider_processing` rows for TikTok's own PUBLISH_COMPLETE evidence
 * through the official post-status endpoint, resumes stale `posting` rows
 * through their persisted publish id and byte progress, attempts READ-ONLY
 * recovery of fail-closed outcomes (the guarded re-arm only when TikTok
 * itself says the post does not exist — never a blind re-init), and
 * re-checks published posts once a day so a later removal on TikTok is
 * visible without rewriting the proven publication fact.
 *
 * Secured with CRON_SECRET exactly like the other workers; concurrent runs
 * are safe through the same `for update skip locked` claims.
 *
 * NOT scheduled by this repository change: the production cron entry is
 * configured by an operator during the documented rollout.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "TikTok reconciliation is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await runTikTokReconciliation();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "TikTok reconciliation could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
