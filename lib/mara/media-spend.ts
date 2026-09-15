/**
 * AI Media Spend Control — legacy USD gate, now aligned with V1 Plans + Credits.
 *
 * Authoritative rules (v1):
 *   Manual    → automatic paid media never allowed, whatever toggle says.
 *   Assisted  → automatic paid media never allowed (deliberate change from old behaviour).
 *               Paid media requires explicit user action.
 *   Autopilot → allowed only if toggle on AND budget not exhausted AND plan allows.
 *   Explicit  → always allowed (owner asked for that exact item), recorded as user_request.
 *
 * Every blocked automatic attempt returns truthful reason and NOTHING is submitted.
 * Workflow keeps plan, copy and drafts — only media waits.
 *
 * ESTIMATED COSTS: kept for backwards compat and for mara_media_generations.estimated_cost_usd.
 * New code should use lib/billing/credits.ts for Voom credit costs.
 *
 * This module is pure so Node test suite can execute it.
 */

export const MEDIA_SOURCES = ["user_request", "assisted", "autopilot"] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

export const MEDIA_SPEND_BLOCK_REASONS = ["automatic_media_disabled", "budget_exhausted", "plan_not_allowed", "insufficient_credits"] as const;
export type MediaSpendBlockReason = (typeof MEDIA_SPEND_BLOCK_REASONS)[number];

export interface MediaSpendSettings {
  allowAutomaticPaidMedia: boolean;
  monthlyMediaBudgetUsd: number;
}

export const DEFAULT_ALLOW_AUTOMATIC_PAID_MEDIA = true;
export const DEFAULT_MONTHLY_MEDIA_BUDGET_USD = 25;

export const ESTIMATED_MEDIA_COST = {
  imageUsd: 0.05,
  videoUsdPerSecond: 0.1,
  videoMinimumSeconds: 4,
  videoDefaultSeconds: 6,
  imageEnvVar: "MEDIA_IMAGE_ESTIMATED_COST_USD",
  videoPerSecondEnvVar: "MEDIA_VIDEO_ESTIMATED_COST_PER_SECOND_USD",
} as const;

export const MEDIA_SPEND_UNVERIFIED_CODE = "media_spend_read_failed";

export const MEDIA_SPEND_UNVERIFIED_NOTICE =
  "MARA couldn't check this month's AI media spending, so nothing was generated automatically. The plan and copy are ready — try again in a moment, or create a visual with Create with MARA.";

export const MEDIA_SPEND_BLOCK_TITLES: Record<string, string> = {
  automatic_media_disabled: "Automatic media generation disabled",
  budget_exhausted: "Monthly AI media budget reached",
  plan_not_allowed: "Plan does not include automatic media",
  insufficient_credits: "Not enough media credits",
};

export const MEDIA_SPEND_BLOCK_MESSAGES: Record<string, string> = {
  automatic_media_disabled:
    "Automatic media generation disabled — Voom planned this content without media. Turn it on in Settings → AI Media Spending, or create each visual with Create with MARA.",
  budget_exhausted:
    "Monthly AI media budget reached — Voom planned this content without media. Raise the monthly budget in Settings → AI Media Spending, or create each visual with Create with MARA.",
  plan_not_allowed:
    "Your plan does not include automatic media generation — Voom planned this content without media. Upgrade to Max for Autopilot, or create each visual with Create with MARA.",
  insufficient_credits:
    "Not enough Voom media credits — Voom planned this content without media. Wait for your monthly reset or upgrade your plan, or create each visual if you have credits remaining.",
};

type EnvLike = Record<string, string | undefined>;

function envNumber(env: EnvLike | undefined, name: string): number | null {
  const raw = env?.[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function estimateMediaCostUsd(input: {
  mediaType: "image" | "video";
  durationSeconds?: number | null;
  env?: EnvLike;
}): number {
  if (input.mediaType === "image") {
    const override = envNumber(input.env, ESTIMATED_MEDIA_COST.imageEnvVar);
    return roundUsd(override ?? ESTIMATED_MEDIA_COST.imageUsd);
  }
  const requested = Number(input.durationSeconds);
  const seconds = Number.isFinite(requested) && requested > 0
    ? Math.max(requested, ESTIMATED_MEDIA_COST.videoMinimumSeconds)
    : ESTIMATED_MEDIA_COST.videoDefaultSeconds;
  const override = envNumber(input.env, ESTIMATED_MEDIA_COST.videoPerSecondEnvVar);
  return roundUsd(seconds * (override ?? ESTIMATED_MEDIA_COST.videoUsdPerSecond));
}

export function normalizeMonthlyMediaBudgetUsd(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MONTHLY_MEDIA_BUDGET_USD;
  }
  return Math.round(parsed * 100) / 100;
}

export function normalizeAllowAutomaticPaidMedia(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return DEFAULT_ALLOW_AUTOMATIC_PAID_MEDIA;
}

export function normalizeMediaSpendSettings(
  row: { allow_automatic_paid_media?: unknown; monthly_media_budget_usd?: unknown } | null | undefined,
): MediaSpendSettings {
  return {
    allowAutomaticPaidMedia: normalizeAllowAutomaticPaidMedia(row?.allow_automatic_paid_media),
    monthlyMediaBudgetUsd: normalizeMonthlyMediaBudgetUsd(row?.monthly_media_budget_usd),
  };
}

export function mediaSourceForRun(mode: "manual" | "assisted" | "autopilot", explicit: boolean): MediaSource {
  if (explicit) return "user_request";
  return mode === "autopilot" ? "autopilot" : "assisted";
}

export type MediaSpendDecision =
  | { allow: true; source: MediaSource; reason: null; message: null; estimatedCostUsd: number; budgetReached: boolean }
  | { allow: false; source: MediaSource; reason: MediaSpendBlockReason; message: string; estimatedCostUsd: number; budgetReached: boolean };

/**
 * The ONE legacy USD gate, now aligned with v1 product rules.
 * Manual and Assisted never allow automatic paid media.
 */
export function evaluateMediaSpendGate(input: {
  mode: "manual" | "assisted" | "autopilot";
  explicit: boolean;
  allowAutomaticPaidMedia: boolean;
  monthlyMediaBudgetUsd: number;
  spentThisMonthUsd: number;
  estimatedCostUsd: number;
  source?: MediaSource;
}): MediaSpendDecision {
  const source = input.source ?? mediaSourceForRun(input.mode, input.explicit);
  const estimatedCostUsd = roundUsd(Math.max(0, input.estimatedCostUsd));
  const budgetReached = input.spentThisMonthUsd + estimatedCostUsd > input.monthlyMediaBudgetUsd;

  if (input.explicit || source === "user_request") {
    return { allow: true, source: "user_request", reason: null, message: null, estimatedCostUsd, budgetReached };
  }
  // v1: Only Autopilot may auto-generate; Manual and Assisted are always blocked
  if (input.mode === "manual" || input.mode === "assisted" || !input.allowAutomaticPaidMedia) {
    return {
      allow: false,
      source,
      reason: "automatic_media_disabled",
      message: MEDIA_SPEND_BLOCK_MESSAGES.automatic_media_disabled,
      estimatedCostUsd,
      budgetReached,
    };
  }
  if (budgetReached) {
    return {
      allow: false,
      source,
      reason: "budget_exhausted",
      message: MEDIA_SPEND_BLOCK_MESSAGES.budget_exhausted,
      estimatedCostUsd,
      budgetReached: true,
    };
  }
  return { allow: true, source, reason: null, message: null, estimatedCostUsd, budgetReached: false };
}

export function mediaSpendRunNotice(failures: { slot?: string; stage: string; code: string }[]): string | null {
  const mediaCodes = failures.filter((failure) => failure.stage === "media").map((failure) => failure.code);
  const parts = [...new Set(mediaCodes)]
    .filter((code): code is MediaSpendBlockReason => (MEDIA_SPEND_BLOCK_REASONS as readonly string[]).includes(code))
    .map((reason) => MEDIA_SPEND_BLOCK_MESSAGES[reason] ?? reason);
  if (mediaCodes.includes(MEDIA_SPEND_UNVERIFIED_CODE)) parts.push(MEDIA_SPEND_UNVERIFIED_NOTICE);
  return parts.length ? parts.join(" ") : null;
}

export const MANUAL_NEVER_AUTO_SPENDS =
  "Manual and Assisted never spend on media by themselves: Voom plans, writes and drafts, and generates a visual only when you click Create with MARA.";
