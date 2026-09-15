import "server-only";

import type { AdminClient } from "@/lib/post/server-data";
import {
  estimateMediaCostUsd,
  evaluateMediaSpendGate,
  mediaSourceForRun,
  normalizeMediaSpendSettings,
  type MediaSource,
  type MediaSpendBlockReason,
  type MediaSpendSettings,
} from "./media-spend";
import { normalizePlan, type PlanId } from "@/lib/billing/plans";
import { getCreditSummary } from "@/lib/billing/ledger";
import { creditCostForMedia } from "@/lib/billing/credits";

export const MEDIA_SPEND_COUNTED_STATUSES = ["queued", "generating", "processing", "completed", "failed"] as const;

export type MediaSpendGateResult =
  | { allow: true; source: MediaSource; reason: null; message: null; estimatedCostUsd: number; budgetReached: boolean; credits?: number }
  | { allow: false; source: MediaSource; reason: MediaSpendBlockReason; message: string; estimatedCostUsd: number; budgetReached: boolean; credits?: number };

export interface MediaSpendGateInput {
  ownerId: string;
  mode: "manual" | "assisted" | "autopilot";
  explicit: boolean;
  mediaType: "image" | "video";
  durationSeconds?: number | null;
  now?: Date;
}

export async function loadMediaSpendSettings(admin: AdminClient, ownerId: string): Promise<MediaSpendSettings> {
  const { data } = await admin.from("businesses")
    .select("allow_automatic_paid_media,monthly_media_budget_usd")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  return normalizeMediaSpendSettings(data as Record<string, unknown> | null);
}

export async function loadBusinessPlan(admin: AdminClient, ownerId: string): Promise<PlanId> {
  try {
    const { data } = await admin.from("businesses").select("plan").eq("owner_user_id", ownerId).maybeSingle();
    return normalizePlan((data as any)?.plan);
  } catch {
    return "free";
  }
}

export async function loadMonthlyMediaSpendUsd(admin: AdminClient, ownerId: string, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await admin.from("mara_media_generations")
    .select("estimated_cost_usd")
    .eq("owner_user_id", ownerId)
    .gte("created_at", monthStart)
    .in("status", [...MEDIA_SPEND_COUNTED_STATUSES]);
  if (error) throw new Error("media_spend_read_failed");
  const spent = (data ?? []).reduce(
    (total: number, row: { estimated_cost_usd?: unknown }) => total + Number(row.estimated_cost_usd ?? 0),
    0,
  );
  return Math.round(spent * 10_000) / 10_000;
}

/**
 * Server-side gate, now aligned with v1 Plans + Credits.
 * Explicit requests are allowed only if plan includes AI media and enough credits.
 * Automatic requests are allowed only for Autopilot + Max + toggle true + enough credits.
 */
export async function guardMediaSpend(admin: AdminClient, input: MediaSpendGateInput): Promise<MediaSpendGateResult> {
  const source = mediaSourceForRun(input.mode, input.explicit);
  const estimatedCostUsd = estimateMediaCostUsd({ mediaType: input.mediaType, durationSeconds: input.durationSeconds ?? null });
  const credits = creditCostForMedia({ mediaType: input.mediaType, durationSeconds: input.durationSeconds });

  if (source === "user_request") {
    // For explicit, still check plan and credits via new ledger (but don't reserve here — caller reserves)
    const planId = await loadBusinessPlan(admin, input.ownerId);
    const summary = await getCreditSummary(admin, input.ownerId, planId, input.now ?? new Date());
    // Free plan cannot generate
    if (planId === "free") {
      return {
        allow: false,
        source: "user_request",
        reason: "plan_not_allowed" as any,
        message: `Your Free plan does not include AI media generation. Upgrade to Pro or Max.`,
        estimatedCostUsd,
        budgetReached: false,
        credits,
      };
    }
    if (summary.remaining < credits) {
      return {
        allow: false,
        source: "user_request",
        reason: "insufficient_credits" as any,
        message: `You need ${credits} credits. You have ${summary.remaining} remaining.`,
        estimatedCostUsd,
        budgetReached: false,
        credits,
      };
    }
    return {
      allow: true,
      source: "user_request",
      reason: null,
      message: null,
      estimatedCostUsd,
      budgetReached: false,
      credits,
    };
  }

  // Automatic path: v1 only Autopilot may auto-generate
  if (input.mode !== "autopilot") {
    return {
      allow: false,
      source,
      reason: "automatic_media_disabled",
      message: "Automatic media generation is available in Autopilot only. Create each visual with Create with MARA.",
      estimatedCostUsd,
      budgetReached: false,
      credits,
    };
  }

  const now = input.now ?? new Date();
  const [settings, spentThisMonthUsd, planId] = await Promise.all([
    loadMediaSpendSettings(admin, input.ownerId),
    loadMonthlyMediaSpendUsd(admin, input.ownerId, now),
    loadBusinessPlan(admin, input.ownerId),
  ]);

  // Plan must be Max for automatic
  if (planId !== "max") {
    return {
      allow: false,
      source,
      reason: "plan_not_allowed" as any,
      message: `Automatic media generation is available on Max plan only.`,
      estimatedCostUsd,
      budgetReached: false,
      credits,
    };
  }

  const summary = await getCreditSummary(admin, input.ownerId, planId, now);
  if (summary.remaining < credits) {
    return {
      allow: false,
      source,
      reason: "insufficient_credits" as any,
      message: `You need ${credits} credits. You have ${summary.remaining} remaining.`,
      estimatedCostUsd,
      budgetReached: false,
      credits,
    };
  }

  return evaluateMediaSpendGate({
    mode: input.mode,
    explicit: false,
    allowAutomaticPaidMedia: settings.allowAutomaticPaidMedia,
    monthlyMediaBudgetUsd: settings.monthlyMediaBudgetUsd,
    spentThisMonthUsd,
    estimatedCostUsd,
    source,
  }) as MediaSpendGateResult;
}
