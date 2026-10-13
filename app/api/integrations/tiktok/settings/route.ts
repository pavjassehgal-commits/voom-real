import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * The owner's stored TikTok privacy default (legacy).
 *
 * TikTok's Content Sharing Guidelines require a manual privacy choice with no
 * default for every post, so this value is NO LONGER used for posting: every
 * TikTok post takes its privacy from the owner's confirmation in the "Post to
 * TikTok" sheet (lib/tiktok/post-consent.ts). The route is kept so existing
 * stored values can still be cleared; it can never make Voom post.
 */
const settingsSchema = z.object({
  defaultPrivacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).nullable(),
}).strict();

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That request was not valid." }, { status: 400 }); }
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the TikTok settings before saving." }, { status: 400 });
  try {
    const { data, error } = await createAdminClient().rpc("set_tiktok_publish_defaults", {
      p_owner_user_id: user.id,
      p_default_privacy: parsed.data.defaultPrivacy,
    });
    if (error) throw new Error("tiktok_settings_save_failed");
    if (!data) return Response.json({ error: "Connect a TikTok account before saving publishing defaults." }, { status: 409 });
    return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Voom couldn't save those TikTok settings. Please retry." }, { status: 503 });
  }
}
