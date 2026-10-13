import { runDailyTrendJob } from "@/lib/trends/daily-job";
import { createTrendAdminRpcClient } from "@/lib/trends/supabase-rpc";
import { bearerMatches } from "@/utils/bearer-auth";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Daily Trend Intelligence job: bounded purge, at most one Wikidata
 * collection per 20 hours through the governed store RPC, retention health.
 *
 * OFF unless TREND_COLLECTION_ENABLED is exactly "true", and authenticated
 * with CRON_SECRET. NOT scheduled: this route is intentionally absent from
 * vercel.json until a production schedule is approved. Responds with counts
 * and safe codes only.
 */
export async function GET(request: Request) {
  if (process.env.TREND_COLLECTION_ENABLED !== "true") {
    return Response.json({ error: "Trend collection is disabled." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Trend collection is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const projectId = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0] || "unknown";
    const report = await runDailyTrendJob({
      client: createTrendAdminRpcClient(),
      now: new Date(),
      fetch: (url, init) => globalThis.fetch(url, init),
      projectId,
    });
    console.info("[trend-collection]", JSON.stringify({
      healthy: report.healthy,
      purge: report.purge.status,
      collection: report.collection.status,
      stored: "storage" in report.collection ? report.collection.storage.stored : 0,
      breach: report.retention?.breach ?? null,
    }));
    return Response.json(report, { status: report.healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[trend-collection] failed safely");
    return Response.json({ error: "Trend collection could not complete safely." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const POST = GET;
