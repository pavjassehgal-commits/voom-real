/**
 * Voom Multi-Social Core — the ONE canonical marketing-channel vocabulary.
 *
 * This module is the single authority for:
 *   - which channels Voom markets on (Instagram, TikTok, YouTube, Email),
 *   - which content formats exist on each channel,
 *   - which channel+format combinations are valid,
 *   - the compact `channel_format` action identifiers campaign actions use.
 *
 * Rules that live nowhere else:
 *   - SMS marketing is retired. It appears in NO allowlist here, so it can
 *     never be selected, planned, validated or executed through this layer.
 *     Historical SMS rows stay readable through the legacy surfaces only.
 *   - Email is a channel but has no social format: its deliverable is the
 *     existing campaign email system (subject/body/CTA), not a media format.
 *   - TikTok and YouTube are real publishing channels (lib/tiktok,
 *     lib/youtube): approval still never means publication on either —
 *     items ride the durable provider publish queues, and only the provider's
 *     own confirmation establishes Published. Publishing truthfulness lives
 *     in `lib/social/publisher.ts`, which refuses disconnected providers.
 *     Nothing in this file invents a provider API, scope, token or status.
 *
 * Pure and dependency-free: the Node test suite executes this module for real.
 */

/** The canonical channels Voom markets on, in product display order. */
export const SOCIAL_CHANNELS = ["instagram", "tiktok", "youtube", "email"] as const;

export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

export const SOCIAL_CHANNEL_LABELS: Record<SocialChannel, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  email: "Email",
};

/**
 * Marketing channels that are NOT part of the product. Kept as documentation
 * and for defensive normalization only — retired channels are rejected by
 * absence from `SOCIAL_CHANNELS`, never by a denylist check.
 */
export const RETIRED_CHANNELS = ["sms"] as const;

/**
 * The canonical social formats, per channel.
 *
 * Instagram keeps every format the existing production architecture supports
 * (Post, Reel, Story) so existing drafts, calendar items, publish queue rows
 * and campaigns stay valid. TikTok has exactly one format. YouTube separates
 * the Short (short vertical) from the full Video (longer-form, titled,
 * described, scripted) — a full YouTube video is a first-class format, never
 * "a Reel with a different name".
 */
export const SOCIAL_FORMATS = {
  instagram: ["post", "reel", "story"],
  tiktok: ["video"],
  youtube: ["short", "video"],
} as const;

/** The social channels: the channels that carry a media format. */
export const SOCIAL_MEDIA_CHANNELS = ["instagram", "tiktok", "youtube"] as const;

export type SocialMediaChannel = (typeof SOCIAL_MEDIA_CHANNELS)[number];

/** Union of every canonical social format value. */
export type SocialFormat =
  | (typeof SOCIAL_FORMATS)["instagram"][number]
  | (typeof SOCIAL_FORMATS)["tiktok"][number]
  | (typeof SOCIAL_FORMATS)["youtube"][number];

export const SOCIAL_FORMAT_LABELS: Record<SocialChannel, Partial<Record<SocialFormat, string>>> = {
  instagram: { post: "Instagram Post", reel: "Instagram Reel", story: "Instagram Story" },
  tiktok: { video: "TikTok Video" },
  youtube: { short: "YouTube Short", video: "YouTube Video" },
  email: {},
};

/** The authoritative channel+format validation matrix, derived once. */
export const CHANNEL_FORMAT_MATRIX: ReadonlyArray<{ channel: SocialMediaChannel; format: string }> = [
  ...SOCIAL_FORMATS.instagram.map((format) => ({ channel: "instagram" as const, format })),
  ...SOCIAL_FORMATS.tiktok.map((format) => ({ channel: "tiktok" as const, format })),
  ...SOCIAL_FORMATS.youtube.map((format) => ({ channel: "youtube" as const, format })),
];

export function isSocialChannel(value: unknown): value is SocialChannel {
  return typeof value === "string" && (SOCIAL_CHANNELS as readonly string[]).includes(value);
}

export function isSocialMediaChannel(value: unknown): value is SocialMediaChannel {
  return typeof value === "string" && (SOCIAL_MEDIA_CHANNELS as readonly string[]).includes(value);
}

/** Formats a channel supports. Email legitimately has none. */
export function formatsForChannel(channel: SocialChannel): readonly string[] {
  if (!isSocialMediaChannel(channel)) return [];
  return SOCIAL_FORMATS[channel];
}

/**
 * The one server-side channel+format validation. Invalid combinations
 * (tiktok+email, youtube+reel, instagram+short, …) return false here and are
 * refused by the routes and the database rather than silently coerced.
 */
export function isValidChannelFormat(channel: unknown, format: unknown): boolean {
  if (typeof channel !== "string" || typeof format !== "string") return false;
  if (!isSocialMediaChannel(channel)) return false;
  return (SOCIAL_FORMATS[channel] as readonly string[]).includes(format);
}

export type ChannelFormatResult =
  | { ok: true; channel: SocialMediaChannel; format: SocialFormat }
  | { ok: false; reason: "unknown_channel" | "retired_channel" | "unknown_format" | "invalid_combination" };

/**
 * Normalizes and validates one channel+format pair.
 *
 * Values are trimmed and lowercased; a retired channel is named explicitly so
 * callers can say "SMS is retired" instead of "unknown".
 */
export function normalizeChannelFormat(channel: unknown, format: unknown): ChannelFormatResult {
  if (typeof channel !== "string") return { ok: false, reason: "unknown_channel" };
  const normalizedChannel = channel.trim().toLowerCase();
  if ((RETIRED_CHANNELS as readonly string[]).includes(normalizedChannel)) {
    return { ok: false, reason: "retired_channel" };
  }
  if (!isSocialMediaChannel(normalizedChannel)) return { ok: false, reason: "unknown_channel" };
  if (typeof format !== "string") return { ok: false, reason: "unknown_format" };
  const normalizedFormat = format.trim().toLowerCase();
  const formats = SOCIAL_FORMATS[normalizedChannel] as readonly string[];
  if (!formats.includes(normalizedFormat)) {
    const knownAnywhere = CHANNEL_FORMAT_MATRIX.some((entry) => entry.format === normalizedFormat);
    return { ok: false, reason: knownAnywhere ? "invalid_combination" : "unknown_format" };
  }
  return { ok: true, channel: normalizedChannel, format: normalizedFormat as SocialFormat };
}

// ─── Compact action identifiers ────────────────────────────────────────────
//
// Campaign actions and calendar commitments use one compact identifier per
// channel+format pair (`instagram_reel`, `tiktok_video`, `youtube_short`, …).
// These functions are the ONLY place that identifier is parsed or built, so
// the campaign layer, the coordinator and the UI can never disagree about the
// mapping. Email keeps its bare `email` identifier: it has no format.

export const EMAIL_ACTION_CHANNEL = "email";

/** Every compact action channel identifier, in canonical order. */
export const ACTION_CHANNELS: readonly string[] = [
  EMAIL_ACTION_CHANNEL,
  ...CHANNEL_FORMAT_MATRIX.map((entry) => `${entry.channel}_${entry.format}`),
];

/** Builds the compact action identifier for one validated pair. */
export function actionChannelFor(channel: SocialMediaChannel, format: string): string {
  return `${channel}_${format}`;
}

export interface ParsedActionChannel {
  /** The canonical channel. */
  channel: SocialChannel;
  /** The canonical format, or null for email. */
  format: SocialFormat | null;
  /** The compact identifier, normalized. */
  actionChannel: string;
}

/**
 * Parses a compact action identifier back into channel+format.
 *
 * Accepts the legacy Instagram identifiers the existing production data uses
 * (`instagram_post`, `instagram_reel`, `instagram_story`) unchanged. Returns
 * null for anything else — including retired channels — so an invented action
 * channel is rejected by every caller.
 */
export function parseActionChannel(value: unknown): ParsedActionChannel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === EMAIL_ACTION_CHANNEL) {
    return { channel: "email", format: null, actionChannel: normalized };
  }
  const separator = normalized.lastIndexOf("_");
  if (separator <= 0) return null;
  const channel = normalized.slice(0, separator);
  const format = normalized.slice(separator + 1);
  if (!isValidChannelFormat(channel, format)) return null;
  return {
    channel: channel as SocialMediaChannel,
    format: format as SocialFormat,
    actionChannel: `${channel}_${format}`,
  };
}

/** True when a compact identifier is a known action channel. */
export function isActionChannel(value: unknown): boolean {
  return parseActionChannel(value) !== null;
}

/** The short display label for one compact action channel. */
export function actionChannelLabel(value: unknown): string {
  const parsed = parseActionChannel(value);
  if (!parsed) return "Content";
  if (parsed.channel === "email") return "Email";
  const label = SOCIAL_FORMAT_LABELS[parsed.channel]?.[parsed.format as SocialFormat];
  return label ?? SOCIAL_CHANNEL_LABELS[parsed.channel];
}

/**
 * A truthful, product-level availability statement per channel.
 *
 * Instagram, TikTok, YouTube and Email have real provider integrations.
 * Publishability is still gated at runtime by the real connection: this flag
 * says the integration exists, never that a publication happened.
 */
export const CHANNEL_PUBLISHING_AVAILABILITY: Record<
  SocialChannel,
  { publishable: boolean; reason: string }
> = {
  instagram: {
    publishable: true,
    reason: "Real Instagram publishing through the connected professional account.",
  },
  tiktok: {
    publishable: true,
    reason: "Real TikTok publishing through the connected account: approved, scheduled items go on the durable TikTok publish queue, and Published appears only after TikTok's own post-status endpoint confirms PUBLISH_COMPLETE.",
  },
  youtube: {
    publishable: true,
    reason: "Real YouTube publishing through the connected channel: approved, scheduled items go on the durable YouTube publish queue, and Published appears only after YouTube itself confirms the video is processed.",
  },
  email: {
    publishable: true,
    reason: "Campaign email sends through the existing Branded Email Engine on explicit send.",
  },
};

/** Whether Voom can truthfully publish on a channel right now. */
export function isChannelPublishable(channel: SocialChannel): boolean {
  return CHANNEL_PUBLISHING_AVAILABILITY[channel].publishable;
}
