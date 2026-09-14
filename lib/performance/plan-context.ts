/**
 * The compact performance context MARA receives when it builds the next
 * rolling 7-day plan.
 *
 * Rules that make this safe:
 *   - it is built ONLY from stored measurements of content Voom published,
 *   - it is ADVISORY: the guidance tells MARA to bias, not obey, and to keep
 *     the plan diverse instead of repeating one winner,
 *   - it carries its own sample size and confidence, so MARA can weigh a
 *     3-item signal differently from a 12-item one,
 *   - it is bounded (few winners, few themes, short sentences), so the
 *     planning prompt can never be flooded by analytics,
 *   - it is absent entirely when there is not enough real data — no invented
 *     "learning" is ever inserted into a plan.
 *
 * Pure module: takes a PerformanceReport, returns JSON-safe context.
 */

import { MIN_MEANINGFUL_MULTIPLE, type PerformanceConfidence, type PerformanceGroupView, type PerformanceReport } from "./insights.ts";
import { performanceContentTypePlural, type PerformanceContentType } from "./types.ts";
import { CONTENT_PURPOSE_LABELS, type ContentPurpose } from "./classify.ts";

export const MAX_CONTEXT_WINNERS = 3;
export const MAX_CONTEXT_UNDERPERFORMERS = 2;
export const MAX_CONTEXT_SIGNALS = 3;

export interface PerformancePlanWinner {
  contentType: string;
  topic: string | null;
  purpose: string;
  /** How far above the account's own recent average this performed. */
  multiple: number;
  /** Human-readable short label, already de-duplicated. */
  label: string;
}

export interface PerformancePlanTheme {
  label: string;
  multiple: number;
}

export interface PerformancePlanGroup {
  label: string;
  multiple: number;
  sampleSize: number;
}

export interface PerformancePlanContext {
  /** Measured, published items this context is derived from. */
  sampleSize: number;
  publishedItems: number;
  windowDays: number;
  confidence: PerformanceConfidence;
  /** What the multiples are measured on, e.g. "reach (accounts reached)". */
  basis: string | null;
  recentWinners: PerformancePlanWinner[];
  underperformingThemes: PerformancePlanTheme[];
  bestContentType: PerformancePlanGroup | null;
  strongestTopic: PerformancePlanGroup | null;
  engagementSignals: string[];
  /** Loud, explicit framing for the model: advisory, bounded, no duplication. */
  guidance: string[];
}

/**
 * Advisory framing attached to every planning request that carries data.
 * Kept in one place so the words MARA is given about the evidence cannot drift
 * from the words the product promises.
 */
export const PERFORMANCE_ADVISORY_RULES = [
  "recentPerformance is EVIDENCE from this business's own already-published Instagram content. It is advisory, never a rule.",
  "Use it to bias topic, format and angle choices toward what measurably worked. Never let it override the brand context, the marketing goal, or the planned content type of a slot.",
  "If it names a winner, create something in that spirit WITHOUT duplicating an existing concept, caption or visual. Preserve diversity: do not plan the same theme twice in one plan and keep the other formats/topics present.",
  "If confidence is low, treat it as a weak hint and explore other angles rather than concentrating the plan on one theme.",
  "Never invent metrics, percentages or results. Only cite what recentPerformance contains, and prefer describing the approach over quoting numbers.",
];

export function buildPerformancePlanContext(report: PerformanceReport): PerformancePlanContext | null {
  if (report.confidence === "none" || report.measuredItems < 3 || !report.basis) return null;
  const winners = [...report.items]
    .filter((item) => item.multiple !== null && item.multiple >= MIN_MEANINGFUL_MULTIPLE)
    .sort((a, b) => (b.multiple ?? 0) - (a.multiple ?? 0))
    .slice(0, MAX_CONTEXT_WINNERS)
    .map((item) => ({
      contentType: performanceContentTypePlural(item.contentType),
      topic: item.topic,
      purpose: CONTENT_PURPOSE_LABELS[item.purpose as ContentPurpose] ?? item.purpose,
      multiple: round(item.multiple ?? 1),
      label: labelFor(item.topic, item.contentType),
    }));

  const underperforming = [...report.byTopic, ...report.byContentType]
    .filter((group) => group.multiple !== null && group.multiple <= 1 / MIN_MEANINGFUL_MULTIPLE)
    .sort((a, b) => (a.multiple ?? 1) - (b.multiple ?? 1))
    .slice(0, MAX_CONTEXT_UNDERPERFORMERS)
    .map((group) => ({ label: group.label, multiple: round(group.multiple ?? 1) }));

  const bestContentType = groupOf(report.byContentType);
  const strongestTopic = groupOf(report.byTopic);
  const engagementSignals = report.signals
    .filter((signal) => /saves|engagement rate|driving/i.test(signal))
    .slice(0, MAX_CONTEXT_SIGNALS);

  return {
    sampleSize: report.measuredItems,
    publishedItems: report.publishedItems,
    windowDays: report.windowDays,
    confidence: report.confidence,
    basis: report.basis.label,
    recentWinners: dedupeWinners(winners),
    underperformingThemes: underperforming,
    bestContentType,
    strongestTopic,
    engagementSignals,
    guidance: [...PERFORMANCE_ADVISORY_RULES],
  };
}

/**
 * The exact JSON-safe shape handed to the planning model: same evidence, with
 * the advisory rules omitted because the system prompt already states them
 * verbatim. Keeps every planning request small.
 */
export function compactPlanContext(context: PerformancePlanContext): Omit<PerformancePlanContext, "guidance"> {
  const { guidance: _guidance, ...rest } = context;
  void _guidance;
  return rest;
}

function dedupeWinners(winners: PerformancePlanWinner[]): PerformancePlanWinner[] {
  const seen = new Set<string>();
  return winners.filter((winner) => {
    if (seen.has(winner.label)) return false;
    seen.add(winner.label);
    return true;
  });
}

function groupOf(groups: PerformanceGroupView[]): PerformancePlanGroup | null {
  const winner = groups.find((group) => group.multiple !== null && group.multiple >= MIN_MEANINGFUL_MULTIPLE && group.sampleSize >= 2);
  return winner && winner.multiple !== null
    ? { label: winner.label, multiple: round(winner.multiple), sampleSize: winner.sampleSize }
    : null;
}

function labelFor(topic: string | null, contentType: PerformanceContentType): string {
  const shape = performanceContentTypePlural(contentType);
  return topic ? `${shape} about “${topic}”` : shape;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
