import Link from "next/link";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Icon } from "@/components/voom/icons";
import { Card, Tag } from "@/components/voom/ui/primitives";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const data = await getOperatingData();
  if (!data) return null;
  const pending = data.actions.filter((item) => item.status === "pending" || item.status === "failed");
  const firstName = data.user.email?.split("@")[0] ?? "there";
  return <div>
    <PageHead title="Today" description={`Your marketing command centre, ${firstName}.`} actions={<AutomationMode compact initial={normalizeAutomationMode(data.business.automation_level)} />} />

    <section className="mb-4 overflow-hidden rounded-[var(--r-lg)] border border-line bg-surface shadow-[var(--shadow)]">
      <div className="border-l-[3px] border-brand p-5 sm:p-6">
        <div className="flex items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name="spark" size={18} /></span><div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[.08em] text-text-3">What Voom is working on</p>
          {data.plan ? <><h2 className="mt-2 font-display text-lg font-semibold">Keeping your active marketing plan on track</h2><p className="mt-1 text-sm leading-relaxed text-text-2">Voom is monitoring approved work, upcoming content, and items that need your decision. Nothing is published, sent, deleted, or funded without permission.</p></> : <><h2 className="mt-2 font-display text-lg font-semibold">Ready to build your first marketing plan</h2><p className="mt-1 text-sm leading-relaxed text-text-2">Your brand profile and existing Voom activity are ready. Generate a grounded weekly plan when plan storage is approved.</p><Link href="/app/plan" className="mt-3 inline-flex text-sm font-semibold text-brand hover:underline">Open Marketing Plan →</Link></>}
        </div></div>
      </div>
    </section>

    <div className="grid gap-4 xl:grid-cols-[1.35fr_.85fr]">
      <div className="space-y-4">
        <Section title="Today’s planned marketing work" icon="cal" href="/app/calendar" link="View calendar">
          {data.today.length ? data.today.map((item) => <WorkRow key={item.id} item={item} />) : <Empty title="Nothing is scheduled for today" text="Your next approved or proposed calendar item will appear here." href="/app/calendar" action="Open Content Calendar" />}
        </Section>
        <Section title="Upcoming scheduled content" icon="clock" href="/app/calendar" link="View calendar">
          {data.upcoming.length ? data.upcoming.map((item) => <WorkRow key={item.id} item={item} />) : <Empty title="No upcoming content yet" text="Approved calendar proposals will appear here with their real channel and publishing time." href="/app/plan" action="Review Marketing Plan" />}
        </Section>
      </div>
      <div className="space-y-4">
        <Section title="Important alerts" icon="warn" href="/app/approvals" link="Review approvals">
          {pending.length ? pending.slice(0, 5).map((item) => <Link href="/app/approvals" key={item.id} className="flex gap-3 border-t border-line px-4 py-3 first:border-0 hover:bg-surface-2"><span className="mt-1 h-2 w-2 flex-none rounded-full bg-amber" /><span className="min-w-0"><b className="block text-sm">{item.status === "failed" ? "Action needs a retry" : "Decision needed"}</b><span className="mt-0.5 block text-xs leading-relaxed text-text-2">{item.summary}</span></span></Link>) : <div className="flex items-center gap-3 p-4"><span className="grid h-9 w-9 place-items-center rounded-full border border-line text-green"><Icon name="check" /></span><div><b className="text-sm">No urgent alerts</b><p className="mt-0.5 text-xs text-text-3">You’re all caught up.</p></div></div>}
        </Section>
        <Section title="Recent activity" icon="trend">
          {data.activity.length ? data.activity.map((item) => <div key={item.id} className="border-t border-line px-4 py-3 first:border-0"><div className="flex items-start justify-between gap-3"><span className="text-sm">{friendlyActivity(item.tool_name, item.status)}</span><time className="whitespace-nowrap text-[11px] text-text-3">{formatWhen(item.completed_at ?? item.started_at)}</time></div>{(item.result_summary || item.error_summary) && <p className="mt-1 line-clamp-2 text-xs text-text-3">{item.result_summary ?? item.error_summary}</p>}</div>) : <Empty title="No activity yet" text="Voom’s planning and approved actions will be recorded here." />}
        </Section>
      </div>
    </div>
  </div>;
}

function Section({ title, icon, href, link, children }: { title: string; icon: string; href?: string; link?: string; children: React.ReactNode }) { return <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-line px-4 py-3.5"><h2 className="flex items-center gap-2 font-display text-base font-semibold"><Icon name={icon} size={17} className="text-brand" />{title}</h2>{href && <Link href={href} className="text-xs font-semibold text-text-2 hover:text-brand">{link} →</Link>}</div>{children}</Card>; }
function WorkRow({ item }: { item: { id: string; title: string; channel: string; publish_at: string; status: string; topic: string } }) { return <div className="grid gap-2 border-t border-line px-4 py-3 first:border-0 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div className="min-w-0"><b className="block truncate text-sm">{item.title}</b><span className="text-xs text-text-3">{item.topic || "No topic added"}</span></div><span className="text-xs text-text-2">{item.channel} · {new Date(item.publish_at).toLocaleString("en-AE", { timeZone: "Asia/Dubai", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span><Tag tone={item.status === "scheduled" ? "t-green" : item.status === "approved" ? "t-blue" : "t-amber"}>{item.status}</Tag></div>; }
function Empty({ title, text, href, action }: { title: string; text: string; href?: string; action?: string }) { return <div className="p-5 text-center"><b className="text-sm">{title}</b><p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-text-3">{text}</p>{href && <Link href={href} className="mt-3 inline-flex text-xs font-semibold text-brand hover:underline">{action} →</Link>}</div>; }
function friendlyActivity(tool: string, status: string) { const action = tool.replaceAll("_", " ").replace(/^mara /, ""); return `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} · ${status.replaceAll("_", " ")}`; }
function formatWhen(value: string) { return new Date(value).toLocaleString("en-AE", { timeZone: "Asia/Dubai", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
