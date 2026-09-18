/**
 * Email Automation v2 — the send adapter over the EXISTING Resend
 * infrastructure. There is no second email sender in Voom: this module uses
 * `createResendClient()` from `@/lib/email/client`, the same client the
 * campaign delivery path uses.
 *
 * Truthfulness: a successful response here means the provider ACCEPTED the
 * message. It is never treated as a delivery. `delivered` is only ever set by
 * a verified Resend webhook (`record_email_flow_delivery_event`).
 */

import "server-only";

import { createResendClient } from "@/lib/email/client";
import type { ResendApiClient } from "@/lib/email/core";

export interface FlowSendDeps {
  /** Test seam. Production uses the configured Resend client. */
  client?: ResendApiClient;
}

export interface FlowSendInput {
  /** Raw recipient address. Server-only — never returned to a browser. */
  to: string;
  subject: string;
  body: string;
  /**
   * Branded optional fields: when provided (the Branded Email Engine path),
   * the resolved sender identity, reply-to and the premium HTML are sent.
   * When absent (legacy callers/tests), the Voom-managed identity and the
   * plain-text body are sent exactly as before.
   */
  html?: string;
  text?: string;
  replyTo?: string | null;
  fromName?: string | null;
  fromAddress?: string | null;
  /**
   * Stable per step run (the run's own idempotency key). Resend deduplicates
   * on this header, so even if Voom's own claim guard were ever bypassed by a
   * timeout-and-retry, the provider would not send the same message twice.
   */
  idempotencyKey: string;
  /** Contact first name for the `{firstName}` token, or null. */
  firstName?: string | null;
}

export interface FlowSendResult {
  ok: boolean;
  providerMessageId: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Replaces the `{firstName}` token with the contact's real first name, or a
 * neutral greeting word when the contact has none. No other templating exists:
 * Voom never interpolates data it does not own.
 */
export function personalizeFlowBody(body: string, firstName: string | null | undefined): string {
  const name = (firstName ?? "").trim();
  return body.replace(/\{firstName\}/g, name || "there");
}

export async function sendFlowEmail(input: FlowSendInput, deps: FlowSendDeps = {}): Promise<FlowSendResult> {
  const client = deps.client ?? createResendClient();
  const text = input.text ?? personalizeFlowBody(input.body, input.firstName ?? null);
  const html = input.html ?? null;

  const fromName = input.fromName?.trim() || client.config.fromName;
  const fromAddress = input.fromAddress?.trim() || client.config.fromAddress;

  const payload: Record<string, unknown> = {
    from: `${fromName} <${fromAddress}>`,
    to: [input.to],
    subject: input.subject,
  };
  if (html) {
    // Premium path: the renderer's HTML is the body, the plain-text part is
    // the accessible alternative.
    payload.html = html;
    payload.text = text;
  } else {
    payload.text = text;
  }
  if (input.replyTo) payload.reply_to = input.replyTo;

  const response = await client.post(
    "emails",
    payload,
    // Provider-side idempotency, in addition to Voom's durable claim guard.
    { headers: { "Idempotency-Key": input.idempotencyKey } },
  );

  const body = await safeProviderBody(response);
  return {
    ok: response.ok && typeof body?.id === "string" && body.id.length > 0,
    providerMessageId: typeof body?.id === "string" ? body.id : null,
    providerStatus: typeof body?.last_event === "string" ? body.last_event : response.ok ? "accepted" : null,
    errorCode: response.ok ? null : `HTTP_${response.status}`,
    errorMessage: response.ok ? null : providerErrorMessage(body, "Resend couldn't accept that email send."),
  };
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
