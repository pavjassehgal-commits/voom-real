import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { TikTokClient } from "./client.ts";
import { readTikTokConfig, tikTokKeyRing, type TikTokConfig } from "./config.ts";
import { getTikTokServerCredentials } from "./data.ts";
import { runTikTokPublishFlow } from "./publish-flow.ts";
import {
  claimTikTokReconcileJobs,
  listTikTokPublishedForVerification,
  recordTikTokProviderStatus,
  failTikTokPublishJob,
  type TikTokQueueRow,
} from "./publish-queue.ts";
import { buildTikTokFlowPorts, toTikTokFlowItem } from "./publish-worker.ts";
import { TIKTOK_UPLOAD_BUDGET_MS } from "./publishing.ts";

export interface TikTokReconcileRunResult {
  claimed: number;
  published: number;
  processing: number;
  failed: number;
  retrying: number;
  verified: number;
  skipped: number;
  results: { id: string; outcome: string; code?: string }[];
}

export interface TikTokReconcileDeps {
  db?: SupabaseClient;
  config?: TikTokConfig | null;
  clientFor?: (config: TikTokConfig) => TikTokClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limit?: number;
  budgetMs?: number;
  timeline?: (event: string, detail?: Record<string, unknown>) => void;
  /**
   * How old a published row must be before its evidence is re-checked.
   * 24 hours in production (one daily verification); injectable so tests
   * can cross the window without rewriting the immutable published_at.
   */
  verificationMinAgeHours?: number;
}

/**
 * The durable TikTok reconciliation worker.
 *
 * It owns every outcome the provider still owes Voom:
 *
 *   provider_processing   TikTok accepted the bytes (publish id persisted,
 *                         all chunks delivered) and now owes Voom the
 *                         outcome. This worker polls the OFFICIAL
 *                         post-status endpoint — the only source of
 *                         publication evidence — WITHOUT consuming posting
 *                         attempts, because waiting for the provider is not
 *                         a failure. PUBLISH_COMPLETE publishes (with the
 *                         public post id when TikTok returned one);
 *                         FAILED is recorded with TikTok's own reason.
 *
 *   stale posting         a worker died mid-upload. Rows that already hold
 *                         a publish id resume their transfer (or collect
 *                         evidence when the transfer was already complete);
 *                         rows without one re-run the documented flow from
 *                         the top. A 404 from the upload task fails closed
 *                         (upload_task_gone) — no duplicate post is ever
 *                         risked.
 *
 *   fail-closed rows      rows parked as upload_task_gone /
 *                         publish_ambiguous / post_unavailable /
 *                         processing_timeout / upload_interrupted while
 *                         holding a publish id get a READ-ONLY post-status
 *                         check (throttled to one per 6 hours by the
 *                         claim). Only the provider's own answer moves
 *                         them: PUBLISH_COMPLETE publishes, FAILED fails
 *                         with the provider reason, and
 *                         invalid_publish_id is the ONE case where the
 *                         guarded re-arm may clear the id — TikTok itself
 *                         attested the post does not exist, so a fresh
 *                         init cannot duplicate anything.
 *
 *   published rows        once a day the post is re-checked read-only;
 *                         later changes (removal, rejection) are recorded
 *                         on the row's provider columns WITHOUT rewriting
 *                         the proven publication fact (the database guard
 *                         forbids that anyway).
 */
export async function runTikTokReconciliation(deps: TikTokReconcileDeps = {}): Promise<TikTokReconcileRunResult> {
  const db = deps.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  const config = deps.config !== undefined ? deps.config : readTikTokConfig();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeline = deps.timeline ?? (() => undefined);
  const result: TikTokReconcileRunResult = { claimed: 0, published: 0, processing: 0, failed: 0, retrying: 0, verified: 0, skipped: 0, results: [] };

  if (!config) {
    result.skipped += 1;
    result.results.push({ id: "-", outcome: "skipped", code: "tiktok_not_configured" });
    return result;
  }

  const startedAt = now().getTime();
  const budgetMs = deps.budgetMs ?? TIKTOK_UPLOAD_BUDGET_MS;
  const deadlineAt = startedAt + budgetMs;
  const remainingBudgetMs = () => deadlineAt - Date.now();

  const client = (deps.clientFor ?? ((value: TikTokConfig) => new TikTokClient(value)))(config);
  const keyRing = tikTokKeyRing(config);
  const signedUrls = new Map<string, string>();
  const ports = buildTikTokFlowPorts(db, client, keyRing, config, sleep, signedUrls, { remainingBudgetMs, timeline });

  // 1) Claimed provider-owned work: processing polls, stale uploads, and
  //    fail-closed rows that persist a publish id (read-only recovery).
  const items = await claimTikTokReconcileJobs(db, deps.limit ?? 10, now());
  result.claimed = items.length;
  timeline("tiktok_reconcile_started", { claimed: items.length, budgetMs });
  for (const row of items) {
    if (remainingBudgetMs() < 5_000) break;
    const item = toTikTokFlowItem(row);
    try {
      // A fail-closed row only ever gets the read-only status check (plus
      // the guarded re-arm when TikTok says the post does not exist) — the
      // upload is never re-attempted from here.
      const outcome = await runTikTokPublishFlow(item, ports, { forceEvidenceOnly: row.status === "failed" });
      if (outcome.outcome === "published") result.published += 1;
      else if (outcome.outcome === "processing") result.processing += 1;
      else if (outcome.outcome === "retrying") result.retrying += 1;
      else result.failed += 1;
      result.results.push({ id: row.id, outcome: outcome.outcome, code: outcome.code });
      timeline("tiktok_reconcile_item_done", { itemId: row.id, outcome: outcome.outcome, code: outcome.code });
    } catch {
      await failTikTokPublishJob(db, row.id, row.owner_user_id, {
        code: "tiktok_publish_unknown_error",
        message: "TikTok reconciliation did not complete. Please review this item.",
        status: "failed",
      }).catch(() => undefined);
      result.failed += 1;
      result.results.push({ id: row.id, outcome: "failed", code: "tiktok_publish_unknown_error" });
    }
  }

  // 2) Periodic read-only verification of published evidence.
  const publishedRows = await listTikTokPublishedForVerification(db, 25, now(), deps.verificationMinAgeHours ?? 24);
  for (const row of publishedRows) {
    if (remainingBudgetMs() < 5_000) break;
    const verified = await verifyTikTokPublishedRow(db, client, keyRing, row, now(), timeline);
    if (verified) result.verified += 1;
  }

  return result;
}

/**
 * Read-only daily re-check of a published row's provider evidence. The
 * publication fact itself is never rewritten; this only records what
 * TikTok says NOW (a post removed or failed after publication is visible
 * truth, not a hidden rollback).
 */
async function verifyTikTokPublishedRow(
  db: SupabaseClient,
  client: TikTokClient,
  keyRing: ReturnType<typeof tikTokKeyRing>,
  row: TikTokQueueRow,
  now: Date,
  timeline: (event: string, detail?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!row.tiktok_publish_id) return false;
  let credentials: { accessToken: string };
  try {
    credentials = await getTikTokServerCredentials(db, row.owner_user_id, keyRing, client);
  } catch {
    // A revoked/expired connection stops verification truthfully; it never
    // rewrites the publication fact.
    timeline("tiktok_verify_skipped", { itemId: row.id, reason: "connection_unavailable" });
    return false;
  }
  let status;
  try {
    status = await client.fetchPostStatus(credentials.accessToken, row.tiktok_publish_id);
  } catch {
    timeline("tiktok_verify_skipped", { itemId: row.id, reason: "provider_read_failed" });
    return false;
  }
  const note =
    status.status === "FAILED"
      ? `TikTok now reports this published post as failed${status.failReason ? ` (${status.failReason})` : ""}.`
      : status.status === "PUBLISH_COMPLETE"
        ? null
        : `TikTok now reports this published post as ${status.status}.`;
  try {
    await recordTikTokProviderStatus(db, row.id, row.owner_user_id, {
      providerStatus: status.status,
      providerPostId: status.postIds[0] ?? null,
      failReason: status.failReason,
      note,
      checkedAt: now.toISOString(),
    });
  } catch {
    // Bookkeeping only; the next verification retries.
    return false;
  }
  return true;
}
