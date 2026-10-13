import "server-only";

import { listUsableTrendObservationsRpc } from "./read-model";
import {
  businessTrendProfile,
  selectTrendIdeasForBusiness,
  WORLDWIDE_MARKET,
  type BusinessProfileInput,
  type BusinessTrendSelection,
  type MatchableObservation,
} from "./relevance";
import type { TrendRpcClient } from "./supabase-rpc";

/**
 * Automatic, per-business trend matching for Replenish. No per-business
 * approval record is needed. The governed read RPC already returns only
 * evidence from sources the owner approved, in markets whose coverage was
 * verified, that is unexpired and not invalidated. The relevance rules then
 * decide fit from the business's own words. Any read failure for a market
 * simply leaves that market out (fail closed); nothing here writes.
 */

/** Countries named in a profile that are read; worldwide evidence is always read too. */
const MAX_PROFILE_MARKETS = 3;

export async function loadBusinessTrendIdeas(
  client: TrendRpcClient,
  business: BusinessProfileInput,
  now: Date,
  options: { max?: number } = {},
): Promise<BusinessTrendSelection> {
  const profile = businessTrendProfile(business);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return { status: "evergreen", profile, reason: "no_usable_evidence" };
  const countries = [...profile.markets.slice(0, MAX_PROFILE_MARKETS).map((m) => m.country), WORLDWIDE_MARKET];
  const observations: MatchableObservation[] = [];
  for (const country of countries) {
    try {
      const read = await listUsableTrendObservationsRpc(client, { platform: "web", country, limit: 200 });
      if (read.status !== "ok") continue;
      observations.push(...read.observations);
    } catch {
      continue;
    }
  }
  return selectTrendIdeasForBusiness(profile, observations, { now: nowMs, max: options.max });
}
