import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * The owner's explicit TikTok privacy default.
 *
 * TikTok has NO default privacy level: this is an OPTIONAL owner-level
 * declaration that fills gaps for items that carry no explicit declaration
 * of their own. Setting it to null clears the default — undeclared items
 * then park visibly in `needs_declaration`. Voom never invents a default
 * here: until the owner speaks, the system stays silent rather than
 * guessing a policy-sensitive value. The live creator-info options TikTok
 * returns still win at publish time.
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
