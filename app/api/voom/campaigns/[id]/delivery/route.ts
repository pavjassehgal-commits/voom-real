import { z } from "zod";
import { getCampaign } from "@/lib/mara/internal-data";
import {
  createCampaignSendAttemptKey,
  getCampaignProviderAvailability,
  normalizeCampaignContact,
  readCampaignDelivery,
  sendEmailCampaign,
  sendSmsCampaign,
} from "@/lib/voom/campaign-delivery";
import { getCurrentUser } from "@/lib/voom/server-data";
import type { CampaignRecipientRecord, CampaignSendRecord } from "@/lib/voom/types";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const deliveryPayload = z.object({
  contact: z.string().trim().min(1).max(320),
  contactName: z.string().trim().max(200).optional().or(z.literal("")),
}).strict();

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });

  try {
    const db = await createClient();
    const campaign = await getCampaign(db, user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    return Response.json({ delivery: await readCampaignDelivery(db, user.id, campaign) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Campaign delivery status is temporarily unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That recipient is not valid." }, { status: 400 }); }
  const parsed = deliveryPayload.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the recipient details before sending." }, { status: 400 });

  try {
    const db = await createClient();
    const campaign = await getCampaign(db, user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    if (campaign.status !== "approved") return Response.json({ error: "Approve the campaign before sending it." }, { status: 409 });

    const contact = normalizeCampaignContact(campaign.kind, parsed.data.contact);
    if (!isValidContact(campaign.kind, contact)) return Response.json({ error: campaign.kind === "email" ? "Enter a valid recipient email address." : "Enter a valid phone number in international format." }, { status: 400 });

    const delivery = await readCampaignDelivery(db, user.id, campaign);
    const provider = getCampaignProviderAvailability(campaign.kind);
    if (!provider.configured) {
      return Response.json({ error: `${provider.label} is not configured on the server yet, so Voom cannot send this ${campaign.kind}.`, delivery }, { status: 503 });
    }
    if (!delivery.schemaReady) {
      return Response.json({ error: "Campaign delivery is not available until the delivery migration is applied.", delivery }, { status: 503 });
    }
    if (delivery.recipient && normalizeCampaignContact(campaign.kind, delivery.recipient.contact) !== contact) {
      return Response.json({ error: "This MVP supports one recipient per campaign. Keep the same recipient or create a new campaign.", delivery }, { status: 409 });
    }
    if (delivery.send && ["sending", "accepted", "delivered"].includes(delivery.send.internal_status)) {
      return Response.json({ error: statusConflictMessage(delivery.send), delivery }, { status: 409 });
    }

    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return Response.json({ error: "Campaign delivery is not fully configured on the server yet.", delivery }, { status: 503 });
    }

    const recipientResult = await admin.rpc("add_campaign_recipient", {
      p_owner_user_id: user.id,
      p_campaign_id: id,
      p_contact: contact,
      p_contact_name: parsed.data.contactName || null,
      p_consent_at: new Date().toISOString(),
      p_consent_source: "voom-campaign-manual-send",
    }).single();

    if (recipientResult.error || !recipientResult.data) {
      return Response.json({ error: rpcErrorMessage(recipientResult.error, "Voom couldn't save that recipient safely."), delivery }, { status: rpcStatus(recipientResult.error) });
    }

    const recipient = recipientResult.data as CampaignRecipientRecord;
    const attemptKey = createCampaignSendAttemptKey();
    const claimResult = await admin.rpc("claim_campaign_send", {
      p_owner_user_id: user.id,
      p_campaign_id: id,
      p_recipient_id: recipient.id,
      p_idempotency_key: attemptKey,
    }).single();

    if (claimResult.error || !claimResult.data) {
      const latest = await readCampaignDelivery(db, user.id, campaign);
      return Response.json({ error: rpcErrorMessage(claimResult.error, "Voom couldn't claim that send safely."), delivery: latest }, { status: rpcStatus(claimResult.error) });
    }

    const claimed = claimResult.data as CampaignSendRecord & { idempotency_key?: string | null };
    if (claimed.idempotency_key !== attemptKey) {
      const latest = await readCampaignDelivery(db, user.id, campaign);
      return Response.json({ message: "This campaign already has an active or completed send for its saved recipient.", delivery: latest }, { status: 200 });
    }

    const providerResult = campaign.kind === "email"
      ? await sendEmailCampaign(campaign, recipient)
      : await sendSmsCampaign(campaign, recipient, request.url);

    const recorded = await admin.rpc("record_campaign_send_provider_result", {
      p_owner_user_id: user.id,
      p_send_id: claimed.id,
      p_outcome: providerResult.ok ? "accepted" : "failed",
      p_provider_status: providerResult.providerStatus,
      p_provider_message_id: providerResult.providerMessageId,
      p_error_code: providerResult.errorCode,
      p_error_message: providerResult.errorMessage,
    }).single();

    if (recorded.error) {
      const latest = await readCampaignDelivery(db, user.id, campaign);
      return Response.json({ error: rpcErrorMessage(recorded.error, "The provider responded, but Voom could not store the send status safely."), delivery: latest }, { status: 503 });
    }

    const latest = await readCampaignDelivery(db, user.id, campaign);
    return Response.json({
      message: providerResult.ok
        ? `${provider.label} accepted the ${campaign.kind}. Delivered will appear only after a verified provider callback confirms it.`
        : providerResult.errorMessage || `${provider.label} could not send that ${campaign.kind}.`,
      delivery: latest,
    }, { status: providerResult.ok ? 200 : 502 });
  } catch {
    return Response.json({ error: "Voom couldn't send that campaign safely. Nothing was simulated." }, { status: 503 });
  }
}

function isValidContact(kind: "email" | "sms", contact: string) {
  return kind === "email"
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)
    : /^\+[1-9][0-9]{7,14}$/.test(contact);
}

function statusConflictMessage(send: CampaignSendRecord) {
  if (send.internal_status === "sending") return "This campaign is already being sent to its saved recipient.";
  if (send.internal_status === "accepted") return "The provider already accepted this campaign for its saved recipient.";
  return "This campaign was already delivered to its saved recipient.";
}

function rpcStatus(error: unknown) {
  const text = `${(error as { code?: string })?.code ?? ""} ${(error as { message?: string })?.message ?? ""}`;
  if (/campaign_not_found/.test(text)) return 404;
  if (/campaign_not_approved|recipient_opted_out|recipient_kind_mismatch/.test(text)) return 409;
  if (/invalid_|delivery migration|PGRST202|relation .* does not exist|schema cache/i.test(text)) return 503;
  return 503;
}

function rpcErrorMessage(error: unknown, fallback: string) {
  const text = `${(error as { message?: string })?.message ?? ""}`;
  if (/campaign_not_approved/.test(text)) return "Approve the campaign before sending it.";
  if (/recipient_opted_out/.test(text)) return "That recipient has opted out and cannot be messaged.";
  if (/invalid_email_contact/.test(text)) return "Enter a valid recipient email address.";
  if (/invalid_sms_contact/.test(text)) return "Enter a valid phone number in international format.";
  if (/delivery migration|PGRST202|relation .* does not exist|schema cache/i.test(text)) return "Campaign delivery is not available until the delivery migration is applied.";
  return fallback;
}
