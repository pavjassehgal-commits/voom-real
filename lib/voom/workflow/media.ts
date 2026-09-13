import "server-only";

import { randomUUID } from "node:crypto";
import { createMediaProvider, getMediaConfig, MediaError } from "@/lib/media";
import { aspectMatches, inspectImageBytes } from "@/lib/media/media-inspect";
import { putPostAsset, removePostAssetObject, syncPostToCalendar, type AdminClient } from "@/lib/post/server-data";
import { advanceVideoJob, buildVideoService, startPostStudioVideo } from "@/lib/mara/video-service";
import { isActiveMediaStatus, isStaleMediaGeneration } from "./state";
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
 *   - a STALE in-flight VIDEO job is re-advanced (polled) instead of
 *     replaced: the provider job may still be running, so a second one is
 *     never submitted; the job self-times-out at its hard limit, after which
 *     an explicit retry is a fresh attempt,
 *   - a STALE in-flight IMAGE row is a dead synchronous attempt: the explicit
 *     retry retires it (cancelled) and starts exactly one fresh attempt,
 *   - video retries after a FINISHED attempt get a fresh token only because
 *     the finished row can never complete; a first run keeps the stable
 *     per-draft token, so repeated clicks resolve to the same job,
 *   - the database keeps the final guard: one active generation per
 *     (owner, draft) partial unique index.
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

export type MediaOutcome = { ok: true; state: "exists" | "queued" | "completed" } | { ok: false; code: string };

/** The latest generation row for a draft (any media type, any status). */
export interface LatestGeneration {
  id: string;
  status: string;
  updatedAt: string | null;
}

/**
 * The one explicit/idempotent media start policy (pure — unit tested).
 *
 *   exists  — something already owns this item's visual (a stored asset or a
 *             fresh in-flight generation): do NOTHING. This is what makes a
 *             repeated retry click a no-op instead of a second charge.
 *   advance — a STALE in-flight video job: re-poll the SAME job. No second
 *             provider job is ever submitted for an in-flight one.
 *   start   — actually (re)start. `token` decides the paid identity:
 *             "stable"  = the per-draft token (first runs; repeats resolve
 *                          to the same job),
 *             "fresh"   = a brand-new token (an explicit retry after a
 *                          FINISHED attempt — the old row is terminal and
 *                          can never complete, so nothing is duplicated),
 *             <string>  = an explicit caller token (e.g. "Regenerate").
 *             `retireGenerationId` = a dead synchronous attempt that the
 *             explicit retry replaces (cancelled first).
 */
export type MediaStartDecision =
  | { kind: "exists" }
  | { kind: "advance"; generationId: string }
  | { kind: "start"; token: "stable" | "fresh" | string; retireGenerationId: string | null };

export function decideMediaStart(input: {
  contentType: ContentType;
  latest: LatestGeneration | null;
  hasAsset: boolean;
  explicitToken?: string;
  now?: Date;
  staleMinutes?: number;
}): MediaStartDecision {
  const now = input.now ?? new Date();
  const latest = input.latest;

  if (latest && isActiveMediaStatus(latest.status)) {
    // A generation is genuinely in flight.
    if (!isStaleMediaGeneration(latest.status, latest.updatedAt, now, input.staleMinutes)) {
      return { kind: "exists" };
    }
    if (input.contentType === "reel") {
      // Stale but in flight: the provider job may still be alive (OpenRouter
      // pending). Re-advance it — never submit a second paid job.
      return { kind: "advance", generationId: latest.id };
    }
    // A stale image row is a dead synchronous attempt: the explicit retry
    // retires it and starts one fresh attempt.
    return { kind: "start", token: "fresh", retireGenerationId: latest.id };
  }

  // No in-flight generation.
  if (input.explicitToken) return { kind: "start", token: input.explicitToken, retireGenerationId: null };
  if (input.contentType !== "reel") return { kind: "start", token: "fresh", retireGenerationId: null };
  // Video, no explicit token:
  if (!latest) return { kind: "start", token: "stable", retireGenerationId: null };
  // A stored asset already satisfies a plain retry — only an explicit
  // "Regenerate" (fresh token) may pay for a second generation.
  if (latest.status === "completed" && input.hasAsset) return { kind: "exists" };
  // The latest attempt is finished (failed / cancelled / orphaned completed):
  // an explicit retry is a NEW attempt — a fresh identity, never a duplicate
  // of anything still running.
  return { kind: "start", token: "fresh", retireGenerationId: null };
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
    .select("id,status,updated_at")
    .eq("owner_user_id", ownerId).eq("draft_id", draftId)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  return {
    id: String(data.id),
    status: String(data.status),
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}

async function hasStoredAsset(admin: AdminClient, ownerId: string, draftId: string): Promise<boolean> {
  const { data } = await admin.from("post_draft_assets").select("id").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  return Boolean(data?.id);
}

/** True when the draft already owns stored bytes or has a live generation. */
export async function mediaAlreadyHandled(admin: AdminClient, ownerId: string, draftId: string): Promise<boolean> {
  const [{ data: asset }, { data: live }] = await Promise.all([
    admin.from("post_draft_assets").select("id").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle(),
    admin.from("mara_media_generations").select("id")
      .eq("owner_user_id", ownerId).eq("draft_id", draftId).in("status", ["queued", "generating", "processing"]).limit(1).maybeSingle(),
  ]);
  return Boolean(asset?.id || live?.id);
}

export async function ensureWorkflowMedia(admin: AdminClient, request: MediaRequest): Promise<MediaOutcome> {
  if (await mediaAlreadyHandled(admin, request.ownerId, request.draftId)) return { ok: true, state: "exists" };
  return produceWorkflowMedia(admin, request);
}

/**
 * Produces media for one workflow item WITHOUT the "already handled" guard.
 *
 * Used by the in-place Marketing Plan actions ("Create with MARA" /
 * "Regenerate" / "Retry generation") so a user can (re)generate the visual of
 * the SAME workflow item on demand. The duplicate-charge policy lives in
 * `decideMediaStart` (see module docs): nothing starts unless the policy
 * says so, and a repeated click while a generation is in flight is a no-op.
 */
export async function produceWorkflowMedia(
  admin: AdminClient,
  request: MediaRequest,
  options: { idempotencyToken?: string; now?: Date } = {},
): Promise<MediaOutcome> {
  const [latest, hasAsset] = await Promise.all([
    getLatestGeneration(admin, request.ownerId, request.draftId),
    hasStoredAsset(admin, request.ownerId, request.draftId),
  ]);
  const decision = decideMediaStart({
    contentType: request.contentType,
    latest,
    hasAsset,
    explicitToken: options.idempotencyToken,
    now: options.now,
  });

  if (decision.kind === "exists") return { ok: true, state: "exists" };

  if (decision.kind === "advance") {
    // A stale in-flight video job: re-poll the SAME durable job. This either
    // completes it (asset attached + held schedule re-synced) or lets it
    // self-time-out to failed — after which the next explicit retry is a
    // fresh attempt. No second provider job is ever submitted here.
    const service = await buildVideoService(admin, request.ownerId);
    if (service) {
      await advanceVideoJob(service, request.draftId, decision.generationId, "reel").catch(() => null);
    }
    return { ok: true, state: "queued" };
  }

  if (decision.retireGenerationId) {
    // Retire the dead synchronous attempt the explicit retry replaces.
    try {
      await admin.from("mara_media_generations")
        .update({ status: "cancelled", error_code: "superseded_by_retry" })
        .eq("id", decision.retireGenerationId).eq("owner_user_id", request.ownerId)
        .eq("status", "processing");
    } catch { /* best effort — the fresh attempt below is the real state */ }
  }

  if (request.contentType === "reel") {
    const result = await startPostStudioVideo({
      admin,
      ownerId: request.ownerId,
      post: { id: request.draftId, kind: "reel", conversationId: request.conversationId, concept: request.concept },
      brief: request.visualBrief,
      idempotencyToken: resolveGenerationToken(decision.token, request.draftId),
    });
    if ("error" in result) return { ok: false, code: "video_start_failed" };
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
