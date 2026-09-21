import Link from "next/link";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Card, EmptyState, Tag } from "@/components/voom/ui/primitives";
import { Icon } from "@/components/voom/icons";
import { MultipleBadge, PerformanceSignals } from "@/components/voom/performance/PerformanceIntelligence";
import { loadPerformanceReport } from "@/lib/performance/data";
import { formatMultiple, formatNumber, type PerformanceGroupView, type PerformanceItemView, type PerformanceReport } from "@/lib/performance/insights";
import { PERFORMANCE_METRIC_LABELS, type PerformanceMetric } from "@/lib/performance/types";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { formatLocalDate, formatLocalDateTime } from "@/lib/voom/timezone";

export const dynamic = "force-dynamic";

/**
 * Performance (v1) — real results for content Voom published.
 *
 * Every number on this page was returned by Meta for a specific published
 * media id and stored as a normalized snapshot. There are no scores, no
 * projections, no estimated reach and no fill-in zeros: a metric Voom could
 * not read is simply not shown. When there is not enough measured history, the
 * page says so instead of ranking content it cannot rank.
 *
 * The read goes through the session client, so Row Level Security — not this
 * component — is what guarantees one owner can never see another's results.
 */
export default async function PerformancePage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const db = await createClient();
  const report = await loadPerformanceReport(db, user.id);

  return <div className="mx-auto max-w-[1000px]">
    <PageHead
      title="Performance"
      description="Real results from the content Voom published for you on Instagram — measured, never estimated."
      tags={<>
        <Tag tone="t-brand">Instagram</Tag>
        {report.lastCollectedAt && <Tag tone="t-grey">Metrics collected {formatLocalDateTime(report.lastCollectedAt)}</Tag>}
        <Tag tone="t-grey">Last {report.windowDays} days</Tag>
      </>}
      actions={<Link href="/app/instagram" className="inline-flex h-[38px] items-center rounded-[10px] border border-line px-4 text-sm font-semibold hover:border-brand">Instagram connection →</Link>}
    />

    {report.measuredItems === 0
      ? <EmptyPerformanceState report={report} />
      : <>
        <Summary report={report} />
        {report.best && <BestContent item={report.best} basisLabel={report.basis?.label ?? null} />}
        <WorkingContent report={report} />
        <RecentContent report={report} />
        <MaraInsight report={report} />
      </>}

    <Card className="mt-4 p-5">
      <h2 className="font-display text-base font-semibold">How these numbers are produced</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-text-2">
        Voom reads metrics from Meta only for content it published for you and Meta confirmed with a real media id.
        Collection is read-only: it never posts, never edits a caption or a visual, and never starts a generation.
        Each reading is stored as a snapshot, so a metric that Meta does not expose for your account or media type is
        left out entirely rather than filled in.
      </p>
      {report.publishedWithoutMetrics > 0 && <p className="mt-2 text-xs leading-relaxed text-text-3">
        {report.publishedWithoutMetrics} published item{report.publishedWithoutMetrics === 1 ? "" : "s"} in this window
        {report.publishedWithoutMetrics === 1 ? " has" : " have"} no metrics yet — Meta either has not exposed them for that media type or is
        still returning them. Voom keeps checking and will compare them as soon as real numbers arrive.
      </p>}
    </Card>

    <Card className="mt-4 p-5">
      <h2 className="font-display text-base font-semibold">YouTube</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-text-2">
        YouTube performance (views, likes, comments for videos Voom published) is collected read-only from the
        official YouTube Data API and shown on the <Link href="/app/youtube" className="font-medium text-brand hover:underline">YouTube page</Link>.
        A dash there means YouTube did not return that number — it is never a zero in disguise.
      </p>
    </Card>

    <Card className="mt-4 p-5">
      <h2 className="font-display text-base font-semibold">TikTok</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-text-2">
        TikTok performance data is unavailable through Voom&apos;s connection — and none is invented here. Voom
        requests only the scopes it needs to publish (basic identity + posting) and asks TikTok for no analytics
        access, so TikTok publishes with no performance numbers. Check TikTok&apos;s own analytics for views and
        engagement.
      </p>
    </Card>
  </div>;
}

function EmptyPerformanceState({ report }: { report: PerformanceReport }) {
  if (report.emptyReason === "no_metrics_yet") {
    return <Card className="p-0">
      <EmptyState
        icon="clock"
        title="Published, but no metrics yet"
        reason={`Voom has published ${report.publishedItems} item${report.publishedItems === 1 ? "" : "s"} in the last ${report.windowDays} days. Meta has not returned performance metrics for them yet — it can take a while for a new post, and Stories stop reporting after 24 hours. Voom checks on a schedule and will show real numbers the moment Meta returns them.`}
        action={<Link href="/app/calendar" className="inline-flex h-[38px] items-center rounded-[10px] border border-line px-4 text-sm font-semibold hover:border-brand">Open Content Calendar</Link>}
      />
    </Card>;
  }
  return <Card className="p-0">
    <EmptyState
      icon="trend"
      title="No published content to measure yet"
      reason="Voom measures only content it has actually published and Meta has confirmed with a real media id. Approve and schedule content from your rolling plan and its real results will appear here."
      action={<Link href="/app/plan" className="inline-flex h-[38px] items-center rounded-[10px] border border-line px-4 text-sm font-semibold hover:border-brand">Open Marketing Plan</Link>}
    />
  </Card>;
}

/**
 * The MARA insight section: the same measured statements the planner receives,
 * shown with the sample they were measured from. Every sentence here is
 * produced from stored snapshots (see lib/performance/insights.ts) — when the
 * account does not have enough measured content, there is no statement and no
 * section, rather than an optimistic placeholder.
 */
function MaraInsight({ report }: { report: PerformanceReport }) {
  if (!report.headline && !report.signals.length) return null;
  return <Card className="mb-4 p-5 sm:p-6">
    <div className="flex flex-wrap items-center gap-2">
      <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name="trend" size={18} /></span>
      <h2 className="font-display text-base font-semibold">Performance intelligence</h2>
      <Tag tone="t-brand">{report.confidence === "moderate" ? "Moderate confidence" : "Low confidence"}</Tag>
      <Tag tone="t-grey">{report.measuredItems} measured item{report.measuredItems === 1 ? "" : "s"}</Tag>
    </div>
    {report.headline && <p className="mt-2 text-sm leading-relaxed text-text-2">{report.headline}</p>}
    <PerformanceSignals report={report} />
    <p className="mt-3 text-xs leading-relaxed text-text-3">
      MARA reads exactly these measured signals — with the sample size and confidence — when it plans your next 7 days.
      They are advisory evidence, never a rule: MARA keeps your brand, your goal and a varied mix of formats and topics in front.
    </p>
  </Card>;
}

function Summary({ report }: { report: PerformanceReport }) {
  const stats: { label: string; value: string }[] = [
    { label: "Measured items", value: String(report.measuredItems) },
    { label: "Comparison basis", value: report.basis ? report.basis.label.split(" (")[0] : "—" },
    { label: "Recent average", value: report.recentAverage === null ? "—" : formatNumber(report.recentAverage) },
    { label: "Baseline items", value: report.baselineSample ? String(report.baselineSample) : "—" },
    { label: "Confidence", value: report.confidence === "moderate" ? "Moderate" : report.confidence === "low" ? "Low" : "None" },
  ];
  return <Card className="mb-4 p-5">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="font-display text-base font-semibold">Recent performance</h2>
      <Tag tone="t-grey">{report.measuredItems} item{report.measuredItems === 1 ? "" : "s"} with real metrics</Tag>
    </div>
    <div className="flex flex-wrap gap-2">
      {stats.map((stat) => <div key={stat.label} className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
        <b className="block font-display text-lg leading-none">{stat.value}</b>
        <span className="text-[11.5px] text-text-3">{stat.label}</span>
      </div>)}
    </div>
    {report.emptyReason === "not_enough_history" && <p className="mt-3 text-xs leading-relaxed text-text-3">
      Voom needs at least 3 measured items before it will call anything a trend. Until then you see the raw metrics and nothing more.
    </p>}
    {report.emptyReason === "no_comparable_metrics" && <p className="mt-3 text-xs leading-relaxed text-text-3">
      Your published content does not share one comparable metric yet (for example, only Stories with views so far), so no relative comparison is shown.
    </p>}
  </Card>;
}

function BestContent({ item, basisLabel }: { item: PerformanceItemView; basisLabel: string | null }) {
  return <Card className="mb-4 p-5">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name="fire" size={18} /></span>
      <h2 className="font-display text-base font-semibold">Best-performing recent content</h2>
      <MultipleBadge multiple={item.multiple} />
    </div>
    <p className="text-sm font-semibold">{item.title}</p>
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <Tag tone="t-blue">{item.contentTypeLabel}</Tag>
      <span className="text-xs text-text-3">Published {formatLocalDate(item.publishedAt)}</span>
      {item.topic && <Tag tone="t-grey">{item.topic}</Tag>}
      <Tag tone="t-grey">{item.purposeLabel}</Tag>
    </div>
    <MetricsRow item={item} />
    {basisLabel && <p className="mt-2 text-xs text-text-3">Compared on {basisLabel} against your own recent published content.</p>}
  </Card>;
}

function WorkingContent({ report }: { report: PerformanceReport }) {
  const groups = [
    { title: "By content type", groups: report.byContentType },
    { title: "By topic", groups: report.byTopic },
    { title: "By purpose", groups: report.byPurpose },
  ].filter((section) => section.groups.some((group) => group.multiple !== null));
  if (!groups.length) return null;
  return <Card className="mb-4 p-5">
    <div className="mb-3 flex items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name="target" size={18} /></span>
      <h2 className="font-display text-base font-semibold">What is working</h2>
    </div>
    <div className="space-y-4">
      {groups.map((section) => <div key={section.title}>
        <h3 className="text-[12.5px] font-semibold tracking-[.01em] text-text-2">{section.title}</h3>
        <div className="mt-2 space-y-2">
          {section.groups.filter((group) => group.multiple !== null).map((group) => <GroupRow key={`${section.title}:${group.key}`} group={group} />)}
        </div>
      </div>)}
    </div>
    <p className="mt-3 text-xs leading-relaxed text-text-3">
      Each line compares that group of your own published content with the rest of it. Groups with fewer than 2 measured
      items are left out, and a comparison is only shown when the average it is measured against is large enough to mean something.
    </p>
  </Card>;
}

function GroupRow({ group }: { group: PerformanceGroupView }) {
  return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
    <b className="text-sm">{group.label}</b>
    <Tag tone="t-grey">{group.sampleSize} item{group.sampleSize === 1 ? "" : "s"}</Tag>
    <span className="text-xs text-text-3">avg {formatNumber(group.average)}</span>
    <span className="ml-auto"><MultipleBadge multiple={group.multiple} /></span>
  </div>;
}

function RecentContent({ report }: { report: PerformanceReport }) {
  const items = report.items.slice(0, 10);
  return <Card className="mb-4 p-5">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name="ig" size={18} /></span>
      <h2 className="font-display text-base font-semibold">Recent published content</h2>
      <Tag tone="t-grey">{report.items.length}</Tag>
    </div>
    {items.length
      ? <div className="space-y-2">{items.map((item) => <div key={item.instagramMediaId} className="rounded-xl border border-line bg-surface-2 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={item.contentType === "reel" ? "t-pink" : item.contentType === "story" ? "t-story" : "t-blue"}>{item.contentTypeLabel}</Tag>
          <b className="min-w-0 flex-1 truncate text-sm">{item.title}</b>
          <MultipleBadge multiple={item.multiple} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-3">
          <span>Published {formatLocalDate(item.publishedAt)}</span>
          {item.topic && <span>· {item.topic}</span>}
          <span>· {item.purposeLabel}</span>
          {item.engagementRate !== null && <span>· {formatRate(item.engagementRate)} engagement rate on reach</span>}
        </div>
        <MetricsRow item={item} />
      </div>)}</div>
      : <p className="text-sm text-text-3">No measured content in this window.</p>}
    {report.trend && <p className="mt-3 text-xs leading-relaxed text-text-3">
      Last {report.trend.recentDays} days: {formatNumber(report.trend.recentAverage)} vs {formatNumber(report.trend.previousAverage)} the week before
      ({report.trend.recentSample} item{report.trend.recentSample === 1 ? "" : "s"} vs {report.trend.previousSample}) — {report.trend.multiple >= 1
        ? `${formatMultiple(report.trend.multiple)} higher`
        : `${formatMultiple(1 / report.trend.multiple)} lower`}.
    </p>}
  </Card>;
}

function MetricsRow({ item }: { item: PerformanceItemView }) {
  // Only metrics Meta really returned. An absent metric is absent, not 0.
  return <div className="mt-2 flex flex-wrap gap-1.5">
    {item.availableMetrics.map((metric: PerformanceMetric) => <span key={metric} className="rounded-lg bg-surface px-2.5 py-1 text-[11.5px] text-text-2">
      {PERFORMANCE_METRIC_LABELS[metric]} <b className="text-text">{formatNumber(item.metrics[metric] ?? 0)}</b>
    </span>)}
  </div>;
}

function formatRate(rate: number): string {
  const percent = rate * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
