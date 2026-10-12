/**
 * Feature flag for giving MARA verified trend evidence while planning.
 *
 * OFF unless VOOM_TREND_CONTEXT_ENABLED is exactly "true". When off, planning
 * is byte-for-byte what it was before Trend Intelligence existed. When on,
 * evidence still reaches MARA only if a trend loader is supplied — there is no
 * production loader yet (merchants have no stored market), so production
 * stays unchanged even with the flag on.
 */
export function trendContextEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VOOM_TREND_CONTEXT_ENABLED === "true";
}
