import { cleanupAbandonedTikTokUploads } from "@/lib/tiktok/upload-session-server";
import { bearerMatches } from "@/utils/bearer-auth";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Removes abandoned TikTok video uploads (never finalized, older than the
 * 26-hour resumable-upload window, and not any draft's linked video).
 * Protected by CRON_SECRET like the other workers. NOT scheduled by this
 * change: Preview deployments do not run cron jobs, so an operator runs it
 * (or schedules it) deliberately. Starting a new upload also cleans that
 * draft's stale uploads, so nothing depends on this route running.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Upload cleanup is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const result = await cleanupAbandonedTikTokUploads(createAdminClient());
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Upload cleanup could not complete safely." }, { status: 503 });
  }
}
