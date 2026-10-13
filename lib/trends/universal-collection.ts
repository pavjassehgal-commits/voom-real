import "server-only";

import { discoverPublicHolidays } from "./connectors/public-holidays";
import { discoverTopWikipediaArticles, PAGEVIEWS_WORLDWIDE_MARKET } from "./connectors/wikimedia-pageviews";
import { listUsableTrendObservationsRpc } from "./read-model";
import { storeTrendObservations } from "./storage";
import type { TrendRpcClient } from "./supabase-rpc";
import type { TrendObservation } from "./types";

/**
 * Governed, bounded collection for the multi-industry sources.
 *
 * For every market the order is the same and fails closed:
 *   1. governance preflight through the read RPC: the source must be approved
 *      and its coverage verified for that market, otherwise NO request is made;
 *   2. rate limit: a market already collected within 20 hours is skipped;
 *   3. bounded GETs (holidays: 1-2 per country; pageviews: 1 per language);
 *   4. storage through the store RPC (duplicates reported, never overwritten).
 * It never approves anything and never creates MARA contexts.
 */

export const UNIVERSAL_COLLECTION_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
export const MAX_HOLIDAY_COUNTRIES = 12;

/** Countries checked for holiday coverage by default. Nothing is fetched unless the owner approved the market. */
export const DEFAULT_HOLIDAY_COUNTRIES = ["GB", "US", "CA", "AU", "IE", "NZ", "DE", "FR", "ES", "IT", "NL", "ZA"] as const;

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export type MarketCollection = {
  source: "public_holidays_nager" | "wikimedia_pageviews";
  market: string;
  status: "not_authorized" | "read_failed" | "skipped_recently_collected" | "no_data" | "source_failed" | "completed";
  code?: string;
  requests: number;
  discovered: number;
  stored: number;
  duplicate: number;
  rejected: number;
};

export type UniversalCollectionReport = {
  runAt: string;
  markets: MarketCollection[];
  requests: number;
  approvalsCreated: 0;
  contextsCreated: 0;
};

async function preflight(client: TrendRpcClient, country: string, sourceId: string, now: Date):
  Promise<{ ok: true } | { ok: false; status: MarketCollection["status"]; code?: string }> {
  const read = await listUsableTrendObservationsRpc(client, { platform: "web", country, limit: 200 });
  if (read.status !== "ok") return { ok: false, status: "read_failed", code: read.status === "invalid_query" ? read.reason : read.code };
  if (!read.permittedSourceIds.includes(sourceId)) return { ok: false, status: "not_authorized", code: `${sourceId}_not_approved_or_not_covered` };
  const last = read.observations.filter((o) => o.sourceId === sourceId)
    .map((o) => Date.parse(o.retrievedAt)).reduce((max, t) => Math.max(max, t), Number.NEGATIVE_INFINITY);
  if (Number.isFinite(last) && now.getTime() - last < UNIVERSAL_COLLECTION_MIN_INTERVAL_MS) return { ok: false, status: "skipped_recently_collected" };
  return { ok: true };
}

async function store(client: TrendRpcClient, observations: TrendObservation[], now: Date) {
  if (observations.length === 0) return { stored: 0, duplicate: 0, rejected: 0 };
  const result = await storeTrendObservations(client, observations, { now, maxBatch: 30 });
  return { stored: result.counts.stored, duplicate: result.counts.duplicate, rejected: result.counts.rejected + result.counts.conflict + result.counts.invalidated };
}

export async function runUniversalTrendCollection(input: {
  client: TrendRpcClient;
  now: Date;
  fetch: FetchLike;
  holidayCountries?: readonly string[];
  pageviewLanguages?: readonly string[];
}): Promise<UniversalCollectionReport> {
  const network = input.fetch;
  let requests = 0;
  const counted: FetchLike = (url, init) => { requests += 1; return network(url, init); };
  const markets: MarketCollection[] = [];
  const empty = { requests: 0, discovered: 0, stored: 0, duplicate: 0, rejected: 0 };

  const countries = [...new Set(input.holidayCountries ?? DEFAULT_HOLIDAY_COUNTRIES)].filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, MAX_HOLIDAY_COUNTRIES);
  for (const country of countries) {
    const gate = await preflight(input.client, country, "public_holidays_nager", input.now);
    if (!gate.ok) { markets.push({ source: "public_holidays_nager", market: country, status: gate.status, code: gate.code, ...empty }); continue; }
    const before = requests;
    const found = await discoverPublicHolidays({ now: input.now, country, fetch: counted });
    if (found.status === "failed") { markets.push({ source: "public_holidays_nager", market: country, status: "source_failed", code: found.code, ...empty, requests: requests - before }); continue; }
    if (found.status === "no_data") { markets.push({ source: "public_holidays_nager", market: country, status: "no_data", ...empty, requests: requests - before }); continue; }
    const saved = await store(input.client, found.holidays.map((h) => h.observation), input.now);
    markets.push({ source: "public_holidays_nager", market: country, status: "completed", requests: requests - before, discovered: found.holidays.length, ...saved });
  }

  for (const language of [...new Set(input.pageviewLanguages ?? ["en"])].slice(0, 3)) {
    const market = `${PAGEVIEWS_WORLDWIDE_MARKET}/${language}`;
    const gate = await preflight(input.client, PAGEVIEWS_WORLDWIDE_MARKET, "wikimedia_pageviews", input.now);
    if (!gate.ok) { markets.push({ source: "wikimedia_pageviews", market, status: gate.status, code: gate.code, ...empty }); continue; }
    const before = requests;
    const found = await discoverTopWikipediaArticles({ now: input.now, language, fetch: counted });
    if (found.status === "failed") { markets.push({ source: "wikimedia_pageviews", market, status: "source_failed", code: found.code, ...empty, requests: requests - before }); continue; }
    const saved = await store(input.client, found.kept.map((k) => k.observation), input.now);
    markets.push({ source: "wikimedia_pageviews", market, status: "completed", requests: requests - before, discovered: found.kept.length, ...saved });
  }

  return { runAt: input.now.toISOString(), markets, requests, approvalsCreated: 0, contextsCreated: 0 };
}
