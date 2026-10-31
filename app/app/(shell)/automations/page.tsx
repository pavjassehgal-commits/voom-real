import Link from "next/link";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { AutomationPauseControl } from "@/components/voom/automations/AutomationPauseControl";
import { EmailFlowsPanel } from "@/components/voom/automations/EmailFlowsPanel";
import { Icon } from "@/components/voom/icons";
import { BTN, ChannelGlyph, PageHeader, StatCard, StatusChip } from "@/components/voom/redesign/ui";
import { normalizeAutomationMode, AUTOMATION_MODE_STATUS_LINES } from "@/lib/voom/automation";
import { normalizePlan, getPlanConfig } from "@/lib/billing/plans";
import { accountTimezone } from "@/lib/voom/timezone";
import { getOperatingData } from "@/lib/voom/operating-data";
import { readAutomationPauseState } from "@/lib/voom/automation-pause-state";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const MEDIA_ACTIVE = new Set(["generating", "waiting_for_media"]);
const MEDIA_PROBLEM = new Set(["media_delayed", "media_timed_out"]);

/**
 * Automations — one place for how proactively MARA works and for the
 * lifecycle rules that run on their own. It keeps two different things apart:
 *
 *   Marketing automation mode — how proactively Voom prepares work
 *                               (Manual / Assisted / Autopilot).
 *   Active automations        — the lifecycle email flows that actually run.
 *
 * Every figure is read from the shared operating data (workflow snapshot,
 * approval feed, coordinator) and the saved pause state; Pause all / Resume
 * use the existing `/api/automation/*` routes. No Keep Figma layout exists for
 * this page (the PDF page labelled "Automations · Flows" shows the Approvals
 * queue), so it uses the Batch 1/2 design system.
 */
export default async function AutomationsPage() {
  const user = await getCurrentUser();
  const [data, pause] = await Promise.all([
    getOperatingData(),
    user ? readAutomationPauseState(createAdminClient(), user.id) : Promise.resolve(null),
  ]);
  if (!data) return null;
  const planId = normalizePlan((data.business as { plan?: string | null }).plan);
  const plan = getPlanConfig(planId);
  const timeZone = accountTimezone((data.business as { timezone?: string | null }).timezone);
  const lifecycle = data.coordinator?.state.emailState;
  const mode = normalizeAutomationMode(data.business.automation_level);
  const pausedAt = pause?.pausedAt ?? null;
  const items = data.snapshot.items;
  const mediaActive = items.filter((item) => MEDIA_ACTIVE.has(item.status));
  const mediaProblems = items.filter((item) => MEDIA_PROBLEM.has(item.status) || item.status === "failed");
  const waitingOnYou = data.actions.filter((action) => action.status === "pending").length;
  const lockedModes = (["manual", "assisted", "autopilot"] as const).filter((value) => !plan.allowedModes.includes(value));
  const activity = data.actions.slice(0, 6);

  return <div className="min-w-0">
    <PageHeader
      title="Automations"
      subtitle="Choose how much MARA does on its own, pause everything in one step, and manage the email flows that run automatically."
      actions={pause ? <AutomationPauseControl pausedAt={pausedAt} /> : <span className="text-[13.5px] text-text-3">Pause state unavailable — refresh to retry.</span>}
    />

    {pausedAt && (
      <div role="status" className="mb-5 flex gap-3 rounded-[18px] border border-[var(--coral)]/25 bg-[var(--coral-soft)] px-5 py-4 text-[14.5px] text-text">
        <Icon name="warn" size={18} className="mt-0.5 shrink-0 text-[var(--coral)]" />
        <span><b className="font-semibold text-[var(--coral)]">Automation is paused</b> since {formatWhen(pausedAt, timeZone)}. MARA isn’t starting new automatic work. Resume when you’re ready — cancelled posts and paused email flows stay as they are.</span>
      </div>
    )}

    <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard icon="sparkle" value={mode === "autopilot" ? "Autopilot" : mode === "assisted" ? "Assisted" : "Manual"} label={pausedAt ? "Saved mode · paused" : "Current mode"} tone="brand" />
      <StatCard icon="checkCircle" value={waitingOnYou} label="Waiting on your approval" tone="coral" note={waitingOnYou ? <Link href="/app/approvals" className="text-[var(--brand-ink)] hover:underline">Review approvals</Link> : undefined} />
      <StatCard icon="video" value={mediaActive.length} label="Media in progress" tone="blue" />
      <StatCard icon="warn" value={mediaProblems.length} label="Need attention" tone={mediaProblems.length ? "coral" : "green"} />
    </div>

    <section className="voom-card mb-5 p-5 sm:p-6" aria-labelledby="automation-mode">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="automation-mode" className="text-[18px] font-semibold text-text">Marketing automation mode</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-text-2">{AUTOMATION_MODE_STATUS_LINES[mode]} Your saved mode is highlighted below; each card says what that mode does, including whether paid MARA media can start on its own.</p>
        </div>
        <span className="rounded-full bg-[var(--brand-soft)] px-3 py-1 text-[12.5px] font-semibold text-[var(--brand-ink)]">{plan.name} plan</span>
      </div>
      <div className="mt-4">
        <AutomationMode describe initial={normalizeAutomationMode(data.business.automation_level)} plan={planId} />
      </div>
      {lockedModes.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[var(--brand-line)] bg-[var(--brand-soft-2)] px-4 py-3">
          <p className="text-[14px] text-text-2">{lockedModes.map((value) => value.charAt(0).toUpperCase() + value.slice(1)).join(" and ")} {lockedModes.length === 1 ? "isn’t" : "aren’t"} included in the {plan.name} plan.</p>
          <Link href="/app/pricing" className={BTN.outline}>See plans <Icon name="arrow" size={14} /></Link>
        </div>
      )}
      <div className="mt-4 grid gap-3 text-[13.5px] leading-relaxed text-text-2 md:grid-cols-2">
        <p className="rounded-[14px] bg-surface-2 px-4 py-3"><b className="font-semibold text-text">Switching mode</b> changes what MARA prepares from now on. It doesn’t cancel posts that are already approved and scheduled — those still go out at their time. To stop scheduled Autopilot posts, use <b className="font-semibold text-text">Pause all</b>.</p>
        <p className="rounded-[14px] bg-surface-2 px-4 py-3"><b className="font-semibold text-text">Email flows</b> are separate: in every mode a flow only runs after you activate it yourself.</p>
      </div>
    </section>

    <div className="mb-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2">
      <section className="voom-card p-5 sm:p-6" aria-labelledby="automation-pending">
        <div className="flex items-center justify-between gap-3">
          <h2 id="automation-pending" className="text-[16px] font-semibold text-text">Pending work and media</h2>
          <Link href="/app/plan" className="text-[13.5px] font-medium text-[var(--brand-ink)] hover:opacity-80">Marketing plan</Link>
        </div>
        {[...mediaProblems, ...mediaActive].length ? (
          <ul className="mt-3 divide-y divide-line">
            {[...mediaProblems, ...mediaActive].slice(0, 6).map((item) => (
              <li key={item.draftId} className="flex items-center gap-3 py-3">
                <ChannelGlyph channel={item.channel} size={20} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-text">{item.concept}</span><span className="block text-[12.5px] text-text-2">{item.contentTypeLabel} · {item.dayLabel} {item.localTime}</span></span>
                <StatusChip status={item.status} label={item.statusLabel} small />
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-[14px] text-text-2">No media is being generated and nothing is stuck. {waitingOnYou ? `${waitingOnYou} item${waitingOnYou === 1 ? "" : "s"} wait for your approval.` : "Nothing is waiting on you."}</p>}
      </section>

      <section className="voom-card p-5 sm:p-6" aria-labelledby="automation-activity">
        <div className="flex items-center justify-between gap-3">
          <h2 id="automation-activity" className="text-[16px] font-semibold text-text">MARA activity</h2>
          <Link href="/app/approvals" className="text-[13.5px] font-medium text-[var(--brand-ink)] hover:opacity-80">All approvals</Link>
        </div>
        {activity.length ? (
          <ul className="mt-3 divide-y divide-line">
            {activity.map((action) => (
              <li key={action.id} className="flex items-start gap-3 py-3">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${action.status === "pending" ? "bg-[var(--coral)]" : action.status === "failed" ? "bg-[var(--red)]" : "bg-[var(--brand)]"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1"><span className="block text-[14px] text-text">{action.summary}</span><span className="block text-[12.5px] text-text-3">{action.status === "pending" ? "Waiting for you" : action.status === "failed" ? "Failed safely" : action.result_summary ?? "Handled"}</span></span>
                <span className="shrink-0 text-[12.5px] text-text-3">{formatWhen(action.created_at, timeZone)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-[14px] text-text-2">No MARA actions yet. Proposals and approvals appear here as MARA works.</p>}
      </section>
    </div>

    <EmailFlowsPanel timeZone={timeZone} />

    {lifecycle && lifecycle.activeLifecycleEnrollments > 0 && (
      <section className="voom-card mt-5 p-5 sm:p-6" aria-labelledby="automation-now">
        <h2 id="automation-now" className="text-[16px] font-semibold text-text">What is happening right now</h2>
        <ul className="mt-2 space-y-1.5 text-[14px] text-text-2">
          <li>{lifecycle.activeLifecycleEnrollments} contact{lifecycle.activeLifecycleEnrollments === 1 ? " is" : "s are"} currently inside a lifecycle flow.</li>
          <li>{lifecycle.scheduledLifecycleEmailCount} lifecycle email{lifecycle.scheduledLifecycleEmailCount === 1 ? " is" : "s are"} scheduled.</li>
          <li>{lifecycle.eligibleContactsCount} contact{lifecycle.eligibleContactsCount === 1 ? " is" : "s are"} subscribed to marketing email and eligible to enroll.</li>
        </ul>
      </section>
    )}

    <section className="voom-card mt-5 flex items-start gap-3 p-5" aria-label="Safety">
      <StatusChip status="published" label="Safety always on" small />
      <p className="text-[14px] leading-relaxed text-text-2">No mode can publish externally, send a campaign, delete content, or spend advertising money without a separately saved permission or an explicit confirmation.</p>
    </section>
  </div>;
}

function formatWhen(iso: string, timeZone: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}
