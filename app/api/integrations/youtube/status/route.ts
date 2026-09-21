import { readYouTubeConfig } from "@/lib/youtube/config";
import { getYouTubeConnection } from "@/lib/youtube/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

/**
 * The sanitized YouTube connection status for the owner's own UI: channel
 * identity, granted scopes, expiry metadata, explicit defaults and the
 * truthful API-project audit state. Never a token, never a secret.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const config = readYouTubeConfig();
  try {
    const connection = await getYouTubeConnection(await createClient(), user.id, Boolean(config), config?.projectAudited === true);
    return Response.json({ connection }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "YouTube connection status is temporarily unavailable." }, { status: 503 });
  }
}
