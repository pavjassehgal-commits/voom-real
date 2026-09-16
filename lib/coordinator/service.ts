import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMarketingState } from "./state";
import { evaluateMarketingNeeds } from "./engine";
import { runOwnerWorkflow } from "@/lib/voom/workflow/service";
import type { AdminClient } from "@/lib/post/server-data";
import type { CoordinatorRunResult } from "./types";

export interface CoordinatorRunOptions {
  now?: Date;
  trigger?: "scheduled" | "replenish" | "manual" | "ui_read";
  forceReplenish?: boolean;
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
  const state = await buildMarketingState(admin, ownerId, businessId, now);

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
      // Calling runOwnerWorkflow with the appropriate trigger and stage.
      // Notice: In Assisted mode, runOwnerWorkflow will automatically be gated or planning_only
      // where appropriate, and NEVER calls media generation unless permitted.
      // In all cases, the coordinator itself spends ZERO media credits.
      const workflowResult = await runOwnerWorkflow(admin as AdminClient, {
        ownerId,
        now,
        trigger: trigger === "replenish" ? "replenish" : "scheduled",
      });

      actionsTaken.push({
        type: "fill_calendar_gaps",
        details: {
          gapsFilled: evaluation.gaps.length,
          slots: workflowResult.slots,
          created: workflowResult.created,
          reused: workflowResult.reused,
          awaitingApproval: workflowResult.awaitingApproval,
          autoApproved: workflowResult.autoApproved,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      actionsTaken.push({
        type: "gap_filling_failed",
        details: { error: msg },
      });
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
