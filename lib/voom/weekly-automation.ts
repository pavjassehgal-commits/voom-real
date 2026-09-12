import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";
import { runOwnerWorkflow } from "@/lib/voom/workflow/service";
import type { AdminClient } from "@/lib/post/server-data";

/**
 * The scheduled rolling-plan automation.
 *
 * Replaces the legacy "generate exactly 3 Instagram recommendations once per
 * week" rule. On every run (daily cron is enough) each automated account has
 * its rolling horizon topped up to the number of items its selected posting
 * cadence requires, starting on that account's real current local date.
 *
 * Idempotent by construction: a workflow item is keyed by (plan, local slot
 * date), so a second run on the same day reuses every existing item and
 * creates nothing. Manual accounts are never touched.
 */

const AUTOMATED_MODES = ["assisted", "autopilot"];

export interface RollingAutomationResult {
  checked: number;
  created: number;
  reused: number;
  autoApproved: number;
  awaitingApproval: number;
  failed: number;
}

export async function runRollingPlanAutomation(
  now = new Date(),
  db: SupabaseClient = createAdminClient(),
  ownerIds?: string[],
): Promise<RollingAutomationResult> {
  let query = db.from("businesses").select("owner_user_id,automation_level")
    .eq("onboarding_completed", true).in("automation_level", AUTOMATED_MODES);
  if (ownerIds) query = query.in("owner_user_id", ownerIds);
  const { data: businesses, error } = await query;
  if (error) throw new Error("automation_businesses_unavailable");

  const result: RollingAutomationResult = { checked: businesses?.length ?? 0, created: 0, reused: 0, autoApproved: 0, awaitingApproval: 0, failed: 0 };
  for (const business of businesses ?? []) {
    try {
      const run = await runOwnerWorkflow(db as AdminClient, { ownerId: String(business.owner_user_id), now });
      result.created += run.created;
      result.reused += run.reused;
      result.autoApproved += run.autoApproved;
      result.awaitingApproval += run.awaitingApproval;
      if (run.failures.length) result.failed += 1;
    } catch {
      // One broken account never stops the rest of the fleet.
      result.failed += 1;
    }
  }
  return result;
}

/** Back-compatible name for the existing cron entry point. */
export const runWeeklyPlanAutomation = runRollingPlanAutomation;
