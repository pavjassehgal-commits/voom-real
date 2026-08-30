/**
 * Deterministic MARA visual composition: mara assigns the user's private
 * asset pack across the four viewer-facing Reel scenes. No AI, no media
 * inspection — pure asset type + upload order + scene role rules. MARA never
 * claims to have understood the content of an image; the product truth is
 * "MARA automatically assembled your provided assets into the Reel."
 */

export interface ReelVisualAsset {
  id: string;
  mimeType: string;
  kind: "image" | "video";
}

export interface ReelSceneVisual {
  assetId: string | null;
  assetKind: "image" | "video" | null;
}

const SCENE_COUNT = 4;

export function assetKindForMime(mimeType: string): "image" | "video" | null {
  if (mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp") return "image";
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") return "video";
  return null;
}

/**
 * Assigns the asset pack to the four scenes in upload order:
 * 1 asset  → same asset everywhere (varied crop/treatment at play time)
 * 2 assets → 0,1,1,0
 * 3 assets → 0,1,2,0
 * 4+ assets → 0,1,2,3 (extras unused)
 * CTA scene prefers the first uploaded image for a cleaner branded end card;
 * otherwise the assignment above stays as-is.
 */
export function assignReelVisuals(assets: ReelVisualAsset[]): ReelSceneVisual[] {
  const ordered = assets.filter((asset) => asset.kind === "image" || asset.kind === "video").slice(0, 6);
  const sequence: Array<ReelVisualAsset | null> = [null, null, null, null];
  if (ordered.length === 1) {
    sequence[0] = sequence[1] = sequence[2] = sequence[3] = ordered[0];
  } else if (ordered.length === 2) {
    sequence[0] = ordered[0]; sequence[1] = ordered[1]; sequence[2] = ordered[1]; sequence[3] = ordered[0];
  } else if (ordered.length === 3) {
    sequence[0] = ordered[0]; sequence[1] = ordered[1]; sequence[2] = ordered[2]; sequence[3] = ordered[0];
  } else if (ordered.length >= 4) {
    sequence[0] = ordered[0]; sequence[1] = ordered[1]; sequence[2] = ordered[2]; sequence[3] = ordered[3];
  }
  // CTA prefers the first uploaded image when it would otherwise be a video
  // (keeps the branded end card readable); otherwise the upload order stands.
  const firstImage = ordered.find((asset) => asset.kind === "image") ?? null;
  if (firstImage && sequence[3]?.kind === "video") {
    const at = sequence.findIndex((asset) => asset?.id === firstImage.id);
    const previousCta = sequence[3];
    if (at >= 0) sequence[at] = previousCta;
    sequence[3] = firstImage;
  }
  return Array.from({ length: SCENE_COUNT }, (_, index) => ({
    assetId: sequence[index]?.id ?? null,
    assetKind: sequence[index]?.kind ?? null,
  }));
}
