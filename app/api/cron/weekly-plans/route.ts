import { runRollingPlanAutomation } from "@/lib/voom/weekly-automation";
import { bearerMatches } from "@/utils/bearer-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * The scheduled rolling-plan worker.
 *
 * Runs daily and tops each automated account's rolling 7-day horizon back up
 * to its selected posting cadence, starting on that account's real current
 * local date. Running twice in a day is safe: items are keyed by (plan, local
 * slot date), so the second run reuses everything and creates nothing.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Plan automation is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json(await runRollingPlanAutomation(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Plan automation could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
