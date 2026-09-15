/**
 * Voom Plans + Credits — authoritative plan definitions.
 *
 * This is the ONE place that owns plan pricing, credit allowances and
 * entitlement rules. No other module may hard-code a plan price, allowance or
 * mode permission — they must read it from here so pricing can be changed
 * later in a single file.
 *
 * Plans:
 *   Free — $0, Manual only, no AI image/video, no Autopilot
 *   Pro  — $29/month, Manual+Assisted, 150 credits, explicit generation allowed, NO automatic paid media, NO Autopilot
 *   Max  — $79/month, Manual+Assisted+Autopilot, 500 credits, automatic allowed only with toggle+credits
 */

export type PlanId = "free" | "pro" | "max";
export type AutomationModeValue = "manual" | "assisted" | "autopilot";

export const PLAN_IDS = ["free", "pro", "max"] as const;

export interface PlanConfig {
  id: PlanId;
  name: string;
  /** Target monthly price in USD (conceptual, not charged until Stripe). */
  priceUsd: number;
  /** Monthly included Voom media credits. */
  monthlyCredits: number;
  /** Which automation modes this plan may use. */
  allowedModes: AutomationModeValue[];
  /** May the user explicitly click Generate with MARA? */
  allowsExplicitMedia: boolean;
  /** May the system automatically generate paid media (Autopilot path)? */
  allowsAutomaticMedia: boolean;
  /** May the account select Autopilot? */
  allowsAutopilot: boolean;
  blurb: string;
}

export const PLAN_CONFIGS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    priceUsd: 0,
    monthlyCredits: 0,
    allowedModes: ["manual"],
    allowsExplicitMedia: false,
    allowsAutomaticMedia: false,
    allowsAutopilot: false,
    blurb: "Manual only. Plan, draft and upload your own media.",
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsd: 29,
    monthlyCredits: 150,
    allowedModes: ["manual", "assisted"],
    allowsExplicitMedia: true,
    allowsAutomaticMedia: false,
    allowsAutopilot: false,
    blurb: "Manual + Assisted. 150 AI media credits/month. You approve execution.",
  },
  max: {
    id: "max",
    name: "Max",
    priceUsd: 79,
    monthlyCredits: 500,
    allowedModes: ["manual", "assisted", "autopilot"],
    allowsExplicitMedia: true,
    allowsAutomaticMedia: true,
    allowsAutopilot: true,
    blurb: "Manual + Assisted + Autopilot. 500 credits/month. MARA runs within your limits.",
  },
};

export function normalizePlan(value: string | null | undefined): PlanId {
  if (value === "pro" || value === "max") return value;
  return "free";
}

export function getPlanConfig(planId: PlanId): PlanConfig {
  return PLAN_CONFIGS[planId] ?? PLAN_CONFIGS.free;
}

export function canUseAutomationMode(planId: PlanId, mode: AutomationModeValue): boolean {
  return getPlanConfig(planId).allowedModes.includes(mode);
}

export function canGenerateExplicitMedia(planId: PlanId): boolean {
  return getPlanConfig(planId).allowsExplicitMedia;
}

export function canGenerateAutomaticMedia(planId: PlanId): boolean {
  return getPlanConfig(planId).allowsAutomaticMedia;
}

export function canUseAutopilot(planId: PlanId): boolean {
  return getPlanConfig(planId).allowsAutopilot;
}

/** Monthly allowances centralized for easy pricing changes. */
export const MONTHLY_CREDIT_ALLOWANCES: Record<PlanId, number> = {
  free: PLAN_CONFIGS.free.monthlyCredits,
  pro: PLAN_CONFIGS.pro.monthlyCredits,
  max: PLAN_CONFIGS.max.monthlyCredits,
};

/** Price concepts centralized. */
export const PLAN_PRICES_USD: Record<PlanId, number> = {
  free: PLAN_CONFIGS.free.priceUsd,
  pro: PLAN_CONFIGS.pro.priceUsd,
  max: PLAN_CONFIGS.max.priceUsd,
};
