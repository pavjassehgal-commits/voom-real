import Link from "next/link";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Icon } from "@/components/voom/icons";
import { Card, EmptyState, Tag } from "@/components/voom/ui/primitives";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { PerformanceIntelligenceCard } from "@/components/voom/performance/PerformanceIntelligence";
import { loadPerformanceReport } from "@/lib/performance/data";
import { readEmailFlowSummary } from "@/lib/email-flows/read";
import { formatLocalDateTime } from "@/lib/voom/timezone";
import type { EmailFlowSummary } from "@/lib/email-flows/types";
import { getOperatingData } from "@/lib/voom/operating-data";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { listSocialCalendarItems } from "@/lib/social/server-drafts";
import type { WorkflowView } from "@/lib/voom/workflow/read";
import { formatLocalDate } from "@/lib/voom/timezone";

export const dynamic = "force-dynamic";

/**
 * Today is the operational command centre. Every row on this page is a real
 * workflow item from the ONE executable plan — never a disconnected marketing
 * recommendation — and every date is the account's real current local date.
 *
 * Multi-Social Core: Today also lists the approved TikTok/YouTube planning
 * drafts that are dated today, labelled truthfully — they are approved inside
 * Voom, and publishing those channels is not connected yet.
 */
export default async function TodayPage() {
  const data = await getOperatingData();
  if (!data) return null;
  const { snapshot, summary } = data;
  const firstName = data.user.email?.split("@")[0] ?? "there";
  // Measured results from the account's OWN published content, read through
  // the session client so RLS is the isolation boundary. The card below
  // renders nothing at all until there is enough real data for a statement
  // (see lib/performance/insights.ts) — Today never shows a placeholder
  // "MARA is learning..." message.
  const sessionDb = await createClient();
  const performance = await loadPerformanceReport(sessionDb, data.user.id);
  // Real lifecycle state for the card below. `available` is false when the
  // 0040 migration is not applied, and then nothing is rendered at all.
  const lifecycle = await readEmailFlowSummary(sessionDb, data.user.id);
  // Multi-Social Core: approved + scheduled TikTok/YouTube drafts dated today.
  // A failure here must never blank the page — the Instagram workflow is the
  // critical path, so the social section degrades to empty.
  const admin = createAdminClient();
  const socialToday = await listSocialCalendarItems(admin, data.user.id)
    .then((items) => items.filter((item) => item.localDate === snapshot.today))
    .catch(() => []);

  return <div>
    <PageHead
      title="Today"
      description={`${snapshot.cadenceLabel} plan · ${snapshot.timeZone.replace("_", " ")} · ${formatLocalDate(snapshot.today)}`}
      actions={<AutomationMode compact initial={normalizeAutomationMode(data.business.automation_level)} />}
    />

    <Card className="mb-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">What Voom is doing today, {firstName}</h2>
        {data.coordinator?.summaryMessage && (
          <Tag tone="t-blue">{data.coordinator.summaryMessage}</Tag>
        )}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-text-2">
        {snapshot.items.length
          ? `${summary.publishingToday.length} item${summary.publishingToday.length === 1 ? "" : "s"} due today · ${summary.needsApproval.length} waiting for you · ${summary.generating.length} generating · ${summary.waitingForMedia.length} waiting for media · ${summary.failed.length} needing attention.`
          : "No executable plan yet. Build your rolling plan and Voom will start today."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Stat label="Due today" value={summary.publishingToday.length} />
        <Stat label="Needs approval" value={summary.needsApproval.length} />
        <Stat label="Generating" value={summary.generating.length} />
        <Stat label="Waiting for media" value={summary.waitingForMedia.length} />
        <Stat label="Scheduled" value={summary.scheduled.length} />
        <Stat label="Published" value={summary.published.length} />
        <Stat label="Missed" value={summary.missed.length} />
        <Stat label="Needs attention" value={summary.failed.length} />
        {socialToday.length > 0 && <Stat label="TikTok/YouTube today" value={socialToday.length} />}
      </div>
    </Card>

    <PerformanceIntelligenceCard report={performance} source="today" />

    <LifecycleEmailCard
      summary={lifecycle.available ? lifecycle.summary : null}
      opportunity={data.coordinator?.needs.find((need) => need.type === "email_flow_opportunity") ?? null}
      timeZone={snapshot.timeZone}
    />

    <Section title="Publishing today" icon="clock" href="/app/calendar" action="Open Content Calendar" items={summary.publishingToday}
      empty="Nothing is due to publish today." />
    {socialToday.length > 0 && (
      <Card className="mb-4 p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name="play" size={18} /></span>
          <h2 className="font-display text-base font-semibold">Approved for today · TikTok &amp; YouTube</h2>
          <Tag tone="t-grey">{socialToday.length}</Tag>
        </div>
        <div className="space-y-2">
          {socialToday.map((item) => (
            <div key={item.draftId} className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
              <span className="min-w-[110px] text-xs font-semibold text-text-2">{item.dayLabel} · {item.localTime}</span>
              <Tag tone="t-blue">{item.contentTypeLabel}</Tag>
              <b className="min-w-0 flex-1 truncate text-sm">{item.concept}</b>
              <Tag tone="t-amber">Approved — publishing not connected yet</Tag>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-3">
          These items are planned and approved inside Voom. TikTok and YouTube publishing connections do not exist
          yet, so nothing is posted externally and Voom never claims it was.
        </p>
        <Link href="/app/calendar" className="mt-1 inline-flex text-sm font-semibold text-brand hover:underline">Open Content Calendar →</Link>
      </Card>
    )}
    <Section title="Needs your approval" icon="warn" href="/app/approvals" action="Open Approvals" items={summary.needsApproval}
      empty="Nothing needs your decision right now." />
    <Section title="Being generated" icon="spark" href="/app/calendar" action="View schedule" items={summary.generating}
      empty="No media is generating."
      reason={snapshot.mode === "manual"
        ? "You're in Manual mode: MARA generates a visual only when you choose Create with MARA on an item. Items show up here while that work is in progress."
        : undefined} />
    <Section title="Waiting for media" icon="film" href="/app/calendar" action="Review waiting items" items={summary.waitingForMedia}
      empty="Nothing is scheduled but waiting for its visual." />
    <Section title="Missed scheduled time" icon="clock" href="/app/calendar" action="Review missed items" items={summary.missed}
      empty="Nothing missed its schedule." />
    <Section title="Needs attention" icon="warn" href="/app/calendar" action="Review failures" items={summary.failed}
      empty="Nothing has failed." />

    <Card className="mt-4 p-5">
      <h2 className="font-display text-base font-semibold">What happens next</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-text-2">{nextStep(snapshot.mode, summary)}</p>
      <Link href="/app/plan" className="mt-3 inline-flex text-sm font-semibold text-brand hover:underline">Open Marketing Plan →</Link>
    </Card>
  </div>;
}

function nextStep(mode: string, summary: { needsApproval: WorkflowView[]; failed: WorkflowView[]; missed: WorkflowView[]; next: WorkflowView | null; generating: WorkflowView[]; waitingForMedia: WorkflowView[] }) {
  if (summary.missed.length) return `${summary.missed.length} item${summary.missed.length === 1 ? "" : "s"} missed its scheduled time. Voom never publishes hours late on its own — post it now or reschedule from the Marketing Plan.`;
  if (summary.failed.length) return `${summary.failed.length} item${summary.failed.length === 1 ? "" : "s"} stopped safely and can be retried. Nothing was published twice.`;
  if (summary.waitingForMedia.length) return `${summary.waitingForMedia.length} item${summary.waitingForMedia.length === 1 ? " is" : "s are"} scheduled but waiting for ${summary.waitingForMedia.length === 1 ? "its" : "their"} visual — Voom cannot publish until the media is ready. Retry a delayed generation, upload a replacement, or let Voom keep waiting.`;
  if (summary.needsApproval.length) return `Approve ${summary.needsApproval.length} item${summary.needsApproval.length === 1 ? "" : "s"} and Voom will schedule ${summary.needsApproval.length === 1 ? "it" : "them"} automatically.`;
  if (summary.generating.length) return "MARA is generating the visuals. Items move to Scheduled on their own once the media is stored.";
  if (summary.next) return `Next up: “${summary.next.concept}” — ${summary.next.dayLabel} at ${summary.next.localTime}.`;
  return mode === "manual"
    ? "You're in Manual mode, so Voom only prepares work when you ask. Build a plan when you're ready."
    : "Your rolling plan is up to date. Voom will replenish the horizon automatically.";
}

/**
 * Lifecycle email, from real database rows only.
 *
 * Renders nothing at all when the account has no flows, so Today stays clean
 * and never shows placeholder activity text.
 */
function LifecycleEmailCard({
  summary,
  opportunity,
  timeZone,
}: {
  summary: EmailFlowSummary | null;
  opportunity: { title: string; description: string; meta?: Record<string, unknown> } | null;
  timeZone: string;
}) {
  if (!summary || (summary.total === 0 && !opportunity)) return null;

  const lines: string[] = [];
  for (const flow of summary.flows) {
    if (flow.status === "active") {
      lines.push(`${flow.name} is active${flow.activeEnrollments > 0 ? ` — ${flow.activeEnrollments} customer${flow.activeEnrollments === 1 ? " is" : "s are"} in it now` : ""}.`);
    } else if (flow.status === "draft") {
      lines.push(`Your ${flow.name} needs approval before anyone is enrolled.`);
    } else if (flow.status === "paused") {
      lines.push(`${flow.name} is paused — nothing new will send.`);
    }
  }
  if (summary.scheduledRuns > 0) {
    lines.push(`${summary.scheduledRuns} lifecycle email${summary.scheduledRuns === 1 ? " is" : "s are"} scheduled.`);
  }
  if (opportunity) lines.push(opportunity.description);

  if (lines.length === 0) return null;

  const nextFlow = summary.flows
    .filter((flow) => flow.status === "active" && flow.nextScheduledAt)
    .sort((a, b) => String(a.nextScheduledAt).localeCompare(String(b.nextScheduledAt)))[0];

  return <Card className="mb-4 p-5 sm:p-6">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-display text-base font-semibold">Lifecycle email</h2>
      <Link href="/app/automations" className="text-[13px] font-semibold text-brand hover:underline">Open Automations →</Link>
    </div>
    <ul className="space-y-1.5 text-sm leading-relaxed text-text-2">
      {lines.slice(0, 4).map((line) => <li key={line}>{line}</li>)}
    </ul>
    {nextFlow?.nextScheduledAt && (
      <p className="mt-2 text-[11.5px] text-text-3">
        Next lifecycle send: {formatLocalDateTime(nextFlow.nextScheduledAt, timeZone)}
      </p>
    )}
  </Card>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
    <div className="font-display text-2xl leading-none">{value}</div>
    <span className="text-[11.5px] text-text-3">{label}</span>
  </div>;
}

/** Why each Today section is (truthfully) empty when it is. */
const emptyWhy: Record<string, string> = {
  "Open Content Calendar": "When an item's schedule reaches today it moves here — see the full rolling schedule in the Content Calendar.",
  "Open Approvals": "Voom prepares work and brings it here before it schedules anything, so you always decide what goes out.",
  "View schedule": "In Assisted and Autopilot, MARA generates visuals on its own after a plan is built. Items show up here while that work is in progress.",
  "Review waiting items": "Approved items whose visual is still generating are held here with their schedule — they publish automatically once the media is ready.",
  "Review failures": "If publishing or media generation stops, the item waits here with what happened and a safe retry — nothing is published twice.",
};

function Section({ title, icon, href, action, items, empty, reason }: { title: string; icon: string; href: string; action: string; items: WorkflowView[]; empty: string; reason?: string }) {
  return <Card className="mb-4 p-5 sm:p-6">
    <div className="mb-4 flex items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name={icon} size={18} /></span>
      <h2 className="font-display text-base font-semibold">{title}</h2>
      <Tag tone="t-grey">{items.length}</Tag>
    </div>
    {items.length
      ? <div className="space-y-2">{items.map((item) => <WorkflowRow key={item.draftId} item={item} />)}</div>
      : <EmptyState icon={icon} title={empty} reason={reason ?? emptyWhy[action]} className="py-6" />}
    <Link href={href} className="mt-1 inline-flex text-sm font-semibold text-brand hover:underline">{action} →</Link>
  </Card>;
}

export function WorkflowRow({ item }: { item: WorkflowView }) {
  return <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
    <span className="min-w-[110px] text-xs font-semibold text-text-2">{item.dayLabel} · {item.localTime}</span>
    <Tag tone="t-blue">{item.contentTypeLabel}</Tag>
    <b className="min-w-0 flex-1 truncate text-sm">{item.concept}</b>
    <Tag tone={statusTone(item.status)}>{item.statusLabel}</Tag>
  </div>;
}

export function statusTone(status: string) {
  if (status === "published") return "t-green";
  if (status === "failed" || status === "media_timed_out") return "t-red";
  if (status === "missed" || status === "needs_approval" || status === "ready_for_review" || status === "waiting_for_media" || status === "media_delayed") return "t-amber";
  if (status === "generating" || status === "publishing" || status === "scheduled") return "t-blue";
  return "t-grey";
}
