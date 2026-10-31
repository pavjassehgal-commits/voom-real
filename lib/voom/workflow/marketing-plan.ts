import { PLAN_FORMAT_LABELS } from "./channels";
import { DEFAULT_HORIZON_DAYS, isWithinHorizon } from "@/lib/voom/cadence";
import type { RollingPlanResult } from "@/lib/voom/workflow/rolling-plan";
import type { WorkflowSnapshot } from "@/lib/voom/workflow/read";

export type PlanReplenishState =
  | "added"
  | "already_up_to_date"
  | "no_supported_social_channels_selected"
  | "failed";

export interface PlanReplenishOutcome {
  state: PlanReplenishState;
  added: number;
  horizonStart: string | null;
  horizonEnd: string | null;
  /** Server-authored labels for only the rows durably added by this run. */
  addedChannelFormats: string[];
}

/**
 * The Marketing Plan is the active planning surface, not a history screen.
 * Other workflow readers deliberately retain progressed rows outside the
 * horizon for Calendar, publishing, performance and audit continuity.
 */
export function marketingPlanSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.filter((item) => {
      const date = item.localDate || item.slotDate;
      return isWithinHorizon(snapshot.today, date, DEFAULT_HORIZON_DAYS);
    }),
  };
}

export const PLAN_UNCHANGED_MESSAGE = "Your existing plan hasn't been changed. Try again.";

/**
 * The owner-facing message for a failed Replenish. A run that saved some new
 * items before another item failed must not claim the plan is unchanged: it
 * says what was kept and that Replenish fills only the remaining dates.
 */
export function replenishFailureMessage(run: Pick<RollingPlanResult, "created"> | null): string {
  const saved = run?.created ?? 0;
  if (saved <= 0) return PLAN_UNCHANGED_MESSAGE;
  return `${saved} new recommendation${saved === 1 ? " was" : "s were"} added, but some dates couldn't be planned. Replenish again to fill only the remaining dates.`;
}

export function failedPlanReplenishOutcome(
  snapshot?: Pick<WorkflowSnapshot, "today" | "planValidUntil">,
): PlanReplenishOutcome {
  return {
    state: "failed",
    added: 0,
    horizonStart: snapshot?.today ?? null,
    horizonEnd: snapshot?.planValidUntil ?? null,
    addedChannelFormats: [],
  };
}

/**
 * Converts the durable workflow result into the public Marketing Plan
 * contract. The browser never guesses whether a run added anything.
 */
export function planReplenishOutcome(
  run: RollingPlanResult,
  snapshot: Pick<WorkflowSnapshot, "today" | "planValidUntil">,
): PlanReplenishOutcome {
  const horizonStart = run.plan?.validFrom ?? snapshot.today;
  const horizonEnd = run.plan?.validUntil ?? snapshot.planValidUntil;

  if (run.blockedReason === "no_supported_social_channels_selected") {
    return {
      state: "no_supported_social_channels_selected",
      added: 0,
      horizonStart,
      horizonEnd,
      addedChannelFormats: [],
    };
  }

  const createdItems = run.plan?.items.filter((item) => item.created) ?? [];
  // Content-stage failures mean the requested plan was only partially
  // persisted. Downstream media/approval holds do not negate a successfully
  // created recommendation and remain reported through their own notices.
  const incompletePersistence = run.failures.some((failure) => failure.stage === "content" || failure.stage === "authorization")
    || !run.plan
    || run.created !== createdItems.length
    || run.created + run.reused !== run.slots;
  if (incompletePersistence) {
    return {
      state: "failed",
      added: 0,
      horizonStart,
      horizonEnd,
      addedChannelFormats: [],
    };
  }

  if (run.created === 0) {
    return {
      state: "already_up_to_date",
      added: 0,
      horizonStart,
      horizonEnd,
      addedChannelFormats: [],
    };
  }

  const addedChannelFormats = [...new Set(createdItems.map((item) =>
    PLAN_FORMAT_LABELS[item.channel][item.format] ?? `${item.channel} ${item.format}`,
  ))];
  return {
    state: "added",
    added: run.created,
    horizonStart,
    horizonEnd,
    addedChannelFormats,
  };
}
