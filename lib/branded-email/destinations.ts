/**
 * Branded Email Engine v1 — destinations.
 *
 * A CTA or unsubscribe link is only ever rendered from a REAL destination the
 * business actually supplied or Voom actually resolves. This module is the
 * single authority for guessing at nothing: every URL is either validated
 * verbatim or dropped.
 */

export interface EmailDestinationContext {
  /** The business's verified/configured primary website. */
  website?: string | null;
  /** The app's own site URL (proof-of-unsubscribe pages live here). */
  siteUrl?: string | null;
  /** The campaign's own destination, already validated by the campaign layer. */
  campaignDestination?: string | null;
  /** The allowedUrls set MARA/flow creation was given (validated elsewhere). */
  allowedUrls?: Array<string | null | undefined>;
}

export interface EmailDestinationPlan {
  /** The real CTA URL, or null when no CTA may be rendered. */
  ctaUrl: string | null;
  /** A real reply-oriented CTA label when the CTA is `mailto:`/reply. */
  replyLabel: string | null;
  /** Reason the destination was (or was not) chosen — human-facing honesty. */
  reason: string;
}

const MAX_URL_LENGTH = 500;

/** The only URL shapes allowed in a delivered email. */
export function normalizeEmailUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (url.username || url.password) return null;
    return url.href;
  }
  // A mailto: link is the only allowed non-web destination, and only when it
  // points at a real address (validated separately by the sender layer).
  if (url.protocol === "mailto:") {
    if (!url.pathname) return null;
    return `mailto:${url.pathname}`;
  }
  return null;
}

/**
 * Picks the CTA destination, strongest allowance first:
 *   1. campaign destination (a campaign author explicitly chose it);
 *   2. a verified business website (the business's own, already validated);
 *   3. an allowedUrls entry (the flow/campaign context MARA was given);
 *   4. a reply-oriented `mailto:` CTA is never invented — only accepted when
 *      the evaluation hands one in (see `replyDestination`).
 *
 * Any candidate that is not an absolute http(s) URL with no credentials is
 * dropped. `replyTo` is only honored when it is an http(s) URL (a real
 * "write back" landing page) — a raw `mailto:` must be the CTA itself.
 */
export function resolveCtaDestination(context: EmailDestinationContext): EmailDestinationPlan {
  const candidates: Array<{ value: string; reason: string }> = [];

  if (context.campaignDestination) {
    candidates.push({ value: context.campaignDestination, reason: "Campaign destination" });
  }
  if (context.website) {
    candidates.push({ value: context.website, reason: "Business website" });
  }
  for (const allowed of context.allowedUrls ?? []) {
    if (allowed) candidates.push({ value: allowed, reason: "Supplied destination" });
  }

  for (const candidate of candidates) {
    const url = normalizeEmailUrl(candidate.value);
    if (url && !url.startsWith("mailto:")) {
      return { ctaUrl: url, replyLabel: null, reason: candidate.reason };
    }
  }

  return {
    ctaUrl: null,
    replyLabel: null,
    reason: candidates.length > 0 ? "No usable destination supplied" : "No destination supplied",
  };
}

/**
 * A CTA that points at the business's reply address. Voom never invents this
 * address: it must be a real, validated address from the sender layer.
 * When the business has a validated reply-to, the CTA becomes a `mailto:` and
 * the UI copies the label in; otherwise the CTA falls back to the strongest
 * non-reply destination (or null).
 */
export function replyDestination(
  replyTo: string | null | undefined,
  context: EmailDestinationContext,
): EmailDestinationPlan {
  if (replyTo) {
    const address = String(replyTo).trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return { ctaUrl: `mailto:${address}`, replyLabel: address, reason: "Business reply address" };
    }
  }
  return resolveCtaDestination(context);
}
