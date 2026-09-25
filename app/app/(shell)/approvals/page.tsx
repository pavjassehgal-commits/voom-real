import { ApprovalsWorkspace } from "@/components/voom/operating/ApprovalsWorkspace";
import type { ApprovalItem } from "@/components/voom/operating/ApprovalsBoard";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";

/**
 * Approvals is a thin loader over the existing authoritative feed:
 * `getOperatingData()` already filters the owner's `mara_pending_actions` to the
 * current workflow horizon. The whole surface (header counts + board) lives in
 * the shared client component so the counts and the cards are always derived
 * from the same rows.
 */
export default async function ApprovalsPage() {
  const data = await getOperatingData();
  if (!data) return null;

  return <ApprovalsWorkspace initial={data.actions as ApprovalItem[]} reelTaskCount={data.reelTaskCount} />;
}
