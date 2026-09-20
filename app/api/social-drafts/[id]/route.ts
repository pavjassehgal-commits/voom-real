import { getCurrentUser } from "@/lib/voom/server-data";
import { getSocialDraft, updateSocialDraft } from "@/lib/social/server-drafts";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Multi-Social Core — read/edit/approve ONE TikTok or YouTube planning draft.
 *
 * Everything here stays inside Voom: editing text, setting a schedule and
 * recording an approval. Approval is NOT publication — no TikTok/YouTube
 * provider integration exists, and this route never pretends otherwise.
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
    return Response.json({
      draft,
      // Truthful: approving records the decision inside Voom. TikTok/YouTube
      // publishing is not connected, so nothing external happened.
      message: parsed.data.decision === "approved"
        ? "Approved inside Voom. Publishing starts when the provider connection exists — nothing was published."
        : "Saved inside Voom. Nothing was published.",
    });
  } catch {
    return Response.json({ error: "Voom couldn't save that content. Please retry." }, { status: 503 });
  }
}
