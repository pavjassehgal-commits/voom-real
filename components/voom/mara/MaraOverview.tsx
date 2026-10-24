import Link from "next/link";
import type { ReactNode } from "react";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { Icon } from "@/components/voom/icons";
import { BTN, ChannelGlyph, PageHeader, StatCard, StatusChip } from "@/components/voom/redesign/ui";
import type { PlanId } from "@/lib/billing/plans";
import { AUTOMATION_MODE_STATUS_LINES, type AutomationModeValue } from "@/lib/voom/automation";
import { formatLocalDate } from "@/lib/voom/timezone";

export interface MaraOverviewProps {
  mode: AutomationModeValue;
  planId: PlanId;
  timeZone: string;
  plannedCount: number;
  pending: { id: string; summary: string; reason: string | null }[];
  mediaActiveCount: number;
  credits: { remaining: number; total: number } | null;
  gapDates: string[];
  disconnected: ("instagram" | "tiktok" | "youtube")[];
  insights: { title: string; description: string }[];
  days: { date: string; gap: boolean; items: { draftId: string; channel: string; concept: string }[] }[];
  knows: [string, string][];
  allowAutomaticPaidMedia: boolean;
  monthlyMediaBudgetUsd: number;
  activity: { id: string; summary: string; status: string; note: string; createdAt: string }[];
}

/**
 * MARA · AI marketing manager (Figma "19 — MARA", Keep) — presentation only.
 * Every value arrives from the page's server reads; nothing is invented. The
 * reference's chat panel / "Ask MARA" and its engagement-uplift, time-saved
 * and ad-spend figures are omitted: the chat API is retired and Voom does not
 * measure those.
 */
export function MaraOverview({ mode, planId, timeZone, plannedCount, pending, mediaActiveCount, credits, gapDates, disconnected, insights, days, knows, allowAutomaticPaidMedia, monthlyMediaBudgetUsd, activity }: MaraOverviewProps) {
  const decisions = pending.length + (gapDates.length ? 1 : 0) + disconnected.length + insights.length;
  return <div className="min-w-0">
    <PageHeader
      title="Your AI marketing manager"
      subtitle={`${mode === "autopilot" ? "Autopilot" : mode === "assisted" ? "Assisted" : "Manual"} mode · ${AUTOMATION_MODE_STATUS_LINES[mode]}`}
      actions={<div className="flex items-center gap-2"><span className="text-[13px] text-text-3">Mode</span><AutomationMode compact showPlanSummary={false} initial={mode} plan={planId} /></div>}
    />

    <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard icon="cal" value={plannedCount} label="Posts planned this week" tone="brand" />
      <StatCard icon="checkCircle" value={pending.length} label="Waiting on you" tone="coral" note={pending.length ? <Link href="/app/approvals" className="text-[var(--brand-ink)] hover:underline">Review approvals</Link> : undefined} />
      <StatCard icon="video" value={mediaActiveCount} label="Media in progress" tone="blue" />
      <StatCard icon="sparkle" value={credits ? credits.remaining : "—"} label={credits ? `Credits left of ${credits.total}` : "Credits unavailable"} tone="green" />
    </div>

    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <section className="voom-card p-5 sm:p-6" aria-labelledby="mara-decisions">
          <div className="flex items-center justify-between gap-3">
            <h2 id="mara-decisions" className="text-[18px] font-semibold text-text">Needs your decision</h2>
            <span className="text-[13px] text-text-2">{decisions} waiting</span>
          </div>
          {decisions === 0 ? <p className="mt-3 text-[14px] text-text-2">Nothing needs you right now. MARA will surface approvals, open dates and connection problems here.</p> : (
            <ul className="mt-4 space-y-3">
              {pending.slice(0, 3).map((action) => (
                <DecisionCard key={action.id} icon="checkCircle" title={action.summary} chip={<StatusChip status="needs_approval" label="Needs approval" small />}
                  detail={action.reason ? `Why: ${action.reason}` : "MARA prepared this and is waiting for your decision."}
                  actions={<Link href="/app/approvals" className={BTN.primary}>Review</Link>} />
              ))}
              {gapDates.length > 0 && (
                <DecisionCard icon="cal" title={`${gapDates.length} open date${gapDates.length === 1 ? "" : "s"} this week`} chip={<StatusChip status="missed" label="Uncovered" small />}
                  detail={gapDates.map((date) => formatLocalDate(date)).join(" · ")}
                  actions={<Link href="/app/plan" className={BTN.primary}>Fill with MARA</Link>} />
              )}
              {disconnected.map((channel) => (
                <DecisionCard key={channel} icon="share" title={`Connect ${CHANNEL[channel]}`} chip={<StatusChip status="connection_required" label="Not connected" small />}
                  detail={`Planned ${CHANNEL[channel]} posts can’t publish until the account is connected.`}
                  actions={<Link href={`/app/${channel}`} className={BTN.primary}>Connect {CHANNEL[channel]}</Link>} />
              ))}
              {insights.map((need) => (
                <DecisionCard key={need.title} icon="sparkle" title={need.title} chip={<StatusChip status="scheduled" label="MARA insight" small />} detail={need.description}
                  actions={<Link href="/app/performance" className={BTN.outline}>See performance</Link>} />
              ))}
            </ul>
          )}
        </section>
        <section className="voom-card p-5 sm:p-6" aria-labelledby="mara-plan">
          <div className="flex items-center justify-between gap-3">
            <h2 id="mara-plan" className="text-[18px] font-semibold text-text">MARA’s plan for this week</h2>
            <Link href="/app/plan" className="text-[13.5px] font-medium text-[var(--brand-ink)] hover:opacity-80">Open marketing plan</Link>
          </div>
          <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {days.map((day, index) => (
              <li key={day.date} className={`min-h-[120px] rounded-[14px] border p-2.5 ${index === 0 ? "border-[var(--brand-line)] bg-[var(--brand-soft-2)]" : "border-line"}`}>
                <div className="text-[12.5px] font-semibold text-text">{new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(`${day.date}T12:00:00Z`))}{index === 0 ? " · Today" : ""}</div>
                <div className="mt-2 space-y-1.5">
                  {day.items.map((item) => <div key={item.draftId} className="rounded-[10px] bg-surface-2 px-2 py-1.5 text-[12px] leading-snug text-text"><ChannelGlyph channel={item.channel} size={14} /><span className="mt-1 block break-words">{item.concept}</span></div>)}
                  {!day.items.length && <div className={`rounded-[10px] border border-dashed px-2 py-1.5 text-[12px] ${day.gap ? "border-[var(--coral)]/50 text-[var(--coral)]" : "border-line-2 text-text-3"}`}>{day.gap ? "Open slot" : "Free"}</div>}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="voom-card p-5 sm:p-6" aria-labelledby="mara-activity">
          <h2 id="mara-activity" className="text-[18px] font-semibold text-text">Activity</h2>
          {activity.length ? (
            <ul className="mt-3 divide-y divide-line">
              {activity.map((action) => (
                <li key={action.id} className="flex items-start gap-3 py-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${action.status === "pending" ? "bg-[var(--coral)]" : action.status === "failed" ? "bg-[var(--red)]" : "bg-[var(--brand)]"}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-[14px] text-text">{action.summary}<span className="block text-[12.5px] text-text-3">{action.note}</span></span>
                  <span className="shrink-0 text-[12.5px] text-text-3">{new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(action.createdAt))}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-3 text-[14px] text-text-2">No MARA activity yet.</p>}
        </section>
      </div>

      <aside className="flex min-w-0 flex-col gap-5">
        <section className="voom-card p-5 sm:p-6" aria-labelledby="mara-knows">
          <div className="flex items-center justify-between gap-3">
            <h2 id="mara-knows" className="text-[16px] font-semibold text-text">What MARA knows</h2>
            <Link href="/app/settings" className="text-[13.5px] font-medium text-[var(--brand-ink)] hover:opacity-80">Edit</Link>
          </div>
          <dl className="mt-3 space-y-2.5 text-[14px]">
            {knows.map(([label, value]) => <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3"><dt className="text-text-2">{label}</dt><dd className="font-semibold text-text">{value || <span className="font-normal text-text-3">Not set</span>}</dd></div>)}
          </dl>
        </section>

        <section className="rounded-[22px] border border-[rgba(31,143,108,0.2)] bg-[var(--green-soft)] p-5 sm:p-6" aria-labelledby="mara-guardrails">
          <h2 id="mara-guardrails" className="text-[16px] font-semibold text-text">Guardrails</h2>
          <ul className="mt-3 space-y-2.5 text-[14px] text-text">
            <Guard>{mode === "autopilot" ? "Auto-approves only posts that pass Voom’s safety checks; anything else waits for you" : "Never publishes without your approval"}</Guard>
            <Guard>{allowAutomaticPaidMedia && mode === "autopilot" ? `Paid media only within your $${monthlyMediaBudgetUsd} monthly media budget and your credits` : "Asks before generating paid media"}</Guard>
            <Guard>Never sends a campaign or spends ad money without your confirmation</Guard>
            <Guard>You can pause all automation at any time</Guard>
          </ul>
          <Link href="/app/automations" className="mt-4 inline-flex text-[13.5px] font-semibold text-[var(--green)] hover:underline">Automation settings <Icon name="arrow" size={14} className="ml-1" /></Link>
        </section>
      </aside>
    </div>
  </div>;
}

const CHANNEL = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" } as const;

function DecisionCard({ icon, title, chip, detail, actions }: { icon: string; title: string; chip: ReactNode; detail: string; actions: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-4 rounded-[18px] border border-line p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name={icon} size={17} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h3 className="text-[15px] font-semibold text-text">{title}</h3>{chip}</div>
        <p className="mt-1 text-[13.5px] leading-relaxed text-text-2">{detail}</p>
        <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
      </div>
    </li>
  );
}

function Guard({ children }: { children: ReactNode }) {
  return <li className="flex gap-2.5"><Icon name="check" size={15} className="mt-0.5 shrink-0 text-[var(--green)]" /><span>{children}</span></li>;
}
