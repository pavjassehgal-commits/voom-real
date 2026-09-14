/**
 * What Meta actually exposes per media kind, in one place.
 *
 * Only current, documented, COUNT metrics are requested. Deliberately NOT
 * requested:
 *   - `impressions` — deprecated for Instagram media insights (enforced from
 *     Graph v22); asking for it fails the whole call on current versions,
 *   - `likes` on Stories — Stories do not expose likes, comments or saves,
 *   - retention/ratio metrics (`ig_reels_avg_watch_time`, `reels_skip_rate`,
 *     `navigation`) — they are not counts, so they cannot be compared with
 *     the account's own averages without inventing a conversion.
 *
 * The normalizer in lib/performance accepts the legacy names too
 * (`video_views`, `impressions`), so an older configured Graph version is
 * still stored correctly.
 */

import type { PerformanceContentType } from "@/lib/performance/types";

/** Instagram permission that gates per-media insights. */
export const INSTAGRAM_INSIGHTS_SCOPES = ["instagram_business_manage_insights", "instagram_manage_insights"] as const;

/** Provider metric names requested per content kind, most valuable first. */
export const INSIGHTS_METRICS_BY_KIND: Record<PerformanceContentType, string[]> = {
  post: ["reach", "views", "likes", "comments", "saved", "shares", "total_interactions"],
  reel: ["reach", "views", "plays", "likes", "comments", "saved", "shares", "total_interactions"],
  story: ["reach", "views", "replies", "shares", "total_interactions", "profile_visits", "follows"],
};

/**
 * The stored connection's permission list is the only honest source for "may
 * Voom read insights for this account?". An EMPTY list is treated as unknown
 * (legacy rows) and the call is attempted — a refusal is then handled
 * truthfully instead of being assumed in advance.
 */
export function hasInsightsPermission(scopes: string[]): boolean {
  if (!scopes.length) return true;
  return INSTAGRAM_INSIGHTS_SCOPES.some((scope) => scopes.includes(scope));
}
