import { PlanWorkspace } from "@/components/voom/operating/PlanWorkspace";
import { getOperatingData } from "@/lib/voom/operating-data";
import { marketingPlanSnapshot } from "@/lib/voom/workflow/marketing-plan";
import { readSocialChannelReadiness } from "@/lib/social/readiness";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * The Marketing Plan is a read-only projection over the existing authoritative
 * reads: the shared workflow snapshot (narrowed to the current rolling horizon
 * by the existing `marketingPlanSnapshot`), the coordinator's own uncovered
 * dates and the real per-provider connection rows. No coverage rule, cadence
 * decision or status is recomputed for presentation.
 */
export default async function PlanPage() {
  const data = await getOperatingData();
  if (!data) return null;

  const readiness = await readSocialChannelReadiness(createAdminClient(), data.user.id);
  const snapshot = marketingPlanSnapshot(data.snapshot);

  return (
    <PlanWorkspace
      initial={snapshot}
      uncoveredDates={(data.coordinator?.gaps ?? []).map((gap) => gap.date)}
      channelReadiness={readiness}
    />
  );
}
