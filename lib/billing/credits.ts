/**
 * Voom Media Credits — centralized pricing helper.
 *
 * This is the ONE place that owns credit costs for paid media generation.
 * No other module may hard-code a credit number — they must call
 * creditCostForMedia().
 *
 * Structure is future-proof: actual provider-cost settlement can replace the
 * conservative estimates here later without touching callers.
 *
 * Initial costs (conservative provider estimates):
 *   Seedream image — 5 credits
 *   Seedance short video (6-8s) — 40 credits
 *
 * These numbers are intentionally integer and small, matching the UX examples:
 *   "Generate image with MARA · 5 credits"
 *   "Generate video with MARA · 40 credits"
 */

export type CreditMediaType = "image" | "video";

export const CREDIT_COSTS = {
  /** One Seedream-class image. */
  image: 5,
  /** One Seedance-class short video (6-8s default). */
  video: 40,
  /** Minimum video cost (for very short clips, if duration varies later). */
  videoMin: 40,
  /** Cost per second beyond the default, if duration-based pricing is added later. */
  videoPerSecond: 5,
} as const;

export interface CreditCostInput {
  mediaType: CreditMediaType;
  /** Optional duration for video; currently ignored beyond minimum, kept for future settlement. */
  durationSeconds?: number | null;
}

/**
 * Centralized credit cost calculator.
 * Returns integer credits required for one generation.
 */
export function creditCostForMedia(input: CreditCostInput): number {
  if (input.mediaType === "image") {
    return CREDIT_COSTS.image;
  }
  // Video: for now fixed cost, but structure allows duration-based pricing later.
  // If duration is supplied and very long, we could scale — for V1 we keep fixed to avoid surprises.
  const duration = typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds) ? input.durationSeconds : 6;
  // Conservative: short videos cost the same; longer videos would cost more if we enable scaling.
  // For now, any video up to 15s is flat 40 credits. This can be replaced with real settlement later.
  if (duration <= 0) return CREDIT_COSTS.videoMin;
  return CREDIT_COSTS.video;
}

/** Human-readable cost label for UI: "5 credits" / "40 credits" */
export function formatCreditCost(credits: number): string {
  return `${credits} credit${credits === 1 ? "" : "s"}`;
}

/** For future settlement: map real provider cost (USD) to credits, if needed. */
export function creditsFromUsd(usd: number, rateUsdPerCredit = 0.01): number {
  // $0.01 per credit => 5 credits = $0.05 image (matches old estimate), 40 credits = $0.40 video (conservative vs old $0.60)
  // Rate can be adjusted centrally.
  return Math.max(1, Math.ceil(usd / rateUsdPerCredit));
}
