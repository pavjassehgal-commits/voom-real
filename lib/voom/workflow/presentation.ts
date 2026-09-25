/**
 * The ONE presentation vocabulary for the Voom workspace surfaces
 * (Marketing Plan, Content Calendar, Create/Studio, Performance, Approvals).
 *
 * Pure and dependency-free: no React, no `server-only`, no I/O — so a server
 * component, a client component and the Node test suite can all read the same
 * mapping. It DERIVES NOTHING NEW about the product: every value here is a
 * display decision over facts that already exist elsewhere
 * (`lib/voom/workflow/state.ts`, `lib/social/channels.ts`,
 * `lib/social/server-drafts.ts`). No status, date, count or coverage rule is
 * recomputed here.
 *
 * Two rules keep the surfaces honest:
 *   - semantic colour (green/amber/red/blue) is reserved for real state;
 *     channel identity is an IRIDESCENT band of the Voom spectrum, never a
 *     provider logo palette;
 *   - "provider-confirmed" is only ever claimed when the authoritative read
 *     model says the provider itself confirmed the item.
 */

import {
  SOCIAL_CHANNEL_LABELS,
  SOCIAL_FORMAT_LABELS,
  type SocialFormat,
  type SocialMediaChannel,
} from "@/lib/social/channels";

/** The four semantic tones a workflow state may take. */
export type WorkspaceTone = "green" | "amber" | "red" | "blue" | "grey";

/**
 * The one status -> tone mapping. Mirrors the shared workflow vocabulary:
 * greens only for provider-confirmed success, ambients for work that needs a
 * human, reds for stopped work, blue for in-flight/scheduled, grey for planned.
 * (This is the same mapping the plan cards and the calendar have always used,
 * now defined once instead of per screen.)
 */
export function workflowTone(status: string): WorkspaceTone {
  if (status === "published") return "green";
  if (status === "failed" || status === "media_timed_out") return "red";
  if (status === "missed" || status === "media_delayed") return "amber";
  if (status === "needs_approval" || status === "ready_for_review" || status === "waiting_for_media") return "amber";
  if (status === "generating" || status === "publishing" || status === "scheduled") return "blue";
  return "grey";
}

/**
 * Tone for the durable provider queues (TikTok / YouTube). Kept here so a
 * queue state never has to be pattern-matched from a display label: these are
 * the exact `queueStatus` values the queue readers emit.
 */
export function socialQueueTone(queueStatus: string | null | undefined): WorkspaceTone {
  switch (queueStatus) {
    case "published": return "green";
    case "failed":
    case "permission_required": return "red";
    case "waiting_for_media":
    case "needs_declaration": return "amber";
    case "scheduled":
    case "uploading":
    case "posting":
    case "provider_processing": return "blue";
    default: return "grey";
  }
}

/** The single accent colour used for rails, dots and chart bars. */
export function workflowAccent(status: string): string {
  const tone = workflowTone(status);
  if (tone === "green") return "var(--green)";
  if (tone === "amber") return "var(--amber)";
  if (tone === "red") return "var(--red)";
  if (tone === "blue") return "var(--blue)";
  return "var(--line-strong)";
}

export type ToneClasses = { text: string; soft: string; dot: string; ring: string };

/** Static Tailwind class strings per tone (literal so the scanner emits them). */
export const TONE_CLASSES: Record<WorkspaceTone, ToneClasses> = {
  green: { text: "text-[var(--green)]", soft: "bg-[var(--green-soft)]", dot: "bg-[var(--green)]", ring: "ring-[var(--green)]/20" },
  amber: { text: "text-[var(--amber)]", soft: "bg-[var(--amber-soft)]", dot: "bg-[var(--amber)]", ring: "ring-[var(--amber)]/20" },
  red: { text: "text-[var(--red)]", soft: "bg-[var(--red-soft)]", dot: "bg-[var(--red)]", ring: "ring-[var(--red)]/20" },
  blue: { text: "text-[var(--blue)]", soft: "bg-[var(--blue-soft)]", dot: "bg-[var(--blue)]", ring: "ring-[var(--blue)]/20" },
  grey: { text: "text-text-3", soft: "bg-surface-2", dot: "bg-text-3", ring: "ring-line" },
};

/**
 * Channel identity — a refracted band of the Voom spectrum per platform.
 * Distinct enough to scan a week at a glance, restrained enough that a
 * seven-day plan never becomes provider branding.
 */
export type ChannelKey = "instagram" | "tiktok" | "youtube" | "email";

export interface ChannelIdentity {
  key: ChannelKey;
  label: string;
  /** Very short form for dense rows (a 3-letter tag, not a logo). */
  short: string;
  /** CSS custom properties; resolved by globals.css in both themes. */
  accent: string;
  soft: string;
}

const CHANNEL_IDENTITIES: Record<ChannelKey, ChannelIdentity> = {
  instagram: { key: "instagram", label: "Instagram", short: "IG", accent: "var(--ch-instagram)", soft: "var(--ch-instagram-soft)" },
  tiktok: { key: "tiktok", label: "TikTok", short: "TT", accent: "var(--ch-tiktok)", soft: "var(--ch-tiktok-soft)" },
  youtube: { key: "youtube", label: "YouTube", short: "YT", accent: "var(--ch-youtube)", soft: "var(--ch-youtube-soft)" },
  email: { key: "email", label: "Email", short: "EM", accent: "var(--ch-email)", soft: "var(--ch-email-soft)" },
};

/**
 * Flat hex accents for the places a CSS variable cannot be composed (a tinted
 * calendar cell needs `#rrggbb` + an alpha suffix). Same semantic meaning as
 * the variables above: state first, channel identity second.
 */
export const TONE_ACCENT_HEX: Record<WorkspaceTone, string> = {
  green: "#1c8a52",
  amber: "#f2a516",
  red: "#c0392b",
  blue: "#2f6f9f",
  grey: "#7c4dff",
};

export const CHANNEL_ACCENT_HEX: Record<ChannelKey, string> = {
  instagram: "#7c4dff",
  tiktok: "#0b8fa8",
  youtube: "#cf4629",
  email: "#2f62d6",
};

/** Resolves any channel value (unknown values degrade to the neutral band). */
export function channelIdentity(channel: string | null | undefined): ChannelIdentity {
  if (channel === "instagram" || channel === "tiktok" || channel === "youtube" || channel === "email") {
    return CHANNEL_IDENTITIES[channel];
  }
  return { key: "instagram", label: "Social", short: "SO", accent: "var(--line-strong)", soft: "var(--surface-2)" };
}

/** Static Tailwind classes per channel (literal strings for the scanner). */
export const CHANNEL_CLASSES: Record<ChannelKey, ToneClasses> = {
  instagram: {
    text: "text-[var(--ch-instagram)]",
    soft: "bg-[var(--ch-instagram-soft)]",
    dot: "bg-[var(--ch-instagram)]",
    ring: "ring-[var(--ch-instagram)]/25",
  },
  tiktok: {
    text: "text-[var(--ch-tiktok)]",
    soft: "bg-[var(--ch-tiktok-soft)]",
    dot: "bg-[var(--ch-tiktok)]",
    ring: "ring-[var(--ch-tiktok)]/25",
  },
  youtube: {
    text: "text-[var(--ch-youtube)]",
    soft: "bg-[var(--ch-youtube-soft)]",
    dot: "bg-[var(--ch-youtube)]",
    ring: "ring-[var(--ch-youtube)]/25",
  },
  email: {
    text: "text-[var(--ch-email)]",
    soft: "bg-[var(--ch-email-soft)]",
    dot: "bg-[var(--ch-email)]",
    ring: "ring-[var(--ch-email)]/25",
  },
};

export function channelClasses(channel: string | null | undefined): ToneClasses {
  return CHANNEL_CLASSES[channelIdentity(channel).key];
}

/** The canonical native format label for one channel+format pair. */
export function channelFormatLabel(channel: string, format: string): string {
  const labels = SOCIAL_FORMAT_LABELS[channel as SocialMediaChannel] as Partial<Record<SocialFormat, string>> | undefined;
  return labels?.[format as SocialFormat] ?? SOCIAL_CHANNEL_LABELS[channel as SocialMediaChannel] ?? "Content";
}

/** Compact slot key for cross-page continuity: the same work, the same name. */
export function channelSlotKey(channel: string, format: string): string {
  return `${channel}:${format}`;
}

/**
 * Provider confirmation — the ONE place a surface may claim that a provider
 * itself confirmed an item. Returns null unless the authoritative read says so:
 *   - Instagram: Meta returned a real media id for the publish queue row,
 *   - TikTok / YouTube: the durable queue row itself is `published`
 *     (TikTok's own PUBLISH_COMPLETE / YouTube's own `processed`).
 * A scheduled or approved item never reaches this function with a value.
 */
export function providerConfirmationLabel(
  channel: string,
  facts: { instagramMediaId?: string | null; queueStatus?: string | null },
): string | null {
  if (channel === "instagram") return facts.instagramMediaId ? "Meta-confirmed" : null;
  if (channel === "tiktok" || channel === "youtube") {
    return facts.queueStatus === "published" ? "Provider-confirmed" : null;
  }
  return null;
}

/**
 * The one grouping used by the strategy rail and the calendar legend: which
 * bucket a state belongs to, without inventing a second status vocabulary.
 */
export type StateGroup = "attention" | "live" | "review" | "ready" | "open";

export function stateGroup(status: string): StateGroup {
  if (status === "failed" || status === "media_timed_out" || status === "missed" || status === "media_delayed") return "attention";
  if (status === "publishing" || status === "published" || status === "scheduled") return "live";
  if (status === "needs_approval" || status === "waiting_for_media") return "review";
  if (status === "ready_for_review" || status === "generating") return "ready";
  return "open";
}

export const STATE_GROUP_LABELS: Record<StateGroup, string> = {
  attention: "Needs attention",
  live: "Scheduled & published",
  review: "Waiting on you",
  ready: "In production",
  open: "Not started",
};

/** Formats a channel+format pair the way every surface names one piece of work. */
export function workLabel(channel: string, format: string): string {
  return `${channelIdentity(channel).label} · ${channelFormatLabel(channel, format)}`;
}
