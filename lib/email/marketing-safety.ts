import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailDeliveryProvider, EmailProviderSendResult } from "./provider";
import type { BrandedSendPayload } from "./branded/dispatch";

const messages: Record<string, string> = {
  marketing_email_disabled: "Marketing sending is awaiting operator activation. Nothing was sent.",
  email_business_suspended: "Marketing sending is paused for this business after a delivery or abuse signal. Contact support to review the customer list.",
  consent_evidence_required: "Open Contacts and record this person's explicit marketing-email consent. Unknown or unconfirmed contacts cannot receive campaigns.",
  recipient_suppressed: "This recipient is unsubscribed or suppressed. Do not resend.",
  email_business_allowance_reached: "Your business's daily or monthly email allowance is exhausted. No email was sent; wait for the next allowance window or contact support.",
  email_provider_allowance_reached: "VOOM's shared email allowance is exhausted. No email was sent. Contact support.",
  email_provider_throttled: "The email provider is busy. No email was submitted; wait briefly before retrying.",
  email_payload_changed: "The content changed after a provider attempt. Do not retry this delivery with different content; review the original outcome first.",
  email_retry_window_closed: "The safe retry window or attempt limit has ended. Contact support to reconcile delivery; do not resend.",
  email_retry_not_due: "The previous provider rejection is still in its retry cooldown. Wait at least one minute.",
};
export const marketingError = (code: string, ambiguous = false): EmailProviderSendResult => ({
  ok: false, provider: "resend", providerMessageId: null, providerStatus: null,
  errorCode: code, errorKind: ambiguous ? "ambiguous" : "configuration", ambiguous,
  errorMessage: ambiguous
    ? "Delivery is uncertain. Do not resend: check the provider record before taking further action."
    : messages[code] ?? "Marketing email was not sent. Check sender verification, recorded contact consent, suppression and sending allowances.",
});

/** All campaign/sequence sends use the same durable final gate. A lost response
 * leaves a submission in submitting/uncertain, never eligible for another POST.
 * Only an explicit provider rejection may retry, same bytes/key, <=3, <23h. */
export async function dispatchSafeMarketingEmail(
  db: SupabaseClient, payload: BrandedSendPayload, provider: EmailDeliveryProvider,
): Promise<EmailProviderSendResult> {
  if (!payload.ownerId || !payload.sourceKind || !payload.sourceId) return marketingError("email_source_required");
  const wire = {
    from: payload.from, to: payload.to, replyTo: payload.replyTo,
    subject: payload.subject, preheader: payload.preheader, html: payload.html, text: payload.text,
    idempotencyKey: payload.idempotencyKey,
    headers: {
      "List-Unsubscribe": `<${payload.oneClickUnsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [{ name: "voom_delivery", value: payload.sourceId }, { name: "voom_kind", value: payload.sourceKind }],
  };
  if (!payload.oneClickUnsubscribeUrl?.startsWith("https://")) return marketingError("secure_unsubscribe_required");
  const hash = createHash("sha256").update(JSON.stringify(wire)).digest("hex");
  let gate;
  try {
    const result = await db.rpc("reserve_marketing_email_submission", {
      p_owner: payload.ownerId, p_key: payload.idempotencyKey, p_kind: payload.sourceKind,
      p_source: payload.sourceId, p_to: payload.to.toLowerCase().trim(), p_hash: hash,
    });
    if (result.error) return marketingError(safeGateCode(result.error.message));
    gate = result.data as { submit?: boolean; state?: string; messageId?: string } | null;
  } catch { return marketingError("email_safety_check_unavailable"); }
  if (gate?.submit !== true) {
    if (gate?.state === "accepted" && gate.messageId) return {
      ok: true, provider: "resend", providerMessageId: gate.messageId, providerStatus: "accepted",
      errorCode: null, errorKind: null, errorMessage: null, ambiguous: false,
    };
    return marketingError("provider_outcome_ambiguous", true);
  }
  let result: EmailProviderSendResult;
  try { result = await provider.send(wire); }
  catch { result = marketingError("provider_outcome_ambiguous", true); }
  // Network/5xx/malformed successes may have crossed the external boundary.
  const uncertain = result.ambiguous || result.errorKind === "network";
  try {
    const stored = await db.rpc("record_marketing_email_submission", {
      p_owner: payload.ownerId, p_key: payload.idempotencyKey,
      p_state: result.ok ? "accepted" : uncertain ? "uncertain" : "rejected",
      p_message: result.providerMessageId, p_error: result.errorCode,
    });
    if (stored.error) return marketingError("provider_outcome_ambiguous", true);
    const confirmed = stored.data as { state?: string; messageId?: string } | null;
    if (confirmed?.state === "accepted" && confirmed.messageId) return {
      ok: true, provider: "resend", providerMessageId: confirmed.messageId, providerStatus: "accepted",
      errorCode: null, errorKind: null, errorMessage: null, ambiguous: false,
    };
    if (confirmed?.state !== (uncertain ? "uncertain" : "rejected") || result.ok) {
      return marketingError("provider_outcome_ambiguous", true);
    }
  } catch { return marketingError("provider_outcome_ambiguous", true); }
  return uncertain ? { ...result, ambiguous: true, errorCode: "provider_outcome_ambiguous" } : result;
}

function safeGateCode(message: string): string {
  return /\b(marketing_email_disabled|email_business_suspended|consent_evidence_required|recipient_suppressed|sender_information_required|sender_domain_not_verified|email_business_allowance_reached|email_provider_allowance_reached|email_provider_throttled|email_retry_window_closed|email_retry_not_due|email_payload_changed|email_source_not_authorized)\b/.exec(message)?.[1]
    ?? "email_safety_check_unavailable";
}
