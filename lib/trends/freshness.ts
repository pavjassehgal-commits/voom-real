/**
 * Freshness and expiry of trend observations.
 *
 * Age is measured from the END of the period an observation describes
 * (`window.end`), because that is how current the data is — not when Voom
 * happened to fetch it. Each source has its own policy (types.ts), which a
 * caller may override with an explicit, validated policy.
 *
 *   fresh   — age ≤ freshFor
 *   aging   — freshFor < age ≤ staleAfter
 *   stale   — staleAfter < age ≤ expiresAfter   (usable, but weak)
 *   expired — age > expiresAfter                 (must not be used)
 *
 * Deterministic: "now" is always an argument.
 */
import { parseInstant } from "./schema";
import { trendSource, type FreshnessPolicy, type TrendObservation } from "./types";

export type FreshnessStatus = "fresh" | "aging" | "stale" | "expired";

export type FreshnessAssessment = {
  status: FreshnessStatus;
  /** Milliseconds since the window ended; 0 if the window ends in the future (bounded by validation's clock skew). */
  ageMs: number;
  freshUntil: string;
  staleFrom: string;
  expiresAt: string;
};

export class FreshnessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshnessPolicyError";
  }
}

/** A policy is valid when 0 < freshFor ≤ staleAfter ≤ expiresAfter, all finite. */
export function assertValidFreshnessPolicy(policy: FreshnessPolicy): void {
  const { freshForMs, staleAfterMs, expiresAfterMs } = policy;
  const values = [freshForMs, staleAfterMs, expiresAfterMs];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
    throw new FreshnessPolicyError("Freshness durations must be positive finite numbers.");
  }
  if (!(freshForMs <= staleAfterMs && staleAfterMs <= expiresAfterMs)) {
    throw new FreshnessPolicyError("Freshness durations must satisfy freshFor ≤ staleAfter ≤ expiresAfter.");
  }
}

function toMs(now: Date | number | string): number {
  const ms = now instanceof Date ? now.getTime() : typeof now === "number" ? now : parseInstant(now);
  if (ms === null || !Number.isFinite(ms)) throw new FreshnessPolicyError("The evaluation time is not a valid instant.");
  return ms;
}

export function freshnessPolicyFor(observation: Pick<TrendObservation, "sourceId">): FreshnessPolicy {
  return trendSource(observation.sourceId).freshness;
}

export function assessFreshness(
  observation: Pick<TrendObservation, "sourceId" | "window">,
  now: Date | number | string,
  policy: FreshnessPolicy = freshnessPolicyFor(observation),
): FreshnessAssessment {
  assertValidFreshnessPolicy(policy);
  const nowMs = toMs(now);
  const endMs = parseInstant(observation.window.end);
  if (endMs === null) throw new FreshnessPolicyError("The observation window end is not a valid instant.");
  const ageMs = Math.max(0, nowMs - endMs);
  const status: FreshnessStatus =
    ageMs <= policy.freshForMs ? "fresh" : ageMs <= policy.staleAfterMs ? "aging" : ageMs <= policy.expiresAfterMs ? "stale" : "expired";
  return {
    status,
    ageMs,
    freshUntil: new Date(endMs + policy.freshForMs).toISOString(),
    staleFrom: new Date(endMs + policy.staleAfterMs).toISOString(),
    expiresAt: new Date(endMs + policy.expiresAfterMs).toISOString(),
  };
}

export function isExpired(observation: Pick<TrendObservation, "sourceId" | "window">, now: Date | number | string, policy?: FreshnessPolicy): boolean {
  return assessFreshness(observation, now, policy).status === "expired";
}

/** Splits observations into usable and expired, preserving input order. */
export function partitionByExpiry<T extends Pick<TrendObservation, "sourceId" | "window">>(
  observations: readonly T[],
  now: Date | number | string,
): { usable: T[]; expired: T[] } {
  const usable: T[] = [];
  const expired: T[] = [];
  for (const observation of observations) (isExpired(observation, now) ? expired : usable).push(observation);
  return { usable, expired };
}
