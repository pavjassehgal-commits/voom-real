/** Planning extends the media vocabulary with LinkedIn text, never media support. */
import {
  SOCIAL_CHANNEL_LABELS, SOCIAL_FORMAT_LABELS, SOCIAL_FORMATS, SOCIAL_MEDIA_CHANNELS,
  isValidChannelFormat, parseActionChannel, type SocialFormat, type SocialMediaChannel,
} from "../../social/channels.ts";

export const PLAN_CHANNELS = [...SOCIAL_MEDIA_CHANNELS, "linkedin"] as const;
export type PlanChannel = SocialMediaChannel | "linkedin";
export type PlanFormat = SocialFormat | "text";
export const PLAN_CHANNEL_LABELS = { ...SOCIAL_CHANNEL_LABELS, linkedin: "LinkedIn" };
export const PLAN_FORMATS = { ...SOCIAL_FORMATS, linkedin: ["text"] } as const;
export const PLAN_FORMAT_LABELS: Record<PlanChannel | "email", Partial<Record<PlanFormat, string>>> = {
  ...SOCIAL_FORMAT_LABELS, linkedin: { text: "LinkedIn Text Post" },
};

export function isPlanChannelFormat(channel: unknown, format: unknown): boolean {
  return channel === "linkedin" ? format === "text" : isValidChannelFormat(channel, format);
}
export function planActionChannelFor(channel: PlanChannel, format: PlanFormat): string {
  return `${channel}_${format}`;
}
export function parsePlanActionChannel(value: unknown) {
  if (typeof value === "string" && value.trim().toLowerCase() === "linkedin_text") {
    return { channel: "linkedin" as const, format: "text" as const, actionChannel: "linkedin_text" };
  }
  return parseActionChannel(value);
}
export function planActionChannelLabel(value: unknown): string {
  const pair = parsePlanActionChannel(value);
  if (!pair) return "Content";
  if (pair.channel === "email") return "Email";
  const labels = PLAN_FORMAT_LABELS[pair.channel] as Partial<Record<PlanFormat, string>>;
  return labels[pair.format as PlanFormat] ?? PLAN_CHANNEL_LABELS[pair.channel];
}

/** Natural business prose, without the Instagram editor's "CTA:" field prefix. */
export function composeLinkedInPlanText(content: { caption: string; cta: string; hashtags: string[] }): string {
  const tags = content.hashtags.map((tag) => `#${tag.replace(/^#+/, "").trim()}`).join(" ");
  return [content.caption.trim(), content.cta.trim(), tags].filter(Boolean).join("\n\n");
}
