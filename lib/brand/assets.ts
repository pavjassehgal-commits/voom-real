/**
 * Brand Kit v2, slice 5: brand assets (logo, product photos, past posts).
 *
 * The files live in the private `brand-kit` bucket (migration 0059) under
 * `<ownerId>/<kind>/<uuid>.<ext>`; a kit version stores REFERENCES only in its
 * `assets` column, never bytes. Each reference carries the one line that says
 * what the image is, and for past posts a few style chips and a short "look"
 * line. MARA may fill those from the image (lib/brand/vision.ts); the owner
 * can always change them, and `describedBy` says which of the two wrote the
 * current text.
 *
 * Pure and client-safe: the uploader, the Brand page and the server all use
 * these rules, and the Node suite tests them directly.
 */
import { z } from "zod";

export const BRAND_KIT_BUCKET = "brand-kit";

export const BRAND_ASSET_KINDS = ["logo", "product", "past_post"] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];

/** One logo, up to 10 products, up to 5 past posts; 10 MB each (the bucket's own cap). */
export const BRAND_ASSET_LIMITS = {
  logo: 1,
  product: 10,
  past_post: 5,
  maxBytes: 10 * 1024 * 1024,
  description: 120,
  look: 160,
  chips: 6,
} as const;

export const BRAND_ASSET_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type BrandAssetMimeType = (typeof BRAND_ASSET_MIME_TYPES)[number];
export const BRAND_ASSET_ACCEPT = ".jpg,.jpeg,.png,.webp";

/** The fixed style chips a past post can carry. MARA may only pick from these. */
export const PAST_POST_CHIPS = [
  "Bright",
  "Dark & moody",
  "Minimal",
  "Colourful",
  "Warm tones",
  "Cool tones",
  "Natural light",
  "People in shot",
  "Product close-up",
  "Behind the scenes",
  "Lifestyle",
  "Flat lay",
  "Text on image",
] as const;

export interface BrandAsset {
  id: string;
  kind: BrandAssetKind;
  path: string;
  mimeType: BrandAssetMimeType;
  byteSize: number;
  /** One line: what the image shows. */
  description: string;
  /** Past posts only: style chips from PAST_POST_CHIPS. */
  chips: string[];
  /** Past posts only: a short line on the look (light, colour, framing). */
  look: string;
  /** "mara" while the text is MARA's reading, unchanged; "owner" once edited; "" when empty. */
  describedBy: "mara" | "owner" | "";
}

/** Two colours, computed from the logo or picked by the owner. */
export interface BrandColours {
  primary: string | null;
  secondary: string | null;
  source: "logo" | "owner";
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH_RE = new RegExp(`^(${UUID})/(logo|product|past_post)/(${UUID})\\.(jpg|png|webp)$`, "i");
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** The storage path for a new upload. Always under the owner's own folder. */
export function brandAssetPath(ownerId: string, kind: BrandAssetKind, id: string, extension: "jpg" | "png" | "webp"): string {
  return `${ownerId}/${kind}/${id}.${extension}`;
}

/** True only for a well-formed brand-kit path inside this owner's folder, of the given kind when one is given. */
export function isOwnBrandAssetPath(ownerId: string, path: unknown, kind?: BrandAssetKind): path is string {
  if (typeof path !== "string") return false;
  const match = PATH_RE.exec(path);
  if (!match) return false;
  if (match[1].toLowerCase() !== ownerId.toLowerCase()) return false;
  return kind ? match[2] === kind : true;
}

export function isBrandColour(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

const assetSchema = z.object({
  id: z.string().regex(new RegExp(`^${UUID}$`, "i")),
  kind: z.enum(BRAND_ASSET_KINDS),
  path: z.string().regex(PATH_RE),
  mimeType: z.enum(BRAND_ASSET_MIME_TYPES),
  byteSize: z.number().int().min(1).max(BRAND_ASSET_LIMITS.maxBytes),
  description: z.string().transform((v) => v.trim().slice(0, BRAND_ASSET_LIMITS.description)).default(""),
  chips: z.array(z.string()).default([]),
  look: z.string().transform((v) => v.trim().slice(0, BRAND_ASSET_LIMITS.look)).default(""),
  describedBy: z.enum(["mara", "owner", ""]).default(""),
}).strip();

/**
 * Validates and caps a list of asset references: unknown chips dropped, chips
 * and look kept only on past posts, duplicates removed, and at most one logo,
 * ten products and five past posts (the first ones win). Returns null when any
 * entry is malformed, so a bad payload is refused rather than half-saved.
 */
export function cleanBrandAssets(raw: unknown): BrandAsset[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const counts: Record<BrandAssetKind, number> = { logo: 0, product: 0, past_post: 0 };
  const out: BrandAsset[] = [];
  for (const item of raw) {
    const parsed = assetSchema.safeParse(item);
    if (!parsed.success) return null;
    const asset = parsed.data;
    if (seen.has(asset.path)) continue;
    if (counts[asset.kind] >= BRAND_ASSET_LIMITS[asset.kind]) continue;
    seen.add(asset.path);
    counts[asset.kind] += 1;
    const pastPost = asset.kind === "past_post";
    const chips = pastPost
      ? [...new Set(asset.chips.filter((chip) => (PAST_POST_CHIPS as readonly string[]).includes(chip)))].slice(0, BRAND_ASSET_LIMITS.chips)
      : [];
    out.push({
      id: asset.id,
      kind: asset.kind,
      path: asset.path,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      description: asset.description,
      chips,
      look: pastPost ? asset.look : "",
      describedBy: asset.describedBy,
    });
  }
  return out;
}

/** Validates the colour pair. Anything that is not #RRGGBB becomes null. */
export function cleanBrandColours(raw: unknown): BrandColours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const primary = isBrandColour(value.primary) ? value.primary.toUpperCase() : null;
  const secondary = isBrandColour(value.secondary) ? value.secondary.toUpperCase() : null;
  if (!primary && !secondary) return null;
  return { primary, secondary, source: value.source === "owner" ? "owner" : "logo" };
}

/* ── List edits shared by the onboarding screen and the Brand page ───────── */

export function brandAssetCount(list: readonly BrandAsset[], kind: BrandAssetKind): number {
  return list.filter((asset) => asset.kind === kind).length;
}

/** Adds an upload unless that kind is already full (the uploader hides the button then too). */
export function withAddedAsset(list: readonly BrandAsset[], asset: BrandAsset): BrandAsset[] {
  if (list.some((item) => item.path === asset.path)) return [...list];
  if (brandAssetCount(list, asset.kind) >= BRAND_ASSET_LIMITS[asset.kind]) return [...list];
  return [...list, asset];
}

export function withoutAsset(list: readonly BrandAsset[], path: string): BrandAsset[] {
  return list.filter((asset) => asset.path !== path);
}

export type BrandAssetText = Partial<Pick<BrandAsset, "description" | "chips" | "look">>;

/**
 * Applies new text to one image. MARA's reading never overwrites what the
 * owner already typed (her answer can arrive after they started); the
 * owner's edit always wins and marks the text as theirs.
 */
export function withAssetText(list: readonly BrandAsset[], path: string, text: BrandAssetText, by: "mara" | "owner"): BrandAsset[] {
  return list.map((asset) => {
    if (asset.path !== path) return asset;
    if (by === "mara" && asset.describedBy === "owner") return asset;
    const pastPost = asset.kind === "past_post";
    const next: BrandAsset = {
      ...asset,
      description: (text.description ?? asset.description).slice(0, BRAND_ASSET_LIMITS.description),
      chips: pastPost ? (text.chips ?? asset.chips).filter((chip) => (PAST_POST_CHIPS as readonly string[]).includes(chip)).slice(0, BRAND_ASSET_LIMITS.chips) : [],
      look: pastPost ? (text.look ?? asset.look).slice(0, BRAND_ASSET_LIMITS.look) : "",
    };
    const empty = !next.description && !next.chips.length && !next.look;
    return { ...next, describedBy: empty ? "" : by };
  });
}

/** Colours computed from a new logo replace earlier computed ones, never colours the owner picked. */
export function coloursAfterLogo(current: BrandColours | null, computed: { primary: string | null; secondary: string | null } | null): BrandColours | null {
  if (current?.source === "owner") return current;
  if (!computed || (!computed.primary && !computed.secondary)) return current;
  return { primary: computed.primary, secondary: computed.secondary, source: "logo" };
}

/** After the logo is removed: colours computed from it go; colours the owner picked stay. */
export function coloursAfterLogoRemoved(current: BrandColours | null): BrandColours | null {
  return current?.source === "logo" ? null : current;
}

/** Plain-language count for history lines and summaries ("1 logo, 2 products"). */
export function describeBrandAssets(assets: readonly BrandAsset[] | null | undefined): string {
  const list = assets ?? [];
  const n = (kind: BrandAssetKind) => list.filter((asset) => asset.kind === kind).length;
  const parts = [
    n("logo") ? "logo" : "",
    n("product") ? `${n("product")} product photo${n("product") === 1 ? "" : "s"}` : "",
    n("past_post") ? `${n("past_post")} past post${n("past_post") === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing";
}

/**
 * The text-only visual style a prompt may carry, or null when there is
 * nothing to say. Paths, sizes and file names never leave the server.
 */
export function brandVisualStyle(assets: readonly BrandAsset[], colours: BrandColours | null) {
  const palette = [colours?.primary, colours?.secondary].filter((c): c is string => Boolean(c));
  const logo = assets.find((asset) => asset.kind === "logo")?.description ?? "";
  const products = assets.filter((asset) => asset.kind === "product" && asset.description).map((asset) => asset.description);
  const posts = assets.filter((asset) => asset.kind === "past_post");
  const looks = posts.map((asset) => asset.look).filter(Boolean);
  const tally = new Map<string, number>();
  for (const post of posts) for (const chip of post.chips) tally.set(chip, (tally.get(chip) ?? 0) + 1);
  const styleTags = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([chip]) => chip).slice(0, 6);
  const pastPostSubjects = posts.map((asset) => asset.description).filter(Boolean);
  if (!palette.length && !logo && !products.length && !looks.length && !styleTags.length && !pastPostSubjects.length) return null;
  return {
    ...(palette.length ? { palette } : {}),
    ...(logo ? { logo } : {}),
    ...(products.length ? { products } : {}),
    ...(looks.length || styleTags.length || pastPostSubjects.length
      ? { pastPosts: { ...(styleTags.length ? { styleTags } : {}), ...(looks.length ? { looks } : {}), ...(pastPostSubjects.length ? { subjects: pastPostSubjects } : {}) } }
      : {}),
  };
}

export type BrandVisualStyle = NonNullable<ReturnType<typeof brandVisualStyle>>;
