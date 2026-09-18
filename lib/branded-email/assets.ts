/**
 * Branded Email Engine v1 — image asset rules.
 *
 * Three facts live here, and nothing else:
 *   1. which MIME types and URL shapes are email-safe;
 *   2. the deterministic asset PREFERENCE order for one campaign/flow email;
 *   3. a guard against temporary (signed) URLs reaching a delivered email.
 *
 * There is NO generation here: zero Seedream/Seedance/OpenRouter/AI calls, zero
 * credit reservations. Callers hand this module asset descriptions they already
 * own (from businesses, uploaded brand/product imagery, or approved Voom
 * assets) and it only ranks them.
 */

export const EMAIL_SAFE_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type EmailSafeImageMimeType = (typeof EMAIL_SAFE_IMAGE_MIME_TYPES)[number];

/** A named, validated image asset. `url` must be public and durable. */
export interface EmailImageAsset {
  id: string;
  /** Where the asset came from: business > campaign > uploaded > voom. */
  source: "business" | "campaign" | "upload" | "voom";
  mimeType: string;
  url: string;
  alt: string;
}

export interface AssetPreferenceContext {
  /** Existing business assets (brand library) — strongest preference. */
  businessAssets: EmailImageAsset[] | null;
  campaignAssets: EmailImageAsset[] | null;
  uploadAssets: EmailImageAsset[] | null;
  voomAssets: EmailImageAsset[] | null;
}

/** True when a MIME type may be embedded inline in an email. */
export function isImageMimeType(mimeType: unknown): mimeType is EmailSafeImageMimeType {
  return typeof mimeType === "string"
    && (EMAIL_SAFE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

/**
 * A URL may only be embedded when it is public, durable, absolute http(s), and
 * it is NOT a temporary signed URL. Resend/PostgREST signed URLs are refused
 * here, because they expire and would break the delivered email.
 */
export function isEmailSafeImage(url: unknown, mimeType: string): boolean {
  if (!isImageMimeType(mimeType)) return false;
  if (typeof url !== "string") return false;
  const candidate = url.trim();
  if (!candidate || candidate.length > 2000) return false;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const search = parsed.search.toLowerCase();
  if (/token=/.test(search) || /signature=/.test(search) || /x-amz-signature/.test(search)) {
    return false;
  }
  return true;
}

/**
 * The deterministic asset preference order the renderer consumes:
 *   business assets > campaign assets > uploaded brand/product imagery >
 *   approved existing Voom-generated assets.
 *
 * Returns the first asset that survives the email-safety check. A bad
 * (e.g. signed-URL) asset is skipped, never embedded.
 */
export function resolveHeroAsset(
  context: AssetPreferenceContext,
): EmailImageAsset | null {
  const ordered = [
    ...(context.businessAssets ?? []),
    ...(context.campaignAssets ?? []),
    ...(context.uploadAssets ?? []),
    ...(context.voomAssets ?? []),
  ];
  for (const asset of ordered) {
    if (asset && typeof asset === "object" && asset.url
      && isEmailSafeImage(asset.url, asset.mimeType)) {
      return {
        id: asset.id,
        source: asset.source,
        mimeType: asset.mimeType.toLowerCase(),
        url: asset.url,
        alt: asset.alt?.trim() || "",
      };
    }
  }
  return null;
}
