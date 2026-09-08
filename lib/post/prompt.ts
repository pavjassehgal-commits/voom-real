/**
 * MARA's Post Studio prompting.
 *
 * Truthfulness rules enforced here:
 *  - MARA writes copy from TEXT ONLY: the business profile, the active
 *    marketing plan, and (for existing content) the file's metadata.
 *  - No image or video bytes are ever sent to a provider. There is no vision
 *    call in Post Studio, so MARA never claims to have looked at a visual.
 *  - Generated visuals are described as generated from a text prompt.
 */
import { z } from "zod";

/** The copy MARA returns for "Create with MARA" on an Instagram Post. */
export const postDraftSchema = z.object({
  concept: z.string().min(1).max(160),
  caption: z.string().min(1).max(2200),
  cta: z.string().min(1).max(160),
  hashtags: z.array(z.string().min(1).max(30)).max(20).default([]),
  visualPrompt: z.string().min(1).max(1200),
}).strict();

export type MaraPostDraft = z.infer<typeof postDraftSchema>;

/** Copy-only suggestions used for existing (already-shot) content. */
export const postSuggestionSchema = z.object({
  caption: z.string().min(1).max(2200),
  cta: z.string().min(1).max(160),
  hashtags: z.array(z.string().min(1).max(30)).max(20).default([]),
  suggestedPublishAt: z.string().datetime({ offset: true }).nullable().default(null),
  timingReason: z.string().max(500).default(""),
}).strict();

export type MaraPostSuggestion = z.infer<typeof postSuggestionSchema>;

/**
 * The plan MARA returns for an Instagram Story visual. Deliberately caption-
 * free: Instagram does not support captions on Stories, so MARA only names the
 * concept and describes the 9:16 visual.
 */
export const storyVisualSchema = z.object({
  concept: z.string().min(1).max(160),
  visualPrompt: z.string().min(1).max(1200),
}).strict();

export type MaraStoryVisualPlan = z.infer<typeof storyVisualSchema>;

export const POST_COPY_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, creating ONE Instagram feed post for the authenticated user's own business.

Return JSON only, with exactly these keys:
{"concept":"string","caption":"string","cta":"string","hashtags":["string"],"visualPrompt":"string"}

Rules:
- concept: a short internal name for the post (max 12 words).
- caption: the complete Instagram caption. 30-150 words. Sound like this specific business. Never invent prices, discounts, offers, opening hours, store locations, links, awards, reviews, statistics, or claims that are not in the supplied context.
- cta: one short call to action, max 8 words.
- hashtags: 3-12 relevant hashtags WITHOUT the leading # character.
- visualPrompt: a precise text-to-image prompt for the post visual, 20-80 words. Describe a clean, brandable image that could honestly be produced for this business. Do not name real people, real customers, or the business's real premises unless the context describes them. Do not ask for readable text, logos, or watermarks inside the image.
- Never claim the post was published, scheduled, or sent. This is a draft for the user to review.
- Plain text only. No markdown, no emoji-heavy gimmicks unless the brand voice calls for it.`;

export const POST_SUGGESTION_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager. The user has imported a photo or video they already own.

Return JSON only, with exactly these keys:
{"caption":"string","cta":"string","hashtags":["string"],"suggestedPublishAt":"ISO-8601 or null","timingReason":"string"}

Critical honesty rule:
- You have NOT seen the photo or video. There is no vision model in this flow. You are given only the file name, file type, file size, the brand profile and the active marketing plan.
- Write copy that fits the brand and the marketing context, and keep it generic enough to be true for the imported file. Do NOT describe what is in the image or video. Do NOT claim you analysed, inspected, viewed, or understood the visual.
- Do not invent prices, discounts, offers, opening hours, locations, links, awards, reviews, or statistics that are not in the supplied context.
- suggestedPublishAt must be a real future ISO-8601 timestamp based on the current time and the business's stated content frequency, or null if you cannot justify one.
- timingReason: one short sentence explaining the suggested slot from the supplied context only.`;

export interface PostBrandContext {
  brandName: string;
  brandDescription: string;
  industry: string;
  targetCustomer: string;
  mainGoal: string;
  brandPersonality: string;
  contentFrequency: string;
}

export const STORY_VISUAL_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, creating ONE Instagram Story image for the authenticated user's own business.

Return JSON only, with exactly these keys:
{"concept":"string","visualPrompt":"string"}

Rules:
- concept: a short internal name for the Story (max 12 words).
- visualPrompt: a precise text-to-image prompt for a 9:16 full-screen vertical Story image, 20-80 words. Describe a clean, brandable image that could honestly be produced for this business. Keep the important content away from the extreme top and bottom edges. Do not name real people, real customers, or the business's real premises unless the context describes them. Do not ask for readable text, logos, or watermarks inside the image.
- Instagram Stories do not support captions, so no caption is written or requested.
- Never claim the Story was published, scheduled, or sent. This is a draft for the user to review.
- Plain text only. No markdown.`;

export interface PostPlanContext {
  businessGoal: string;
  weeklyStrategy: string;
  topics: string[];
  validUntil: string | null;
}

/** Text-only context handed to the provider. Never contains media bytes. */
export function buildPostContextPayload(input: {
  brand: PostBrandContext;
  plan: PostPlanContext | null;
  format: string;
  kind: "instagram_post" | "reel" | "story";
  brief?: string;
}) {
  return {
    business: {
      name: input.brand.brandName.slice(0, 160),
      description: input.brand.brandDescription.slice(0, 800),
      industry: input.brand.industry.slice(0, 200),
      targetCustomer: input.brand.targetCustomer.slice(0, 300),
      mainGoal: input.brand.mainGoal.slice(0, 300),
      brandPersonality: input.brand.brandPersonality.slice(0, 400),
      contentFrequency: input.brand.contentFrequency.slice(0, 200),
    },
    marketingPlan: input.plan
      ? {
          businessGoal: input.plan.businessGoal.slice(0, 500),
          weeklyStrategy: input.plan.weeklyStrategy.slice(0, 1500),
          recentTopics: input.plan.topics.slice(0, 12),
          validUntil: input.plan.validUntil,
        }
      : null,
    requestedFormat: input.format,
    contentType: input.kind === "reel" ? "reel" : input.kind === "story" ? "instagram_story" : "instagram_feed_post",
    userBrief: (input.brief ?? "").slice(0, 800),
  };
}

/**
 * Metadata-only description of an imported file. This is the ONLY information
 * about the visual that reaches the provider — never its bytes.
 */
export function buildExistingContentPayload(input: {
  displayName: string;
  mimeType: string;
  byteSize: number;
  assetKind: "image" | "video";
  brand: PostBrandContext;
  plan: PostPlanContext | null;
  nowIso: string;
}) {
  return {
    importedFile: {
      name: input.displayName.slice(0, 180),
      type: input.assetKind === "video" ? "video" : "image",
      mimeType: input.mimeType,
      sizeBytes: input.byteSize,
    },
    maraHasSeenTheFile: false,
    note: "MARA cannot see this file. Use only the metadata above plus the business and plan context. Do not describe the visual.",
    currentTime: input.nowIso,
    business: {
      name: input.brand.brandName.slice(0, 160),
      description: input.brand.brandDescription.slice(0, 800),
      industry: input.brand.industry.slice(0, 200),
      targetCustomer: input.brand.targetCustomer.slice(0, 300),
      mainGoal: input.brand.mainGoal.slice(0, 300),
      contentFrequency: input.brand.contentFrequency.slice(0, 200),
    },
    marketingPlan: input.plan
      ? { businessGoal: input.plan.businessGoal.slice(0, 500), weeklyStrategy: input.plan.weeklyStrategy.slice(0, 1500), recentTopics: input.plan.topics.slice(0, 12) }
      : null,
  };
}

/**
 * The disclosure shown next to any suggestion for existing content, so the UI
 * never implies MARA looked at the media itself.
 */
export const EXISTING_CONTENT_DISCLOSURE =
  "MARA has not seen this file. These suggestions are based on the file name, file type and your brand and plan context only.";
