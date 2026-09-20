/**
 * Email Automation v2 — the send adapter over the Branded Email Engine.
 *
 * There is no second email sender in Voom: this module is the lifecycle
 * flow's front door onto the SAME shared pipeline campaign sends use
 * (`prepareBrandedSend` + `dispatchBrandedEmail` in `@/lib/email/branded`):
 * per-business sender identity, validated design, deterministic renderer,
 * quality guard, real unsubscribe — then the existing Resend client.
 *
 * Truthfulness: a successful response here means the provider ACCEPTED the
 * message. It is never treated as a delivery. `delivered` is only ever set by
 * a verified Resend webhook (`record_email_flow_delivery_event`).
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dispatchBrandedEmail,
  prepareBrandedSend,
  type BrandedSendPayload,
  type BrandedSendDeps,
} from "@/lib/email/branded/dispatch";

export interface FlowSendDeps {
  /** Test seam. Production uses the configured Resend client. */
  client?: BrandedSendDeps["client"];
  /**
   * Injected provider domain state (test seam). When provided, no provider
   * network call is made for sender verification.
   */
  providerDomains?: BrandedSendDeps["providerDomains"];
}

export interface FlowSendInput {
  /** The service-role client: sender identity + brand + assets live here. */
  admin: SupabaseClient;
  ownerId: string;
  /** Raw recipient address. Server-only — never returned to a browser. */
  to: string;
  subject: string;
  /**
   * Stable per step run (the run's own idempotency key). Resend deduplicates
   * on this header, so even if Voom's own claim guard were ever bypassed by a
   * timeout-and-retry, the provider would not send the same message twice.
   */
  idempotencyKey: string;
  /** Contact first name for the `{firstName}` token, or null. */
  firstName?: string | null;
  /** Stored step copy (frozen on the run's content snapshot at claim time). */
  body: string;
  previewText?: string | null;
  cta?: string | null;
  ctaUrl?: string | null;
  flowType?: "welcome" | "re_engagement" | null;
}

export interface FlowSendResult {
  ok: boolean;
  providerMessageId: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Present when the pre-send quality guard blocked the message. */
  qualityFailures?: Array<{ code: string; message: string }>;
  /**
   * A terminal failure (quality guard / sender unresolved) will not change on
   * retry — the caller must not reschedule it.
   */
  terminal: boolean;
  /** The request may have reached the provider; automatic resend is unsafe. */
  ambiguous?: boolean;
}

export type PreparedFlowEmail =
  | { ok: true; payload: BrandedSendPayload }
  | { ok: false; result: FlowSendResult };

/**
 * Replaces the `{firstName}` token with the contact's real first name, or a
 * neutral greeting word when the contact has none. Kept for the tests and for
 * deterministic copy; the renderer performs the same substitution.
 */
export function personalizeFlowBody(body: string, firstName: string | null | undefined): string {
  const name = (firstName ?? "").trim();
  return body.replace(/\{firstName\}/g, name || "there");
}

/**
 * Sends one lifecycle step through the branded engine.
 *
 * Failure classes:
 *   - quality guard / sender / unsubscribe: `terminal: true` — resending the
 *     same content cannot fix a malformed email, so the run is failed
 *     without a retry;
 *   - provider refusal / network: `terminal: false` — the bounded retry
 *     (MAX_SEND_ATTEMPTS) applies, exactly as before.
 */
export async function sendFlowEmail(input: FlowSendInput, deps: FlowSendDeps = {}): Promise<FlowSendResult> {
  const prepared = await prepareFlowEmail(input, deps);
  if (!prepared.ok) return prepared.result;
  return dispatchPreparedFlowEmail(prepared.payload, deps);
}

/** Complete every renderer/sender/quality check before a provider call. */
export async function prepareFlowEmail(input: FlowSendInput, deps: FlowSendDeps = {}): Promise<PreparedFlowEmail> {
  try {
    const prepared = await prepareBrandedSend(
      {
        admin: input.admin,
        ownerId: input.ownerId,
        to: input.to,
        idempotencyKey: input.idempotencyKey,
        subject: input.subject,
        body: input.body,
        previewText: input.previewText ?? null,
        cta: input.cta ?? "",
        ctaUrl: input.ctaUrl ?? null,
        flowType: input.flowType ?? null,
        firstName: input.firstName ?? null,
      },
      { client: deps.client ?? null, providerDomains: deps.providerDomains ?? null },
    );
    if (prepared.ok) return prepared;
    return {
      ok: false,
      result: {
        ok: false,
        providerMessageId: null,
        providerStatus: null,
        errorCode: prepared.code,
        errorMessage: prepared.message,
        qualityFailures: prepared.qualityFailures,
        terminal: prepared.terminal,
      },
    };
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        providerMessageId: null,
        providerStatus: null,
        errorCode: "email_preflight_failed",
        errorMessage: "The email could not be prepared safely.",
        terminal: true,
      },
    };
  }
}

/** The only lifecycle provider-call boundary. */
export async function dispatchPreparedFlowEmail(
  payload: BrandedSendPayload,
  deps: FlowSendDeps = {},
): Promise<FlowSendResult> {
  let response;
  try {
    response = await dispatchBrandedEmail(payload, { client: deps.client ?? null });
  } catch {
    return {
      ok: false,
      providerMessageId: null,
      providerStatus: null,
      errorCode: "provider_outcome_ambiguous",
      errorMessage: "The provider outcome could not be confirmed.",
      terminal: true,
      ambiguous: true,
    };
  }

  return {
    ok: response.ok,
    providerMessageId: response.providerMessageId,
    providerStatus: response.providerStatus,
    errorCode: response.errorCode,
    errorMessage: response.errorMessage,
    // A 2xx without a provider id is ambiguous: the provider may have accepted
    // the request even though its response was incomplete. Never auto-resend.
    terminal: response.ambiguous,
    ambiguous: response.ambiguous,
  };
}
