/**
 * Branded Email Engine v1 — the authoritative email brand profile.
 *
 * There is EXACTLY one source of truth for a business's brand: the
 * `public.businesses` row (plus the account's own `profiles.display_name` as a
 * graceful fallback for a business name before onboarding completes). The
 * renderer and the sender resolver both build on this shape; nothing invents a
 * competing source.
 *
 * Pure: this module only normalizes plain values passed in. Reading the row is
 * the caller's job (see `lib/branded-email/brand.ts`).
 */

import { brandColor, hasBrandColor } from "./colors";

/** The validated #RRGGBB brand color used by the renderer. */
export const EMAIL_BRAND_COLOR_NEUTRAL = "#111614";

export interface EmailBrandProfileInput {
  ownerId: string | null;
  /** public.businesses.id, when a business row exists. */
  businessId: string | null;
  /** public.profiles.display_name — used only when no business name exists. */
  profileDisplayName?: string | null;
  brandName?: string | null;
  brandDescription?: string | null;
  industry?: string | null;
  /** The site the business supplied (onboarding/website field). */
  website?: string | null;
  /** Brand color as a #RRGGBB literal, else null. */
  primaryColor?: string | null;
  accentColor?: string | null;
  /** Public logo asset: { path, mimeType } with a public (never signed) URL. */
  logo?: BrandAssetRef | null;
  /** Real social links (name + validated public URL). */
  socialLinks?: EmailSocialLink[];
  /** One-line footer address/sentence the business supplied, else null. */
  footerAddress?: string | null;
  /** Brand tone label ("plain-spoken", etc.). */
  tone?: string | null;
}

export interface BrandAssetRef {
  /** Public storage path (e.g. `${ownerId}/...`). Never a signed URL. */
  path: string;
  mimeType: string;
  /** A public, durable, email-safe URL for this asset — never a temp URL. */
  url: string;
  alt: string;
}

export interface EmailSocialLink {
  /** "Instagram", "TikTok", "X", "Facebook", "Website". */
  label: string;
  /** A validated absolute http(s) URL. */
  url: string;
}

/** The normalized, deterministic brand profile the renderer consumes. */
export interface EmailBrandProfile {
  ownerId: string | null;
  businessId: string | null;
  name: string;
  description: string;
  industry: string;
  website: string | null;
  primaryColor: string;
  accentColor: string;
  hasBrandColor: boolean;
  logo: BrandAssetRef | null;
  socialLinks: EmailSocialLink[];
  footerAddress: string | null;
  tone: string | null;
}

const NAME_LIMIT = 120;
const DESCRIPTION_LIMIT = 600;
const INDUSTRY_LIMIT = 100;
const ADDRESS_LIMIT = 300;
const SOCIAL_LIMIT = 6;

function cleanName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.slice(0, NAME_LIMIT);
}

function cleanText(value: unknown, limit: number): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.slice(0, limit);
}

/**
 * Only absolute http(s) URLs with no credentials may appear in a delivered
 * email. Anything else is null — a link is never haunted into existence.
 */
export function validPublicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 500) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href;
}

/**
 * Builds the authoritative email brand profile from a brand data row.
 *
 * `website` is only accepted when it is a real absolute URL; a social link is
 * only accepted with a real URL; colors are validated to the curated palette;
 * and a logo is only accepted when it points at an email-safe image type.
 */
export function buildEmailBrandProfile(input: EmailBrandProfileInput): EmailBrandProfile {
  const brandName = cleanName(input.brandName);
  const profileName = cleanName(input.profileDisplayName);

  const primaryColor = hasBrandColor(input.primaryColor)
    ? brandColor(input.primaryColor)
    : EMAIL_BRAND_COLOR_NEUTRAL;

  return {
    ownerId: input.ownerId ?? null,
    businessId: input.businessId ?? null,
    name: brandName || profileName || "Your business",
    description: cleanText(input.brandDescription, DESCRIPTION_LIMIT),
    industry: cleanText(input.industry, INDUSTRY_LIMIT),
    website: validPublicUrl(input.website),
    primaryColor,
    accentColor: hasBrandColor(input.accentColor)
      ? brandColor(input.accentColor)
      : primaryColor,
    hasBrandColor: hasBrandColor(input.primaryColor),
    logo: normalizeLogo(input.logo),
    socialLinks: normalizeSocialLinks(input.socialLinks),
    footerAddress: cleanText(input.footerAddress, ADDRESS_LIMIT) || null,
    tone: cleanText(input.tone, 100) || null,
  };
}

const LOGO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function normalizeLogo(value: BrandAssetRef | null | undefined): BrandAssetRef | null {
  if (!value) return null;
  const path = typeof value.path === "string" ? value.path.trim() : "";
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.trim().toLowerCase() : "";
  const url = validPublicUrl(value.url);
  if (!path || !LOGO_MIME_TYPES.has(mimeType) || !url) return null;
  const alt = typeof value.alt === "string" && value.alt.trim()
    ? value.alt.trim().slice(0, 200)
    : "Logo";
  return { path: path.slice(0, 500), mimeType, url, alt };
}

function normalizeSocialLinks(value: EmailSocialLink[] | null | undefined): EmailSocialLink[] {
  const links: EmailSocialLink[] = [];
  const seen = new Set<string>();
  for (const link of value ?? []) {
    if (links.length >= SOCIAL_LIMIT) break;
    if (!link || typeof link !== "object") continue;
    const label = typeof link.label === "string" ? link.label.trim().slice(0, 40) : "";
    const url = validPublicUrl(link.url);
    if (!label || !url) continue;
    if (seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    links.push({ label, url });
  }
  return links;
}
