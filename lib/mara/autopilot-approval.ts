import "server-only";

import type { ServerSupabase } from "@/lib/mara/internal-data";
import { getDraft } from "@/lib/mara/internal-data";
import { evaluateAutopilotRecommendation } from "@/lib/mara/autopilot-safety";
import { executeConfirmedAction } from "@/lib/mara/tools";

export async function autoApproveSafePlanRecommendations(db: ServerSupabase, ownerId: string, planId: string, now = new Date()) {
  const { data: drafts, error: draftError } = await db.from("mara_drafts")
    .select("id").eq("owner_user_id", ownerId).eq("source_plan_id", planId);
  if (draftError) throw new Error("autopilot_drafts_unavailable");
  const draftIds = (drafts ?? []).map((draft) => draft.id);
  if (!draftIds.length) return { approved: 0, pending: 0 };

  const { data: actions, error: actionError } = await db.from("mara_pending_actions")
    .select("id,conversation_id,tool_name,sanitized_arguments,status")
    .eq("owner_user_id", ownerId).eq("tool_name", "propose_calendar_item")
    .in("status", ["pending", "failed"]);
  if (actionError) throw new Error("autopilot_actions_unavailable");
  const planActions = (actions ?? []).filter((action) => draftIds.includes(action.sanitized_arguments?.sourceDraftId));
  let approved = 0;
  let pending = 0;

  for (const action of planActions) {
    const args = action.sanitized_arguments as Record<string, unknown>;
    const draft = await getDraft(db, ownerId, args.sourceDraftId as string);
    if (!draft) { pending += 1; continue; }
    const safety = evaluateAutopilotRecommendation({
      title: String(args.title ?? draft.title), content: draft.content,
      topic: typeof args.topic === "string" ? args.topic : undefined,
      reason: typeof args.reason === "string" ? args.reason : undefined,
      publishAt: draft.proposed_publish_at ?? "",
    }, now);
    if (!safety.safe) { pending += 1; continue; }

    const evaluatedAt = new Date().toISOString();
    const audit = { automatic: true, mode: "autopilot", deterministicSafetyChecks: "passed", checks: safety.checks, sourceDraftId: draft.id, evaluatedAt };
    const { data: claimed, error: claimError } = await db.from("mara_pending_actions")
      .update({ status: "executing", error_summary: null, sanitized_arguments: { ...args, autopilotApproval: audit } })
      .eq("id", action.id).eq("owner_user_id", ownerId).in("status", ["pending", "failed"])
      .select("id,conversation_id,tool_name,sanitized_arguments,status").maybeSingle();
    if (claimError) throw new Error("autopilot_claim_failed");
    if (!claimed) continue;

    try {
      const result = await executeConfirmedAction({ db, ownerId, conversationId: claimed.conversation_id }, claimed);
      const calendarItemId = result.result && typeof result.result === "object" && "id" in result.result ? String(result.result.id) : null;
      const summary = `Auto-approved by Autopilot after deterministic safety checks. ${result.summary}`.slice(0, 1000);
      await Promise.all([
        db.from("mara_pending_actions").update({ result_summary: summary }).eq("id", action.id).eq("owner_user_id", ownerId).eq("status", "confirmed"),
        db.from("mara_tool_runs").update({ status: "succeeded", result_summary: summary, sanitized_arguments: { ...args, autopilotApproval: { ...audit, resultingCalendarItemId: calendarItemId, approvedAt: new Date().toISOString() } }, completed_at: new Date().toISOString() }).eq("pending_action_id", action.id).eq("owner_user_id", ownerId),
      ]);
      approved += 1;
    } catch {
      await Promise.all([
        db.from("mara_pending_actions").update({ status: "failed", error_summary: "Autopilot approval failed safely. Nothing was published.", executed_at: new Date().toISOString() }).eq("id", action.id).eq("owner_user_id", ownerId).eq("status", "executing"),
        db.from("mara_tool_runs").update({ status: "failed", error_summary: "Autopilot approval failed safely.", completed_at: new Date().toISOString() }).eq("pending_action_id", action.id).eq("owner_user_id", ownerId),
      ]);
      pending += 1;
    }
  }
  return { approved, pending };
}
