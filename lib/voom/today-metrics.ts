/**
 * Today performance figures — a presentation-only projection over the real
 * performance read model (stored Instagram measurements). Nothing here is
 * estimated: every number is a sum of measured values, and every figure is
 * null when there is nothing measured to sum.
 *
 * Definitions (stated on screen):
 * - Engagement = measured interactions (likes, comments, saves, shares,
 *   replies) on posts PUBLISHED in the last 7 days.
 * - Reach / Views = measured reach / views on those same posts.
 * - Change = the same engagement definition vs posts published in the 7 days
 *   before that; only when both periods have measured posts.
 * - Daily series = engagement grouped by each post's local publish date.
 */
export type TodayMetricItem = {
  draftId: string | null;
  publishedAt: string;
  interactions: number | null;
  metrics: Partial<Record<string, number>>;
};

export type TodayMetrics = {
  engagement: number | null;
  engagementChangePct: number | null;
  reach: number | null;
  views: number | null;
  measuredPosts: number;
  daily: { date: string; weekday: string; value: number }[];
};

const DAY = 86_400_000;

export function buildTodayMetrics(items: TodayMetricItem[], now: Date, timeZone: string): TodayMetrics {
  const end = now.getTime();
  const recent = items.filter((item) => inWindow(item.publishedAt, end - 7 * DAY, end));
  const previous = items.filter((item) => inWindow(item.publishedAt, end - 14 * DAY, end - 7 * DAY));
  const engagement = sumOf(recent.map((item) => item.interactions));
  const previousEngagement = sumOf(previous.map((item) => item.interactions));
  const engagementChangePct = engagement !== null && previousEngagement !== null && previousEngagement > 0
    ? Math.round(((engagement - previousEngagement) / previousEngagement) * 100)
    : null;

  const localDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const daily = Array.from({ length: 7 }, (_, index) => {
    const at = new Date(end - (6 - index) * DAY);
    const date = localDate(at.toISOString());
    const value = recent
      .filter((item) => localDate(item.publishedAt) === date)
      .reduce((sum, item) => sum + (item.interactions ?? 0), 0);
    return { date, weekday: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at), value };
  });

  return {
    engagement,
    engagementChangePct,
    reach: sumOf(recent.map((item) => item.metrics.reach ?? null)),
    views: sumOf(recent.map((item) => item.metrics.views ?? null)),
    measuredPosts: recent.filter((item) => item.interactions !== null).length,
    daily,
  };
}

/** Compact display: 18400 → "18.4K", 2400000 → "2.4M". */
export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (Math.abs(value) >= 1_000) return `${trimZero(value / 1_000)}K`;
  return String(value);
}

function trimZero(value: number) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function inWindow(iso: string, from: number, to: number) {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > from && at <= to;
}

function sumOf(values: (number | null | undefined)[]): number | null {
  const measured = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) : null;
}
