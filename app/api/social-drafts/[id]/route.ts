import { getCurrentUser } from "@/lib/voom/server-data";
import { getSocialDraft, updateSocialDraft } from "@/lib/social/server-drafts";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Multi-Social Core — read/edit/approve ONE TikTok or YouTube planning draft.
 *
 * Editing text, setting a schedule, declaring the YouTube audience/privacy
 * and recording an approval all stay inside Voom. Approval is NOT
 * publication on either channel:
 *   - TikTok has no provider integration at all — nothing external happens.
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
    // Truthful approval messaging per channel: TikTok stays inside Voom;
    // YouTube approval enqueues durable execution that only the worker (with
    // YouTube's own confirmation) can ever call Published.
    const approvalMessage = draft.channel === "youtube"
      ? draft.scheduledAt
        ? "Approved. It is on the durable YouTube publish queue and uploads at the scheduled time — Published appears only after YouTube confirms the video is processed."
        : "Approved inside Voom. Add a schedule to put it on the YouTube publish queue — nothing has been published."
      : "Approved inside Voom. TikTok publishing is not connected, so nothing was published.";
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
