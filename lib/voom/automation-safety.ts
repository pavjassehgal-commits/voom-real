import { canUseAutomationMode, normalizePlan } from "@/lib/billing/plans";
import type { AdminClient } from "@/lib/post/server-data";
import { normalizeAutomationMode, type AutomationModeValue } from "./automation";

export type AutonomousBlockReason = "automation_paused" | "mode_changed" | "subscription_restricted";

export async function assertAutonomousWorkAllowed(
  admin: AdminClient,
  ownerId: string,
  requiredMode: AutomationModeValue = "autopilot",
): Promise<void> {
  const { data, error } = await admin.from("businesses")
    .select("automation_level,automation_paused_at,plan")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  if (error || !data) throw new Error("automation_state_unavailable");
  if (data.automation_paused_at) throw new Error("automation_paused");
  const mode = normalizeAutomationMode(data.automation_level);
  if (mode !== requiredMode) throw new Error("automation_mode_changed");
  if (!canUseAutomationMode(normalizePlan(data.plan), mode)) throw new Error("automation_subscription_restricted");
}

export interface PauseAutomationResult {
  alreadyPaused: boolean;
  socialJobsStopped: { instagram: number; youtube: number; tiktok: number };
  lifecycleFlowsPaused: number;
  untouched: { claimedOrSubmitted: number; published: number };
}

export async function pauseAllAutomation(
  admin: AdminClient,
  ownerId: string,
  idempotencyKey: string,
): Promise<PauseAutomationResult> {
  const { data, error } = await admin.rpc("pause_all_automation", {
    p_owner_user_id: ownerId,
    p_idempotency_key: idempotencyKey,
  });
  if (error || !data) throw new Error("automation_pause_failed");
  return data as PauseAutomationResult;
}

export interface ResumeAutomationResult {
  wasPaused: boolean;
  pausedSince: string | null;
  automationMode: AutomationModeValue;
  /** False when the saved plan no longer includes the saved mode: autonomous work stays blocked. */
  modeAllowedByPlan: boolean;
  notRestored: { cancelledAutopilotJobs: number; pausedLifecycleFlows: number };
}

/**
 * Lifts an emergency pause. Only ever called from the owner's explicit
 * request (app/api/automation/resume); MARA, workers and coordinators never
 * resume automation. Cancelled Autopilot jobs and paused lifecycle flows are
 * NOT restored, and mode/plan entitlement is still enforced at every
 * autonomous boundary by assertAutonomousWorkAllowed.
 */
export async function resumeAllAutomation(
  admin: AdminClient,
  ownerId: string,
  idempotencyKey: string,
): Promise<ResumeAutomationResult> {
  const { data, error } = await admin.rpc("resume_all_automation", {
    p_owner_user_id: ownerId,
    p_idempotency_key: idempotencyKey,
  });
  if (error || !data) throw new Error("automation_resume_failed");
  const raw = data as {
    wasPaused?: boolean;
    pausedSince?: string | null;
    automationMode?: string | null;
    plan?: string | null;
    notRestored?: { cancelledAutopilotJobs?: number; pausedLifecycleFlows?: number };
  };
  const automationMode = normalizeAutomationMode(raw.automationMode);
  return {
    wasPaused: Boolean(raw.wasPaused),
    pausedSince: raw.pausedSince ?? null,
    automationMode,
    modeAllowedByPlan: canUseAutomationMode(normalizePlan(raw.plan), automationMode),
    notRestored: {
      cancelledAutopilotJobs: Number(raw.notRestored?.cancelledAutopilotJobs ?? 0),
      pausedLifecycleFlows: Number(raw.notRestored?.pausedLifecycleFlows ?? 0),
    },
  };
}
