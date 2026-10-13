import "server-only";

import type { TrendPromptContext } from "./opportunity";
import { listUsableTrendObservationsRpc } from "./read-model";
import type { TrendRpcClient } from "./supabase-rpc";
import { isTrendLanguage, TREND_PLATFORMS, type TrendPlatform } from "./types";

type StoredContext = {
  topic: unknown;
  platform: unknown;
  market_country: unknown;
  market_language: unknown;
  event_start: unknown;
  event_end: unknown;
  facts: unknown;
  observed_at: unknown;
  confidence: unknown;
  caveats: unknown;
  observation_ids: unknown;
};

type ContextQuery = {
  eq(column: string, value: unknown): ContextQuery;
  gt(column: string, value: unknown): ContextQuery;
  order(column: string, options: { ascending: boolean }): ContextQuery;
  limit(count: number): ContextQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
};

export type TrendWorkflowClient = TrendRpcClient & {
  from(table: string): { select(columns: string): ContextQuery };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function parseStoredContext(row: StoredContext): (TrendPromptContext & { platform: TrendPlatform; observationIds: string[] }) | null {
  if (!text(row.topic, 200) || !(TREND_PLATFORMS as readonly unknown[]).includes(row.platform)) return null;
  if (!text(row.market_country, 2) || !COUNTRY.test(row.market_country)) return null;
  if (!text(row.market_language, 16) || (row.market_language !== "und" && !isTrendLanguage(row.market_language))) return null;
  if (!text(row.observed_at, 40) || !Number.isFinite(Date.parse(row.observed_at))) return null;
  if (!text(row.confidence, 20) || !["low", "medium", "high"].includes(row.confidence)) return null;
  if (!Array.isArray(row.facts) || row.facts.length === 0 || row.facts.length > 6) return null;
  if (!Array.isArray(row.caveats) || row.caveats.length > 4 || !row.caveats.every((v) => text(v, 400))) return null;
  if (!Array.isArray(row.observation_ids) || row.observation_ids.length === 0
      || row.observation_ids.length > 20 || !row.observation_ids.every((v) => typeof v === "string" && UUID.test(v))) return null;
  const facts: TrendPromptContext["facts"] = [];
  for (const value of row.facts) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const fact = value as { statement?: unknown; sources?: unknown };
    if (!text(fact.statement, 300) || !Array.isArray(fact.sources) || fact.sources.length === 0
        || fact.sources.length > 3 || !fact.sources.every((v) => text(v, 200))) return null;
    facts.push({ statement: fact.statement, sources: fact.sources as string[] });
  }
  const noWindow = row.event_start === null && row.event_end === null;
  if (!noWindow && (!(typeof row.event_start === "string" && DATE.test(row.event_start))
      || !(typeof row.event_end === "string" && DATE.test(row.event_end)) || row.event_start > row.event_end)) return null;
  return {
    topic: row.topic,
    platform: row.platform as TrendPlatform,
    market: { country: row.market_country, language: row.market_language },
    eventWindow: noWindow ? null : { start: row.event_start as string, end: row.event_end as string },
    facts,
    observedAt: new Date(row.observed_at).toISOString(),
    confidence: row.confidence,
    caveats: row.caveats as string[],
    observationIds: row.observation_ids as string[],
  };
}

/**
 * Production loader for MARA's shared planning path. The feature flag is
 * checked by the caller. This loader fails closed unless a reviewed,
 * owner-scoped context is still valid AND every linked observation remains
 * usable through the existing policy/coverage/expiry/invalidation RPC.
 */
export async function loadOwnerTrendPromptContext(
  db: TrendWorkflowClient,
  ownerId: string,
  now: Date | string,
): Promise<TrendPromptContext | null> {
  const nowIso = now instanceof Date ? now.toISOString() : now;
  if (!Number.isFinite(Date.parse(nowIso))) return null;
  const { data, error } = await db.from("trend_mara_contexts")
    .select("topic,platform,market_country,market_language,event_start,event_end,facts,observed_at,confidence,caveats,observation_ids")
    .eq("owner_user_id", ownerId)
    .eq("status", "approved")
    .gt("valid_until", nowIso)
    .order("valid_until", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const context = parseStoredContext(data as StoredContext);
  if (!context) return null;

  const usable = await listUsableTrendObservationsRpc(db, {
    platform: context.platform,
    country: context.market.country,
    language: context.market.language,
    limit: 200,
  });
  if (usable.status !== "ok") return null;
  const usableIds = new Set(usable.observations.map((observation) => observation.storageId));
  if (!context.observationIds.every((id) => usableIds.has(id))) return null;
  const linked = usable.observations.filter((observation) => context.observationIds.includes(observation.storageId));
  if (!linked.some((observation) => observation.subject.text === context.topic)) return null;

  return {
    topic: context.topic,
    market: context.market,
    eventWindow: context.eventWindow,
    facts: context.facts,
    observedAt: context.observedAt,
    confidence: context.confidence,
    caveats: context.caveats,
  };
}
