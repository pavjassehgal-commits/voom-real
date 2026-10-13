import "server-only";

import { createMarketPolicy } from "./confidence";
import { toIsoInstant, type TrendSqlClient } from "./db";
import { isTrendSourceId, TREND_GOVERNANCE_SETTINGS, trendSource, type MarketPolicy, type SourceAuthorization, type SourceCoverage, type TrendPlatform } from "./types";

/**
 * Trend Intelligence — loads source authorization and market coverage from
 * the proposed storage schema into a Stage 1 MarketPolicy.
 *
 * Deny by default. A source is usable only with an `approved` decision that
 * is complete, not in the future and not older than the review period; a
 * market only with a `verified` coverage check under the same rules. A
 * missing row, a revoked (`not_approved`) or pending (`under_review`)
 * decision, an expired or malformed record, an unknown source, or ANY error
 * while loading produces no permission.
 *
 * Review periods are provisional product defaults (TREND_GOVERNANCE_SETTINGS,
 * identical to the database's trend_*_review_period() functions). They can
 * be shortened per call, never disabled.
 */

const DAY_MS = 86_400_000;

export const POLICY_REVIEW_PERIODS = {
  /** An approval older than this must be re-confirmed before data is used. */
  authorizationMs: TREND_GOVERNANCE_SETTINGS.authorizationReviewDays * DAY_MS,
  /** A coverage check older than this must be repeated. */
  coverageMs: TREND_GOVERNANCE_SETTINGS.coverageReviewDays * DAY_MS,
} as const;

/** Bounds on how many decision rows are read; exceeding them fails closed. */
const MAX_AUTHORIZATION_ROWS = 100;
const MAX_COVERAGE_ROWS = 5000;

export type PolicyIssueReason =
  | "unknown_source"
  | "invalid_record"
  | "decision_in_future"
  | "authorization_expired"
  | "coverage_in_future"
  | "coverage_expired"
  | "policy_unavailable";

export type PolicyIssue = {
  kind: "authorization" | "coverage" | "policy";
  reason: PolicyIssueReason;
  sourceId?: string;
  platform?: string;
  country?: string;
};

export type LoadedTrendPolicy = {
  /** False when loading failed; `policy` then permits nothing. */
  complete: boolean;
  policy: MarketPolicy;
  issues: PolicyIssue[];
};

type AuthorizationRow = { source_id: string; status: string; decided_at: unknown; decided_by: string | null; reference: string | null };
type CoverageRow = { source_id: string; platform: string; country: string; status: string; checked_at: unknown; evidence: string | null };

const DENY_ALL: MarketPolicy = createMarketPolicy();

export async function loadTrendMarketPolicy(
  db: TrendSqlClient,
  options: { now: Date | number | string; reviewPeriods?: Partial<typeof POLICY_REVIEW_PERIODS> },
): Promise<LoadedTrendPolicy> {
  const nowMs = new Date(options.now).getTime();
  const periods = {
    authorizationMs: Math.min(options.reviewPeriods?.authorizationMs ?? POLICY_REVIEW_PERIODS.authorizationMs, POLICY_REVIEW_PERIODS.authorizationMs),
    coverageMs: Math.min(options.reviewPeriods?.coverageMs ?? POLICY_REVIEW_PERIODS.coverageMs, POLICY_REVIEW_PERIODS.coverageMs),
  };
  if (!Number.isFinite(nowMs) || !(periods.authorizationMs > 0) || !(periods.coverageMs > 0)) {
    return { complete: false, policy: DENY_ALL, issues: [{ kind: "policy", reason: "policy_unavailable" }] };
  }
  try {
    const authorizationRows = (await db.query<AuthorizationRow>(
      `select source_id, status, decided_at, decided_by, reference
         from public.trend_source_authorizations order by source_id limit ${MAX_AUTHORIZATION_ROWS + 1}`,
    )).rows;
    const coverageRows = (await db.query<CoverageRow>(
      `select source_id, platform, country, status, checked_at, evidence
         from public.trend_source_coverage order by source_id, platform, country limit ${MAX_COVERAGE_ROWS + 1}`,
    )).rows;
    if (authorizationRows.length > MAX_AUTHORIZATION_ROWS || coverageRows.length > MAX_COVERAGE_ROWS) {
      return { complete: false, policy: DENY_ALL, issues: [{ kind: "policy", reason: "policy_unavailable" }] };
    }

    const issues: PolicyIssue[] = [];
    const authorizations: SourceAuthorization[] = [];
    for (const row of authorizationRows) {
      const entry = authorizationFrom(row, nowMs, periods.authorizationMs, issues);
      if (entry) authorizations.push(entry);
    }
    const coverage: SourceCoverage[] = [];
    for (const row of coverageRows) {
      const entry = coverageFrom(row, nowMs, periods.coverageMs, issues);
      if (entry) coverage.push(entry);
    }
    return { complete: true, policy: createMarketPolicy({ authorizations, coverage }), issues };
  } catch {
    // Unreadable, malformed or inconsistent policy: permit nothing.
    return { complete: false, policy: DENY_ALL, issues: [{ kind: "policy", reason: "policy_unavailable" }] };
  }
}

function instantOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  try {
    return Date.parse(toIsoInstant(value));
  } catch {
    return null;
  }
}

function present(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function authorizationFrom(row: AuthorizationRow, nowMs: number, maxAgeMs: number, issues: PolicyIssue[]): SourceAuthorization | null {
  const sourceId = row.source_id;
  if (!isTrendSourceId(sourceId)) {
    issues.push({ kind: "authorization", reason: "unknown_source", sourceId });
    return null;
  }
  if (row.status === "under_review") {
    return { sourceId, status: "under_review", decidedAt: null, decidedBy: null, reference: null };
  }
  const decidedMs = instantOrNull(row.decided_at);
  if ((row.status !== "approved" && row.status !== "not_approved") || decidedMs === null || !present(row.decided_by)
    || (row.status === "approved" && !present(row.reference))) {
    issues.push({ kind: "authorization", reason: "invalid_record", sourceId });
    return null;
  }
  const decidedAt = new Date(decidedMs).toISOString();
  if (row.status === "not_approved") {
    // A refusal or revocation is always honored, whatever its age.
    return { sourceId, status: "not_approved", decidedAt, decidedBy: row.decided_by, reference: row.reference };
  }
  if (decidedMs > nowMs) {
    issues.push({ kind: "authorization", reason: "decision_in_future", sourceId });
    return null;
  }
  if (nowMs - decidedMs > maxAgeMs) {
    issues.push({ kind: "authorization", reason: "authorization_expired", sourceId });
    return null;
  }
  return { sourceId, status: "approved", decidedAt, decidedBy: row.decided_by, reference: row.reference };
}

function coverageFrom(row: CoverageRow, nowMs: number, maxAgeMs: number, issues: PolicyIssue[]): SourceCoverage | null {
  const where = { sourceId: row.source_id, platform: row.platform, country: row.country };
  if (!isTrendSourceId(row.source_id)) {
    issues.push({ kind: "coverage", reason: "unknown_source", ...where });
    return null;
  }
  if (!(trendSource(row.source_id).platforms as readonly string[]).includes(row.platform) || !/^[A-Z]{2}$/.test(row.country)) {
    issues.push({ kind: "coverage", reason: "invalid_record", ...where });
    return null;
  }
  if (row.status !== "verified") {
    // Unavailable / unverified carry no permission; they need no freshness check.
    return null;
  }
  const checkedMs = instantOrNull(row.checked_at);
  if (checkedMs === null || !present(row.evidence)) {
    issues.push({ kind: "coverage", reason: "invalid_record", ...where });
    return null;
  }
  if (checkedMs > nowMs) {
    issues.push({ kind: "coverage", reason: "coverage_in_future", ...where });
    return null;
  }
  if (nowMs - checkedMs > maxAgeMs) {
    issues.push({ kind: "coverage", reason: "coverage_expired", ...where });
    return null;
  }
  return {
    sourceId: row.source_id,
    platform: row.platform as TrendPlatform,
    country: row.country,
    status: "verified",
    checkedAt: new Date(checkedMs).toISOString(),
    evidence: row.evidence,
  };
}

/** Sources whose data may be used for one platform and country under `policy`. */
export function permittedSources(policy: MarketPolicy, platform: TrendPlatform, country: string): string[] {
  const approved = new Set(policy.authorizations.filter((entry) => entry.status === "approved").map((entry) => entry.sourceId));
  return policy.coverage
    .filter((entry) => entry.status === "verified" && entry.platform === platform && entry.country === country && approved.has(entry.sourceId))
    .map((entry) => entry.sourceId)
    .sort();
}
