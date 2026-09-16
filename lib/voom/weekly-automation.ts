import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";
import { runFleetCoordinator } from "@/lib/coordinator/service";

/**
 * The scheduled rolling-plan automation, now powered by the central
 * Automation Coordinator v1.
 *
 * Replaces the legacy "generate exactly 3 Instagram recommendations once per
 * week" rule with intelligent gap identification and marketing coordination.
 * On every run each automated account is evaluated for existing campaign
 * actions, approved calendar items, and pending approvals before any missing
 * work is prepared.
 *
 * Idempotent by construction: runs are keyed by durable idempotency keys and
 * slots are deduplicated on (plan, local slot date).
 * Manual accounts are never touched.
 */

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
  const fleetSummary = await runFleetCoordinator(db, now, ownerIds);

  return {
    checked: fleetSummary.evaluated,
    created: fleetSummary.actionsTriggered,
    reused: fleetSummary.evaluated - fleetSummary.failures,
    autoApproved: 0,
    awaitingApproval: 0,
    failed: fleetSummary.failures,
  };
}

/** Back-compatible name for the existing cron entry point. */
export const runWeeklyPlanAutomation = runRollingPlanAutomation;
