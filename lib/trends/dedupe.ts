/**
 * Trend subject normalization, duplicate detection and grouping.
 *
 * Deterministic: results never depend on input order, locale or the clock.
 *
 * Three identities, never confused:
 *   itemKey  — ONE specific provider content item (platform + kind +
 *              provider id). Global: the same video everywhere.
 *   topicKey — what an observation is about, by text (platform + market +
 *              kind + normalized subject). Two different videos with the same
 *              title share a topic but are different items.
 *   trendKey — what is grouped and assessed: the item (within a market) when
 *              there is one, otherwise the topic.
 *
 * Every key that groups or deduplicates includes platform, country and
 * language, so markets never mix. Nothing here merges, sums or averages
 * metrics: a group keeps every observation with its own metrics intact.
 */
import type { TrendItem, TrendMarket, TrendObservation, TrendPlatform, TrendSourceId, TrendSubjectKind } from "./types";

// Zero-width characters, bidi controls and the BOM: invisible, so they must
// never make two identical-looking subjects distinct.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

export const MAX_SUBJECT_LENGTH = 200;

/**
 * The comparison form of a subject: Unicode NFKC, invisible characters
 * removed, whitespace collapsed, locale-independent lower case, and for
 * hashtags the leading "#" removed. Returns null when nothing meaningful
 * remains or the text contains control characters.
 */
export function normalizeSubjectText(kind: TrendSubjectKind, text: string): string | null {
  if (typeof text !== "string" || CONTROL.test(text.replace(/[\t\n\r]/g, " "))) return null;
  let value = text.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (kind === "hashtag") value = value.replace(/^#+/, "").trim();
  if (value.length === 0 || value.length > MAX_SUBJECT_LENGTH) return null;
  return value;
}

/** One specific provider content item, or null for topic observations. Namespaced by platform. */
export function itemKey(observation: Pick<TrendObservation, "item">): string | null {
  const { item } = observation;
  return item ? JSON.stringify(["item", item.platform, item.kind, item.providerItemId]) : null;
}

/** What the observation is about, by text, within one platform and market. */
export function topicKey(observation: Pick<TrendObservation, "platform" | "market" | "subject">): string {
  const { platform, market, subject } = observation;
  return JSON.stringify(["topic", platform, market.country, market.language, subject.kind, subject.normalized]);
}

/**
 * The identity used for grouping and confidence: the item within this market
 * when there is one (a retitled video stays one trend; two videos sharing a
 * title stay two), otherwise the topic.
 */
export function trendKey(observation: Pick<TrendObservation, "platform" | "market" | "subject" | "item">): string {
  const { platform, market, item } = observation;
  return item
    ? JSON.stringify(["item", platform, market.country, market.language, item.kind, item.providerItemId])
    : topicKey(observation);
}

/** The identity of a single report: the same source describing the same trend over the same window. */
export function observationIdentity(observation: TrendObservation): string {
  return JSON.stringify([observation.sourceId, trendKey(observation), observation.window.start, observation.window.end]);
}

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Total, input-order-independent ordering for observations. */
export function compareObservations(a: TrendObservation, b: TrendObservation): number {
  return (
    compareStrings(trendKey(a), trendKey(b)) ||
    compareStrings(a.sourceId, b.sourceId) ||
    compareStrings(a.window.start, b.window.start) ||
    compareStrings(a.window.end, b.window.end) ||
    compareStrings(b.retrievedAt, a.retrievedAt) || // newest retrieval first
    compareStrings(a.id, b.id)
  );
}

export type DuplicateRecord = {
  keptId: string;
  droppedId: string;
  reason: "same_source_same_trend_same_window";
};

export type IdConflict = {
  id: string;
  reason: "same_id_different_observation";
};

export type DedupeResult = {
  /** One observation per (source, trend, window), in deterministic order. */
  kept: TrendObservation[];
  duplicates: DuplicateRecord[];
  /** Ids reused for different observations. Every observation with such an id is excluded. */
  conflicts: IdConflict[];
};

/**
 * Removes repeated reports of the same trend from the same source for the
 * same window, keeping the most recently retrieved one (ties: smallest id).
 * Reports from DIFFERENT sources are never duplicates — they corroborate.
 *
 * An id used for two different observations is a data-integrity problem, not
 * a duplicate: all observations carrying that id are excluded and reported.
 */
export function dedupeObservations(observations: readonly TrendObservation[]): DedupeResult {
  const byId = new Map<string, Set<string>>();
  for (const observation of observations) {
    const identities = byId.get(observation.id) ?? new Set<string>();
    identities.add(observationIdentity(observation));
    byId.set(observation.id, identities);
  }
  const conflictingIds = [...byId.entries()].filter(([, identities]) => identities.size > 1).map(([id]) => id).sort(compareStrings);
  const conflicting = new Set(conflictingIds);

  const sorted = observations.filter((observation) => !conflicting.has(observation.id)).sort(compareObservations);
  const kept: TrendObservation[] = [];
  const duplicates: DuplicateRecord[] = [];
  const keptByIdentity = new Map<string, TrendObservation>();
  const reported = new Set<string>();
  for (const observation of sorted) {
    const identity = observationIdentity(observation);
    const existing = keptByIdentity.get(identity);
    if (!existing) {
      keptByIdentity.set(identity, observation);
      kept.push(observation);
    } else if (existing.id !== observation.id && !reported.has(observation.id)) {
      // Each dropped id is reported once, even if it was submitted repeatedly.
      reported.add(observation.id);
      duplicates.push({ keptId: existing.id, droppedId: observation.id, reason: "same_source_same_trend_same_window" });
    }
    // Same id and same identity as the kept record: the identical record submitted twice — silently collapsed.
  }

  return {
    kept,
    duplicates: duplicates.sort((a, b) => compareStrings(a.keptId, b.keptId) || compareStrings(a.droppedId, b.droppedId)),
    conflicts: conflictingIds.map((id) => ({ id, reason: "same_id_different_observation" as const })),
  };
}

export type TrendGroup = {
  key: string;
  platform: TrendPlatform;
  market: TrendMarket;
  /** The item, when the group is one specific provider item. */
  item: TrendItem | null;
  /** The subject of the first observation in order (titles of one item may differ). */
  subject: { kind: TrendSubjectKind; normalized: string };
  /** Every observation of this trend, each with its own source-specific metrics. */
  observations: TrendObservation[];
  /** Distinct sources, sorted. */
  sourceIds: TrendSourceId[];
};

/**
 * Groups observations of the same trend (same trendKey: the same item, or the
 * same topic, within one platform, country and language) so independent
 * sources can corroborate each other. Observations that differ in any of
 * those never share a group.
 */
export function groupObservationsByTrend(observations: readonly TrendObservation[]): TrendGroup[] {
  const groups = new Map<string, TrendObservation[]>();
  for (const observation of observations) {
    const key = trendKey(observation);
    const list = groups.get(key) ?? [];
    list.push(observation);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, list]) => {
      const sortedList = [...list].sort(compareObservations);
      const first = sortedList[0];
      return {
        key,
        platform: first.platform,
        market: { country: first.market.country, language: first.market.language },
        item: first.item ? { ...first.item } : null,
        subject: { kind: first.subject.kind, normalized: first.subject.normalized },
        observations: sortedList,
        sourceIds: [...new Set(sortedList.map((observation) => observation.sourceId))].sort(compareStrings),
      };
    });
}
