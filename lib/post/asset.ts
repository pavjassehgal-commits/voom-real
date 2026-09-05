// Relative imports (not the "@/..." alias) so these helpers stay resolvable
// outside the Next.js bundler.
import { detectReelAsset, safeAssetName } from "../media/reel-asset";
import { type PostAssetKind } from "./core";

/**
 * Post Studio upload rules. The byte cap matches the post_draft_assets
 * byte_size check in migration 0021. Uploaded files are stored byte-for-byte:
 * Post Studio never re-encodes, resizes, or otherwise changes a user asset.
 */
export const POST_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const POST_ASSET_ACCEPT = ".jpg,.jpeg,.png,.webp,.mp4,.mov";
export const POST_IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp";

export type { PostAssetKind };

export interface DetectedPostAsset {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/quicktime";
  extension: "jpg" | "png" | "webp" | "mp4" | "mov";
  kind: PostAssetKind;
}

/**
 * Magic-byte sniffing, never the browser-supplied content type. Reuses the
 * Reel detector so both studios agree on what a valid file is.
 */
export function detectPostAsset(bytes: Uint8Array): DetectedPostAsset | null {
  return detectReelAsset(bytes);
}

/** Human wording for the file kinds a given post type accepts. */
export function describeAllowedKinds(kinds: PostAssetKind[]): string {
  if (kinds.length === 1) return kinds[0] === "video" ? "an MP4 or MOV video" : "a JPEG, PNG or WebP image";
  return "a JPEG, PNG, WebP image or an MP4 or MOV video";
}

export function safePostAssetName(name: string): string {
  return safeAssetName(name);
}
