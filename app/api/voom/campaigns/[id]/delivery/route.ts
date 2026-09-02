import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCampaign } from "@/lib/mara/internal-data";
import {
  BULK_SEND_CAP,
  createCampaignSendAttemptKey,
  getCampaignProviderAvailability,
  normalizeCampaignContact,
  readCampaignDelivery,
  sendEmailCampaign,
  sendSmsCampaign,
} from "@/lib/voom/campaign-delivery";
import { planAudienceSend } from "@/lib/voom/audience-send-plan";
import { resolveAudienceChannelEligibility } from "@/lib/contacts/server-data";
import { getCurrentUser } from "@/lib/voom/server-data";
import type { AudienceSendResultEntry, AudienceSendResults, CampaignRecord, CampaignRecipientRecord, CampaignSendRecord } from "@/lib/voom/types";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const singleRecipientPayload = z.object({
  contact: z.string().trim().min(1).max(320),
  contactName: z.string().trim().max(200).optional().or(z.literal("")),
}).strict();

// Explicit confirmation to send to the campaign's linked audience. The
// audience is re-resolved server-side at send time — a client-supplied
// recipient list is never accepted (both branches stay strict).
const audienceSendPayload = z.object({
  audienceSend: z.literal(true),
}).strict();

const deliveryPayload = z.union([singleRecipientPayload, audienceSendPayload]);

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
    // Explicit approval is always required before any send — single recipient
    // or audience.
    if (campaign.status !== "approved") return Response.json({ error: "Approve the campaign before sending it." }, { status: 409 });

    if (campaign.audience_id) {
      if (!("audienceSend" in parsed.data)) {
        return Response.json({ error: "This campaign sends to its linked audience. Confirm the audience send from the campaign editor — individual recipients can't be entered for it." }, { status: 400 });
      }
      return await sendToLinkedAudience(db, user.id, campaign);
    }

    if ("audienceSend" in parsed.data) {
      return Response.json({ error: "No audience is linked to this campaign. Link an audience in the campaign editor, or send to a single recipient." }, { status: 400 });
    }

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
      : await sendSmsCampaign(campaign, recipient);

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

/**
 * Explicit send to the campaign's linked audience.
 *
 * Safety properties:
 * - Requires prior explicit approval (enforced by the caller) plus this
 *   explicit send request — nothing is ever sent automatically.
 * - The audience is re-resolved server-side at send time from live contacts;
 *   the client never supplies recipients.
 * - Eligibility: email needs subscribed + valid email, SMS needs subscribed +
 *   valid E.164 phone; unknown/unsubscribed are excluded and duplicate
 *   destinations are deduped.
 * - STRICT cap: if the audience resolves to more than BULK_SEND_CAP eligible
 *   destinations, the entire send is REFUSED — zero recipients are contacted
 *   and zero provider calls are made. The eligible list is never sliced and
 *   a partial send is impossible (see planAudienceSend).
 * - Reuses the 0018 per-recipient claim lifecycle, so a recipient with an
 *   active or completed send is returned as-is and never resent, while failed
 *   or never-attempted recipients remain safely retryable.
 * - Results are always truthful accepted/failed/skipped; destinations in the
 *   response are masked. Accepted means provider-accepted only — Delivered is
 *   only ever set by a verified provider callback.
 */
async function sendToLinkedAudience(db: SupabaseClient, ownerId: string, campaign: CampaignRecord) {
  const audienceId = campaign.audience_id as string;
  const delivery = await readCampaignDelivery(db, ownerId, campaign);
  const provider = getCampaignProviderAvailability(campaign.kind);
  if (!provider.configured) {
    return Response.json({ error: `${provider.label} is not configured on the server yet, so Voom cannot send this ${campaign.kind}.`, delivery }, { status: 503 });
  }
  if (!delivery.schemaReady) {
    return Response.json({ error: "Campaign delivery is not available until the delivery migration is applied.", delivery }, { status: 503 });
  }

  // Send-time re-resolution: this owner-scoped lookup is also the ownership
  // re-validation, so an audience from another workspace can never be used.
  const eligibility = await resolveAudienceChannelEligibility(db, ownerId, audienceId, campaign.kind);
  if (!eligibility.ok) {
    if (eligibility.error.code === "not_found") {
      return Response.json({ error: "The linked audience was not found in your workspace. Nothing was initiated.", delivery }, { status: 404 });
    }
    return Response.json({ error: "Audience eligibility is temporarily unavailable. Nothing was initiated.", delivery }, { status: 503 });
  }

  const eligible = eligibility.data.eligible;
  if (eligible.length === 0) {
    const latest = await readCampaignDelivery(db, ownerId, campaign);
    return Response.json({
      error: `No contacts in "${eligibility.data.audience.name}" are eligible for this ${campaign.kind} right now — subscribed status plus a valid destination is required. Nothing was initiated.`,
      delivery: latest,
    }, { status: 409 });
  }

  // STRICT over-cap gate: more than BULK_SEND_CAP eligible destinations
  // refuses the ENTIRE send. This returns before the admin client is created
  // and before any add_campaign_recipient, claim_campaign_send, Resend or
  // ClickSend call — zero recipients are contacted and zero provider calls
  // are made. A refused plan exposes no batch to iterate, so a partial or
  // sliced send is impossible.
  const plan = planAudienceSend(eligible, BULK_SEND_CAP);
  if (!plan.ok) {
    const latest = await readCampaignDelivery(db, ownerId, campaign);
    const results: AudienceSendResults = {
      attempted: 0,
      accepted: 0,
      failed: 0,
      skipped: plan.total,
      overLimit: plan.overLimit,
      cap: plan.cap,
      recipients: [],
    };
    return Response.json({
      error: `"${eligibility.data.audience.name}" has ${plan.total} eligible destinations — over the limit of ${plan.cap} per send. The entire send was refused and no recipient was contacted. Narrow the audience to ${plan.cap} or fewer eligible destinations and try again.`,
      results,
      delivery: latest,
    }, { status: 422 });
  }
  const batch = plan.batch;

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return Response.json({ error: "Campaign delivery is not fully configured on the server yet.", delivery }, { status: 503 });
  }

  const recipients: AudienceSendResultEntry[] = [];
  let accepted = 0;
  let failed = 0;
  let skipped = 0;
  const consentAt = new Date().toISOString();

  // Sequential processing keeps this a safe, provider-polite batch and gives
  // each recipient its own truthful outcome.
  for (const target of batch) {
    const recipientResult = await admin.rpc("add_campaign_recipient", {
      p_owner_user_id: ownerId,
      p_campaign_id: campaign.id,
      p_contact: target.destination,
      p_contact_name: target.contactName,
      p_consent_at: consentAt,
      p_consent_source: "voom-campaign-audience-send",
    }).single();

    if (recipientResult.error || !recipientResult.data) {
      failed += 1;
      recipients.push({ destination: target.masked, status: "failed", detail: rpcErrorMessage(recipientResult.error, "Voom couldn't save that recipient safely.") });
      continue;
    }

    const recipient = recipientResult.data as CampaignRecipientRecord;
    const attemptKey = createCampaignSendAttemptKey();
    const claimResult = await admin.rpc("claim_campaign_send", {
      p_owner_user_id: ownerId,
      p_campaign_id: campaign.id,
      p_recipient_id: recipient.id,
      p_idempotency_key: attemptKey,
    }).single();

    if (claimResult.error || !claimResult.data) {
      // e.g. recipient_opted_out: never claimable, left unsent.
      skipped += 1;
      recipients.push({ destination: target.masked, status: "skipped", detail: rpcErrorMessage(claimResult.error, "That recipient couldn't be claimed safely and was left unsent.") });
      continue;
    }

    const claimed = claimResult.data as CampaignSendRecord & { idempotency_key?: string | null };
    if (claimed.idempotency_key !== attemptKey) {
      // The 0018 claim returned the existing row: this recipient already has
      // an active or completed send, so it is never resent.
      skipped += 1;
      recipients.push({ destination: target.masked, status: "skipped", detail: "Already sent or in progress — not sent again." });
      continue;
    }

    const providerResult = campaign.kind === "email"
      ? await sendEmailCampaign(campaign, recipient)
      : await sendSmsCampaign(campaign, recipient);

    const recorded = await admin.rpc("record_campaign_send_provider_result", {
      p_owner_user_id: ownerId,
      p_send_id: claimed.id,
      p_outcome: providerResult.ok ? "accepted" : "failed",
      p_provider_status: providerResult.providerStatus,
      p_provider_message_id: providerResult.providerMessageId,
      p_error_code: providerResult.errorCode,
      p_error_message: providerResult.errorMessage,
    }).single();

    if (recorded.error) {
      failed += 1;
      recipients.push({ destination: target.masked, status: "failed", detail: "The provider responded, but Voom could not store the send status safely." });
      continue;
    }

    if (providerResult.ok) {
      accepted += 1;
      recipients.push({ destination: target.masked, status: "accepted", detail: `${provider.label} accepted the ${campaign.kind}.` });
    } else {
      failed += 1;
      recipients.push({ destination: target.masked, status: "failed", detail: providerResult.errorMessage || `${provider.label} could not send that ${campaign.kind}.` });
    }
  }

  // plan.ok guarantees the whole eligible set fits within the cap.
  const results: AudienceSendResults = { attempted: batch.length, accepted, failed, skipped, overLimit: 0, cap: BULK_SEND_CAP, recipients };
  const latest = await readCampaignDelivery(db, ownerId, campaign);

  const summary = accepted === 0 && failed === 0 && skipped > 0
    ? `No new sends were needed in "${eligibility.data.audience.name}": every eligible recipient already has an active or completed send, and successful recipients are never resent.`
    : `${provider.label} run finished for "${eligibility.data.audience.name}": ${accepted} accepted, ${failed} failed, ${skipped} skipped (already sent or in progress) out of ${eligible.length} eligible destination${eligible.length === 1 ? "" : "s"}.`;
  const trackingNote = " Accepted means the provider took the message; Delivered is only ever set by a verified provider callback.";
  const message = `${summary}${trackingNote}`;

  const allFailed = batch.length > 0 && failed === batch.length;
  return Response.json(
    allFailed
      ? { error: `All ${failed} send attempts failed. ${message}`, results, delivery: latest }
      : { message, results, delivery: latest },
    { status: allFailed ? 502 : 200 },
  );
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
