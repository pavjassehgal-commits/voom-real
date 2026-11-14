/**
 * Post Studio, slice 5b: MARA looks at an uploaded photo before suggesting
 * its caption.
 *
 * ONE structured call to the optional vision model (AI_VISION_*) with a small
 * JPEG copy of the photo (lib/brand/image.ts) and a short brand hint: the
 * business name, its kind, what it offers and how its product photos are
 * described on the Brand page. The hint lets MARA name a product the owner
 * sells when the photo clearly shows it; the prompt forbids naming one
 * otherwise. The reading is one plain paragraph the caption model then writes
 * for, and the owner sees it next to the suggestion. Nothing is stored.
 *
 * Safety: only what is visible; no identifying people or guessing personal
 * traits; visible words copied exactly. The provider gets a strict JSON
 * Schema; the zod parse trims over-long text instead of losing the reading.
 *
 * Pure apart from base64 encoding: the provider is injected, so the Node
 * suite tests it with a fake.
 */
import { z } from "zod";
import type { AiProvider } from "@/lib/ai/types";
import type { PostBrandContext } from "./prompt";

export const POST_VISION_DESCRIPTION_MAX = 400;

const HINT_LIMITS = { offerings: 20, products: 10, text: 120 } as const;

/** What the vision call is told about the brand, so it can name what it sees. */
export interface PostVisionHint {
  brandName: string;
  category: string;
  offerings: string[];
  /** The one-line descriptions of the owner's product photos from the Brand page. */
  products: string[];
}

const short = (items: readonly string[], max: number) =>
  [...new Set(items.map((item) => item.trim().slice(0, HINT_LIMITS.text)).filter(Boolean))].slice(0, max);

export function postVisionHint(brand: PostBrandContext): PostVisionHint {
  const kit = brand.brandKit;
  const products = kit && "visualStyle" in kit && kit.visualStyle && "products" in kit.visualStyle && Array.isArray(kit.visualStyle.products) ? kit.visualStyle.products : [];
  return {
    brandName: brand.brandName.trim().slice(0, 160),
    category: brand.industry.trim().slice(0, 120),
    offerings: short(kit?.offerings ?? [], HINT_LIMITS.offerings),
    products: short(products, HINT_LIMITS.products),
  };
}

export const postImageReadingSchema = z.object({
  description: z.string().transform((v) => v.trim().slice(0, POST_VISION_DESCRIPTION_MAX)),
}).strict();

export const postImageReadingJsonSchema = {
  name: "mara_post_image_reading",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["description"],
    properties: {
      description: { type: "string", maxLength: POST_VISION_DESCRIPTION_MAX, description: "What the photo shows, in plain words, for someone who cannot see it." },
    },
  },
} as const;

export const POST_VISION_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, looking at ONE photo a small business owner uploaded to post on social media. Describe it for a colleague who cannot see it and will write the caption.

Return JSON only, matching the schema you were given: { "description": "..." }, under ${POST_VISION_DESCRIPTION_MAX} characters, plain text: what is shown, the setting, the light or mood, and any visible words copied exactly as written.
- Describe only what is visible. Never guess prices, places, dates, awards or claims that are not written in the image.
- Never identify or name a person, and never guess anyone's age, ethnicity, religion, health or other personal traits. Say "a person" or "two people".
- The payload names the business, its kind, what it offers and how its product photos are described. Name a product from that list ONLY when the photo clearly shows it: a visible label, or an unmistakable match to its description. Otherwise describe what you see in plain words and name nothing from the list.
- When the image is unclear, say so briefly.`;

/** One vision call for one photo. Throws the provider's AiError on failure. */
export async function describePostImage(
  provider: Pick<AiProvider, "structured">,
  input: { jpeg: Uint8Array; hint: PostVisionHint },
): Promise<string> {
  const dataUrl = `data:image/jpeg;base64,${Buffer.from(input.jpeg).toString("base64")}`;
  const reading = await provider.structured<{ description: string }>({
    messages: [
      { role: "system", content: POST_VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify({ business: input.hint }) },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    maxTokens: 600,
    // One retry at most: the owner is waiting in the editor.
    maxAttempts: 2,
    jsonSchema: postImageReadingJsonSchema,
    parse: (value) => postImageReadingSchema.parse(value),
  });
  return reading.description;
}
