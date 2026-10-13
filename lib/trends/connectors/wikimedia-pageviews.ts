import "server-only";

import { attentionSignals } from "../industry";
import { parseTrendObservation } from "../schema";
import type { TrendObservation } from "../types";

/**
 * Wikimedia most-viewed articles: free, keyless Wikimedia Analytics REST API
 * (pageview data is CC0; a descriptive User-Agent is required).
 *
 * One bounded GET for one language edition and one completed UTC day
 * (yesterday). The measured view count is stored as `daily_views`. Only
 * articles that name an industry or a cultural moment from the shared
 * taxonomy are kept, and unsafe topics are always dropped, so the store holds
 * business-relevant, brand-safe attention signals rather than the whole list.
 * The signal is per language edition, not per country: it is stored under
 * the worldwide market "ZZ" and presented as Wikipedia reader attention only.
 */

const ENDPOINT = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top";
const PER_ARTICLE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";
const DAY_MS = 86_400_000;
export const PAGEVIEWS_MAX_KEPT = 40;
/** No single industry may crowd out the others (films dominate the daily list). */
export const PAGEVIEWS_MAX_PER_INDUSTRY = 4;
export const PAGEVIEWS_WORLDWIDE_MARKET = "ZZ";
const PROJECTS: Record<string, string> = { en: "en.wikipedia" };

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export type DiscoveredAttention = { observation: TrendObservation; article: string; views: number; rank: number; industries: string[]; moment: string | null };

export type PageviewsDiscoveryResult =
  | { status: "ok"; day: string; kept: DiscoveredAttention[]; scanned: number; dropped: Record<string, number> }
  | { status: "failed"; day: string; code: "unsupported_language" | "not_yet_available" | "timeout" | "http_error" | "invalid_response"; kept: []; scanned: 0; dropped: Record<string, never> };

type RawArticle = { article?: unknown; views?: unknown; rank?: unknown };

/** Namespaces and service pages that are not topics. */
const NOT_A_TOPIC = /^(Main_Page|Special:|Wikipedia:|File:|Portal:|Help:|Template:|Category:|Talk:|User:|Draft:|Module:|-$)/;

function title(article: string): string {
  return article.replaceAll("_", " ").trim();
}

export async function discoverTopWikipediaArticles(options: {
  now: Date;
  language?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<PageviewsDiscoveryResult> {
  const language = options.language ?? "en";
  const day = new Date(Date.parse(`${options.now.toISOString().slice(0, 10)}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const project = PROJECTS[language];
  if (!project) return { status: "failed", day, code: "unsupported_language", kept: [], scanned: 0, dropped: {} };
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 1_000), 20_000);
  const [y, m, d] = day.split("-");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload: unknown;
  try {
    const response = await fetcher(`${ENDPOINT}/${project}/all-access/${y}/${m}/${d}`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Voom-Trend-Intelligence/1.0 (https://voom.today)" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.status === 404) return { status: "failed", day, code: "not_yet_available", kept: [], scanned: 0, dropped: {} };
    if (!response.ok) return { status: "failed", day, code: "http_error", kept: [], scanned: 0, dropped: {} };
    payload = await response.json();
  } catch (error) {
    return { status: "failed", day, code: error instanceof Error && error.name === "AbortError" ? "timeout" : "invalid_response", kept: [], scanned: 0, dropped: {} };
  } finally {
    clearTimeout(timer);
  }
  const articles = (payload as { items?: { articles?: unknown }[] })?.items?.[0]?.articles;
  if (!Array.isArray(articles)) return { status: "failed", day, code: "invalid_response", kept: [], scanned: 0, dropped: {} };

  const retrievedAt = options.now.toISOString();
  const windowStart = `${day}T00:00:00.000Z`;
  const windowEnd = new Date(Date.parse(windowStart) + DAY_MS).toISOString();
  const compactDay = day.replaceAll("-", "");
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const kept: DiscoveredAttention[] = [];
  const perIndustry: Record<string, number> = {};
  const scannedList = (articles as RawArticle[]).slice(0, 1000);
  for (const raw of scannedList) {
    const article = typeof raw.article === "string" ? raw.article : null;
    const views = typeof raw.views === "number" && Number.isInteger(raw.views) && raw.views > 0 ? raw.views : null;
    const rank = typeof raw.rank === "number" && Number.isInteger(raw.rank) && raw.rank > 0 ? raw.rank : null;
    if (!article || views === null || rank === null || article.length > 180) { drop("malformed"); continue; }
    if (NOT_A_TOPIC.test(article) || article.includes(":") || /^List_of_/i.test(article)) { drop("not_a_topic"); continue; }
    const name = title(article);
    if (!/\p{L}/u.test(name) || name.length < 3) { drop("not_a_topic"); continue; }
    const signals = attentionSignals(name);
    if (signals.unsafe) { drop("unsafe_topic"); continue; }
    const moment = signals.moment;
    if (signals.industries.length === 0 && !moment) { drop("no_business_signal"); continue; }
    if (kept.length >= PAGEVIEWS_MAX_KEPT) { drop("over_limit"); continue; }
    if (signals.industries.length > 0 && !moment
        && signals.industries.every((industry) => (perIndustry[industry] ?? 0) >= PAGEVIEWS_MAX_PER_INDUSTRY)) { drop("industry_quota"); continue; }
    const parsed = parseTrendObservation({
      id: `wikipedia-${language}-${compactDay}-${rank}`,
      sourceId: "wikimedia_pageviews",
      platform: "web",
      market: { country: PAGEVIEWS_WORLDWIDE_MARKET, language },
      subject: { kind: "topic", text: name },
      window: { start: windowStart, end: windowEnd },
      retrievedAt,
      metrics: { daily_views: { status: "measured", value: views, definitionVersion: "wikimedia_pageviews.daily_views.v1" } },
      evidence: [{
        sourceId: "wikimedia_pageviews",
        url: `${PER_ARTICLE}/${project}/all-access/all-agents/${encodeURIComponent(article)}/daily/${compactDay}/${compactDay}`,
        attribution: `Wikimedia pageviews (CC0), ${project}, ${day}`,
        retrievedAt,
      }],
    }, { now: options.now });
    if (!parsed.ok) { drop("invalid_observation"); continue; }
    for (const industry of signals.industries) perIndustry[industry] = (perIndustry[industry] ?? 0) + 1;
    kept.push({ observation: parsed.value, article, views, rank, industries: signals.industries, moment });
  }
  return { status: "ok", day, kept, scanned: scannedList.length, dropped };
}

export const WIKIMEDIA_PAGEVIEWS_ENDPOINT = ENDPOINT;
