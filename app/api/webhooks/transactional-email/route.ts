import { createAdminClient } from "@/utils/supabase/admin";
import { handleTransactionalWebhook, transactionalConfig } from "@/lib/transactional-email/core";
export const runtime = "nodejs";
export async function POST(request: Request) {
    try {
        const config = transactionalConfig();
        if (!config)
            return new Response("Not configured", { status: 503 });
        return await handleTransactionalWebhook(request, createAdminClient(), config);
    }
    catch {
        return new Response("Receipt unavailable", { status: 503 });
    }
}
