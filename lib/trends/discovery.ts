import "server-only";

import { discoverWikidataEvents, type DiscoveredWikidataEvent, type WikidataDiscoveryResult } from "./connectors/wikidata-events";
import { storeTrendObservations, type BatchStoreResult } from "./storage";
import type { TrendRpcClient } from "./supabase-rpc";

export type DiscoveryRunResult =
  | { status: "source_failed"; source: WikidataDiscoveryResult }
  | { status: "completed"; discovered: number; rejectedByConnector: number; rejectedReasons: Record<string, number>; storage: BatchStoreResult; reviewCandidates: DiscoveredWikidataEvent[] };

/**
 * Fetches one bounded Wikidata page and stores validated observations. Storage
 * still fails closed unless the database owner has approved the source and
 * verified AE/web coverage. Returned candidates are NOT reviewed or approved.
 */
export async function runWikidataEventDiscovery(input: {
  client: TrendRpcClient;
  now: Date;
  fetch?: Parameters<typeof discoverWikidataEvents>[0]["fetch"];
}): Promise<DiscoveryRunResult> {
  const source = await discoverWikidataEvents({ now: input.now, fetch: input.fetch });
  if (source.status !== "ok") return { status: "source_failed", source };
  const storage = await storeTrendObservations(input.client, source.events.map((event) => event.observation), { now: input.now, maxBatch: 25 });
  return {
    status: "completed",
    discovered: source.events.length,
    rejectedByConnector: source.rejected,
    rejectedReasons: { ...source.rejectedReasons },
    storage,
    reviewCandidates: source.events,
  };
}
