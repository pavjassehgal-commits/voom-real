import { getCurrentUser } from "@/lib/voom/server-data";
import { getSocialDraft, updateSocialDraft } from "@/lib/social/server-drafts";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Multi-Social Core — read/edit/approve ONE TikTok or YouTube planning draft.
 *
 * Editing text, setting a schedule, declaring the TikTok privacy or the
 * YouTube audience/privacy and recording an approval all stay inside Voom.
 * Approval is NOT publication on either channel:
 *   - TikTok approval + schedule mirrors the item into the durable
 *     tiktok_publish_queue (migration 0049); only the cron worker uploads,
 *     and only TikTok's own PUBLISH_COMPLETE post status ever establishes
 *     Published.
 *   - YouTube approval + schedule mirrors the item into the durable
 *     youtube_publish_queue (migration 0047); only the cron worker uploads,
 *     and only YouTube's own confirmation (a real video id with
 *     uploadStatus='processed') ever establishes Published.
 * No credit is spent and no media is generated.
 */
const patchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  caption: z.string().trim().max(4000).optional(),
  description: z.string().trim().max(5000).optional(),
  concept: z.string().trim().max(300).optional(),
  script: z.array(z.string().trim().max(400)).max(40).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  decision: z.enum(["approved", "draft"]).optional(),
  /** Explicit YouTube declarations. null CLEARS a declaration (never a guess). */
  madeForKids: z.boolean().nullable().optional(),
  privacy: z.enum(["public", "private", "unlisted"]).nullable().optional(),
  /**
   * Explicit TikTok privacy declaration (TikTok's own four values).
   * null CLEARS the declaration (never a guess) — TikTok has no default
   * privacy level, so an undeclared item waits visibly.
   */
  tiktokPrivacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).nullable().optional(),
}).strict();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That content was not found." }, { status: 404 });
  try {
    const draft = await getSocialDraft(createAdminClient(), user.id, id);
    if (!draft) return Response.json({ error: "That content was not found." }, { status: 404 });
    return Response.json({ draft }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Voom couldn't load that content. Please retry." }, { status: 503 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That content was not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That request was not valid." }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the content details before saving." }, { status: 400 });

  const scheduledAt = parsed.data.scheduledAt;
  if (scheduledAt && Date.parse(scheduledAt) < Date.now() - 5 * 60_000) {
    return Response.json({ error: "Choose a date in the future to schedule this." }, { status: 400 });
  }

  try {
    const draft = await updateSocialDraft(createAdminClient(), user.id, id, parsed.data);
    if (!draft) return Response.json({ error: "That content was not found." }, { status: 404 });
    // Truthful approval messaging per channel: approval enqueues durable
    // execution on the channel's own queue; only the worker — with the
    // provider's own confirmation — can ever call it Published.
    const approvalMessage = draft.channel === "youtube"
      ? draft.scheduledAt
        ? "Approved. It is on the durable YouTube publish queue and uploads at the scheduled time — Published appears only after YouTube confirms the video is processed."
        : "Approved inside Voom. Add a schedule to put it on the YouTube publish queue — nothing has been published."
      : draft.scheduledAt
        ? "Approved. It is on the durable TikTok publish queue and publishes at the scheduled time — Published appears only after TikTok confirms."
        : "Approved inside Voom. Add a schedule to put it on the TikTok publish queue — nothing has been published.";
    return Response.json({
      draft,
      message: parsed.data.decision === "approved"
        ? approvalMessage
        : "Saved inside Voom. Nothing was published.",
    });
  } catch {
    return Response.json({ error: "Voom couldn't save that content. Please retry." }, { status: 503 });
  }
}
