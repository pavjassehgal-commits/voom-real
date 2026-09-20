import "server-only";

import { randomUUID } from "node:crypto";
import { createMediaProvider, getMediaConfig, MediaError } from "@/lib/media";
import { aspectMatches, inspectImageBytes } from "@/lib/media/media-inspect";
import { putPostAsset, removePostAssetObject, syncPostToCalendar, type AdminClient } from "@/lib/post/server-data";
import { advanceVideoJob, buildVideoService, enforceVideoJobHardTimeout, startPostStudioVideo } from "@/lib/mara/video-service";
import type { PostStudioVideoStartArgs, PostStudioVideoStartResult } from "@/lib/mara/video-service";
import { isTimedOutVideoGeneration, staleDecision } from "@/lib/mara/video-job";
import type { MediaSource } from "@/lib/mara/media-spend";
import { isActiveMediaStatus, isStaleMediaGeneration, MEDIA_GENERATION_HARD_TIMEOUT_MINUTES } from "./state";
import type { ContentType } from "@/lib/voom/cadence";
import { normalizePlan, type PlanId } from "@/lib/billing/plans";
import { creditCostForMedia } from "@/lib/billing/credits";
import { guardAndReserveMedia, releaseReservationOnFailure, confirmReservation } from "@/lib/billing/entitlement-guard";
import { normalizeAllowAutomaticPaidMedia, estimateMediaCostUsd } from "@/lib/mara/media-spend";

/**
 * Media generation for one workflow item, reusing the EXISTING durable MARA
 * media systems only.
 *
 * V1 Plans + Credits guarantees:
 * - Reservation before provider submission (never call Seedream/Seedance first and deduct later)
 * - Atomic reservation prevents concurrent overspend
 * - Refund on provider failure before real paid job
 * - No double-charge via unique generation_id
 * - Polling/reconciliation consumes zero additional credits
 * - Manual and Assisted never auto-generate paid media (deliberate product change)
 * - Autopilot auto-generates only if plan=Max, toggle true, enough credits, safety allows
 */

const GENERATED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface MediaRequest {
  ownerId: string;
  draftId: string;
  conversationId: string;
  contentType: ContentType;
  concept: string;
  visualBrief: string;
  mode?: "manual" | "assisted" | "autopilot";
  /** Optional billing context to avoid extra DB read in tests. */
  planId?: PlanId;
  allowAutomaticPaidMedia?: boolean;
}

export type MediaOutcomeState = "exists" | "advanced" | "timed_out" | "queued" | "completed";
export type MediaOutcome = { ok: true; state: MediaOutcomeState } | { ok: false; code: string };

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

export interface LatestGeneration {
  id: string;
  status: string;
  mediaType: string | null;
  errorCode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function isTimedOutGeneration(latest: LatestGeneration | null): boolean {
  if (!latest) return false;
  if (latest.mediaType === "image") return false;
  return isTimedOutVideoGeneration(latest.status, latest.errorCode ?? null);
}

export type MediaStartDecision =
  | { kind: "exists" }
  | { kind: "advance"; generationId: string }
  | { kind: "timeout"; generationId: string }
  | { kind: "start_after_timeout"; generationId: string; token: "fresh" | string }
  | { kind: "start"; token: "stable" | "fresh" | string; retireGenerationId: string | null };

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
  const videoJob = input.contentType === "reel" && (latest?.mediaType ?? "video") !== "image";

  if (latest && isActiveMediaStatus(latest.status)) {
    if (!isStaleMediaGeneration(latest.status, latest.updatedAt, now, input.staleMinutes)) {
      return { kind: "exists" };
    }
    if (mustStopVideoJob(latest, input.contentType, now, input.staleMinutes)) {
      return explicit
        ? { kind: "start_after_timeout", generationId: latest.id, token: input.explicitToken ?? "fresh" }
        : { kind: "timeout", generationId: latest.id };
    }
    if (videoJob) {
      return { kind: "advance", generationId: latest.id };
    }
    return { kind: "start", token: "fresh", retireGenerationId: latest.id };
  }

  if (input.explicitToken) return { kind: "start", token: input.explicitToken, retireGenerationId: null };
  if (videoJob && !explicit && isTimedOutGeneration(latest)) return { kind: "exists" };
  if (input.contentType !== "reel") return { kind: "start", token: "fresh", retireGenerationId: null };
  if (!latest) return { kind: "start", token: "stable", retireGenerationId: null };
  if (latest.status === "completed" && input.hasAsset) return { kind: "exists" };
  if (videoJob && explicit && isTimedOutGeneration(latest)) {
    return { kind: "start_after_timeout", generationId: latest.id, token: "fresh" };
  }
  return { kind: "start", token: "fresh", retireGenerationId: null };
}

export function mustStopVideoJob(
  latest: LatestGeneration | null,
  contentType: ContentType,
  now: Date,
  staleMinutes?: number,
): boolean {
  if (!latest || !isActiveMediaStatus(latest.status)) return false;
  if (contentType !== "reel" || latest.mediaType === "image") return false;
  if (!isStaleMediaGeneration(latest.status, latest.updatedAt, now, staleMinutes)) return false;
  return videoJobDecision(latest, now) === "timeout";
}

function videoJobDecision(latest: LatestGeneration, now: Date): "timeout" | "reclaim" | "ok" {
  const nowMs = now.getTime();
  return staleDecision(latest.status, {
    nowMs,
    createdAtMs: parseInstantOr(latest.createdAt ?? latest.updatedAt, nowMs),
    updatedAtMs: parseInstantOr(latest.updatedAt ?? latest.createdAt, nowMs),
  });
}

function parseInstantOr(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : fallback;
}

export function resolveGenerationToken(token: string | "stable" | "fresh", draftId: string): string {
  if (token === "stable") return `workflow-${draftId}`;
  if (token === "fresh") return `workflow-${draftId}:${randomUUID()}`;
  return token;
}

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

export function blocksAutomaticMedia(input: {
  hasAsset: boolean;
  hasActiveGeneration: boolean;
  latest: LatestGeneration | null;
}): boolean {
  if (input.hasAsset || input.hasActiveGeneration) return true;
  return isTimedOutGeneration(input.latest);
}

export async function mediaAlreadyHandled(admin: AdminClient, ownerId: string, draftId: string): Promise<boolean> {
  const [{ data: asset }, { data: live }, latest] = await Promise.all([
    admin.from("post_draft_assets").select("id").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle(),
    admin.from("mara_media_generations").select("id")
      .eq("owner_user_id", ownerId).eq("draft_id", draftId).in("status", ["queued", "generating", "processing"]).limit(1).maybeSingle(),
    getLatestGeneration(admin, ownerId, draftId),
  ]);
  return blocksAutomaticMedia({ hasAsset: Boolean(asset?.id), hasActiveGeneration: Boolean(live?.id), latest });
}

export interface WorkflowMediaDeps {
  advance(admin: AdminClient, ownerId: string, draftId: string, generationId: string): Promise<"advanced" | "unavailable">;
  enforceTimeout(admin: AdminClient, ownerId: string, generationId: string, now: Date): Promise<{ enforced: boolean }>;
  startVideo(args: PostStudioVideoStartArgs): Promise<PostStudioVideoStartResult>;
  generateImage(input: { prompt: string; aspectRatio: "1:1" | "9:16" }): Promise<{ provider: string; bytes: Uint8Array }>;
}

export const defaultWorkflowMediaDeps: WorkflowMediaDeps = {
  async generateImage(input) {
    const config = getMediaConfig();
    const result = await createMediaProvider(config).generateImage({ prompt: input.prompt, aspectRatio: input.aspectRatio });
    return { provider: config.provider, bytes: result.bytes };
  },
  async advance(admin, ownerId, draftId, generationId) {
    const service = await buildVideoService(admin, ownerId);
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

export async function ensureWorkflowMedia(
  admin: AdminClient,
  request: MediaRequest,
  options: { now?: Date; deps?: Partial<WorkflowMediaDeps> } = {},
): Promise<MediaOutcome> {
  const now = options.now ?? new Date();
  const deps: WorkflowMediaDeps = { ...defaultWorkflowMediaDeps, ...options.deps };
  const latest = await getLatestGeneration(admin, request.ownerId, request.draftId);
  if (latest && mustStopVideoJob(latest, request.contentType, now)) {
    return stopTimedOutGeneration(admin, request.ownerId, latest.id, now, deps);
  }
  if (await mediaAlreadyHandled(admin, request.ownerId, request.draftId)) return { ok: true, state: "exists" };
  return produceWorkflowMedia(admin, request, { now, deps });
}

async function stopTimedOutGeneration(
  admin: AdminClient,
  ownerId: string,
  generationId: string,
  now: Date,
  deps: WorkflowMediaDeps,
): Promise<MediaOutcome> {
  await deps.enforceTimeout(admin, ownerId, generationId, now).catch(() => ({ enforced: false }));
  return { ok: true, state: "timed_out" };
}

async function loadBusinessBilling(admin: AdminClient, ownerId: string): Promise<{ planId: PlanId; allowAutomatic: boolean }> {
  try {
    const { data } = await admin.from("businesses").select("plan,allow_automatic_paid_media").eq("owner_user_id", ownerId).maybeSingle();
    const planId = normalizePlan((data as any)?.plan);
    const allowAutomatic = normalizeAllowAutomaticPaidMedia((data as any)?.allow_automatic_paid_media);
    return { planId, allowAutomatic };
  } catch {
    return { planId: "free", allowAutomatic: false };
  }
}

export async function produceWorkflowMedia(
  admin: AdminClient,
  request: MediaRequest,
  options: {
    idempotencyToken?: string;
    explicit?: boolean;
    mode?: "manual" | "assisted" | "autopilot";
    now?: Date;
    deps?: Partial<WorkflowMediaDeps>;
  } = {},
): Promise<MediaOutcome> {
  const now = options.now ?? new Date();
  const deps: WorkflowMediaDeps = { ...defaultWorkflowMediaDeps, ...options.deps };
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
    const advanced = await deps.advance(admin, request.ownerId, request.draftId, decision.generationId)
      .catch(() => "unavailable" as const);
    if (advanced === "unavailable") return { ok: false, code: "video_provider_unavailable" };
    return { ok: true, state: "advanced" };
  }

  if (decision.kind === "timeout") {
    return stopTimedOutGeneration(admin, request.ownerId, decision.generationId, now, deps);
  }

  // Billing context: prefer explicit passed in request, else load from DB
  const billing = request.planId !== undefined && request.allowAutomaticPaidMedia !== undefined
    ? { planId: request.planId, allowAutomatic: request.allowAutomaticPaidMedia }
    : await loadBusinessBilling(admin, request.ownerId);

  const mode = options.mode ?? request.mode ?? "assisted";
  const isExplicit = options.explicit === true;
  const mediaType = request.contentType === "reel" ? "video" : "image";
  const source = isExplicit ? "user_request" : (mode === "autopilot" ? "autopilot" : "user_request" as const);
  // For automatic path, source is autopilot only if mode is autopilot and not explicit
  const effectiveSource = isExplicit ? "user_request" : "autopilot";

  // For automatic (non-explicit) we must be in autopilot mode per new product rules
  if (!isExplicit && mode !== "autopilot") {
    return { ok: false, code: "automatic_media_disabled" };
  }

  const generationIdForLedger = randomUUID();
  const requiredCredits = creditCostForMedia({ mediaType, durationSeconds: mediaType === "video" ? 8 : null });

  // Central guard + atomic reservation BEFORE provider
  const guard = await guardAndReserveMedia(admin, {
    ownerId: request.ownerId,
    planId: billing.planId,
    mode,
    allowAutomaticPaidMedia: billing.allowAutomatic,
    mediaType,
    durationSeconds: mediaType === "video" ? 8 : null,
    source: effectiveSource as any,
    generationId: generationIdForLedger,
    now,
  });

  if (!guard.allow) {
    // Map guard codes to legacy block reasons for workflow failures
    const codeMap: Record<string, string> = {
      plan_not_allowed: "plan_not_allowed",
      mode_not_allowed: "automatic_media_disabled",
      automatic_disabled: "automatic_media_disabled",
      insufficient_credits: "insufficient_credits",
      safety_blocked: "safety_blocked",
      autopilot_not_allowed: "autopilot_not_allowed",
    };
    return { ok: false, code: codeMap[guard.code] ?? guard.code };
  }

  // If already reserved (idempotent), treat as exists — no second provider call
  if (guard.reservation.already) {
    return { ok: true, state: "exists" };
  }

  if (decision.kind === "start_after_timeout") {
    await stopTimedOutGeneration(admin, request.ownerId, decision.generationId, now, deps);
  }

  if (decision.kind === "start" && decision.retireGenerationId) {
    try {
      await admin.from("mara_media_generations")
        .update({ status: "cancelled", error_code: "superseded_by_retry" })
        .eq("id", decision.retireGenerationId).eq("owner_user_id", request.ownerId)
        .eq("status", "processing");
    } catch { /* best effort */ }
  }

  if (request.contentType === "reel") {
    // For video, we already reserved with generationIdForLedger. Pass same id to startVideo
    // so its internal guard uses same ledger row and does not double-charge.
    let result: PostStudioVideoStartResult;
    try {
      result = await deps.startVideo({
        admin,
        ownerId: request.ownerId,
        post: { id: request.draftId, kind: "reel", conversationId: request.conversationId, concept: request.concept },
        brief: request.visualBrief,
        idempotencyToken: resolveGenerationToken(decision.token, request.draftId),
        source: isExplicit ? "user_request" : "autopilot",
        generationId: generationIdForLedger,
      });
    } catch {
      await releaseReservationOnFailure(admin, request.ownerId, generationIdForLedger).catch(() => null);
      return { ok: false, code: "video_start_failed" };
    }

    if ("error" in result) {
      // No job was started under THIS call's ledger identity — including on a
      // 409, where the active job (and its own reservation) belongs to a
      // different generation id — so the reservation taken above must be
      // released, or the losing click of a race would keep credits charged for
      // a video that never existed. The refund RPC is idempotent, so this is a
      // no-op when the video orchestrator already refunded at insert time.
      await releaseReservationOnFailure(admin, request.ownerId, generationIdForLedger).catch(() => null);
      return { ok: false, code: result.status === 409 ? "video_start_conflict" : "video_start_failed" };
    }

    await confirmReservation(admin, request.ownerId, generationIdForLedger).catch(() => null);
    return { ok: true, state: result.status === 202 ? "queued" : "exists" };
  }

  // Image path — use same ledger generationId as mara row id for traceability
  const imageGenId = generationIdForLedger;
  const format = request.contentType === "story" ? "9:16" : "1:1";
  const prompt = buildVisualPrompt(request);
  const { error: queueError } = await admin.from("mara_media_generations").insert({
    id: imageGenId,
    owner_user_id: request.ownerId,
    conversation_id: request.conversationId,
    draft_id: request.draftId,
    media_type: "image",
    prompt: prompt.slice(0, 4000),
    aspect_ratio: format,
    status: "processing",
    spend_source: isExplicit ? "user_request" : "autopilot",
    estimated_cost_usd: estimateMediaCostUsd({ mediaType: "image" }),
    idempotency_key: `workflow:${request.draftId}:${imageGenId}`,
  });
  if (queueError) {
    await releaseReservationOnFailure(admin, request.ownerId, generationIdForLedger).catch(() => null);
    return { ok: false, code: "media_job_failed" };
  }

  try {
    const result = await deps.generateImage({ prompt, aspectRatio: format });
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
      provider: result.provider, storage_path: storagePath, mime_type: mimeType,
      byte_size: result.bytes.length, status: "completed", completed_at: new Date().toISOString(), error_code: null,
    }).eq("id", imageGenId).eq("owner_user_id", request.ownerId);
    if (previousStoragePath && previousStoragePath !== storagePath) {
      await removePostAssetObject(admin, request.ownerId, previousStoragePath).catch(() => undefined);
    }
    await confirmReservation(admin, request.ownerId, generationIdForLedger).catch(() => null);
    await syncPostToCalendar(admin, request.ownerId, request.draftId).catch(() => null);
    return { ok: true, state: "completed" };
  } catch (reason) {
    const code = reason instanceof MediaError ? reason.code : "unavailable";
    await admin.from("mara_media_generations").update({
      status: "failed", error_code: code,
      provider_diagnostic: reason instanceof MediaError ? reason.diagnostic : null,
    }).eq("id", imageGenId).eq("owner_user_id", request.ownerId);
    await releaseReservationOnFailure(admin, request.ownerId, generationIdForLedger).catch(() => null);
    return { ok: false, code };
  }
}

export function buildVisualPrompt(request: MediaRequest): string {
  const surface = request.contentType === "story" ? "9:16 full-screen Instagram Story frame" : "clean, brandable Instagram feed image";
  return [
    `${surface} for the concept "${request.concept}".`,
    request.visualBrief,
    "Photographic, natural light, no readable text, no logos, no watermarks, no real identifiable people.",
  ].filter(Boolean).join(" ").slice(0, 1200);
}
