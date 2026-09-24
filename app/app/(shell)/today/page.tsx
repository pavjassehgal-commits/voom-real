import { TodayDashboard } from "@/components/voom/today/TodayDashboard";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { loadPerformanceReport } from "@/lib/performance/data";
import { getOperatingData } from "@/lib/voom/operating-data";
import { buildTodayView } from "@/lib/voom/today-view";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Today V2 is deliberately a read-only projection over Voom's existing truth:
 * the shared workflow snapshot, its existing todaySummary, the coordinator's
 * existing gap/need evaluation and real stored performance measurements.
 * It creates no parallel coverage, attention, scheduling or performance data.
 */
export default async function TodayPage() {
  const data = await getOperatingData();
  if (!data) return null;

  const sessionDb = await createClient();
  const performance = await loadPerformanceReport(sessionDb, data.user.id);
  const view = buildTodayView(data.snapshot, data.summary, data.coordinator);
  const displayName = readDisplayName(data.user.email);

  return <TodayDashboard
    firstName={displayName}
    greeting={greetingFor(new Date(), data.snapshot.timeZone)}
    view={view}
    performance={performance}
    automationMode={normalizeAutomationMode(data.business.automation_level)}
  />;
}

function readDisplayName(email?: string | null) {
  const local = email?.split("@")[0]?.trim();
  return local ? local.split(/[._-]/)[0] : "there";
}

function greetingFor(now: Date, timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(now));
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
