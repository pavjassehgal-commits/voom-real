import { YouTubeClient } from "@/lib/youtube/client";
import { readYouTubeConfig, youTubeKeyRing } from "@/lib/youtube/config";
import { disconnectYouTube } from "@/lib/youtube/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { eraseYouTubeData } from "@/lib/youtube/privacy";

export const runtime = "nodejs";

/**
 * Disconnects the YouTube channel.
 *
 * Commits an owner-scoped access block, erases YouTube-derived local data,
 * and attempts Google revocation through the isolated leased outbox.
 * A failed purge remains blocked for maintenance recovery; an unconfirmed
 * revocation is not reported as success. Original drafts/media stay.
 *
 * What it NEVER does: delete or modify a single video on the customer's
 * YouTube channel (no videos.delete path exists anywhere in this
 * integration). YouTube-derived history is erased; original drafts/media stay.
 */
export async function DELETE(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({error:"Invalid request origin."},{status:403});
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
        { disconnected: (await eraseYouTubeData(admin,user.id)).erased, revokedAtGoogle: false };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "YouTube could not be disconnected. Please retry." }, { status: 503 });
  }
}
