import { runLinkedInPublishing } from "@/lib/linkedin/publish-worker";
import { createAdminClient } from "@/utils/supabase/admin";
import { bearerMatches } from "@/utils/bearer-auth";
import { json } from "@/lib/linkedin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
// No cron registration is added. An operator must explicitly enable this
// worker after isolated OAuth and publishing validation, never during setup.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({error:"Worker is not configured."},503);
  if (!bearerMatches(request, secret)) return json({error:"Unauthorized."},401);
  try { return json(await runLinkedInPublishing({db:createAdminClient()})); }
  catch { return json({error:"LinkedIn publishing could not complete safely."},503); }
}
export const POST = GET;
