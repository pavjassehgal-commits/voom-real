import "server-only";

/**
 * Trend Intelligence — the database port used by storage, policy loading and
 * the read model.
 *
 * Storage writes an observation, its metrics and its evidence in ONE
 * transaction (the proposed schema seals an observation at commit). The
 * Supabase JS client cannot run multi-statement transactions, so these
 * modules take this minimal transactional SQL port instead of
 * createAdminClient(). PGlite implements it directly (tests). A production
 * implementation must run as the service role and is deliberately not
 * provided yet: see docs/trend-intelligence/STAGE-2B-STORAGE.md.
 */

export type TrendSqlResult<T> = { rows: T[] };

export type TrendSqlClient = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<TrendSqlResult<T>>;
};

export type TrendDatabase = TrendSqlClient & {
  /** Runs `fn` in one transaction; commits when it resolves, rolls back when it throws. */
  transaction<T>(fn: (tx: TrendSqlClient) => Promise<T>): Promise<T>;
};

/**
 * The stable error token a trend guard raised (e.g. "trend_source_not_authorized"),
 * or null. Only this token ever leaves storage: raw database messages may
 * contain SQL or values and are never returned.
 */
export function trendDatabaseCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const raised = /^(trend_[a-z_]+)$/.exec(message.trim());
  if (raised) return raised[1];
  const constraint = /constraint "(trend_[a-z_]+)"/.exec(message);
  return constraint ? constraint[1] : null;
}

/** Database timestamps arrive as Date (PGlite) or ISO-ish strings (PostgREST). */
export function toIsoInstant(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid timestamp from the database.");
  return date.toISOString();
}
