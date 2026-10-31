import { instagramKeyRing, readInstagramConfig } from "@/lib/instagram/config";
import { refreshInstagramLongLivedToken } from "@/lib/instagram/token-refresh";
import { renewInstagramTokens, supabaseRenewalStore } from "@/lib/instagram/token-renewal";
import { handleInstagramTokenRenewalCron } from "@/lib/instagram/token-renewal-cron";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
/** Matches the other workers; the renewal batch also enforces its own budget. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Instagram long-lived token renewal worker (migration 0068).
 *
 * Runs only on Vercel Production (Preview deployments share the Production
 * database), then follows the existing worker pattern: Supabase Cron calls it
 * with `Authorization: Bearer <CRON_SECRET>` (secret held in Supabase Vault),
 * checked in constant time before the admin client exists.
 * Overlapping runs are safe: every connection is claimed inside PostgreSQL
 * before Meta is called. It never publishes and never touches queues, drafts
 * or credits. The response carries counts only — no token, owner id or
 * provider response.
 *
 * NOT registered in vercel.json: the schedule is the operator-run
 * `voom-instagram-token-refresh-6h` job in supabase/ops/schedule-workers.sql.
 */
export async function GET(request: Request) {
  return handleInstagramTokenRenewalCron(request, {
    environment: process.env.VERCEL_ENV,
    secret: process.env.CRON_SECRET,
    run: async () => {
      const config = readInstagramConfig();
      if (!config) return null;
      return renewInstagramTokens({
        store: supabaseRenewalStore(createAdminClient()),
        refresh: (token) => refreshInstagramLongLivedToken(token),
        keyRing: instagramKeyRing(config),
      });
    },
  });
}

export const POST = GET;
