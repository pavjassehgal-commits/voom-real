/**
 * Entitlement Guard — hard provider-spend protection.
 *
 * This is the ONE gate that decides whether Voom may submit a paid media generation.
 * UI-only protection is insufficient — every provider submission path must call this.
 *
 * Rules (authoritative from product spec):
 *
 * Manual:
 *   - User controls execution.
 *   - Allowed: explicit plan generation, campaign generation, text/copy drafting, upload own assets, explicitly click Create with MARA
 *   - NOT allowed automatically: paid image, paid video, Instagram publishing, email sending, approvals, paid-media retries/new jobs
 *
 * Assisted:
 *   - MARA prepares everything; user approves execution.
 *   - Allowed automatically: planning, recommendations, captions, email drafts, campaign structure, proposed schedules
 *   - NOT allowed automatically: Seedream submission, Seedance submission, any paid media generation, Instagram publishing, email sending
 *   - Paid media must require explicit user generation action.
 *
 * Autopilot:
 *   - MARA can run marketing end-to-end within hard limits.
 *   - May: plan, draft, schedule, internally approve safe actions, publish/send per existing safety rules, automatically generate paid media
 *   - BUT automatic paid media allowed ONLY if ALL true:
 *     1. account plan supports Autopilot
 *     2. account plan supports automatic paid media
 *     3. allow_automatic_paid_media = true
 *     4. enough Voom credits are available
 *     5. generation fits within account credit limits
 *     6. existing safety rules allow the content
 *
 * Missing any condition = do not call provider. Planning must continue even when media is blocked.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlanConfig, type PlanId, canUseAutomationMode, canGenerateExplicitMedia, canGenerateAutomaticMedia } from "./plans";
import { creditCostForMedia, type CreditMediaType } from "./credits";
import { reserveCredits, refundCredits, settleCredits, getCreditSummary } from "./ledger";

export type AutomationModeValue = "manual" | "assisted" | "autopilot";
export type GenerationSource = "user_request" | "autopilot";

export interface GuardContext {
  ownerId: string;
  planId: PlanId;
  mode: AutomationModeValue;
  allowAutomaticPaidMedia: boolean;
  mediaType: CreditMediaType;
  durationSeconds?: number | null;
  source: GenerationSource;
  /** For autopilot safety — caller passes whether existing safety rules allow content. Defaults to true. */
  safetyAllowed?: boolean;
  now?: Date;
}

export type GuardResult =
  | { allow: true; credits: number; reservation: { generationId: string; remaining: number; allowance: number; used: number; already?: boolean } }
  | { allow: false; reason: string; code: "plan_not_allowed" | "mode_not_allowed" | "automatic_disabled" | "insufficient_credits" | "safety_blocked" | "autopilot_not_allowed"; credits: number; message: string };

/**
 * Central guard — must be called BEFORE any Seedream/Seedance submission.
 * It:
 * 1. calculates required credits
 * 2. verifies plan entitlement
 * 3. verifies mode permission
 * 4. verifies toggle for automatic
 * 5. verifies safety
 * 6. verifies and reserves credits atomically
 *
 * If any check fails, returns allow:false and NO provider call should happen.
 * If reservation succeeds, caller may submit provider job, then settle. On failure before paid job, refund.
 */
export async function guardAndReserveMedia(
  admin: SupabaseClient,
  input: GuardContext & { generationId: string },
): Promise<GuardResult> {
  const now = input.now ?? new Date();
  const credits = creditCostForMedia({ mediaType: input.mediaType, durationSeconds: input.durationSeconds });
  const planConfig = getPlanConfig(input.planId);

  // 1. Plan supports Autopilot? (for automatic path)
  if (input.source === "autopilot") {
    // Must be Max plan
    if (!planConfig.allowsAutopilot) {
      return {
        allow: false,
        reason: "autopilot_not_allowed",
        code: "autopilot_not_allowed",
        credits,
        message: `Autopilot is available on Max plan only. Your plan is ${planConfig.name}.`,
      };
    }
    // Plan must support automatic paid media
    if (!canGenerateAutomaticMedia(input.planId)) {
      return {
        allow: false,
        reason: "plan does not support automatic paid media",
        code: "plan_not_allowed",
        credits,
        message: `Automatic media generation is not included in your ${planConfig.name} plan.`,
      };
    }
    // Mode must be autopilot (not manual/assisted for auto path)
    if (input.mode !== "autopilot") {
      return {
        allow: false,
        reason: "mode not autopilot",
        code: "mode_not_allowed",
        credits,
        message: `Automatic media generation requires Autopilot mode.`,
      };
    }
    // Toggle must be true
    if (!input.allowAutomaticPaidMedia) {
      return {
        allow: false,
        reason: "automatic toggle disabled",
        code: "automatic_disabled",
        credits,
        message: `Automatic media generation is disabled. Turn it on in Settings → AI Media Spending, or create each visual with Create with MARA.`,
      };
    }
    // Safety
    if (input.safetyAllowed === false) {
      return {
        allow: false,
        reason: "safety blocked",
        code: "safety_blocked",
        credits,
        message: `That content was held for review and no media was generated automatically.`,
      };
    }
  } else {
    // Explicit user request path
    if (!canGenerateExplicitMedia(input.planId)) {
      return {
        allow: false,
        reason: "plan does not allow explicit media",
        code: "plan_not_allowed",
        credits,
        message: `Your ${planConfig.name} plan does not include AI image/video generation. Upgrade to Pro or Max to generate with MARA.`,
      };
    }
    // Mode check: free can only use manual, but explicit generation is still blocked by plan above
    // Pro can use manual+assisted, Max can use all — explicit is allowed in any allowed mode
    if (!canUseAutomationMode(input.planId, input.mode)) {
      return {
        allow: false,
        reason: "mode not allowed for plan",
        code: "mode_not_allowed",
        credits,
        message: `Your ${planConfig.name} plan does not support ${input.mode} mode.`,
      };
    }
  }

  // 4 & 5: Check credits and reserve atomically
  const reserve = await reserveCredits(admin, {
    ownerId: input.ownerId,
    generationId: input.generationId,
    mediaType: input.mediaType,
    credits,
    source: input.source,
    planId: input.planId,
    now,
  });

  if (!reserve.ok) {
    if (reserve.reason === "insufficient_credits") {
      return {
        allow: false,
        reason: "insufficient credits",
        code: "insufficient_credits",
        credits,
        message: `You need ${credits} credits. You have ${reserve.remaining} remaining.`,
      };
    }
    return {
      allow: false,
      reason: reserve.reason,
      code: reserve.reason === "plan_not_allowed" ? "plan_not_allowed" : "insufficient_credits",
      credits,
      message: reserve.message,
    };
  }

  return {
    allow: true,
    credits,
    reservation: {
      generationId: input.generationId,
      remaining: reserve.remaining,
      allowance: reserve.allowance,
      used: reserve.used,
      already: reserve.already,
    },
  };
}

export async function releaseReservationOnFailure(admin: SupabaseClient, ownerId: string, generationId: string) {
  return refundCredits(admin, ownerId, generationId);
}

export async function confirmReservation(admin: SupabaseClient, ownerId: string, generationId: string) {
  return settleCredits(admin, ownerId, generationId);
}

/** Helper for UI to show cost before generation */
export function getCreditCostForUI(mediaType: CreditMediaType, durationSeconds?: number | null): number {
  return creditCostForMedia({ mediaType, durationSeconds });
}

/** For workflow: check if automatic media is allowed for mode (pure, no DB). */
export function mayAutomaticallyGeneratePaidMediaV2(mode: AutomationModeValue): boolean {
  // Only autopilot may automatically generate paid media (new product rule)
  return mode === "autopilot";
}
