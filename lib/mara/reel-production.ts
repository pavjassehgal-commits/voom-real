export const reelProductionMethods = ["create_with_mara", "film_yourself", "upload_asset"] as const;
export type ReelProductionMethod = typeof reelProductionMethods[number];

export interface ReelProductionInput { concept: string; script: string; shotInstructions?: string[]; }
export interface ReelProductionCapability {
  availableMethods: ReelProductionMethod[];
  recommendedMethod: ReelProductionMethod;
  missingAssetRequest: string | null;
  shotInstructions: string[];
}

const AUTHENTIC_FOOTAGE = /\b(testimonial|real customer|customer reaction|owner|founder|staff|team member|storefront|shop front|exterior|interior|inside (?:the|our) (?:shop|store|cafe|restaurant)|behind the scenes|being (?:made|prepared|cut|served)|cut(?:ting)? open|unboxing|event|today'?s|our location|walkthrough)\b/i;
const TEMPLATE_FRIENDLY = /\b(tips?|how to|explainer|checklist|myths?|facts?|did you know|educational|text[- ]led|animated|graphic|step[- ]by[- ]step|frequently asked|faq)\b/i;

export function classifyReelProduction(input: ReelProductionInput): ReelProductionCapability {
  const text = `${input.concept}\n${input.script}\n${(input.shotInstructions ?? []).join("\n")}`;
  const needsAuthenticFootage = AUTHENTIC_FOOTAGE.test(text);
  const maraCanProduceTruthfully = !needsAuthenticFootage && TEMPLATE_FRIENDLY.test(text);
  const shotInstructions = normalizeShots(input.shotInstructions, needsAuthenticFootage);
  if (maraCanProduceTruthfully) return {
    availableMethods: ["create_with_mara", "upload_asset", "film_yourself"],
    recommendedMethod: "create_with_mara", missingAssetRequest: null, shotInstructions,
  };
  return {
    availableMethods: ["film_yourself", "upload_asset"], recommendedMethod: "film_yourself",
    missingAssetRequest: missingAsset(text), shotInstructions,
  };
}

export function productionStatusFor(method: ReelProductionMethod) {
  if (method === "create_with_mara") return "ready_for_mara_production";
  if (method === "film_yourself") return "waiting_for_filming";
  return "waiting_for_asset_upload";
}

function normalizeShots(shots: string[] | undefined, authentic: boolean) {
  const clean = (shots ?? []).map((shot) => shot.trim()).filter(Boolean).slice(0, 5);
  if (clean.length) return clean;
  return authentic
    ? ["Film vertically (9:16).", "Capture one steady 5–8 second clip in good light.", "Keep the real subject clearly visible."]
    : ["Use a vertical 9:16 layout.", "Show one clear idea per scene.", "Keep the finished Reel around 8–15 seconds."];
}

function missingAsset(text: string) {
  if (/\b(testimonial|real customer|customer reaction)\b/i.test(text)) return "1 vertical 10–15 second clip of the real customer giving the testimonial, with their permission.";
  if (/\b(storefront|shop front|exterior|our location)\b/i.test(text)) return "1 vertical 5–8 second clip showing the real storefront and entrance.";
  if (/\b(being cut|cut(?:ting)? open)\b/i.test(text)) return "1 vertical 5–8 second close-up clip of the real product being cut open.";
  if (/\b(being made|being prepared|behind the scenes)\b/i.test(text)) return "1 vertical 5–8 second clip of the real preparation process.";
  if (/\b(owner|founder|staff|team member)\b/i.test(text)) return "1 vertical 5–8 second clip of the named real person in the business.";
  return "1 vertical 5–8 second clip showing the real scene described in this Reel concept.";
}
