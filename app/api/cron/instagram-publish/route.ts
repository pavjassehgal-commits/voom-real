import { runInstagramPublishing } from "@/lib/instagram/publish-worker";

export const runtime = "nodejs";
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
