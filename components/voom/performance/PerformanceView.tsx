import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/voom/icons";
import { BTN, ChannelGlyph, PageHeader } from "@/components/voom/redesign/ui";
import { formatMultiple, formatNumber, type PerformanceGroupView, type PerformanceItemView, type PerformanceReport } from "@/lib/performance/insights";
import { PERFORMANCE_METRIC_LABELS, type PerformanceMetric } from "@/lib/performance/types";
import { cx } from "@/lib/voom/cx";
import { formatLocalDate, formatLocalDateTime } from "@/lib/voom/timezone";
import type { YouTubePerformanceVideo } from "@/lib/youtube/performance-view";

/**
 * Performance — redesign Batch 4C (Figma "See what's working.", drawn on the
 * PDF page labelled "36 — Campaigns · All campaigns", Keep).
 *
 * The whole page is one pure render over the two authoritative reads: the
 * Instagram report (stored Meta snapshots) and YouTube's stored Data API rows.
 * Every number was returned by a provider for content Voom really published.
 * Totals add only values a provider returned; a metric no item reported shows
 * a dash and "Not reported", never a zero. The reference's channel / period /
 * format filters, period comparison line, date arrows and Export report are
 * not shown — Voom stores one fixed window and has no export. Facebook, X and
 * LinkedIn rows are not shown: Voom does not publish there.
 */
export function PerformanceView({ report, youTube }: {
  report: PerformanceReport;
  youTube: YouTubePerformanceVideo[] | null;
}) {
  const items = [...report.items].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const sum = (metric: PerformanceMetric) => total(items.map((item) => item.metrics[metric]));
  const engagement = total(items.map((item) => item.interactions ?? undefined));
  const youTubeWithNumbers = (youTube ?? []).filter((video) => Object.keys(video.metrics).length > 0);

  return (
    <div className="min-w-0">
      <PageHeader
        title="See what’s working."
        subtitle={<>Is my marketing working — and what changed? Reach, engagement and audience growth across your published content.</>}
        actions={
          <div className="voom-card flex items-center gap-3 px-4 py-3">
            <Icon name="cal" size={18} className="text-text-2" />
            <span>
              <span className="block text-[14px] font-semibold text-text">Last {report.windowDays} days</span>
              <span className="block text-[12.5px] text-text-2">{report.lastCollectedAt ? `Metrics collected ${formatLocalDateTime(report.lastCollectedAt)}` : "No metrics collected yet"}</span>
            </span>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon="heart" label="Engagement" value={engagement} series={items.map((item) => item.interactions)}
          note={report.basis?.key === "engagement" && report.trend ? trendNote(report.trend.multiple, report.trend.recentDays) : "Likes, comments, saves, shares, replies"} />
        <MetricCard icon="eye" label="Reach" value={sum("reach")} series={items.map((item) => item.metrics.reach ?? null)}
          note={report.basis?.key === "reach" && report.trend ? trendNote(report.trend.multiple, report.trend.recentDays) : "Accounts reached, as Meta reports it"} />
        <MetricCard icon="contacts" label="New followers" value={sum("follows")} series={items.map((item) => item.metrics.follows ?? null)}
          note="Follows Meta attributed to a post" />
        <MetricCard icon="file" label="Posts measured" value={report.measuredItems} series={null}
          note={`${report.publishedItems} published · ${report.publishedWithoutMetrics} awaiting metrics`} />
      </div>

      {report.measuredItems === 0 ? <EmptyPerformanceState report={report} /> : (
        <div className="mb-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
          <OverTime report={report} items={items} />
          <MaraInsight report={report} />
        </div>
      )}

      <div className="mb-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <ChannelTable report={report} engagement={engagement} reach={sum("reach")} follows={sum("follows")} youTube={youTube} youTubeWithNumbers={youTubeWithNumbers} />
        <BestContent report={report} />
      </div>

      {report.measuredItems > 0 && <>
        <WorkingContent report={report} />
        <RecentContent report={report} />
      </>}

      <section className="voom-card p-5" aria-labelledby="perf-source">
        <CardTitle icon="shield" id="perf-source" title="How these numbers are produced" />
        <p className="mt-3 text-[13.5px] leading-relaxed text-text-2">
          Read-only collection — it never posts, never edits a caption or a visual, and never starts a generation. Voom reads
          metrics from Meta only for content it published for you and Meta confirmed with a real media id. Each reading is
          stored as a snapshot, so a metric that Meta does not expose for your account or media type is left out entirely
          rather than filled in.
        </p>
        {report.publishedWithoutMetrics > 0 && <p className="mt-2 text-[12.5px] leading-relaxed text-text-3">
          {report.publishedWithoutMetrics} published item{report.publishedWithoutMetrics === 1 ? "" : "s"} in this window
          {report.publishedWithoutMetrics === 1 ? " has" : " have"} no metrics yet — Meta either has not exposed them for that media type or is
          still returning them. Voom keeps checking and will compare them as soon as real numbers arrive.
        </p>}
      </section>
    </div>
  );
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** Headline figures read like the reference ("24.1K"); exact values stay in the item rows. */
function compact(value: number) {
  return COMPACT.format(value);
}

/** Sum of the values a provider actually returned; null when none did. */
function total(values: (number | null | undefined)[]): number | null {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

function trendNote(multiple: number, days: number) {
  const up = multiple >= 1;
  return <span className={up ? "text-[var(--green)]" : "text-[var(--amber)]"}>
    <Icon name="arrowUp" size={11} className={cx("mr-0.5 inline align-[-1px]", !up && "rotate-180")} />
    {up ? `${formatMultiple(multiple)} higher` : `${formatMultiple(1 / multiple)} lower`} <span className="font-normal text-text-3">last {days} days vs the week before</span>
  </span>;
}

function MetricCard({ icon, label, value, series, note }: { icon: string; label: string; value: number | null; series: (number | null)[] | null; note: ReactNode }) {
  const points = (series ?? []).filter((point): point is number => typeof point === "number");
  return (
    <div className="voom-card min-w-0 p-5">
      <div className="flex items-start gap-3.5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name={icon} size={19} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-text">{label}</div>
          <div className="mt-1 flex items-end justify-between gap-2">
            <span className="text-[28px] font-bold leading-none tracking-[-0.03em] text-text">{value === null ? "—" : compact(value)}</span>
            {points.length > 1 && <Sparkline points={points} />}
          </div>
          <div className="mt-2 text-[12px] font-semibold text-text-2">{value === null ? <span className="font-normal text-text-3">Not reported for this window</span> : note}</div>
        </div>
      </div>
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const width = 84;
  const height = 30;
  const max = Math.max(...points, 1);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${((index / (points.length - 1)) * width).toFixed(1)},${(height - 2 - (point / max) * (height - 6)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="shrink-0" aria-hidden="true">
      <path d={`${path} L${width},${height} L0,${height} Z`} fill="var(--brand-soft)" />
      <path d={path} fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function CardTitle({ icon, id, title, hint, action }: { icon: string; id: string; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name={icon} size={16} /></span>
        <div className="min-w-0">
          <h2 id={id} className="text-[16px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-text-2">{hint}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

/** One relative signal, e.g. "1.8× your average". Never a score. */
function Multiple({ multiple }: { multiple: number | null }) {
  const base = "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold";
  if (multiple === null) return <span className={cx(base, "bg-surface-3 text-text-2")}>Not enough data to compare</span>;
  if (multiple >= 1.05) return <span className={cx(base, "bg-[var(--green-soft)] text-[var(--green)]")}>{formatMultiple(multiple)} your average</span>;
  if (multiple <= 0.95) return <span className={cx(base, "bg-[var(--amber-soft)] text-[var(--amber)]")}>{formatMultiple(multiple)} your average</span>;
  return <span className={cx(base, "bg-surface-3 text-text-2")}>Level with your average</span>;
}

/**
 * One point per measured item, by publish date, on the account's comparison
 * basis. Items without a value on that basis are skipped, never drawn as 0.
 */
function OverTime({ report, items }: { report: PerformanceReport; items: PerformanceItemView[] }) {
  const points = items.filter((item) => item.basisValue !== null).map((item) => ({ item, value: item.basisValue as number }));
  const width = 720;
  const height = 220;
  const max = Math.max(1, ...points.map((point) => point.value));
  const xy = points.map((point, index) => ({
    ...point,
    x: points.length === 1 ? width / 2 : (index / (points.length - 1)) * width,
    y: height - 16 - (point.value / max) * (height - 40),
  }));
  const line = xy.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const last = xy[xy.length - 1];
  return (
    <section className="voom-card min-w-0 p-5 sm:p-6" aria-labelledby="perf-over-time">
      <CardTitle
        icon="trend"
        id="perf-over-time"
        title="Performance over time"
        hint={report.basis ? `${capitalise(report.basis.label)}, per published Instagram item, by publish date.` : "Measured items, by publish date."}
        action={report.basis && <span className="rounded-full bg-[var(--brand)] px-3 py-1 text-[12.5px] font-semibold text-white">{report.basis.key === "engagement" ? "Engagement" : PERFORMANCE_METRIC_LABELS[report.basis.key]}</span>}
      />
      {xy.length > 1 ? (
        <figure className="mt-5">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[220px] w-full overflow-visible" role="img"
            aria-label={`Per item: ${points.map((point) => `${point.item.title} ${point.value}`).join(", ")}`}>
            <defs>
              <linearGradient id="perf-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#8b6cf5" stopOpacity="0.25" />
                <stop offset="1" stopColor="#8b6cf5" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75, 1].map((step) => <line key={step} x1="0" x2={width} y1={height - 16 - step * (height - 40)} y2={height - 16 - step * (height - 40)} stroke="var(--line)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
            <path d={`${line} L${last.x},${height} L${xy[0].x},${height} Z`} fill="url(#perf-fill)" />
            <path d={line} fill="none" stroke="var(--brand)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {xy.map((point) => <circle key={point.item.instagramMediaId} cx={point.x} cy={point.y} r="3.5" fill="#fff" stroke="var(--brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
          </svg>
          <figcaption className="mt-2 flex justify-between gap-3 text-[12px] text-text-3">
            <span>{formatLocalDate(points[0].item.publishedAt)}</span>
            <span>{points.length} measured items · max {formatNumber(max)}</span>
            <span>{formatLocalDate(points[points.length - 1].item.publishedAt)}</span>
          </figcaption>
        </figure>
      ) : (
        <p className="mt-5 rounded-[14px] bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-text-2">
          Not enough measured items share one comparable metric to draw a line yet. {report.measuredItems} measured so far.
        </p>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-text-3">
        {report.trend
          ? `Last ${report.trend.recentDays} days: ${report.trend.recentSample} item${report.trend.recentSample === 1 ? "" : "s"} vs ${report.trend.previousSample} the week before.`
          : "No week-over-week comparison yet — Voom needs real numbers in both windows before it calls anything a trend."}
        {" "}A point Meta returned no value for is left out — never drawn as zero.
      </p>
    </section>
  );
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The MARA insight panel: the same measured statements the planner receives,
 * with the sample they come from. When there is no provable statement, it says
 * so rather than showing an optimistic placeholder.
 */
function MaraInsight({ report }: { report: PerformanceReport }) {
  const has = Boolean(report.headline || report.signals.length);
  return (
    <section className="voom-card flex min-w-0 flex-col p-5 sm:p-6" aria-labelledby="perf-insight">
      <div className="flex items-center gap-3">
        <span className="voom-create-btn grid h-10 w-10 shrink-0 place-items-center rounded-[12px] text-white"><Icon name="sparkles" size={18} /></span>
        <div className="min-w-0">
          <h2 id="perf-insight" className="text-[16px] font-semibold text-text">Performance intelligence</h2>
          <p className="text-[12.5px] text-text-2">{report.confidence === "moderate" ? "Moderate confidence" : report.confidence === "low" ? "Low confidence" : "Not enough data yet"} · {report.measuredItems} measured item{report.measuredItems === 1 ? "" : "s"}</p>
        </div>
      </div>
      <div className="mt-4 rounded-[16px] bg-[var(--brand-soft-2)] p-4">
        {has ? <>
          {report.headline && <p className="text-[14.5px] font-semibold leading-snug text-[var(--brand-ink)]">{report.headline}</p>}
          {report.signals.length > 0 && <ul className="mt-2.5 space-y-2">
            {report.signals.map((signal) => <li key={signal} className="flex gap-2 text-[13px] leading-relaxed text-text-2"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand)]" />{signal}</li>)}
          </ul>}
        </> : <p className="text-[13px] leading-relaxed text-text-2">MARA has no measured statement to make yet. It needs at least 3 measured items that share a comparable metric.</p>}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-text-3">
        MARA reads exactly these measured signals — with the sample size and confidence — when it plans your next 7 days.
        They are advisory evidence, never a rule.
      </p>
      <Link href="/app/plan" className={cx(BTN.outline, "mt-auto w-full")} style={{ marginTop: "1rem" }}>Open Marketing Plan <Icon name="arrow" size={14} /></Link>
    </section>
  );
}

function ChannelTable({ report, engagement, reach, follows, youTube, youTubeWithNumbers }: {
  report: PerformanceReport;
  engagement: number | null;
  reach: number | null;
  follows: number | null;
  youTube: YouTubePerformanceVideo[] | null;
  youTubeWithNumbers: YouTubePerformanceVideo[];
}) {
  const ytViews = total(youTubeWithNumbers.map((video) => video.metrics.views));
  const ytEngagement = total(youTubeWithNumbers.flatMap((video) => [video.metrics.likes, video.metrics.comments]));
  const cell = (value: number | null) => value === null ? <span className="text-text-3">—</span> : compact(value);
  return (
    <section className="voom-card min-w-0 p-5 sm:p-6" aria-labelledby="perf-channels">
      <CardTitle icon="share" id="perf-channels" title="Channel performance" hint={`How each channel did over the last ${report.windowDays} days. A dash means the provider returned no number.`} />
      <div className="mt-4">
        <table className="w-full table-fixed text-left text-[13px] sm:text-[13.5px]">
          <thead>
            <tr className="border-b border-line text-[12.5px] text-text-2">
              <th className="w-[34%] py-2.5 pr-2 font-semibold sm:w-auto">Channel</th>
              <th className="px-2 py-2.5 text-right font-semibold sm:px-3">Posts</th>
              <th className="px-2 py-2.5 text-right font-semibold sm:px-3">Reach</th>
              <th className="hidden px-3 py-2.5 text-right font-semibold sm:table-cell">Views</th>
              <th className="px-2 py-2.5 text-right font-semibold sm:px-3">Engagement</th>
              <th className="hidden py-2.5 pl-3 text-right font-semibold sm:table-cell">New followers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="py-3 pr-2"><span className="flex min-w-0 items-center gap-2 truncate font-semibold text-text"><ChannelGlyph channel="instagram" size={22} />Instagram</span></td>
              <td className="px-2 py-3 text-right sm:px-3 tabular-nums">{report.measuredItems}</td>
              <td className="px-2 py-3 text-right sm:px-3 tabular-nums">{cell(reach)}</td>
              <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{cell(total(report.items.map((item) => item.metrics.views)))}</td>
              <td className="px-2 py-3 text-right sm:px-3 tabular-nums">{cell(engagement)}</td>
              <td className="hidden py-3 pl-3 text-right tabular-nums sm:table-cell">{cell(follows)}</td>
            </tr>
            <tr>
              <td className="py-3 pr-2"><span className="flex min-w-0 items-center gap-2 truncate font-semibold text-text"><ChannelGlyph channel="youtube" size={22} />YouTube</span></td>
              {youTubeWithNumbers.length ? <>
                <td className="px-2 py-3 text-right sm:px-3 tabular-nums">{youTubeWithNumbers.length}</td>
                <td className="px-2 py-3 text-right sm:px-3"><span className="text-text-3">—</span></td>
                <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{cell(ytViews)}</td>
                <td className="px-2 py-3 text-right sm:px-3 tabular-nums">{cell(ytEngagement)}</td>
                <td className="hidden py-3 pl-3 text-right sm:table-cell"><span className="text-text-3">—</span></td>
              </> : <td colSpan={5} className="py-3 pl-3 text-right text-[12.5px] text-text-3">
                {youTube === null ? "YouTube performance could not be read right now. Nothing is estimated in its place." : "No published YouTube video has returned statistics yet."}
              </td>}
            </tr>
            <tr>
              <td className="py-3 pr-2"><span className="flex min-w-0 items-center gap-2 truncate font-semibold text-text"><ChannelGlyph channel="tiktok" size={22} />TikTok</span></td>
              <td colSpan={5} className="py-3 pl-3 text-right text-[12.5px] text-text-3">Unavailable — <Link href="/app/tiktok" className="font-semibold text-[var(--brand-ink)] hover:underline">open TikTok</Link></td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="mt-4 space-y-1.5 text-[12px] leading-relaxed text-text-3">
        <li>Instagram: Meta Insights, read per published media id.</li>
        <li>YouTube: views, likes and comments per published video, from the official YouTube Data API. <Link href="/app/youtube" className="font-semibold text-[var(--brand-ink)] hover:underline">Open YouTube</Link></li>
        <li>TikTok performance data is unavailable through Voom&apos;s connection — and none is invented here. Voom asks TikTok only for publishing access, so check TikTok&apos;s own analytics for views and engagement.</li>
      </ul>
    </section>
  );
}

function BestContent({ report }: { report: PerformanceReport }) {
  const ranked = [...report.items].filter((item) => item.basisValue !== null).sort((a, b) => (b.basisValue ?? 0) - (a.basisValue ?? 0)).slice(0, 4);
  return (
    <section className="voom-card min-w-0 p-5 sm:p-6" aria-labelledby="perf-best">
      <CardTitle icon="fire" id="perf-best" title="Best-performing recent content" hint={report.basis ? `Ranked on ${report.basis.label}.` : "Ranked once items share a comparable metric."}
        action={<Link href="/app/content" className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--brand-ink)] hover:underline">All content <Icon name="arrow" size={13} /></Link>} />
      {ranked.length ? (
        <ul className="mt-4 flex flex-col gap-2.5">
          {ranked.map((item) => (
            <li key={item.instagramMediaId} className="flex min-w-0 items-center gap-3 rounded-[14px] border border-line px-3.5 py-3">
              <ChannelGlyph channel="instagram" size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-text">{item.title}</span>
                <span className="block text-[12px] text-text-2">{item.contentTypeLabel} · {formatLocalDate(item.publishedAt)}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[16px] font-bold tabular-nums text-text">{formatNumber(item.basisValue as number)}</span>
                <span className="block text-[11.5px] text-text-3">{report.basis?.key === "engagement" ? "engagements" : report.basis ? PERFORMANCE_METRIC_LABELS[report.basis.key].toLowerCase() : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-4 text-[13.5px] leading-relaxed text-text-2">No measured content to rank in this window yet.</p>}
      {report.best && <p className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-text-3">Top item: <Multiple multiple={report.best.multiple} /></p>}
    </section>
  );
}

function WorkingContent({ report }: { report: PerformanceReport }) {
  const sections = [
    { title: "By content type", groups: report.byContentType },
    { title: "By topic", groups: report.byTopic },
    { title: "By purpose", groups: report.byPurpose },
  ].filter((section) => section.groups.some((group) => group.multiple !== null));
  if (!sections.length) return null;
  return (
    <section className="voom-card mb-5 p-5 sm:p-6" aria-labelledby="perf-working">
      <CardTitle icon="target" id="perf-working" title="What is working" hint="Each line compares that group of your own published content with the rest of it." />
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {sections.map((section) => (
          <div key={section.title} className="min-w-0">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-text-3">{section.title}</h3>
            <div className="mt-2 space-y-2">
              {section.groups.filter((group) => group.multiple !== null).map((group) => <GroupRow key={`${section.title}:${group.key}`} group={group} />)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-text-3">Groups with fewer than 2 measured items are left out, and a comparison is only shown when the average it is measured against is large enough to mean something.</p>
    </section>
  );
}

function GroupRow({ group }: { group: PerformanceGroupView }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-[12px] border border-line px-3 py-2.5">
      <b className="min-w-0 truncate text-[13.5px] font-semibold text-text">{group.label}</b>
      <span className="text-[12px] text-text-3">{group.sampleSize} item{group.sampleSize === 1 ? "" : "s"} · avg {formatNumber(group.average)}</span>
      <span className="ml-auto"><Multiple multiple={group.multiple} /></span>
    </div>
  );
}

function RecentContent({ report }: { report: PerformanceReport }) {
  const items = report.items.slice(0, 10);
  return (
    <section className="voom-card mb-5 p-5 sm:p-6" aria-labelledby="perf-recent">
      <CardTitle icon="ig" id="perf-recent" title="Recent published content" action={<span className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[12px] font-semibold text-text-2">{report.items.length} measured</span>} />
      <ul className="mt-4 divide-y divide-line">
        {items.map((item) => (
          <li key={item.instagramMediaId} className="min-w-0 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <b className="min-w-0 flex-1 truncate text-[14px] font-semibold text-text">{item.title}</b>
              <Multiple multiple={item.multiple} />
            </div>
            <div className="mt-0.5 text-[12px] text-text-3">
              {item.contentTypeLabel} · Published {formatLocalDate(item.publishedAt)}{item.topic ? ` · ${item.topic}` : ""} · {item.purposeLabel}
              {item.engagementRate !== null && ` · ${formatRate(item.engagementRate)} engagement rate on reach`}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.availableMetrics.map((metric) => <span key={metric} className="rounded-[8px] bg-surface-2 px-2.5 py-1 text-[12px] text-text-2">
                {PERFORMANCE_METRIC_LABELS[metric]} <b className="tabular-nums text-text">{formatNumber(item.metrics[metric] ?? 0)}</b>
              </span>)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyPerformanceState({ report }: { report: PerformanceReport }) {
  const waiting = report.emptyReason === "no_metrics_yet";
  return (
    <section className="voom-card mb-5 flex flex-col items-start gap-3 p-6 sm:flex-row sm:items-center" aria-label="No measured results yet">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name={waiting ? "clock" : "trend"} size={20} /></span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[16px] font-semibold text-text">{waiting ? "Published, but no metrics yet" : "No published content to measure yet"}</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-text-2">
          {waiting
            ? `Voom has published ${report.publishedItems} item${report.publishedItems === 1 ? "" : "s"} in the last ${report.windowDays} days. Meta has not returned performance metrics for them yet — Voom checks on a schedule and shows real numbers the moment they arrive.`
            : "Voom measures only content it has actually published and Meta has confirmed with a real media id. Approve and schedule content from your plan and its real results will appear here."}
        </p>
      </div>
      <Link href={waiting ? "/app/calendar" : "/app/plan"} className={BTN.outline}>{waiting ? "Open calendar" : "Open Marketing Plan"}</Link>
    </section>
  );
}

function formatRate(rate: number): string {
  const percent = rate * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
