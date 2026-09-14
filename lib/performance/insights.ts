/**
 * Relative, explainable performance reading — no scores, no fake AI.
 *
 * Everything here is arithmetic over snapshots that were really collected for
 * content Voom really published:
 *
 *   - content vs the account's OWN recent average (leave-one-out, so an item
 *     never inflates the baseline it is compared against),
 *   - content type / topic / purpose comparisons, always against the rest of
 *     the account's own measured content,
 *   - engagement rate ONLY when reach was really returned as the denominator.
 *
 * Small samples are handled honestly: below the thresholds this module returns
 * "not enough history" instead of a ranking, a winner, or a percentage.
 *
 * Pure module: no I/O, no `server-only`, directly unit tested.
 */

import {
  AUDIENCE_BASIS_LABELS,
  AUDIENCE_METRIC_PREFERENCE,
  ENGAGEMENT_BASIS,
  PERFORMANCE_METRICS,
  availableMetrics,
  basisValueOf,
  engagementRateOf,
  interactionCount,
  performanceContentTypeLabel,
  performanceContentTypePlural,
  type MetricSources,
  type PerformanceBasis,
  type PerformanceBasisKey,
  type PerformanceContentType,
  type PerformanceMetric,
  type PerformanceMetrics,
} from "./types.ts";
import {
  CONTENT_PURPOSE_LABELS,
  assignTopics,
  classifyPurpose,
  topicLabel,
  type ContentPurpose,
} from "./classify.ts";

/** Minimum measured items before ANY average or multiple is shown. */
export const MIN_BASELINE_ITEMS = 3;
/** Minimum measured items before a group/topic claim may outrank the average. */
export const MIN_GROUP_ITEMS = 2;
/**
 * A ratio needs a non-trivial base: dividing by an average of 1-2 interaction
 * units produces impressive-looking noise, so no multiple is claimed there.
 */
export const MIN_BASELINE_VALUE = 3;
/** How far above a baseline a group must sit before it is called a winner. */
export const MIN_MEANINGFUL_MULTIPLE = 1.2;
/** Measured items needed before a plain-language "MARA learned" headline. */
export const MIN_ITEMS_FOR_HEADLINE = 5;

export type PerformanceConfidence = "none" | "low" | "moderate";

export type PerformanceEmptyReason =
  | "no_published_content"
  | "no_metrics_yet"
  | "not_enough_history"
  | "no_comparable_metrics";

/** One stored measurement of one published item (the read model's input). */
export interface PerformanceMeasurement {
  instagramMediaId: string;
  draftId: string | null;
  contentType: PerformanceContentType;
  title: string;
  caption: string;
  publishedAt: string;
  collectedAt: string;
  metrics: PerformanceMetrics;
  sources: MetricSources;
}

export interface PerformanceItemView {
  instagramMediaId: string;
  draftId: string | null;
  contentType: PerformanceContentType;
  contentTypeLabel: string;
  title: string;
  topic: string | null;
  purpose: ContentPurpose;
  purposeLabel: string;
  publishedAt: string;
  collectedAt: string;
  metrics: PerformanceMetrics;
  availableMetrics: PerformanceMetric[];
  interactions: number | null;
  engagementRate: number | null;
  /** Its value on the account's comparison basis; null when unavailable. */
  basisValue: number | null;
  /** value / recent average (leave-one-out); null when not provable. */
  multiple: number | null;
  /** Absolute unit difference vs the recent average, when provable. */
  difference: number | null;
}

export interface PerformanceGroupView {
  key: string;
  label: string;
  sampleSize: number;
  average: number;
  /** Group average vs the account's other measured content; null when unprovable. */
  multiple: number | null;
  /** Measured value on one engagement metric, when every group item had it. */
  engagement?: { metric: PerformanceMetric; label: string; average: number };
}

export interface PerformanceTrend {
  recentDays: number;
  recentAverage: number;
  previousAverage: number;
  multiple: number;
  recentSample: number;
  previousSample: number;
}

export interface PerformanceReport {
  generatedAt: string;
  windowDays: number;
  /** Published items Voom can measure inside the window. */
  publishedItems: number;
  /** Of those, how many actually returned at least one metric. */
  measuredItems: number;
  /** How many were published but have no metrics (honest denominator). */
  publishedWithoutMetrics: number;
  items: PerformanceItemView[];
  confidence: PerformanceConfidence;
  basis: PerformanceBasis | null;
  recentAverage: number | null;
  baselineSample: number;
  best: PerformanceItemView | null;
  trend: PerformanceTrend | null;
  byContentType: PerformanceGroupView[];
  byTopic: PerformanceGroupView[];
  byPurpose: PerformanceGroupView[];
  /** Plain sentences, each backed by the numbers above. */
  signals: string[];
  /** The one-line "MARA learned" statement; null when not provable. */
  headline: string | null;
  emptyReason: PerformanceEmptyReason | null;
  lastCollectedAt: string | null;
}

export interface PerformanceReportInput {
  measurements: PerformanceMeasurement[];
  /** Published items in the window whose metrics have not arrived. */
  publishedWithoutMetrics: number;
  now: Date;
  windowDays: number;
}

export function buildPerformanceReport(input: PerformanceReportInput): PerformanceReport {
  const now = input.now;
  const ordered = [...input.measurements].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const measured = ordered.filter((item) => availableMetrics(item.metrics).length > 0);
  const basis = resolveBasis(measured);
  const values = basis ? measured.map((item) => ({ item, value: basisValueOf(item.metrics, basis) })) : [];
  const withValue = values.filter((entry): entry is { item: PerformanceMeasurement; value: number } => entry.value !== null);
  const baseline = withValue.length >= MIN_BASELINE_ITEMS
    ? withValue.reduce((total, entry) => total + entry.value, 0) / withValue.length
    : null;

  const topics = assignTopics(measured.map((item) => ({ key: item.instagramMediaId, text: `${item.title}\n${item.caption}` })));

  const items: PerformanceItemView[] = measured.map((item) => {
    const value = basis ? basisValueOf(item.metrics, basis) : null;
    const peers = value === null ? [] : withValue.filter((entry) => entry.item.instagramMediaId !== item.instagramMediaId);
    const peerAverage = peers.length ? peers.reduce((total, entry) => total + entry.value, 0) / peers.length : null;
    const comparison = comparable(value, peerAverage, peers.length);
    return {
      instagramMediaId: item.instagramMediaId,
      draftId: item.draftId,
      contentType: item.contentType,
      contentTypeLabel: performanceContentTypeLabel(item.contentType),
      title: item.title || "Published content",
      topic: topics.get(item.instagramMediaId) ?? null,
      purpose: classifyPurpose(item.title, item.caption),
      purposeLabel: CONTENT_PURPOSE_LABELS[classifyPurpose(item.title, item.caption)],
      publishedAt: item.publishedAt,
      collectedAt: item.collectedAt,
      metrics: item.metrics,
      availableMetrics: availableMetrics(item.metrics),
      interactions: interactionCount(item.metrics),
      engagementRate: engagementRateOf(item.metrics),
      basisValue: value,
      multiple: comparison?.multiple ?? null,
      difference: comparison?.difference ?? null,
    };
  });

  const byContentType = groupBy(items, (item) => item.contentType, (item) => performanceContentTypePlural(item.contentType));
  const byTopic = groupBy(items, (item) => item.topic, (item) => (item.topic ? topicLabel(item.topic) : ""));
  const byPurpose = groupBy(items, (item) => item.purpose, (item) => CONTENT_PURPOSE_LABELS[item.purpose]);
  const trend = buildTrend(withValue, now);
  const best = pickBest(items);
  const confidence = measured.length >= MIN_ITEMS_FOR_HEADLINE ? "moderate" : measured.length >= MIN_BASELINE_ITEMS ? "low" : "none";
  const signals = buildSignals({ basis, baseline, baselineSample: withValue.length, items, byContentType, byTopic, byPurpose, trend, best, confidence });
  const headline = buildHeadline({ confidence, best, byContentType, byTopic });

  const report: PerformanceReport = {
    generatedAt: now.toISOString(),
    windowDays: input.windowDays,
    publishedItems: measured.length + input.publishedWithoutMetrics,
    measuredItems: measured.length,
    publishedWithoutMetrics: input.publishedWithoutMetrics,
    items,
    confidence,
    basis,
    recentAverage: baseline,
    baselineSample: withValue.length,
    best,
    trend,
    byContentType,
    byTopic,
    byPurpose,
    signals,
    headline,
    emptyReason: null,
    lastCollectedAt: measured.reduce<string | null>((latest, item) => (!latest || Date.parse(item.collectedAt) > Date.parse(latest) ? item.collectedAt : latest), null),
  };
  report.emptyReason = resolveEmptyReason(report);
  return report;
}

/**
 * Picks the comparison basis: the account's widest-shared audience metric,
 * otherwise engagement. Only a basis that at least MIN_BASELINE_ITEMS items
 * share is usable — a metric one post happens to expose proves nothing.
 */
export function resolveBasis(measured: PerformanceMeasurement[]): PerformanceBasis | null {
  const required = Math.max(MIN_BASELINE_ITEMS, Math.ceil(measured.length / 2));
  for (const metric of AUDIENCE_METRIC_PREFERENCE) {
    const coverage = measured.filter((item) => item.metrics[metric] !== undefined).length;
    if (coverage >= required) return { key: metric as PerformanceBasisKey, label: AUDIENCE_BASIS_LABELS[metric] ?? metric };
  }
  const engagementCoverage = measured.filter((item) => interactionCount(item.metrics) !== null).length;
  return engagementCoverage >= required ? ENGAGEMENT_BASIS : null;
}

function comparable(value: number | null, peerAverage: number | null, peers: number): { multiple: number; difference: number } | null {
  if (value === null || peerAverage === null) return null;
  if (peers < MIN_BASELINE_ITEMS || peerAverage < MIN_BASELINE_VALUE) return null;
  return { multiple: value / peerAverage, difference: value - peerAverage };
}

function groupBy(
  items: PerformanceItemView[],
  keyOf: (item: PerformanceItemView) => string | null,
  labelOf: (item: PerformanceItemView) => string,
): PerformanceGroupView[] {
  const groups = new Map<string, { label: string; items: PerformanceItemView[] }>();
  for (const item of items) {
    if (item.basisValue === null) continue;
    const key = keyOf(item);
    if (!key) continue;
    const group = groups.get(key) ?? { label: labelOf(item), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const views: PerformanceGroupView[] = [];
  for (const [key, group] of groups) {
    if (group.items.length < MIN_GROUP_ITEMS) continue;
    const average = group.items.reduce((total, item) => total + (item.basisValue ?? 0), 0) / group.items.length;
    const others = items.filter((item) => item.basisValue !== null && keyOf(item) !== key);
    const otherAverage = others.length >= MIN_BASELINE_ITEMS
      ? others.reduce((total, item) => total + (item.basisValue ?? 0), 0) / others.length
      : null;
    const multiple = otherAverage !== null && otherAverage >= MIN_BASELINE_VALUE ? average / otherAverage : null;
    views.push({ key, label: group.label, sampleSize: group.items.length, average, multiple, engagement: groupEngagement(group.items) });
  }
  return views.sort((a, b) => (b.multiple ?? 0) - (a.multiple ?? 0) || b.sampleSize - a.sampleSize || a.key.localeCompare(b.key));
}

/**
 * One engagement metric every item in a group really reported (saves, likes,
 * shares...). Requires every group member to have it, so the averages compare
 * like with like.
 */
function groupEngagement(items: PerformanceItemView[]): { metric: PerformanceMetric; label: string; average: number } | undefined {
  const candidates: PerformanceMetric[] = ["saves", "shares", "comments", "likes"];
  for (const metric of candidates) {
    if (!items.every((item) => item.metrics[metric] !== undefined)) continue;
    return { metric, label: metric, average: items.reduce((total, item) => total + (item.metrics[metric] ?? 0), 0) / items.length };
  }
  return undefined;
}

function buildTrend(withValue: { item: PerformanceMeasurement; value: number }[], now: Date): PerformanceTrend | null {
  const day = 86_400_000;
  const recent = withValue.filter((entry) => now.getTime() - Date.parse(entry.item.publishedAt) <= 7 * day);
  const previous = withValue.filter((entry) => {
    const age = now.getTime() - Date.parse(entry.item.publishedAt);
    return age > 7 * day && age <= 14 * day;
  });
  if (recent.length < MIN_GROUP_ITEMS || previous.length < MIN_GROUP_ITEMS) return null;
  const recentAverage = recent.reduce((total, entry) => total + entry.value, 0) / recent.length;
  const previousAverage = previous.reduce((total, entry) => total + entry.value, 0) / previous.length;
  if (previousAverage < MIN_BASELINE_VALUE) return null;
  return { recentDays: 7, recentAverage, previousAverage, multiple: recentAverage / previousAverage, recentSample: recent.length, previousSample: previous.length };
}

function pickBest(items: PerformanceItemView[]): PerformanceItemView | null {
  if (items.length < MIN_BASELINE_ITEMS) return null;
  const winners = items
    .filter((item) => item.multiple !== null && item.multiple >= MIN_MEANINGFUL_MULTIPLE && item.basisValue !== null)
    .sort((a, b) => (b.multiple ?? 0) - (a.multiple ?? 0) || (b.basisValue ?? 0) - (a.basisValue ?? 0));
  if (winners.length) return winners[0];
  // With nothing meaningfully above the average, the best-reach item is still
  // a true fact — but only when a basis exists to rank by.
  const ranked = items.filter((item) => item.basisValue !== null).sort((a, b) => (b.basisValue ?? 0) - (a.basisValue ?? 0));
  return ranked.length >= MIN_BASELINE_ITEMS ? ranked[0] : null;
}

interface SignalInput {
  basis: PerformanceBasis | null;
  baseline: number | null;
  baselineSample: number;
  items: PerformanceItemView[];
  byContentType: PerformanceGroupView[];
  byTopic: PerformanceGroupView[];
  byPurpose: PerformanceGroupView[];
  trend: PerformanceTrend | null;
  best: PerformanceItemView | null;
  confidence: PerformanceConfidence;
}

function buildSignals(input: SignalInput): string[] {
  const signals: string[] = [];
  const basisLabel = input.basis?.label ?? null;
  if (input.confidence === "none" || !basisLabel) {
    return signals;
  }
  if (input.baselineSample >= MIN_BASELINE_ITEMS && (input.baseline ?? 0) > 0) {
    signals.push(`Compared on ${basisLabel} across ${input.baselineSample} published item${input.baselineSample === 1 ? "" : "s"}.`);
  }
  const typeWinner = firstWinner(input.byContentType);
  if (typeWinner?.multiple) {
    signals.push(`${typeWinner.label} are averaging ${formatMultiple(typeWinner.multiple)} your recent average across ${typeWinner.sampleSize} item${typeWinner.sampleSize === 1 ? "" : "s"}.`);
  }
  const topicWinner = firstWinner(input.byTopic);
  if (topicWinner?.multiple) {
    signals.push(`Content about ${topicWinner.label} is averaging ${formatMultiple(topicWinner.multiple)} your recent average.`);
  }
  const purposeSaveSignal = purposeEngagementSignal(input.byPurpose, "saves");
  if (purposeSaveSignal) signals.push(purposeSaveSignal);
  const purposeWinner = firstWinner(input.byPurpose);
  if (purposeWinner?.multiple) {
    signals.push(`${purposeWinner.label} content is averaging ${formatMultiple(purposeWinner.multiple)} your recent average across ${purposeWinner.sampleSize} item${purposeWinner.sampleSize === 1 ? "" : "s"}.`);
  }
  if (input.trend) {
    const direction = input.trend.multiple >= 1.05 ? "above" : input.trend.multiple <= 0.95 ? "below" : "level with";
    signals.push(direction === "level with"
      ? `Your last 7 days are level with the previous 7 days (${formatNumber(input.trend.recentAverage)} vs ${formatNumber(input.trend.previousAverage)} ${basisLabel} per item).`
      : `Your last 7 days are ${formatMultiple(direction === "above" ? input.trend.multiple : 1 / input.trend.multiple)} ${direction} the previous 7 days (${formatNumber(input.trend.recentAverage)} vs ${formatNumber(input.trend.previousAverage)} ${basisLabel} per item).`);
  }
  if (input.best?.multiple && input.best.multiple >= MIN_MEANINGFUL_MULTIPLE) {
    signals.push(`Best recent performer: “${truncate(input.best.title, 60)}” at ${formatMultiple(input.best.multiple)} your recent average.`);
  }
  const rateItem = input.items.find((item) => item.engagementRate !== null && item.basisValue !== null);
  if (rateItem?.engagementRate !== null && rateItem?.engagementRate !== undefined && input.baselineSample >= MIN_BASELINE_ITEMS) {
    signals.push(`Engagement rate is tracked on reach: ${(rateItem.engagementRate * 100).toFixed(1)}% on “${truncate(rateItem.title, 48)}”.`);
  }
  return signals;
}

/** "Educational content drives 2.4× more saves than promotional posts." */
function purposeEngagementSignal(groups: PerformanceGroupView[], metric: PerformanceMetric): string | null {
  const withMetric = groups.filter((group) => group.engagement?.metric === metric);
  const best = withMetric.filter((group) => group.engagement).sort((a, b) => (b.engagement?.average ?? 0) - (a.engagement?.average ?? 0));
  if (best.length < 2) return null;
  const [top, ...rest] = best;
  const lowest = rest[rest.length - 1];
  const topAverage = top.engagement?.average ?? 0;
  const lowAverage = lowest.engagement?.average ?? 0;
  if (lowAverage <= 0 || topAverage / lowAverage < MIN_MEANINGFUL_MULTIPLE) return null;
  return `${lower(top.label)} content is driving ${formatMultiple(topAverage / lowAverage)} more ${metric} than ${lower(lowest.label)} content (${formatNumber(topAverage)} vs ${formatNumber(lowAverage)} per item).`;
}

function firstWinner(groups: PerformanceGroupView[]): PerformanceGroupView | null {
  const winner = groups.find((group) => group.multiple !== null && group.multiple >= MIN_MEANINGFUL_MULTIPLE);
  return winner ?? null;
}

function buildHeadline(input: {
  confidence: PerformanceConfidence;
  best: PerformanceItemView | null;
  byContentType: PerformanceGroupView[];
  byTopic: PerformanceGroupView[];
}): string | null {
  if (input.confidence !== "moderate") return null;
  const topic = firstWinner(input.byTopic);
  const type = firstWinner(input.byContentType);
  const winner = topic ?? type;
  if (!winner?.multiple) return null;
  const subject = topic
    ? `${type?.label ?? "Your content"} about ${topic.label}`
    : `${winner.label}`;
  const shape = topic && type ? `${lower(type.label)}` : "that kind of content";
  return `MARA learned: ${subject} performed ${formatMultiple(winner.multiple)} better than your recent average, so upcoming plans favour more ${shape} like it.`;
}

function resolveEmptyReason(report: PerformanceReport): PerformanceEmptyReason | null {
  if (report.measuredItems === 0) {
    return report.publishedItems > 0 ? "no_metrics_yet" : "no_published_content";
  }
  if (report.measuredItems < MIN_BASELINE_ITEMS) return "not_enough_history";
  if (!report.basis) return "no_comparable_metrics";
  return null;
}

/** "2.1×" — one decimal, always relative to a real measured average. */
export function formatMultiple(multiple: number): string {
  return `${(Math.round(multiple * 10) / 10).toFixed(1)}×`;
}

/** Integer-ish counts for sentences: 12 or 12.5. */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function truncate(value: string, max: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function lower(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** Every metric name the model understands, for tests and diagnostics. */
export const SUPPORTED_METRICS = PERFORMANCE_METRICS;

export type { ContentPurpose, PerformanceBasis, PerformanceBasisKey, PerformanceMetric };
