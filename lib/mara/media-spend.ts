/**
 * AI Media Spend Control — the ONE place that decides whether Voom may submit
 * a paid MARA media generation, and the ONE place the estimated media costs
 * live.
 *
 * Rules (owner settings on `businesses`, migration 0031):
 *   - `allow_automatic_paid_media`            — may MARA spend on media without
 *                                               an explicit request?
 *   - `monthly_media_budget_usd`              — the monthly ceiling (default $25)
 *
 *   Manual                  -> automatic paid media is never allowed, whatever
 *                              the toggle says. The owner starts media per item
 *                              with "Create with MARA".
 *   Assisted / Autopilot    -> allowed while the toggle is on AND the month's
 *                              estimated spend is below the budget.
 *   Explicit user request   -> ALWAYS allowed (the owner asked for that exact
 *                              item) and recorded as `user_request`, so
 *                              "Create with MARA" keeps working even when
 *                              automatic generation is disabled.
 *
 * Every blocked automatic attempt returns a truthful reason and NOTHING is
 * submitted: no provider call, no generation row, no charge. The workflow
 * keeps its plan, copy and drafts — only the media waits.
 *
 * ESTIMATED COSTS: Voom cannot read provider-reported prices today, so one
 * conservative internal model is used (below). It is deliberately centralized
 * here so replacing it with real provider costs is a single-file change.
 * Costs only ever gate and account; they never fail a generation.
 *
 * This module is pure (no `server-only`, no Supabase) so the policy is
 * executable by the Node test suite and usable on both sides of the app. The
 * database-backed reads live in `lib/mara/spend-control.ts`.
 */

/** Where a paid generation came from. Persisted on the generation row. */
export const MEDIA_SOURCES = ["user_request", "assisted", "autopilot"] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

/** Why an automatic generation was refused. */
export const MEDIA_SPEND_BLOCK_REASONS = ["automatic_media_disabled", "budget_exhausted"] as const;
export type MediaSpendBlockReason = (typeof MEDIA_SPEND_BLOCK_REASONS)[number];

/** The owner's saved AI media spending settings (defaults when unset). */
export interface MediaSpendSettings {
  /** May MARA generate paid media WITHOUT an explicit user request? */
  allowAutomaticPaidMedia: boolean;
  /** Monthly ceiling for media spend, in USD. */
  monthlyMediaBudgetUsd: number;
}

export const DEFAULT_ALLOW_AUTOMATIC_PAID_MEDIA = true;
export const DEFAULT_MONTHLY_MEDIA_BUDGET_USD = 25;

/**
 * The ONE estimated-cost model. Conservative on purpose: it must never
 * under-count spend. Replace the numbers (or read provider-reported costs)
 * here only — no cost logic belongs anywhere else.
 *
 *   image  — one generated image (Seedream class).
 *   video  — per second of generated video (Seedance class), with a floor so a
 *            very short clip cannot be estimated below a real provider charge.
 */
export const ESTIMATED_MEDIA_COST = {
  imageUsd: 0.05,
  videoUsdPerSecond: 0.1,
  videoMinimumSeconds: 4,
  /** Default video length when the caller does not supply one (OpenRouter V1). */
  videoDefaultSeconds: 6,
  imageEnvVar: "MEDIA_IMAGE_ESTIMATED_COST_USD",
  videoPerSecondEnvVar: "MEDIA_VIDEO_ESTIMATED_COST_PER_SECOND_USD",
} as const;

/**
 * The failure code `guardMediaSpend` raises when the month's accounting could
 * not be read. It is deliberately NOT a block reason: the attempt never ran, so
 * nothing was checked and nothing was charged.
 */
export const MEDIA_SPEND_UNVERIFIED_CODE = "media_spend_read_failed";

/**
 * Truthful sentence for that case. Kept beside the two block messages so every
 * screen tells the same story.
 */
export const MEDIA_SPEND_UNVERIFIED_NOTICE =
  "MARA couldn't check this month's AI media spending, so nothing was generated automatically. The plan and copy are ready — try again in a moment, or create a visual with Create with MARA.";

/** Truthful, user-facing reasons. Kept in one place so no screen invents one. */
export const MEDIA_SPEND_BLOCK_TITLES: Record<MediaSpendBlockReason, string> = {
  automatic_media_disabled: "Automatic media generation disabled",
  budget_exhausted: "Monthly AI media budget reached",
};

export const MEDIA_SPEND_BLOCK_MESSAGES: Record<MediaSpendBlockReason, string> = {
  automatic_media_disabled:
    "Automatic media generation disabled — Voom planned this content without media. Turn it on in Settings → AI Media Spending, or create each visual with Create with MARA.",
  budget_exhausted:
    "Monthly AI media budget reached — Voom planned this content without media. Raise the monthly budget in Settings → AI Media Spending, or create each visual with Create with MARA.",
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

/**
 * The estimated provider cost of ONE generation, from the centralized model.
 * Environment variables stay supported as deployment-level overrides of the
 * same numbers (`.env.example`), never as a second source of cost logic.
 */
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

/** A usable monthly budget: any finite value >= 0, otherwise the $25 default. */
export function normalizeMonthlyMediaBudgetUsd(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MONTHLY_MEDIA_BUDGET_USD;
  }
  return Math.round(parsed * 100) / 100;
}

/** A usable toggle: only an explicit `false` disables automatic spend. */
export function normalizeAllowAutomaticPaidMedia(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return DEFAULT_ALLOW_AUTOMATIC_PAID_MEDIA;
}

/** Reads the two owner settings off a `businesses` row (defaults when absent). */
export function normalizeMediaSpendSettings(
  row: { allow_automatic_paid_media?: unknown; monthly_media_budget_usd?: unknown } | null | undefined,
): MediaSpendSettings {
  return {
    allowAutomaticPaidMedia: normalizeAllowAutomaticPaidMedia(row?.allow_automatic_paid_media),
    monthlyMediaBudgetUsd: normalizeMonthlyMediaBudgetUsd(row?.monthly_media_budget_usd),
  };
}

/**
 * The recorded source of a generation.
 *
 * An explicit click is always `user_request` — that is what makes "Create with
 * MARA" auditable and always available. Everything else is the account's
 * automation mode at the moment of the run. A Manual account can never reach
 * the recorded automatic sources: the gate refuses it first.
 */
export function mediaSourceForRun(mode: "manual" | "assisted" | "autopilot", explicit: boolean): MediaSource {
  if (explicit) return "user_request";
  return mode === "autopilot" ? "autopilot" : "assisted";
}

export type MediaSpendDecision =
  | { allow: true; source: MediaSource; reason: null; message: null; estimatedCostUsd: number; budgetReached: boolean }
  | { allow: false; source: MediaSource; reason: MediaSpendBlockReason; message: string; estimatedCostUsd: number; budgetReached: boolean };

/**
 * The ONE gate.
 *
 *   Manual              -> block (`automatic_media_disabled`), regardless of
 *                          the toggle: manual means the owner starts media.
 *   toggle off          -> block (`automatic_media_disabled`).
 *   budget exhausted    -> block (`budget_exhausted`): the estimated cost of
 *                          this generation would push the month past the cap.
 *   explicit request    -> allow, recorded as `user_request`.
 *
 * `>=` vs `>`: the budget is inclusive — spending exactly the monthly budget
 * is allowed, the next paid submission is not.
 */
export function evaluateMediaSpendGate(input: {
  mode: "manual" | "assisted" | "autopilot";
  explicit: boolean;
  allowAutomaticPaidMedia: boolean;
  monthlyMediaBudgetUsd: number;
  spentThisMonthUsd: number;
  estimatedCostUsd: number;
  /** Only used to name the source; not part of the decision. */
  source?: MediaSource;
}): MediaSpendDecision {
  const source = input.source ?? mediaSourceForRun(input.mode, input.explicit);
  const estimatedCostUsd = roundUsd(Math.max(0, input.estimatedCostUsd));
  const budgetReached = input.spentThisMonthUsd + estimatedCostUsd > input.monthlyMediaBudgetUsd;

  if (input.explicit || source === "user_request") {
    // The owner asked for THIS generation. It is never blocked by the
    // automatic-spend setting; the caller records `user_request`.
    return { allow: true, source: "user_request", reason: null, message: null, estimatedCostUsd, budgetReached };
  }
  if (input.mode === "manual" || !input.allowAutomaticPaidMedia) {
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

/**
 * The truthful sentence for a run whose automatic media was blocked, or null
 * when nothing was blocked. Derived from the run's own failure codes so a
 * screen can never claim a reason the engine did not record.
 */
export function mediaSpendRunNotice(failures: { slot?: string; stage: string; code: string }[]): string | null {
  const mediaCodes = failures.filter((failure) => failure.stage === "media").map((failure) => failure.code);
  const parts = [...new Set(mediaCodes)]
    .filter((code): code is MediaSpendBlockReason => (MEDIA_SPEND_BLOCK_REASONS as readonly string[]).includes(code))
    .map((reason) => MEDIA_SPEND_BLOCK_MESSAGES[reason]);
  // Accounting Voom could not read is its own truthful sentence, never silence.
  if (mediaCodes.includes(MEDIA_SPEND_UNVERIFIED_CODE)) parts.push(MEDIA_SPEND_UNVERIFIED_NOTICE);
  return parts.length ? parts.join(" ") : null;
}

/** Compact settings copy — one sentence per rule, shared by every screen. */
export const MANUAL_NEVER_AUTO_SPENDS =
  "Manual mode never spends on media by itself: Voom plans, writes and drafts, and generates a visual only when you click Create with MARA.";
