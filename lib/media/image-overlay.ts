import "server-only";

/**
 * Deterministic Voom-controlled overlays for MARA-generated IMAGES.
 *
 * Image/video models are never asked to render important text (business name,
 * CTA). The base media is generated clean; Voom then composites its own SVG
 * text layer on top, server-side, with a fixed layout. If the overlay cannot
 * be applied, the caller keeps the valid base media and the copy (which the
 * caption already carries) stays true — an overlay failure never destroys a
 * valid generated asset.
 *
 * V1 scope: feed posts only (1:1 / 4:5). Stories stay full-bleed (Instagram
 * convention) and Reel copy is delivered through the existing deterministic
 * composition preview, so neither gets a burned-in image overlay in V1.
 */

export interface OverlayCopy {
  /** Business name shown as a small wordmark chip. */
  brandName: string;
  /** One short call to action shown as the primary line. */
  cta: string;
}

export interface OverlayResult {
  bytes: Uint8Array;
  mimeType: "image/png";
}

/** Nothing to overlay -> unchanged input. */
export function hasOverlayCopy(copy: OverlayCopy): boolean {
  return copy.brandName.trim().length > 0 || copy.cta.trim().length > 0;
}

export async function applyPostOverlay(
  input: { bytes: Uint8Array; mimeType: string },
  copy: OverlayCopy,
): Promise<OverlayResult> {
  const sharp = (await import("sharp")).default;
  if (!hasOverlayCopy(copy)) {
    return { bytes: input.bytes, mimeType: "image/png" };
  }
  const image = sharp(input.bytes, { failOn: "error" });
  const meta = await image.metadata();
  const width = meta.width ?? 1080;
  const height = meta.height ?? 1080;
  const composed = await sharp(input.bytes, { failOn: "error" })
    .composite([
      // Sharp treats STRING inputs as file paths — the SVG must be a buffer.
      { input: Buffer.from(overlaySvg(width, height, copy)), top: 0, left: 0 },
    ])
    .png({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  return { bytes: composed.data, mimeType: "image/png" };
}

/**
 * Fixed layout (never AI-decided):
 *   - soft bottom gradient scrim for legibility,
 *   - CTA: bold, bottom-centre,
 *   - brand name: small uppercase chip, bottom-right, below the CTA.
 * All text is escaped; sizes scale with the canvas so 1:1 and 4:5 share one
 * layout.
 */
export function overlaySvg(width: number, height: number, copy: OverlayCopy): string {
  const unit = Math.min(width, height);
  const ctaSize = Math.round(unit * 0.045);
  const brandSize = Math.round(unit * 0.022);
  const margin = Math.round(unit * 0.045);
  const scrimTop = Math.round(height * 0.62);
  const cta = cleanText(copy.cta, 48);
  const brand = cleanText(copy.brandName, 40);
  const ctaLine = cta ? svgText(width / 2, height - margin - (brand ? brandSize * 1.9 : 0), cta, ctaSize, 700, "middle") : "";
  const brandLine = brand
    ? svgText(width - margin, height - margin - (cta ? 0 : brandSize * 0.35), brand.toUpperCase(), brandSize, 600, "end")
    : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#000000" stop-opacity="0"/>`,
    `<stop offset="1" stop-color="#000000" stop-opacity="0.62"/>`,
    `</linearGradient></defs>`,
    `<rect x="0" y="${scrimTop}" width="${width}" height="${height - scrimTop}" fill="url(#scrim)"/>`,
    ctaLine,
    brandLine,
    `</svg>`,
  ].join("");
}

function svgText(x: number, y: number, text: string, size: number, weight: number, anchor: "middle" | "end"): string {
  return (
    `<text x="${x}" y="${y}" fill="#ffffff" font-family="Helvetica, Arial, sans-serif" ` +
    `font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" ` +
    `style="paint-order:stroke" stroke="rgba(0,0,0,0.55)" stroke-width="${Math.max(1, Math.round(size * 0.09))}">${escapeXml(text)}</text>`
  );
}

function cleanText(value: string, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
