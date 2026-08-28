import { PageHead } from "@/components/voom/shell/AppShell";
import { PlanWorkspace } from "@/components/voom/operating/PlanWorkspace";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";
export default async function PlanPage() { const data = await getOperatingData(); return <div><PageHead title="Marketing Plan" description="The strategy Voom is using to coordinate your approved marketing work." />{data && <PlanWorkspace initial={data.plan} storageReady={data.planStorageReady} />}</div>; }
