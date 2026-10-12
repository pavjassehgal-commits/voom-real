/**
 * Confidence classification for a trend group.
 *
 * Confidence describes how well the EVIDENCE supports "this trend exists in
 * this market on this platform right now". It is a category with reasons,
 * never a score: no metric is summed, averaged, converted or compared across
 * sources, and an unavailable metric is never counted as zero.
 *
 *   insufficient — not an intended target market or language, no source
 *                  APPROVED for use by Voom, no approved source with
 *                  VERIFIED coverage for this platform and country,
 *                  everything expired, or no usable evidence (no measured
 *                  metric and no linked qualitative evidence)
 *   high         — at least two independent sources with fresh evidence, and
 *                  at least one fresh observation whose required metrics were
 *                  all measured
 *   medium       — fresh or aging evidence that is either complete
 *                  quantitative evidence, or corroborated by two sources
 *   low          — anything else that is still usable (stale only, partial
 *                  metrics, or a single qualitative report)
 *
 * Deterministic: "now" and the market policy are arguments; reasons are sorted.
 */
import type { TrendGroup } from "./dedupe";
import { assessFreshness, type FreshnessStatus } from "./freshness";
import { parseInstant } from "./schema";
import {
  DEFAULT_SOURCE_AUTHORIZATIONS,
  DEFAULT_SOURCE_COVERAGE,
  TARGET_MARKETS,
  TREND_PLATFORMS,
  UNDETERMINED_LANGUAGE,
  isTrendLanguage,
  isTrendSourceId,
  trendSource,
  type MarketPolicy,
  type SourceAuthorization,
  type SourceCoverage,
  type TargetMarket,
  type TrendMarket,
  type TrendObservation,
  type TrendPlatform,
  type TrendSourceId,
} from "./types";

export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient";

export type ConfidenceReason =
  | "unsupported_market"
  | "language_not_targeted"
  | "source_not_authorized"
  | "source_coverage_unverified"
  | "source_coverage_unavailable"
  | "all_evidence_expired"
  | "no_usable_evidence"
  | "fresh_evidence"
  | "aging_evidence"
  | "stale_evidence_only"
  | "complete_required_metrics"
  | "missing_required_metrics"
  | "qualitative_evidence_only"
  | "corroborated_by_multiple_sources"
  | "single_source";

export type ConfidenceAssessment = {
  level: ConfidenceLevel;
  reasons: ConfidenceReason[];
  /** Distinct sources among usable (unexpired, covered) observations, sorted. */
  supportingSourceIds: TrendSourceId[];
  usableObservationIds: string[];
  expiredObservationIds: string[];
  /** Observations ignored because Voom has not approved their source for use. */
  unauthorizedObservationIds: string[];
  /** Observations from approved sources ignored because coverage here is not verified. */
  uncoveredObservationIds: string[];
};

export class MarketPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketPolicyError";
  }
}

const COUNTRY = /^[A-Z]{2}$/;

/**
 * Builds a validated market policy. Defaults: Voom's intended TARGET_MARKETS,
 * DEFAULT_SOURCE_COVERAGE (nothing verified) and DEFAULT_SOURCE_AUTHORIZATIONS
 * (nothing approved). A coverage entry that claims "verified" or
 * "unavailable" must say when and how it was checked; an approval must say
 * when, by whom, and where it is recorded.
 */
export function createMarketPolicy(
  input: { targets?: readonly TargetMarket[]; coverage?: readonly SourceCoverage[]; authorizations?: readonly SourceAuthorization[] } = {},
): MarketPolicy {
  const targets = input.targets ?? TARGET_MARKETS;
  const coverage = input.coverage ?? DEFAULT_SOURCE_COVERAGE;
  const authorizations = input.authorizations ?? DEFAULT_SOURCE_AUTHORIZATIONS;
  const countries = new Set<string>();
  for (const target of targets) {
    if (!COUNTRY.test(target.country)) throw new MarketPolicyError(`Invalid ISO 3166-1 alpha-2 country code: ${target.country}`);
    if (countries.has(target.country)) throw new MarketPolicyError(`Duplicate target market: ${target.country}`);
    countries.add(target.country);
    if (target.languages.length === 0) throw new MarketPolicyError(`Target market ${target.country} has no languages.`);
    for (const language of target.languages) {
      if (!isTrendLanguage(language)) throw new MarketPolicyError(`Unregistered language tag for ${target.country}: ${language}`);
    }
  }
  const seen = new Set<string>();
  for (const entry of coverage) {
    if (!isTrendSourceId(entry.sourceId)) throw new MarketPolicyError(`Coverage names an unknown source: ${entry.sourceId}`);
    if (!(TREND_PLATFORMS as readonly string[]).includes(entry.platform) || !(trendSource(entry.sourceId).platforms as readonly string[]).includes(entry.platform)) {
      throw new MarketPolicyError(`${entry.sourceId} does not cover platform ${entry.platform}.`);
    }
    if (!COUNTRY.test(entry.country)) throw new MarketPolicyError(`Invalid coverage country: ${entry.country}`);
    if (!["verified", "unavailable", "unverified"].includes(entry.status)) throw new MarketPolicyError(`Invalid coverage status: ${entry.status}`);
    if (entry.status !== "unverified") {
      if (entry.checkedAt === null || parseInstant(entry.checkedAt) === null) throw new MarketPolicyError("Checked coverage needs an ISO 8601 checkedAt.");
      if (entry.evidence === null || entry.evidence.trim().length === 0) throw new MarketPolicyError("Checked coverage needs a description of the evidence.");
    }
    const key = JSON.stringify([entry.sourceId, entry.platform, entry.country]);
    if (seen.has(key)) throw new MarketPolicyError(`Duplicate coverage entry: ${entry.sourceId}/${entry.platform}/${entry.country}`);
    seen.add(key);
  }
  const decided = new Set<string>();
  for (const entry of authorizations) {
    if (!isTrendSourceId(entry.sourceId)) throw new MarketPolicyError(`Authorization names an unknown source: ${entry.sourceId}`);
    if (!["approved", "not_approved", "under_review"].includes(entry.status)) throw new MarketPolicyError(`Invalid authorization status: ${entry.status}`);
    if (entry.status !== "under_review") {
      if (entry.decidedAt === null || parseInstant(entry.decidedAt) === null) throw new MarketPolicyError("A decision needs an ISO 8601 decidedAt.");
      if (entry.decidedBy === null || entry.decidedBy.trim().length === 0) throw new MarketPolicyError("A decision needs decidedBy.");
    }
    if (entry.status === "approved" && (entry.reference === null || entry.reference.trim().length === 0)) {
      throw new MarketPolicyError("An approval needs a reference to its record.");
    }
    if (decided.has(entry.sourceId)) throw new MarketPolicyError(`Duplicate authorization for ${entry.sourceId}`);
    decided.add(entry.sourceId);
  }
  return { targets: [...targets], coverage: [...coverage], authorizations: [...authorizations] };
}

/** Voom's approval to use a source. Unlisted means "not_reviewed" — never usable. */
export function sourceAuthorizationStatus(sourceId: TrendSourceId, policy: MarketPolicy): SourceAuthorization["status"] | "not_reviewed" {
  return policy.authorizations.find((entry) => entry.sourceId === sourceId)?.status ?? "not_reviewed";
}

/** Whether the market is one of Voom's intended targets, in one of its target languages ("und" allowed). */
export function targetMarketStatus(market: TrendMarket, policy: MarketPolicy): "targeted" | "not_target_market" | "language_not_targeted" {
  const target = policy.targets.find((candidate) => candidate.country === market.country);
  if (!target) return "not_target_market";
  if (market.language === UNDETERMINED_LANGUAGE) return "targeted";
  return (target.languages as readonly string[]).includes(market.language) ? "targeted" : "language_not_targeted";
}

/** The checked coverage of one source for one platform and country. Unlisted means unverified. */
export function sourceCoverageStatus(
  sourceId: TrendSourceId,
  platform: TrendPlatform,
  country: string,
  policy: MarketPolicy,
): SourceCoverage["status"] {
  return policy.coverage.find((entry) => entry.sourceId === sourceId && entry.platform === platform && entry.country === country)?.status ?? "unverified";
}

type ObservationFacts = {
  observation: TrendObservation;
  freshness: FreshnessStatus;
  quantitative: boolean;
  anyMeasured: boolean;
  completeRequired: boolean;
  linkedQualitative: boolean;
};

function factsFor(observation: TrendObservation, now: Date | number | string): ObservationFacts {
  const source = trendSource(observation.sourceId);
  const quantitative = source.metrics.length > 0;
  const values = source.metrics.map((metric) => ({ metric, value: observation.metrics[metric.key] }));
  const anyMeasured = values.some(({ value }) => value?.status === "measured");
  const required = values.filter(({ metric }) => metric.required);
  const completeRequired = quantitative && required.length > 0 && required.every(({ value }) => value?.status === "measured");
  const linkedQualitative = !quantitative && observation.evidence.some((item) => item.url !== null);
  return { observation, freshness: assessFreshness(observation, now).status, quantitative, anyMeasured, completeRequired, linkedQualitative };
}

const RANK: Record<FreshnessStatus, number> = { fresh: 0, aging: 1, stale: 2, expired: 3 };

export function classifyTrendConfidence(
  group: TrendGroup,
  options: { now: Date | number | string; markets: MarketPolicy },
): ConfidenceAssessment {
  const approved = (observation: TrendObservation) => sourceAuthorizationStatus(observation.sourceId, options.markets) === "approved";
  const coverageOf = (observation: TrendObservation) =>
    sourceCoverageStatus(observation.sourceId, observation.platform, observation.market.country, options.markets);
  const authorized = group.observations.filter(approved);
  const unauthorizedObservationIds = group.observations.filter((observation) => !approved(observation)).map((o) => o.id).sort();
  const covered = authorized.filter((observation) => coverageOf(observation) === "verified");
  const uncoveredObservationIds = authorized.filter((observation) => coverageOf(observation) !== "verified").map((o) => o.id).sort();
  const facts = covered.map((observation) => factsFor(observation, options.now));
  const usable = facts.filter((fact) => fact.freshness !== "expired");
  const expiredObservationIds = facts.filter((fact) => fact.freshness === "expired").map((fact) => fact.observation.id).sort();
  const usableObservationIds = usable.map((fact) => fact.observation.id).sort();
  const supportingSourceIds = [...new Set(usable.map((fact) => fact.observation.sourceId))].sort();
  const result = (level: ConfidenceLevel, reasons: ConfidenceReason[]): ConfidenceAssessment => ({
    level,
    reasons: [...new Set(reasons)].sort(),
    supportingSourceIds,
    usableObservationIds,
    expiredObservationIds,
    unauthorizedObservationIds,
    uncoveredObservationIds,
  });

  const target = targetMarketStatus(group.market, options.markets);
  if (target === "not_target_market") return result("insufficient", ["unsupported_market"]);
  if (target === "language_not_targeted") return result("insufficient", ["language_not_targeted"]);
  if (authorized.length === 0) return result("insufficient", ["source_not_authorized"]);
  if (covered.length === 0) {
    const anyUnavailable = authorized.some((observation) => coverageOf(observation) === "unavailable");
    return result("insufficient", [anyUnavailable ? "source_coverage_unavailable" : "source_coverage_unverified"]);
  }
  if (usable.length === 0) return result("insufficient", ["all_evidence_expired"]);

  const evidential = usable.filter((fact) => fact.anyMeasured || fact.linkedQualitative);
  if (evidential.length === 0) return result("insufficient", ["no_usable_evidence"]);

  const best = evidential.reduce((current, fact) => (RANK[fact.freshness] < RANK[current] ? fact.freshness : current), "expired" as FreshnessStatus);
  const sources = new Set(evidential.map((fact) => fact.observation.sourceId));
  const freshSources = new Set(evidential.filter((fact) => fact.freshness === "fresh").map((fact) => fact.observation.sourceId));
  const completeFresh = evidential.some((fact) => fact.completeRequired && fact.freshness === "fresh");
  const completeCurrent = evidential.some((fact) => fact.completeRequired && (fact.freshness === "fresh" || fact.freshness === "aging"));
  const anyQuantitative = evidential.some((fact) => fact.quantitative);
  const anyIncomplete = evidential.some((fact) => fact.quantitative && !fact.completeRequired);

  const reasons: ConfidenceReason[] = [];
  reasons.push(best === "fresh" ? "fresh_evidence" : best === "aging" ? "aging_evidence" : "stale_evidence_only");
  reasons.push(sources.size >= 2 ? "corroborated_by_multiple_sources" : "single_source");
  if (!anyQuantitative) reasons.push("qualitative_evidence_only");
  if (evidential.some((fact) => fact.completeRequired)) reasons.push("complete_required_metrics");
  if (anyIncomplete) reasons.push("missing_required_metrics");

  if (freshSources.size >= 2 && completeFresh) return result("high", reasons);
  if (best !== "stale" && (completeCurrent || sources.size >= 2)) return result("medium", reasons);
  return result("low", reasons);
}
