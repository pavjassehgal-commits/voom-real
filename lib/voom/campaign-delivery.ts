import "server-only";

import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createResendClient } from "@/lib/email/client";
import { getResendAvailability } from "@/lib/email/config";
import { resolveAudienceChannelEligibility } from "@/lib/contacts/server-data";
import type { AudienceChannelEligibility, AudienceEligibilityPreview } from "@/lib/contacts/types";
import type { CampaignRecord, CampaignRecipientRecord, CampaignSendRecord, CampaignDeliveryView, CampaignProviderAvailability, CampaignDeliveryState, CampaignSendSummary } from "./types";

/**
 * Maximum recipients an audience send may target. STRICT semantics: a
 * campaign whose audience resolves to more eligible destinations than this
 * cap has its entire send refused — zero recipients are contacted and zero
 * provider calls are made. The eligible list is never sliced.
 */
export const BULK_SEND_CAP = 100;

export function getCampaignProviderAvailability(kind: CampaignRecord["kind"]): CampaignProviderAvailability {
  if (kind === "email") {
    const config = getResendAvailability();
    return {
      provider: "resend",
      label: "Resend",
      configured: config.configured,
      deliveryTrackingConfigured: config.webhookConfigured,
      missingEnv: config.missingEnv,
    };
  }

  // SMS marketing was removed from the active Voom product (and automated
  // multi-channel campaigns never send from this helper). Historical SMS
  // campaigns stay readable, but no provider is configured or callable: the
  // delivery route refuses new SMS execution with a 410, and nothing here
  // imports an SMS client.
  return {
    provider: "retired",
    label: kind === "multi" ? "Automated campaign" : "SMS (retired)",
    configured: false,
    deliveryTrackingConfigured: false,
    missingEnv: [],
  };
}

/** The single delivery channel kind supported by the active product. */
function deliveryKindOf(campaign: CampaignRecord): "email" | "sms" {
  return campaign.kind === "email" ? "email" : "sms";
}

export async function readCampaignDelivery(db: SupabaseClient, ownerId: string, campaign: CampaignRecord): Promise<CampaignDeliveryView> {
  const provider = getCampaignProviderAvailability(campaign.kind);

  try {
    const [recipientResult, sendResult, sendsResult] = await Promise.all([
      db.from("campaign_recipients")
        .select("id,contact,contact_name,consent_at,consent_source,opt_out_at,created_at,updated_at")
        .eq("owner_user_id", ownerId)
        .eq("campaign_id", campaign.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("campaign_sends")
        .select("id,recipient_id,channel,provider,provider_message_id,provider_status,internal_status,attempts,last_error_code,last_error_message,claimed_at,accepted_at,delivered_at,created_at,updated_at")
        .eq("owner_user_id", ownerId)
        .eq("campaign_id", campaign.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // All recorded sends for truthful aggregate counts. Capped sends mean
      // this stays small (see BULK_SEND_CAP).
      db.from("campaign_sends")
        .select("internal_status")
        .eq("owner_user_id", ownerId)
        .eq("campaign_id", campaign.id),
    ]);

    if (recipientResult.error || sendResult.error || sendsResult.error) {
      if (isDeliverySchemaMissing(recipientResult.error) || isDeliverySchemaMissing(sendResult.error) || isDeliverySchemaMissing(sendsResult.error)) {
        return fallbackDelivery(campaign, provider, "Campaign delivery is not available until the delivery migration is applied.");
      }
      throw recipientResult.error || sendResult.error || sendsResult.error;
    }

    const recipient = ((recipientResult.data as CampaignRecipientRecord | null) ?? null);
    const send = ((sendResult.data as CampaignSendRecord | null) ?? null);
    const sendsSummary = summarizeCampaignSends(sendsResult.data);
    const state = getCampaignDeliveryState(campaign.status, send);

    // Audience campaigns: re-resolve eligibility server-side on every read so
    // the UI never displays stale or client-decided recipient data.
    let audience: AudienceEligibilityPreview | null = null;
    let audienceNote: string | null = null;
    if (campaign.audience_id && campaign.kind !== "multi") {
      const eligibility = await resolveAudienceChannelEligibility(db, ownerId, campaign.audience_id, deliveryKindOf(campaign));
      if (eligibility.ok) {
        audience = toAudienceEligibilityPreview(eligibility.data);
      } else if (eligibility.error.code === "not_found") {
        audienceNote = "The linked audience was not found. Choose an audience again before sending.";
      } else {
        throw new Error(eligibility.error.code);
      }
    }

    return {
      recipient,
      send,
      audience,
      sendsSummary,
      state,
      provider,
      canSend: campaign.status === "approved" && provider.configured && (
        campaign.audience_id
          // Over-cap audiences must be refused entirely — sending stays
          // blocked until the audience is narrowed back within the cap.
          ? audience !== null && audience.eligibleCount > 0 && audience.overLimitCount === 0
          : (!send || send.internal_status === "failed")
      ),
      note: audienceNote ?? buildDeliveryNote(campaign, provider, send, audience, sendsSummary),
      schemaReady: true,
    };
  } catch {
    return fallbackDelivery(campaign, provider, "Campaign delivery is temporarily unavailable.");
  }
}

/** Browser-safe eligibility preview: masked destinations only, never raw. */
export function toAudienceEligibilityPreview(eligibility: AudienceChannelEligibility): AudienceEligibilityPreview {
  return {
    audience: {
      id: eligibility.audience.id,
      name: eligibility.audience.name,
      type: eligibility.audience.type,
    },
    channel: eligibility.channel,
    totalMembers: eligibility.totalMembers,
    eligibleCount: eligibility.eligibleCount,
    excludedCount: eligibility.excludedCount,
    duplicateCount: eligibility.duplicateCount,
    sendCap: BULK_SEND_CAP,
    overLimitCount: Math.max(0, eligibility.eligibleCount - BULK_SEND_CAP),
    recipients: eligibility.eligible.map((r) => ({
      contactId: r.contactId,
      destination: r.masked,
      contactName: r.contactName,
    })),
  };
}

function summarizeCampaignSends(rows: Array<{ internal_status?: string | null }> | null): CampaignSendSummary {
  const summary: CampaignSendSummary = { total: 0, queued: 0, sending: 0, accepted: 0, delivered: 0, failed: 0, skipped: 0 };
  for (const row of rows ?? []) {
    const status = row.internal_status;
    if (status === "queued" || status === "sending" || status === "accepted" || status === "delivered" || status === "failed" || status === "skipped") {
      summary[status] += 1;
      summary.total += 1;
    }
  }
  return summary;
}

/** Normalizes a single email destination. SMS was retired; only email sends. */
export function normalizeCampaignContact(value: string) {
  return value.trim().toLowerCase();
}

export function getCampaignDeliveryState(status: CampaignRecord["status"], send: CampaignSendRecord | null): CampaignDeliveryState | null {
  if (send?.internal_status === "sending") return "sending";
  if (send?.internal_status === "accepted") return "accepted";
  if (send?.internal_status === "delivered") return "delivered";
  if (send?.internal_status === "failed") return "failed";
  if (status === "approved") return "ready";
  return null;
}

export function createCampaignSendAttemptKey() {
  return randomUUID();
}

export async function sendEmailCampaign(campaign: CampaignRecord, recipient: CampaignRecipientRecord) {
  const client = createResendClient();
  const response = await client.post("emails", {
    from: `${client.config.fromName} <${client.config.fromAddress}>`,
    to: [recipient.contact],
    subject: campaign.subject?.trim() || campaign.name,
    text: campaign.content,
  });
  const body = await safeProviderBody(response);
  return {
    ok: response.ok && typeof body?.id === "string" && body.id.length > 0,
    providerMessageId: typeof body?.id === "string" ? body.id : null,
    providerStatus: typeof body?.last_event === "string" ? body.last_event : "accepted",
    errorCode: response.ok ? null : `HTTP_${response.status}`,
    errorMessage: response.ok ? null : providerErrorMessage(body, "Resend couldn't accept that email send."),
  };
}

export function verifyResendWebhook(payload: string, headers: Headers, secret: string) {
  return new Webhook(secret).verify(payload, {
    "webhook-id": headers.get("svix-id") ?? "",
    "webhook-timestamp": headers.get("svix-timestamp") ?? "",
    "webhook-signature": headers.get("svix-signature") ?? "",
  }) as Record<string, unknown>;
}

export async function recordDeliveryFromWebhook(db: SupabaseClient, input: { provider: "resend" | "twilio"; providerMessageId: string | null; eventId: string; eventType: string; receivedAt: string; providerStatus: string | null }) {
  if (!input.providerMessageId) return;

  // 1) Campaign sends (0018 lifecycle).
  const sendResult = await db.from("campaign_sends")
    .select("id,owner_user_id,recipient_id")
    .eq("provider", input.provider)
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();

  if (!sendResult.error && sendResult.data) {
    await db.rpc("record_campaign_delivery_event", {
      p_owner_user_id: sendResult.data.owner_user_id,
      p_send_id: sendResult.data.id,
      p_provider: input.provider,
      p_event_id: input.eventId,
      p_event_type: input.eventType,
      p_received_at: input.receivedAt,
      p_provider_status: input.providerStatus,
    });
    // A bounce or complaint is durable evidence about the ADDRESS, not just
    // about one send. Without this the contact stayed 'subscribed' and the
    // next campaign or lifecycle email went to the same dead address again.
    await suppressFromProviderEvent(db, {
      ownerId: String(sendResult.data.owner_user_id),
      provider: input.provider,
      eventType: input.eventType,
      providerStatus: input.providerStatus,
      eventId: input.eventId,
      recipientId: (sendResult.data as { recipient_id?: string | null }).recipient_id ?? null,
    });
    return;
  }

  // 2) Lifecycle flow sends (0040). One webhook route serves both: Voom has a
  //    single email provider and a single delivery-event intake.
  const runResult = await db.from("voom_email_flow_step_runs")
    .select("id,owner_user_id")
    .eq("provider", "resend")
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();

  if (runResult.error || !runResult.data) return;
  if (input.provider !== "resend") return;

  await db.rpc("record_email_flow_delivery_event", {
    p_owner_user_id: runResult.data.owner_user_id,
    p_send_id: runResult.data.id,
    p_provider: "resend",
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_received_at: input.receivedAt,
    p_provider_status: input.providerStatus,
  });
}

const SUPPRESSION_EVENTS: Record<string, "bounced" | "complained"> = {
  "email.bounced": "bounced",
  "email.complained": "complained",
  bounced: "bounced",
  complained: "complained",
};

/**
 * Records durable suppression from a verified provider event, for the campaign
 * path. The lifecycle path records its own suppression inside
 * `record_email_flow_delivery_event`. Both write the same table, so one bounce
 * stops every future send to that address.
 */
async function suppressFromProviderEvent(
  db: SupabaseClient,
  input: {
    ownerId: string;
    provider: string;
    eventType: string;
    providerStatus: string | null;
    eventId: string;
    recipientId: string | null;
  },
) {
  const normalized = (input.providerStatus ?? input.eventType ?? "").toLowerCase();
  const reason = SUPPRESSION_EVENTS[normalized];
  if (!reason || !input.recipientId) return;

  try {
    const { data: recipient, error } = await db.from("campaign_recipients")
      .select("contact")
      .eq("owner_user_id", input.ownerId)
      .eq("id", input.recipientId)
      .maybeSingle();
    const address = (recipient as { contact?: string } | null)?.contact;
    if (error || !address) return;

    await db.rpc("record_email_suppression", {
      p_owner_user_id: input.ownerId,
      p_email: address,
      p_reason: reason,
      p_provider: input.provider === "resend" ? "resend" : null,
      p_provider_event_id: input.eventId,
      p_detail: "Recorded from a verified provider delivery event.",
    });
  } catch {
    // Suppression is a safety net; a failure to record it must not fail the
    // webhook, and the send row above is already updated.
  }
}

function fallbackDelivery(campaign: CampaignRecord, provider: CampaignProviderAvailability, note: string): CampaignDeliveryView {
  return {
    recipient: null,
    send: null,
    audience: null,
    sendsSummary: { total: 0, queued: 0, sending: 0, accepted: 0, delivered: 0, failed: 0, skipped: 0 },
    state: campaign.status === "approved" ? "ready" : null,
    provider,
    canSend: false,
    note,
    schemaReady: false,
  };
}

function buildDeliveryNote(campaign: CampaignRecord, provider: CampaignProviderAvailability, send: CampaignSendRecord | null, audience: AudienceEligibilityPreview | null = null, sendsSummary: CampaignSendSummary | null = null) {
  if (campaign.status !== "approved") return "Approve the campaign before sending anything externally.";
  if (!provider.configured) return `${provider.label} is not configured on the server yet, so Voom cannot send this campaign.`;

  if (campaign.audience_id && audience) {
    const progress = sendsSummary && sendsSummary.total > 0
      ? ` So far: ${sendsSummary.accepted} accepted, ${sendsSummary.delivered} delivered, ${sendsSummary.failed} failed. Successful recipients are never resent.`
      : "";
    if (audience.eligibleCount === 0) {
      return `No contacts in “${audience.audience.name}” are eligible for ${campaign.kind} right now — subscribed status plus a valid destination is required. Nothing would be sent.${progress}`;
    }
    const capNote = audience.overLimitCount > 0
      ? ` Sending is blocked: ${audience.eligibleCount} eligible destinations exceed the ${audience.sendCap}-recipient limit, and an over-limit send is refused entirely. Narrow the audience to ${audience.sendCap} or fewer eligible destinations to send.`
      : "";
    const trackingNote = !provider.deliveryTrackingConfigured
      ? ` ${provider.label} sends stay at Accepted — Delivered is only set by a verified provider callback.`
      : " Delivered is only set by a verified provider callback.";
    return `This approved campaign sends to “${audience.audience.name}”: ${audience.eligibleCount} eligible ${campaign.kind} destination${audience.eligibleCount === 1 ? "" : "s"} (re-resolved at send time; unsubscribed, unknown and duplicate entries are excluded).${capNote}${trackingNote}${progress}`;
  }

  if (send?.internal_status === "accepted" && !provider.deliveryTrackingConfigured) return `${provider.label} accepted the send. Delivery will stay at Accepted until verified callback tracking is configured.`;
  if (send?.internal_status === "accepted") return `${provider.label} accepted the message. Delivered appears only after a verified provider callback confirms it.`;
  if (send?.internal_status === "delivered") return "Delivered was verified by the provider callback.";
  if (send?.internal_status === "failed") return send.last_error_message || "The provider reported a failure. Review the recipient and retry if appropriate.";
  if (send?.internal_status === "sending") return "Voom is waiting for the provider response.";
  if (!provider.deliveryTrackingConfigured && campaign.kind === "email") return "Resend sending can work, but Delivered requires the verified Resend webhook to be configured.";
  return `This approved campaign is ready to send through ${provider.label}.`;
}

function isDeliverySchemaMissing(error: unknown) {
  const text = `${(error as { code?: string })?.code ?? ""} ${(error as { message?: string })?.message ?? ""}`;
  return /PGRST20[24]|campaign_(recipients|sends|delivery_events)|relation .* does not exist|schema cache/i.test(text);
}

async function safeProviderBody(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text } satisfies Record<string, unknown>;
  }
}

function providerErrorMessage(body: Record<string, unknown> | null, fallback: string) {
  const candidate = typeof body?.message === "string"
    ? body.message
    : typeof body?.error === "string"
      ? body.error
      : typeof body?.detail === "string"
        ? body.detail
        : typeof body?.more_info === "string"
          ? body.more_info
          : fallback;
  return candidate.slice(0, 1000);
}
