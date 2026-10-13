import "server-only";

import { toIsoInstant, type TrendDatabase } from "./db";
import { loadTrendMarketPolicy, permittedSources, type PolicyIssue } from "./policy-store";
import { parseInstant } from "./schema";
import { callTrendRpc, safeCode, type TrendRpcClient } from "./supabase-rpc";
import {
  isTrendLanguage,
  isTrendSourceId,
  TREND_PLATFORMS,
  TREND_SUBJECT_KINDS,
  UNAVAILABLE_REASONS,
  type MetricUnit,
  type MetricValue,
  type TrendEvidence,
  type TrendObservation,
  type TrendPlatform,
  type TrendSourceId,
  type TrendSubjectKind,
  type UnavailableReason,
} from "./types";

/**
 * Trend Intelligence — read-only retrieval of usable stored observations for
 * one platform and country (optionally one language).
 *
 * Returned only when, at `now`:
 *   - the source is approved and the market's coverage verified (current
 *     policy, deny by default; a revoked source hides its stored data);
 *   - the observation has not expired and its deletion deadline has not
 *     passed (rows awaiting purge are never served);
 *   - it was retrieved no later than `now`;
 *   - it has not been invalidated (a correction, if any, is its own revision).
 * Metrics keep their unit, definition version and exact stored value;
 * unavailable metrics are returned as unavailable with their reason, never 0.
 * Evidence keeps its attribution. Results are bounded and ordered newest
 * window first. Runs in a read-only transaction.
 */

export const READ_LIMIT_DEFAULT = 50;
export const READ_LIMIT_MAX = 200;

export type StoredMetric =
  | { status: "measured"; value: number; exactValue: string; unit: MetricUnit; definitionVersion: string }
  | { status: "unavailable"; reason: UnavailableReason; unit: MetricUnit };

export type StoredTrendObservation = {
  storageId: string;
  sourceId: TrendSourceId;
  platform: TrendPlatform;
  market: { country: string; language: string };
  subject: { kind: TrendSubjectKind; text: string; normalized: string };
  item: { platform: TrendPlatform; kind: TrendSubjectKind; providerItemId: string } | null;
  keys: { itemKey: string | null; topicKey: string; trendKey: string };
  /** 1 for an original observation; n + 1 for the correction of revision n. */
  revision: number;
  window: { start: string; end: string };
  retrievedAt: string;
  freshness: { freshUntil: string; staleAfter: string; expiresAt: string; basis: string };
  deleteAfter: string;
  metrics: Record<string, StoredMetric>;
  evidence: TrendEvidence[];
};

export type TrendQuery = {
  platform: TrendPlatform;
  country: string;
  language?: string;
  now: Date | number | string;
  limit?: number;
};

export type TrendReadResult =
  | { status: "ok"; observations: StoredTrendObservation[]; permittedSourceIds: string[]; policyIssues: PolicyIssue[] }
  | { status: "invalid_query"; reason: string }
  | { status: "unavailable"; code: "policy_unavailable" | "storage_failed" };

type ObservationRow = {
  id: string; source_id: string; platform: string; country: string; language: string;
  subject_kind: string; subject_text: string; subject_normalized: string; provider_item_id: string | null;
  item_key: string | null; topic_key: string; trend_key: string; revision: number;
  window_start: unknown; window_end: unknown; retrieved_at: unknown;
  fresh_until: unknown; stale_after: unknown; expires_at: unknown; freshness_basis: string; delete_after: unknown;
};
type MetricRow = { observation_id: string; metric_key: string; status: string; value: string | null; unit: string; definition_version: string | null; unavailable_reason: string | null };
type EvidenceRow = { observation_id: string; source_id: string; url: string | null; attribution: string; retrieved_at: unknown };

export async function listUsableTrendObservations(db: TrendDatabase, query: TrendQuery): Promise<TrendReadResult> {
  const nowMs = typeof query.now === "number" ? query.now : query.now instanceof Date ? query.now.getTime() : parseInstant(query.now);
  if (nowMs === null || !Number.isFinite(nowMs)) return { status: "invalid_query", reason: "invalid_now" };
  if (!(TREND_PLATFORMS as readonly string[]).includes(query.platform)) return { status: "invalid_query", reason: "invalid_platform" };
  if (!/^[A-Z]{2}$/.test(query.country)) return { status: "invalid_query", reason: "invalid_country" };
  if (query.language !== undefined && query.language !== "und" && !isTrendLanguage(query.language)) {
    return { status: "invalid_query", reason: "invalid_language" };
  }
  const limit = query.limit ?? READ_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_LIMIT_MAX) return { status: "invalid_query", reason: "invalid_limit" };
  const now = new Date(nowMs).toISOString();

  try {
    return await db.transaction(async (tx) => {
      await tx.query("set transaction read only");
      const loaded = await loadTrendMarketPolicy(tx, { now: nowMs });
      if (!loaded.complete) return { status: "unavailable", code: "policy_unavailable" } as const;
      const sources = permittedSources(loaded.policy, query.platform, query.country);
      if (sources.length === 0) return { status: "ok", observations: [], permittedSourceIds: [], policyIssues: loaded.issues } as const;

      const rows = (await tx.query<ObservationRow>(
        `select id, source_id, platform, country, language, subject_kind, subject_text, subject_normalized, provider_item_id,
                item_key, topic_key, trend_key, revision, window_start, window_end, retrieved_at,
                fresh_until, stale_after, expires_at, freshness_basis, delete_after
           from public.trend_observations o
          where platform = $1 and country = $2 and ($3::text is null or language = $3)
            and source_id = any($4::text[])
            and expires_at > $5 and delete_after > $5 and retrieved_at <= $5
            and not exists (select 1 from public.trend_observation_invalidations i where i.observation_id = o.id)
          order by window_end desc, id
          limit $6`,
        [query.platform, query.country, query.language ?? null, sources, now, limit],
      )).rows;
      if (rows.length === 0) return { status: "ok", observations: [], permittedSourceIds: sources, policyIssues: loaded.issues } as const;

      const ids = rows.map((row) => row.id);
      const metricRows = (await tx.query<MetricRow>(
        `select observation_id, metric_key, status, value::text as value, unit, definition_version, unavailable_reason
           from public.trend_observation_metrics where observation_id = any($1::uuid[]) order by observation_id, metric_key`,
        [ids],
      )).rows;
      const evidenceRows = (await tx.query<EvidenceRow>(
        `select observation_id, source_id, url, attribution, retrieved_at
           from public.trend_evidence where observation_id = any($1::uuid[]) order by observation_id, retrieved_at, id`,
        [ids],
      )).rows;

      const metricsById = new Map<string, Record<string, StoredMetric>>();
      for (const metric of metricRows) {
        const bucket = metricsById.get(metric.observation_id) ?? {};
        bucket[metric.metric_key] = metric.status === "measured"
          ? { status: "measured", value: Number(metric.value), exactValue: String(metric.value), unit: metric.unit as MetricUnit, definitionVersion: String(metric.definition_version) }
          : { status: "unavailable", reason: metric.unavailable_reason as UnavailableReason, unit: metric.unit as MetricUnit };
        metricsById.set(metric.observation_id, bucket);
      }
      const evidenceById = new Map<string, TrendEvidence[]>();
      for (const entry of evidenceRows) {
        const bucket = evidenceById.get(entry.observation_id) ?? [];
        bucket.push({ sourceId: entry.source_id as TrendSourceId, url: entry.url, attribution: entry.attribution, retrievedAt: toIsoInstant(entry.retrieved_at) });
        evidenceById.set(entry.observation_id, bucket);
      }

      const observations = rows.map((row): StoredTrendObservation => ({
        storageId: row.id,
        sourceId: row.source_id as TrendSourceId,
        platform: row.platform as TrendPlatform,
        market: { country: row.country, language: row.language },
        subject: { kind: row.subject_kind as TrendSubjectKind, text: row.subject_text, normalized: row.subject_normalized },
        item: row.provider_item_id === null
          ? null
          : { platform: row.platform as TrendPlatform, kind: row.subject_kind as TrendSubjectKind, providerItemId: row.provider_item_id },
        keys: { itemKey: row.item_key, topicKey: row.topic_key, trendKey: row.trend_key },
        revision: Number(row.revision),
        window: { start: toIsoInstant(row.window_start), end: toIsoInstant(row.window_end) },
        retrievedAt: toIsoInstant(row.retrieved_at),
        freshness: {
          freshUntil: toIsoInstant(row.fresh_until),
          staleAfter: toIsoInstant(row.stale_after),
          expiresAt: toIsoInstant(row.expires_at),
          basis: row.freshness_basis,
        },
        deleteAfter: toIsoInstant(row.delete_after),
        metrics: metricsById.get(row.id) ?? {},
        evidence: evidenceById.get(row.id) ?? [],
      }));
      return { status: "ok", observations, permittedSourceIds: sources, policyIssues: loaded.issues } as const;
    });
  } catch {
    return { status: "unavailable", code: "storage_failed" };
  }
}

/**
 * The Stage 1 shape, for grouping and confidence. Metric values are JS
 * numbers there; `exactValue` on the stored form remains the exact record.
 */
export function toTrendObservation(stored: StoredTrendObservation): TrendObservation {
  const metrics: Record<string, MetricValue> = {};
  for (const [key, metric] of Object.entries(stored.metrics)) {
    metrics[key] = metric.status === "measured"
      ? { status: "measured", value: metric.value, definitionVersion: metric.definitionVersion }
      : { status: "unavailable", reason: metric.reason };
  }
  return {
    id: stored.storageId,
    sourceId: stored.sourceId,
    platform: stored.platform,
    market: { ...stored.market },
    subject: { ...stored.subject },
    item: stored.item ? { ...stored.item } : null,
    window: { ...stored.window },
    retrievedAt: stored.retrievedAt,
    metrics,
    evidence: stored.evidence.map((entry) => ({ ...entry })),
  };
}

/* ──────────────────────────────────────────────────────────────
   Production read path: the service-role RPC (Stage 2D)
   ────────────────────────────────────────────────────────────── */

/** Keyset position: the last returned row's window end and storage id. */
export type TrendReadCursor = { windowEnd: string; id: string };

export type TrendRpcQuery = {
  platform: TrendPlatform;
  country: string;
  language?: string;
  limit?: number;
  cursor?: TrendReadCursor;
};

export type TrendRpcReadResult =
  | { status: "ok"; observations: StoredTrendObservation[]; permittedSourceIds: string[]; nextCursor: TrendReadCursor | null }
  | { status: "invalid_query"; reason: string }
  | { status: "unavailable"; code: "storage_failed" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^[0-9]{1,40}(\.[0-9]{1,20})?$/;
const UNITS: readonly string[] = ["relative_index", "scaled_interest", "count", "rank"];

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown, max = 2048): value is string => typeof value === "string" && value.length <= max;
function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = parseInstant(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function metricFrom(value: unknown): StoredMetric | null {
  if (!isObject(value) || !isText(value.unit) || !UNITS.includes(value.unit)) return null;
  const unit = value.unit as MetricUnit;
  if (value.status === "measured") {
    if (!isText(value.value) || !DECIMAL.test(value.value) || !isText(value.definition_version, 120) || value.unavailable_reason !== null) return null;
    return { status: "measured", value: Number(value.value), exactValue: value.value, unit, definitionVersion: value.definition_version };
  }
  if (value.status === "unavailable") {
    if (value.value !== null || value.definition_version !== null) return null;
    if (!(UNAVAILABLE_REASONS as readonly unknown[]).includes(value.unavailable_reason)) return null;
    return { status: "unavailable", reason: value.unavailable_reason as UnavailableReason, unit };
  }
  return null;
}

/** Strictly rebuilds one RPC row; any unexpected shape returns null. */
function storedFrom(row: unknown): StoredTrendObservation | null {
  if (!isObject(row)) return null;
  const { storage_id: id, source_id: sourceId, platform, country, language, subject_kind: kind } = row;
  if (!isText(id) || !UUID.test(id) || !isTrendSourceId(sourceId)) return null;
  if (!(TREND_PLATFORMS as readonly unknown[]).includes(platform) || !isText(country) || !/^[A-Z]{2}$/.test(country)) return null;
  if (!isText(language, 16) || !(TREND_SUBJECT_KINDS as readonly unknown[]).includes(kind)) return null;
  if (!isText(row.subject_text, 400) || !isText(row.subject_normalized, 200)) return null;
  if (row.provider_item_id !== null && !isText(row.provider_item_id, 128)) return null;
  if ((row.item_key !== null && !isText(row.item_key)) || !isText(row.topic_key) || !isText(row.trend_key)) return null;
  if (!Number.isInteger(row.revision) || (row.revision as number) < 1 || !isText(row.freshness_basis, 64)) return null;
  const times = ["window_start", "window_end", "retrieved_at", "fresh_until", "stale_after", "expires_at", "delete_after"].map((key) => instant(row[key]));
  if (times.some((time) => time === null)) return null;
  const [windowStart, windowEnd, retrievedAt, freshUntil, staleAfter, expiresAt, deleteAfter] = times as string[];

  if (!isObject(row.metrics) || !Array.isArray(row.evidence) || row.evidence.length === 0) return null;
  const metrics: Record<string, StoredMetric> = {};
  for (const [key, value] of Object.entries(row.metrics)) {
    const metric = metricFrom(value);
    if (!metric || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) return null;
    metrics[key] = metric;
  }
  const evidence: TrendEvidence[] = [];
  for (const entry of row.evidence) {
    if (!isObject(entry) || !isTrendSourceId(entry.source_id) || !isText(entry.attribution, 200)) return null;
    if (entry.url !== null && (!isText(entry.url) || !entry.url.startsWith("https://"))) return null;
    const at = instant(entry.retrieved_at);
    if (at === null) return null;
    evidence.push({ sourceId: entry.source_id, url: entry.url as string | null, attribution: entry.attribution, retrievedAt: at });
  }

  const providerItemId = row.provider_item_id as string | null;
  return {
    storageId: id,
    sourceId,
    platform: platform as TrendPlatform,
    market: { country, language },
    subject: { kind: kind as TrendSubjectKind, text: row.subject_text, normalized: row.subject_normalized },
    item: providerItemId === null ? null : { platform: platform as TrendPlatform, kind: kind as TrendSubjectKind, providerItemId },
    keys: { itemKey: row.item_key as string | null, topicKey: row.topic_key, trendKey: row.trend_key },
    revision: row.revision as number,
    window: { start: windowStart, end: windowEnd },
    retrievedAt,
    freshness: { freshUntil, staleAfter, expiresAt, basis: row.freshness_basis },
    deleteAfter,
    metrics,
    evidence,
  };
}

/**
 * Reads usable observations through `trend_list_usable_observations`
 * (service role; database clock). The database applies every exclusion —
 * approval and coverage within their review periods, invalidation, expiry,
 * deletion deadline — and pages with a keyset cursor (1–200 rows).
 * The response is rebuilt strictly: one malformed row fails the whole read
 * closed rather than returning partial or reinterpreted data.
 */
export async function listUsableTrendObservationsRpc(client: TrendRpcClient, query: TrendRpcQuery): Promise<TrendRpcReadResult> {
  if (!(TREND_PLATFORMS as readonly string[]).includes(query.platform)) return { status: "invalid_query", reason: "invalid_platform" };
  if (!/^[A-Z]{2}$/.test(query.country)) return { status: "invalid_query", reason: "invalid_country" };
  if (query.language !== undefined && query.language !== "und" && !isTrendLanguage(query.language)) {
    return { status: "invalid_query", reason: "invalid_language" };
  }
  const limit = query.limit ?? READ_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_LIMIT_MAX) return { status: "invalid_query", reason: "invalid_limit" };
  let cursorEnd: string | null = null;
  if (query.cursor !== undefined) {
    cursorEnd = instant(query.cursor.windowEnd);
    if (cursorEnd === null || !UUID.test(query.cursor.id)) return { status: "invalid_query", reason: "invalid_cursor" };
  }

  const response = await callTrendRpc(client, "trend_list_usable_observations", {
    p_platform: query.platform,
    p_country: query.country,
    p_language: query.language ?? null,
    p_limit: limit,
    p_after_window_end: cursorEnd,
    p_after_id: query.cursor?.id ?? null,
  });
  if (!response.ok) return { status: "unavailable", code: "storage_failed" };
  const data = response.data;
  if (data.status === "invalid_query") return { status: "invalid_query", reason: safeCode(data.reason) ?? "invalid_query" };
  if (data.status !== "ok" || !Array.isArray(data.observations) || !Array.isArray(data.permitted_source_ids)) {
    return { status: "unavailable", code: "storage_failed" };
  }
  if (data.observations.length > limit || !data.permitted_source_ids.every(isTrendSourceId)) return { status: "unavailable", code: "storage_failed" };

  const observations: StoredTrendObservation[] = [];
  for (const row of data.observations) {
    const stored = storedFrom(row);
    // Defense in depth: never accept a row from another market or an unpermitted source.
    if (!stored || stored.platform !== query.platform || stored.market.country !== query.country
        || (query.language !== undefined && stored.market.language !== query.language)
        || !data.permitted_source_ids.includes(stored.sourceId)) {
      return { status: "unavailable", code: "storage_failed" };
    }
    observations.push(stored);
  }

  let nextCursor: TrendReadCursor | null = null;
  if (data.next_cursor !== null && data.next_cursor !== undefined) {
    if (!isObject(data.next_cursor)) return { status: "unavailable", code: "storage_failed" };
    const end = instant(data.next_cursor.window_end);
    const id = data.next_cursor.id;
    if (end === null || !isText(id) || !UUID.test(id)) return { status: "unavailable", code: "storage_failed" };
    nextCursor = { windowEnd: end, id };
  }
  return { status: "ok", observations, permittedSourceIds: data.permitted_source_ids as string[], nextCursor };
}
