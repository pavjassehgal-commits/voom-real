import { PlanWorkspace } from "@/components/voom/operating/PlanWorkspace";
import { getOperatingData } from "@/lib/voom/operating-data";
import { marketingPlanSnapshot } from "@/lib/voom/workflow/marketing-plan";
import { readSocialChannelReadiness } from "@/lib/social/readiness";
import { getCurrentUser } from "@/lib/voom/server-data";
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
  // Channel readiness is a separate owner-scoped read: it runs concurrently
  // with the shared operating-data read instead of after it.
  const user = await getCurrentUser();
  const [data, readiness] = await Promise.all([
    getOperatingData(),
    user ? readSocialChannelReadiness(createAdminClient(), user.id) : Promise.resolve(null),
  ]);
  if (!data) return null;
  const snapshot = marketingPlanSnapshot(data.snapshot);

  return (
    <PlanWorkspace
      initial={snapshot}
      uncoveredDates={(data.coordinator?.gaps ?? []).map((gap) => gap.date)}
      channelReadiness={readiness ?? []}
    />
  );
}
