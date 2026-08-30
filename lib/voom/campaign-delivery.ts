import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Webhook } from "standardwebhooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createResendClient } from "@/lib/email/client";
import { getResendAvailability } from "@/lib/email/config";
import { createTwilioClient } from "@/lib/sms/client";
import { getTwilioAvailability, requireTwilioConfig } from "@/lib/sms/config";
import { resolveSiteUrl } from "@/utils/site-url";
import type { CampaignRecord, CampaignRecipientRecord, CampaignSendRecord, CampaignDeliveryView, CampaignProviderAvailability, CampaignDeliveryState } from "./types";

export function getCampaignProviderAvailability(kind: "email" | "sms"): CampaignProviderAvailability {
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

  const config = getTwilioAvailability();
  return {
    provider: "twilio",
    label: "Twilio",
    configured: config.configured,
    deliveryTrackingConfigured: config.configured,
    missingEnv: config.missingEnv,
  };
}

export async function readCampaignDelivery(db: SupabaseClient, ownerId: string, campaign: CampaignRecord): Promise<CampaignDeliveryView> {
  const provider = getCampaignProviderAvailability(campaign.kind);

  try {
    const [recipientResult, sendResult] = await Promise.all([
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
    ]);

    if (recipientResult.error || sendResult.error) {
      if (isDeliverySchemaMissing(recipientResult.error) || isDeliverySchemaMissing(sendResult.error)) {
        return fallbackDelivery(campaign, provider, "Campaign delivery is not available until the delivery migration is applied.");
      }
      throw recipientResult.error || sendResult.error;
    }

    const recipient = ((recipientResult.data as CampaignRecipientRecord | null) ?? null);
    const send = ((sendResult.data as CampaignSendRecord | null) ?? null);
    const state = getCampaignDeliveryState(campaign.status, send);

    return {
      recipient,
      send,
      state,
      provider,
      canSend: campaign.status === "approved" && provider.configured && (!send || send.internal_status === "failed"),
      note: buildDeliveryNote(campaign, provider, send),
      schemaReady: true,
    };
  } catch {
    return fallbackDelivery(campaign, provider, "Campaign delivery is temporarily unavailable.");
  }
}

export function normalizeCampaignContact(kind: "email" | "sms", value: string) {
  const trimmed = value.trim();
  return kind === "email" ? trimmed.toLowerCase() : trimmed;
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

export async function sendSmsCampaign(campaign: CampaignRecord, recipient: CampaignRecipientRecord, requestUrl: string) {
  const config = requireTwilioConfig();
  const callbackUrl = new URL("/api/webhooks/twilio/status", resolveSiteUrl(new URL(requestUrl).origin).toString()).toString();
  const client = createTwilioClient();
  const response = await client.postForm("Messages.json", {
    MessagingServiceSid: config.messagingServiceSid,
    To: recipient.contact,
    Body: campaign.content,
    StatusCallback: callbackUrl,
  });
  const body = await safeProviderBody(response);
  return {
    ok: response.ok && typeof body?.sid === "string" && body.sid.length > 0,
    providerMessageId: typeof body?.sid === "string" ? body.sid : null,
    providerStatus: typeof body?.status === "string" ? body.status : "accepted",
    errorCode: response.ok ? null : String(body?.code ?? `HTTP_${response.status}`),
    errorMessage: response.ok ? null : providerErrorMessage(body, "Twilio couldn't accept that SMS send."),
  };
}

export function verifyResendWebhook(payload: string, headers: Headers, secret: string) {
  return new Webhook(secret).verify(payload, {
    "webhook-id": headers.get("svix-id") ?? "",
    "webhook-timestamp": headers.get("svix-timestamp") ?? "",
    "webhook-signature": headers.get("svix-signature") ?? "",
  }) as Record<string, unknown>;
}

export function verifyTwilioSignature(input: { authToken: string; url: string; params: Record<string, string>; signature: string | null }) {
  if (!input.signature) return false;
  let signed = input.url;
  for (const [key, value] of Object.entries(input.params).sort(([a], [b]) => a.localeCompare(b))) {
    signed += key + value;
  }
  const expected = createHmac("sha1", input.authToken).update(Buffer.from(signed, "utf8")).digest("base64");
  const actualBuffer = Buffer.from(input.signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function recordDeliveryFromWebhook(db: SupabaseClient, input: { provider: "resend" | "twilio"; providerMessageId: string | null; eventId: string; eventType: string; receivedAt: string; providerStatus: string | null }) {
  if (!input.providerMessageId) return;
  const sendResult = await db.from("campaign_sends")
    .select("id,owner_user_id")
    .eq("provider", input.provider)
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();
  if (sendResult.error || !sendResult.data) return;
  await db.rpc("record_campaign_delivery_event", {
    p_owner_user_id: sendResult.data.owner_user_id,
    p_send_id: sendResult.data.id,
    p_provider: input.provider,
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_received_at: input.receivedAt,
    p_provider_status: input.providerStatus,
  });
}

function fallbackDelivery(campaign: CampaignRecord, provider: CampaignProviderAvailability, note: string): CampaignDeliveryView {
  return {
    recipient: null,
    send: null,
    state: campaign.status === "approved" ? "ready" : null,
    provider,
    canSend: false,
    note,
    schemaReady: false,
  };
}

function buildDeliveryNote(campaign: CampaignRecord, provider: CampaignProviderAvailability, send: CampaignSendRecord | null) {
  if (campaign.status !== "approved") return "Approve the campaign before sending anything externally.";
  if (!provider.configured) return `${provider.label} is not configured on the server yet, so Voom cannot send this campaign.`;
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
