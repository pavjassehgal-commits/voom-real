import { createAdminClient } from "@/utils/supabase/admin";
import { bearerMatches } from "@/utils/bearer-auth";
import { processTransactionalEmail, transactionalConfig } from "@/lib/transactional-email/core";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
// Not scheduled by this PR. One job/pass, both app and DB default OFF.
export async function GET(request: Request) {
    if (!process.env.CRON_SECRET || !bearerMatches(request, process.env.CRON_SECRET))
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    try {
        const config = transactionalConfig();
        if (!config)
            return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
        return Response.json(await processTransactionalEmail(createAdminClient(), config), { headers: { "Cache-Control": "no-store" } });
    }
    catch {
        return Response.json({ error: "Transactional email unavailable" }, { status: 503 });
    }
}
export const POST = GET;
