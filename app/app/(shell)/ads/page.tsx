import Link from "next/link";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Icon } from "@/components/voom/icons";
import { Card, EmptyState, Tag } from "@/components/voom/ui/primitives";

/**
 * Paid advertising is not implemented yet: Voom has no Meta or Google ads
 * connection, so this screen shows a truthful state instead of the previous
 * sample allocator. It explains what the feature will do and what to do next,
 * and invents no budgets, results or approvals.
 */

const STEPS = [
  "Connect your Meta or Google advertising account.",
  "Add your payment card directly to Meta or Google.",
  "Voom prepares a campaign and suggests a budget.",
  "You approve, reduce or decline it.",
  "Meta or Google charges your card gradually as advertisements run.",
  "Voom optimises within the amount you approved.",
  "Any increase requires another approval.",
];

export default function AdsPage() {
  return (
    <div className="mx-auto max-w-[760px]">
      <PageHead
        title="Paid advertising"
        description="Voom will prepare the allocation and you approve it. Nothing spends until you do."
      />

      <Card className="p-0">
        <EmptyState
          icon="target"
          title="Paid advertising isn’t set up for your business yet"
          reason="Voom can’t see or spend any advertising budget right now — no ad account is connected and nothing was ever charged through Voom. When Meta or Google advertising is connected, Voom will prepare a budget allocation here for your explicit approval before anything runs."
          action={<>
            <Link href="/app/connections" className="voom-grad inline-flex h-[42px] items-center gap-2 rounded-[11px] px-[18px] text-sm font-semibold text-white shadow-[0_6px_18px_-8px_var(--brand)] hover:brightness-110">
              <Icon name="globe" size={15} /> Check connections
            </Link>
            <Link href="/app/today" className="inline-flex h-[42px] items-center gap-2 rounded-[11px] border border-line-2 px-[18px] text-sm font-semibold hover:bg-surface-2">
              <Icon name="home" size={15} /> Back to Today
            </Link>
          </>}
        />
      </Card>

      <Card className="mt-4 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-base font-semibold">How paid advertising will work</h2>
          <Tag tone="t-grey">Planned</Tag>
        </div>
        <ol className="mt-3.5 space-y-2.5">
          {STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-2.5 text-sm leading-relaxed text-text-2">
              <span className="mt-0.5 grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-surface-2 font-mono text-[10.5px] font-bold text-text-2">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <p className="mt-4 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-text-3">
          Your Voom subscription pays for the software. Advertising budgets are optional and are charged directly by
          your connected advertising account — never by Voom.
        </p>
      </Card>
    </div>
  );
}
