/**
 * Brand Kit v2, slice 5: brand assets (logo, product photos, past posts).
 *
 * The files live in the private `brand-kit` bucket (migration 0075) under
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

/** A pair of colours as found in one place (the logo's pixels, the website's look). */
export interface BrandPalette {
  primary: string | null;
  secondary: string | null;
}

export type BrandColourSource = "logo" | "website" | "owner";

/**
 * The colours MARA uses: `primary` is the dominant colour (what images lead
 * with), `secondary` supports it. `source` says where the pair in use came
 * from. Since slice 7 the palettes FOUND per source are kept side by side in
 * `found` and never overwrite each other: a logo's computed colours and the
 * website's colours can both exist, and the owner chooses which one MARA
 * uses (or picks by hand, source "owner").
 */
export interface BrandColours extends BrandPalette {
  source: BrandColourSource;
  found?: { logo?: BrandPalette; website?: BrandPalette };
}

export const BRAND_COLOUR_SOURCE_LABELS: Record<BrandColourSource, string> = {
  logo: "Computed from your logo",
  website: "From your website",
  owner: "Picked by you",
};

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

function cleanPalette(raw: unknown): BrandPalette | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const primary = isBrandColour(value.primary) ? value.primary.toUpperCase() : null;
  const secondary = isBrandColour(value.secondary) ? value.secondary.toUpperCase() : null;
  if (!primary && !secondary) return null;
  return { primary, secondary };
}

const hasColour = (palette: BrandPalette | null | undefined): palette is BrandPalette => Boolean(palette && (palette.primary || palette.secondary));

/**
 * Validates the colours. Anything that is not #RRGGBB becomes null; a found
 * palette with no colour is dropped; null when nothing is left at all (no
 * pair in use and nothing found).
 */
export function cleanBrandColours(raw: unknown): BrandColours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const inUse = cleanPalette(value) ?? { primary: null, secondary: null };
  const foundRaw = value.found && typeof value.found === "object" && !Array.isArray(value.found) ? (value.found as Record<string, unknown>) : {};
  const logo = cleanPalette(foundRaw.logo);
  const website = cleanPalette(foundRaw.website);
  const found = { ...(logo ? { logo } : {}), ...(website ? { website } : {}) };
  if (!hasColour(inUse) && !logo && !website) return null;
  const source: BrandColourSource = value.source === "owner" || value.source === "website" ? value.source : "logo";
  return { ...inUse, source, ...(Object.keys(found).length ? { found } : {}) };
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

/* ── Colour rules (slice 5, reworked in slice 7 to keep a palette per source) ── */

function withFound(current: BrandColours | null, found: NonNullable<BrandColours["found"]>): NonNullable<BrandColours["found"]> {
  return { ...(current?.found ?? {}), ...found };
}

/** Drops empty found entries; null when nothing is left anywhere. */
function settle(colours: BrandColours): BrandColours | null {
  const found = { ...(hasColour(colours.found?.logo) ? { logo: colours.found!.logo! } : {}), ...(hasColour(colours.found?.website) ? { website: colours.found!.website! } : {}) };
  if (!hasColour(colours) && !Object.keys(found).length) return null;
  return { primary: colours.primary, secondary: colours.secondary, source: colours.source, ...(Object.keys(found).length ? { found } : {}) };
}

/** True when the pair in use may be replaced by a newly found palette: nothing in use yet, or not the owner's own pick. */
function inUseIsReplaceable(current: BrandColours | null): boolean {
  return !current || !hasColour(current) || current.source !== "owner";
}

/**
 * A new logo's computed colours become the logo palette (replacing an earlier
 * logo palette only). They are used when the pair in use is replaceable: the
 * logo wins over the website by default, never over the owner's own pick.
 */
export function coloursAfterLogo(current: BrandColours | null, computed: BrandPalette | null): BrandColours | null {
  if (!hasColour(computed)) return current;
  const logo = { primary: computed.primary, secondary: computed.secondary };
  const found = withFound(current, { logo });
  if (!inUseIsReplaceable(current)) return settle({ ...current!, found });
  return settle({ ...logo, source: "logo", found });
}

/**
 * The website's colours become the website palette (replacing an earlier
 * website palette only). They are used only when nothing is in use yet or the
 * website's earlier palette was: a logo's colours and the owner's pick both win.
 */
export function coloursAfterWebsite(current: BrandColours | null, palette: BrandPalette | null): BrandColours | null {
  if (!hasColour(palette)) return current;
  const website = { primary: palette.primary, secondary: palette.secondary };
  const found = withFound(current, { website });
  const useIt = !current || !hasColour(current) || current.source === "website";
  if (!useIt) return settle({ ...current!, found });
  return settle({ ...website, source: "website", found });
}

/** After the logo is removed: its palette goes; if it was in use, the website's palette takes over, else nothing is in use. The owner's pick stays. */
export function coloursAfterLogoRemoved(current: BrandColours | null): BrandColours | null {
  if (!current) return null;
  const found = { ...(current.found ?? {}) };
  delete found.logo;
  if (current.source !== "logo") return settle({ ...current, found });
  if (hasColour(found.website)) return settle({ ...found.website!, source: "website", found });
  return settle({ primary: null, secondary: null, source: "logo", found });
}

/** The owner chooses one of the found palettes as the pair MARA uses. */
export function chooseFoundPalette(current: BrandColours | null, which: "logo" | "website"): BrandColours | null {
  const palette = current?.found?.[which];
  if (!hasColour(palette)) return current;
  return settle({ ...palette, source: which, found: current!.found! });
}

/** Swaps which colour is dominant. The source stays: the colours are still the logo's or the website's, in the owner's order. */
export function swapBrandColours(current: BrandColours | null): BrandColours | null {
  if (!current) return null;
  return settle({ ...current, primary: current.secondary, secondary: current.primary });
}

/** The owner types one colour by hand: the pair becomes their own pick; found palettes stay available. */
export function pickBrandColour(current: BrandColours | null, which: "primary" | "secondary", value: string): BrandColours | null {
  if (!isBrandColour(value)) return current;
  return settle({ primary: current?.primary ?? null, secondary: current?.secondary ?? null, [which]: value.toUpperCase(), source: "owner", ...(current?.found ? { found: current.found } : {}) });
}

/** Clears the pair in use (MARA uses no colours); found palettes stay available to use again. */
export function clearBrandColours(current: BrandColours | null): BrandColours | null {
  if (!current) return null;
  return settle({ primary: null, secondary: null, source: "owner", ...(current.found ? { found: current.found } : {}) });
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
/** What the homepage screenshot told MARA about the site's look (slice 7). Text only. */
export interface WebsiteLookNote {
  look: string;
  styleTags: string[];
}

export function brandVisualStyle(assets: readonly BrandAsset[], colours: BrandColours | null, website: WebsiteLookNote | null = null) {
  // The dominant colour is named, not just listed: image prompts lead with it.
  const palette = colours && (colours.primary || colours.secondary)
    ? {
        dominant: colours.primary ?? colours.secondary!,
        ...(colours.primary && colours.secondary ? { supporting: colours.secondary } : {}),
        source: colours.source === "logo" ? "computed from the logo" : colours.source === "website" ? "the website's colours" : "picked by the owner",
      }
    : null;
  const siteLook = website && (website.look || website.styleTags.length) ? { ...(website.look ? { look: website.look } : {}), ...(website.styleTags.length ? { styleTags: website.styleTags } : {}) } : null;
  const logo = assets.find((asset) => asset.kind === "logo")?.description ?? "";
  const products = assets.filter((asset) => asset.kind === "product" && asset.description).map((asset) => asset.description);
  const posts = assets.filter((asset) => asset.kind === "past_post");
  const looks = posts.map((asset) => asset.look).filter(Boolean);
  const tally = new Map<string, number>();
  for (const post of posts) for (const chip of post.chips) tally.set(chip, (tally.get(chip) ?? 0) + 1);
  const styleTags = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([chip]) => chip).slice(0, 6);
  const pastPostSubjects = posts.map((asset) => asset.description).filter(Boolean);
  if (!palette && !siteLook && !logo && !products.length && !looks.length && !styleTags.length && !pastPostSubjects.length) return null;
  return {
    ...(palette ? { palette } : {}),
    ...(siteLook ? { website: siteLook } : {}),
    ...(logo ? { logo } : {}),
    ...(products.length ? { products } : {}),
    ...(looks.length || styleTags.length || pastPostSubjects.length
      ? { pastPosts: { ...(styleTags.length ? { styleTags } : {}), ...(looks.length ? { looks } : {}), ...(pastPostSubjects.length ? { subjects: pastPostSubjects } : {}) } }
      : {}),
  };
}

export type BrandVisualStyle = NonNullable<ReturnType<typeof brandVisualStyle>>;
