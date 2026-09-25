import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { MultipleBadge, PerformanceSignals } from "@/components/voom/performance/PerformanceIntelligence";
import { loadPerformanceReport } from "@/lib/performance/data";
import { formatMultiple, formatNumber, type PerformanceGroupView, type PerformanceItemView, type PerformanceReport } from "@/lib/performance/insights";
import { PERFORMANCE_METRIC_LABELS, type PerformanceMetric } from "@/lib/performance/types";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { formatLocalDate, formatLocalDateTime } from "@/lib/voom/timezone";
import { loadYouTubePerformanceVideos, type YouTubePerformanceVideo } from "@/lib/youtube/performance-view";
import {
  ComparisonBar,
  Fact,
  MetaChip,
  MiniBars,
  Panel,
  PanelHead,
  QuietState,
  SectionLabel,
  WorkspaceFrame,
  WorkspaceHeader,
} from "@/components/voom/workspace/ui";

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

/** The whole page as one pure render over the two authoritative reads. */
export function PerformanceView({ report, youTube }: {
  report: PerformanceReport;
  youTube: YouTubePerformanceVideo[] | null;
}) {
  return (
    <WorkspaceFrame>
      <WorkspaceHeader
        eyebrow="Performance"
        title="Is my marketing working — and what changed?"
        question={report.headline ?? (report.measuredItems > 0
          ? `${report.publishedItems} published item${report.publishedItems === 1 ? "" : "s"} in the last ${report.windowDays} days, ${report.measuredItems} with real provider numbers.`
          : "Nothing measured yet — this page fills in only once Voom has really published content and a provider returned numbers for it.")}
        description="Measured results only. Voom never estimates reach, never fills a missing number with zero, and never turns a small sample into a trend."
        meta={<>
          <MetaChip accent><Icon name="ig" size={12} /> Instagram</MetaChip>
          <MetaChip><Icon name="trend" size={12} /> Last {report.windowDays} days</MetaChip>
          <MetaChip>{report.measuredItems} measured · {report.publishedItems} published</MetaChip>
          {report.basis && <MetaChip>Compared on {report.basis.label}</MetaChip>}
          {report.lastCollectedAt && <MetaChip>Metrics collected {formatLocalDateTime(report.lastCollectedAt)}</MetaChip>}
        </>}
        actions={<>
          <Link href="/app/instagram" className="inline-flex h-[34px] items-center gap-1.5 rounded-[10px] border border-line px-3.5 text-[13px] font-semibold text-text-2 transition hover:border-line-2 hover:text-text">
            <Icon name="ig" size={14} /> Instagram
          </Link>
          <Link href="/app/youtube" className="inline-flex h-[34px] items-center gap-1.5 rounded-[10px] border border-line px-3.5 text-[13px] font-semibold text-text-2 transition hover:border-line-2 hover:text-text">
            <Icon name="play" size={14} /> YouTube
          </Link>
        </>}
      />

      {report.measuredItems === 0
        ? <EmptyPerformanceState report={report} />
        : <>
          <ExecutiveRead report={report} />
          {report.best && <BestContent item={report.best} basisLabel={report.basis?.label ?? null} />}
          <WorkingContent report={report} />
          <RecentContent report={report} />
          <MaraInsight report={report} />
        </>}

      <PlatformBreakdown youTube={youTube} />

      <Panel className="relative z-10 mt-3.5">
        <PanelHead
          icon="shield"
          title="How these numbers are produced"
          hint="Read-only collection — it never posts, never edits a caption or a visual, and never starts a generation."
        />
        <p className="mt-3 text-[13px] leading-relaxed text-text-2">
          Voom reads metrics from Meta only for content it published for you and Meta confirmed with a real media id.
          Each reading is stored as a snapshot, so a metric that Meta does not expose for your account or media type is
          left out entirely rather than filled in.
        </p>
        {report.publishedWithoutMetrics > 0 && <p className="mt-2 text-[12px] leading-relaxed text-text-3">
          {report.publishedWithoutMetrics} published item{report.publishedWithoutMetrics === 1 ? "" : "s"} in this window
          {report.publishedWithoutMetrics === 1 ? " has" : " have"} no metrics yet — Meta either has not exposed them for that media type or is
          still returning them. Voom keeps checking and will compare them as soon as real numbers arrive.
        </p>}
      </Panel>
    </WorkspaceFrame>
  );
}

/* ──────────────────────────────────────────────────────────────
   The executive read: one headline, one real trend, one real series
   ────────────────────────────────────────────────────────────── */

function ExecutiveRead({ report }: { report: PerformanceReport }) {
  const series = [...report.items]
    .filter((item) => item.basisValue !== null)
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    .map((item) => ({
      key: item.instagramMediaId,
      value: item.basisValue,
      label: `${item.title} · ${formatLocalDate(item.publishedAt)}`,
      accent: "var(--iridescent)",
    }));

  return (
    <Panel className="relative z-10 mb-3.5">
      <PanelHead
        icon="trend"
        title={report.headline ? "What changed" : "The real numbers so far"}
        hint={report.headline
          ? undefined
          : `Voom needs at least 3 measured items before it will call anything a trend. ${report.measuredItems} measured so far.`}
        action={report.basis ? <MetaChip>Basis · {report.basis.label}</MetaChip> : undefined}
      />
      {report.headline && <p className="mt-3 max-w-3xl text-[15px] font-semibold leading-relaxed tracking-[-0.01em] text-text">{report.headline}</p>}

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {report.trend ? <ComparisonBar
            recent={report.trend.recentAverage}
            previous={report.trend.previousAverage}
            recentLabel={`Last ${report.trend.recentDays} days`}
            previousLabel="The week before"
            accent="var(--brand)"
          /> : <p className="rounded-2xl bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-text-3">
            No week-over-week comparison yet. {report.emptyReason === "not_enough_history"
              ? "Your measured content is still too recent for Voom to split it into two comparable windows."
              : report.emptyReason === "no_comparable_metrics"
                ? "Your published content does not share one comparable metric yet, so no relative comparison is shown."
                : "Voom will compare the last 7 days with the week before as soon as both windows hold real numbers."}
          </p>}
          {report.trend && <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">
            {report.trend.recentSample} item{report.trend.recentSample === 1 ? "" : "s"} vs {report.trend.previousSample} the week before ·
            {" "}{report.trend.multiple >= 1 ? `${formatMultiple(report.trend.multiple)} higher` : `${formatMultiple(1 / report.trend.multiple)} lower`}.
          </p>}
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3.5 sm:grid-cols-3">
            <Fact label="Measured items">{report.measuredItems}</Fact>
            <Fact label="Baseline sample">{report.baselineSample ? String(report.baselineSample) : "—"}</Fact>
            <Fact label="Confidence">{report.confidence === "moderate" ? "Moderate" : report.confidence === "low" ? "Low" : "None"}</Fact>
          </dl>
        </div>

        <div className="min-w-0">
          <SectionLabel>{report.basis ? `${report.basis.label} per published item` : "Measured items"}</SectionLabel>
          {series.length > 1
            ? <>
              <MiniBars className="mt-2.5" points={series} height={88} />
              <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">
                One bar per published item Voom measured, oldest to newest. A hairline gap is an item Meta returned no
                value for — never a zero.
              </p>
            </>
            : <p className="mt-2 rounded-2xl bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-text-3">
              Not enough measured items share one comparable metric to draw a series yet.
            </p>}
          <PerformanceSignals report={report} />
        </div>
      </div>
    </Panel>
  );
}

function EmptyPerformanceState({ report }: { report: PerformanceReport }) {
  if (report.emptyReason === "no_metrics_yet") {
    return <Panel className="relative z-10 mb-3.5">
      <QuietState
        icon="clock"
        title="Published, but no metrics yet"
        action={<Link href="/app/calendar" className="inline-flex h-[34px] items-center rounded-[10px] border border-line px-3.5 text-[13px] font-semibold hover:border-line-2">Open Content Calendar</Link>}
      >
        <p>Voom has published {report.publishedItems} item{report.publishedItems === 1 ? "" : "s"} in the last {report.windowDays} days. Meta has not returned performance metrics for them yet — it can take a while for a new post, and Stories stop reporting after 24 hours.</p>
        <p className="mt-1.5 text-text-3">Voom checks on a schedule and will show real numbers the moment Meta returns them.</p>
      </QuietState>
    </Panel>;
  }
  return <Panel className="relative z-10 mb-3.5">
    <QuietState
      icon="trend"
      title="No published content to measure yet"
      action={<Link href="/app/plan" className="inline-flex h-[34px] items-center rounded-[10px] border border-line px-3.5 text-[13px] font-semibold hover:border-line-2">Open Marketing Plan</Link>}
    >
      <p>Voom measures only content it has actually published and Meta has confirmed with a real media id. Approve and schedule content from your rolling plan and its real results will appear here.</p>
    </QuietState>
  </Panel>;
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
  return <Panel className="relative z-10 mb-3.5">
    <PanelHead
      icon="spark"
      title="Performance intelligence"
      action={<>
        <MetaChip>{report.confidence === "moderate" ? "Moderate confidence" : "Low confidence"}</MetaChip>
        <MetaChip>{report.measuredItems} measured item{report.measuredItems === 1 ? "" : "s"}</MetaChip>
      </>}
    />
    {report.headline && <p className="mt-3 text-[13.5px] leading-relaxed text-text-2">{report.headline}</p>}
    <PerformanceSignals report={report} />
    <p className="mt-3 text-[11.5px] leading-relaxed text-text-3">
      MARA reads exactly these measured signals — with the sample size and confidence — when it plans your next 7 days.
      They are advisory evidence, never a rule: MARA keeps your brand, your goal and a varied mix of formats and topics in front.
    </p>
  </Panel>;
}

function BestContent({ item, basisLabel }: { item: PerformanceItemView; basisLabel: string | null }) {
  return <Panel className="relative z-10 mb-3.5">
    <PanelHead
      icon="fire"
      title="Best-performing recent content"
      action={<MultipleBadge multiple={item.multiple} />}
    />
    <p className="mt-3 text-[13.5px] font-semibold tracking-[-0.01em] text-text">{item.title}</p>
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <MetaChip>{item.contentTypeLabel}</MetaChip>
      <MetaChip>Published {formatLocalDate(item.publishedAt)}</MetaChip>
      {item.topic && <MetaChip>{item.topic}</MetaChip>}
      <MetaChip>{item.purposeLabel}</MetaChip>
    </div>
    <MetricsRow item={item} />
    {basisLabel && <p className="mt-2 text-[11.5px] text-text-3">Compared on {basisLabel} against your own recent published content.</p>}
  </Panel>;
}

function WorkingContent({ report }: { report: PerformanceReport }) {
  const groups = [
    { title: "By content type", groups: report.byContentType },
    { title: "By topic", groups: report.byTopic },
    { title: "By purpose", groups: report.byPurpose },
  ].filter((section) => section.groups.some((group) => group.multiple !== null));
  if (!groups.length) return null;
  return <Panel className="relative z-10 mb-3.5">
    <PanelHead icon="target" title="What is working" hint="Each line compares that group of your own published content with the rest of it." />
    <div className="mt-4 space-y-4">
      {groups.map((section) => <div key={section.title} className="min-w-0">
        <SectionLabel>{section.title}</SectionLabel>
        <div className="mt-2 space-y-2">
          {section.groups.filter((group) => group.multiple !== null).map((group) => <GroupRow key={`${section.title}:${group.key}`} group={group} />)}
        </div>
      </div>)}
    </div>
    <p className="mt-3 text-[11.5px] leading-relaxed text-text-3">
      Groups with fewer than 2 measured items are left out, and a comparison is only shown when the average it is
      measured against is large enough to mean something.
    </p>
  </Panel>;
}

function GroupRow({ group }: { group: PerformanceGroupView }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-2xl border border-line bg-[var(--surface)]/70 px-3.5 py-2.5">
    <b className="min-w-0 truncate text-[13px] font-semibold">{group.label}</b>
    <MetaChip>{group.sampleSize} item{group.sampleSize === 1 ? "" : "s"}</MetaChip>
    <span className="text-[12px] text-text-3">avg {formatNumber(group.average)}</span>
    <span className="ml-auto"><MultipleBadge multiple={group.multiple} /></span>
  </div>;
}

function RecentContent({ report }: { report: PerformanceReport }) {
  const items = report.items.slice(0, 10);
  return <Panel className="relative z-10 mb-3.5">
    <PanelHead
      icon="ig"
      title="Recent published content"
      action={<MetaChip>{report.items.length} measured</MetaChip>}
    />
    {items.length
      ? <div className="mt-3.5 space-y-2">{items.map((item) => <div key={item.instagramMediaId} className="min-w-0 rounded-2xl border border-line bg-[var(--surface)]/70 px-3.5 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <MetaChip>{item.contentTypeLabel}</MetaChip>
          <b className="min-w-0 flex-1 truncate text-[13.5px]">{item.title}</b>
          <MultipleBadge multiple={item.multiple} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-3">
          <span>Published {formatLocalDate(item.publishedAt)}</span>
          {item.topic && <span>· {item.topic}</span>}
          <span>· {item.purposeLabel}</span>
          {item.engagementRate !== null && <span>· {formatRate(item.engagementRate)} engagement rate on reach</span>}
        </div>
        <MetricsRow item={item} />
      </div>)}</div>
      : <p className="mt-3 text-[13px] text-text-3">No measured content in this window.</p>}
  </Panel>;
}

function MetricsRow({ item }: { item: PerformanceItemView }) {
  // Only metrics Meta really returned. An absent metric is absent, not 0.
  return <div className="mt-2 flex flex-wrap gap-1.5">
    {item.availableMetrics.map((metric: PerformanceMetric) => <span key={metric} className="rounded-lg bg-surface-2 px-2.5 py-1 text-[11.5px] text-text-2">
      {PERFORMANCE_METRIC_LABELS[metric]} <b className="tabular-nums text-text">{formatNumber(item.metrics[metric] ?? 0)}</b>
    </span>)}
  </div>;
}

/**
 * Platform breakdown. Instagram is measured above; YouTube shows the real
 * Data API numbers for the videos Voom published; TikTok is honestly
 * unavailable — Voom asks TikTok for no analytics scope, so the panel says so
 * instead of printing zeros.
 */
function PlatformBreakdown({ youTube }: { youTube: YouTubePerformanceVideo[] | null }) {
  const youTubeWithNumbers = (youTube ?? []).filter((video) => Object.keys(video.metrics).length > 0);
  const youTubeSeries = [...youTubeWithNumbers]
    .sort((a, b) => Date.parse(a.publishedAt ?? a.collectedAt ?? "") - Date.parse(b.publishedAt ?? b.collectedAt ?? ""))
    .map((video) => ({
      key: video.videoId,
      value: typeof video.metrics.views === "number" ? video.metrics.views : null,
      label: `${video.videoId} · ${video.contentType === "short" ? "Short" : "Video"}`,
      accent: "var(--iridescent)",
    }));

  return <Panel className="relative z-10 mt-3.5">
    <PanelHead
      icon="globe"
      title="Where the numbers come from"
      hint="One panel per platform. A platform without a real read says so — it is never shown as zeros."
    />
    <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-3">
      <div className="min-w-0 rounded-2xl border border-line bg-[var(--surface)]/70 p-3.5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--ch-instagram)" }} />
          <b className="text-[13px] font-semibold">Instagram</b>
          <MetaChip>Measured</MetaChip>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-3">Meta Insights, read per published media id. This is the only platform with a full performance read today.</p>
      </div>

      <div className="min-w-0 rounded-2xl border border-line bg-[var(--surface)]/70 p-3.5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--ch-youtube)" }} />
          <b className="text-[13px] font-semibold">YouTube</b>
          <MetaChip>{youTubeWithNumbers.length > 0 ? "Data API" : youTube ? "No numbers yet" : "Unavailable"}</MetaChip>
        </div>
        {youTubeSeries.length > 0
          ? <>
            <MiniBars className="mt-3" points={youTubeSeries} height={56} />
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">
              Views per published video, from the official YouTube Data API. A dash means YouTube did not return that number — never a zero in disguise.
            </p>
          </>
          : <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-3">
            {youTube === null
              ? "YouTube performance could not be read right now. Nothing is estimated in its place."
              : "No published YouTube video has returned statistics yet. Voom collects them read-only once YouTube confirms processing."}
            </p>}
        <Link href="/app/youtube" className="mt-2.5 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
          Open YouTube <Icon name="arrow" size={12} />
        </Link>
      </div>

      <div className="min-w-0 rounded-2xl border border-line bg-[var(--surface)]/70 p-3.5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "var(--ch-tiktok)" }} />
          <b className="text-[13px] font-semibold">TikTok</b>
          <MetaChip>Unavailable</MetaChip>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-3">
          TikTok performance data is unavailable through Voom&apos;s connection — and none is invented here. Voom requests
          only the scopes it needs to publish (basic identity + posting) and asks TikTok for no analytics access.
        </p>
        <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">Check TikTok&apos;s own analytics for views and engagement.</p>
      </div>
    </div>
  </Panel>;
}

function formatRate(rate: number): string {
  const percent = rate * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
