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
  const firstName = data.user.email?.split("@")[0] ?? "there";
  const recommendation = getRecommendation(data.pendingApprovalCount, data.nextScheduled?.publish_at, Boolean(data.plan));

  return <div>
    <PageHead title="Today" description={`Your marketing command centre, ${firstName}.`} actions={<AutomationMode compact initial={normalizeAutomationMode(data.business.automation_level)} />} />
    <div className="grid gap-4 md:grid-cols-2">
      <DashboardCard title="Needs your approval" icon="warn" href="/app/approvals" action="Open Approvals">
        <div className="flex items-end gap-3"><strong className="font-display text-4xl leading-none">{data.pendingApprovalCount}</strong><span className="pb-1 text-sm text-text-2">{data.pendingApprovalCount === 1 ? "recommendation" : "recommendations"} waiting</span></div>
        <p className="mt-3 text-sm leading-relaxed text-text-3">{data.pendingApprovalCount ? "Review each caption and schedule before it is added to your calendar." : "Nothing needs your decision right now."}</p>
      </DashboardCard>

      <DashboardCard title="Next scheduled content" icon="clock" href="/app/calendar" action="Open Content Calendar">
        {data.nextScheduled ? <div><div className="flex flex-wrap items-center gap-2"><Tag tone="t-blue">{data.nextScheduled.channel}</Tag><span className="text-xs font-semibold text-text-2">{formatDubai(data.nextScheduled.publish_at)}</span></div><p className="mt-3 line-clamp-2 text-sm leading-relaxed text-text-2">{data.nextScheduled.content || data.nextScheduled.title}</p></div> : <Empty title="Nothing scheduled yet" text="Approved recommendations will appear here once they are placed on the calendar." />}
      </DashboardCard>

      <DashboardCard title="Marketing plan" icon="cal" href="/app/plan" action="Open Marketing Plan">
        {data.plan ? <div><div className="flex items-center gap-2"><Tag tone={data.plan.status === "active" ? "t-green" : "t-grey"}>{data.plan.status === "active" ? "Active" : "Latest"}</Tag><b className="text-sm">{data.plan.business_goal}</b></div><p className="mt-3 text-sm text-text-3">{data.plan.status === "active" ? "Current plan" : "Most recent plan"} · updated {formatDubai(data.plan.updated_at ?? data.plan.created_at)}</p></div> : <Empty title="No marketing plan yet" text="Generate your first weekly plan when you’re ready. Today will not create one automatically." />}
      </DashboardCard>

      <DashboardCard title="Voom recommendation" icon="spark" href={recommendation.href} action={recommendation.action}>
        <p className="text-sm font-semibold leading-relaxed">{recommendation.text}</p><p className="mt-2 text-xs leading-relaxed text-text-3">Based on your current Voom plan, approvals, and calendar.</p>
      </DashboardCard>
    </div>
  </div>;
}

function DashboardCard({ title, icon, href, action, children }: { title: string; icon: string; href: string; action: string; children: React.ReactNode }) { return <Card className="flex min-h-52 flex-col p-5 sm:p-6"><div className="mb-5 flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name={icon} size={18} /></span><h2 className="font-display text-base font-semibold">{title}</h2></div><div className="flex-1">{children}</div><Link href={href} className="mt-5 inline-flex text-sm font-semibold text-brand hover:underline">{action} →</Link></Card>; }
function Empty({ title, text }: { title: string; text: string }) { return <div><b className="text-sm">{title}</b><p className="mt-2 text-sm leading-relaxed text-text-3">{text}</p></div>; }

function getRecommendation(pending: number, publishAt: string | undefined, hasPlan: boolean) {
  if (pending > 0) return { text: `You still have ${pending} ${pending === 1 ? "post" : "posts"} waiting for approval.`, href: "/app/approvals", action: "Review approvals" };
  if (publishAt) return { text: `Your next scheduled post is ${relativeDubai(publishAt)}.`, href: "/app/calendar", action: "View scheduled content" };
  if (!hasPlan) return { text: "Create a weekly marketing plan to get your first three actionable recommendations.", href: "/app/plan", action: "Build a marketing plan" };
  return { text: "Your marketing plan is active and nothing is waiting for approval. Review the plan when you’re ready for the next action.", href: "/app/plan", action: "Review marketing plan" };
}

function relativeDubai(value: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" });
  const target = formatter.format(new Date(value));
  const today = formatter.format(new Date());
  const tomorrow = formatter.format(new Date(Date.now() + 86400000));
  const time = new Date(value).toLocaleTimeString("en-AE", { timeZone: "Asia/Dubai", hour: "numeric", minute: "2-digit" });
  if (target === today) return `today at ${time}`;
  if (target === tomorrow) return `tomorrow at ${time}`;
  return `on ${formatDubai(value)}`;
}
function formatDubai(value: string) { return new Date(value).toLocaleString("en-AE", { timeZone: "Asia/Dubai", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
