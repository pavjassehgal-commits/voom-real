import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { Icon } from "@/components/voom/icons";
import type { PerformanceReport } from "@/lib/performance/insights";
import type { AutomationModeValue } from "@/lib/voom/automation";
import { cx } from "@/lib/voom/cx";
import { compactNumber, type TodayMetrics } from "@/lib/voom/today-metrics";
import type { TodayCoverageDay, TodayItem } from "@/lib/voom/today-view";
import { DismissibleNotice, QuickCreate } from "./TodayClient";

type View = {
  coverage: { state: "covered" | "gaps" | "active" | "empty"; title: string; detail: string };
  attention: { state: "action" | "clear"; title: string; detail: string; href: string };
  next: TodayItem | null;
  days: TodayCoverageDay[];
  coordinatorInsight: { title: string; description: string } | null;
};

export type TodayChannel = {
  id: "instagram" | "tiktok" | "youtube" | "email";
  name: string;
  href: string;
  state: "connected" | "not_connected" | "ready" | "not_set_up" | "unavailable";
};

export type TodayContentCard = {
  draftId: string;
  concept: string;
  channel: string;
  channelLabel: string;
  contentTypeLabel: string;
  when: string;
  status: string;
  statusLabel: string;
  mediaPreviewUrl: string | null;
  stats: { likes: number | null; comments: number | null; shares: number | null } | null;
};

type Idea = { draftId: string; concept: string; contentType: string; channel: string };

/**
 * Today — redesign Batch 1 (Figma "15 — Today · Dashboard home", PDF p.52).
 *
 * Every figure is real: workflow snapshot, coordinator gaps, stored
 * performance measurements and connection rows. Where the reference shows
 * data Voom does not store (followers, unsupported networks) the card is
 * omitted or shows a truthful empty state — never a mock value.
 *
 * Mobile priority (single column): coverage/attention notices, Next up,
 * This week, Engagement, Performance, MARA, Channels, Quick create, Recent
 * content. From 1380px the reference's three-column composition applies;
 * between `md` and that width a two-column layout keeps every card legible.
 */
export function TodayDashboard({
  firstName,
  greeting,
  dateLabel,
  weekNumber,
  view,
  performance,
  metrics,
  ideas,
  ideaCount,
  channels,
  recent,
  automationMode,
}: {
  firstName: string;
  greeting: string;
  dateLabel: string;
  weekNumber: number;
  view: View;
  performance: PerformanceReport;
  metrics: TodayMetrics;
  ideas: Idea[];
  ideaCount: number;
  channels: TodayChannel[];
  recent: TodayContentCard[];
  automationMode: AutomationModeValue;
}) {
  const todayCount = view.days[0]?.items.length ?? 0;
  return (
    <div className="today-v3 relative flex min-w-0 flex-col gap-5">
      <header className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-[clamp(1.75rem,3.2vw,2.25rem)] font-bold leading-[1.1] tracking-[-0.04em] text-text">
            {greeting}, {firstName}
          </h1>
          <p className="mt-1 text-[15.5px] text-text-2 sm:text-[17px]">Here’s what’s happening with your content today.</p>
        </div>
        <Link href="/app/calendar" className="voom-card flex min-w-0 items-center gap-3.5 px-5 py-3.5 transition hover:border-[var(--line-2)] lg:min-w-[300px]">
          <Icon name="cal" size={20} className="shrink-0 text-text-2" />
          <span className="min-w-0">
            <span className="block truncate text-[14.5px] font-semibold text-text">{dateLabel}</span>
            <span className="block truncate text-[13px] text-text-2">Week {weekNumber} · {todayCount} post{todayCount === 1 ? "" : "s"} scheduled today</span>
          </span>
        </Link>
      </header>

      <Notices view={view} />

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 md:grid-flow-row-dense md:grid-cols-2 wide:grid-flow-row wide:grid-cols-[minmax(0,0.92fr)_minmax(0,1.3fr)_minmax(0,1fr)] wide:items-start">
        {/* Left column (xl): Engagement, MARA */}
        <div className="contents wide:flex wide:min-w-0 wide:flex-col wide:gap-5">
          <div className="order-3 min-w-0"><EngagementCard metrics={metrics} /></div>
          <div className="order-5 min-w-0"><MaraCard ideas={ideas} ideaCount={ideaCount} insight={view.coordinatorInsight} automationMode={automationMode} /></div>
        </div>
        {/* Middle column (xl): Next up, This week */}
        <div className="contents wide:flex wide:min-w-0 wide:flex-col wide:gap-5">
          <div className="order-1 min-w-0 md:col-span-2 wide:col-span-1"><NextUpCard item={view.next} /></div>
          <div className="order-2 min-w-0 md:col-span-2 wide:col-span-1"><WeekCard days={view.days} /></div>
        </div>
        {/* Right column (xl): Channels, Quick create */}
        <div className="contents wide:row-span-2 wide:flex wide:min-w-0 wide:flex-col wide:gap-5">
          <div className="order-6 min-w-0"><ChannelsCard channels={channels} /></div>
          <div className="order-7 min-w-0">
            <section className="voom-card p-5 sm:p-6" aria-labelledby="today-quick-create">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-[11px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name="plus" size={17} /></span>
                <h2 id="today-quick-create" className="text-[16px] font-semibold tracking-[-0.01em] text-text">Quick create</h2>
              </div>
              <QuickCreate />
            </section>
          </div>
        </div>
        {/* Performance spans the left and middle columns (xl). */}
        <div className="order-4 min-w-0 md:col-span-2"><PerformanceCard report={performance} metrics={metrics} /></div>
        <div className="order-8 min-w-0 md:col-span-2 wide:col-span-3"><RecentCard items={recent} /></div>
      </div>
    </div>
  );
}

/** Coverage gaps and items needing the user — real workflow/coordinator state only. */
function Notices({ view }: { view: View }) {
  const notices: { id: string; title: string; detail: string; href: string; cta: string }[] = [];
  if (view.attention.state === "action") {
    notices.push({ id: `attention-${view.days[0]?.date ?? ""}`, title: view.attention.title, detail: view.attention.detail, href: view.attention.href, cta: view.attention.href === "/app/approvals" ? "Review approvals" : "Open calendar" });
  }
  if (view.coverage.state === "gaps" || view.coverage.state === "empty") {
    notices.push({ id: `coverage-${view.days[0]?.date ?? ""}`, title: view.coverage.title, detail: view.coverage.detail, href: "/app/plan", cta: "Review marketing plan" });
  }
  if (!notices.length) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Needs you">
      {notices.map((notice) => (
        <DismissibleNotice key={notice.id} id={notice.id}>
          <div className="flex flex-col gap-3 rounded-[18px] bg-[var(--coral-soft)] px-5 py-4 pr-14 sm:flex-row sm:items-center sm:justify-between sm:pr-20">
            <p className="flex min-w-0 gap-3 text-[14.5px] leading-relaxed text-text">
              <span className="mt-[9px] h-2 w-2 shrink-0 rounded-full bg-[var(--coral)]" aria-hidden="true" />
              <span><b className="font-semibold">{notice.title}</b> <span className="text-text-2">{notice.detail}</span></span>
            </p>
            <Link href={notice.href} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 self-start rounded-[12px] border border-[var(--brand-line)] bg-surface px-5 text-[14px] font-semibold text-[var(--brand-ink)] transition hover:bg-[var(--brand-soft-2)] sm:self-auto">
              {notice.cta} <Icon name="arrow" size={15} />
            </Link>
          </div>
        </DismissibleNotice>
      ))}
    </section>
  );
}

function EngagementCard({ metrics }: { metrics: TodayMetrics }) {
  const has = metrics.engagement !== null;
  return (
    <Link href="/app/performance" className="voom-hero-card block overflow-hidden rounded-[22px] p-5 text-white shadow-[0_18px_40px_-24px_rgba(58,42,122,.9)] transition hover:brightness-[1.04] sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-medium text-white/85">Engagement</span>
        <span className="rounded-full border border-white/25 px-2.5 py-0.5 text-[12px] font-medium text-white/90">7D</span>
      </div>
      <div className="mt-3 text-[clamp(2.4rem,4.6vw,3.2rem)] font-bold leading-none tracking-[-0.045em]">
        {has ? compactNumber(metrics.engagement as number) : "—"}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 text-[13px]">
        {metrics.engagementChangePct !== null && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/12 px-3 py-1">
            <Icon name="arrowUp" size={13} className={metrics.engagementChangePct < 0 ? "rotate-180" : ""} />
            {Math.abs(metrics.engagementChangePct)}%
          </span>
        )}
        <span className="rounded-full bg-white/12 px-3 py-1">{has ? "Last 7 days" : "No measured posts in the last 7 days"}</span>
      </div>
    </Link>
  );
}

function MaraCard({ ideas, ideaCount, insight, automationMode }: { ideas: Idea[]; ideaCount: number; insight: View["coordinatorInsight"]; automationMode: AutomationModeValue }) {
  return (
    <section className="voom-card p-5 sm:p-6" aria-labelledby="today-mara">
      <div className="flex items-center gap-3">
        <span className="voom-create-btn grid h-11 w-11 shrink-0 place-items-center rounded-[13px] text-white"><Icon name="sparkle" size={17} /></span>
        <div className="min-w-0">
          <h2 id="today-mara" className="text-[16px] font-semibold leading-tight text-text">MARA</h2>
          <p className="text-[13.5px] text-text-2">Your AI marketing manager</p>
        </div>
      </div>
      {/* The saved automation mode, changed through the one existing endpoint. */}
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-text-3">Automation</span>
        <AutomationMode compact showPlanSummary={false} initial={automationMode} />
      </div>
      <div className="mt-5 rounded-[18px] bg-[var(--brand-soft-2)] p-3 sm:p-4">
        {ideaCount > 0 ? <>
          <p className="px-1 text-[14.5px] leading-snug text-text">I’ve prepared {ideaCount} content idea{ideaCount === 1 ? "" : "s"} for your review.</p>
          <ul className="mt-3 overflow-hidden rounded-[14px] border border-line bg-surface">
            {ideas.map((idea) => (
              <li key={idea.draftId} className="border-b border-line last:border-b-0">
                <Link href="/app/approvals" className="flex items-center gap-3 px-3 py-3 transition hover:bg-surface-2">
                  <ChannelGlyph channel={idea.channel} size={22} />
                  <span className="min-w-0 flex-1 text-[14px] leading-snug text-text line-clamp-2">{idea.concept}</span>
                  <Icon name="chevR" size={16} className="shrink-0 text-text-3" />
                </Link>
              </li>
            ))}
          </ul>
        </> : insight ? <div className="px-1">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-text-3">MARA insight</p>
          <p className="mt-1 text-[14.5px] font-semibold leading-snug text-text">{insight.title}</p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-2 line-clamp-4">{insight.description}</p>
        </div> : <p className="px-1 text-[14px] leading-relaxed text-text-2">Nothing needs your review right now. MARA will surface new ideas and measured opportunities here.</p>}
        <Link href="/app/plan" className="mt-4 flex h-11 items-center justify-center gap-2 rounded-[13px] border border-[var(--brand-line)] bg-surface text-[14px] font-semibold text-[var(--brand-ink)] transition hover:bg-[var(--brand-soft)]">
          View MARA’s plan <Icon name="arrow" size={15} />
        </Link>
      </div>
    </section>
  );
}

function CardHead({ icon, title, id, href, cta }: { icon: string; title: string; id: string; href?: string; cta?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-[11px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name={icon} size={17} /></span>
        <h2 id={id} className="text-[16px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
      </div>
      {href && cta && (
        <Link href={href} className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[var(--brand-ink)] transition hover:opacity-80">
          {cta} <Icon name="arrow" size={14} />
        </Link>
      )}
    </div>
  );
}

function NextUpCard({ item }: { item: TodayItem | null }) {
  return (
    <section className="voom-card p-5 sm:p-6" aria-labelledby="today-next-up">
      <CardHead icon="cal" title="Next up" id="today-next-up" href="/app/calendar" cta="View calendar" />
      {item ? (
        <Link href="/app/calendar" className="mt-4 block rounded-[18px] border border-line p-4 transition hover:border-[var(--line-2)]">
          <div className="flex min-w-0 gap-4">
            <div className="relative h-[92px] w-[112px] shrink-0 overflow-hidden rounded-[14px] bg-surface-3">
              {item.mediaPreviewUrl
                ? <Image src={item.mediaPreviewUrl} alt="" fill unoptimized className="object-cover" />
                : <div className="grid h-full place-items-center text-[11px] font-medium text-text-3">Visual not ready</div>}
              <span className="absolute bottom-1.5 left-1.5"><ChannelGlyph channelLabel={item.channelLabel} size={22} /></span>
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="line-clamp-2 text-[17px] font-semibold leading-snug tracking-[-0.015em] text-text">{item.concept}</h3>
              <p className="mt-1 text-[14px] text-text-2">{item.channelLabel} {item.contentTypeLabel}</p>
              <p className="mt-1.5 text-[14px] text-text-2">{item.dayLabel ?? item.localDate}, {item.localTime}</p>
            </div>
          </div>
          <div className="mt-4"><StatusChip status={item.status} label={item.statusLabel ?? item.status} /></div>
          {item.caption && <p className="mt-3 line-clamp-2 text-[14px] leading-relaxed text-text-2">{item.caption}</p>}
        </Link>
      ) : (
        <div className="mt-4 rounded-[18px] border border-dashed border-line-2 p-5">
          <h3 className="text-[15px] font-semibold text-text">Nothing is scheduled next.</h3>
          <p className="mt-1 text-[13.5px] text-text-2">Your calendar will show the next committed item here.</p>
        </div>
      )}
    </section>
  );
}

function WeekCard({ days }: { days: TodayCoverageDay[] }) {
  return (
    <section className="voom-card p-5 sm:p-6" aria-labelledby="today-week">
      <CardHead icon="cal" title="This week" id="today-week" href="/app/calendar" cta="View calendar" />
      <ol className="mt-5 grid grid-cols-7 gap-1 sm:gap-2" aria-label="Posts committed over the next seven days">
        {days.map((day, index) => {
          const count = day.items.length;
          return (
            <li key={day.date} className={cx("flex min-w-0 flex-col items-center rounded-[16px] px-0.5 py-3 text-center", index === 0 && "border border-[var(--brand-line)] bg-[var(--brand-soft-2)]")} aria-current={index === 0 ? "date" : undefined}>
              <Bars count={count} />
              <span className="mt-3 text-[13px] font-semibold text-text sm:text-[14px]">{day.weekday}</span>
              <span className="text-[11.5px] text-text-3 sm:text-[12.5px]">{day.monthDay}</span>
              <span className={cx("mt-3 text-[18px] font-bold leading-none", count ? "text-text" : "text-text-3")}>{count}</span>
              <span className="mt-1 text-[11.5px] text-text-3">{count === 1 ? "post" : "posts"}</span>
              <span className="mt-2.5 flex min-h-[22px] flex-wrap justify-center gap-1">
                {count ? uniqueChannels(day.items).map((label) => <ChannelGlyph key={label} channelLabel={label} size={18} />)
                  : <Link href="/app/plan" aria-label={`Plan content for ${day.weekday} ${day.monthDay}`} className="grid h-[22px] w-[22px] place-items-center rounded-full border border-dashed border-line-2 text-text-3 transition hover:border-[var(--brand-line)] hover:text-[var(--brand-ink)]"><Icon name="plus" size={12} /></Link>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Three-step bar glyph: filled steps = posts committed that day (max 3). */
function Bars({ count }: { count: number }) {
  return (
    <span className="flex h-7 items-end gap-[3px]" aria-hidden="true">
      {[0.45, 0.7, 1].map((height, step) => (
        <span key={step} className={cx("w-[5px] rounded-full", step < count ? "bg-[#8b6cf5]" : "bg-[var(--brand-tile)]")} style={{ height: `${height * 100}%` }} />
      ))}
    </span>
  );
}

function ChannelsCard({ channels }: { channels: TodayChannel[] }) {
  return (
    <section className="voom-card p-5 sm:p-6" aria-labelledby="today-channels">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-[11px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name="share" size={17} /></span>
          <h2 id="today-channels" className="text-[16px] font-semibold tracking-[-0.01em] text-text">Channels</h2>
        </div>
        <Link href="/app/connections" className="text-[13.5px] font-medium text-[var(--brand-ink)] transition hover:opacity-80">Manage</Link>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        {channels.map((channel) => (
          <Link key={channel.id} href={channel.href} className="voom-tile min-w-0 p-3 transition hover:border-[var(--line-2)]">
            <span className="flex min-w-0 items-center gap-2.5">
              <ChannelGlyph channel={channel.id} size={26} />
              <span className="truncate text-[14px] font-semibold text-text">{channel.name}</span>
            </span>
            <span className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-text-2">
              <span className={cx("h-1.5 w-1.5 rounded-full", channel.state === "connected" || channel.state === "ready" ? "bg-[var(--green-dot)]" : "bg-text-3")} aria-hidden="true" />
              {CHANNEL_STATE[channel.state]}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

const CHANNEL_STATE: Record<TodayChannel["state"], string> = {
  connected: "Connected",
  not_connected: "Not connected",
  ready: "Ready",
  not_set_up: "Not set up",
  unavailable: "Status unavailable",
};

function PerformanceCard({ report, metrics }: { report: PerformanceReport; metrics: TodayMetrics }) {
  const tiles = [
    { label: "Engagement", value: metrics.engagement },
    { label: "Reach", value: metrics.reach },
    { label: "Views", value: metrics.views },
  ].filter((tile) => tile.value !== null) as { label: string; value: number }[];
  const hasSignal = tiles.length > 0;
  return (
    <section className="voom-card p-5 sm:p-6" aria-labelledby="today-performance">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-[11px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name="bars" size={17} /></span>
          <h2 id="today-performance" className="text-[16px] font-semibold tracking-[-0.01em] text-text">Performance</h2>
        </div>
        <Link href="/app/performance" className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[var(--brand-ink)] transition hover:opacity-80">Last 7 days <Icon name="arrow" size={14} /></Link>
      </div>
      {hasSignal ? <>
        <div className="today-perf-tiles mt-4 grid gap-2.5" style={{ ["--tiles" as string]: tiles.length }}>
          {tiles.map((tile) => (
            <div key={tile.label} className="voom-tile px-4 py-3">
              <div className="text-[20px] font-bold leading-tight tracking-[-0.03em] text-text">{compactNumber(tile.value)}</div>
              <div className="text-[12.5px] text-text-2">{tile.label}</div>
              {tile.label === "Engagement" && metrics.engagementChangePct !== null && (
                <div className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-semibold text-text">
                  <Icon name="arrowUp" size={12} className={metrics.engagementChangePct < 0 ? "rotate-180" : ""} />{Math.abs(metrics.engagementChangePct)}%
                </div>
              )}
            </div>
          ))}
        </div>
        <EngagementChart daily={metrics.daily} />
        <p className="mt-2 text-[12px] text-text-3">Measured on posts published in the last 7 days, by publish date. {metrics.measuredPosts} measured post{metrics.measuredPosts === 1 ? "" : "s"}.</p>
      </> : (
        <div className="mt-4 rounded-[16px] border border-dashed border-line-2 p-5">
          <h3 className="text-[15px] font-semibold text-text">Performance is learning.</h3>
          <p className="mt-1 text-[13.5px] leading-relaxed text-text-2">
            {report.headline ?? "Voom will show measured results here once published content in the last 7 days has real metrics."}
          </p>
        </div>
      )}
    </section>
  );
}

/** Smooth line over real daily engagement totals (no interpolation of values). */
function EngagementChart({ daily }: { daily: TodayMetrics["daily"] }) {
  const width = 700;
  const height = 120;
  const max = Math.max(1, ...daily.map((day) => day.value));
  const points = daily.map((day, index) => ({
    x: (index / Math.max(1, daily.length - 1)) * width,
    y: height - 12 - (day.value / max) * (height - 28),
  }));
  const line = points.reduce((path, point, index) => {
    if (index === 0) return `M${point.x},${point.y}`;
    const prev = points[index - 1];
    const mid = (prev.x + point.x) / 2;
    return `${path} C${mid},${prev.y} ${mid},${point.y} ${point.x},${point.y}`;
  }, "");
  return (
    <figure className="mt-5">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[120px] w-full overflow-visible" role="img" aria-label={`Engagement by publish date: ${daily.map((day) => `${day.weekday} ${day.value}`).join(", ")}`}>
        <defs>
          <linearGradient id="today-perf-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#8b6cf5" stopOpacity="0.22" />
            <stop offset="1" stopColor="#8b6cf5" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${width},${height} L0,${height} Z`} fill="url(#today-perf-fill)" />
        <path d={line} fill="none" stroke="#6b4ef6" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      </svg>
      <figcaption className="mt-2 grid grid-cols-7 text-[12px] text-text-3">
        {daily.map((day, index) => <span key={day.date} className={cx(index === 0 ? "text-left" : index === daily.length - 1 ? "text-right" : "text-center")}>{day.weekday}</span>)}
      </figcaption>
    </figure>
  );
}

function RecentCard({ items }: { items: TodayContentCard[] }) {
  return (
    <section className="voom-card p-5 sm:p-6" aria-labelledby="today-recent">
      <CardHead icon="file" title="Recent content" id="today-recent" href="/app/calendar" cta="View all content" />
      {items.length ? (
        <ul className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 wide:grid-cols-4">
          {items.map((item) => (
            <li key={item.draftId} className="min-w-0">
              <Link href="/app/calendar" className="flex h-full min-w-0 gap-3 rounded-[16px] border border-line p-2.5 transition hover:border-[var(--line-2)]">
                <div className="relative h-[84px] w-[84px] shrink-0 overflow-hidden rounded-[12px] bg-surface-3">
                  {item.mediaPreviewUrl
                    ? <Image src={item.mediaPreviewUrl} alt="" fill unoptimized className="object-cover" />
                    : <div className="grid h-full place-items-center px-1 text-center text-[10.5px] text-text-3">No visual yet</div>}
                  <span className="absolute bottom-1.5 left-1.5"><ChannelGlyph channelLabel={item.channelLabel} size={20} /></span>
                </div>
                <div className="min-w-0 py-0.5">
                  <h3 className="truncate text-[14px] font-semibold text-text">{item.concept}</h3>
                  <p className="mt-0.5 truncate text-[12.5px] text-text-2">{item.when}</p>
                  <div className="mt-1.5"><StatusChip status={item.status} label={item.statusLabel} small /></div>
                  {item.stats && (
                    <div className="mt-1.5 flex gap-3 text-[12px] text-text-2">
                      {item.stats.likes !== null && <span className="inline-flex items-center gap-1"><Icon name="heart" size={12} />{compactNumber(item.stats.likes)}</span>}
                      {item.stats.comments !== null && <span className="inline-flex items-center gap-1"><Icon name="comment" size={12} />{compactNumber(item.stats.comments)}</span>}
                      {item.stats.shares !== null && <span className="inline-flex items-center gap-1"><Icon name="upload" size={12} />{compactNumber(item.stats.shares)}</span>}
                    </div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[14px] text-text-2">No content in this week’s plan yet.</p>
      )}
    </section>
  );
}

function StatusChip({ status, label, small = false }: { status: string; label: string; small?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full font-semibold", small ? "px-2 py-0.5 text-[11.5px]" : "px-3 py-1 text-[13px]", statusTone(status))}>
      {!small && <Icon name="cal" size={13} />}
      {label}
    </span>
  );
}

function statusTone(status: string) {
  if (status === "published") return "bg-[var(--green-soft)] text-[var(--green)]";
  if (["failed", "media_timed_out", "rejected"].includes(status)) return "bg-[var(--red-soft)] text-[var(--red)]";
  if (status === "needs_approval") return "bg-[var(--coral-soft)] text-[var(--coral)]";
  if (["missed", "waiting_for_media", "media_delayed"].includes(status)) return "bg-[var(--amber-soft)] text-[var(--amber)]";
  if (["scheduled", "publishing", "generating", "approved"].includes(status)) return "bg-[var(--blue-soft)] text-[var(--blue)]";
  return "bg-surface-3 text-text-2";
}

function uniqueChannels(items: TodayItem[]) {
  return [...new Set(items.map((item) => item.channelLabel))].slice(0, 3);
}

/** Small network badges (Instagram, TikTok, YouTube, Email) in their own colours. */
function ChannelGlyph({ channel, channelLabel, size = 20 }: { channel?: string; channelLabel?: string; size?: number }) {
  const key = (channel ?? channelLabel ?? "").toLowerCase();
  const kind = key.startsWith("instagram") ? "instagram" : key.startsWith("tiktok") ? "tiktok" : key.startsWith("youtube") ? "youtube" : key.startsWith("email") ? "email" : "other";
  const label = kind === "other" ? channelLabel ?? "Channel" : kind.charAt(0).toUpperCase() + kind.slice(1);
  const frame = (background: string, children: ReactNode) => (
    <span className="grid shrink-0 place-items-center rounded-[6px] ring-2 ring-[var(--surface)]" style={{ width: size, height: size, background }} role="img" aria-label={label}>
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
    </span>
  );
  if (kind === "instagram") return frame("linear-gradient(135deg,#f9a03f 0%,#e1306c 50%,#833ab4 100%)", <><rect x="4" y="4" width="16" height="16" rx="5" /><circle cx="12" cy="12" r="3.6" /><circle cx="16.8" cy="7.2" r="0.9" fill="#fff" stroke="none" /></>);
  if (kind === "tiktok") return frame("#111111", <path d="M14 4v10.5a3.5 3.5 0 11-3.5-3.5M14 4c.6 2.6 2.4 4.1 5 4.3" />);
  if (kind === "youtube") return frame("#ff0033", <path d="M10 8.5l5.5 3.5-5.5 3.5z" fill="#fff" stroke="none" />);
  if (kind === "email") return frame("#2c6fb0", <><rect x="3.5" y="6" width="17" height="12" rx="2" /><path d="M4.5 7.5l7.5 5.5 7.5-5.5" /></>);
  return frame("var(--text-3)", <circle cx="12" cy="12" r="4" />);
}
