export const REEL_ASSET_MAX_BYTES = 4 * 1024 * 1024;
export const REEL_ASSET_PACK_LIMIT = 6;
export const REEL_ASSET_ACCEPT = ".jpg,.jpeg,.png,.webp,.mp4,.mov";

export type ReelAssetKind = "image" | "video";
export interface DetectedReelAsset { mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/quicktime"; extension: "jpg" | "png" | "webp" | "mp4" | "mov"; kind: ReelAssetKind; }

export function detectReelAsset(bytes: Uint8Array): DetectedReelAsset | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: "image/jpeg", extension: "jpg", kind: "image" };
  if (bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value)) return { mimeType: "image/png", extension: "png", kind: "image" };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { mimeType: "image/webp", extension: "webp", kind: "image" };
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const quicktime = ascii(bytes, 8, 12) === "qt  ";
    return { mimeType: quicktime ? "video/quicktime" : "video/mp4", extension: quicktime ? "mov" : "mp4", kind: "video" };
  }
  return null;
}

export function safeAssetName(name: string) {
  const normalized = name.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").trim();
  return (normalized || "reel-asset").slice(0, 180);
}

function ascii(bytes: Uint8Array, start: number, end: number) { return String.fromCharCode(...bytes.slice(start, end)); }
