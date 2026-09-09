import { z } from "zod";

/**
 * MARA's structured media generation plan.
 *
 * A plan separates WHAT THE VIEWER SEES FROM THE BUSINESS (concept, overlay
 * copy, CTA — all Voom-controlled) from HOW THE PROVIDER RENDERS IT (visual
 * prompt + motion direction — never shown to the user as a UI promise, never
 * trusted to contain readable text). The provider prompt is built from the
 * plan, but the two are kept as distinct fields on purpose:
 *
 *   - overlayCopy / cta  -> deterministic Voom overlay or caption,
 *   - visualPrompt        -> image generator base frame,
 *   - motionDirection     -> video generator camera/motion direction.
 *
 * Truthfulness rules (mirrored from lib/post/prompt.ts and lib/mara/reel-copy):
 *   - text-only context (business profile + marketing plan + brief). No media
 *     bytes ever reach the LLM, so MARA never claims to have seen an asset.
 *   - no invented prices, offers, locations, real people, or claims,
 *   - no readable text / logos / watermarks requested inside the image.
 */

export const reelVideoPlanSchema = z.object({
  concept: z.string().min(1).max(160),
  visualObjective: z.string().min(1).max(300),
  visualPrompt: z.string().min(1).max(1200),
  motionDirection: z.string().min(1).max(400),
  overlayCopy: z.object({
    hook: z.string().min(1).max(80),
    message: z.string().min(1).max(120),
    value: z.string().min(1).max(120),
    cta: z.string().min(1).max(80),
  }).strict(),
  cta: z.string().min(1).max(160),
  durationSeconds: z.number().int().min(4).max(15),
}).strict();

export const storyVideoPlanSchema = z.object({
  concept: z.string().min(1).max(160),
  visualObjective: z.string().min(1).max(300),
  visualPrompt: z.string().min(1).max(1200),
  motionDirection: z.string().min(1).max(400),
  durationSeconds: z.number().int().min(3).max(15),
}).strict();

export type ReelVideoPlan = z.infer<typeof reelVideoPlanSchema>;
export type StoryVideoPlan = z.infer<typeof storyVideoPlanSchema>;

export const REEL_VIDEO_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, planning ONE 9:16 Reel video for the authenticated user's own business.

Return JSON only, with exactly these keys:
{"concept":"string","visualObjective":"string","visualPrompt":"string","motionDirection":"string","overlayCopy":{"hook":"string","message":"string","value":"string","cta":"string"},"cta":"string","durationSeconds":number}

Rules:
- concept: a short internal name for the Reel (max 12 words).
- visualObjective: one sentence stating what the visual must communicate to the target customer.
- visualPrompt: a precise text-to-image prompt for ONE clean, brandable 9:16 vertical frame, 20-80 words. Describe setting, subject, light and mood in the business's style. Ground it ONLY in the supplied business context, concept and brief. Do not name real people, real customers, or the business's real premises unless the context describes them. Do NOT ask for readable text, words, numbers, logos, or watermarks inside the image.
- motionDirection: 1-2 sentences of camera/motion direction for a video generator (for example: slow push-in, gentle parallax, soft light change, subtle product rotation). No dialogue, no on-screen text, no cuts.
- overlayCopy: viewer-facing on-screen copy only. hook: 3-8 words. message: 4-10 words stating the main point. value: 4-10 words of support grounded ONLY in the supplied context. cta: at most 6 words, one short action. Plain concise marketing copy; never production or shot direction.
- cta: one short call to action, max 8 words.
- durationSeconds: an integer between 6 and 12.
- Never invent prices, discounts, offers, opening hours, locations, links, awards, reviews, or statistics that are not in the supplied context.
- Never claim the Reel was generated, published, or scheduled. This is a plan for the user to review.`;

export const STORY_VIDEO_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, planning ONE 9:16 full-screen Instagram Story video for the authenticated user's own business.

Return JSON only, with exactly these keys:
{"concept":"string","visualObjective":"string","visualPrompt":"string","motionDirection":"string","durationSeconds":number}

Rules:
- concept: a short internal name for the Story (max 12 words).
- visualObjective: one sentence stating what the full-screen visual must communicate.
- visualPrompt: a precise text-to-image prompt for ONE clean, brandable 9:16 full-screen frame, 20-80 words. Keep the important content away from the extreme top and bottom edges (Instagram UI overlays them). Ground it ONLY in the supplied business context, concept and brief. Do not name real people, real customers, or the business's real premises unless the context describes them. Do NOT ask for readable text, words, numbers, logos, or watermarks inside the image.
- motionDirection: 1-2 sentences of camera/motion direction for a video generator (for example: slow push-in, gentle parallax, soft light change). No dialogue, no on-screen text, no cuts.
- durationSeconds: an integer between 5 and 10.
- Instagram Stories do not support captions, so no caption or overlay copy is written.
- Never invent prices, discounts, offers, opening hours, locations, links, awards, reviews, or statistics that are not in the supplied context.
- Never claim the Story was generated, published, or scheduled. This is a plan for the user to review.`;

export interface MediaPlanContext {
  brand: {
    name: string;
    description: string;
    industry: string;
    targetCustomer: string;
    mainGoal: string;
    brandPersonality: string;
  };
  marketingPlan: {
    businessGoal: string;
    weeklyStrategy: string;
    recentTopics: string[];
  } | null;
  requestedFormat: "9:16";
  contentType: "reel" | "instagram_story";
  /** The plan's existing concept/script when MARA planned the Reel. */
  suppliedConcept: string;
  suppliedScript: string;
  userBrief: string;
  sourceAsset: { kind: "image" | null; note: string };
}

/**
 * Text-only context handed to the LLM. Never contains media bytes, provider
 * keys, or storage paths.
 */
export function buildMediaPlanContext(input: {
  brand: {
    name: string;
    description: string;
    industry: string;
    targetCustomer: string;
    mainGoal: string;
    brandPersonality: string;
  };
  plan: { businessGoal: string; weeklyStrategy: string; topics: string[] } | null;
  contentType: "reel" | "instagram_story";
  concept: string;
  script?: string;
  brief?: string;
  hasSourceImage: boolean;
}): MediaPlanContext {
  return {
    brand: {
      name: input.brand.name.slice(0, 160),
      description: input.brand.description.slice(0, 800),
      industry: input.brand.industry.slice(0, 200),
      targetCustomer: input.brand.targetCustomer.slice(0, 300),
      mainGoal: input.brand.mainGoal.slice(0, 300),
      brandPersonality: input.brand.brandPersonality.slice(0, 400),
    },
    marketingPlan: input.plan
      ? {
          businessGoal: input.plan.businessGoal.slice(0, 500),
          weeklyStrategy: input.plan.weeklyStrategy.slice(0, 1500),
          recentTopics: input.plan.topics.slice(0, 12),
        }
      : null,
    requestedFormat: "9:16",
    contentType: input.contentType,
    suppliedConcept: input.concept.slice(0, 500),
    suppliedScript: (input.script ?? "").slice(0, 1200),
    userBrief: (input.brief ?? "").slice(0, 800),
    sourceAsset: input.hasSourceImage
      ? { kind: "image", note: "The user's own private image will be the first video frame; it is NOT described here and MARA has not seen it. Direct motion around a single supplied frame." }
      : { kind: null, note: "No source asset: MARA generates a clean base frame first, then the video is generated from that frame." },
  };
}

/**
 * The prompt actually sent to the video provider: the visual frame prompt
 * plus the motion direction. Kept separate from all user-facing copy.
 */
export function buildVideoProviderPrompt(plan: Pick<ReelVideoPlan | StoryVideoPlan, "visualPrompt" | "motionDirection">): string {
  return `${plan.visualPrompt.trim().replace(/\s+/g, " ")} ${plan.motionDirection.trim().replace(/\s+/g, " ")}`.slice(0, 1500);
}

/**
 * The prompt sent to the image provider when MARA must generate the base
 * frame before an image-to-video job. Adds the 9:16 framing rule without
 * ever asking for text.
 */
export function buildBaseImagePrompt(plan: Pick<ReelVideoPlan | StoryVideoPlan, "visualPrompt">): string {
  return `${plan.visualPrompt.trim().replace(/\s+/g, " ")} Vertical 9:16 composition, clean commercial look, no text, no logos, no watermarks.`.slice(0, 1500);
}
