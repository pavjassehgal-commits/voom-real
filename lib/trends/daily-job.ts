import "server-only";

import { runWikidataCollection, type CollectionReport } from "./collection-runner";
import { getTrendRetentionStatus, runTrendRetentionPurge, type PurgeResult, type RetentionStatus } from "./governance";
import { listUsableTrendObservationsRpc } from "./read-model";
import type { TrendRpcClient } from "./supabase-rpc";
import { runUniversalTrendCollection, type UniversalCollectionReport } from "./universal-collection";

/**
 * The daily Trend Intelligence job (cron route: app/api/cron/trend-collection).
 *
 *   1. bounded retention purge through the existing service RPC (database
 *      clock only; deletes nothing before its deadline);
 *   2. rate limit: if a Wikidata observation was retrieved within the last
 *      20 hours, no Wikidata request is made (one collection per day);
 *   3. otherwise the governed collection: approval/coverage preflight, ONE
 *      bounded Wikidata GET, storage through the store RPC (duplicates are
 *      reported, never overwritten);
 *   4. the multi-industry sources (public holidays per approved country,
 *      Wikipedia attention per approved language), each behind the same
 *      approval/coverage preflight and a 20-hour rate limit;
 *   5. retention health for monitoring.
 * It never approves evidence and never creates MARA contexts. Every outcome
 * is a safe code; no credentials or raw errors are returned.
 */

export const DAILY_COLLECTION_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export type DailyTrendJobReport = {
  runAt: string;
  purge: PurgeResult;
  collection:
    | { status: "skipped_recently_collected"; lastRetrievedAt: string }
    | { status: "skipped_read_failed"; code: string }
    | CollectionReport;
  universal: UniversalCollectionReport;
  retention: RetentionStatus | null;
  healthy: boolean;
};

export async function runDailyTrendJob(input: {
  client: TrendRpcClient;
  now: Date;
  fetch: FetchLike;
  projectId: string;
}): Promise<DailyTrendJobReport> {
  const purge = await runTrendRetentionPurge(input.client, { limit: 500 });

  let collection: DailyTrendJobReport["collection"];
  const recent = await listUsableTrendObservationsRpc(input.client, { platform: "web", country: "AE", language: "en", limit: 200 });
  if (recent.status !== "ok") {
    collection = { status: "skipped_read_failed", code: recent.status === "invalid_query" ? recent.reason : recent.code };
  } else {
    const last = recent.observations
      .filter((o) => o.sourceId === "wikidata_events")
      .map((o) => Date.parse(o.retrievedAt))
      .reduce((max, t) => Math.max(max, t), Number.NEGATIVE_INFINITY);
    collection = Number.isFinite(last) && input.now.getTime() - last < DAILY_COLLECTION_MIN_INTERVAL_MS
      ? { status: "skipped_recently_collected", lastRetrievedAt: new Date(last).toISOString() }
      : await runWikidataCollection({ client: input.client, now: input.now, fetch: input.fetch, projectId: input.projectId });
  }

  const universal = await runUniversalTrendCollection({ client: input.client, now: input.now, fetch: input.fetch });
  const status = await getTrendRetentionStatus(input.client);
  const retention = status.ok ? status.status : null;
  const collectionOk = collection.status === "completed" || collection.status === "skipped_recently_collected";
  return {
    runAt: input.now.toISOString(),
    purge,
    collection,
    universal,
    retention,
    healthy: purge.status === "succeeded" && collectionOk && retention !== null && !retention.breach,
  };
}
