import { ContentLibrary } from "@/components/voom/content/ContentLibrary";
import { loadPerformanceReport } from "@/lib/performance/data";
import { loadContentLibrary } from "@/lib/voom/content-library";
import { CONTENT_TABS, type ContentBucket } from "@/lib/voom/content-library-core";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Content (Figma "27 — Content · All content" … "30 — Published", Keep).
 * A read-only library over the owner's real posts and drafts; every action
 * opens the existing editors, so no publishing, approval or scheduling rule
 * is duplicated here.
 */
export default async function ContentPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const initialTab = CONTENT_TABS.some((entry) => entry.id === tab) ? tab as "all" | ContentBucket : "all";
  const user = await getCurrentUser();
  if (!user) return null;
  const performance = await loadPerformanceReport(await createClient(), user.id).catch(() => null);
  const library = await loadContentLibrary(createAdminClient(), user.id, performance).catch(() => null);
  return (
    <ContentLibrary
      initialTab={initialTab}
      items={library?.items ?? []}
      limited={library?.limited ?? false}
      unavailable={!library}
      performance={performance && performance.measuredItems > 0 ? {
        headline: performance.headline,
        windowDays: performance.windowDays,
        views: sum(performance.items.map((item) => item.metrics.views ?? item.metrics.plays ?? null)),
        likes: sum(performance.items.map((item) => item.metrics.likes ?? null)),
        comments: sum(performance.items.map((item) => item.metrics.comments ?? null)),
        best: performance.best ? { title: performance.best.title, typeLabel: performance.best.contentTypeLabel, basisValue: performance.best.basisValue, basisLabel: performance.basis?.label ?? null } : null,
      } : null}
    />
  );
}

function sum(values: (number | null | undefined)[]) {
  const measured = values.filter((value): value is number => typeof value === "number");
  return measured.length ? measured.reduce((total, value) => total + value, 0) : null;
}
