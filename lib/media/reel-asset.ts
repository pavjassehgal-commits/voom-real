export const REEL_ASSET_MAX_BYTES = 4 * 1024 * 1024;
export const REEL_ASSET_PACK_LIMIT = 6;
export const REEL_ASSET_ACCEPT = ".jpg,.jpeg,.png,.webp,.mp4,.mov";

export type ReelAssetKind = "image" | "video";
export type ReelAssetMimeType = "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/quicktime";
export type ReelAssetExtension = "jpg" | "png" | "webp" | "mp4" | "mov";

export interface DetectedReelAsset {
  mimeType: ReelAssetMimeType;
  extension: ReelAssetExtension;
  kind: ReelAssetKind;
}

export interface DetectReelAssetOptions {
  /**
   * Original client filename. Used to split a structurally valid ISO-BMFF file
   * between MP4 and QuickTime MOV. The browser MIME type is never trusted, and
   * the container brand alone cannot distinguish the two: Apple exports real
   * MP4s whose `ftyp` major brand is `qt`.
   */
  name?: string;
}

/**
 * Magic-byte detection of a Reel / Post asset.
 *
 * Images are sniffed from their signature. Video is accepted only when the
 * bytes start with a structurally valid ISO-BMFF `ftyp` box (never the
 * extension, never the browser-supplied MIME type). Within a structurally
 * valid container the filename decides the stored type:
 *
 *   - `.mp4` (or any valid ISO-BMFF file without a `.mov` hint) -> MP4. A
 *     `qt`-branded `.mp4` is therefore never rewritten to MOV.
 *   - `.mov` -> QuickTime **only** when the container is actually a QuickTime
 *     container (major brand `qt` or `qt` listed as a compatible brand).
 *
 * A structurally invalid `ftyp` (bad size, non-printable/absent brand, missing
 * minor version) is rejected, so a fake `.mp4` cannot sneak through.
 */
export function detectReelAsset(bytes: Uint8Array, options: DetectReelAssetOptions = {}): DetectedReelAsset | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: "image/jpeg", extension: "jpg", kind: "image" };
  if (bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value)) return { mimeType: "image/png", extension: "png", kind: "image" };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { mimeType: "image/webp", extension: "webp", kind: "image" };

  const iso = sniffIsoBmff(bytes);
  if (!iso) return null;

  const isQuickTimeContainer = isQuickTimeBrand(iso.majorBrand, iso.compatibleBrands);
  const extension = extensionFromName(options.name);

  // A `.mov` must actually be a QuickTime container to be stored as QuickTime.
  // If it is not, reject it truthfully rather than relabelling an MP4 as MOV.
  if (extension === "mov") {
    if (isQuickTimeContainer) return { mimeType: "video/quicktime", extension: "mov", kind: "video" };
    return null;
  }

  // `.mp4`, and any structurally valid ISO-BMFF file with no `.mov` hint, stays
  // MP4 even when the major brand is `qt`. MP4 is the priority for this fix.
  return { mimeType: "video/mp4", extension: "mp4", kind: "video" };
}

export function safeAssetName(name: string) {
  const normalized = name.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "-").trim();
  return (normalized || "reel-asset").slice(0, 180);
}

// --- private ISO-BMFF helpers ------------------------------------------------

const QUICKTIME_BRAND = "qt  ";

interface IsoBmffHeader {
  majorBrand: string;
  compatibleBrands: string[];
}

/**
 * Validates the leading ISO-BMFF `ftyp` box and returns the major and
 * compatible brands. Rejects anything that is not a well-formed `ftyp`:
 *   - fewer than the 16-byte minimum (header + major brand + minor version),
 *   - a wrong signature at bytes 4..8,
 *   - a box whose declared size is too small for its own header,
 *   - a non-printable major brand,
 *   - a malformed compatible-brand run.
 */
function sniffIsoBmff(bytes: Uint8Array): IsoBmffHeader | null {
  if (bytes.length < 16) return null;
  if (ascii(bytes, 4, 8) !== "ftyp") return null;

  const boxSize = readUint32(bytes, 0);
  // A box size of 1 means a 64-bit extended size, which an `ftyp` never uses.
  // A size of 0 means the box extends to the end of the file.
  if (boxSize === 1) return null;
  const boxEnd = boxSize === 0 ? bytes.length : boxSize;
  if (boxEnd < 16) return null;

  const majorBrand = ascii(bytes, 8, 12);
  if (!isPrintableBrand(majorBrand)) return null;

  const compatibleBrands: string[] = [];
  const compatibleEnd = Math.min(bytes.length, boxEnd);
  for (let offset = 16; offset + 4 <= compatibleEnd; offset += 4) {
    const brand = ascii(bytes, offset, offset + 4);
    if (!isPrintableBrand(brand)) break;
    compatibleBrands.push(brand);
  }
  return { majorBrand, compatibleBrands };
}

function isQuickTimeBrand(majorBrand: string, compatibleBrands: string[]): boolean {
  return majorBrand === QUICKTIME_BRAND || compatibleBrands.includes(QUICKTIME_BRAND);
}

function extensionFromName(name: string | undefined): "mp4" | "mov" | null {
  if (!name) return null;
  const match = /\.(mp4|mov)$/i.exec(name.trim());
  if (!match) return null;
  return match[1].toLowerCase() as "mp4" | "mov";
}

function isPrintableBrand(brand: string): boolean {
  if (brand.length !== 4) return false;
  for (let i = 0; i < brand.length; i++) {
    const code = brand.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  // Multiplication, not bit-shifting, so the leading byte never goes negative.
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function ascii(bytes: Uint8Array, start: number, end: number) { return String.fromCharCode(...bytes.slice(start, end)); }
