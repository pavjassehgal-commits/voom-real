import Link from "next/link";
import Image from "next/image";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { Icon } from "@/components/voom/icons";
import { Card, Tag, VoomMark, cx } from "@/components/voom/ui/primitives";
import type { PerformanceReport } from "@/lib/performance/insights";
import type { AutomationModeValue } from "@/lib/voom/automation";
import type { TodayCoverageDay, TodayItem } from "@/lib/voom/today-view";

type View = {
  coverage: { state: "covered" | "gaps" | "active" | "empty"; title: string; detail: string };
  attention: { state: "action" | "clear"; title: string; detail: string; href: string };
  next: TodayItem | null;
  days: TodayCoverageDay[];
  coordinatorInsight: { title: string; description: string } | null;
};

export function TodayDashboard({
  firstName,
  greeting,
  view,
  performance,
  automationMode,
}: {
  firstName: string;
  greeting: string;
  view: View;
  performance: PerformanceReport;
  automationMode: AutomationModeValue;
}) {
  return (
    <div className="today-v2 relative isolate -mx-2 overflow-hidden rounded-[28px] px-2 pb-3 sm:-mx-3 sm:px-3 lg:-mt-2">
      <TodayAtmosphere />

      <header className="relative z-10 flex min-w-0 flex-col gap-5 pb-5 pt-2 sm:pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-text-3">Today</p>
          <h1 className="font-display text-[clamp(2rem,4vw,3.6rem)] font-semibold leading-[0.98] tracking-[-0.055em] text-text">
            {greeting}, <span className="voom-text-gradient">{firstName}.</span>
          </h1>
          <p className="mt-3 max-w-2xl text-[clamp(1rem,1.8vw,1.28rem)] leading-snug text-text-2">{view.coverage.title}</p>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-text-3">{view.coverage.detail}</p>
        </div>
        <div className="flex w-full min-w-0 items-center justify-between gap-3 rounded-2xl border border-line bg-surface/75 p-2.5 shadow-[var(--shadow-sm)] backdrop-blur-xl sm:w-auto sm:justify-start">
          <span className="hidden text-xs font-semibold text-text-3 sm:inline">Automation</span>
          <AutomationMode compact showPlanSummary={false} initial={automationMode} />
        </div>
      </header>

      <main className="relative z-10 grid min-w-0 gap-3 lg:grid-cols-12 lg:grid-rows-[minmax(190px,1fr)_minmax(170px,.82fr)]">
        <AttentionCard attention={view.attention} />
        <NextUpCard item={view.next} />
        <CoverageCard days={view.days} />
        <PerformanceCard report={performance} />
        <MaraInsightCard insight={view.coordinatorInsight} />
      </main>
    </div>
  );
}

function TodayAtmosphere() {
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[28px]">
    <div className="today-spectrum absolute -right-24 -top-44 h-[430px] w-[620px] opacity-70 blur-[3px]" />
    <div className="today-aurora absolute -left-32 top-[36%] h-[340px] w-[520px] opacity-55 blur-3xl" />
    <div className="today-orbit absolute right-[7%] top-7 hidden h-24 w-24 rounded-full lg:block" />
  </div>;
}

function NextUpCard({ item }: { item: TodayItem | null }) {
  return <Card className="group relative min-w-0 overflow-hidden p-5 sm:p-6 lg:col-span-7 lg:col-start-1 lg:row-start-1">
    <CardHeader icon="cal" title="Next up" href="/app/calendar" />
    {item ? <Link href="/app/calendar" className="mt-4 grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_148px] sm:items-end">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap gap-2">
          <Tag tone="t-brand">{item.channelLabel}</Tag>
          <Tag tone="t-grey">{item.contentTypeLabel}</Tag>
          <Tag tone={statusTone(item.status)}>{item.statusLabel ?? item.status}</Tag>
        </div>
        <h2 className="line-clamp-2 font-display text-xl font-semibold leading-tight tracking-[-0.025em] text-text sm:text-2xl">{item.concept}</h2>
        <p className="mt-3 text-sm font-semibold text-text-2">{item.dayLabel ?? item.localDate} · {item.localTime}</p>
      </div>
      <div className="relative h-28 overflow-hidden rounded-2xl border border-line bg-surface-2 sm:h-32">
        {item.mediaPreviewUrl
          ? <Image src={item.mediaPreviewUrl} alt="" fill unoptimized className="object-cover transition duration-500 group-hover:scale-[1.03]" />
          : <div className="grid h-full place-items-center"><div className="today-media-orb" /><span className="absolute bottom-3 text-[11px] font-semibold text-text-3">Visual not ready</span></div>}
      </div>
    </Link> : <div className="mt-6 flex min-h-28 items-center gap-4">
      <div className="today-media-orb shrink-0" />
      <div><h2 className="font-display text-lg font-semibold">Nothing is scheduled next.</h2><p className="mt-1 text-sm text-text-3">Your Calendar will show the next committed item here.</p></div>
    </div>}
  </Card>;
}

function AttentionCard({ attention }: { attention: View["attention"] }) {
  const clear = attention.state === "clear";
  return <Link href={attention.href} className="block min-w-0 lg:col-span-5 lg:col-start-8 lg:row-start-1">
    <Card className={cx("h-full min-w-0 p-5 sm:p-6", clear ? "today-clear-card" : "today-attention-card")}>
      <div className="flex items-start justify-between gap-3">
        <div className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-2xl", clear ? "bg-[var(--green-soft)] text-green" : "bg-[var(--amber-soft)] text-amber")}>
          <Icon name={clear ? "check" : "warn"} size={19} />
        </div>
        <Icon name="arrow" className="text-text-3" size={17} />
      </div>
      <p className="mt-5 text-[11px] font-bold uppercase tracking-[0.14em] text-text-3">Needs you</p>
      <h2 className="mt-1.5 font-display text-xl font-semibold tracking-[-0.025em] text-text">{attention.title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-text-2">{attention.detail}</p>
    </Card>
  </Link>;
}

function CoverageCard({ days }: { days: TodayCoverageDay[] }) {
  return <Card className="min-w-0 p-5 sm:p-6 lg:col-span-7">
    <CardHeader icon="cal" title="This week" href="/app/plan" />
    <div className="mt-5 grid grid-cols-7 gap-1.5 sm:gap-2.5" aria-label="Seven-day marketing coverage">
      {days.map((day, index) => <div key={day.date} className="min-w-0 text-center">
        <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">{day.label}</span>
        <div className={cx("relative mx-auto mt-2 grid aspect-square w-full max-w-12 place-items-center rounded-[14px] border text-sm font-semibold transition", day.covered ? "today-day-covered border-transparent text-white" : "border-line bg-surface-2 text-text-3", index === 0 && "ring-2 ring-brand/25 ring-offset-2 ring-offset-[var(--surface)]")}>
          {day.dayNumber}
          {day.items.length > 1 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-text px-1 text-[8px] text-surface">{day.items.length}</span>}
        </div>
        <span className="mt-2 block truncate text-[9px] font-semibold text-text-3 sm:text-[10px]">{day.items[0]?.channelLabel ?? "Open"}</span>
      </div>)}
    </div>
  </Card>;
}

function PerformanceCard({ report }: { report: PerformanceReport }) {
  const hasSignal = Boolean(report.headline);
  return <Link href="/app/performance" className="block min-w-0 lg:col-span-3">
    <Card className="h-full min-w-0 overflow-hidden p-5 sm:p-6">
      <CardHeader icon="trend" title="Performance" />
      {hasSignal ? <>
        <p className="mt-4 line-clamp-3 text-sm leading-relaxed text-text-2">{report.headline}</p>
        <div className="mt-5 flex items-end justify-between gap-3">
          <div><span className="font-display text-3xl font-semibold tracking-[-0.04em]">{report.measuredItems}</span><span className="ml-1.5 text-xs text-text-3">measured</span></div>
          {report.trend && <Tag tone={report.trend.multiple >= 1 ? "t-green" : "t-amber"}>{formatMultiple(report.trend.multiple)} recent trend</Tag>}
        </div>
        <TrendLine positive={!report.trend || report.trend.multiple >= 1} />
      </> : <div className="mt-5">
        <TrendLine muted />
        <h2 className="mt-4 font-display text-base font-semibold">Performance is learning.</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-text-3">Voom will show a measured trend once enough published content has real results.</p>
      </div>}
    </Card>
  </Link>;
}

function MaraInsightCard({ insight }: { insight: View["coordinatorInsight"] }) {
  return <Card className="relative min-w-0 overflow-hidden p-5 sm:p-6 lg:col-span-2">
    <div className="flex items-center gap-2.5"><VoomMark size={28} /><span className="text-[11px] font-bold uppercase tracking-[0.14em] text-text-3">MARA insight</span></div>
    {insight ? <><h2 className="mt-5 font-display text-base font-semibold leading-snug">{insight.title}</h2><p className="mt-2 line-clamp-4 text-sm leading-relaxed text-text-2">{insight.description}</p></> : <><h2 className="mt-5 font-display text-base font-semibold">No new recommendation.</h2><p className="mt-2 text-sm leading-relaxed text-text-3">MARA will surface a measured opportunity here when one is available.</p></>}
    <div aria-hidden="true" className="today-insight-glow pointer-events-none absolute -bottom-16 -right-12 h-32 w-32 rounded-full" />
  </Card>;
}

function CardHeader({ icon, title, href }: { icon: string; title: string; href?: string }) {
  return <div className="flex items-center justify-between gap-3">
    <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name={icon} size={16} /></span><span className="font-display text-sm font-semibold">{title}</span></div>
    {href && <Link href={href} className="text-xs font-semibold text-text-3 transition hover:text-text">View <span aria-hidden="true">→</span></Link>}
  </div>;
}

function TrendLine({ positive = true, muted = false }: { positive?: boolean; muted?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 240 52" className={cx("mt-4 h-12 w-full overflow-visible", muted && "opacity-35")} preserveAspectRatio="none">
    <defs><linearGradient id="today-line" x1="0" x2="1"><stop stopColor="#2dd7ee"/><stop offset=".35" stopColor="#3578ff"/><stop offset=".7" stopColor="#db3ee5"/><stop offset="1" stopColor="#ff9b4a"/></linearGradient></defs>
    <path d={positive ? "M2 43 C42 41 48 31 80 34 S126 42 151 27 S194 31 238 7" : "M2 18 C45 12 61 28 92 24 S139 17 169 30 S209 36 238 40"} fill="none" stroke="url(#today-line)" strokeWidth="4" strokeLinecap="round" />
  </svg>;
}

function formatMultiple(value: number) { return `${value.toFixed(1)}×`; }

function statusTone(status: string) {
  if (status === "published") return "t-green";
  if (["failed", "media_timed_out"].includes(status)) return "t-red";
  if (["missed", "needs_approval", "waiting_for_media", "media_delayed"].includes(status)) return "t-amber";
  if (["generating", "publishing", "scheduled"].includes(status)) return "t-blue";
  return "t-grey";
}
