import "server-only";

import { Webhook } from "standardwebhooks";
import { createResendClient } from "@/lib/email/client";
import type { ResendApiClient } from "@/lib/email/core";
import type {
  EmailDeliveryProvider,
  EmailProviderSendInput,
  NormalizedEmailDeliveryEvent,
  NormalizedEmailEventStatus,
} from "@/lib/email/provider";

export function createResendDeliveryProvider(
  client: ResendApiClient = createResendClient(),
): EmailDeliveryProvider {
  return {
    id: "resend",
    async send(input) {
      let response: Response;
      try {
        response = await client.post(
          "emails",
          toResendBody(input),
          { headers: { "Idempotency-Key": input.idempotencyKey } },
        );
      } catch {
        return {
          ok: false,
          provider: "resend",
          providerMessageId: null,
          providerStatus: null,
          errorCode: "provider_request_failed",
          errorKind: "network",
          errorMessage: "The email provider request failed safely.",
          ambiguous: true,
        };
      }

      const parsed = await safeProviderBody(response);
      const messageId = firstString(parsed?.id);
      const accepted = response.ok && Boolean(messageId);
      return {
        ok: accepted,
        provider: "resend",
        providerMessageId: messageId,
        providerStatus: firstString(parsed?.last_event) ?? (response.ok ? "accepted" : null),
        errorCode: response.ok
          ? accepted ? null : "provider_outcome_ambiguous"
          : `HTTP_${response.status}`,
        errorKind: response.ok ? accepted ? null : "ambiguous" : "rejected",
        errorMessage: response.ok
          ? accepted ? null : "The provider response did not include a message identifier."
          : providerErrorMessage(parsed, "The email provider couldn't accept that send."),
        ambiguous: response.ok && !accepted,
      };
    },
  };
}

export function verifyResendWebhook(payload: string, headers: Headers, secret: string) {
  return new Webhook(secret).verify(payload, {
    "webhook-id": headers.get("svix-id") ?? "",
    "webhook-timestamp": headers.get("svix-timestamp") ?? "",
    "webhook-signature": headers.get("svix-signature") ?? "",
  }) as Record<string, unknown>;
}

export function normalizeResendWebhook(
  event: Record<string, unknown>,
  headers: Headers,
): NormalizedEmailDeliveryEvent {
  const data = asRecord(event.data);
  const eventType = firstString(event.type) ?? "email.unknown";
  return {
    provider: "resend",
    providerMessageId: firstString(data?.email_id, data?.emailId, data?.id),
    eventId: headers.get("svix-id") ?? firstString(event.id) ?? `resend:${Date.now()}`,
    eventType,
    status: normalizeResendEventStatus(eventType),
    receivedAt: firstString(event.created_at, data?.created_at) ?? new Date().toISOString(),
  };
}

function toResendBody(input: EmailProviderSendInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    preheader: input.preheader,
  };
  if (input.replyTo) body.reply_to = input.replyTo;
  return body;
}

function normalizeResendEventStatus(eventType: string): NormalizedEmailEventStatus {
  const type = eventType.toLowerCase();
  if (type === "email.sent" || type === "email.accepted") return "accepted";
  if (type === "email.delivered") return "delivered";
  if (type === "email.opened") return "opened";
  if (type === "email.clicked") return "clicked";
  if (type === "email.bounced") return "bounced";
  if (type === "email.complained") return "complained";
  if (type === "email.failed" || type === "email.delivery_delayed") return "failed";
  if (type === "email.canceled") return "canceled";
  return "unknown";
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
  const candidate = firstString(body?.message, body?.error, body?.detail, body?.more_info) ?? fallback;
  return candidate.slice(0, 1000);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

