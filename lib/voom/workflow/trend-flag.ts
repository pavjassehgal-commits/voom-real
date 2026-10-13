/**
 * Feature flag for giving MARA verified trend evidence while planning.
 *
 * OFF unless VOOM_TREND_CONTEXT_ENABLED is exactly "true". When off, planning
 * is byte-for-byte what it was before Trend Intelligence existed. When on,
 * Replenish uses a reviewed owner context if one exists; otherwise it matches
 * governed, usable evidence to the business's own profile (at most two trend
 * slots per run) and labels every other idea as evergreen.
 */
export function trendContextEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VOOM_TREND_CONTEXT_ENABLED === "true";
}
