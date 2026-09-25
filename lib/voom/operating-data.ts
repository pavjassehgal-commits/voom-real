import "server-only";
import { cache } from "react";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  filterApprovalActionsForCurrentWorkflow,
  loadWorkflowSnapshot,
  todaySummary,
} from "@/lib/voom/workflow/read";
import { runCoordinatorForOwner } from "@/lib/coordinator/service";
import type { CoordinatorEvaluation } from "@/lib/coordinator/types";
import { loadPerformanceReport } from "@/lib/performance/data";
import type { PerformanceReport } from "@/lib/performance/insights";
import { getCurrentUser, getBusinessRecord } from "./server-data";

/**
 * Server-side read for every operating screen.
 *
 * Today, Approvals, Marketing Plan and Content Calendar all read the SAME
 * workflow snapshot, so they can never disagree about what exists, what its
 * status is, or which local date it is on. Read-only: no screen mutates state.
 *
 * Request-scoped: `cache()` deduplicates this exact read within one request's
 * render (layouts + pages + repeated consumers share ONE computation and one
 * set of reads). The cache lives only for the current request — it can never
 * serve another user or business, and every navigation re-reads fresh state.
 *
 * The heavy reads run as one concurrent wave — the workflow snapshot, the
 * coordinator's evaluation and the approvals feed are independent, and the
 * owner's performance report is read once and SHARED with the coordinator
 * (identical data it always derived from) and with the Today screen.
 */
export const getOperatingData = cache(async () => {
  const [user, business] = await Promise.all([getCurrentUser(), getBusinessRecord()]);
  if (!user || !business) return null;
  const db = await createClient();
  const admin = createAdminClient();

  // One owner-scoped performance read per request. `performance` is returned
  // as the in-flight promise so the Today screen awaits the SAME read (its
  // failure behaves exactly as it did when the page loaded the report itself),
  // while the coordinator consumes it under its own graceful-degradation guard.
  const performancePromise = loadPerformanceReport(db, user.id);

  const [snapshot, coordinator, actionsRead] = await Promise.all([
    loadWorkflowSnapshot(admin, user.id, { business }),
    (async () => {
      try {
        const res = await runCoordinatorForOwner(admin, user.id, business.id, {
          trigger: "ui_read",
          performanceReport: performancePromise,
        });
        return res.evaluation;
      } catch {
        // Graceful degradation
        return null;
      }
    })(),
    db.from("mara_pending_actions")
      .select("id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at")
      .eq("owner_user_id", user.id).order("created_at", { ascending: false }).limit(50),
  ]);

  const summary = todaySummary(snapshot);
  const coordinatorEvaluation: CoordinatorEvaluation | null = coordinator;

  // The Approvals feed follows the same active-horizon rule as the snapshot:
  // rolling-plan cards for stale legacy/out-of-horizon drafts never surface as
  // current approval needs. All other cards pass through untouched.
  const actionRows = filterApprovalActionsForCurrentWorkflow(actionsRead.data ?? [], snapshot);
  const reelTaskCount = actionRows.filter((action) => action.tool_name === "choose_reel_production" && action.status === "pending"
    && !["ready_for_mara_production", "produced"].includes(String(action.new_value?.productionStatus ?? ""))).length;

  return {
    user,
    business,
    snapshot,
    summary,
    coordinator: coordinatorEvaluation,
    // Approvals only ever counts items that genuinely still need a decision.
    pendingApprovalCount: summary.needsApproval.length,
    reelTaskCount,
    actions: actionRows,
    /**
     * The owner's performance report (same read the coordinator derived from).
     * Awaited only by screens that display it; on load failure awaiting it
     * rejects exactly as their own load did before.
     */
    performance: performancePromise as Promise<PerformanceReport>,
  };
});
