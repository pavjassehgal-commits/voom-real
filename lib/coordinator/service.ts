import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMarketingState } from "./state";
import { evaluateMarketingNeeds } from "./engine";
import { runOwnerWorkflow } from "@/lib/voom/workflow/service";
import { parseActionChannel } from "@/lib/social/channels";
import { proposeEmailFlow } from "@/lib/email-flows/create";
import type { AdminClient } from "@/lib/post/server-data";
import type { PerformanceReport } from "@/lib/performance/insights";
import type { CoordinatorRunResult } from "./types";

export interface CoordinatorRunOptions {
  now?: Date;
  trigger?: "scheduled" | "replenish" | "manual" | "ui_read";
  forceReplenish?: boolean;
  /**
   * Optional already-loaded performance report for this owner (or its
   * in-flight promise). When present the coordinator's marketing state derives
   * from it instead of reading the owner's performance data again — identical
   * derived state, one read per request. Omitted, it is read exactly as before.
   */
  performanceReport?: PerformanceReport | Promise<PerformanceReport>;
}

/**
 * Executes the Automation Coordinator for an owner.
 *
 * Flow:
 * 1. Build authoritative marketing state (owner & business scoped, bounded window)
 * 2. Deterministically evaluate marketing needs & gaps
 * 3. Enforce automation mode constraints:
 *    - Manual: ZERO autonomous creations, zero executions, zero spending
 *    - Assisted: prepares gaps via planning workflow (ZERO media spending, zero auto-approval)
 *    - Autopilot: prepares gaps; respects existing plans/credits/safety gates
 * 4. Ensures ZERO media credit spend in coordinator execution itself
 * 5. Records durable coordinator run for idempotency and auditability
 */
export async function runCoordinatorForOwner(
  admin: SupabaseClient,
  ownerId: string,
  businessId?: string,
  options: CoordinatorRunOptions = {},
): Promise<CoordinatorRunResult> {
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? "scheduled";

  // Build the Authoritative Marketing State
  const state = await buildMarketingState(admin, ownerId, businessId, now, {
    performanceReport: options.performanceReport,
  });

  // Evaluate Needs
  const evaluation = evaluateMarketingNeeds(state);

  const actionsTaken: { type: string; details: Record<string, unknown> }[] = [];

  // Generate durable idempotency key for this run:
  // owner + trigger + today date + gaps fingerprint
  const gapsFingerprint = evaluation.gaps.map((g) => `${g.date}:${g.recommendedFormat}`).join("|");
  const idempotencyKey = createHash("sha256")
    .update(`coord:${ownerId}:${trigger}:${state.todayLocalDate}:${gapsFingerprint}`)
    .digest("hex")
    .slice(0, 48);

  // Check if we should execute workflow filling for gaps:
  // If Manual, NEVER autonomously generate content or run workflow.
  // If ui_read, NEVER run mutation workflows.
  const shouldExecuteGapFilling =
    trigger !== "ui_read" &&
    state.mode !== "manual" &&
    evaluation.gaps.length > 0;

  if (shouldExecuteGapFilling) {
    try {
      // The coordinator supplies the actual uncovered dates, not just a count.
      // Existing social commitments participate in channel balance, while
      // email remains outside the social cadence.
      const channelCoverage = state.commitments.flatMap((commitment) => {
        const parsed = parseActionChannel(commitment.channel);
        return parsed && parsed.channel !== "email"
          ? [{ date: commitment.localDate, channel: parsed.channel, format: parsed.format }]
          : [];
      });
      const workflowResult = await runOwnerWorkflow(admin as AdminClient, {
        ownerId,
        now,
        trigger: trigger === "replenish" ? "replenish" : "scheduled",
        targetDates: evaluation.gaps.map((gap) => gap.date),
        channelCoverage,
      });

      const requestedGapDates = evaluation.gaps.map((gap) => gap.date);
      const requestedGapSet = new Set(requestedGapDates);
      // A requested slot counts as filled only when the workflow actually
      // returned a persisted/reused plan item for that local date. `slots` is
      // an attempted count and `created` omits reused items; neither alone is
      // an honest completion measure.
      const filledGapDates = new Set((workflowResult.plan?.items ?? [])
        .filter((item) => requestedGapSet.has(item.slot))
        .map((item) => item.slot));
      const gapsFilled = workflowResult.blockedReason ? 0 : filledGapDates.size;
      const gapsRemaining = Math.max(0, requestedGapDates.length - gapsFilled);
      const actionType = workflowResult.blockedReason
        ? "gap_filling_blocked"
        : gapsRemaining > 0 ? "gap_filling_partial" : "fill_calendar_gaps";

      actionsTaken.push({
        type: actionType,
        details: {
          gapsRequested: requestedGapDates.length,
          gapsFilled,
          gapsRemaining,
          ...(workflowResult.blockedReason ? { blockedReason: workflowResult.blockedReason } : {}),
          slotsAttempted: workflowResult.slots,
          created: workflowResult.created,
          reused: workflowResult.reused,
          awaitingApproval: workflowResult.awaitingApproval,
          autoApproved: workflowResult.autoApproved,
          failures: workflowResult.failures.filter((failure) => requestedGapSet.has(failure.slot)),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      actionsTaken.push({
        type: "gap_filling_failed",
        details: {
          error: msg,
          gapsRequested: evaluation.gaps.length,
          gapsFilled: 0,
          gapsRemaining: evaluation.gaps.length,
        },
      });
    }
  }

  // Lifecycle email flows (Email Automation v2).
  //
  // The Coordinator may PREPARE a flow — that is Assisted/Autopilot preparing
  // marketing — but it never activates one. No existing Voom policy authorises
  // automatic activation of a lifecycle flow that sends email, so Autopilot
  // fails closed here too and leaves the flow proposed for the owner.
  //
  // Duplication is impossible three times over: the opportunity list already
  // excludes flow types that exist, `proposeEmailFlow` uses a key derived from
  // (owner, flow type), and the database refuses a second live proposal of the
  // same type. So `cron → email opportunity → new flow every day` cannot happen.
  const shouldProposeFlows =
    trigger !== "ui_read" &&
    state.mode !== "manual" &&
    evaluation.state.emailState.flowOpportunities.length > 0;

  if (shouldProposeFlows) {
    for (const opportunity of evaluation.state.emailState.flowOpportunities) {
      try {
        const outcome = await proposeEmailFlow(admin, {
          ownerId,
          flowType: opportunity.flowType,
          mode: state.mode,
          now,
        });
        actionsTaken.push({
          type: `email_flow_${outcome.outcome}`,
          details: {
            flowType: opportunity.flowType,
            // A proposal is always a draft: nothing can enroll or send yet.
            activated: false,
            ...(outcome.outcome === "proposed"
              ? {
                  flowId: outcome.result.flow.id,
                  steps: outcome.result.stepCount,
                  generationSource: outcome.result.generationSource,
                }
              : {}),
            ...("reason" in outcome ? { reason: outcome.reason } : {}),
          },
        });
      } catch (err) {
        actionsTaken.push({
          type: "email_flow_proposal_failed",
          details: {
            flowType: opportunity.flowType,
            error: err instanceof Error ? err.message : "unknown_error",
          },
        });
      }
    }
  }

  // Persist run in voom_coordinator_runs if not just a UI read
  if (trigger !== "ui_read") {
    try {
      await admin.from("voom_coordinator_runs").insert({
        owner_user_id: ownerId,
        business_id: state.businessId,
        idempotency_key: idempotencyKey,
        trigger,
        automation_mode: state.mode,
        horizon_start: state.horizonStart,
        horizon_end: state.horizonEnd,
        needs: evaluation.needs,
        actions_taken: actionsTaken,
      });
    } catch {
      // In case of duplicate idempotency key on conflict or table missing in unit tests without migration
    }
  }

  return {
    evaluation,
    actionsTaken,
    idempotencyKey,
  };
}

/**
 * Fleet-wide Automation Coordinator Runner (for cron / scheduled execution).
 * Replaces the blind "weekly-plans" loop with intelligent, gap-aware coordination.
 */
export async function runFleetCoordinator(
  admin: SupabaseClient,
  now = new Date(),
  ownerIds?: string[],
) {
  let query = admin.from("businesses")
    .select("id,owner_user_id,automation_level")
    .eq("onboarding_completed", true)
    .in("automation_level", ["assisted", "autopilot"]);

  if (ownerIds && ownerIds.length > 0) {
    query = query.in("owner_user_id", ownerIds);
  }

  const { data: businesses, error } = await query;
  if (error) {
    throw new Error("failed_fetching_businesses_for_coordinator");
  }

  const summary = {
    evaluated: businesses?.length ?? 0,
    gapsDetected: 0,
    actionsTriggered: 0,
    failures: 0,
  };

  for (const b of businesses ?? []) {
    try {
      const res = await runCoordinatorForOwner(admin, String(b.owner_user_id), String(b.id), {
        now,
        trigger: "scheduled",
      });
      summary.gapsDetected += res.evaluation.gaps.length;
      summary.actionsTriggered += res.actionsTaken.length;
    } catch {
      summary.failures += 1;
    }
  }

  return summary;
}
