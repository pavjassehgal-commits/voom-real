/**
 * Trend Intelligence — which verified signals fit ONE business.
 *
 * Deterministic and pure ("now" passed in, no I/O). Input: the business's own
 * profile text and observations that the database already returned as usable
 * (approved source, verified market coverage, unexpired, not invalidated).
 * Output: up to `max` trend ideas for MARA, or an explicit evergreen result.
 *
 * Honesty rules:
 *   - industries and markets come only from words the business wrote
 *     (classifyText / marketsMentioned); nothing is guessed;
 *   - an observation qualifies only through an explicit overlap with the
 *     business's industries, or as a public holiday / cultural moment that any
 *     business may mark; there is no "probably relevant" path;
 *   - country-specific evidence is used only for countries the profile names;
 *     worldwide evidence (market ZZ) is used for everyone and says so;
 *   - every fact is written from the observation's stored, structured fields
 *     (holiday name and date, measured views, Wikidata record) and attributed
 *     to its publisher. No free-text claim from a source is ever repeated;
 *   - unsafe topics (deaths, violence, politics, disasters, adult content)
 *     are never offered.
 */

import { attentionSignals, classifyText, countryName, marketsMentioned, normalizeText, REGIONAL_MOMENTS, type Industry, type MarketMention } from "./industry";
import type { TrendPromptContext } from "./opportunity";

export const WORLDWIDE_MARKET = "ZZ";
/** At most this many slots in one Replenish run are built around verified trends; the rest stay evergreen. */
export const MAX_TREND_IDEAS_PER_RUN = 2;
/** Holidays further away than this are not "now". */
export const HOLIDAY_HORIZON_DAYS = 45;

const DAY_MS = 86_400_000;
const NAGER_EVIDENCE = /^https:\/\/date\.nager\.at\/api\/v3\/PublicHolidays\/(\d{4})\/([A-Z]{2})#(\d{4}-\d{2}-\d{2})$/;
const WIKIDATA_EVIDENCE = /^https:\/\/www\.wikidata\.org\/entity\/Q[1-9][0-9]*$/;

export type BusinessProfileInput = {
  brandName?: string | null;
  description?: string | null;
  industry?: string | null;
  targetCustomer?: string[] | string | null;
  goal?: string | null;
};

export type BusinessTrendProfile = {
  industries: Industry[];
  industryTerms: string[];
  markets: MarketMention[];
  /** "named_in_profile" only when the business text names a place. */
  marketBasis: "named_in_profile" | "not_stated";
};

/** The minimal shape of a usable observation (structurally compatible with the read model). */
export type MatchableObservation = {
  storageId: string;
  sourceId: string;
  platform: string;
  market: { country: string; language: string };
  subject: { text: string };
  window: { start: string; end: string };
  retrievedAt: string;
  freshness: { expiresAt: string };
  metrics: Record<string, { status: string; value?: number }>;
  evidence: { sourceId: string; url: string | null; attribution: string; retrievedAt: string }[];
};

export type TrendIdeaBasis = {
  sourceId: string;
  observationId: string;
  kind: "industry_match" | "holiday" | "cultural_moment";
  matchedIndustries: Industry[];
  matchedTerm: string | null;
  market: string;
  score: number;
};

export type TrendIdea = { context: TrendPromptContext; basis: TrendIdeaBasis };

export type BusinessTrendSelection =
  | { status: "matched"; profile: BusinessTrendProfile; ideas: TrendIdea[] }
  | { status: "evergreen"; profile: BusinessTrendProfile; reason: "no_usable_evidence" | "no_relevant_evidence" };

export function businessTrendProfile(input: BusinessProfileInput): BusinessTrendProfile {
  const audience = Array.isArray(input.targetCustomer) ? input.targetCustomer.join(" • ") : input.targetCustomer ?? "";
  // Industry comes from what the business says it sells: its own industry
  // label decides when it names one; otherwise its description and name. The
  // audience and goal describe customers, not the offer, and are not used.
  const label = classifyText(input.industry);
  const offer = label.industries.length > 0 ? label : classifyText(input.description, input.brandName);
  const markets = marketsMentioned(input.description, audience, input.brandName, input.industry, input.goal);
  return {
    industries: offer.industries,
    industryTerms: [...new Set(Object.values(offer.matchedTerms).flat() as string[])],
    markets,
    marketBasis: markets.length > 0 ? "named_in_profile" : "not_stated",
  };
}

type Built = { topic: string; facts: TrendPromptContext["facts"]; eventWindow: TrendPromptContext["eventWindow"]; confidence: string; caveats: string[] };

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function holidayIdea(o: MatchableObservation, nowMs: number): (Built & { daysAway: number }) | null {
  const url = o.evidence.find((e) => e.sourceId === "public_holidays_nager")?.url ?? null;
  const match = url ? NAGER_EVIDENCE.exec(url) : null;
  if (!match || match[2] !== o.market.country || !match[3].startsWith(match[1])) return null;
  const date = match[3];
  const daysAway = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${utcDay(nowMs)}T00:00:00Z`)) / DAY_MS);
  if (!Number.isFinite(daysAway) || daysAway < 0 || daysAway > HOLIDAY_HORIZON_DAYS) return null;
  const name = o.subject.text;
  return {
    topic: name,
    facts: [{ statement: `${name} is a public holiday in ${countryName(o.market.country)} on ${date}, according to the Nager.Date public holiday calendar.`, sources: ["Nager.Date"] }],
    eventWindow: { start: date, end: date },
    confidence: "high",
    caveats: [
      "Treat this as a calendar moment only; do not claim any official link to the holiday.",
      "Keep the tone respectful and inclusive; observances differ between communities.",
    ],
    daysAway,
  };
}

function pageviewsIdea(o: MatchableObservation): (Built & { views: number }) | null {
  const views = o.metrics.daily_views;
  if (!views || views.status !== "measured" || typeof views.value !== "number" || !Number.isInteger(views.value) || views.value <= 0) return null;
  const day = o.window.start.slice(0, 10);
  const edition = o.market.language === "en" ? "English" : o.market.language;
  return {
    topic: o.subject.text,
    facts: [{
      statement: `"${o.subject.text}" was among the most-viewed ${edition} Wikipedia articles on ${day}, with ${views.value} views, according to Wikimedia pageview statistics.`,
      sources: ["Wikimedia pageviews"],
    }],
    eventWindow: null,
    confidence: "medium",
    caveats: [
      "This measures Wikipedia reader attention only; do not call it a search, sales or social-media trend.",
      "Do not invent details about the topic beyond its name.",
    ],
    views: views.value,
  };
}

function wikidataIdea(o: MatchableObservation): Built | null {
  if (!o.evidence.some((e) => e.sourceId === "wikidata_events" && e.url !== null && WIKIDATA_EVIDENCE.test(e.url))) return null;
  return {
    topic: o.subject.text,
    facts: [{
      statement: `${o.subject.text} is listed in Wikidata as an upcoming event in ${countryName(o.market.country)}.`,
      sources: ["Wikidata"],
    }],
    eventWindow: null,
    confidence: "medium",
    caveats: ["Dates are not confirmed here; do not state a date for this event.", "Do not invent details about the event beyond its name."],
  };
}

function marketCaveat(o: MatchableObservation, profile: BusinessTrendProfile): string {
  if (o.market.country === WORLDWIDE_MARKET) return "Worldwide signal; it is not specific to the business's location.";
  const place = profile.markets.find((m) => m.country === o.market.country)?.mentioned ?? o.market.country;
  return `Market taken from the business profile, which mentions ${place}.`;
}

export function selectTrendIdeasForBusiness(
  profile: BusinessTrendProfile,
  observations: readonly MatchableObservation[],
  options: { now: number; max?: number },
): BusinessTrendSelection {
  const max = Math.min(Math.max(options.max ?? MAX_TREND_IDEAS_PER_RUN, 0), 6);
  const allowedCountries = new Set([WORLDWIDE_MARKET, ...profile.markets.map((m) => m.country)]);
  const eligible = observations.filter((o) => o.platform === "web" && allowedCountries.has(o.market.country)
    && Number.isFinite(Date.parse(o.freshness.expiresAt)) && Date.parse(o.freshness.expiresAt) > options.now);
  if (eligible.length === 0) return { status: "evergreen", profile, reason: "no_usable_evidence" };

  const candidates: (TrendIdea & { key: string })[] = [];
  for (const o of eligible) {
    const topicSignals = classifyText(o.subject.text);
    if (topicSignals.unsafe) continue;
    const attention = o.sourceId === "wikimedia_pageviews" ? attentionSignals(o.subject.text) : null;
    // A worldwide title that names a place ("Thanksgiving (Canada)", "2026
    // Abu Dhabi Grand Prix") belongs to that country's businesses only.
    if (o.market.country === WORLDWIDE_MARKET) {
      const places = marketsMentioned(o.subject.text).map((m) => m.country);
      if (places.length > 0 && !places.some((country) => profile.markets.some((m) => m.country === country))) continue;
    }
    const overlap = (attention ?? topicSignals).industries.filter((industry) => profile.industries.includes(industry));
    // A moment tied to particular countries (Thanksgiving, bank holidays,
    // national days) is offered only to businesses in those countries.
    const momentMarkets = (moment: string | null) => (moment && moment in REGIONAL_MOMENTS ? REGIONAL_MOMENTS[moment] : null);
    const momentFits = (moment: string | null) => {
      const markets = momentMarkets(moment);
      return markets === null || markets.some((country) => profile.markets.some((m) => m.country === country));
    };
    let built: Built | null = null;
    let kind: TrendIdeaBasis["kind"] | null = null;
    let score = 0;
    let matchedTerm: string | null = null;

    if (o.sourceId === "public_holidays_nager") {
      const holiday = holidayIdea(o, options.now);
      if (!holiday) continue;
      built = holiday;
      kind = overlap.length > 0 ? "industry_match" : "holiday";
      // Sooner holidays first; a holiday that also names the business's industry ranks higher.
      score = 2 + (1 - holiday.daysAway / HOLIDAY_HORIZON_DAYS) + overlap.length;
      matchedTerm = topicSignals.universalMoment;
    } else if (o.sourceId === "wikimedia_pageviews") {
      const measured = pageviewsIdea(o);
      if (!measured || !attention) continue;
      if (overlap.length > 0) {
        kind = "industry_match";
        score = 3 + overlap.length + Math.log10(measured.views) / 10;
        matchedTerm = overlap.flatMap((industry) => topicSignals.matchedTerms[industry] ?? [])[0] ?? overlap[0];
      } else if (attention.moment && momentFits(attention.moment)) {
        kind = "cultural_moment";
        score = 1.5 + Math.log10(measured.views) / 10;
        matchedTerm = attention.moment;
      } else continue;
      built = measured;
    } else if (o.sourceId === "wikidata_events") {
      const event = wikidataIdea(o);
      if (!event) continue;
      if (overlap.length > 0) {
        kind = "industry_match";
        score = 3 + overlap.length + (o.market.country === WORLDWIDE_MARKET ? 0 : 0.5);
        matchedTerm = overlap.flatMap((industry) => topicSignals.matchedTerms[industry] ?? [])[0] ?? null;
      } else if (topicSignals.universalMoment && momentFits(topicSignals.universalMoment)) {
        kind = "cultural_moment";
        score = 1.5;
        matchedTerm = topicSignals.universalMoment;
      } else continue;
      built = event;
    } else {
      // Other sources need a reviewer's written facts (the reviewed context path).
      continue;
    }
    if (!built || !kind) continue;
    const caveats = [`Do not imply that the business is an official partner, sponsor or participant of ${built.topic}.`, marketCaveat(o, profile), ...built.caveats]
      .map((c) => c.slice(0, 400)).slice(0, 4);
    candidates.push({
      key: normalizeText(built.topic),
      context: {
        topic: built.topic.slice(0, 200),
        market: { country: o.market.country, language: o.market.language },
        eventWindow: built.eventWindow,
        facts: built.facts.map((f) => ({ statement: f.statement.slice(0, 300), sources: f.sources.slice(0, 3) })),
        observedAt: new Date(Date.parse(o.retrievedAt)).toISOString(),
        confidence: built.confidence,
        caveats,
      },
      basis: {
        sourceId: o.sourceId,
        observationId: o.storageId,
        kind,
        matchedIndustries: overlap,
        matchedTerm,
        market: o.market.country,
        score: Math.round(score * 1000) / 1000,
      },
    });
  }

  candidates.sort((a, b) => b.basis.score - a.basis.score || a.basis.observationId.localeCompare(b.basis.observationId));
  const ideas: TrendIdea[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (ideas.length >= max) break;
    // Near-duplicates ("Formula One" vs "2026 Formula One World Championship")
    // would give the run two versions of one idea.
    const core = candidate.key.replace(/\b\d{4}\b/g, " ").replace(/\s+/g, " ").trim();
    if ([...seen].some((other) => other.includes(core) || core.includes(other))) continue;
    seen.add(core);
    ideas.push({ context: candidate.context, basis: candidate.basis });
  }
  return ideas.length > 0 ? { status: "matched", profile, ideas } : { status: "evergreen", profile, reason: "no_relevant_evidence" };
}
