import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getInstagramConnection } from "@/lib/instagram/data";
import { readInstagramConfig } from "@/lib/instagram/config";
import { getTikTokConnection } from "@/lib/tiktok/data";
import { readTikTokConfig } from "@/lib/tiktok/config";
import { getYouTubeConnection } from "@/lib/youtube/data";
import { readYouTubeConfig } from "@/lib/youtube/config";

/**
 * Provider-connection readiness for the workspace surfaces.
 *
 * Read-only, and deliberately the SAME rule the Connections page already
 * states: a channel is "connected" only when its own provider row says so AND
 * the publish scope that channel needs was really granted (TikTok
 * `video.publish`, YouTube `youtube.upload`; Instagram's publishing capability
 * is the connected professional account). Nothing here guesses a capability
 * from billing, configuration or a selected channel — an unconfigured
 * deployment reports `configured: false` instead of pretending.
 *
 * A channel whose row cannot be read is omitted rather than reported as
 * "not connected": a failed read is not evidence of a missing connection.
 */
export interface SocialChannelReadiness {
  channel: "instagram" | "tiktok" | "youtube";
  connected: boolean;
  configured: boolean;
}

export const SOCIAL_CHANNEL_READINESS_ORDER: readonly SocialChannelReadiness["channel"][] = ["instagram", "tiktok", "youtube"];

export async function readSocialChannelReadiness(
  db: SupabaseClient,
  ownerId: string,
): Promise<SocialChannelReadiness[]> {
  const youTubeConfig = readYouTubeConfig();
  const tikTokConfig = readTikTokConfig();
  const instagramConfig = readInstagramConfig();

  const [instagram, tikTok, youTube] = await Promise.all([
    getInstagramConnection(db, ownerId, Boolean(instagramConfig))
      .then((row) => ({ connected: Boolean(row.connected), configured: Boolean(row.configured) }))
      .catch(() => null),
    getTikTokConnection(db, ownerId, Boolean(tikTokConfig), tikTokConfig?.appAudited === true)
      .then((row) => ({ connected: Boolean(row?.connected) && Boolean(row?.scopes.includes("video.publish")), configured: Boolean(tikTokConfig) }))
      .catch(() => null),
    getYouTubeConnection(db, ownerId, Boolean(youTubeConfig), youTubeConfig?.projectAudited === true)
      .then((row) => ({ connected: Boolean(row?.connected) && Boolean(row?.scopes.includes("https://www.googleapis.com/auth/youtube.upload")), configured: Boolean(youTubeConfig) }))
      .catch(() => null),
  ]);

  const entries: (SocialChannelReadiness | null)[] = [
    instagram ? { channel: "instagram", ...instagram } : null,
    tikTok ? { channel: "tiktok", ...tikTok } : null,
    youTube ? { channel: "youtube", ...youTube } : null,
  ];
  return entries.filter((entry): entry is SocialChannelReadiness => entry !== null);
}
