/**
 * Brand Kit v2, slice 5: the two image jobs done by code, not by the AI.
 *
 *   - `computeLogoColours`: the two dominant colours of a logo, from its
 *     pixels. Transparent and white/near-white pixels are ignored (they are
 *     almost always the background); black is kept, because many logos are
 *     black. Labelled "computed from your logo" wherever it is shown.
 *   - `downscaleForVision`: a small JPEG copy (max 768 px) of an image, which
 *     is all the vision model needs. Cheaper, faster and well under every
 *     provider's inline-image limit; the owner's original is never changed.
 *
 * Uses `sharp` (already a dependency for email images), loaded lazily so the
 * module stays importable where the native binary is missing.
 */

export interface ComputedColours {
  primary: string | null;
  secondary: string | null;
}

const SAMPLE_SIZE = 64;
/** A second colour must be clearly different from the first (RGB distance). */
const MIN_COLOUR_DISTANCE = 60;
/** ...and cover at least this share of the counted pixels. */
const MIN_SECONDARY_SHARE = 0.03;

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export async function computeLogoColours(bytes: Uint8Array): Promise<ComputedColours> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(Buffer.from(bytes), { failOn: "error" })
    .rotate()
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "inside", withoutEnlargement: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Bucket colours to 4 bits per channel, then average inside each bucket.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let counted = 0;
  for (let i = 0; i + 3 < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue;
    if (r > 235 && g > 235 && b > 235) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
    counted += 1;
  }
  if (counted === 0) return { primary: null, secondary: null };

  const ranked = [...buckets.values()]
    .sort((x, y) => y.count - x.count)
    .map((bucket) => ({ count: bucket.count, r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count }));
  const first = ranked[0];
  const second = ranked.slice(1).find((bucket) => {
    const distance = Math.hypot(bucket.r - first.r, bucket.g - first.g, bucket.b - first.b);
    return distance >= MIN_COLOUR_DISTANCE && bucket.count / counted >= MIN_SECONDARY_SHARE;
  });
  return {
    primary: hex(first.r, first.g, first.b),
    secondary: second ? hex(second.r, second.g, second.b) : null,
  };
}

export const VISION_MAX_EDGE = 768;

export async function downscaleForVision(bytes: Uint8Array): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  const output = await sharp(Buffer.from(bytes), { failOn: "error" })
    .rotate()
    .resize(VISION_MAX_EDGE, VISION_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return new Uint8Array(output);
}
