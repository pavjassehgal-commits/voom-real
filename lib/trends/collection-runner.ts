import "server-only";

import { runWikidataEventDiscovery } from "./discovery";
import { listUsableTrendObservationsRpc } from "./read-model";
import type { TrendRpcClient } from "./supabase-rpc";

/**
 * One-off staging collection for the Wikidata event source.
 *
 * Order of operations (fail closed at every step):
 *   1. the caller (scripts/trends/collect-wikidata-staging.mjs) has verified
 *      the environment targets voom-staging before building the client;
 *   2. preflight through the governed read RPC: the database must currently
 *      permit wikidata_events for web/AE (approved + verified coverage).
 *      Otherwise NO Wikidata request is made;
 *   3. ONE bounded Wikidata GET (connector: <= 25 records, no retries);
 *   4. storage through the governed store RPC only (duplicates are reported,
 *      never overwritten).
 * It never approves an event, never creates or approves a MARA context, and
 * returns only counts, statuses and safe codes — no credentials or raw errors.
 */

/** voom-staging. The command verifies the environment targets it before building a client. */
export const STAGING_PROJECT_ID = "qcdpegwjofrqnfudyrqq";

export type CollectionCandidate = {
  entity: string;
  label: string;
  dateStatus: "recorded" | "needs_verification";
  dateIssues: string[];
  eventWindow: { start: string; end: string } | null;
  storage: string;
  reviewStatus: "pending_human_review";
};

export type CollectionReport = {
  runAt: string;
  projectId: string;
  status: "refused_not_authorized" | "preflight_failed" | "source_failed" | "completed";
  code?: string;
  wikidataRequests: number;
  discovered: number;
  rejectedByConnector: number;
  rejectedReasons: Record<string, number>;
  storage: { stored: number; duplicate: number; conflict: number; invalidated: number; rejected: number };
  storageCodes: Record<string, number>;
  candidates: CollectionCandidate[];
  approvalsCreated: 0;
  contextsCreated: 0;
};

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const EMPTY_STORAGE = { stored: 0, duplicate: 0, conflict: 0, invalidated: 0, rejected: 0 };

export async function runStagingWikidataCollection(input: {
  client: TrendRpcClient;
  now: Date;
  /** Label recorded in the report; defaults to voom-staging. */
  projectId?: string;
  /** Injected network access (the command passes globalThis.fetch). */
  fetch: FetchLike;
}): Promise<CollectionReport> {
  const base = {
    runAt: input.now.toISOString(),
    projectId: input.projectId ?? STAGING_PROJECT_ID,
    wikidataRequests: 0,
    discovered: 0,
    rejectedByConnector: 0,
    rejectedReasons: {},
    storage: { ...EMPTY_STORAGE },
    storageCodes: {},
    candidates: [],
    approvalsCreated: 0 as const,
    contextsCreated: 0 as const,
  };

  // Governance preflight: no permission, no outbound request.
  const permission = await listUsableTrendObservationsRpc(input.client, { platform: "web", country: "AE", language: "en", limit: 1 });
  if (permission.status !== "ok") {
    return { ...base, status: "preflight_failed", code: permission.status === "invalid_query" ? permission.reason : permission.code };
  }
  if (!permission.permittedSourceIds.includes("wikidata_events")) {
    return { ...base, status: "refused_not_authorized", code: "wikidata_events_not_approved_or_not_covered" };
  }

  const requestWikidata = input.fetch;
  let requests = 0;
  const counted: FetchLike = (url, init) => {
    requests += 1;
    return requestWikidata(url, init);
  };

  const run = await runWikidataEventDiscovery({ client: input.client, now: input.now, fetch: counted });
  if (run.status === "source_failed") {
    return { ...base, wikidataRequests: requests, status: "source_failed", code: run.source.status === "failed" ? run.source.code : "source_failed" };
  }

  const storageCodes: Record<string, number> = {};
  const candidates = run.reviewCandidates.map((event, index): CollectionCandidate => {
    const result = run.storage.results[index];
    const storage = result.status === "rejected" ? `rejected:${result.code}` : result.status;
    if (result.status === "rejected") storageCodes[result.code] = (storageCodes[result.code] ?? 0) + 1;
    return {
      entity: event.observation.evidence[0].url ?? "",
      label: event.observation.subject.text,
      dateStatus: event.dateStatus,
      dateIssues: [...event.dateIssues],
      eventWindow: event.eventWindow,
      storage,
      reviewStatus: "pending_human_review",
    };
  });

  return {
    ...base,
    status: "completed",
    wikidataRequests: requests,
    discovered: run.discovered,
    rejectedByConnector: run.rejectedByConnector,
    rejectedReasons: { ...run.rejectedReasons },
    storage: { ...run.storage.counts },
    storageCodes,
    candidates,
  };
}

/** The same governed, bounded collection for any configured project (used by the daily job). */
export const runWikidataCollection = runStagingWikidataCollection;
