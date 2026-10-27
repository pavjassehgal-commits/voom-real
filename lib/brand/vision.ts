/**
 * Brand Kit v2, slice 5: MARA looks at one uploaded brand image.
 *
 * ONE structured call to the optional vision model (AI_VISION_*) per image,
 * with a small JPEG copy attached (lib/brand/image.ts). It returns the one
 * line that says what the image is and, for past posts, style chips and a
 * short "look" line. Every value is a guess the owner can change; the UI
 * marks it "MARA's guess" until they do.
 *
 * Safety: the prompt allows only what is visible, forbids identifying or
 * describing people's personal traits, and limits chips to PAST_POST_CHIPS.
 * The provider gets a strict JSON Schema; the zod parse below is the second
 * layer: it drops any chip outside our list and trims over-long text instead
 * of losing the whole reading.
 *
 * Pure apart from base64 encoding: the provider is injected, so the Node
 * suite tests it with a fake.
 */
import { z } from "zod";
import type { AiProvider } from "@/lib/ai/types";
import { BRAND_ASSET_LIMITS, PAST_POST_CHIPS, type BrandAssetKind } from "./assets";

export interface BrandImageReading {
  description: string;
  chips: string[];
  look: string;
}

const KNOWN_CHIPS: readonly string[] = PAST_POST_CHIPS;

export const brandImageReadingSchema = z.object({
  description: z.string().transform((v) => v.trim().slice(0, BRAND_ASSET_LIMITS.description)),
  chips: z.array(z.string()).transform((items) => [...new Set(items.map((c) => c.trim()).filter((c) => KNOWN_CHIPS.includes(c)))].slice(0, BRAND_ASSET_LIMITS.chips)),
  look: z.string().transform((v) => v.trim().slice(0, BRAND_ASSET_LIMITS.look)),
}).strict();

export const brandImageReadingJsonSchema = {
  name: "mara_brand_image_reading",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["description", "chips", "look"],
    properties: {
      description: { type: "string", maxLength: BRAND_ASSET_LIMITS.description, description: "One plain line: what the image shows. Visible words exactly as written." },
      chips: { type: "array", maxItems: BRAND_ASSET_LIMITS.chips, items: { type: "string", enum: [...PAST_POST_CHIPS] }, description: "Past posts only: style chips that clearly apply. [] otherwise." },
      look: { type: "string", maxLength: BRAND_ASSET_LIMITS.look, description: "Past posts only: the light, colours and framing in one short line. \"\" otherwise." },
    },
  },
} as const;

export const BRAND_VISION_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, looking at ONE image a small business owner uploaded to their brand kit.

Return JSON only, matching the schema you were given.
- Describe only what is visible. Never guess names, places, prices, awards or claims that are not written in the image.
- Never identify or name a person, and never guess anyone's age, ethnicity, religion, health or other personal traits. Say "a person" or "two people".
- Copy any visible words exactly as written.
- The payload says what kind of image it is:
  - "logo": description = what the logo shows, under ${BRAND_ASSET_LIMITS.description} characters, including its words ("Brown coffee bean above the words Bean & Co."). chips = [], look = "".
  - "product": description = one plain line saying what the product or service shown is, under ${BRAND_ASSET_LIMITS.description} characters ("Iced latte in a tall glass"). chips = [], look = "".
  - "past_post": description = what the post shows, under ${BRAND_ASSET_LIMITS.description} characters. chips = up to ${BRAND_ASSET_LIMITS.chips} of ${PAST_POST_CHIPS.map((c) => `"${c}"`).join(", ")} that clearly apply. look = one short line on the light, colours and framing, under ${BRAND_ASSET_LIMITS.look} characters ("Warm morning light, close-up, cream and brown tones").
- When the image is unclear, answer "" and [].`;

/** One vision call for one image. Throws the provider's AiError on failure. */
export async function describeBrandImage(
  provider: Pick<AiProvider, "structured">,
  input: { kind: BrandAssetKind; jpeg: Uint8Array },
): Promise<BrandImageReading> {
  const dataUrl = `data:image/jpeg;base64,${Buffer.from(input.jpeg).toString("base64")}`;
  const reading = await provider.structured<BrandImageReading>({
    messages: [
      { role: "system", content: BRAND_VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify({ kind: input.kind }) },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    maxTokens: 400,
    // One retry at most: the owner is waiting on the upload screen.
    maxAttempts: 2,
    jsonSchema: brandImageReadingJsonSchema,
    parse: (value) => brandImageReadingSchema.parse(value),
  });
  return input.kind === "past_post" ? reading : { description: reading.description, chips: [], look: "" };
}
