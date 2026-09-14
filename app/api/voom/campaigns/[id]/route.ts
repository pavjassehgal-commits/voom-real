import { approveCampaign, getCampaign, rejectCampaign, updateCampaign } from "@/lib/mara/internal-data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { readAutomatedCampaign } from "@/lib/campaign/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Legacy single-channel email draft editing. SMS is no longer editable
// (historical SMS rows stay read-only); automated campaigns are managed on
// the timeline, so kind is accepted-and-ignored for legacy email clients only.
const editFields = z.object({
  kind: z.literal("email").optional(),
  name: z.string().trim().min(1).max(160).optional(),
  objective: z.string().trim().max(1000).optional(),
  audience: z.string().trim().max(1000).optional(),
  audienceId: z.string().trim().regex(UUID_VALUE_RE).nullable().optional(),
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
    const rawKind = (body as { kind?: unknown } | null)?.kind;
    if (rawKind === "sms") {
      return Response.json({ error: "SMS campaigns are read-only in Voom now." }, { status: 400 });
    }
    return Response.json({ error: "Check the campaign details before saving." }, { status: 400 });
  }

  try {
    const db = await createClient();
    const existing = await getCampaign(db, user.id, id);
    if (!existing) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    if (existing.kind === "multi" || existing.is_automated) {
      return Response.json({ error: "MARA-built campaigns are managed on their timeline, not as one draft." }, { status: 409 });
    }
    if (existing.kind === "sms") {
      return Response.json({ error: "SMS marketing is no longer active in Voom. This historical campaign is read-only." }, { status: 410 });
    }

    let audienceId: string | null | undefined;
    if (parsed.data.audienceId !== undefined) {
      if (parsed.data.audienceId === null) {
        audienceId = null;
      } else {
        const { data: audience, error: audienceError } = await db
          .from("audiences")
          .select("id")
          .eq("owner_id", user.id)
          .eq("id", parsed.data.audienceId)
          .maybeSingle();
        if (audienceError) {
          return Response.json({ error: "Voom couldn't verify that audience. Please retry." }, { status: 503 });
        }
        if (!audience) {
          return Response.json({ error: "That audience was not found in your workspace." }, { status: 404 });
        }
        audienceId = audience.id;
      }
    }

    const campaign = await updateCampaign(db, user.id, id, {
      name: parsed.data.name,
      objective: parsed.data.objective,
      audience: parsed.data.audience,
      audience_id: audienceId,
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
    const existing = await getCampaign(db, user.id, id);
    if (!existing) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    if (existing.kind === "multi" || existing.is_automated) {
      return Response.json({ error: "Approve this MARA-built campaign one timeline action at a time." }, { status: 409 });
    }
    if (existing.kind === "sms") {
      return Response.json({ error: "SMS marketing is no longer active in Voom. This historical campaign is read-only." }, { status: 410 });
    }

    const adminCampaign = await tryAdminCampaignApproval(user.id, id, parsed.data.action);
    if (adminCampaign) {
      const message = parsed.data.action === "approve"
        ? "Campaign approved. It is ready for an explicit send. Nothing has been sent."
        : "Campaign marked not approved. Nothing has been sent.";
      return Response.json({ campaign: adminCampaign, message });
    }

    const campaign = parsed.data.action === "approve"
      ? await approveCampaign(db, user.id, id)
      : await rejectCampaign(db, user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    const message = parsed.data.action === "approve"
      ? "Campaign approved. It is ready for an explicit send. Nothing has been sent."
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
    const db = await createClient();
    const campaign = await getCampaign(db, user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    if (campaign.kind === "multi") {
      const automated = await readAutomatedCampaign(db, user.id, id);
      if (!automated) return Response.json({ error: "That campaign was not found." }, { status: 404 });
      return Response.json({ campaign, automated }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ campaign }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "That campaign couldn't load. Please retry." }, { status: 503 });
  }
}

async function tryAdminCampaignApproval(ownerId: string, campaignId: string, action: "approve" | "reject") {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("set_voom_campaign_approval", {
      p_owner_user_id: ownerId,
      p_campaign_id: campaignId,
      p_action: action,
    }).single();
    if (error) {
      const message = `${error.code ?? ""} ${error.message ?? ""}`;
      if (/PGRST202|set_voom_campaign_approval|campaign_not_found|relation .* does not exist|schema cache/i.test(message)) return null;
      throw error;
    }
    return data;
  } catch (error) {
    if (`${(error as { message?: string })?.message ?? ""}`.includes("supabase_admin_not_configured")) return null;
    throw error;
  }
}
