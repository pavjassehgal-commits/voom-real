/**
 * MARA's Post Studio prompting.
 *
 * Truthfulness rules enforced here:
 *  - MARA writes copy from TEXT ONLY: the business profile, the active
 *    marketing plan, and (for existing content) the file's metadata, plus,
 *    since slice 5b, the one-paragraph reading the vision model made of an
 *    uploaded photo (lib/post/vision.ts). That reading is the only thing the
 *    text model knows about the picture, and the prompt says so.
 *  - No image or video bytes ever reach the TEXT model. The vision call sends
 *    a small JPEG copy of a photo once; videos are never looked at, and the
 *    unseen prompt still says MARA has not seen the file.
 *  - Generated visuals are described as generated from a text prompt.
 */
import { z } from "zod";
// Type-only on purpose: this module stays dependency-free at runtime so the
// Node test suite can import it directly.
import type { BrandKitPromptContext } from "@/lib/brand/context";

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

/* ---------------------------------------------------------------------------
 * Provider-side structured output contracts (Groq `json_schema`).
 *
 * These are Groq-compatible strict JSON Schemas mirroring the zod schemas
 * above EXACTLY (min(1) -> minLength 1, max(n) -> maxLength n, .max(20) ->
 * maxItems 20, .strict() -> additionalProperties false). Strict mode requires
 * every property in `required`; the only optional value, `suggestedPublishAt`,
 * is a ["string","null"] union rather than an omitted key — so the provider
 * must always return the complete, typed object.
 *
 * The zod schemas remain the second safety layer: whatever the provider
 * returns is still parsed and validated server-side before it is persisted or
 * handed to media generation, so a schema disagreement can never turn into a
 * stored draft or an image request.
 * ------------------------------------------------------------------------- */

/** Groq strict structured output for `postDraftSchema` (Create-with-MARA copy). */
export const postDraftJsonSchema = {
  name: "mara_post_draft",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["concept", "caption", "cta", "hashtags", "visualPrompt"],
    properties: {
      concept: { type: "string", minLength: 1, maxLength: 160, description: "Short internal name for the post (max 12 words)." },
      caption: { type: "string", minLength: 1, maxLength: 2200, description: "The complete Instagram caption (30-150 words), truthful to the supplied context." },
      cta: { type: "string", minLength: 1, maxLength: 160, description: "One short call to action, max 8 words." },
      hashtags: {
        type: "array",
        maxItems: 20,
        description: "3-12 relevant hashtags WITHOUT the leading # character.",
        items: { type: "string", minLength: 1, maxLength: 30 },
      },
      visualPrompt: { type: "string", minLength: 1, maxLength: 1200, description: "Precise text-to-image prompt for the post visual (20-80 words), no readable text, logos or watermarks." },
    },
  },
} as const;

/** Groq strict structured output for `storyVisualSchema` (Story visual plan). */
export const storyVisualJsonSchema = {
  name: "mara_story_visual",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["concept", "visualPrompt"],
    properties: {
      concept: { type: "string", minLength: 1, maxLength: 160, description: "Short internal name for the Story (max 12 words)." },
      visualPrompt: { type: "string", minLength: 1, maxLength: 1200, description: "Precise text-to-image prompt for a 9:16 full-screen Story image (20-80 words), no readable text, logos or watermarks." },
    },
  },
} as const;

/** Groq strict structured output for `postSuggestionSchema` (copy-only suggestions). */
export const postSuggestionJsonSchema = {
  name: "mara_post_suggestion",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["caption", "cta", "hashtags", "suggestedPublishAt", "timingReason"],
    properties: {
      caption: { type: "string", minLength: 1, maxLength: 2200, description: "Suggested caption. Generic enough to be true for the imported file — MARA has not seen it." },
      cta: { type: "string", minLength: 1, maxLength: 160, description: "One short call to action, max 8 words." },
      hashtags: {
        type: "array",
        maxItems: 20,
        description: "Relevant hashtags WITHOUT the leading # character.",
        items: { type: "string", minLength: 1, maxLength: 30 },
      },
      suggestedPublishAt: { type: ["string", "null"], description: "A real future ISO-8601 timestamp with explicit offset, or null when no slot can be justified." },
      timingReason: { type: "string", maxLength: 500, description: "One short sentence justifying the suggested slot from the supplied context only." },
    },
  },
} as const;

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

What a caption is for:
- postPurpose is the owner's own line on why they are posting this. The caption's job is that purpose, in the brand's voice. When postPurpose is null, choose the purpose from the business's main goal and the marketing plan (for example "more online sales" means an invitation to order, "more walk-ins" means a reason to visit) and write for it.
- A caption is never a description of the file. Lead with why the reader should care, then the specifics.

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
  /** Brand Kit prompt block (migration 0075), already built by the loader. Absent/null = no `brandKit` key in the payload. */
  brandKit?: BrandKitPromptContext | null;
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
  const payload = {
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
  // The key exists only when the account has a Brand Kit with content, so
  // payloads for every other account are unchanged.
  return input.brand.brandKit ? { ...payload, brandKit: input.brand.brandKit } : payload;
}

/**
 * Description of an imported file for the TEXT model: its metadata, plus,
 * when the vision model looked at a photo (slice 5b), the one paragraph it
 * wrote. Never the bytes.
 */
export function buildExistingContentPayload(input: {
  displayName: string;
  mimeType: string;
  byteSize: number;
  assetKind: "image" | "video";
  brand: PostBrandContext;
  plan: PostPlanContext | null;
  nowIso: string;
  /** What the vision model saw in the photo, or null/absent when nothing looked at it. */
  visual?: { description: string } | null;
  /** The owner's own line on what this post is for ("What is this post for?"), or empty. */
  brief?: string | null;
}) {
  const seen = input.visual?.description.trim().slice(0, 400) || "";
  const purpose = (input.brief ?? "").trim().slice(0, 800);
  const payload = {
    // The owner's purpose for the post comes first: it is what the caption serves.
    postPurpose: purpose || null,
    importedFile: {
      name: input.displayName.slice(0, 180),
      type: input.assetKind === "video" ? "video" : "image",
      mimeType: input.mimeType,
      sizeBytes: input.byteSize,
      ...(seen ? { whatMaraSaw: seen } : {}),
    },
    maraHasSeenTheFile: Boolean(seen),
    note: seen
      ? "MARA looked at a small copy of this image once; importedFile.whatMaraSaw is everything she saw. Write for that picture, in the brand's voice, and state nothing about the image beyond that description."
      : "MARA cannot see this file. Use only the metadata above plus the business and plan context. Do not describe the visual.",
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
  return input.brand.brandKit ? { ...payload, brandKit: input.brand.brandKit } : payload;
}

/**
 * The disclosure shown next to any suggestion for existing content, so the UI
 * never implies MARA looked at the media itself.
 */
export const EXISTING_CONTENT_DISCLOSURE =
  "MARA has not seen this file. These suggestions are based on the file name, file type and your brand and plan context only.";

/** The disclosure when the vision model looked at the photo (slice 5b). */
export const EXISTING_CONTENT_SEEN_DISCLOSURE =
  "MARA looked at a small copy of this image once to write these. Check that what she saw matches the photo before you save.";

/**
 * The suggestion prompt when MARA has a reading of the photo (slice 5b). Same
 * rules as the unseen prompt, with the honesty rule turned around: she knows
 * the picture only through that one description and may state nothing beyond it.
 */
export const POST_SUGGESTION_SEEN_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager. The user has imported a photo they already own, and you looked at a small copy of it once.

Return JSON only, with exactly these keys:
{"caption":"string","cta":"string","hashtags":["string"],"suggestedPublishAt":"ISO-8601 or null","timingReason":"string"}

What a caption is for:
- postPurpose is the owner's own line on why they are posting this photo. The caption's job is that purpose, in the brand's voice; the photo supplies the specifics. When postPurpose is null, choose the purpose from the business's main goal and the marketing plan (for example "more online sales" means an invitation to order, "more walk-ins" means a reason to visit) and write for it.
- A caption is never a description of the photo. Lead with why the reader should care, then use what the photo shows to make it concrete. Never list what is in the picture.
- When postPurpose and the photo clearly do not match (the purpose names a product the photo does not show), follow the purpose for what the post is about and the photo for what is shown, invent nothing to bridge them, and say in timingReason that the photo may not fit the purpose.

Critical honesty rule:
- Everything you know about the photo is importedFile.whatMaraSaw, written from that one look. Do NOT state anything about the image that is not in that description, and never claim to have examined it closely.
- Where the description names one of the business's products, use that name; where it does not, do not guess which product it is.
- Fit the brand: its description, personality and, when given, the Brand Kit rules, so the caption and the picture never contradict each other.
- Do not invent prices, discounts, offers, opening hours, locations, links, awards, reviews, or statistics that are not in the supplied context.
- suggestedPublishAt must be a real future ISO-8601 timestamp based on the current time and the business's stated content frequency, or null if you cannot justify one.
- timingReason: one short sentence explaining the suggested slot from the supplied context only.`;
