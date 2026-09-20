/**
 * Voom Multi-Social Core — platform intelligence vocabulary.
 *
 * The ONE description of what each platform format MEANS and how MARA must
 * differentiate content per platform. Both the deterministic planner
 * (lib/campaign/planner.ts) and the MARA intelligence layer
 * (lib/campaign/strategy.ts) take their platform wording from here, so the
 * skeleton and the intelligence can never describe a format differently.
 *
 * The core product rule this encodes: a multichannel campaign is ONE
 * coordinated story told natively on each platform — a teaser Reel, a
 * TikTok-native variation, an email launch, a YouTube Short, a deeper YouTube
 * video — never the same caption pasted everywhere.
 *
 * Pure and dependency-free.
 */

import { SOCIAL_FORMAT_LABELS, type SocialChannel, type SocialFormat } from "./channels";

export interface PlatformFormatGuidance {
  channel: SocialChannel;
  format: SocialFormat | null;
  label: string;
  /** What the format IS, in one factual sentence. */
  definition: string;
  /** How MARA must write for it — native behaviour, not a repost. */
  writingRule: string;
  /** Where the format sits in a coordinated multichannel sequence. */
  sequenceRole: string;
}

/** The authoritative per-format planning guidance. */
export const PLATFORM_FORMAT_GUIDANCE: Record<string, PlatformFormatGuidance> = {
  instagram_post: {
    channel: "instagram",
    format: "post",
    label: SOCIAL_FORMAT_LABELS.instagram.post ?? "Instagram Post",
    definition: "A visual feed post (1:1 or 4:5) with a caption, CTA and hashtags.",
    writingRule: "Write a scannable caption with a clear first line, benefit-led middle and one CTA. Hashtags are allowed and useful here.",
    sequenceRole: "Carries the announcement and the proof moments; the durable feed presence of the campaign.",
  },
  instagram_reel: {
    channel: "instagram",
    format: "reel",
    label: SOCIAL_FORMAT_LABELS.instagram.reel ?? "Instagram Reel",
    definition: "A short vertical 9:16 video with a hook in the first seconds.",
    writingRule: "Write a scroll-stopping hook, 3-6 short shot-by-shot script lines and a compact caption. Keep it Instagram-native: trending-audio pacing, on-screen text.",
    sequenceRole: "The teaser: earns attention early and points to the deeper content on other platforms.",
  },
  instagram_story: {
    channel: "instagram",
    format: "story",
    label: SOCIAL_FORMAT_LABELS.instagram.story ?? "Instagram Story",
    definition: "A full-screen 9:16 image or video moment with overlay text and a sticker.",
    writingRule: "One line of overlay text, one sticker idea, no caption essay. Stories carry no hashtags-heavy copy.",
    sequenceRole: "Keeps the campaign present between feed moments; the closing reminder lives here.",
  },
  tiktok_video: {
    channel: "tiktok",
    format: "video",
    label: SOCIAL_FORMAT_LABELS.tiktok.video ?? "TikTok Video",
    definition: "A short-form vertical video written for TikTok's native style.",
    writingRule: "Write TikTok-native, NOT a reposted Reel: a blunt in-your-face hook, fast cuts, conversational on-screen text, a sound-forward beat, and a caption of one short line plus 3-5 tags. Never reuse the Instagram caption verbatim.",
    sequenceRole: "The variation: retells the campaign's core moment for a discovery-feed audience, right after the Instagram teaser.",
  },
  youtube_short: {
    channel: "youtube",
    format: "short",
    label: SOCIAL_FORMAT_LABELS.youtube.short ?? "YouTube Short",
    definition: "A short vertical video on YouTube with a title and optional description.",
    writingRule: "Write a search-friendly title (front-load the topic), a 1-2 line description, and a hook that promises the payoff. YouTube Shorts viewers arrive from search and the Shorts shelf — be explicit about the topic, less slang-dependent than TikTok.",
    sequenceRole: "Extends reach into YouTube's discovery surfaces and teases the full video.",
  },
  youtube_video: {
    channel: "youtube",
    format: "video",
    label: SOCIAL_FORMAT_LABELS.youtube.video ?? "YouTube Video",
    definition: "A longer-form YouTube video with a title, a full description, a concept and a script or outline.",
    writingRule: "Write a specific title, a 2-4 sentence description with the payoff and chapters, a clear concept, and a real outline or script (hook, 3-5 sections, closing CTA). This is the campaign's depth piece: it may explain what the short-form pieces only teased. Planning it never triggers expensive video generation.",
    sequenceRole: "The depth: the definitive explanation the rest of the sequence points back to.",
  },
  email: {
    channel: "email",
    format: null,
    label: "Email",
    definition: "A branded campaign email with subject, preview text, body and CTA.",
    writingRule: "Write a specific subject, a preview text that extends it, and an 80-250 word body with one clear CTA. Never restate a caption; email carries the detail and the direct next step.",
    sequenceRole: "The launch and follow-up: converts the attention the social moments earned.",
  },
};

/** Guidance lookup by compact action channel (`instagram_reel`, `email`, …). */
export function platformGuidanceFor(actionChannel: string): PlatformFormatGuidance | null {
  return PLATFORM_FORMAT_GUIDANCE[actionChannel] ?? null;
}

/**
 * The coordinated-sequence rule MARA receives for a multichannel campaign.
 * Built from the campaign's actual channel selection, so a campaign never
 * receives advice about a platform it does not run on.
 */
export function coordinatedSequenceRule(channels: readonly SocialChannel[]): string {
  if (channels.length <= 1) {
    return "This campaign runs on ONE channel. Write every action natively for that channel and never mention or promise another platform.";
  }
  const roles = channels
    .map((channel) => {
      const formats = Object.values(PLATFORM_FORMAT_GUIDANCE).filter((g) => g.channel === channel);
      return formats.map((g) => `${g.label}: ${g.sequenceRole}`).join(" ");
    })
    .join(" ");
  return [
    "This campaign is ONE coordinated story told natively on each selected platform — never the same caption or script pasted across platforms.",
    "Typical arc: a teaser short-form video, a platform-native variation, the email launch, a short-form YouTube moment, the deeper YouTube video, then a reminder.",
    "Each platform's action must differ in hook, wording and angle while carrying the same core message.",
    roles,
  ].join(" ");
}

/** Compact per-format definitions for prompts (bounded, factual). */
export function platformDefinitionsFor(actionChannels: readonly string[]): Array<{ channel: string; definition: string; writingRule: string }> {
  return actionChannels
    .map((channel) => PLATFORM_FORMAT_GUIDANCE[channel])
    .filter((g): g is PlatformFormatGuidance => Boolean(g))
    .map((g) => ({ channel: `${g.channel}${g.format ? `_${g.format}` : ""}`, definition: g.definition, writingRule: g.writingRule }));
}
