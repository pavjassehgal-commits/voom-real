import "server-only";

import { parseTrendObservation } from "../schema";
import type { TrendObservation } from "../types";

/**
 * Nager.Date public holidays: free, keyless, open-source (MIT) calendar API.
 *
 * One bounded GET per country and calendar year (at most two years when the
 * horizon crosses 31 December). Only NATIONWIDE public holidays inside the
 * horizon are kept; regional observances are dropped rather than presented
 * as national. The holiday date is carried in the evidence URL fragment
 * (".../PublicHolidays/{year}/{country}#{date}") so the stored record proves
 * it. No popularity is claimed: a holiday is a calendar fact.
 */

const ENDPOINT = "https://date.nager.at/api/v3/PublicHolidays";
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const PUBLIC_HOLIDAYS_MAX_PER_COUNTRY = 15;

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export type DiscoveredHoliday = { observation: TrendObservation; date: string; name: string };

export type HolidayDiscoveryResult =
  | { status: "ok"; country: string; holidays: DiscoveredHoliday[]; rejected: number; requests: number }
  | { status: "no_data"; country: string; holidays: []; rejected: 0; requests: number }
  | { status: "failed"; country: string; code: "invalid_country" | "timeout" | "http_error" | "invalid_response"; holidays: []; rejected: 0; requests: number };

type Raw = { date?: unknown; name?: unknown; global?: unknown; types?: unknown };

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name.length >= 3 && name.length <= 120 && /\p{L}/u.test(name) ? name : null;
}

export async function discoverPublicHolidays(options: {
  now: Date;
  country: string;
  fetch?: FetchLike;
  horizonDays?: number;
  timeoutMs?: number;
}): Promise<HolidayDiscoveryResult> {
  const country = options.country;
  if (!COUNTRY.test(country)) return { status: "failed", country, code: "invalid_country", holidays: [], rejected: 0, requests: 0 };
  const fetcher = options.fetch ?? fetch;
  const horizonDays = Math.min(Math.max(options.horizonDays ?? 45, 1), 90);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 1_000), 20_000);
  const today = options.now.toISOString().slice(0, 10);
  const last = new Date(options.now.getTime() + horizonDays * DAY_MS).toISOString().slice(0, 10);
  const years = [...new Set([today.slice(0, 4), last.slice(0, 4)])];

  const raw: (Raw & { year: string })[] = [];
  let requests = 0;
  let sawData = false;
  for (const year of years) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      requests += 1;
      const response = await fetcher(`${ENDPOINT}/${year}/${country}`, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "Voom-Trend-Intelligence/1.0 (https://voom.today)" },
        signal: controller.signal,
        cache: "no-store",
      });
      if (response.status === 204 || response.status === 404) continue;
      if (!response.ok) return { status: "failed", country, code: "http_error", holidays: [], rejected: 0, requests };
      const payload = await response.json();
      if (!Array.isArray(payload)) return { status: "failed", country, code: "invalid_response", holidays: [], rejected: 0, requests };
      sawData = true;
      for (const item of payload) raw.push({ ...(item as Raw), year });
    } catch (error) {
      return { status: "failed", country, code: error instanceof Error && error.name === "AbortError" ? "timeout" : "invalid_response", holidays: [], rejected: 0, requests };
    } finally {
      clearTimeout(timer);
    }
  }
  if (!sawData) return { status: "no_data", country, holidays: [], rejected: 0, requests };

  const retrievedAt = options.now.toISOString();
  const windowAt = `${today}T00:00:00.000Z`;
  const holidays: DiscoveredHoliday[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const item of raw) {
    const date = typeof item.date === "string" && DATE.test(item.date) && item.date.startsWith(item.year) ? item.date : null;
    const name = cleanName(item.name);
    const isPublic = Array.isArray(item.types) && item.types.includes("Public");
    if (!date || !name || item.global !== true || !isPublic || date < today || date > last) { rejected += 1; continue; }
    const key = `${date}|${name.toLowerCase()}`;
    if (seen.has(key)) { rejected += 1; continue; }
    if (holidays.length >= PUBLIC_HOLIDAYS_MAX_PER_COUNTRY) { rejected += 1; continue; }
    const parsed = parseTrendObservation({
      id: `nager-${country}-${date}`,
      sourceId: "public_holidays_nager",
      platform: "web",
      market: { country, language: "en" },
      subject: { kind: "topic", text: name },
      window: { start: windowAt, end: windowAt },
      retrievedAt,
      metrics: {},
      evidence: [{
        sourceId: "public_holidays_nager",
        url: `${ENDPOINT}/${item.year}/${country}#${date}`,
        attribution: `Nager.Date public holidays (${country} ${item.year})`,
        retrievedAt,
      }],
    }, { now: options.now });
    if (!parsed.ok) { rejected += 1; continue; }
    seen.add(key);
    holidays.push({ observation: parsed.value, date, name });
  }
  return { status: "ok", country, holidays, rejected, requests };
}

export const PUBLIC_HOLIDAYS_ENDPOINT = ENDPOINT;
