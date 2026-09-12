/**
 * Production options for one Reel recommendation.
 *
 * Two DIFFERENT concepts live here and must never be conflated:
 *
 *   - the RECOMMENDED production method (what MARA believes produces the best
 *     result for this exact concept, e.g. "Film it yourself" for anything
 *     needing authentic real-world footage), and
 *   - the AVAILABLE production methods (every way the user can legitimately
 *     execute the plan item).
 *
 * "Create with MARA" therefore stays visible even when filming is
 * recommended: when the exact concept asks for real people, real premises or
 * real processes, MARA offers an ADAPTED equivalent (a branded animated
 * explainer covering the same message) instead of silently disappearing.
 * MARA generation is only ever disabled when no safe or meaningful generated
 * equivalent exists (real customer testimonials, real product demos) — and
 * then with a specific, user-facing reason, never a silent omission.
 */

export const reelProductionMethods = ["create_with_mara", "film_yourself", "upload_asset"] as const;
export type ReelProductionMethod = typeof reelProductionMethods[number];

export interface ReelProductionInput { concept: string; script: string; shotInstructions?: string[]; }

/**
 * What "Create with MARA" means for this exact concept.
 *
 *   recommended  -> MARA is also the best method; the concept is generated as written.
 *   available    -> MARA can faithfully produce the exact concept.
 *   adapted      -> the concept asks for real footage MARA cannot fabricate, so
 *                   MARA produces a truthful adapted equivalent instead
 *                   (`concept` holds what would actually be generated).
 *   unavailable  -> no safe/meaningful generated equivalent exists;
 *                   `disabledReason` says why, in plain language.
 */
export interface MaraProductionOption {
  state: "recommended" | "available" | "adapted" | "unavailable";
  /** The concept MARA would actually generate (the adapted one when adapting). */
  concept: string | null;
  /** One compact user-facing line explaining what MARA will do. */
  note: string | null;
  /** Why Create with MARA is disabled. Set only when state is "unavailable". */
  disabledReason: string | null;
}

export interface ReelProductionCapability {
  availableMethods: ReelProductionMethod[];
  recommendedMethod: ReelProductionMethod;
  missingAssetRequest: string | null;
  shotInstructions: string[];
  allowedAssetKinds: ("image" | "video")[];
  /** The Create-with-MARA option, always resolved — never silently dropped. */
  maraOption: MaraProductionOption;
}

const AUTHENTIC_FOOTAGE = /\b(testimonial|real customer|customer reaction|owner|founder|staff|team member|storefront|shop front|exterior|interior|inside (?:the|our) (?:shop|store|cafe|restaurant)|behind the scenes|being (?:made|prepared|cut|served)|cut(?:ting)? open|unboxing|event|today'?s|our location|walkthrough)\b/i;
const TEMPLATE_FRIENDLY = /\b(tips?|how to|explainer|checklist|myths?|facts?|did you know|educational|text[- ]led|animated|graphic|step[- ]by[- ]step|frequently asked|faq)\b/i;

/**
 * Concepts whose ENTIRE point is authentic reality that a generator cannot
 * fabricate: a real customer's endorsement, or the real product being
 * opened/prepared/demonstrated. A generated version would fabricate a review
 * or misrepresent the real product, so Create with MARA is truthfully
 * disabled for these — everything else gets an adapted alternative.
 */
const CANNOT_BE_FAKED = /\b(testimonial|real customer|customer reaction|being (?:made|prepared|cut|served)|cut(?:ting)? open|unboxing)\b/i;

/** Adaptable real-footage concept -> the truthful equivalent MARA produces. */
const ADAPTATIONS: [RegExp, (concept: string) => string][] = [
  [/\b(founder|owner|staff|team member)\b/i, (concept) => `Branded animated explainer covering the same message as “${concept}” — no on-camera presenter.`],
  [/\b(behind the scenes|being served)\b/i, (concept) => `Branded motion-graphic teaser evoking the story of “${concept}” — animated, not real footage.`],
  [/\b(storefront|shop front|exterior|interior|our location|walkthrough|inside (?:the|our) (?:shop|store|cafe|restaurant))\b/i, (concept) => `Branded animated invitation around the theme of “${concept}” — stylised graphics, not the real premises.`],
  [/\b(event|today'?s)\b/i, (concept) => `Branded animated announcement covering the same message as “${concept}”.`],
];

const ADAPTED_NOTE = "Filming gets the most authentic result, but MARA can generate an adapted animated version of this concept.";

export function classifyReelProduction(input: ReelProductionInput): ReelProductionCapability {
  const text = `${input.concept}\n${input.script}\n${(input.shotInstructions ?? []).join("\n")}`;
  const needsAuthenticFootage = AUTHENTIC_FOOTAGE.test(text);
  const maraCanProduceTruthfully = !needsAuthenticFootage && TEMPLATE_FRIENDLY.test(text);
  const shotInstructions = normalizeShots(input.shotInstructions, needsAuthenticFootage);

  if (maraCanProduceTruthfully) {
    return {
      availableMethods: ["create_with_mara", "upload_asset", "film_yourself"],
      recommendedMethod: "create_with_mara", missingAssetRequest: null, shotInstructions,
      allowedAssetKinds: ["image", "video"],
      maraOption: { state: "recommended", concept: input.concept, note: "Best result: MARA generates this concept directly.", disabledReason: null },
    };
  }

  if (!needsAuthenticFootage) {
    // Neither template-shaped nor authentic-footage-shaped: MARA can still
    // generate a clean brandable Reel, but filming stays the recommendation.
    return {
      availableMethods: ["film_yourself", "create_with_mara", "upload_asset"],
      recommendedMethod: "film_yourself",
      missingAssetRequest: missingAsset(text), shotInstructions, allowedAssetKinds: videoRequired(text) ? ["video"] : ["image", "video"],
      maraOption: { state: "available", concept: input.concept, note: "MARA can generate a clean branded version of this concept.", disabledReason: null },
    };
  }

  if (CANNOT_BE_FAKED.test(text)) {
    const reason = cannotFakeReason(text);
    return {
      availableMethods: ["film_yourself", "upload_asset"], recommendedMethod: "film_yourself",
      missingAssetRequest: missingAsset(text), shotInstructions, allowedAssetKinds: videoRequired(text) ? ["video"] : ["image", "video"],
      maraOption: { state: "unavailable", concept: null, note: null, disabledReason: reason },
    };
  }

  // Authentic-footage concept with a safe adapted equivalent: filming stays
  // recommended, and Create with MARA stays visible — producing the adapted
  // concept instead of pretending to film reality.
  const adapted = adaptConcept(input.concept);
  return {
    availableMethods: ["film_yourself", "create_with_mara", "upload_asset"],
    recommendedMethod: "film_yourself",
    missingAssetRequest: missingAsset(text), shotInstructions, allowedAssetKinds: videoRequired(text) ? ["video"] : ["image", "video"],
    maraOption: { state: "adapted", concept: adapted, note: ADAPTED_NOTE, disabledReason: null },
  };
}

function adaptConcept(concept: string): string {
  const clean = concept.trim().replace(/[.。!！?？]+$/, "");
  for (const [pattern, build] of ADAPTATIONS) {
    if (pattern.test(clean)) return build(clean).slice(0, 160);
  }
  return `Branded animated explainer covering the same message as “${clean}” — no on-camera presenter.`.slice(0, 160);
}

function cannotFakeReason(text: string): string {
  if (/\b(testimonial|real customer|customer reaction)\b/i.test(text)) {
    return "MARA can't generate a real customer's testimonial — a fabricated endorsement would misrepresent your customers. Film the real clip or upload it.";
  }
  if (/\b(being (?:made|prepared|cut|served)|cut(?:ting)? open|unboxing)\b/i.test(text)) {
    return "MARA can't generate the real product being opened or prepared — a fabricated demo would misrepresent your product. Film the real clip or upload it.";
  }
  return "This concept only works with real footage MARA cannot fabricate. Film it yourself or upload an existing clip.";
}

function videoRequired(text: string) {
  return /\b(testimonial|customer reaction|being (?:made|prepared|cut|served)|cut(?:ting)? open|walkthrough)\b/i.test(text);
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
