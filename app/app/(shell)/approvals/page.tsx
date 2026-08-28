import { PageHead } from "@/components/voom/shell/AppShell";
import { ApprovalsBoard, type ApprovalItem } from "@/components/voom/operating/ApprovalsBoard";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const data = await getOperatingData();
  return <div><PageHead title="Approvals" description="Review protected changes before Voom applies them." />{data && <ApprovalsBoard initial={data.actions as ApprovalItem[]} />}</div>;
}
