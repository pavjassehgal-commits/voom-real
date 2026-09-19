/**
 * Branded Email Engine — shared row + view types for the 0041 tables.
 */

export const EMAIL_IDENTITY_VERIFICATION_STATUSES = [
  "not_configured",
  "pending",
  "verified",
  "failed",
] as const;
export type EmailIdentityVerificationStatus = (typeof EMAIL_IDENTITY_VERIFICATION_STATUSES)[number];

export interface EmailIdentityRow {
  id: string;
  owner_user_id: string;
  business_id: string | null;
  /** Sender display name the recipient's inbox shows. */
  display_name: string | null;
  /** The business address it wants to send from, e.g. hello@synrapay.com. */
  from_address: string | null;
  /** Where customer replies should go. */
  reply_to: string | null;
  /**
   * Display hint only. The resolver never trusts this column: a sender is
   * only ever considered "verified" when the provider confirms the domain at
   * resolve time. Kept in sync by the refresh endpoint, for the settings UI.
   */
  verification_status: EmailIdentityVerificationStatus;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailBrandRow {
  id: string;
  owner_user_id: string;
  business_id: string | null;
  logo_asset_id: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  website: string | null;
  footer_line: string | null;
  created_at: string;
  updated_at: string;
}

export const EMAIL_ASSET_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type EmailAssetMimeType = (typeof EMAIL_ASSET_MIME_TYPES)[number];

export interface EmailAssetRow {
  id: string;
  owner_user_id: string;
  business_id: string | null;
  public_path: string;
  /** Durable, non-expiring public URL an email client can fetch. */
  public_url: string;
  mime_type: EmailAssetMimeType;
  byte_size: number;
  alt_text: string | null;
  width: number | null;
  height: number | null;
  source_kind: "uploaded" | "from_draft_asset" | "from_reel_asset" | "generated_preexisting";
  source_draft_id: string | null;
  status: "ready" | "removed";
  created_at: string;
  updated_at: string;
}

export interface EmailUnsubscribeRow {
  id: string;
  owner_user_id: string;
  email: string;
  contact_id: string | null;
  source: string;
  created_at: string;
}

/** The assembled email brand profile: one authoritative view for rendering. */
export interface EmailBrandProfile {
  businessId: string | null;
  name: string;
  description: string;
  industry: string;
  website: string | null;
  /** Tone/voice, reused from the business profile's brand personality. */
  tone: string;
  footerLine: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  logo: {
    assetId: string;
    url: string;
    altText: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    width: number | null;
    height: number | null;
  } | null;
  /** Every ready email asset the business published, in preference order. */
  assets: Array<{
    assetId: string;
    url: string;
    altText: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    width: number | null;
    height: number | null;
  }>;
}

export type ProviderDomainStatus = "verified" | "pending" | "failed";

/**
 * What the provider says about each domain. A domain absent from this map is
 * one the provider account does not know at all — which is NOT "pending":
 * the settings UI reports it as not configured with the provider.
 */
export type ProviderDomainMap = Map<string, ProviderDomainStatus>;
