import { approveCampaign, getCampaign, rejectCampaign, updateCampaign } from "@/lib/mara/internal-data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const editFields = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  objective: z.string().trim().max(1000).optional(),
  audience: z.string().trim().max(1000).optional(),
  subject: z.string().trim().max(300).nullable().optional(),
  previewText: z.string().trim().max(500).nullable().optional(),
  content: z.string().trim().max(12000).optional(),
  proposedSendAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

const statusAction = z.object({ action: z.enum(["approve", "reject"]) }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Those campaign changes are not valid." }, { status: 400 }); }
  const parsed = editFields.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json({ error: "Check the campaign details before saving." }, { status: 400 });
  }

  try {
    const campaign = await updateCampaign(await createClient(), user.id, id, {
      name: parsed.data.name,
      objective: parsed.data.objective,
      audience: parsed.data.audience,
      subject: parsed.data.subject,
      preview_text: parsed.data.previewText,
      content: parsed.data.content,
      proposed_send_at: parsed.data.proposedSendAt,
    });
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    return Response.json({ campaign, message: "Draft saved. Nothing has been sent." });
  } catch {
    return Response.json({ error: "Voom couldn't save those changes. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That action is not valid." }, { status: 400 }); }
  const parsed = statusAction.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Choose a valid campaign action." }, { status: 400 });

  try {
    const db = await createClient();
    const campaign = parsed.data.action === "approve"
      ? await approveCampaign(db, user.id, id)
      : await rejectCampaign(db, user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    const message = parsed.data.action === "approve"
      ? "Campaign approved. It is ready to send once a provider is connected — nothing has been sent."
      : "Campaign marked not approved. Nothing has been sent.";
    return Response.json({ campaign, message });
  } catch {
    return Response.json({ error: "Voom couldn't update that campaign. Please retry." }, { status: 503 });
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });
  try {
    const campaign = await getCampaign(await createClient(), user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    return Response.json({ campaign });
  } catch {
    return Response.json({ error: "That campaign couldn't load. Please retry." }, { status: 503 });
  }
}
