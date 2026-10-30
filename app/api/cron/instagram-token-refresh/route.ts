import { instagramKeyRing, readInstagramConfig } from "@/lib/instagram/config";
import { refreshInstagramLongLivedToken } from "@/lib/instagram/token-refresh";
import { renewInstagramTokens, supabaseRenewalStore } from "@/lib/instagram/token-renewal";
import { createAdminClient } from "@/utils/supabase/admin";
import { bearerMatches } from "@/utils/bearer-auth";

export const runtime = "nodejs";
/** Matches the other workers; the renewal batch also enforces its own budget. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Instagram long-lived token renewal worker (migration 0068).
 *
 * Auth follows the existing worker pattern exactly: Supabase Cron calls this
 * route with `Authorization: Bearer <CRON_SECRET>` (secret held in Supabase
 * Vault). Overlapping runs are safe: every connection is claimed inside
 * PostgreSQL before Meta is called. It never publishes and never touches
 * queues, drafts or credits. The response carries counts only — no token,
 * owner id or provider response.
 *
 * NOT registered in vercel.json: the schedule is the operator-run
 * `voom-instagram-token-refresh-6h` job in supabase/ops/schedule-workers.sql.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Instagram token renewal is not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const config = readInstagramConfig();
  if (!config) return Response.json({ error: "Instagram token renewal is not configured." }, { status: 503 });
  try {
    const result = await renewInstagramTokens({
      store: supabaseRenewalStore(createAdminClient()),
      refresh: (token) => refreshInstagramLongLivedToken(token),
      keyRing: instagramKeyRing(config),
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Instagram token renewal could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
