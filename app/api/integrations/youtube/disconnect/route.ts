import { YouTubeClient } from "@/lib/youtube/client";
import { readYouTubeConfig, youTubeKeyRing } from "@/lib/youtube/config";
import { disconnectYouTube } from "@/lib/youtube/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * Disconnects the YouTube channel.
 *
 * What it does, in the safe order: destroys the encrypted tokens locally
 * (future publishing becomes impossible immediately), marks the connection
 * disconnected, withdraws queue rows that never reached the provider, and
 * then asks Google to revoke the refresh token (best effort — the local
 * destruction never depends on it).
 *
 * What it NEVER does: delete or modify a single video on the customer's
 * YouTube channel (no videos.delete path exists anywhere in this
 * integration), or erase Voom history — published queue rows, provider
 * references and performance snapshots all remain.
 */
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const config = readYouTubeConfig();
  try {
    const admin = createAdminClient();
    const result = config
      ? await disconnectYouTube(admin, user.id, youTubeKeyRing(config), new YouTubeClient(config))
      : // Even unconfigured, the local disconnect must work: it only needs the
        // database. Revocation is impossible without client credentials and
        // is reported truthfully.
        { disconnected: Boolean((await admin.rpc("disconnect_youtube_connection", { p_owner_user_id: user.id })).data), revokedAtGoogle: false };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "YouTube could not be disconnected. Please retry." }, { status: 503 });
  }
}
