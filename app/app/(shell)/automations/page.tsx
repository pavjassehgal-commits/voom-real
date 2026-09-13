import { PageHead } from "@/components/voom/shell/AppShell";
import { Card, Tag } from "@/components/voom/ui/primitives";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";

/**
 * Automations: choose how proactively Voom works.
 *
 * Everything that depends on the saved mode — the segmented control, the
 * descriptive cards, which card is visually active, and the Autopilot credits
 * warning — is rendered by the client control from the one saved-mode value
 * read off the business record. Nothing on this page hard-codes a mode as
 * active or as "current", so the highlighted card can never disagree with the
 * stored value (the bug this page shipped with: Assisted pinned as
 * active/Default while Manual was saved).
 */
export default async function AutomationsPage() {
  const data = await getOperatingData();
  if (!data) return null;
  return <div>
    <PageHead title="Automations" description="Choose how proactively Voom prepares your marketing." />
    <Card className="p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold">Automation mode</h2>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-2">
        Your saved mode is highlighted below, and the card that matches it is marked Active. Each card says what that
        mode does — including whether paid MARA media generation can start on its own.
      </p>
      <div className="mt-4">
        <AutomationMode describe initial={normalizeAutomationMode(data.business.automation_level)} />
      </div>
    </Card>
    <Card className="mt-4 p-5"><div className="flex items-start gap-3"><Tag tone="t-green">Safety always on</Tag><p className="text-sm leading-relaxed text-text-2">No mode can publish externally, send a campaign, delete content, or spend advertising money without a separately saved permission or an explicit confirmation.</p></div></Card>
  </div>;
}
