import "server-only";

import { createAdminClient } from "@/utils/supabase/admin";
import { syncPostToCalendar, type AdminClient } from "@/lib/post/server-data";
import { getVideoConfig } from "@/lib/media/video-config";
import { createVideoProvider, type VideoGenerationProvider } from "@/lib/media/video-provider";
import {
  isActiveVideoState,
  isTimedOutVideoGeneration,
  reconcileDecision,
  VIDEO_JOB_POLL_INTERVAL_MS,
  VIDEO_JOB_RECOVERY_WINDOW_MINUTES,
  VIDEO_JOB_TIMEOUT_ERROR_CODE,
} from "./video-job";
import {
  advanceVideoGeneration,
  VIDEO_JOB_SELECT,
  type AdvanceResult,
  type VideoGenerationPorts,
  type VideoJobRow,
} from "./video-generation";
import { buildVideoPollingPorts } from "./video-ports";
import { enforceVideoJobHardTimeout } from "./video-service";
import { logVideoPoll, type VideoPollEvent } from "./video-poll-log";

/** The worker's server-side cadence: one provider status check per job every two minutes. */
export const VIDEO_GENERATION_POLL_INTERVAL_MINUTES = VIDEO_JOB_POLL_INTERVAL_MS / 60_000;
/** Keep one invocation bounded and avoid a burst of provider requests. */
export const VIDEO_GENERATION_POLL_BATCH_SIZE = 10;

const VIDEO_ACTIVE_STATES = ["queued", "generating", "processing"] as const;
type VideoKind = "reel" | "story";

export interface DueVideoGeneration {
  row: VideoJobRow;
  kind: VideoKind;
}

export interface VideoPollerResult {
  selected: number;
  polled: number;
  pending: number;
  completed: number;
  failed: number;
  timedOut: number;
  skipped: number;
  results: Array<{ generationId: string; outcome: "pending" | "completed" | "failed" | "timed_out" | "skipped"; errorCode?: string }>;
}

export interface VideoPollerDependencies {
  /** Injected in tests; production uses the service-role client. */
  admin?: AdminClient;
  now?: () => number;
  limit?: number;
  /** Injected provider/ports keep unit tests entirely offline. */
  provider?: VideoGenerationProvider | null;
  ports?: VideoGenerationPorts | null;
  jobs?: DueVideoGeneration[];
  listJobs?: (admin: AdminClient, options: { now: number; providerName: string | null; limit: number }) => Promise<DueVideoGeneration[]>;
  advance?: (ports: VideoGenerationPorts, ownerId: string, generationId: string, kind: VideoKind, options?: { reconcile?: boolean }) => Promise<AdvanceResult>;
  enforceTimeout?: (admin: AdminClient, ownerId: string, generationId: string, now: number) => Promise<{ enforced: boolean; row: VideoJobRow | null }>;
  syncCalendar?: (admin: AdminClient, ownerId: string, draftId: string) => Promise<unknown>;
  logger?: (event: VideoPollEvent, input?: Parameters<typeof logVideoPoll>[1]) => void;
}

/**
 * Finds due active video jobs. A provider handle is mandatory: rows without a
 * persisted handle are never submitted or guessed at by the poller. The
 * provider retry timestamp is checked in memory so a Retry-After response does
 * not cause a request before its deadline. The existing updated_at trigger is
 * the poll lease and cadence clock; no new table or column is required.
 */
export async function listDueVideoGenerations(
  admin: AdminClient,
  options: { now?: number; providerName?: string | null; limit?: number } = {},
): Promise<DueVideoGeneration[]> {
  const now = options.now ?? Date.now();
  const providerName = options.providerName ?? null;
  const limit = Math.min(Math.max(options.limit ?? VIDEO_GENERATION_POLL_BATCH_SIZE, 1), VIDEO_GENERATION_POLL_BATCH_SIZE);
  const dueBefore = new Date(now - VIDEO_JOB_POLL_INTERVAL_MS).toISOString();

  // 'failed' is selected alongside the active states so a job Voom already
  // stopped as `provider_timeout` can still be RECONCILED: the provider may
  // have finished that video after the timeout was written, and the account
  // has already paid for it. `reconcileDecision` decides per row whether such
  // a row is genuinely recoverable; every other failure code is filtered out
  // below and never re-polled.
  const queryBase = admin.from("mara_media_generations")
    .select(VIDEO_JOB_SELECT)
    .eq("media_type", "video")
    .in("status", [...VIDEO_ACTIVE_STATES, "failed"])
    .not("provider_job_id", "is", null)
    .or(`updated_at.is.null,updated_at.lte.${dueBefore}`)
    .order("updated_at", { ascending: true })
    .limit(limit);
  // Keep the provider predicate in SQL so one provider's backlog cannot fill
  // the batch for another. The explicit narrow cast avoids asking Supabase's
  // deeply generic builder to infer two different re-assigned chains.
  const query = providerName
    ? (queryBase as unknown as { eq(column: string, value: string): typeof queryBase }).eq("provider", providerName)
    : queryBase;

  const { data, error } = await query;
  if (error) throw new Error("video_poll_jobs_read_failed");
  const rows = ((data ?? []) as unknown as Record<string, unknown>[])
    .filter((row) => {
      const retryAt = typeof row.provider_retry_after_at === "string" ? Date.parse(row.provider_retry_after_at) : NaN;
      return !Number.isFinite(retryAt) || retryAt <= now;
    })
    // A terminal row qualifies ONLY as a timed-out job still inside its
    // recovery window. A genuine provider failure (rejected, invalid_output,
    // insufficient_credits, …) stays terminal and is never polled again.
    .filter((row) => {
      const status = typeof row.status === "string" ? row.status : "";
      if (isActiveVideoState(status)) return true;
      if (!isTimedOutVideoGeneration(status, typeof row.error_code === "string" ? row.error_code : null)) return false;
      const created = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
      return Number.isFinite(created) && now - created <= VIDEO_JOB_RECOVERY_WINDOW_MINUTES * 60_000;
    })
    .slice(0, limit);

  return Promise.all(rows.map(async (raw) => {
    const row = raw as unknown as VideoJobRow;
    const kind = await findVideoKind(admin, row.owner_user_id, row.draft_id);
    return { row, kind };
  })).then((jobs) => jobs.filter((job): job is DueVideoGeneration => job.kind !== null));
}

/**
 * Durable server-side worker. It never calls the provider's create endpoint:
 * the only provider operation reachable from this path is pollVideoJob with
 * the provider_job_id already stored on the generation row.
 */
export async function runVideoGenerationPoller(deps: VideoPollerDependencies = {}): Promise<VideoPollerResult> {
  const admin = deps.admin ?? createAdminClient();
  const now = deps.now ?? (() => Date.now());
  const nowMs = now();
  const limit = Math.min(Math.max(deps.limit ?? VIDEO_GENERATION_POLL_BATCH_SIZE, 1), VIDEO_GENERATION_POLL_BATCH_SIZE);
  const logger = deps.logger ?? ((event, input) => logVideoPoll(event, input));
  const result: VideoPollerResult = {
    selected: 0,
    polled: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0,
    results: [],
  };

  let providerName: string | null = null;
  let provider = deps.provider ?? null;
  let ports = deps.ports ?? null;
  if (provider === null && deps.provider !== null && !ports) {
    try {
      const config = getVideoConfig();
      providerName = config.provider;
      provider = createVideoProvider(config);
    } catch {
      // The timeout path below remains available even when provider
      // configuration is temporarily missing. Fresh jobs remain active and are
      // picked up by a later run; they are never re-submitted here.
    }
  } else if (provider) {
    providerName = provider.name;
  }

  const jobs = deps.jobs ?? await (deps.listJobs ?? listDueVideoGenerations)(admin, { now: nowMs, providerName, limit });
  result.selected = jobs.length;
  if (!jobs.length) return result;

  if (!ports && provider) ports = buildVideoPollingPorts({ admin, provider });
  const advance = deps.advance ?? advanceVideoGeneration;
  const enforceTimeout = deps.enforceTimeout ?? (async (db, ownerId, generationId, at) => enforceVideoJobHardTimeout(db, ownerId, generationId, { now: at }));
  const syncCalendar = deps.syncCalendar ?? ((db, ownerId, draftId) => syncPostToCalendar(db, ownerId, draftId));

  for (const job of jobs) {
    const { row, kind } = job;
    const wasCompleted = row.status === "completed";
    const startedAt = now();
    logger("poll_started", { generationId: row.id, provider: row.provider ?? providerName });

    // A job at/past its 30-minute lifetime gets ONE final reconciliation
    // against the provider before Voom writes it off. The provider may have
    // finished the video at minute 29 — the account already paid for it, so
    // failing it unseen would throw away work that exists. Reconciliation is
    // a status read on the STORED provider_job_id (see reconcileDecision); it
    // can never submit a replacement job.
    //
    // Only when there is no usable handle, no provider stack, or the answer
    // is still "pending" does the timeout become a persisted database truth.
    const decision = reconcileDecision({
      status: row.status,
      providerJobId: typeof row.provider_job_id === "string" ? row.provider_job_id : null,
      errorCode: typeof row.error_code === "string" ? row.error_code : null,
      clock: { nowMs, createdAtMs: Date.parse(row.created_at) || 0 },
    });

    if (decision !== "none") {
      // Without a provider stack there is nothing to reconcile with. A hard
      // timeout is still a Voom truth, so it is applied even when provider
      // configuration or credentials are temporarily unavailable.
      if (decision === "timeout" || !ports) {
        const outcome = await persistTimeout({
          admin, row, nowMs, enforceTimeout, logger, providerName, startedAt, now, result,
        });
        if (outcome === "handled") continue;
        if (outcome === "no_longer_active") continue;
      } else {
        const settled = await reconcileOnce({
          admin, ports, row, kind, nowMs, advance, enforceTimeout, syncCalendar,
          logger, providerName, startedAt, now, result,
        });
        if (settled) continue;
      }
    }

    if (!ports) {
      result.skipped += 1;
      result.results.push({ generationId: row.id, outcome: "skipped" });
      continue;
    }

    result.polled += 1;
    let advanced: AdvanceResult;
    try {
      advanced = await advance(ports, row.owner_user_id, row.id, kind);
    } catch {
      // `advanceVideoGeneration` normally classifies provider faults and
      // persists them. A defensive worker catch does not submit a replacement
      // job and does not expose provider payloads in its response.
      result.failed += 1;
      logger("provider_failed", { generationId: row.id, provider: row.provider ?? providerName, errorCode: "unavailable", durationMs: elapsed(startedAt, now) });
      result.results.push({ generationId: row.id, outcome: "failed", errorCode: "unavailable" });
      continue;
    }
    if (!advanced.ok) {
      result.skipped += 1;
      result.results.push({ generationId: row.id, outcome: "skipped" });
      continue;
    }

    const current = advanced.generation;
    logger("provider_status", {
      generationId: current.id,
      provider: current.provider ?? providerName,
      providerStatus: current.provider_status ?? current.status,
      durationMs: elapsed(startedAt, now),
    });

    if (current.status === "completed") {
      result.completed += 1;
      const newlyCompleted = !wasCompleted && advanced.attached;
      logger("provider_completed", { generationId: current.id, provider: current.provider ?? providerName, providerStatus: current.provider_status ?? "completed" });
      if (newlyCompleted) {
        await syncCalendar(admin, current.owner_user_id, current.draft_id).catch(() => undefined);
        logger("asset_stored", { generationId: current.id, provider: current.provider ?? providerName });
      }
      result.results.push({ generationId: current.id, outcome: "completed" });
    } else if (current.status === "failed") {
      const code = current.error_code ?? "unavailable";
      if (code === VIDEO_JOB_TIMEOUT_ERROR_CODE) {
        result.timedOut += 1;
        logger("timed_out", { generationId: current.id, provider: current.provider ?? providerName, errorCode: code });
        result.results.push({ generationId: current.id, outcome: "timed_out", errorCode: code });
      } else {
        result.failed += 1;
        logger("provider_failed", { generationId: current.id, provider: current.provider ?? providerName, providerStatus: current.provider_status ?? "failed", errorCode: code });
        result.results.push({ generationId: current.id, outcome: "failed", errorCode: code });
      }
    } else {
      result.pending += 1;
      result.results.push({ generationId: current.id, outcome: "pending" });
    }
  }
  return result;
}

interface SettleContext {
  admin: AdminClient;
  row: VideoJobRow;
  nowMs: number;
  enforceTimeout: NonNullable<VideoPollerDependencies["enforceTimeout"]>;
  logger: (event: VideoPollEvent, input?: Parameters<typeof logVideoPoll>[1]) => void;
  providerName: string | null;
  startedAt: number;
  now: () => number;
  result: VideoPollerResult;
}

/**
 * Persists the hard timeout as a Voom database truth. No provider call is made
 * here, so this path stays available when credentials or configuration are
 * missing — a stuck job can never hold a schedule open forever just because
 * the provider stack is down.
 */
async function persistTimeout(ctx: SettleContext): Promise<"handled" | "no_longer_active" | "still_active"> {
  const { admin, row, nowMs, enforceTimeout, logger, providerName, startedAt, now, result } = ctx;
  const enforced = await enforceTimeout(admin, row.owner_user_id, row.id, nowMs).catch(() => ({ enforced: false, row: null }));
  if (enforced.enforced || enforced.row?.error_code === VIDEO_JOB_TIMEOUT_ERROR_CODE) {
    result.timedOut += 1;
    logger("timed_out", { generationId: row.id, provider: row.provider ?? providerName, errorCode: VIDEO_JOB_TIMEOUT_ERROR_CODE, durationMs: elapsed(startedAt, now) });
    result.results.push({ generationId: row.id, outcome: "timed_out", errorCode: VIDEO_JOB_TIMEOUT_ERROR_CODE });
    return "handled";
  }
  // A concurrent worker may have completed/failed it while this run was
  // reading. Do not make a second provider call on an uncertain row.
  if (!isActiveVideoState(enforced.row?.status ?? row.status)) {
    result.skipped += 1;
    result.results.push({ generationId: row.id, outcome: "skipped" });
    return "no_longer_active";
  }
  return "still_active";
}

/**
 * The final provider reconciliation.
 *
 * One read-only status check on the job id already stored on the row, routed
 * through `advanceVideoGeneration` so completion reuses the SAME validated
 * download → store → attach path as a normal poll. Three real outcomes:
 *
 *   completed — the provider finished (possibly after an earlier timeout).
 *               The asset is attached and the held schedule re-synced, so a
 *               paid video is recovered instead of discarded.
 *   failed    — the provider reported a real failure. That truthful reason is
 *               persisted INSTEAD of a generic timeout.
 *   pending   — the provider is still working with no result to collect, so
 *               the hard timeout is persisted and the job stops.
 *
 * Returns true when the job reached a settled outcome and needs no further
 * work this tick.
 */
async function reconcileOnce(ctx: SettleContext & {
  ports: VideoGenerationPorts;
  kind: VideoKind;
  advance: NonNullable<VideoPollerDependencies["advance"]>;
  syncCalendar: NonNullable<VideoPollerDependencies["syncCalendar"]>;
}): Promise<boolean> {
  const { admin, ports, row, kind, advance, syncCalendar, logger, providerName, startedAt, now, result } = ctx;
  const wasCompleted = row.status === "completed";

  result.polled += 1;
  let advanced: AdvanceResult;
  try {
    advanced = await advance(ports, row.owner_user_id, row.id, kind, { reconcile: true });
  } catch {
    // The reconciliation itself failed. Fall back to the database truth so a
    // provider outage cannot leave the job active forever. No replacement job
    // is ever submitted on this path.
    const outcome = await persistTimeout(ctx);
    if (outcome === "still_active") {
      result.failed += 1;
      logger("provider_failed", { generationId: row.id, provider: row.provider ?? providerName, errorCode: "unavailable", durationMs: elapsed(startedAt, now) });
      result.results.push({ generationId: row.id, outcome: "failed", errorCode: "unavailable" });
    }
    return true;
  }
  if (!advanced.ok) {
    result.skipped += 1;
    result.results.push({ generationId: row.id, outcome: "skipped" });
    return true;
  }

  const current = advanced.generation;
  logger("provider_status", {
    generationId: current.id,
    provider: current.provider ?? providerName,
    providerStatus: current.provider_status ?? current.status,
    durationMs: elapsed(startedAt, now),
  });

  if (current.status === "completed") {
    // A real video exists. Recovering it is the whole point of reconciling:
    // the account already paid for these bytes.
    result.completed += 1;
    logger("provider_completed", { generationId: current.id, provider: current.provider ?? providerName, providerStatus: current.provider_status ?? "completed" });
    if (!wasCompleted && advanced.attached) {
      await syncCalendar(admin, current.owner_user_id, current.draft_id).catch(() => undefined);
      logger("asset_stored", { generationId: current.id, provider: current.provider ?? providerName });
    }
    result.results.push({ generationId: current.id, outcome: "completed" });
    return true;
  }

  if (current.status === "failed") {
    const code = current.error_code ?? VIDEO_JOB_TIMEOUT_ERROR_CODE;
    if (code === VIDEO_JOB_TIMEOUT_ERROR_CODE) {
      result.timedOut += 1;
      logger("timed_out", { generationId: current.id, provider: current.provider ?? providerName, errorCode: code });
      result.results.push({ generationId: current.id, outcome: "timed_out", errorCode: code });
    } else {
      // A REAL provider failure reason is more truthful than "timed out", so
      // it is kept exactly as the provider reported it.
      result.failed += 1;
      logger("provider_failed", { generationId: current.id, provider: current.provider ?? providerName, providerStatus: current.provider_status ?? "failed", errorCode: code });
      result.results.push({ generationId: current.id, outcome: "failed", errorCode: code });
    }
    return true;
  }

  // Still genuinely pending past its lifetime: nothing to collect, so the
  // timeout becomes the persisted truth and the job stops here.
  const outcome = await persistTimeout(ctx);
  if (outcome === "still_active") {
    result.pending += 1;
    result.results.push({ generationId: current.id, outcome: "pending" });
  }
  return true;
}

async function findVideoKind(admin: AdminClient, ownerId: string, draftId: string): Promise<VideoKind | null> {
  const { data, error } = await admin.from("mara_drafts")
    .select("kind")
    .eq("owner_user_id", ownerId)
    .eq("id", draftId)
    .maybeSingle();
  if (error || !data) return null;
  return data.kind === "story" ? "story" : data.kind === "reel" ? "reel" : null;
}

function elapsed(start: number, now: () => number): number {
  return Math.max(0, now() - start);
}

/** Kept small and explicit for route/tests that need to explain the cadence. */
export function videoPollCadenceSeconds(): number {
  return VIDEO_JOB_POLL_INTERVAL_MS / 1000;
}

/** Used by tests and operational checks without importing a provider. */
export function isDueForVideoPoll(row: Pick<VideoJobRow, "status" | "provider_job_id" | "updated_at" | "provider_retry_after_at">, nowMs: number): boolean {
  if (!isActiveVideoState(row.status) || typeof row.provider_job_id !== "string" || !row.provider_job_id) return false;
  const retryAt = row.provider_retry_after_at ? Date.parse(row.provider_retry_after_at) : NaN;
  if (Number.isFinite(retryAt) && retryAt > nowMs) return false;
  const last = Date.parse(row.updated_at);
  return !Number.isFinite(last) || nowMs - last >= VIDEO_JOB_POLL_INTERVAL_MS;
}
