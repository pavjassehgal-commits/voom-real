import { runVideoGenerationPoller, VIDEO_GENERATION_POLL_INTERVAL_MINUTES } from "@/lib/mara/video-poller";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Authoritative server-side video-generation worker.
 *
 * Supabase Cron calls this route with the same CRON_SECRET/Vault pattern as the
 * Instagram publisher. The browser is not involved: every active provider job
 * is resumed from its persisted provider_job_id, at most once per two-minute
 * cadence, until it completes, fails, or reaches Voom's 30-minute timeout.
 *
 * This route never accepts a draft id and never starts a generation. It only
 * polls already-submitted jobs, so a repeated cron invocation cannot create a
 * second paid Seedance request.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Media generation polling is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await runVideoGenerationPoller();
    return Response.json(
      { ...result, cadenceMinutes: VIDEO_GENERATION_POLL_INTERVAL_MINUTES },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Media generation polling could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
