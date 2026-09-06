import { InstagramClient } from "@/lib/instagram/client";
import { instagramKeyRing, requireInstagramConfig } from "@/lib/instagram/config";
import { getInstagramServerCredentials } from "@/lib/instagram/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const config = requireInstagramConfig();
    const admin = createAdminClient();
    const credentials = await getInstagramServerCredentials(admin, user.id, instagramKeyRing(config));
    const client = new InstagramClient(config);
    const [insightResult, mediaResult] = await Promise.allSettled([
      client.getAccountInsights(credentials.accessToken),
      client.getMedia(credentials.accessToken),
    ]);
    const insights = insightResult.status === "fulfilled" ? insightResult.value : [];
    const media = mediaResult.status === "fulfilled" ? mediaResult.value : [];
    if (insightResult.status === "rejected" && mediaResult.status === "rejected") throw new Error("instagram_reads_failed");
    const metrics = Object.fromEntries(insights.flatMap((item) => {
      const name = typeof item.name === "string" ? item.name : null;
      const value = item.total_value && typeof item.total_value === "object" && !Array.isArray(item.total_value)
        ? (item.total_value as Record<string, unknown>).value
        : null;
      return name && typeof value === "number" ? [[name, value]] : [];
    }));
    if (insightResult.status === "fulfilled") await admin.from("instagram_insight_snapshots").insert({
      owner_user_id: user.id,
      instagram_media_id: null,
      period_start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      period_end: new Date().toISOString(),
      metrics,
    });
    return Response.json({ metrics, media: media.map(sanitizeMedia), syncedAt: new Date().toISOString(), metricsAvailable: insightResult.status === "fulfilled", mediaAvailable: mediaResult.status === "fulfilled" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Instagram insights are temporarily unavailable. Please retry." }, { status: 503 });
  }
}

function sanitizeMedia(item: Record<string, unknown>) {
  return {
    id: String(item.id ?? ""),
    caption: typeof item.caption === "string" ? item.caption : "",
    mediaType: typeof item.media_type === "string" ? item.media_type : "UNKNOWN",
    mediaUrl: typeof item.media_url === "string" ? item.media_url : null,
    thumbnailUrl: typeof item.thumbnail_url === "string" ? item.thumbnail_url : null,
    permalink: typeof item.permalink === "string" ? item.permalink : null,
    timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
    likes: typeof item.like_count === "number" ? item.like_count : 0,
    comments: typeof item.comments_count === "number" ? item.comments_count : 0,
  };
}
