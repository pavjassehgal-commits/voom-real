/**
 * Website normalization for the onboarding wizard.
 *
 * The ONLY place Voom stores or uses a business website is the email brand
 * profile (`voom_email_brands.website`, migration 0041), consumed by the
 * Branded Email Engine as the email's website link and default CTA
 * destination. Its writer RPC (`upsert_email_brand`, 0042) accepts only
 * `^https?://\S+$` up to 500 characters, so a bare "yourbusiness.ae" typed
 * into the wizard is given the https scheme here — and anything that still
 * is not a plausible http(s) URL is dropped (returned as null) instead of
 * failing the onboarding. Pure and dependency-free so the Node suite runs it.
 */

export const WEBSITE_MAX_LENGTH = 500;

/** Shown when the business saved but the best-effort website write did not. */
export const WEBSITE_NOT_SAVED_NOTICE =
  "Your business profile is saved, but the website couldn't be stored. Add it any time under Settings → Email identity & branding.";

export function normalizeWebsiteUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (withScheme.length > WEBSITE_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A real public host: at least one dot and no empty labels ("abc" or
  // "foo..bar" are typos, not websites).
  const host = url.hostname;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  return withScheme;
}
