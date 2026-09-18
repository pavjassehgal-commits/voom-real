/**
 * Branded Email Engine v1 — the pre-send quality guard.
 *
 * Runs BEFORE any provider call. A send that trips a blocker is surfaced as
 * needs-attention instead of shipping malformed mail. The caller (engine,
 * campaign delivery route) refuses to hand a blocked send to the provider.
 *
 * Blockers are the same set everywhere, and they are binary and honest:
 *   - sender identity not resolvable;
 *   - empty subject;
 *   - unresolved personalization tokens;
 *   - marketing send with no real unsubscribe link;
 *   - CTA URL present but not email-safe;
 *   - a claimed/required image missing or not email-safe;
 *   - HTML or plain text missing.
 *
 * Pure: no I/O, no server-only import. It accepts the resolved values the
 * caller computed, so the same guard runs in tests and production identically.
 */

import { isEmailSafeImage, isImageMimeType } from "./assets";

export interface EmailQualityGuardInput {
  subject: string;
  html: string | null;
  text: string | null;
  /** The resolved sender identity, or null when resolution failed. */
  sender?: { fromName: string; fromAddress: string } | null;
  /** True when this is a marketing send (unsubscribe is mandatory). */
  marketing: boolean;
  unsubscribeUrl?: string | null;
  ctaUrl?: string | null;
  /** The hero image the renderer expects to embed, when one is referenced. */
  hero?: { url: string | null; mimeType: string | null; alt: string | null } | null;
  /** image alt text that was claimed in the design. */
  heroAssetExpected?: boolean;
}

export type EmailQualityBlocker =
  | "sender_not_resolved"
  | "subject_missing"
  | "unresolved_tokens"
  | "marketing_missing_unsubscribe"
  | "unsubscribe_not_email_safe"
  | "cta_not_email_safe"
  | "hero_missing"
  | "hero_not_email_safe"
  | "html_missing"
  | "text_missing";

export interface EmailQualityResult {
  ok: boolean;
  blockers: EmailQualityBlocker[];
  /** One human sentence surfaced to the owner via needs-attention. */
  needsAttentionMessage: string | null;
}

const SENDER_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BLOCKER_MESSAGES: Record<EmailQualityBlocker, string> = {
  sender_not_resolved: "The sender identity could not be resolved.",
  subject_missing: "The email has no subject.",
  unresolved_tokens: "The email still contains personalization tokens.",
  marketing_missing_unsubscribe: "A marketing email must include a working unsubscribe link.",
  unsubscribe_not_email_safe: "The unsubscribe link is not a valid web address.",
  cta_not_email_safe: "The call-to-action link is not a valid web address.",
  hero_missing: "The email design references an image that is missing.",
  hero_not_email_safe: "The email design references an image that is not email-safe.",
  html_missing: "The HTML body was not generated.",
  text_missing: "The plain-text body was not generated.",
};

export function qualityBlockerLabel(blocker: EmailQualityBlocker): string {
  return BLOCKER_MESSAGES[blocker];
}

const TOKEN_RE = /\{\{?\s*[A-Za-z][A-Za-z0-9]*\s*\}?\}/;

function isEmailSafeWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate || candidate.length > 500) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !url.username && !url.password;
}

/**
 * Evaluates the quality guard. Returns `ok: true` only when every mandatory
 * property is present and safe. Destructive traits (tokens, bad URLs, a
 * missing unsubscribe) are blockers, never silent fixes.
 */
export function evaluateEmailQualityGuard(input: EmailQualityGuardInput): EmailQualityResult {
  const blockers: EmailQualityBlocker[] = [];

  const senderAddress = input.sender?.fromAddress?.trim() ?? "";
  const senderName = input.sender?.fromName?.trim() ?? "";
  if (!senderName || !SENDER_ADDRESS_RE.test(senderAddress)) {
    blockers.push("sender_not_resolved");
  }

  if (!input.subject.trim()) blockers.push("subject_missing");

  if (TOKEN_RE.test(input.subject)
    || (input.text !== null && TOKEN_RE.test(input.text))
    || (input.html !== null && TOKEN_RE.test(input.html))) {
    blockers.push("unresolved_tokens");
  }

  if (!input.html) blockers.push("html_missing");
  if (!input.text) blockers.push("text_missing");

  if (input.marketing) {
    if (!input.unsubscribeUrl) {
      blockers.push("marketing_missing_unsubscribe");
    } else if (!isEmailSafeWebUrl(input.unsubscribeUrl)) {
      blockers.push("unsubscribe_not_email_safe");
    }
  }

  if (input.ctaUrl) {
    if (!isEmailSafeWebUrl(input.ctaUrl)) blockers.push("cta_not_email_safe");
  }

  if (input.heroAssetExpected || input.hero) {
    const heroUrl = input.hero?.url ?? null;
    const mimeType = input.hero?.mimeType ?? null;
    if (!heroUrl) {
      blockers.push("hero_missing");
    } else if (!mimeType || !isImageMimeType(mimeType) || !isEmailSafeImage(heroUrl, String(mimeType))) {
      blockers.push("hero_not_email_safe");
    }
  }

  const needsAttentionMessage = blockers.length > 0
    ? blockers.map((blocker) => BLOCKER_MESSAGES[blocker]).join(" ")
    : null;

  return { ok: blockers.length === 0, blockers, needsAttentionMessage };
}

/** Human label for the campaign/flow send result when the guard refused. */
export const QUALITY_BLOCKED_CODE = "quality_guard_blocked";
