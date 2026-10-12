import "server-only";

import { parseTrendObservation } from "../schema";
import type { TrendObservation } from "../types";

const ENDPOINT = "https://query.wikidata.org/sparql";
const ENTITY = /^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9][0-9]*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}T/;
const DAY_MS = 86_400_000;
/** Wikibase time precision for a calendar day. Coarser values (month 10, year 9, ...) are not dates of an event. */
const DAY_PRECISION = 11;
/** A label that is only an entity id (or nothing meaningful) is not a usable topic. */
const ENTITY_ID_LABEL = /^Q[0-9]+$/;

/**
 * Date reliability of one event, decided only from Wikidata's own statements:
 *   - "recorded": exactly one day-precision start and one day-precision end
 *     (non-deprecated statements). The dates may be stated, attributed to the
 *     Wikidata record.
 *   - "needs_verification": the record has conflicting start/end claims, a
 *     coarser-than-day claim alongside a day claim, or no end date. NO dates
 *     are presented: eventWindow is null and the fact says the dates must be
 *     verified by a person.
 * Records with no day-precision start at all are rejected, not flagged.
 */
export type WikidataDateStatus = "recorded" | "needs_verification";
export type WikidataDateIssue = "conflicting_start_dates" | "conflicting_end_dates" | "imprecise_date_claim" | "end_date_missing";

export type DiscoveredWikidataEvent = {
  observation: TrendObservation;
  /** Present only when the dates are "recorded"; never set for uncertain dates. */
  eventWindow: { start: string; end: string } | null;
  dateStatus: WikidataDateStatus;
  dateIssues: WikidataDateIssue[];
  /** The raw day-level claims, for the human reviewer only (never shown as confirmed). */
  dateClaims: { starts: string[]; ends: string[] };
  facts: [{ statement: string; evidenceUrls: [string] }];
  sourceWebsite: string | null;
};

export type WikidataDiscoveryResult =
  | { status: "ok"; events: DiscoveredWikidataEvent[]; rejected: number; rejectedReasons: Record<string, number> }
  | { status: "failed"; code: "timeout" | "http_error" | "invalid_response"; events: []; rejected: number; rejectedReasons: Record<string, never> };

type Binding = {
  event?: { value?: unknown };
  label?: { value?: unknown };
  starts?: { value?: unknown };
  ends?: { value?: unknown };
  website?: { value?: unknown };
};

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export const WIKIDATA_EVENTS_MAX_RECORDS = 25;

/**
 * One bounded query: UAE events (P17 = Q878) whose best-rank start time (P580)
 * falls in the horizon. For each event it returns EVERY non-deprecated start
 * and end statement with its precision ("time|precision", ';'-separated), and
 * the event's real English label (no label-service fallback to the Q-id).
 */
function query(now: Date, horizonDays: number): string {
  const first = now.toISOString().slice(0, 10);
  const last = new Date(now.getTime() + horizonDays * DAY_MS).toISOString().slice(0, 10);
  return `SELECT ?event (SAMPLE(?enLabel) AS ?label) (MIN(?bestStart) AS ?firstStart)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?start), "|", STR(?startPrecision)); separator=";") AS ?starts)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?end), "|", STR(?endPrecision)); separator=";") AS ?ends)
  (SAMPLE(?site) AS ?website)
WHERE {
  ?event wdt:P17 wd:Q878; wdt:P580 ?bestStart.
  FILTER(?bestStart >= "${first}T00:00:00Z"^^xsd:dateTime)
  FILTER(?bestStart <= "${last}T23:59:59Z"^^xsd:dateTime)
  ?event p:P580 ?startStatement.
  ?startStatement wikibase:rank ?startRank; psv:P580 ?startValue.
  FILTER(?startRank != wikibase:DeprecatedRank)
  ?startValue wikibase:timeValue ?start; wikibase:timePrecision ?startPrecision.
  OPTIONAL {
    ?event p:P582 ?endStatement.
    ?endStatement wikibase:rank ?endRank; psv:P582 ?endValue.
    FILTER(?endRank != wikibase:DeprecatedRank)
    ?endValue wikibase:timeValue ?end; wikibase:timePrecision ?endPrecision.
  }
  OPTIONAL { ?event rdfs:label ?enLabel. FILTER(LANG(?enLabel) = "en") }
  OPTIONAL { ?event wdt:P856 ?site. }
}
GROUP BY ?event
ORDER BY ?firstStart
LIMIT ${WIKIDATA_EVENTS_MAX_RECORDS}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function secureWebsite(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function day(value: string): string | null {
  if (!DATE.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString().slice(0, 10);
}

/** "time|precision;time|precision" → day-precision days (distinct, sorted) and whether any coarser claim exists. */
function claims(value: unknown): { days: string[]; coarse: boolean; malformed: boolean } {
  const raw = text(value);
  if (!raw) return { days: [], coarse: false, malformed: false };
  const days = new Set<string>();
  let coarse = false;
  let malformed = false;
  for (const part of raw.split(";")) {
    const [time, precision] = part.split("|");
    const parsed = time ? day(time) : null;
    const level = Number(precision);
    if (!parsed || !Number.isInteger(level)) malformed = true;
    else if (level >= DAY_PRECISION) days.add(parsed);
    else coarse = true;
  }
  return { days: [...days].sort(), coarse, malformed };
}

function meaningfulLabel(value: unknown): string | null {
  const label = text(value);
  if (!label || label.length < 3 || ENTITY_ID_LABEL.test(label) || !/\p{L}/u.test(label)) return null;
  return label;
}

export async function discoverWikidataEvents(options: {
  now: Date;
  fetch?: FetchLike;
  timeoutMs?: number;
  horizonDays?: number;
}): Promise<WikidataDiscoveryResult> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1_000), 30_000);
  const horizonDays = Math.min(Math.max(options.horizonDays ?? 120, 1), 180);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload: unknown;
  try {
    const url = new URL(ENDPOINT);
    url.searchParams.set("query", query(options.now, horizonDays));
    url.searchParams.set("format", "json");
    const response = await fetcher(url.toString(), {
      method: "GET",
      headers: { Accept: "application/sparql-results+json", "User-Agent": "Voom-Trend-Intelligence/1.0 (https://voom.today)" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return { status: "failed", code: "http_error", events: [], rejected: 0, rejectedReasons: {} };
    payload = await response.json();
  } catch (error) {
    return { status: "failed", code: error instanceof Error && error.name === "AbortError" ? "timeout" : "invalid_response", events: [], rejected: 0, rejectedReasons: {} };
  } finally {
    clearTimeout(timer);
  }

  const bindings = (payload as { results?: { bindings?: unknown } })?.results?.bindings;
  if (!Array.isArray(bindings)) return { status: "failed", code: "invalid_response", events: [], rejected: 0, rejectedReasons: {} };

  const retrievedAt = options.now.toISOString();
  const today = retrievedAt.slice(0, 10);
  const windowAt = `${today}T00:00:00.000Z`;
  const events: DiscoveredWikidataEvent[] = [];
  const seen = new Set<string>();
  const rejectedReasons: Record<string, number> = {};
  const reject = (reason: string) => { rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1; };
  if (bindings.length > WIKIDATA_EVENTS_MAX_RECORDS) rejectedReasons.over_limit = bindings.length - WIKIDATA_EVENTS_MAX_RECORDS;

  for (const raw of (bindings as Binding[]).slice(0, WIKIDATA_EVENTS_MAX_RECORDS)) {
    const match = text(raw.event?.value)?.match(ENTITY);
    if (!match) { reject("invalid_entity"); continue; }
    if (seen.has(match[1])) { reject("duplicate_entity"); continue; }
    const label = meaningfulLabel(raw.label?.value);
    if (!label) { reject("missing_english_label"); continue; }
    const starts = claims(raw.starts?.value);
    const ends = claims(raw.ends?.value);
    if (starts.malformed || ends.malformed) { reject("malformed_date"); continue; }
    if (starts.days.length === 0) { reject("no_day_precision_start"); continue; }

    const issues: WikidataDateIssue[] = [];
    if (starts.days.length > 1) issues.push("conflicting_start_dates");
    if (ends.days.length > 1) issues.push("conflicting_end_dates");
    if (starts.coarse || ends.coarse) issues.push("imprecise_date_claim");
    if (ends.days.length === 0) issues.push("end_date_missing");

    // Over only if EVERY claimed end (or, with no end, every start) is in the past.
    const lastClaim = (ends.days.length ? ends.days : starts.days).at(-1) as string;
    if (lastClaim < today) { reject("event_ended"); continue; }
    if (issues.length === 0 && ends.days[0] < starts.days[0]) { reject("end_before_start"); continue; }

    const evidenceUrl = `https://www.wikidata.org/entity/${match[1]}`;
    const parsed = parseTrendObservation({
      id: `wikidata-${match[1]}`,
      sourceId: "wikidata_events",
      platform: "web",
      market: { country: "AE", language: "en" },
      subject: { kind: "topic", text: label },
      window: { start: windowAt, end: windowAt },
      retrievedAt,
      metrics: {},
      evidence: [{ sourceId: "wikidata_events", url: evidenceUrl, attribution: "Wikidata (CC0)", retrievedAt }],
    }, { now: options.now });
    if (!parsed.ok) { reject("invalid_observation"); continue; }
    seen.add(match[1]);

    const recorded = issues.length === 0;
    const statement = recorded
      ? `${label} is scheduled in the United Arab Emirates from ${starts.days[0]} to ${ends.days[0]}, according to its Wikidata event record.`
      : `${label} is recorded in Wikidata as a United Arab Emirates event, but its dates are uncertain in that record; the dates must be verified by a person before use.`;
    events.push({
      observation: parsed.value,
      eventWindow: recorded ? { start: starts.days[0], end: ends.days[0] } : null,
      dateStatus: recorded ? "recorded" : "needs_verification",
      dateIssues: issues,
      dateClaims: { starts: starts.days, ends: ends.days },
      facts: [{ statement, evidenceUrls: [evidenceUrl] }],
      sourceWebsite: secureWebsite(raw.website?.value),
    });
  }
  const rejected = Object.values(rejectedReasons).reduce((sum, n) => sum + n, 0);
  return { status: "ok", events, rejected, rejectedReasons };
}

export const WIKIDATA_EVENTS_ENDPOINT = ENDPOINT;
