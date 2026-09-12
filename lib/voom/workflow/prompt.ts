import { z } from "zod";

/**
 * MARA's structured content generation for one planned workflow item.
 *
 * Text-only context (business profile + goal + planned slot). No media bytes
 * ever reach the provider, and MARA never claims anything was published.
 * Uses the existing Groq structured-output contract.
 */

export const plannedContentSchema = z.object({
  concept: z.string().min(1).max(160),
  caption: z.string().min(1).max(2200),
  cta: z.string().min(1).max(160),
  hashtags: z.array(z.string().min(1).max(30)).max(15).default([]),
  visualBrief: z.string().min(1).max(1200),
}).strict();

export type PlannedContent = z.infer<typeof plannedContentSchema>;

export const plannedContentJsonSchema = {
  name: "voom_planned_content",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["concept", "caption", "cta", "hashtags", "visualBrief"],
    properties: {
      concept: { type: "string", minLength: 1, maxLength: 160 },
      caption: { type: "string", minLength: 1, maxLength: 2200 },
      cta: { type: "string", minLength: 1, maxLength: 160 },
      hashtags: { type: "array", maxItems: 15, items: { type: "string", minLength: 1, maxLength: 30 } },
      visualBrief: { type: "string", minLength: 1, maxLength: 1200 },
    },
  },
} as const;

export const PLANNED_CONTENT_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, writing ONE scheduled piece of Instagram content for the authenticated user's own business.

Return JSON only, with exactly these keys:
{"concept":"string","caption":"string","cta":"string","hashtags":["string"],"visualBrief":"string"}

Rules:
- concept: a short internal name for this content (max 12 words).
- caption: the complete caption in the brand's voice. For a Story, keep it to one short on-screen line, because Instagram does not support Story captions.
- cta: one short call to action, max 8 words.
- hashtags: 3-8 relevant hashtags for a Post or Reel; an empty array for a Story.
- visualBrief: a precise description of the single visual to produce, 20-80 words. Describe setting, subject, light and mood. Do NOT ask for readable text, words, numbers, logos, or watermarks in the image.
- Ground everything ONLY in the supplied business context and marketing goal. Never invent prices, discounts, offers, opening hours, links, awards, reviews, guarantees or statistics.
- Never claim the content was generated, scheduled, sent or published. This is a plan for the user's workflow.
- Plain text only. No markdown.`;

/** Text-only payload for one planned slot. */
export function buildPlannedContentPayload(input: {
  business: Record<string, unknown>;
  goal: string;
  cadenceLabel: string;
  contentType: "post" | "reel" | "story";
  localDate: string;
  localTime: string;
  timezone: string;
  recentConcepts: string[];
}) {
  return {
    business: input.business,
    marketingGoal: input.goal.slice(0, 300),
    postingCadence: input.cadenceLabel,
    contentType: input.contentType === "post" ? "instagram_feed_post" : input.contentType === "reel" ? "reel" : "instagram_story",
    scheduledFor: { date: input.localDate, localTime: input.localTime, timezone: input.timezone },
    // Prevents the rolling plan from repeating itself across the horizon.
    alreadyPlannedConcepts: input.recentConcepts.slice(0, 14),
  };
}
