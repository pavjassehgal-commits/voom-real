import Link from "next/link";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Icon } from "@/components/voom/icons";
import { Card, EmptyState, Tag } from "@/components/voom/ui/primitives";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { getOperatingData } from "@/lib/voom/operating-data";
import type { WorkflowView } from "@/lib/voom/workflow/read";
import { formatLocalDate } from "@/lib/voom/timezone";

export const dynamic = "force-dynamic";

/**
 * Today is the operational command centre. Every row on this page is a real
 * workflow item from the ONE executable plan — never a disconnected marketing
 * recommendation — and every date is the account's real current local date.
 */
export default async function TodayPage() {
  const data = await getOperatingData();
  if (!data) return null;
  const { snapshot, summary } = data;
  const firstName = data.user.email?.split("@")[0] ?? "there";

  return <div>
    <PageHead
      title="Today"
      description={`${snapshot.cadenceLabel} plan · ${snapshot.timeZone.replace("_", " ")} · ${formatLocalDate(snapshot.today)}`}
      actions={<AutomationMode compact initial={normalizeAutomationMode(data.business.automation_level)} />}
    />

    <Card className="mb-4 p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold">What Voom is doing today, {firstName}</h2>
      <p className="mt-1 text-sm leading-relaxed text-text-2">
        {snapshot.items.length
          ? `${summary.publishingToday.length} item${summary.publishingToday.length === 1 ? "" : "s"} due today · ${summary.needsApproval.length} waiting for you · ${summary.generating.length} generating · ${summary.failed.length} needing attention.`
          : "No executable plan yet. Build your rolling plan and Voom will start today."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Stat label="Due today" value={summary.publishingToday.length} />
        <Stat label="Needs approval" value={summary.needsApproval.length} />
        <Stat label="Generating" value={summary.generating.length} />
        <Stat label="Scheduled" value={summary.scheduled.length} />
        <Stat label="Published" value={summary.published.length} />
        <Stat label="Needs attention" value={summary.failed.length} />
      </div>
    </Card>

    <Section title="Publishing today" icon="clock" href="/app/calendar" action="Open Content Calendar" items={summary.publishingToday}
      empty="Nothing is due to publish today." />
    <Section title="Needs your approval" icon="warn" href="/app/approvals" action="Open Approvals" items={summary.needsApproval}
      empty="Nothing needs your decision right now." />
    <Section title="Being generated" icon="spark" href="/app/calendar" action="View schedule" items={summary.generating}
      empty="No media is generating." />
    <Section title="Needs attention" icon="warn" href="/app/calendar" action="Review failures" items={summary.failed}
      empty="Nothing has failed." />

    <Card className="mt-4 p-5">
      <h2 className="font-display text-base font-semibold">What happens next</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-text-2">{nextStep(snapshot.mode, summary)}</p>
      <Link href="/app/plan" className="mt-3 inline-flex text-sm font-semibold text-brand hover:underline">Open Marketing Plan →</Link>
    </Card>
  </div>;
}

function nextStep(mode: string, summary: { needsApproval: WorkflowView[]; failed: WorkflowView[]; next: WorkflowView | null; generating: WorkflowView[] }) {
  if (summary.failed.length) return `${summary.failed.length} item${summary.failed.length === 1 ? "" : "s"} stopped safely and can be retried. Nothing was published twice.`;
  if (summary.needsApproval.length) return `Approve ${summary.needsApproval.length} item${summary.needsApproval.length === 1 ? "" : "s"} and Voom will schedule ${summary.needsApproval.length === 1 ? "it" : "them"} automatically.`;
  if (summary.generating.length) return "MARA is generating the visuals. Items move to Scheduled on their own once the media is stored.";
  if (summary.next) return `Next up: “${summary.next.concept}” — ${summary.next.dayLabel} at ${summary.next.localTime}.`;
  return mode === "manual"
    ? "You're in Manual mode, so Voom only prepares work when you ask. Build a plan when you're ready."
    : "Your rolling plan is up to date. Voom will replenish the horizon automatically.";
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
  "View schedule": "MARA generates visuals on its own after a plan is built. Items show up here while that work is in progress.",
  "Review failures": "If publishing or media generation stops, the item waits here with what happened and a safe retry — nothing is published twice.",
};

function Section({ title, icon, href, action, items, empty }: { title: string; icon: string; href: string; action: string; items: WorkflowView[]; empty: string }) {
  return <Card className="mb-4 p-5 sm:p-6">
    <div className="mb-4 flex items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name={icon} size={18} /></span>
      <h2 className="font-display text-base font-semibold">{title}</h2>
      <Tag tone="t-grey">{items.length}</Tag>
    </div>
    {items.length
      ? <div className="space-y-2">{items.map((item) => <WorkflowRow key={item.draftId} item={item} />)}</div>
      : <EmptyState icon={icon} title={empty} reason={emptyWhy[action]} className="py-6" />}
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
  if (status === "failed") return "t-red";
  if (status === "needs_approval") return "t-amber";
  if (status === "generating" || status === "publishing") return "t-blue";
  return "t-grey";
}
