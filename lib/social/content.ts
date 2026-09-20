/**
 * Voom Multi-Social Core — the channel-neutral social content model.
 *
 * Voom's existing content architecture (`mara_drafts` + `post_draft_assets` +
 * `content_calendar_items`) is evolved, NOT replaced: migration 0046 adds a
 * small structured layer to `mara_drafts`:
 *
 *   social_channel   canonical channel (instagram | tiktok | youtube | email)
 *   social_format    canonical format (post | reel | story | video | short)
 *   content_meta     structured, extensible JSONB deliverable:
 *                    { title, description, concept, script[], hashtags[] }
 *                    (thumbnail/playlist/audience settings can be added
 *                    later without another redesign)
 *   provider_ref     the provider's own publication reference — written ONLY
 *                    from a real provider confirmation, never invented.
 *
 * This module is the ONE mapping between those rows and a channel-neutral
 * `SocialContentRecord`. Every existing Instagram draft maps through the
 * legacy fallback (kind/channel), so historical rows stay fully compatible
 * with no backfill dependency.
 *
 * Pure and dependency-free: the Node suite executes this for real.
 */

import {
  isValidChannelFormat,
  parseActionChannel,
  type SocialChannel,
  type SocialFormat,
  type SocialMediaChannel,
} from "./channels";
import {
  publishStateForUnconnectedProvider,
  publishStateFromDraftStatus,
  publishStateFromInstagramQueue,
  type SocialPublishState,
} from "./publish-state";

/** The mara_drafts.kind values that carry social content, per channel. */
export const SOCIAL_DRAFT_KINDS = {
  instagram: ["instagram_post", "reel", "story"],
  tiktok: ["tiktok_video"],
  youtube: ["youtube_short", "youtube_video"],
} as const;

/** Every draft kind that is social content on some channel. */
export const ALL_SOCIAL_DRAFT_KINDS: readonly string[] = [
  ...SOCIAL_DRAFT_KINDS.instagram,
  ...SOCIAL_DRAFT_KINDS.tiktok,
  ...SOCIAL_DRAFT_KINDS.youtube,
];

/** Legacy draft kind → canonical channel+format (backward compatibility). */
export const LEGACY_KIND_CHANNEL_FORMAT: Record<string, { channel: SocialMediaChannel; format: SocialFormat }> = {
  instagram_post: { channel: "instagram", format: "post" },
  reel: { channel: "instagram", format: "reel" },
  story: { channel: "instagram", format: "story" },
  tiktok_video: { channel: "tiktok", format: "video" },
  youtube_short: { channel: "youtube", format: "short" },
  youtube_video: { channel: "youtube", format: "video" },
};

/**
 * The draft kind Voom writes for one validated channel+format pair. The write
 * vocabulary is exactly the persisted one: the legacy Instagram kinds
 * (instagram_post/reel/story) are preserved verbatim, and the 0046 social
 * video kinds are channel_format. Deriving it from the ONE map keeps reads
 * and writes from ever drifting apart.
 */
export function draftKindFor(channel: SocialMediaChannel, format: string): string | null {
  if (!isValidChannelFormat(channel, format)) return null;
  for (const [kind, pair] of Object.entries(LEGACY_KIND_CHANNEL_FORMAT)) {
    if (pair.channel === channel && pair.format === format) return kind;
  }
  return null;
}

/** The compact campaign-action identifier for one draft kind. */
export function actionChannelForDraftKind(kind: string): string | null {
  const pair = LEGACY_KIND_CHANNEL_FORMAT[kind];
  if (!pair) return null;
  return `${pair.channel}_${pair.format}`;
}

/** True when a draft kind carries social content. */
export function isSocialDraftKind(kind: unknown): boolean {
  return typeof kind === "string" && ALL_SOCIAL_DRAFT_KINDS.includes(kind);
}

/** The structured deliverable stored in mara_drafts.content_meta (0046). */
export interface SocialContentMeta {
  /** Long-form title (YouTube Video/Short, TikTok). */
  title?: string | null;
  /** Long-form description (YouTube). */
  description?: string | null;
  /** The internal creative concept. */
  concept?: string | null;
  /** Script / outline lines (YouTube Video, Reels, TikTok). */
  script?: string[];
  /** Hashtags without the "#". */
  hashtags?: string[];
}

/**
 * Normalizes arbitrary JSONB into the structured meta shape. Unknown keys are
 * preserved (so future metadata like thumbnail/playlist survives a round
 * trip), and every known field is type-checked — hostile input can never
 * smuggle a non-string into a typed field.
 */
export function normalizeContentMeta(value: unknown): SocialContentMeta & Record<string, unknown> {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const out: SocialContentMeta & Record<string, unknown> = { ...raw };
  for (const key of ["title", "description", "concept"] as const) {
    if (typeof raw[key] !== "string") delete out[key];
    else out[key] = (raw[key] as string).slice(0, key === "description" ? 5000 : 300);
  }
  out.script = Array.isArray(raw.script)
    ? raw.script.filter((line): line is string => typeof line === "string").map((line) => line.slice(0, 300)).slice(0, 40)
    : [];
  out.hashtags = Array.isArray(raw.hashtags)
    ? raw.hashtags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.slice(0, 40)).slice(0, 30)
    : [];
  return out;
}

/** How a social content item came to exist. */
export type SocialContentSource = "studio" | "campaign" | "mara_chat" | "legacy";

/** The channel-neutral view of one social content item. */
export interface SocialContentRecord {
  id: string;
  ownerId: string;
  channel: SocialChannel;
  format: SocialFormat | null;
  source: SocialContentSource;
  campaignId: string | null;
  /** Internal working title (mara_drafts.title). */
  title: string;
  /** The caption/description body (mara_drafts.content). */
  caption: string;
  /** Structured deliverable metadata. */
  meta: SocialContentMeta;
  approvalState: "draft" | "approved" | "rejected";
  scheduledAt: string | null;
  /** The business's authoritative timezone for presentation. */
  timeZone: string;
  /** Canonical execution lifecycle state, derived — never faked. */
  publishState: SocialPublishState;
  /** Real provider publication reference, or null. Never invented. */
  providerRef: string | null;
  asset: { exists: boolean; mimeType: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** The minimal mara_drafts row shape this mapper consumes. */
export interface SocialDraftRow {
  id: string;
  owner_user_id: string;
  kind: string;
  channel?: string | null;
  title: string;
  content: string;
  proposed_publish_at?: string | null;
  status: string;
  social_channel?: string | null;
  social_format?: string | null;
  content_meta?: unknown;
  provider_ref?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Resolves the canonical channel+format of a draft row.
 *
 * Priority: the 0046 structured columns when present and valid; otherwise the
 * legacy kind mapping, which covers every existing production Instagram row.
 * Returns null for kinds that are not social content (email drafts, campaign
 * plans, weekly calendars, historical SMS).
 */
export function resolveDraftChannelFormat(
  row: Pick<SocialDraftRow, "kind" | "social_channel" | "social_format">,
): { channel: SocialMediaChannel; format: SocialFormat } | null {
  if (row.social_channel && row.social_format && isValidChannelFormat(row.social_channel, row.social_format)) {
    return {
      channel: row.social_channel as SocialMediaChannel,
      format: row.social_format as SocialFormat,
    };
  }
  return LEGACY_KIND_CHANNEL_FORMAT[row.kind] ?? null;
}

export interface SocialContentMappingInput {
  row: SocialDraftRow;
  /** Business timezone for presentation. */
  timeZone?: string;
  /** Campaign relationship, when the draft backs a campaign action. */
  campaignId?: string | null;
  source?: SocialContentSource;
  /** Existing Instagram publish queue status for the draft, if any. */
  instagramQueueStatus?:
    | "scheduled"
    | "waiting_for_media"
    | "permission_required"
    | "publishing"
    | "published"
    | "failed"
    | "cancelled"
    | null;
  /** Whether the draft's private asset bytes are stored. */
  hasAsset?: boolean;
  assetMimeType?: string | null;
}

/**
 * Maps one draft row onto the channel-neutral record.
 *
 * The publish state is DERIVED truthfully per channel:
 *   - Instagram: the existing queue state wins when a queue row exists
 *     (published there already means Meta-confirmed); otherwise the draft's
 *     approval state.
 *   - TikTok/YouTube: no provider integration exists, so an approved item is
 *     honestly `connection_required` — never `published`, never a scheduled
 *     state that pretends execution will happen.
 */
export function socialContentFromDraft(input: SocialContentMappingInput): SocialContentRecord | null {
  const { row } = input;
  const pair = resolveDraftChannelFormat(row);
  if (!pair) return null;

  const approvalState = row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "draft";
  let publishState: SocialPublishState;
  if (pair.channel === "instagram") {
    const fromQueue = publishStateFromInstagramQueue(input.instagramQueueStatus ?? null);
    publishState = fromQueue ?? (approvalState === "approved" && row.proposed_publish_at ? "scheduled" : publishStateFromDraftStatus(approvalState));
  } else {
    publishState = publishStateForUnconnectedProvider(approvalState);
  }

  return {
    id: row.id,
    ownerId: row.owner_user_id,
    channel: pair.channel,
    format: pair.format,
    source: input.source ?? "studio",
    campaignId: input.campaignId ?? null,
    title: row.title,
    caption: row.content,
    meta: normalizeContentMeta(row.content_meta),
    approvalState,
    scheduledAt: row.proposed_publish_at ?? null,
    timeZone: input.timeZone ?? "UTC",
    publishState,
    // A provider reference only exists when a provider really returned one.
    providerRef: typeof row.provider_ref === "string" && row.provider_ref.trim() ? row.provider_ref : null,
    asset: { exists: Boolean(input.hasAsset), mimeType: input.assetMimeType ?? null },
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

/**
 * Validates a compact action identifier as a social (non-email) pair — the
 * guard campaign and calendar layers use before writing a draft.
 */
export function socialPairFromActionChannel(value: unknown): { channel: SocialMediaChannel; format: SocialFormat } | null {
  const parsed = parseActionChannel(value);
  if (!parsed || parsed.channel === "email" || !parsed.format) return null;
  return { channel: parsed.channel as SocialMediaChannel, format: parsed.format };
}
