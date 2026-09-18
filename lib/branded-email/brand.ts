/**
 * Branded Email Engine v1 — brand resolution from the database + storage.
 *
 * The authoritative sources:
 *   - `public.businesses` for name/description/industry/website/brand color;
 *   - `public.profiles` for the account display-name fallback;
 *   - `storage` for a public brand logo (never a signed URL).
 *
 * Reads and normalizes; never writes, never invents. A missing row degrades to
 * a deterministic "Your business" profile.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getPublicAssetUrl } from "./storage";
import {
  buildEmailBrandProfile,
  type EmailBrandProfile,
  type EmailSocialLink,
} from "./brand-profile";

export interface BrandRow {
  id?: string | null;
  owner_user_id?: string | null;
  brand_name?: string | null;
  brand_description?: string | null;
  industry?: string | null;
  website?: string | null;
  site?: string | null;
  website_url?: string | null;
  primary_color?: string | null;
  accent_color?: string | null;
  brand_color?: string | null;
  logo_path?: string | null;
  footer_address?: string | null;
  tone?: string | null;
  brand_personality?: string[] | null;
}

/**
 * Reads the business + profile rows the brand profile needs, and returns the
 * normalized profile plus the raw website/color columns for the sender layer.
 */
export async function loadEmailBrandProfile(
  db: SupabaseClient,
  ownerId: string,
): Promise<EmailBrandProfile> {
  const [{ data: business, error: businessError }, { data: profile, error: profileError }] =
    await Promise.all([
      db.from("businesses")
        .select("id,owner_user_id,brand_name,brand_description,industry,website,primary_color,accent_color,logo_path,footer_address,brand_personality")
        .eq("owner_user_id", ownerId)
        .maybeSingle(),
      db.from("profiles")
        .select("display_name")
        .eq("user_id", ownerId)
        .maybeSingle(),
    ]);

  if (businessError || profileError) {
    // Fail safe to a deterministic profile rather than a broken send.
    return buildEmailBrandProfile({ ownerId, businessId: null, profileDisplayName: null });
  }

  const row = (business ?? {}) as BrandRow;
  const profileDisplayName = (profile as { display_name?: string | null } | null)?.display_name ?? null;

  const brandName = row.brand_name ?? null;
  const logo = await resolveBrandLogo(db, ownerId, row.logo_path);

  const personality = Array.isArray(row.brand_personality) ? row.brand_personality : [];
  const tone = row.tone ?? personality[0] ?? null;

  return buildEmailBrandProfile({
    ownerId,
    businessId: row.id ? String(row.id) : null,
    profileDisplayName,
    brandName,
    brandDescription: row.brand_description ?? null,
    industry: row.industry ?? null,
    website: row.website ?? row.site ?? row.website_url ?? null,
    primaryColor: row.primary_color ?? row.brand_color ?? null,
    accentColor: row.accent_color ?? null,
    logo,
    socialLinks: await resolveSocialLinks(),
    footerAddress: row.footer_address ?? null,
    tone,
  });
}

async function resolveBrandLogo(
  db: SupabaseClient,
  ownerId: string,
  logoPath: string | null | undefined,
) {
  if (!logoPath) return null;
  const url = await getPublicAssetUrl(db, String(logoPath));
  if (!url) return null;
  const mimeType = mimeTypeForPath(String(logoPath));
  return { path: String(logoPath), mimeType, url, alt: "Logo" };
}

function mimeTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/** Real social links only. In v1 there is no social-link store yet, so this
 *  returns an empty list rather than inventing handles. */
function resolveSocialLinks(): Promise<EmailSocialLink[]> {
  // Reserved for a future migration column (e.g. businesses.social_links);
  // Voom never invites or invents link destinations.
  return Promise.resolve([]);
}
