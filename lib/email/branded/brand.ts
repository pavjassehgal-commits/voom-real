/**
 * Branded Email Engine — the email brand profile.
 *
 * One authoritative assembled view used by the renderer, the sender
 * resolution, the preview surfaces and the settings screen. It reuses the
 * existing `businesses` row as the source of truth for everything the
 * business already knows (name, description, industry, tone/voice) and adds
 * only the email-specific presentation state from `voom_email_brands` (0041):
 * logo, colours, website, footer line. No competing source of truth is
 * created — the two rows are read together, every time, in one place.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeBrandColor } from "./renderer";
import type { EmailAssetRow, EmailBrandProfile } from "./types";

const EMPTY_PROFILE: Omit<EmailBrandProfile, "name"> = {
  businessId: null,
  description: "",
  industry: "",
  website: null,
  tone: "",
  footerLine: null,
  primaryColor: null,
  secondaryColor: null,
  logo: null,
  assets: [],
};

export function toEmailAssetRefs(
  rows: Array<Partial<EmailAssetRow> & { id: string; public_url: string; mime_type: string; status?: string }>,
): Array<EmailBrandProfile["assets"][number]> {
  return rows
    .filter((row) => (row.status ?? "ready") === "ready" && typeof row.public_url === "string" && row.public_url.trim() !== "")
    .map((row) => ({
      assetId: row.id,
      url: row.public_url.trim(),
      altText: typeof row.alt_text === "string" && row.alt_text.trim() ? row.alt_text.trim() : "A photo from this business",
      mimeType: row.mime_type as "image/jpeg" | "image/png" | "image/webp",
      width: typeof row.width === "number" ? row.width : null,
      height: typeof row.height === "number" ? row.height : null,
    }));
}

/**
 * Assembles the brand profile for one owner. Missing rows are fine — the
 * renderer degrades to a clean neutral design (never an empty one).
 */
export async function loadEmailBrandProfile(
  db: SupabaseClient,
  ownerId: string,
): Promise<EmailBrandProfile> {
  const [businessResult, brandResult, assetsResult] = await Promise.all([
    db.from("businesses")
      .select("id,brand_name,brand_description,industry,brand_personality")
      .eq("owner_user_id", ownerId)
      .maybeSingle(),
    db.from("voom_email_brands")
      .select("id,owner_user_id,business_id,logo_asset_id,primary_color,secondary_color,website,footer_line")
      .eq("owner_user_id", ownerId)
      .maybeSingle(),
    db.from("voom_email_assets")
      .select("id,public_url,mime_type,alt_text,width,height,status")
      .eq("owner_user_id", ownerId)
      .eq("status", "ready")
      .order("created_at", { ascending: true }),
  ]);

  if (brandResult.error || assetsResult.error) {
    // 0041 not applied yet: the business row alone still yields a usable,
    // neutral brand profile so existing sends keep working.
    const business = businessResult.data as unknown as Record<string, unknown> | null;
    return {
      ...EMPTY_PROFILE,
      businessId: business?.id ? String(business.id) : null,
      name: businessProfileName(business),
      description: String(business?.brand_description ?? ""),
      industry: String(business?.industry ?? ""),
      tone: brandTone(business?.brand_personality),
    };
  }

  const business = businessResult.data as unknown as Record<string, unknown> | null;
  const brand = (brandResult.data as unknown as Record<string, unknown> | null) ?? {};
  const assetRows = (assetsResult.data ?? []) as unknown as Array<Partial<EmailAssetRow> & { id: string; public_url: string; mime_type: string }>;
  const assets = toEmailAssetRefs(assetRows);
  const logoAssetId = brand.logo_asset_id ? String(brand.logo_asset_id) : null;
  const logo = logoAssetId ? assets.find((asset) => asset.assetId === logoAssetId) ?? null : null;

  return {
    businessId: business?.id ? String(business.id) : null,
    name: businessProfileName(business),
    description: String(business?.brand_description ?? "").trim(),
    industry: String(business?.industry ?? "").trim(),
    website: typeof brand.website === "string" && brand.website.trim() ? brand.website.trim() : null,
    tone: brandTone(business?.brand_personality),
    footerLine: typeof brand.footer_line === "string" && brand.footer_line.trim() ? brand.footer_line.trim() : null,
    primaryColor: safeBrandColor(brand.primary_color as string | null),
    secondaryColor: safeBrandColor(brand.secondary_color as string | null),
    logo,
    assets,
  };
}

function businessProfileName(business: Record<string, unknown> | null): string {
  const name = String(business?.brand_name ?? "").trim();
  return name || "Your business";
}

function brandTone(personality: unknown): string {
  if (!Array.isArray(personality)) return "";
  return (personality as unknown[])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");
}
