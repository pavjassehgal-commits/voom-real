/**
 * Post Studio core logic — pure and dependency-free so it can be unit tested
 * without a database, a provider, or a browser.
 *
 * Everything here stays internal to Voom. Nothing in this module talks to
 * Instagram, and no state in this module is ever labelled "Posted".
 */

/** Instagram Post V1 formats, plus the 9:16 Story format. */
export const POST_FORMATS = ["1:1", "4:5", "9:16"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

/** The mara_drafts.kind values Post Studio writes. */
export const POST_DRAFT_KIND = "instagram_post";
export const REEL_DRAFT_KIND = "reel";
export const STORY_DRAFT_KIND = "story";
export type PostDraftKind = typeof POST_DRAFT_KIND | typeof REEL_DRAFT_KIND | typeof STORY_DRAFT_KIND;

/**
 * Multi-Social Core: the mara_drafts.kind values the unified Studio writes for
 * TikTok and YouTube. They live in Voom, can be approved and scheduled, and
 * publish through their own durable provider queues (lib/tiktok, lib/youtube)
 * once the channel is connected. They never touch the Instagram publish queue.
 */
export const TIKTOK_VIDEO_DRAFT_KIND = "tiktok_video";
export const YOUTUBE_SHORT_DRAFT_KIND = "youtube_short";
export const YOUTUBE_VIDEO_DRAFT_KIND = "youtube_video";
export type SocialVideoDraftKind =
  | typeof TIKTOK_VIDEO_DRAFT_KIND
  | typeof YOUTUBE_SHORT_DRAFT_KIND
  | typeof YOUTUBE_VIDEO_DRAFT_KIND;

export const SOCIAL_VIDEO_DRAFT_KINDS: readonly string[] = [
  TIKTOK_VIDEO_DRAFT_KIND,
  YOUTUBE_SHORT_DRAFT_KIND,
  YOUTUBE_VIDEO_DRAFT_KIND,
];

export function isSocialVideoDraftKind(value: unknown): value is SocialVideoDraftKind {
  return typeof value === "string" && SOCIAL_VIDEO_DRAFT_KINDS.includes(value);
}

/** Every draft kind the unified Studio creates. */
export type StudioDraftKind = PostDraftKind | SocialVideoDraftKind;

export function isStudioDraftKind(value: unknown): value is StudioDraftKind {
  return isPostDraftKind(value) || isSocialVideoDraftKind(value);
}

/** Display labels for the social video kinds. */
export const SOCIAL_VIDEO_TYPE_LABELS: Record<SocialVideoDraftKind, string> = {
  tiktok_video: "TikTok Video",
  youtube_short: "YouTube Short",
  youtube_video: "YouTube Video",
};

/** The Content Calendar channel label for a social video kind (0046 enum). */
export function socialCalendarChannelFor(kind: string): "TikTok" | "YouTube Short" | "YouTube Video" | null {
  if (kind === TIKTOK_VIDEO_DRAFT_KIND) return "TikTok";
  if (kind === YOUTUBE_SHORT_DRAFT_KIND) return "YouTube Short";
  if (kind === YOUTUBE_VIDEO_DRAFT_KIND) return "YouTube Video";
  return null;
}

/** How the visual for this post came to exist (UI / API, not a DB column). */
export const POST_ORIGINS = ["mara", "own_asset", "existing_content"] as const;
export type PostOrigin = (typeof POST_ORIGINS)[number];

/**
 * Production 0021 `post_draft_assets.origin` values. The applied check is
 * exactly `origin in ('uploaded_asset','uploaded_existing')`.
 */
export const ASSET_ORIGINS = ["uploaded_asset", "uploaded_existing"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

/** Columns that exist on production `post_draft_assets`. There is no `format`. */
export const POST_DRAFT_ASSET_PRODUCTION_COLUMNS = [
  "id",
  "owner_user_id",
  "draft_id",
  "storage_path",
  "display_name",
  "mime_type",
  "byte_size",
  "origin",
  "status",
  "created_at",
  "updated_at",
] as const;

/** Columns the service role writes on insert/upsert. id/timestamps are defaults. */
export const POST_DRAFT_ASSET_WRITE_COLUMNS = [
  "owner_user_id",
  "draft_id",
  "storage_path",
  "display_name",
  "mime_type",
  "byte_size",
  "origin",
  "status",
] as const;

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
  story: "Instagram Story",
  existing_content: "Existing content",
} as const;

export function isPostFormat(value: unknown): value is PostFormat {
  return value === "1:1" || value === "4:5" || value === "9:16";
}

export function normalizePostFormat(value: unknown, fallback: PostFormat = "1:1"): PostFormat {
  return isPostFormat(value) ? value : fallback;
}

/** CSS aspect-ratio value used by the editor preview. */
export function formatAspectRatio(format: PostFormat): string {
  return format === "4:5" ? "4 / 5" : format === "9:16" ? "9 / 16" : "1 / 1";
}

export type PostAssetKind = "image" | "video";

/** Classifies a stored mime type. Kept dependency-free so tests can import it. */
export function postAssetKindForMime(mime: string): PostAssetKind | null {
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") return "image";
  if (mime === "video/mp4" || mime === "video/quicktime") return "video";
  return null;
}

export function isPostDraftKind(value: unknown): value is PostDraftKind {
  return value === POST_DRAFT_KIND || value === REEL_DRAFT_KIND || value === STORY_DRAFT_KIND;
}

// ---------------------------------------------------------------------------
// Persisting the selected format on the draft itself
//
// mara_drafts has no JSON column and no free metadata column, so the selected
// format is encoded into mara_drafts.channel — a free-form label constrained
// only to 1-60 characters, with no enum, no foreign key, and nothing in the
// codebase that filters mara_drafts by channel. This keeps the choice alive on
// the draft even when no visual exists yet, and needs no schema migration.
//
// The draft's channel is the single source of truth for format. The mirrored
// post_draft_assets.format column is written from it and never read back, so
// the two can never disagree.
// ---------------------------------------------------------------------------

export const POST_CHANNEL_SEPARATOR = " · ";

/** The clean channel label, matching what the rest of Voom writes. */
export function baseChannelFor(kind: string): "Instagram" | "Reel" | "Story" {
  return kind === REEL_DRAFT_KIND ? "Reel" : kind === STORY_DRAFT_KIND ? "Story" : "Instagram";
}

/** Encodes the selected format into the free-form mara_drafts.channel label. */
export function encodeDraftChannel(kind: string, format: PostFormat): string {
  return `${baseChannelFor(kind)}${POST_CHANNEL_SEPARATOR}${normalizePostFormat(format)}`;
}

/** Strips the encoded format back off, leaving the clean channel label. */
export function baseChannelFromDraftChannel(channel: string | null | undefined): string {
  const value = String(channel ?? "").trim();
  const base = value.split(POST_CHANNEL_SEPARATOR)[0]?.trim();
  return base || "Instagram";
}

/**
 * Reads the persisted format back out of mara_drafts.channel.
 *
 * Deliberately tolerant for backward compatibility: drafts written before this
 * change carry a bare "Instagram" or "Reel" with no encoded format, and any
 * unrecognised value falls back to 1:1 rather than throwing.
 */
export function decodeDraftFormat(channel: string | null | undefined, fallback: PostFormat = "1:1"): PostFormat {
  const value = String(channel ?? "");
  const segments = value.split(POST_CHANNEL_SEPARATOR);
  const encoded = segments[segments.length - 1]?.trim();
  return isPostFormat(encoded) ? encoded : normalizePostFormat(fallback, "1:1");
}

export function isPostOrigin(value: unknown): value is PostOrigin {
  return typeof value === "string" && (POST_ORIGINS as readonly string[]).includes(value);
}

/**
 * Maps a Post Studio entry point to the production origin check.
 *
 *   - already-made imported image/video → uploaded_existing
 *   - user's own asset on a MARA Post   → uploaded_asset
 *   - MARA-generated visual             → uploaded_asset
 *
 * Post Studio Reels are imported existing videos, so a reel kind is stored as
 * uploaded_existing even if the caller sent own_asset (the editor has no
 * origin on the draft until a visual exists).
 */
export function assetOriginFor(origin: PostOrigin, kind?: string): AssetOrigin {
  if (origin === "existing_content" || kind === REEL_DRAFT_KIND) return "uploaded_existing";
  return "uploaded_asset";
}

export function originForAsset(assetOrigin: string | null | undefined): PostOrigin {
  if (assetOrigin === "uploaded_existing" || assetOrigin === "existing_content") return "existing_content";
  if (assetOrigin === "mara_generated") return "mara";
  return "own_asset";
}

export interface PostDraftAssetWrite {
  owner_user_id: string;
  draft_id: string;
  storage_path: string;
  display_name: string;
  mime_type: string;
  byte_size: number;
  origin: AssetOrigin;
  status: "uploaded";
}

/**
 * The exact row upserted into production `post_draft_assets`. Deliberately
 * omits `format` — that column does not exist in production 0021.
 */
export function buildPostDraftAssetWrite(input: {
  ownerUserId: string;
  draftId: string;
  storagePath: string;
  displayName: string;
  mimeType: string;
  byteSize: number;
  origin: PostOrigin;
  kind?: string;
}): PostDraftAssetWrite {
  return {
    owner_user_id: input.ownerUserId,
    draft_id: input.draftId,
    storage_path: input.storagePath,
    display_name: input.displayName.slice(0, 180),
    mime_type: input.mimeType,
    byte_size: input.byteSize,
    origin: assetOriginFor(input.origin, input.kind),
    status: "uploaded",
  };
}

/** True when every key is a production column, `format` is absent, and origin is legal. */
export function isProductionPostDraftAssetWrite(row: object): row is PostDraftAssetWrite {
  const record = row as Record<string, unknown>;
  if ("format" in record) return false;
  const keys = Object.keys(record);
  if (keys.length !== POST_DRAFT_ASSET_WRITE_COLUMNS.length) return false;
  if (!keys.every((key) => (POST_DRAFT_ASSET_WRITE_COLUMNS as readonly string[]).includes(key))) return false;
  return record.origin === "uploaded_asset" || record.origin === "uploaded_existing";
}

/**
 * The one label the calendar and post list use to distinguish content types.
 * Imported existing content is called out first because that is the more
 * specific truth about where the visual came from — except Stories, which are
 * always labelled as Stories so the calendar can badge them unambiguously.
 */
export function postTypeLabel(kind: string, assetOrigin: string | null | undefined): string {
  if (kind === STORY_DRAFT_KIND) return POST_TYPE_LABELS.story;
  if (assetOrigin === "uploaded_existing" || assetOrigin === "existing_content") return POST_TYPE_LABELS.existing_content;
  return kind === REEL_DRAFT_KIND ? POST_TYPE_LABELS.reel : POST_TYPE_LABELS.instagram_post;
}
/** The existing Content Calendar channel enum value for a post kind. */
export function calendarChannelFor(kind: string): "Instagram" | "Reel" | "Story" {
  return kind === REEL_DRAFT_KIND ? "Reel" : kind === STORY_DRAFT_KIND ? "Story" : "Instagram";
}

/** Which asset kinds each post type accepts. A Story is an image or a video. */
export function allowedAssetKindsFor(kind: string): ("image" | "video")[] {
  return kind === REEL_DRAFT_KIND || kind === STORY_DRAFT_KIND ? ["image", "video"] : ["image"];
}

/**
 * The legal format for a content kind. Stories are always 9:16 (Meta's Story
 * canvas); 9:16 is not a feed post format, so it never sticks to a Post.
 */
export function formatForKind(kind: string, format: PostFormat): PostFormat {
  if (kind === STORY_DRAFT_KIND) return "9:16";
  return format === "9:16" ? "1:1" : format;
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
/**
 * Reasons content may not be approved yet. Empty means it may be approved.
 * Stories have no caption requirement — Instagram does not support captions on
 * Stories — but they still require a stored visual before approval.
 */
export function postApprovalBlockers(input: { caption: string; hasVisual: boolean; kind?: string }): string[] {
  const blockers: string[] = [];
  const isStory = input.kind === STORY_DRAFT_KIND;
  if (!isStory && !input.caption.trim()) blockers.push("Add a caption before approving.");
  if (!input.hasVisual) {
    blockers.push(isStory
      ? "Add an image or video before approving. Instagram Stories need one."
      : "Add a visual before approving. Instagram posts and Reels need one.");
  }
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
