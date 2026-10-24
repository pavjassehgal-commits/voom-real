/**
 * Brand Kit v2, slice 4: what MARA learns from the owner's description.
 *
 * ONE structured AI call reads the description the owner wrote on screen 2 and
 * returns guesses for the later screens: name, category, offerings, audience,
 * goal, personality, a short brief draft and the specific facts the text
 * claims. Everything is a guess the owner confirms on the "Here's what I
 * learned" screen; nothing is saved until "Finish setup".
 *
 * Two safety layers: the provider gets a strict JSON Schema whose choice
 * fields are enums of OUR lists, and the zod schema here re-checks the answer,
 * so a category, audience chip, goal or tone outside the product's vocabulary
 * is rejected (and counts as a failed read, which falls back to the keyword
 * guess). Pure and dependency-light so the Node suite tests it directly with a
 * fake provider; the real provider is injected by the server action.
 */
import { z } from "zod";
import type { AiProvider } from "@/lib/ai/types";
import type { BrandLearned } from "@/lib/voom/types";
import { OB_TONE, Q_CUSTOMER, Q_GOAL, Q_INDUSTRY } from "@/lib/voom/onboardingData";

export type { BrandLearned } from "@/lib/voom/types";

/** The description is capped before it is sent; a brand description is a few paragraphs, not a website. */
export const BRAND_EXTRACTION_INPUT_MAX = 4000;
export const BRAND_BRIEF_DRAFT_MAX = 600;

const CATEGORIES = Q_INDUSTRY.map(([, name]) => name);
const GOALS = Q_GOAL.map(([, name]) => name);
const AUDIENCES = [...Q_CUSTOMER];
const TONES = [...OB_TONE];

const asEnum = (values: string[]) => z.enum(values as [string, ...string[]]);
const dedupe = (maxItems: number) => (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, maxItems);

/** Server-side check of the provider's answer. Off-list choices are refused, never coerced. */
export const brandExtractionSchema = z.object({
  name: z.string().trim().max(160),
  category: z.union([z.literal(""), asEnum(CATEGORIES)]),
  offerings: z.array(z.string().trim().min(1).max(200)).max(20).transform(dedupe(20)),
  audience: z.array(asEnum(AUDIENCES)).max(10).transform(dedupe(10)),
  goal: z.union([z.literal(""), asEnum(GOALS)]),
  personality: z.array(asEnum(TONES)).max(3).transform(dedupe(3)),
  brief: z.string().trim().max(BRAND_BRIEF_DRAFT_MAX),
  facts: z.array(z.string().trim().min(1).max(200)).max(20).transform(dedupe(20)),
}).strict();

/** Groq strict structured output mirroring `brandExtractionSchema` exactly. */
export const brandExtractionJsonSchema = {
  name: "mara_brand_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "category", "offerings", "audience", "goal", "personality", "brief", "facts"],
    properties: {
      name: { type: "string", maxLength: 160, description: "The business name exactly as the description writes it, or \"\" when it is not named." },
      category: { type: "string", enum: ["", ...CATEGORIES], description: "The one kind of business that fits, or \"\" when unclear." },
      offerings: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 }, description: "Products or services the description mentions, in the owner's words." },
      audience: { type: "array", maxItems: 10, items: { type: "string", enum: AUDIENCES }, description: "Only the audience groups the description supports." },
      goal: { type: "string", enum: ["", ...GOALS], description: "What the owner says they want more of, or \"\"." },
      personality: { type: "array", maxItems: 3, items: { type: "string", enum: TONES }, description: "Up to three tones the description's own words make clear." },
      brief: { type: "string", maxLength: BRAND_BRIEF_DRAFT_MAX, description: "Two to four plain sentences restating the description as the business (\"We ...\"). No new claims." },
      facts: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 }, description: "Specific claims in the description that need the owner's confirmation: years, dates, counts, awards, places, certifications." },
    },
  },
} as const;

export const BRAND_EXTRACTION_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, reading a small business owner's description of their brand for the first time.

Return JSON only, matching the schema you were given. Every value is a GUESS the owner will confirm or correct on the next screen, so:
- Use ONLY what the description says. Never invent names, products, places, years, numbers, awards or customers. When the description does not say, answer "" or [].
- name: the business name exactly as written, or "".
- category: exactly one of ${CATEGORIES.map((c) => `"${c}"`).join(", ")}, or "" when unclear. Use "Other" only when the business clearly fits none of the rest.
- offerings: the products or services the description mentions, short and in the owner's words, up to 8.
- audience: only from ${AUDIENCES.map((a) => `"${a}"`).join(", ")}; pick the groups the description supports, [] when unsure.
- goal: one of ${GOALS.map((g) => `"${g}"`).join(", ")}, or "" when the description does not say what they want more of.
- personality: up to 3 from ${TONES.map((t) => `"${t}"`).join(", ")}, only when the description's tone or words make it clear.
- brief: two to four plain sentences, under ${BRAND_BRIEF_DRAFT_MAX} characters, written as the business ("We ..."), restating what the description says: what they are, what they offer, who it is for, what makes them different. No new claims, no superlatives the owner did not use, no hashtags, no emoji.
- facts: the specific claims in the description that need the owner's confirmation before MARA may ever state them: years, dates, counts, awards, places, certifications. Quote each briefly ("Roasting since 2014"). [] when there are none.
Write in the language of the description.`;

export function brandLearnedIsEmpty(learned: BrandLearned): boolean {
  return !learned.name && !learned.category && !learned.offerings.length && !learned.audience.length
    && !learned.goal && !learned.personality.length && !learned.brief && !learned.facts.length;
}

/**
 * The one extraction call. Throws the provider's AiError on failure; the
 * server action maps it to a plain reason and the wizard falls back.
 */
export async function extractBrandFromDescription(provider: Pick<AiProvider, "structured">, description: string): Promise<BrandLearned> {
  const text = description.trim().slice(0, BRAND_EXTRACTION_INPUT_MAX);
  return provider.structured<BrandLearned>({
    messages: [
      { role: "system", content: BRAND_EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ description: text }) },
    ],
    temperature: 0.2,
    maxTokens: 900,
    jsonSchema: brandExtractionJsonSchema,
    parse: (value) => brandExtractionSchema.parse(value),
  });
}
