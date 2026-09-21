import { TikTokClient } from "@/lib/tiktok/client";
import { readTikTokConfig, tikTokKeyRing } from "@/lib/tiktok/config";
import { disconnectTikTok } from "@/lib/tiktok/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * Disconnects the TikTok account.
 *
 * What it does, in the safe order: destroys the encrypted tokens locally
 * (future publishing becomes impossible immediately), marks the connection
 * disconnected, withdraws queue rows that never reached the provider, and
 * then asks TikTok to revoke the access token (best effort — the local
 * destruction never depends on it).
 *
 * What it NEVER does: delete or modify a single post on the customer's
 * TikTok account (no video-delete path exists anywhere in this
 * integration), or erase Voom history — published queue rows, provider
 * references and the proven publication facts all remain.
 */
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const config = readTikTokConfig();
  try {
    const admin = createAdminClient();
    const result = config
      ? await disconnectTikTok(admin, user.id, tikTokKeyRing(config), new TikTokClient(config))
      : // Even unconfigured, the local disconnect must work: it only needs the
        // database. Revocation is impossible without client credentials and
        // is reported truthfully.
        { disconnected: Boolean((await admin.rpc("disconnect_tiktok_connection", { p_owner_user_id: user.id })).data), revokedAtTikTok: false };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "TikTok could not be disconnected. Please retry." }, { status: 503 });
  }
}
