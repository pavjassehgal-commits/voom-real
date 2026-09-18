/**
 * Branded Email Engine v1 — the shared Resend send adapter.
 *
 * Campaigns and Email Automation both send through the existing Resend client
 * (`createResendClient`) and both thread `html` (premium renderer) + `text`
 * (plain alternative) with the RESOLVED per-business sender. There is still
 * exactly one email provider and one webhook intake.
 *
 * This module takes an already-composed `ComposedSend` (see composeEmail) so it
 * never re-derives content and never reaches a provider while a quality
 * blocker is outstanding.
 */

import "server-only";

import type { ResendApiClient } from "@/lib/email/core";

export interface ComposedSend {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** `${fromName} <${fromAddress}>` with the RESOLVED identity. */
  from: string;
  replyTo: string | null;
  idempotencyKey: string;
  /** Optional recipient id for Resend tagging. */
  tags?: Array<{ name: string; value: string }>;
}

export interface ProviderSendResult {
  ok: boolean;
  providerMessageId: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BrandedSendDeps {
  client?: ResendApiClient;
}

/**
 * Sends a composed branded email through Resend. Acceptance is never delivery:
 * `ok: true` only means the provider accepted the message; `delivered` is only
 * ever written by the verified webhook, exactly as today.
 */
export async function sendComposedEmail(
  input: ComposedSend,
  deps: BrandedSendDeps = {},
): Promise<ProviderSendResult> {
  const { client } = deps;
  let api: ResendApiClient;
  if (client) {
    api = client;
  } else {
    const { createResendClient } = await import("@/lib/email/client");
    api = createResendClient();
  }

  const payload: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
  };
  if (input.replyTo) payload.reply_to = input.replyTo;
  if (input.tags?.length) {
    payload.tags = input.tags.map((tag) => ({ name: tag.name, value: tag.value }));
  }

  const response = await api.post(
    "emails",
    payload,
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
