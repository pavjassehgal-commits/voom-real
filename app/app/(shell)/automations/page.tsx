import { PageHead } from "@/components/voom/shell/AppShell";
import { Card, Tag } from "@/components/voom/ui/primitives";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { EmailFlowsPanel } from "@/components/voom/automations/EmailFlowsPanel";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { normalizePlan } from "@/lib/billing/plans";
import { accountTimezone } from "@/lib/voom/timezone";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";

/**
 * Automations is now the home of ongoing lifecycle behaviour, and it keeps two
 * clearly different things apart:
 *
 *   Marketing automation mode — how proactively Voom prepares work
 *                               (Manual / Assisted / Autopilot).
 *   Active automations        — the lifecycle rules that actually run
 *                               (Welcome flow, Re-engagement flow, …).
 *
 * A flow is not a campaign: campaigns live on /app/campaigns and have an end
 * date, while a flow keeps running for as long as it is active.
 */
export default async function AutomationsPage() {
  const data = await getOperatingData();
  if (!data) return null;
  const planId = normalizePlan((data.business as any).plan);
  const timeZone = accountTimezone((data.business as { timezone?: string | null }).timezone);
  const lifecycle = data.coordinator?.state.emailState;

  return <div>
    <PageHead title="Automations" description="Choose how proactively Voom prepares your marketing, and see the lifecycle automations that are running." />

    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">Marketing automation mode</h2>
        {data.coordinator?.summaryMessage && (
          <Tag tone="t-blue">{data.coordinator.summaryMessage}</Tag>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-2">
        Your saved mode is highlighted below, and the card that matches it is marked Active. Each card says what that
        mode does — including whether paid MARA media generation can start on its own.
      </p>
      <div className="mt-4">
        <AutomationMode describe initial={normalizeAutomationMode(data.business.automation_level)} plan={planId} />
      </div>
      <p className="mt-3 max-w-2xl text-xs leading-relaxed text-text-3">
        The mode changes how much Voom prepares on its own. It never decides whether a lifecycle flow sends: in every
        mode a flow only runs after you activate it yourself.
      </p>
    </Card>

    <EmailFlowsPanel timeZone={timeZone} />

    {lifecycle && lifecycle.activeLifecycleEnrollments > 0 && (
      <Card className="mt-4 p-5">
        <h2 className="font-display text-base font-semibold">What is happening right now</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-text-2">
          <li>{lifecycle.activeLifecycleEnrollments} contact{lifecycle.activeLifecycleEnrollments === 1 ? " is" : "s are"} currently inside a lifecycle flow.</li>
          <li>{lifecycle.scheduledLifecycleEmailCount} lifecycle email{lifecycle.scheduledLifecycleEmailCount === 1 ? " is" : "s are"} scheduled.</li>
          <li>{lifecycle.eligibleContactsCount} contact{lifecycle.eligibleContactsCount === 1 ? " is" : "s are"} subscribed to marketing email and eligible to enroll.</li>
        </ul>
      </Card>
    )}

    <Card className="mt-4 p-5"><div className="flex items-start gap-3"><Tag tone="t-green">Safety always on</Tag><p className="text-sm leading-relaxed text-text-2">No mode can publish externally, send a campaign, delete content, or spend advertising money without a separately saved permission or an explicit confirmation.</p></div></Card>
  </div>;
}
