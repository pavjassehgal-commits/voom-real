import { runLinkedInPublishing } from "@/lib/linkedin/publish-worker";
import { createAdminClient } from "@/utils/supabase/admin";
import { handleLinkedInCron } from "@/lib/linkedin/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
// Registered every five minutes in vercel.json; the handler authenticates before
// constructing the admin client. Only explicitly approved LinkedIn jobs are claimed.
export async function GET(request: Request) {
  return handleLinkedInCron(request, {
    environment: process.env.VERCEL_ENV,
    secret: process.env.CRON_SECRET,
    run: () => runLinkedInPublishing({ db: createAdminClient() }),
  });
}
export const POST = GET;
