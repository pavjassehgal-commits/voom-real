/**
 * Post Studio core logic — pure and dependency-free so it can be unit tested
 * without a database, a provider, or a browser.
 *
 * Everything here stays internal to Voom. Nothing in this module talks to
 * Instagram, and no state in this module is ever labelled "Posted".
 */

/** Instagram Post V1 formats. */
export const POST_FORMATS = ["1:1", "4:5"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

/** The mara_drafts.kind values Post Studio writes. */
export const POST_DRAFT_KIND = "instagram_post";
export const REEL_DRAFT_KIND = "reel";
export type PostDraftKind = typeof POST_DRAFT_KIND | typeof REEL_DRAFT_KIND;

/** How the visual for this post came to exist. */
export const POST_ORIGINS = ["mara", "own_asset", "existing_content"] as const;
export type PostOrigin = (typeof POST_ORIGINS)[number];

/** post_draft_assets.origin values, one per Post Studio entry point. */
export const ASSET_ORIGINS = ["mara_generated", "user_upload", "existing_content"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

/**
 * Truthful internal lifecycle states. There is deliberately no "posted" state:
 * Voom does not publish to Instagram yet.
 */
export const POST_INTERNAL_STATES = ["draft", "approved", "scheduled_internal", "ready_to_publish"] as const;
export type PostInternalState = (typeof POST_INTERNAL_STATES)[number];

export const POST_STATE_LABELS: Record<PostInternalState, string> = {
  draft: "Draft",
  approved: "Approved",
  scheduled_internal: "Scheduled internally",
  ready_to_publish: "Ready to publish",
};

export const POST_TYPE_LABELS = {
  instagram_post: "Instagram Post",
  reel: "Reel",
  existing_content: "Existing content",
} as const;

export function isPostFormat(value: unknown): value is PostFormat {
  return value === "1:1" || value === "4:5";
}

export function normalizePostFormat(value: unknown, fallback: PostFormat = "1:1"): PostFormat {
  return isPostFormat(value) ? value : fallback;
}

/** CSS aspect-ratio value used by the editor preview. */
export function formatAspectRatio(format: PostFormat): string {
  return format === "4:5" ? "4 / 5" : "1 / 1";
}

export type PostAssetKind = "image" | "video";

/** Classifies a stored mime type. Kept dependency-free so tests can import it. */
export function postAssetKindForMime(mime: string): PostAssetKind | null {
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") return "image";
  if (mime === "video/mp4" || mime === "video/quicktime") return "video";
  return null;
}

export function isPostDraftKind(value: unknown): value is PostDraftKind {
  return value === POST_DRAFT_KIND || value === REEL_DRAFT_KIND;
}

export function isPostOrigin(value: unknown): value is PostOrigin {
  return typeof value === "string" && (POST_ORIGINS as readonly string[]).includes(value);
}

/** Maps a Post Studio entry point to the stored asset origin. */
export function assetOriginFor(origin: PostOrigin): AssetOrigin {
  if (origin === "mara") return "mara_generated";
  if (origin === "existing_content") return "existing_content";
  return "user_upload";
}

export function originForAsset(assetOrigin: string | null | undefined): PostOrigin {
  if (assetOrigin === "mara_generated") return "mara";
  if (assetOrigin === "existing_content") return "existing_content";
  return "own_asset";
}

/**
 * The one label the calendar and post list use to distinguish content types.
 * Imported existing content is called out first because that is the more
 * specific truth about where the visual came from.
 */
export function postTypeLabel(kind: string, assetOrigin: string | null | undefined): string {
  if (assetOrigin === "existing_content") return POST_TYPE_LABELS.existing_content;
  return kind === REEL_DRAFT_KIND ? POST_TYPE_LABELS.reel : POST_TYPE_LABELS.instagram_post;
}

/** The existing Content Calendar channel enum value for a post kind. */
export function calendarChannelFor(kind: string): "Instagram" | "Reel" {
  return kind === REEL_DRAFT_KIND ? "Reel" : "Instagram";
}

/** Which asset kinds each post type accepts. */
export function allowedAssetKindsFor(kind: string): ("image" | "video")[] {
  return kind === REEL_DRAFT_KIND ? ["image", "video"] : ["image"];
}

export const MAX_HASHTAGS = 20;
export const MAX_HASHTAG_LENGTH = 30;

/** Cleans free text or a list into at most 20 usable hashtags, without the "#". */
export function normalizeHashtags(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input.map((item) => String(item ?? ""))
    : String(input ?? "").split(/[\s,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw) {
    const clean = token.trim().replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, MAX_HASHTAG_LENGTH);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

export function formatHashtags(hashtags: string[]): string {
  return hashtags.map((tag) => `#${tag}`).join(" ");
}

/**
 * Composes the stored caption body. This is the exact text a user would copy
 * into Instagram: caption, then an explicit CTA line, then the hashtags.
 * Kept reversible by splitPostCaption so the editor can show the parts.
 */
export function composePostCaption(input: { caption: string; cta?: string; hashtags?: string[] }): string {
  const parts = [input.caption.trim()];
  const cta = input.cta?.trim();
  if (cta) parts.push(`CTA: ${cta}`);
  const tags = formatHashtags(normalizeHashtags(input.hashtags ?? []));
  if (tags) parts.push(tags);
  return parts.filter(Boolean).join("\n\n");
}

const CTA_LINE = /^\s*cta:\s*(.+?)\s*$/i;

/** Reverses composePostCaption. Tolerates hand-written captions too. */
export function splitPostCaption(content: string): { caption: string; cta: string; hashtags: string[] } {
  let lines = String(content ?? "").split("\n");

  // Hashtags live on the last non-empty line when every token is a hashtag.
  let hashtags: string[] = [];
  const trailing = lines.map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const tokens = trailing.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => token.startsWith("#"))) {
    hashtags = normalizeHashtags(tokens);
    const dropFrom = lines.length - 1 - [...lines].reverse().findIndex((line) => line.trim() === trailing);
    lines = lines.filter((_, index) => index !== dropFrom);
  }

  // The CTA is the last explicit "CTA:" line anywhere in the body.
  let cta = "";
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = CTA_LINE.exec(lines[index]);
    if (match) {
      cta = match[1].trim();
      lines = lines.filter((_, at) => at !== index);
      break;
    }
  }

  return { caption: lines.join("\n").trim(), cta, hashtags };
}

export function postHasVisual(asset: { status?: string } | null | undefined): boolean {
  return Boolean(asset && asset.status === "uploaded");
}

/**
 * Derives the truthful internal state.
 *
 *  - not approved               -> Draft
 *  - approved, no schedule      -> Approved
 *  - approved, scheduled, no
 *    visual yet                 -> Scheduled internally
 *  - approved, scheduled and a
 *    stored visual              -> Ready to publish
 */
export function internalPostState(input: { status: string; scheduledAt: string | null; hasVisual: boolean }): PostInternalState {
  if (input.status !== "approved") return "draft";
  if (!input.scheduledAt) return "approved";
  if (!input.hasVisual) return "scheduled_internal";
  return "ready_to_publish";
}

/** Only approved content reaches the existing Content Calendar. */
export function appearsOnCalendar(state: PostInternalState): boolean {
  return state !== "draft";
}

/** Maps an internal state onto the existing content_calendar_items.status enum. */
export function calendarStatusFor(state: PostInternalState): "approved" | "scheduled" {
  return state === "approved" ? "approved" : "scheduled";
}

/** Reasons a post may not be approved yet. Empty means it may be approved. */
export function postApprovalBlockers(input: { caption: string; hasVisual: boolean }): string[] {
  const blockers: string[] = [];
  if (!input.caption.trim()) blockers.push("Add a caption before approving.");
  if (!input.hasVisual) blockers.push("Add a visual before approving. Instagram posts and Reels need one.");
  return blockers;
}

/** Normalises a user-supplied schedule into an ISO string, or null. */
export function normalizeSchedule(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function isFutureSchedule(value: string | null, now: number = Date.now()): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed >= now - 5 * 60_000;
}
