import { readTikTokConfig } from "@/lib/tiktok/config";
import { getTikTokConnection } from "@/lib/tiktok/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

/**
 * The sanitized TikTok connection status for the owner's own UI: provider
 * identity (open_id, display name, avatar), granted scopes, expiry
 * metadata, the explicit privacy default, and the truthful app-audit state.
 * Never a token, never a secret.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const config = readTikTokConfig();
  try {
    const connection = await getTikTokConnection(await createClient(), user.id, Boolean(config), config?.appAudited === true);
    return Response.json({ connection }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "TikTok connection status is temporarily unavailable." }, { status: 503 });
  }
}
