/**
 * Trend Intelligence — evidence-backed marketing opportunity for ONE merchant.
 *
 * Deterministic and pure (no AI, no I/O, "now" passed in). Input: usable
 * trend observations (already filtered by approval, coverage, expiry and
 * invalidation — e.g. from the read RPC), the reviewer's research notes, and
 * the merchant's profile. Output: at most one recommendation, or a reason why
 * there is none.
 *
 * Honesty rules enforced here:
 *   - every fact used must be linked to evidence URLs that are actually stored
 *     on the observation (an unlinked or foreign fact rejects the note);
 *   - the recommendation text is built only from those facts and the
 *     merchant's own profile — no numbers, offers, partnerships or results
 *     are introduced;
 *   - relevance must be explicit: the reviewer's relevant industries must
 *     match the merchant's stated industry/description;
 *   - market must match (same country; language tag compatible);
 *   - nothing is recommended for an event that has already ended, or from
 *     evidence with insufficient confidence;
 *   - it is always a recommendation requiring the owner's approval.
 */

import { classifyTrendConfidence, type ConfidenceAssessment } from "./confidence";
import { groupObservationsByTrend, trendKey } from "./dedupe";
import { assessFreshness, type FreshnessStatus } from "./freshness";
import { parseInstant } from "./schema";
import type { MarketPolicy, TrendObservation } from "./types";

export type TrendResearchFact = { statement: string; evidenceUrls: string[] };

/** A reviewer's notes about one trend (part of the manually supplied evidence). */
export type TrendResearchNote = {
  /** Stage 1 trendKey() of the observation this note describes. */
  trendKey: string;
  facts: TrendResearchFact[];
  /** Calendar dates (YYYY-MM-DD) when the trend/event is happening, if any. */
  eventWindow: { start: string; end: string } | null;
  relevantIndustries: string[];
  relevanceRationale: string;
  reviewer: string;
  reviewedAt: string;
};

export type MerchantProfile = {
  name: string;
  industry: string;
  description: string;
  city: string;
  country: string;
  /** Primary content language (a registered tag, e.g. "en"). */
  language: string;
  targetCustomer: string[];
};

export type RecommendationCitation = { publisher: string; url: string; retrievedAt: string };

export type TrendRecommendation = {
  status: "recommended";
  topic: string;
  market: { country: string; language: string };
  headline: string;
  whyNow: string;
  suggestedAction: string;
  contentIdeas: string[];
  timing: { startPostingOn: string; eventStart: string | null; eventEnd: string | null; evidenceUsableUntil: string };
  facts: TrendResearchFact[];
  citations: RecommendationCitation[];
  observedAt: string;
  freshness: FreshnessStatus;
  confidence: Pick<ConfidenceAssessment, "level" | "reasons">;
  relevance: { matchedOn: string[]; rationale: string; reviewer: string };
  caveats: string[];
  approvalRequired: true;
  generatedBy: "trend_opportunity_rules_v1";
};

export type NoRecommendation = {
  status: "no_recommendation";
  reason: "no_usable_trend" | "no_relevant_trend" | "event_already_over" | "insufficient_confidence";
  /** Notes rejected because a fact was not linked to stored evidence. */
  rejectedNotes: string[];
};

const DAY_MS = 86_400_000;
const LEAD_DAYS = 7;

const normalize = (text: string) => text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function industryMatches(note: TrendResearchNote, merchant: MerchantProfile): string[] {
  const haystack = ` ${normalize(`${merchant.industry} ${merchant.description}`)} `;
  return note.relevantIndustries.filter((term) => {
    const needle = normalize(term);
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

function languageCompatible(observationLanguage: string, merchantLanguage: string): boolean {
  return observationLanguage === "und" || observationLanguage === merchantLanguage;
}

/** A note is usable only if every fact cites evidence stored on the observation. */
function noteIsLinked(note: TrendResearchNote, observation: TrendObservation): boolean {
  const stored = new Set(observation.evidence.map((entry) => entry.url).filter((url): url is string => url !== null));
  return note.facts.length > 0
    && note.facts.every((fact) => fact.statement.trim().length > 0 && fact.evidenceUrls.length > 0 && fact.evidenceUrls.every((url) => stored.has(url)));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const formatDay = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2, insufficient: 3 } as const;

export function recommendTrendOpportunity(input: {
  merchant: MerchantProfile;
  observations: readonly TrendObservation[];
  notes: readonly TrendResearchNote[];
  markets: MarketPolicy;
  now: Date | number | string;
}): TrendRecommendation | NoRecommendation {
  const nowMs = typeof input.now === "number" ? input.now : input.now instanceof Date ? input.now.getTime() : parseInstant(input.now);
  if (nowMs === null || !Number.isFinite(nowMs)) throw new RangeError("invalid now");
  const today = new Date(nowMs).toISOString().slice(0, 10);

  const inMarket = input.observations.filter((o) =>
    o.market.country === input.merchant.country && languageCompatible(o.market.language, input.merchant.language)
    && assessFreshness(o, nowMs).status !== "expired");
  if (inMarket.length === 0) return { status: "no_recommendation", reason: "no_usable_trend", rejectedNotes: [] };

  const rejectedNotes: string[] = [];
  type Candidate = { group: ReturnType<typeof groupObservationsByTrend>[number]; note: TrendResearchNote; matched: string[]; confidence: ConfidenceAssessment };
  const candidates: Candidate[] = [];
  let anyRelevant = false;
  let anyEnded = false;
  let anyLowConfidence = false;
  for (const group of groupObservationsByTrend(inMarket)) {
    const key = trendKey(group.observations[0]);
    for (const note of input.notes.filter((n) => n.trendKey === key)) {
      if (!group.observations.some((o) => noteIsLinked(note, o))) {
        rejectedNotes.push(key);
        continue;
      }
      const matched = industryMatches(note, input.merchant);
      if (matched.length === 0) continue;
      anyRelevant = true;
      if (note.eventWindow && (!DATE.test(note.eventWindow.end) || note.eventWindow.end < today)) {
        anyEnded = true;
        continue;
      }
      const confidence = classifyTrendConfidence(group, { now: nowMs, markets: input.markets });
      if (confidence.level === "insufficient") {
        anyLowConfidence = true;
        continue;
      }
      candidates.push({ group, note, matched, confidence });
    }
  }
  if (candidates.length === 0) {
    const reason = anyLowConfidence ? "insufficient_confidence" : anyEnded ? "event_already_over" : anyRelevant ? "no_usable_trend" : "no_relevant_trend";
    return { status: "no_recommendation", reason, rejectedNotes };
  }

  candidates.sort((a, b) =>
    CONFIDENCE_RANK[a.confidence.level] - CONFIDENCE_RANK[b.confidence.level]
    || (a.note.eventWindow?.start ?? "9999").localeCompare(b.note.eventWindow?.start ?? "9999"));
  const { group, note, matched, confidence } = candidates[0];
  const observation = [...group.observations].sort((a, b) => b.window.end.localeCompare(a.window.end))[0];
  const topic = observation.subject.text;
  const freshness = assessFreshness(observation, nowMs);
  const audience = input.merchant.targetCustomer[0] ?? "your customers";

  const eventStart = note.eventWindow?.start ?? null;
  const eventEnd = note.eventWindow?.end ?? null;
  const leadStart = eventStart ? new Date(Date.parse(`${eventStart}T00:00:00Z`) - LEAD_DAYS * DAY_MS).toISOString().slice(0, 10) : today;
  const startPostingOn = leadStart > today ? leadStart : today;

  const citations = new Map<string, RecommendationCitation>();
  for (const o of group.observations) {
    for (const entry of o.evidence) {
      if (entry.url && note.facts.some((fact) => fact.evidenceUrls.includes(entry.url as string))) {
        citations.set(entry.url, { publisher: entry.attribution, url: entry.url, retrievedAt: entry.retrievedAt });
      }
    }
  }

  const when = eventStart && eventEnd ? ` (${formatDay(eventStart)} – ${formatDay(eventEnd)})` : "";
  const caveats = [
    confidence.reasons.includes("qualitative_evidence_only")
      ? "Evidence is qualitative (published reports). There is no search-volume, reach or engagement data behind this recommendation."
      : "Metrics are as reported by the source at retrieval time.",
    confidence.reasons.includes("single_source")
      ? "Supported by one evidence source type; treat as an opportunity to consider, not a measured trend."
      : "Corroborated by more than one evidence source.",
    `Do not claim an official partnership with ${topic}, or any discount, prize or result, unless ${input.merchant.name} actually has one.`,
    `Evidence must be re-checked after ${formatDay(freshness.expiresAt.slice(0, 10))}, when it expires.`,
  ];

  return {
    status: "recommended",
    topic,
    market: { ...observation.market },
    headline: `Plan ${input.merchant.name}'s content around ${topic}${when}.`,
    whyNow: note.facts.map((fact) => fact.statement).join(" "),
    suggestedAction:
      `Prepare a short series that helps ${audience}${audience.includes(input.merchant.city) ? "" : ` in ${input.merchant.city}`} take part in ${topic}, connecting it to what ${input.merchant.name} already offers (${input.merchant.industry}). `
      + `Start posting on ${formatDay(startPostingOn)}${eventEnd ? ` and keep it going until ${formatDay(eventEnd)}` : ""}.`,
    contentIdeas: [
      `Before it starts: tell ${audience} that ${topic} is coming and point them to the official registration.`,
      `During it: a recurring post showing how ${input.merchant.name} fits into an active daily routine.`,
      `Around the flagship community days named in the reports: a timely post for people taking part.`,
    ],
    timing: {
      startPostingOn,
      eventStart,
      eventEnd,
      evidenceUsableUntil: freshness.expiresAt,
    },
    facts: note.facts.map((fact) => ({ statement: fact.statement, evidenceUrls: [...fact.evidenceUrls] })),
    citations: [...citations.values()].sort((a, b) => a.url.localeCompare(b.url)),
    observedAt: observation.window.end,
    freshness: freshness.status,
    confidence: { level: confidence.level, reasons: [...confidence.reasons] },
    relevance: { matchedOn: matched, rationale: note.relevanceRationale, reviewer: note.reviewer },
    caveats,
    approvalRequired: true,
    generatedBy: "trend_opportunity_rules_v1",
  };
}

/**
 * The bounded, advisory block MARA's content prompt receives when the trend
 * feature flag is on: only verified facts with their sources and dates.
 */
export type TrendPromptContext = {
  topic: string;
  market: { country: string; language: string };
  eventWindow: { start: string; end: string } | null;
  facts: { statement: string; sources: string[] }[];
  observedAt: string;
  confidence: string;
  caveats: string[];
};

export function toTrendPromptContext(recommendation: TrendRecommendation): TrendPromptContext {
  const publisherOf = new Map(recommendation.citations.map((c) => [c.url, c.publisher]));
  return {
    topic: recommendation.topic,
    market: recommendation.market,
    eventWindow: recommendation.timing.eventStart && recommendation.timing.eventEnd
      ? { start: recommendation.timing.eventStart, end: recommendation.timing.eventEnd }
      : null,
    facts: recommendation.facts.slice(0, 6).map((fact) => ({
      statement: fact.statement.slice(0, 300),
      sources: fact.evidenceUrls.map((url) => publisherOf.get(url) ?? url).slice(0, 3),
    })),
    observedAt: recommendation.observedAt,
    confidence: recommendation.confidence.level,
    caveats: recommendation.caveats.slice(0, 4),
  };
}
