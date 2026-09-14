import Link from "next/link";
import { Card, Tag } from "@/components/voom/ui/primitives";
import { Icon } from "@/components/voom/icons";
import { formatMultiple, type PerformanceReport } from "@/lib/performance/insights";

/**
 * The one place the "MARA learned ..." statement is rendered, shared by Today
 * and the Performance page so the same measured facts can never be worded two
 * different ways.
 *
 * Truthfulness: it renders NOTHING unless the report itself produced a
 * headline, which only happens when the account has enough really-measured
 * published content (see lib/performance/insights.ts). A card with no
 * measured statement behind it is not rendered at all, and every number on it
 * comes from a stored snapshot rather than from copy written for the empty case.
 */
export function PerformanceIntelligenceCard({ report, source }: { report: PerformanceReport; source: "today" | "performance" }) {
  if (!report.headline) return null;
  return <Card className="mb-4 p-5 sm:p-6">
    <div className="flex items-start gap-3">
      <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-[var(--brand-soft)] text-brand"><Icon name="trend" size={20} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-base font-semibold">Performance intelligence</h2>
          <Tag tone="t-brand">{report.confidence === "moderate" ? "Moderate confidence" : "Low confidence"}</Tag>
          <Tag tone="t-grey">{report.measuredItems} measured item{report.measuredItems === 1 ? "" : "s"}</Tag>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-text-2">{report.headline}</p>
        {source === "today"
          ? <Link href="/app/performance" className="mt-3 inline-flex text-sm font-semibold text-brand hover:underline">See the measured results →</Link>
          : <p className="mt-2 text-xs leading-relaxed text-text-3">
            Measured from your own published Instagram content over the last {report.windowDays} days
            {report.basis ? `, compared on ${report.basis.label}` : ""}. This steers MARA&apos;s next rolling plan as advice — never as a rule.
          </p>}
      </div>
    </div>
  </Card>;
}

/**
 * The measured, data-backed statements themselves — no wrapper, so a caller can
 * present them inside its own section. Nothing is rendered when there is
 * nothing provable to say.
 */
export function PerformanceSignals({ report }: { report: PerformanceReport }) {
  if (!report.signals.length) return null;
  return <ul className="mt-3 space-y-2">
    {report.signals.map((signal) => <li key={signal} className="flex gap-2 text-sm leading-relaxed text-text-2">
      <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-brand" />{signal}
    </li>)}
  </ul>;
}

/** One relative signal, e.g. "1.8× your recent average". Never a score. */
export function MultipleBadge({ multiple }: { multiple: number | null }) {
  // A null multiple is "not provable from this sample" — it is never shown as
  // 1.0× or as a winner, and never replaced by a made-up score.
  if (multiple === null) return <Tag tone="t-grey">Not enough data to compare</Tag>;
  if (multiple >= 1.05) return <Tag tone="t-green">{formatMultiple(multiple)} your average</Tag>;
  if (multiple <= 0.95) return <Tag tone="t-amber">{formatMultiple(multiple)} your average</Tag>;
  return <Tag tone="t-grey">Level with your average</Tag>;
}
