/**
 * Branded Email Engine — the pre-send quality guard.
 *
 * A deterministic checklist that runs against the fully prepared email —
 * sender, subject, design, rendered HTML, plain text — before anything is
 * handed to a provider. If a safety requirement fails, the email is NOT sent
 * and the failure is surfaced as a stable, actionable code.
 *
 * This is the last deterministic line before Resend. It checks structure and
 * truthfulness; it never rewrites content (the renderer already guarantees
 * safe output — the guard proves it).
 *
 * Pure: no I/O, no server-only import — the Node suite executes it for real.
 */

import type { EmailDesignSpec } from "./design";
import type { RenderedIdentity } from "./renderer";
import { findUnresolvedTokens } from "./personalize";

export interface QualityCheckInput {
  /** Whether a resolved sender identity (name + address) exists. */
  sender: RenderedIdentity | null;
  subject: string;
  design: EmailDesignSpec;
  html: string;
  text: string;
  /** Marketing emails must carry a real unsubscribe link. Every Voom email is
   *  marketing to a subscribed recipient, so this is always required. */
  unsubscribeUrl: string | null;
  /** Asset ids referenced by the design that the caller could resolve. */
  referencedAssetIds: string[];
  resolvedAssetIds: string[];
}

export interface QualityFailure {
  code: string;
  message: string;
}

export interface QualityResult {
  ok: boolean;
  failures: QualityFailure[];
}

const HTML_REQUIRES = ["<!DOCTYPE html>", "<html", "</html>", "<body"];

/**
 * Real injection vectors only — deliberately NOT a blanket ban on `<meta
 * http-equiv>` (the standard X-UA-Compatible tag is common and harmless) and
 * NOT a substring match for `on...=` (which false-positives on `content=`).
 */
const FORBIDDEN_HTML = [
  /<script[\s>]/i,
  /<iframe[\s>]/i,
  /<form[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /<link[\s>]/i,
  /javascript:/i,
  // Inline event handlers as a whole attribute (onclick=, onerror=…), not a
  // substring of a larger attribute name like content= or font-size=.
  /(?:^|[\s"'\/])on\w+\s*=/i,
  /@import/i,
  // Only the http-equiv values that can redirect or inject in an email.
  /<meta[^>]*http-equiv\s*=\s*["']?\s*(?:refresh|content-type|set-cookie|location)/i,
];

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Runs every check. Failures accumulate (one malformed email reports all of
 * its problems at once, so an owner can fix them in one pass).
 */
export function runEmailQualityChecks(input: QualityCheckInput): QualityResult {
  const failures: QualityFailure[] = [];
  const fail = (code: string, message: string) => failures.push({ code, message });

  // 1. Sender identity resolvable.
  if (!input.sender || !input.sender.fromName.trim() || !input.sender.fromAddress.trim()) {
    fail("sender_unresolvable", "No sending identity could be resolved for this business.");
  }

  // 2. Subject non-empty.
  if (!input.subject.trim()) {
    fail("subject_empty", "The email has no subject line.");
  }

  // 3. No unresolved personalization tokens anywhere a recipient would see.
  const tokenText = `${input.subject}\n${input.html}\n${input.text}`;
  const tokens = findUnresolvedTokens(tokenText);
  if (tokens.length > 0) {
    fail("unresolved_tokens", `Unresolved personalization tokens would reach the recipient: ${tokens.join(", ")}`);
  }

  // 4. Real unsubscribe link for this marketing email, present in both
  //    formats (HTML and plain text).
  if (!input.unsubscribeUrl || !isValidHttpUrl(input.unsubscribeUrl)) {
    fail("unsubscribe_missing", "The email has no working unsubscribe link.");
  } else {
    if (!input.html.includes(input.unsubscribeUrl)) fail("unsubscribe_missing_html", "The unsubscribe link is missing from the HTML email.");
    if (!input.text.includes(input.unsubscribeUrl)) fail("unsubscribe_missing_text", "The unsubscribe link is missing from the plain-text email.");
  }

  // 5. CTA url valid when the CTA is linked.
  if (input.design.cta.url) {
    if (!isValidHttpUrl(input.design.cta.url)) {
      fail("cta_url_invalid", "The call-to-action points at a destination that is not a valid http(s) URL.");
    }
  }

  // 6. Every referenced image resolves to a real, email-safe asset.
  const resolved = new Set(input.resolvedAssetIds);
  for (const assetId of input.referencedAssetIds) {
    if (!resolved.has(assetId)) {
      fail("asset_unresolved", `A referenced image (${assetId}) is not an available email asset for this business.`);
    }
  }

  // 7. HTML generated successfully and structurally sound.
  if (!input.html.trim()) {
    fail("html_invalid", "No HTML was generated.");
  } else {
    for (const required of HTML_REQUIRES) {
      if (!input.html.includes(required)) fail("html_invalid", `The HTML output is missing ${required}.`);
    }
    for (const forbidden of FORBIDDEN_HTML) {
      if (forbidden.test(input.html)) fail("html_forbidden_markup", "The HTML output contains markup email clients do not allow.");
    }
    if (!/<img[^>]*alt="/i.test(input.html) && /<img/i.test(input.html)) {
      fail("image_missing_alt", "An image in the HTML has no alt text.");
    }
  }

  // 8. Plain-text alternative exists.
  if (!input.text.trim()) {
    fail("plain_text_missing", "No plain-text alternative was generated.");
  }

  return { ok: failures.length === 0, failures };
}
