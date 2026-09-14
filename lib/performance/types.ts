/**
 * Voom Performance Intelligence — the internal performance model.
 *
 * This is the ONE shape MARA and every Voom screen read. It exists so nothing
 * outside `lib/instagram/client.ts` ever depends on a Meta response shape:
 * provider metric names, provider payload envelopes and provider-specific
 * availability rules all stop here.
 *
 * Truthfulness rules (pure, unit-testable, no I/O):
 *   - a metric key exists ONLY when the provider actually returned a real
 *     number for it; a missing metric is an ABSENT KEY, never 0 and never null,
 *   - every value is a finite, non-negative integer,
 *   - unknown provider metric names are ignored instead of guessed,
 *   - engagement rate is only computed when a legitimate denominator (reach)
 *     was really returned — otherwise there is no rate at all.
 *
 * Pure module: no I/O, no `server-only`, directly unit tested.
 */

/** Every metric Voom can store. Counts only — no rates, no percentages. */
export const PERFORMANCE_METRICS = [
  "reach",
  "impressions",
  "views",
  "plays",
  "likes",
  "comments",
  "saves",
  "shares",
  "replies",
  "follows",
  "profile_visits",
  "total_interactions",
] as const;

export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

export type PerformanceMetrics = Partial<Record<PerformanceMetric, number>>;

/** Short, honest UI labels. "Saves" not "Saved", "Interactions" not "Engagement score". */
export const PERFORMANCE_METRIC_LABELS: Record<PerformanceMetric, string> = {
  reach: "Reach",
  impressions: "Impressions",
  views: "Views",
  plays: "Plays",
  likes: "Likes",
  comments: "Comments",
  saves: "Saves",
  shares: "Shares",
  replies: "Replies",
  follows: "Follows",
  profile_visits: "Profile visits",
  total_interactions: "Interactions",
};

/** Which provider surface returned a stored metric. */
export type MetricSource = "media_node" | "insights";

export type MetricSources = Partial<Record<PerformanceMetric, MetricSource>>;

export type PerformanceContentType = "post" | "reel" | "story";

export const PERFORMANCE_CONTENT_TYPES: PerformanceContentType[] = ["post", "reel", "story"];

export function performanceContentTypeLabel(contentType: PerformanceContentType): string {
  return contentType === "post" ? "Instagram Post" : contentType === "reel" ? "Reel" : "Instagram Story";
}

/** Short label for a comparison sentence: "Reels", "Posts", "Stories". */
export function performanceContentTypePlural(contentType: PerformanceContentType): string {
  return contentType === "post" ? "Posts" : contentType === "reel" ? "Reels" : "Stories";
}

/** Maps Voom's publish queue media kind onto the performance content type. */
export function performanceContentTypeForMediaKind(mediaKind: string): PerformanceContentType | null {
  if (mediaKind === "image" || mediaKind === "post") return "post";
  if (mediaKind === "reel") return "reel";
  if (mediaKind === "story") return "story";
  return null;
}

/**
 * The comparison basis used for relative ("1.8× your recent average") signals.
 *
 * `audience` metrics compare how many accounts a piece reached; `engagement`
 * compares how many interactions it produced. Content types that do not expose
 * a shared audience metric are compared on engagement instead — never by
 * mixing an audience number with an interaction number.
 */
export type PerformanceBasisKey = Extract<PerformanceMetric, "reach" | "views" | "plays" | "impressions"> | "engagement";

export interface PerformanceBasis {
  key: PerformanceBasisKey;
  label: string;
}

export const ENGAGEMENT_METRICS: PerformanceMetric[] = ["likes", "comments", "saves", "shares", "replies"];

/** Audience-scale metrics in preference order (reach first, most comparable). */
export const AUDIENCE_METRIC_PREFERENCE: PerformanceMetric[] = ["reach", "views", "plays", "impressions"];

export const ENGAGEMENT_BASIS: PerformanceBasis = {
  key: "engagement",
  label: "engagement (likes, comments, saves, shares, replies)",
};

export const AUDIENCE_BASIS_LABELS: Record<string, string> = {
  reach: "reach (accounts reached)",
  views: "views",
  plays: "plays",
  impressions: "impressions",
};

/** One measured, already-published piece of Instagram content. */
export interface PerformanceItem {
  instagramMediaId: string;
  draftId: string | null;
  contentType: PerformanceContentType;
  contentTypeLabel: string;
  title: string;
  /** Derived from the stored title/caption; null when nothing distinctive. */
  topic: string | null;
  /** Derived from the stored title/caption (educational / promotional / ...). */
  purpose: string;
  publishedAt: string;
  collectedAt: string;
  metrics: PerformanceMetrics;
  availableMetrics: PerformanceMetric[];
  sources: MetricSources;
  /** Sum of the engagement metrics that were really returned; null when none. */
  interactions: number | null;
  /** interactions / reach — only when reach was really returned. */
  engagementRate: number | null;
  /** Its value on the account's comparison basis, when one exists. */
  basisValue: number | null;
}

export interface PerformanceComparison {
  metric: PerformanceBasisKey;
  metricLabel: string;
  value: number;
  baseline: number;
  /** value / baseline, rounded by the presentation layer. */
  multiple: number;
  peers: number;
}

export interface MeasuredPerformanceItem extends PerformanceItem {
  comparison: PerformanceComparison | null;
}

/**
 * Normalizes one provider insight entry into (metric, value).
 *
 * Accepted envelopes, all seen from Meta across Graph versions:
 *   { name, values: [{ value }] }        — lifetime media insights
 *   { name, total_value: { value } }     — total_value metric type
 *   { name, value }                      — defensive, some breakdowns
 *
 * Anything else (unknown name, non-numeric, negative, infinite, NaN) returns
 * null: Voom stores what it can prove and nothing else.
 */
export function normalizeInsightEntry(entry: unknown): { metric: PerformanceMetric; value: number } | null {
  if (!isRecord(entry)) return null;
  const providerName = typeof entry.name === "string" ? entry.name : null;
  if (providerName === null) return null;
  const metric = providerMetricName(providerName);
  if (!metric) return null;
  const value = readNumber(entry.values) ?? readNumber(entry.total_value) ?? entry.value;
  const normalized = toCount(value);
  return normalized === null ? null : { metric, value: normalized };
}

/** Normalizes a whole provider insight payload (`{ data: [...] }`). */
export function normalizeInsightPayload(payload: unknown): { metrics: PerformanceMetrics; metricsAvailable: PerformanceMetric[] } {
  const entries = isRecord(payload) && Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload) ? payload : [];
  const metrics: PerformanceMetrics = {};
  for (const entry of entries) {
    const normalized = normalizeInsightEntry(entry);
    // The FIRST real value wins; a duplicate metric is never summed, because
    // summing two envelopes would invent a number Meta never returned.
    if (normalized && metrics[normalized.metric] === undefined) metrics[normalized.metric] = normalized.value;
  }
  return { metrics, metricsAvailable: Object.keys(metrics) as PerformanceMetric[] };
}

/**
 * Metrics Voom can legitimately read from the media node itself (documented
 * media fields, available with the basic read permission even when per-media
 * insights are not). `like_count` / `comments_count` are real Meta values.
 */
export function normalizeMediaNode(row: Record<string, unknown> | null | undefined): PerformanceMetrics {
  if (!row) return {};
  const metrics: PerformanceMetrics = {};
  const likes = toCount(row.like_count);
  const comments = toCount(row.comments_count);
  if (likes !== null) metrics.likes = likes;
  if (comments !== null) metrics.comments = comments;
  return metrics;
}

export function mergeMetrics(...sources: PerformanceMetrics[]): PerformanceMetrics {
  const merged: PerformanceMetrics = {};
  for (const source of sources) {
    for (const metric of PERFORMANCE_METRICS) {
      // Earlier sources win: insights (the richer surface) take precedence over
      // the media-node fallback for the same metric.
      if (source[metric] !== undefined && merged[metric] === undefined) merged[metric] = source[metric];
    }
  }
  return merged;
}

export function availableMetrics(metrics: PerformanceMetrics): PerformanceMetric[] {
  return PERFORMANCE_METRICS.filter((metric) => metrics[metric] !== undefined);
}

/** Total interactions from the engagement metrics that were really returned. */
export function interactionCount(metrics: PerformanceMetrics): number | null {
  if (metrics.total_interactions !== undefined) return metrics.total_interactions;
  const present = ENGAGEMENT_METRICS.filter((metric) => metrics[metric] !== undefined);
  if (!present.length) return null;
  return present.reduce((total, metric) => total + (metrics[metric] ?? 0), 0);
}

/**
 * Engagement rate with a legitimate denominator only: reach. Without reach
 * there is no rate — Voom never substitutes follower count, impressions or a
 * made-up base.
 */
export function engagementRateOf(metrics: PerformanceMetrics): number | null {
  const interactions = interactionCount(metrics);
  const reach = metrics.reach;
  if (interactions === null || reach === undefined || reach <= 0) return null;
  return interactions / reach;
}

/** The value of one item on a comparison basis, or null when unavailable. */
export function basisValueOf(metrics: PerformanceMetrics, basis: PerformanceBasis): number | null {
  if (basis.key === "engagement") return interactionCount(metrics);
  const value = metrics[basis.key];
  return value === undefined ? null : value;
}

/** Provider metric name -> internal metric. Unknown names are ignored. */
function providerMetricName(name: string): PerformanceMetric | null {
  switch (name) {
    case "reach": return "reach";
    case "impressions": return "impressions";
    case "views": return "views";
    // Legacy Graph names for the same documented count.
    case "video_views": return "views";
    case "plays": return "plays";
    case "video_plays": return "plays";
    case "likes": return "likes";
    case "comments": return "comments";
    // Meta's media insights call the saves metric `saved`.
    case "saved": case "saves": return "saves";
    case "shares": return "shares";
    case "replies": return "replies";
    case "follows": return "follows";
    case "profile_visits": return "profile_visits";
    case "total_interactions": return "total_interactions";
    default: return null;
  }
}

function readNumber(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? readNumber((value[0] as Record<string, unknown> | undefined)?.value) : undefined;
  if (isRecord(value)) return value.value;
  return value;
}

function toCount(value: unknown): number | null {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
