import "server-only";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  filterApprovalActionsForCurrentWorkflow,
  loadWorkflowSnapshot,
  todaySummary,
  type WorkflowSnapshot,
} from "@/lib/voom/workflow/read";
import { runCoordinatorForOwner } from "@/lib/coordinator/service";
import type { CoordinatorEvaluation } from "@/lib/coordinator/types";
import { getCurrentUser, getBusinessRecord } from "./server-data";

/**
 * Server-side read for every operating screen.
 *
 * Today, Approvals, Marketing Plan and Content Calendar all read the SAME
 * workflow snapshot, so they can never disagree about what exists, what its
 * status is, or which local date it is on. Read-only: no screen mutates state.
 */
export async function getOperatingData() {
  const [user, business] = await Promise.all([getCurrentUser(), getBusinessRecord()]);
  if (!user || !business) return null;
  const db = await createClient();
  const admin = createAdminClient();
  const snapshot: WorkflowSnapshot = await loadWorkflowSnapshot(admin, user.id);
  const summary = todaySummary(snapshot);

  let coordinator: CoordinatorEvaluation | null = null;
  try {
    const res = await runCoordinatorForOwner(admin, user.id, business.id, { trigger: "ui_read" });
    coordinator = res.evaluation;
  } catch {
    // Graceful degradation
  }

  const { data: actions } = await db.from("mara_pending_actions")
    .select("id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at")
    .eq("owner_user_id", user.id).order("created_at", { ascending: false }).limit(50);
  // The Approvals feed follows the same active-horizon rule as the snapshot:
  // rolling-plan cards for stale legacy/out-of-horizon drafts never surface as
  // current approval needs. All other cards pass through untouched.
  const actionRows = filterApprovalActionsForCurrentWorkflow(actions ?? [], snapshot);
  const reelTaskCount = actionRows.filter((action) => action.tool_name === "choose_reel_production" && action.status === "pending"
    && !["ready_for_mara_production", "produced"].includes(String(action.new_value?.productionStatus ?? ""))).length;

  return {
    user,
    business,
    snapshot,
    summary,
    coordinator,
    // Approvals only ever counts items that genuinely still need a decision.
    pendingApprovalCount: summary.needsApproval.length,
    reelTaskCount,
    actions: actionRows,
  };
}
