import "server-only";

import { randomUUID } from "node:crypto";
import { createMediaProvider, getMediaConfig, MediaError } from "@/lib/media";
import { aspectMatches, inspectImageBytes } from "@/lib/media/media-inspect";
import { putPostAsset, removePostAssetObject, syncPostToCalendar, type AdminClient } from "@/lib/post/server-data";
import { advanceVideoJob, buildVideoService, enforceVideoJobHardTimeout, startPostStudioVideo } from "@/lib/mara/video-service";
import type { PostStudioVideoStartArgs, PostStudioVideoStartResult } from "@/lib/mara/video-service";
import { isTimedOutVideoGeneration, staleDecision } from "@/lib/mara/video-job";
import { isActiveMediaStatus, isStaleMediaGeneration, MEDIA_GENERATION_HARD_TIMEOUT_MINUTES } from "./state";
import type { ContentType } from "@/lib/voom/cadence";

/**
 * Media generation for one workflow item, reusing the EXISTING durable MARA
 * media systems only:
 *
 *   Image Post / image Story -> lib/media provider abstraction (OpenRouter
 *     Seedream today) + the same byte-level validation and private storage
 *     Post Studio uses.
 *   Reel / video Story       -> the existing durable video job service
 *     (OpenRouter Seedance, Magic Hour fallback) via startPostStudioVideo.
 *
 * No new provider implementation is introduced here.
 *
 * Duplicate-charge protection (explicit + idempotent):
 *   - a FRESH in-flight generation always resolves to "exists": repeated
 *     clicks (or a second tab) can never start, let alone pay for, a second
 *     generation — `decideMediaStart` encodes the whole policy so it is
 *     unit tested,
 *   - a STALE in-flight VIDEO job that is still INSIDE its hard timeout is
 *     re-advanced (polled) instead of replaced: the provider job may still be
 *     running, so a second one is never submitted,
 *   - a VIDEO job BEYOND its hard timeout can never complete: it is stopped
 *     with a terminal provider_timeout state (a database write only — no
 *     provider call, no charge) and the ONLY way to a new paid generation is
 *     the user's explicit "Retry as new generation" click. Merely viewing,
 *     polling or re-advancing never submits one,
 *   - a STALE in-flight IMAGE row is a dead synchronous attempt: the explicit
 *     retry retires it (cancelled) and starts exactly one fresh attempt,
 *   - video retries after a FINISHED attempt get a fresh token only because
 *     the finished row can never complete; a first run keeps the stable
 *     per-draft token, so repeated clicks resolve to the same job,
 *   - the database keeps the final guard: one active generation per
 *     (owner, draft) partial unique index — so even two simultaneous clicks
 *     create at most one fresh provider job.
 */

const GENERATED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface MediaRequest {
  ownerId: string;
  draftId: string;
  conversationId: string;
  contentType: ContentType;
  concept: string;
  visualBrief: string;
}

/**
 * What actually happened, so the UI can only tell the truth:
 *
 *   exists    — nothing was started (a stored asset or a live generation
 *               already owns this item); nothing was charged,
 *   advanced  — an EXISTING in-flight job was re-checked with the provider;
 *               no new job was submitted and nothing new was charged,
 *   timed_out — an in-flight job beyond its hard timeout was stopped with a
 *               terminal provider_timeout state; no new job, no charge,
 *   queued    — a NEW generation was submitted (the only paid outcome here),
 *   completed — an image generation finished synchronously and is stored.
 */
export type MediaOutcomeState = "exists" | "advanced" | "timed_out" | "queued" | "completed";

export type MediaOutcome = { ok: true; state: MediaOutcomeState } | { ok: false; code: string };

/**
 * The truthful user-facing sentence for one outcome. A retry that only
 * re-checked an existing job must never claim a new video was started, and a
 * retry that DID submit a new paid generation must say so plainly.
 */
export function mediaOutcomeMessage(state: MediaOutcomeState): string {
  switch (state) {
    case "exists":
      return "A generation is already in flight for this item — nothing new was started, so nothing was charged.";
    case "advanced":
      return "Voom re-checked this item's existing generation with the provider — no new video was started and nothing new was charged.";
    case "timed_out":
      return `That generation ran past Voom's ${MEDIA_GENERATION_HARD_TIMEOUT_MINUTES}-minute limit, so Voom stopped it. No new generation was started and nothing was charged — retry it as a new generation, upload a replacement, or cancel the schedule.`;
    case "queued":
      return "MARA started a NEW generation for this item. Nothing was published.";
    case "completed":
      return "MARA generated the visual for this item. Nothing was published.";
  }
}

/** The latest generation row for a draft (any media type, any status). */
export interface LatestGeneration {
  id: string;
  status: string;
  /** 'image' | 'video' — the hard timeout is an asynchronous-video rule. */
  mediaType: string | null;
  /** Terminal reason, e.g. 'provider_timeout'. */
  errorCode: string | null;
  /** Job lifetime anchor: the hard timeout is measured from creation. */
  createdAt: string | null;
  updatedAt: string | null;
}

/** True when this row is a terminal hard-timeout video generation. */
export function isTimedOutGeneration(latest: LatestGeneration | null): boolean {
  if (!latest) return false;
  if (latest.mediaType === "image") return false;
  return isTimedOutVideoGeneration(latest.status, latest.errorCode ?? null);
}

/**
 * The one explicit/idempotent media start policy (pure — unit tested).
 *
 *   exists             — something already owns this item's visual (a stored
 *                        asset, a fresh in-flight generation, or a timed-out
 *                        generation nobody explicitly retried): do NOTHING.
 *                        This is what makes a repeated retry click a no-op
 *                        instead of a second charge.
 *   advance            — a STALE in-flight video job still INSIDE its hard
 *                        timeout: re-check the SAME job. No second provider
 *                        job is ever submitted for an in-flight one.
 *   timeout            — an in-flight video job BEYOND its hard timeout: stop
 *                        it with a terminal provider_timeout state. Database
 *                        write only — no provider call, no new job, no charge.
 *   start_after_timeout— the SAME terminal transition, followed by exactly one
 *                        fresh generation. This is "Retry as new generation"
 *                        and the ONLY decision that may submit a new provider
 *                        job after a timeout — so it requires `explicit`.
 *   start              — actually (re)start. `token` decides the paid identity:
 *                        "stable"  = the per-draft token (first runs; repeats
 *                                     resolve to the same job),
 *                        "fresh"   = a brand-new token (an explicit retry after
 *                                     a FINISHED attempt — the old row is
 *                                     terminal and can never complete, so
 *                                     nothing is duplicated),
 *                        <string>  = an explicit caller token (e.g. "Regenerate").
 *                        `retireGenerationId` = a dead synchronous attempt that
 *                        the explicit retry replaces (cancelled first).
 */
export type MediaStartDecision =
  | { kind: "exists" }
  | { kind: "advance"; generationId: string }
  | { kind: "timeout"; generationId: string }
  | { kind: "start_after_timeout"; generationId: string; token: "fresh" | string }
  | { kind: "start"; token: "stable" | "fresh" | string; retireGenerationId: string | null };

/**
 * `explicit` is the user's click. It is the ONLY thing that can turn a
 * timed-out generation into a new paid one: viewing, polling, the rolling-plan
 * run and any other automatic path leave it terminal.
 */
export function decideMediaStart(input: {
  contentType: ContentType;
  latest: LatestGeneration | null;
  hasAsset: boolean;
  explicitToken?: string;
  explicit?: boolean;
  now?: Date;
  staleMinutes?: number;
}): MediaStartDecision {
  const now = input.now ?? new Date();
  const latest = input.latest;
  const explicit = input.explicit === true || Boolean(input.explicitToken);
  // The hard timeout is the asynchronous VIDEO job rule; images are
  // synchronous and keep their existing dead-attempt handling.
  const videoJob = input.contentType === "reel" && (latest?.mediaType ?? "video") !== "image";

  if (latest && isActiveMediaStatus(latest.status)) {
    // A generation is genuinely in flight.
    if (!isStaleMediaGeneration(latest.status, latest.updatedAt, now, input.staleMinutes)) {
      return { kind: "exists" };
    }
    if (mustStopVideoJob(latest, input.contentType, now, input.staleMinutes)) {
      // Beyond the hard timeout this job can never complete. It is stopped;
      // only an explicit click may then pay for a new generation.
      return explicit
        ? { kind: "start_after_timeout", generationId: latest.id, token: input.explicitToken ?? "fresh" }
        : { kind: "timeout", generationId: latest.id };
    }
    if (videoJob) {
      // Stale but still inside the hard timeout: the provider job may be alive
      // (OpenRouter pending). Re-check it — never submit a second paid job.
      return { kind: "advance", generationId: latest.id };
    }
    // A stale image row is a dead synchronous attempt: the explicit retry
    // retires it and starts one fresh attempt.
    return { kind: "start", token: "fresh", retireGenerationId: latest.id };
  }

  // No in-flight generation.
  if (input.explicitToken) return { kind: "start", token: input.explicitToken, retireGenerationId: null };
  // A timed-out generation is terminal work only the USER may repeat: nothing
  // automatic ever silently submits a fresh paid generation for it.
  if (videoJob && !explicit && isTimedOutGeneration(latest)) return { kind: "exists" };
  if (input.contentType !== "reel") return { kind: "start", token: "fresh", retireGenerationId: null };
  // Video, no explicit token:
  if (!latest) return { kind: "start", token: "stable", retireGenerationId: null };
  // A stored asset already satisfies a plain retry — only an explicit
  // "Regenerate" (fresh token) may pay for a second generation.
  if (latest.status === "completed" && input.hasAsset) return { kind: "exists" };
  // An explicit retry after a TERMINAL TIMEOUT: the timed-out row is stopped
  // (if it is not already) and exactly one fresh generation is submitted.
  if (videoJob && explicit && isTimedOutGeneration(latest)) {
    return { kind: "start_after_timeout", generationId: latest.id, token: "fresh" };
  }
  // The latest attempt is finished (failed / cancelled / orphaned completed):
  // an explicit retry is a NEW attempt — a fresh identity, never a duplicate
  // of anything still running.
  return { kind: "start", token: "fresh", retireGenerationId: null };
}

/**
 * True when an in-flight video generation is stale AND beyond the durable
 * job's hard timeout — the one condition under which Voom stops a job instead
 * of waiting on it. Both the explicit retry path and the automatic path use
 * this same predicate, so they can never disagree.
 */
export function mustStopVideoJob(
  latest: LatestGeneration | null,
  contentType: ContentType,
  now: Date,
  staleMinutes?: number,
): boolean {
  if (!latest || !isActiveMediaStatus(latest.status)) return false;
  // The hard timeout is the asynchronous VIDEO job rule.
  if (contentType !== "reel" || latest.mediaType === "image") return false;
  if (!isStaleMediaGeneration(latest.status, latest.updatedAt, now, staleMinutes)) return false;
  return videoJobDecision(latest, now) === "timeout";
}

/** The durable job's own lifetime rule for one generation row. */
function videoJobDecision(latest: LatestGeneration, now: Date): "timeout" | "reclaim" | "ok" {
  const nowMs = now.getTime();
  return staleDecision(latest.status, {
    nowMs,
    // Missing/invalid timestamps age the job zero seconds: never a timeout
    // decision on bad data.
    createdAtMs: parseInstantOr(latest.createdAt ?? latest.updatedAt, nowMs),
    updatedAtMs: parseInstantOr(latest.updatedAt ?? latest.createdAt, nowMs),
  });
}

function parseInstantOr(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : fallback;
}

/** Resolves the decision's token kind into the durable idempotency token. */
export function resolveGenerationToken(token: string | "stable" | "fresh", draftId: string): string {
  if (token === "stable") return `workflow-${draftId}`;
  if (token === "fresh") return `workflow-${draftId}:${randomUUID()}`;
  return token;
}

/** The newest generation row for a draft (any media type), owner-scoped. */
export async function getLatestGeneration(admin: AdminClient, ownerId: string, draftId: string): Promise<LatestGeneration | null> {
  const { data } = await admin.from("mara_media_generations")
    .select("id,status,media_type,error_code,created_at,updated_at")
    .eq("owner_user_id", ownerId).eq("draft_id", draftId)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  return {
    id: String(data.id),
    status: String(data.status),
    mediaType: typeof data.media_type === "string" ? data.media_type : null,
    errorCode: typeof data.error_code === "string" ? data.error_code : null,
    createdAt: typeof data.created_at === "string" ? data.created_at : null,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}

async function hasStoredAsset(admin: AdminClient, ownerId: string, draftId: string): Promise<boolean> {
  const { data } = await admin.from("post_draft_assets").select("id").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  return Boolean(data?.id);
}

/**
 * True when the AUTOMATIC path (the rolling-plan run) must leave this draft's
 * media alone: Voom already owns the bytes, a generation is still in flight,
 * or the latest video generation ended in a hard timeout. After a timeout only
 * an explicit user click ("Retry as new generation") may pay for a new job —
 * automation never repeats a paid generation by itself.
 */
export function blocksAutomaticMedia(input: {
  hasAsset: boolean;
  hasActiveGeneration: boolean;
  latest: LatestGeneration | null;
}): boolean {
  if (input.hasAsset || input.hasActiveGeneration) return true;
  return isTimedOutGeneration(input.latest);
}

/** True when the draft already owns stored bytes, has a live generation, or timed out. */
export async function mediaAlreadyHandled(admin: AdminClient, ownerId: string, draftId: string): Promise<boolean> {
  const [{ data: asset }, { data: live }, latest] = await Promise.all([
    admin.from("post_draft_assets").select("id").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle(),
    admin.from("mara_media_generations").select("id")
      .eq("owner_user_id", ownerId).eq("draft_id", draftId).in("status", ["queued", "generating", "processing"]).limit(1).maybeSingle(),
    getLatestGeneration(admin, ownerId, draftId),
  ]);
  return blocksAutomaticMedia({ hasAsset: Boolean(asset?.id), hasActiveGeneration: Boolean(live?.id), latest });
}

/**
 * The video-side effects of this module, behind one seam so the money-critical
 * policy is exercised with fakes (no OpenRouter call, no paid generation) —
 * the same ports pattern the durable video job service and the Instagram
 * publish flow already use. Production always uses `defaultWorkflowVideoDeps`.
 */
export interface WorkflowVideoDeps {
  /** Re-checks ONE existing durable job. Never submits a provider job. */
  advance(admin: AdminClient, ownerId: string, draftId: string, generationId: string): Promise<"advanced" | "unavailable">;
  /** Persists the hard-timeout terminal state: a database write, no provider call. */
  enforceTimeout(admin: AdminClient, ownerId: string, generationId: string, now: Date): Promise<{ enforced: boolean }>;
  /** The ONLY path that may submit a new paid provider job. */
  startVideo(args: PostStudioVideoStartArgs): Promise<PostStudioVideoStartResult>;
}

export const defaultWorkflowVideoDeps: WorkflowVideoDeps = {
  async advance(admin, ownerId, draftId, generationId) {
    const service = await buildVideoService(admin, ownerId);
    // No provider stack means there is nothing to poll. The hard timeout does
    // NOT depend on this stack (see enforceTimeout), so a job can never stay
    // stuck in flight just because the provider is unconfigured.
    if (!service) return "unavailable";
    await advanceVideoJob(service, draftId, generationId, "reel").catch(() => null);
    return "advanced";
  },
  async enforceTimeout(admin, ownerId, generationId, now) {
    const result = await enforceVideoJobHardTimeout(admin, ownerId, generationId, { now: now.getTime() });
    return { enforced: result.enforced };
  },
  startVideo: startPostStudioVideo,
};

/**
 * The AUTOMATIC media path (the rolling-plan run / a plan rebuild).
 *
 * It never submits a provider job for anything already in flight, and it never
 * repeats a timed-out generation — but it DOES stop a job that is beyond its
 * hard timeout, because leaving it 'generating' forever is exactly the
 * production bug. Stopping is a guarded database write: no provider call, no
 * new job, no charge. Only an explicit user click can then start a new one.
 */
export async function ensureWorkflowMedia(
  admin: AdminClient,
  request: MediaRequest,
  options: { now?: Date; deps?: Partial<WorkflowVideoDeps> } = {},
): Promise<MediaOutcome> {
  const now = options.now ?? new Date();
  const deps: WorkflowVideoDeps = { ...defaultWorkflowVideoDeps, ...options.deps };
  const latest = await getLatestGeneration(admin, request.ownerId, request.draftId);
  // A job beyond its hard timeout is stopped even here, so it cannot stay
  // 'generating' forever. This submits nothing: no provider call, no charge.
  if (latest && mustStopVideoJob(latest, request.contentType, now)) {
    return stopTimedOutGeneration(admin, request.ownerId, latest.id, now, deps);
  }
  if (await mediaAlreadyHandled(admin, request.ownerId, request.draftId)) return { ok: true, state: "exists" };
  return produceWorkflowMedia(admin, request, { now, deps });
}

/**
 * Persists the terminal timeout state of one dead video job. Database write
 * only — this is the whole reason a job beyond its hard timeout can no longer
 * stay 'generating/pending' indefinitely.
 */
async function stopTimedOutGeneration(
  admin: AdminClient,
  ownerId: string,
  generationId: string,
  now: Date,
  deps: WorkflowVideoDeps,
): Promise<MediaOutcome> {
  await deps.enforceTimeout(admin, ownerId, generationId, now).catch(() => ({ enforced: false }));
  return { ok: true, state: "timed_out" };
}

/**
 * Produces media for one workflow item WITHOUT the "already handled" guard.
 *
 * Used by the in-place Marketing Plan actions ("Create with MARA" /
 * "Regenerate" / "Retry generation" / "Retry as new generation") so a user can
 * (re)generate the visual of the SAME workflow item on demand. The
 * duplicate-charge policy lives in `decideMediaStart` (see module docs):
 * nothing starts unless the policy says so, a repeated click while a
 * generation is in flight is a no-op, and a job beyond its hard timeout is
 * stopped instead of being left `generating` forever.
 *
 * `options.explicit` is the user's click. Without it a timed-out generation is
 * only ever stopped — never replaced by a new paid one.
 */
export async function produceWorkflowMedia(
  admin: AdminClient,
  request: MediaRequest,
  options: { idempotencyToken?: string; explicit?: boolean; now?: Date; deps?: Partial<WorkflowVideoDeps> } = {},
): Promise<MediaOutcome> {
  const now = options.now ?? new Date();
  const deps: WorkflowVideoDeps = { ...defaultWorkflowVideoDeps, ...options.deps };
  const [latest, hasAsset] = await Promise.all([
    getLatestGeneration(admin, request.ownerId, request.draftId),
    hasStoredAsset(admin, request.ownerId, request.draftId),
  ]);
  const decision = decideMediaStart({
    contentType: request.contentType,
    latest,
    hasAsset,
    explicitToken: options.idempotencyToken,
    explicit: options.explicit,
    now,
  });

  if (decision.kind === "exists") return { ok: true, state: "exists" };

  if (decision.kind === "advance") {
    // Stale but INSIDE the hard timeout: re-check the SAME durable job. This
    // either completes it (asset attached + held schedule re-synced) or keeps
    // waiting on the provider. No second provider job is ever submitted here,
    // so the outcome never claims a new generation was started.
    const advanced = await deps.advance(admin, request.ownerId, request.draftId, decision.generationId)
      .catch(() => "unavailable" as const);
    // Without the provider stack there was nothing to re-check: say so instead
    // of implying a poll happened. Still nothing started and nothing charged.
    if (advanced === "unavailable") return { ok: false, code: "video_provider_unavailable" };
    return { ok: true, state: "advanced" };
  }

  if (decision.kind === "timeout") {
    // Beyond the hard timeout: persist the terminal state — a guarded database
    // write only, no provider call, no new job, no charge.
    return stopTimedOutGeneration(admin, request.ownerId, decision.generationId, now, deps);
  }

  if (decision.kind === "start_after_timeout") {
    // The explicit "Retry as new generation": the dead job is stopped FIRST
    // (it keeps its provider job id as history), then exactly one fresh
    // generation may be submitted below.
    await stopTimedOutGeneration(admin, request.ownerId, decision.generationId, now, deps);
  }

  if (decision.kind === "start" && decision.retireGenerationId) {
    // Retire the dead synchronous attempt the explicit retry replaces.
    try {
      await admin.from("mara_media_generations")
        .update({ status: "cancelled", error_code: "superseded_by_retry" })
        .eq("id", decision.retireGenerationId).eq("owner_user_id", request.ownerId)
        .eq("status", "processing");
    } catch { /* best effort — the fresh attempt below is the real state */ }
  }

  if (request.contentType === "reel") {
    const result = await deps.startVideo({
      admin,
      ownerId: request.ownerId,
      post: { id: request.draftId, kind: "reel", conversationId: request.conversationId, concept: request.concept },
      brief: request.visualBrief,
      idempotencyToken: resolveGenerationToken(decision.token, request.draftId),
    });
    if ("error" in result) {
      // 409 is the one-active-job guard refusing a second job: a repeated or
      // racing click is a no-op, not a failure, and nothing was charged.
      return { ok: false, code: result.status === 409 ? "video_start_conflict" : "video_start_failed" };
    }
    return { ok: true, state: result.status === 202 ? "queued" : "exists" };
  }

  const outcome = await generateWorkflowImage(admin, request);
  // The visual arriving late must re-sync an approved item's schedule: the
  // queue row moves from 'waiting_for_media' to 'scheduled' and the worker
  // publishes it — the item never silently dies waiting for media.
  if (outcome.ok) await syncPostToCalendar(admin, request.ownerId, request.draftId).catch(() => null);
  return outcome;
}


/** Image generation through the existing provider abstraction. */
async function generateWorkflowImage(admin: AdminClient, request: MediaRequest): Promise<MediaOutcome> {
  const format = request.contentType === "story" ? "9:16" : "1:1";
  const prompt = buildVisualPrompt(request);
  const generationId = randomUUID();
  const { error: queueError } = await admin.from("mara_media_generations").insert({
    id: generationId,
    owner_user_id: request.ownerId,
    conversation_id: request.conversationId,
    draft_id: request.draftId,
    media_type: "image",
    prompt: prompt.slice(0, 4000),
    aspect_ratio: format,
    status: "processing",
    // One generation identity per draft per attempt keeps the existing unique
    // (owner, idempotency_key) guard meaningful.
    idempotency_key: `workflow:${request.draftId}:${generationId}`,
  });
  if (queueError) return { ok: false, code: "media_job_failed" };

  try {
    const config = getMediaConfig();
    const result = await createMediaProvider(config).generateImage({ prompt, aspectRatio: format });
    if (!result.bytes.length || result.bytes.length > GENERATED_IMAGE_MAX_BYTES) throw new MediaError("malformed_response");
    const inspected = inspectImageBytes(result.bytes);
    if (!inspected || !aspectMatches(inspected.width, inspected.height, format)) throw new MediaError("malformed_response");

    const mimeType = inspected.mimeType;
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const { storagePath, previousStoragePath } = await putPostAsset(admin, request.ownerId, request.draftId, {
      bytes: result.bytes,
      mimeType,
      extension,
      displayName: `MARA visual · ${request.concept.slice(0, 60)}`,
      origin: "mara",
    });
    await admin.from("mara_media_generations").update({
      provider: config.provider, storage_path: storagePath, mime_type: mimeType,
      byte_size: result.bytes.length, status: "completed", completed_at: new Date().toISOString(), error_code: null,
    }).eq("id", generationId).eq("owner_user_id", request.ownerId);
    if (previousStoragePath && previousStoragePath !== storagePath) {
      await removePostAssetObject(admin, request.ownerId, previousStoragePath).catch(() => undefined);
    }
    return { ok: true, state: "completed" };
  } catch (reason) {
    const code = reason instanceof MediaError ? reason.code : "unavailable";
    await admin.from("mara_media_generations").update({
      status: "failed", error_code: code,
      provider_diagnostic: reason instanceof MediaError ? reason.diagnostic : null,
    }).eq("id", generationId).eq("owner_user_id", request.ownerId);
    return { ok: false, code };
  }
}

/**
 * The visual brief MARA wrote for this planned item becomes the provider
 * prompt. Readable text, logos and watermarks are never requested, matching
 * the existing Post Studio prompt rules.
 */
export function buildVisualPrompt(request: MediaRequest): string {
  const surface = request.contentType === "story" ? "9:16 full-screen Instagram Story frame" : "clean, brandable Instagram feed image";
  return [
    `${surface} for the concept "${request.concept}".`,
    request.visualBrief,
    "Photographic, natural light, no readable text, no logos, no watermarks, no real identifiable people.",
  ].filter(Boolean).join(" ").slice(0, 1200);
}
