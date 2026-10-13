import "server-only";

import { assessFreshness } from "./freshness";
import { parseInstant, parseTrendObservation } from "./schema";
import { callTrendRpc, safeCode, type TrendRpcClient } from "./supabase-rpc";
import { trendSource, type TrendObservation, type TrendSourceId, type ValidationIssue } from "./types";

/**
 * Trend Intelligence — server-only storage of validated observations through
 * the service-role RPC `trend_store_observation` (Stage 2C).
 *
 * The database is the authority: inside one transaction it validates the
 * payload, checks CURRENT approval and coverage (locked against concurrent
 * revocation), computes freshness and the deletion deadline from the source,
 * derives identity, and writes observation + metrics + evidence atomically.
 *
 * This module adds the checks only the application can make before calling:
 *   - the observation must be exactly what parseTrendObservation() produces;
 *   - it must not already be expired;
 *   - every measured value must be representable exactly (values are sent as
 *     decimal strings; an integer beyond 2^53 has already lost precision in
 *     JavaScript and is refused rather than stored inaccurately).
 *
 * Duplicates never overwrite: an identical replay returns `duplicate`, a
 * different payload `conflict`, and an identity whose latest revision was
 * invalidated returns `invalidated` (a correction must name what it
 * replaces). Errors are stable codes; database messages are never returned.
 */

const DAY_MS = 86_400_000;

/** Mirrors trend_sources.max_retention_days in the proposed schema. */
export const SOURCE_RETENTION_CAP_MS: Record<TrendSourceId, number> = {
  google_trends_web: 365 * DAY_MS,
  google_trends_api: 365 * DAY_MS,
  youtube_data_api: 30 * DAY_MS,
  manual_research: 365 * DAY_MS,
  wikidata_events: 30 * DAY_MS,
};

export type StoreErrorCode =
  | "invalid_now"
  | "invalid_replacement"
  | "observation_not_validated"
  | "observation_expired"
  | "metric_precision_lost"
  | "source_not_authorized"
  | "coverage_not_verified"
  | "metric_rejected"
  | "evidence_rejected"
  | "retention_rejected"
  | "storage_rejected"
  | "storage_failed";

export type StorageKeys = { itemKey: string | null; topicKey: string; trendKey: string };

export type StoreResult =
  | { status: "stored"; observationId: string; revision: number; keys: StorageKeys; expiresAt: string; deleteAfter: string }
  | { status: "duplicate" | "conflict"; observationId: string; revision: number; keys: StorageKeys }
  | { status: "invalidated"; observationId: string; revision: number }
  | { status: "rejected"; code: StoreErrorCode; detail?: string; issues?: ValidationIssue[] };

export type StoreOptions = {
  now: Date | number | string;
  /** The invalidated observation this one corrects (same identity). */
  replaces?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The identity keys exactly as the database generates them. */
export function storageKeys(observation: TrendObservation): StorageKeys {
  const { platform, market, subject, item } = observation;
  const topicKey = ["topic", platform, market.country, market.language, subject.kind, subject.normalized].join("|");
  return {
    itemKey: item ? ["item", platform, item.kind, item.providerItemId].join("|") : null,
    topicKey,
    trendKey: item ? ["item", platform, market.country, market.language, item.kind, item.providerItemId].join("|") : topicKey,
  };
}

/** The raw shape that parseTrendObservation() turns back into `observation`. */
function rawFrom(observation: TrendObservation): unknown {
  return {
    id: observation.id,
    sourceId: observation.sourceId,
    platform: observation.platform,
    market: { ...observation.market },
    subject: {
      kind: observation.subject.kind,
      text: observation.subject.text,
      ...(observation.item ? { providerItemId: observation.item.providerItemId } : {}),
    },
    window: { ...observation.window },
    retrievedAt: observation.retrievedAt,
    metrics: Object.fromEntries(Object.entries(observation.metrics).map(([key, value]) => [key, { ...value }])),
    evidence: observation.evidence.map((entry) => ({ ...entry })),
  };
}

/** Deterministic JSON (sorted keys) for structural comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
      : inner,
  );
}

/** An exact decimal string for a validated, non-negative metric value, or null. */
export function exactDecimal(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (Number.isInteger(value)) return Number.isSafeInteger(value) ? BigInt(value).toString() : null;
  const text = String(value);
  if (!/e/i.test(text)) return text;
  const fixed = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return Number(fixed) === value ? fixed : null;
}

/** Maps a database result code onto the application's error families. */
function codeFromDatabase(code: string | undefined): { code: StoreErrorCode; detail?: string } {
  if (code === undefined) return { code: "storage_failed" };
  if (code === "source_not_authorized" || code === "coverage_not_verified" || code === "observation_expired" || code === "invalid_replacement") {
    return { code };
  }
  if (/^(invalid_metrics|unknown_metric|unknown_metric_definition|metric_[a-z_]+|metrics_[a-z_]+|observation_missing_required_metric)$/.test(code)) {
    return { code: "metric_rejected", detail: code };
  }
  if (/^(invalid_evidence|evidence_[a-z_]+|observation_missing_evidence)$/.test(code)) return { code: "evidence_rejected", detail: code };
  if (/^(retention_[a-z_]+|observations_delete_after_retrieval)$/.test(code)) return { code: "retention_rejected", detail: code };
  if (code === "storage_failed") return { code: "storage_failed" };
  return { code: "storage_rejected", detail: code };
}

function keysFrom(data: Record<string, unknown>): StorageKeys | null {
  const { item_key: itemKey, topic_key: topicKey, trend_key: trendKey } = data;
  if (typeof topicKey !== "string" || typeof trendKey !== "string" || (itemKey !== null && typeof itemKey !== "string")) return null;
  return { itemKey: itemKey as string | null, topicKey, trendKey };
}

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRevision = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

export async function storeTrendObservation(client: TrendRpcClient, observation: TrendObservation, options: StoreOptions): Promise<StoreResult> {
  const nowMs = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : parseInstant(options.now);
  if (nowMs === null || !Number.isFinite(nowMs)) return { status: "rejected", code: "invalid_now" };
  if (options.replaces !== undefined && !isUuid(options.replaces)) return { status: "rejected", code: "invalid_replacement" };

  // 1. Only validator output is accepted, unchanged.
  const reparsed = parseTrendObservation(rawFrom(observation), { now: nowMs });
  if (!reparsed.ok) return { status: "rejected", code: "observation_not_validated", issues: reparsed.issues };
  if (canonical(reparsed.value) !== canonical(observation)) {
    return {
      status: "rejected",
      code: "observation_not_validated",
      issues: [{ path: "", code: "not_canonical", message: "The observation differs from its validated form." }],
    };
  }

  // 2. Never send what is already unusable (the database re-checks).
  if (assessFreshness(observation, nowMs).status === "expired") return { status: "rejected", code: "observation_expired" };

  // 3. Exact values only.
  const metrics: Record<string, Record<string, string | null>> = {};
  for (const definition of trendSource(observation.sourceId).metrics) {
    const value = observation.metrics[definition.key];
    if (value.status === "unavailable") {
      metrics[definition.key] = { status: "unavailable", unavailable_reason: value.reason };
      continue;
    }
    const exact = exactDecimal(value.value);
    if (exact === null) return { status: "rejected", code: "metric_precision_lost", detail: definition.key };
    metrics[definition.key] = { status: "measured", value: exact, definition_version: value.definitionVersion };
  }

  const payload = {
    source_id: observation.sourceId,
    platform: observation.platform,
    country: observation.market.country,
    language: observation.market.language,
    subject_kind: observation.subject.kind,
    subject_text: observation.subject.text,
    subject_normalized: observation.subject.normalized,
    provider_item_id: observation.item?.providerItemId ?? null,
    window_start: observation.window.start,
    window_end: observation.window.end,
    retrieved_at: observation.retrievedAt,
    metrics,
    evidence: observation.evidence.map((entry) => ({
      source_id: entry.sourceId,
      url: entry.url,
      attribution: entry.attribution,
      retrieved_at: entry.retrievedAt,
    })),
  };

  const response = await callTrendRpc(client, "trend_store_observation", { p_observation: payload, p_replaces: options.replaces ?? null });
  if (!response.ok) return { status: "rejected", code: "storage_failed" };
  const data = response.data;
  switch (data.status) {
    case "stored": {
      const keys = keysFrom(data);
      if (!keys || !isUuid(data.observation_id) || !isRevision(data.revision)) return { status: "rejected", code: "storage_failed" };
      const expiresAt = parseInstant(String(data.expires_at));
      const deleteAfter = parseInstant(String(data.delete_after));
      if (expiresAt === null || deleteAfter === null) return { status: "rejected", code: "storage_failed" };
      return {
        status: "stored",
        observationId: data.observation_id,
        revision: data.revision,
        keys,
        expiresAt: new Date(expiresAt).toISOString(),
        deleteAfter: new Date(deleteAfter).toISOString(),
      };
    }
    case "duplicate":
    case "conflict": {
      const keys = keysFrom(data);
      if (!keys || !isUuid(data.observation_id) || !isRevision(data.revision)) return { status: "rejected", code: "storage_failed" };
      return { status: data.status, observationId: data.observation_id, revision: data.revision, keys };
    }
    case "invalidated":
      if (!isUuid(data.observation_id) || !isRevision(data.revision)) return { status: "rejected", code: "storage_failed" };
      return { status: "invalidated", observationId: data.observation_id, revision: data.revision };
    case "rejected":
      return { status: "rejected", ...codeFromDatabase(safeCode(data.code)) };
    default:
      return { status: "rejected", code: "storage_failed" };
  }
}

export type BatchStoreResult = {
  results: StoreResult[];
  counts: Record<StoreResult["status"], number>;
};

/** Stores each observation in its own transaction; one failure never affects another. */
export async function storeTrendObservations(
  client: TrendRpcClient,
  observations: readonly TrendObservation[],
  options: { now: Date | number | string; maxBatch?: number },
): Promise<BatchStoreResult> {
  const maxBatch = Math.min(options.maxBatch ?? 200, 200);
  if (observations.length > maxBatch) throw new RangeError(`At most ${maxBatch} observations per call.`);
  const results: StoreResult[] = [];
  const counts = { stored: 0, duplicate: 0, conflict: 0, invalidated: 0, rejected: 0 };
  for (const observation of observations) {
    const result = await storeTrendObservation(client, observation, { now: options.now });
    counts[result.status] += 1;
    results.push(result);
  }
  return { results, counts };
}
