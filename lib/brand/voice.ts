/**
 * Brand Kit v2, slice 6: MARA writes three sample captions in the brand's voice.
 *
 * ONE structured call to the text model from a snapshot of what the owner has
 * told her so far (name, kind of business, what they offer, audience, goal,
 * personality, brief, rules, banned words, confirmed facts, and the samples
 * already sorted). The owner taps "Sounds like us" / "Not us" on each; only
 * the ones they tap are saved, as the kit's `voice_samples`, which generation
 * already reads (lib/brand/context.ts).
 *
 * Safety: the prompt forbids inventing anything and limits facts to the
 * confirmed list; the code below drops any caption that uses a banned word or
 * copies a sample the owner already sorted, so the model's slip never reaches
 * the screen. Nothing here stores anything.
 *
 * Pure: the provider is injected, so the Node suite tests it with a fake.
 */
import { z } from "zod";
import type { AiProvider } from "@/lib/ai/types";
import type { BrandSectionValues } from "./sections";

/** The schema asks for captions under this; the parse allows a little over rather than losing the set. */
export const VOICE_SAMPLE_MAX = 220;
export const VOICE_SAMPLE_COUNT = 3;
/** Per list, the same cap as the Brand page editor and the reader (lib/brand/context.ts). */
export const VOICE_SAMPLES_PER_LIST = 5;

const text = (max: number) => z.string().trim().max(max).default("");
const list = (maxItems: number, maxLen: number) => z.array(z.string()).default([]).transform((items) =>
  [...new Set(items.map((item) => item.trim().slice(0, maxLen)).filter(Boolean))].slice(0, maxItems),
);

/** What MARA is told. Built by the screen from the answers it holds; checked again by the action. */
export const brandVoiceSnapshotSchema = z.object({
  name: text(160),
  category: text(120),
  description: text(2000),
  offerings: list(20, 200),
  audience: list(10, 80),
  goal: text(120),
  personality: list(10, 40),
  brief: text(6000),
  rules: list(20, 200),
  words: list(50, 60),
  facts: list(20, 200),
  liked: list(VOICE_SAMPLES_PER_LIST, 600),
  disliked: list(VOICE_SAMPLES_PER_LIST, 600),
}).strict();

export type BrandVoiceSnapshot = z.infer<typeof brandVoiceSnapshotSchema>;

/** The snapshot from the section values the Brand page and the wizard already hold. */
export function voiceSnapshotFromSections(v: Pick<BrandSectionValues, "basics" | "brief" | "offerings" | "audience" | "voice" | "avoid" | "facts">): BrandVoiceSnapshot {
  return {
    name: v.basics.name,
    category: v.basics.category,
    description: v.basics.description,
    offerings: v.offerings.offerings,
    audience: v.audience.audience,
    goal: v.audience.goal,
    personality: v.voice.personality,
    brief: v.brief.brief,
    rules: v.avoid.rules,
    words: v.avoid.words,
    facts: v.facts.facts,
    liked: v.voice.liked,
    disliked: v.voice.disliked,
  };
}

/**
 * The part of the snapshot that changes what MARA would write. Sorting a
 * caption changes `liked`/`disliked` but should not ask for a new set, so
 * those two are left out: the wizard compares this to decide whether to call.
 */
export function voiceSnapshotKey(snapshot: BrandVoiceSnapshot): string {
  const rest: Omit<BrandVoiceSnapshot, "liked" | "disliked"> = {
    name: snapshot.name, category: snapshot.category, description: snapshot.description, offerings: snapshot.offerings,
    audience: snapshot.audience, goal: snapshot.goal, personality: snapshot.personality, brief: snapshot.brief,
    rules: snapshot.rules, words: snapshot.words, facts: snapshot.facts,
  };
  return JSON.stringify(rest);
}

/** Server-side check of the provider's answer: exactly three captions, each short. */
export const brandVoiceSamplesSchema = z.object({
  samples: z.array(z.string().trim().min(1).max(VOICE_SAMPLE_MAX + 60)).length(VOICE_SAMPLE_COUNT),
}).strict();

/** Strict structured output mirroring `brandVoiceSamplesSchema`. */
export const brandVoiceSamplesJsonSchema = {
  name: "mara_brand_voice_samples",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["samples"],
    properties: {
      samples: {
        type: "array",
        minItems: VOICE_SAMPLE_COUNT,
        maxItems: VOICE_SAMPLE_COUNT,
        items: { type: "string", minLength: 1, maxLength: VOICE_SAMPLE_MAX },
        description: "Exactly three sample captions, each a different angle, plain text.",
      },
    },
  },
} as const;

export const BRAND_VOICE_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager. A small business owner is setting up their brand. Write THREE short sample captions that show how their brand could sound in a social post, so the owner can tell you which ones sound like them.

Return JSON only, matching the schema you were given: { "samples": [three strings] }.
- Each caption: one to three sentences, under ${VOICE_SAMPLE_MAX} characters, plain text. No hashtags, no markdown, no emoji unless the personality includes "Playful".
- Three different angles: one about what they offer, one for the people they serve, one that shows their personality (a small moment, a behind-the-scenes line, a quiet opinion). Never three versions of the same idea.
- Match the personality tones. The brief and the description are the voice to follow.
- Use ONLY what the payload says. Never invent products, prices, places, years, numbers, awards or customers. The only specific facts you may state are in "facts"; state none when it is empty.
- Follow every rule in "avoid.rules". Never use a word from "avoid.words", in any casing.
- "samples.soundsLikeUs" are captions the owner already likes: match that tone, never copy one. "samples.notUs" are captions they rejected: write nothing like them.
- Write in the language of the description.`;

/**
 * The captions that may reach the screen: no blanks, no duplicates, none
 * using a banned word (any casing), none copying a sample already sorted.
 */
export function keepUsableSamples(samples: string[], snapshot: Pick<BrandVoiceSnapshot, "words" | "liked" | "disliked">): string[] {
  const banned = snapshot.words.map((w) => w.toLowerCase()).filter(Boolean);
  const known = new Set([...snapshot.liked, ...snapshot.disliked].map((s) => s.trim().toLowerCase()));
  const kept: string[] = [];
  for (const raw of samples) {
    const sample = raw.trim();
    const lower = sample.toLowerCase();
    if (!sample || known.has(lower) || kept.some((k) => k.toLowerCase() === lower)) continue;
    if (banned.some((word) => lower.includes(word))) continue;
    kept.push(sample);
  }
  return kept;
}

/**
 * The one call. Returns the usable captions (up to three; fewer when one was
 * dropped, [] when none survived). Throws the provider's AiError on failure.
 */
export async function writeVoiceSamples(provider: Pick<AiProvider, "structured">, snapshot: BrandVoiceSnapshot): Promise<string[]> {
  const payload = {
    business: { name: snapshot.name, category: snapshot.category, description: snapshot.description, offerings: snapshot.offerings, audience: snapshot.audience, goal: snapshot.goal },
    personality: snapshot.personality,
    brief: snapshot.brief,
    avoid: { rules: snapshot.rules, words: snapshot.words },
    facts: snapshot.facts,
    samples: { soundsLikeUs: snapshot.liked, notUs: snapshot.disliked },
  };
  const result = await provider.structured<{ samples: string[] }>({
    messages: [
      { role: "system", content: BRAND_VOICE_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    // Variety matters here, unlike the readings: three distinct angles.
    temperature: 0.8,
    // Room for a thinking model's reasoning, which counts against the cap: at
    // 500 Groq's gpt-oss-120b was cut off and failed four calls in five
    // (2026-10-27); it spends about 500 tokens thinking before the JSON.
    maxTokens: 1500,
    // One retry at most: the owner is waiting on the screen.
    maxAttempts: 2,
    jsonSchema: brandVoiceSamplesJsonSchema,
    parse: (value) => brandVoiceSamplesSchema.parse(value),
  });
  return keepUsableSamples(result.samples, snapshot);
}
