import { PerformanceView } from "@/components/voom/performance/PerformanceView";
import { loadPerformanceReport } from "@/lib/performance/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { loadYouTubePerformanceVideos } from "@/lib/youtube/performance-view";

export const dynamic = "force-dynamic";

/**
 * Performance — the executive read of what Voom actually published.
 *
 * Every number on this page was returned by a provider for a real published
 * item and stored as a normalized snapshot. There are no scores, no
 * projections, no estimated reach and no fill-in zeros: a metric Voom could
 * not read is simply not shown, and a comparison is only made when the sample
 * is large enough to mean something. When there is not enough measured history,
 * the page says so instead of ranking content it cannot rank.
 *
 * The read goes through the session client, so Row Level Security — not this
 * component — is what guarantees one owner can never see another's results.
 * YouTube numbers come from the SAME shared read the YouTube API route uses
 * (lib/youtube/performance-view.ts), so the two surfaces can never disagree.
 */
export default async function PerformancePage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const db = await createClient();
  const [report, youTube] = await Promise.all([
    loadPerformanceReport(db, user.id),
    loadYouTubePerformanceVideos(db, user.id).catch(() => null),
  ]);

  return <PerformanceView report={report} youTube={youTube} />;
}
