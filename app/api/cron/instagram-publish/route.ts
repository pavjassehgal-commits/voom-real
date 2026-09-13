import { runInstagramPublishing } from "@/lib/instagram/publish-worker";

export const runtime = "nodejs";
/**
 * Hard serverless ceiling for one worker invocation, and the number the whole
 * readiness-polling budget is derived from: see PUBLISH_WORKER_MAX_DURATION_MS
 * and PUBLISH_POLLING_BUDGET_MS in lib/instagram/publishing.ts. 300s is also
 * the maximum Vercel allows on the Hobby plan with Fluid Compute, so this
 * cannot be raised — polling has to fit inside it instead.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Scheduled Instagram auto-publishing worker.
 *
 * Secured with CRON_SECRET exactly like /api/cron/weekly-plans. The Supabase
 * Cron job voom-instagram-publish-5m (5-minute cadence) calls this endpoint
 * with the Bearer secret from Supabase Vault; no browser can reach it. Vercel
 * runs on the Hobby plan, so no Vercel cron entry exists for this route.
 *
 * Running twice concurrently is safe: every item is claimed atomically inside
 * PostgreSQL (`for update skip locked`) before any Instagram call is made.
 *
 * The five-minute cadence is a timing contract, not just a schedule: a retry
 * is parked for the NEXT boundary of exactly this cadence
 * (PUBLISH_WORKER_PERIOD_MS), so the following run can claim it. Changing the
 * cron frequency without changing that constant would strand retries again.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Instagram publishing is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await runInstagramPublishing();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Instagram publishing could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
