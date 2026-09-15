import "server-only";
import { randomUUID } from "node:crypto";
import { detectReelAsset } from "@/lib/media/reel-asset";
import { aspectMatches, durationMatches, inspectImageBytes, inspectVideoBytes } from "@/lib/media/media-inspect";
import { MediaError, type GeneratedMedia } from "@/lib/media/types";
import type { MediaAspectRatio } from "@/lib/media/types";
import { GENERATED_VIDEO_MAX_BYTES } from "@/lib/media/video-provider";
import type { CreatedVideoJob, ReferenceImage, VideoJobPoll } from "@/lib/media/video-provider";
import {
  VIDEO_JOB_POLL_INTERVAL_MS,
  VIDEO_JOB_TIMEOUT_MINUTES,
  isActiveVideoState,
  isTimedOutVideoGeneration,
  staleDecision,
  videoJobSafeError,
} from "./video-job";

export const VIDEO_JOB_SELECT =
  "id,owner_user_id,draft_id,conversation_id,media_type,generation_mode,prompt,aspect_ratio,status,provider,provider_job_id,provider_polling_url,provider_status,provider_retry_after_at,provider_diagnostic,storage_path,mime_type,byte_size,duration_seconds,estimated_cost_usd,error_code,idempotency_key,source_asset_id,overlay,started_at,attempt_count,created_at,updated_at,completed_at";

export interface VideoJobRow extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  draft_id: string;
  conversation_id: string;
  media_type: "video";
  generation_mode: "image_to_video" | "generated_image_to_video" | "text_to_video" | null;
  prompt: string;
  aspect_ratio: "9:16";
  status: string;
  provider: string | null;
  provider_job_id: string | null;
  provider_polling_url: string | null;
  provider_status: string | null;
  provider_retry_after_at: string | null;
  provider_diagnostic: Record<string, unknown> | null;
  storage_path: string | null;
  mime_type: string | null;
  byte_size: number | null;
  duration_seconds: number | null;
  estimated_cost_usd: number | null;
  error_code: string | null;
  idempotency_key: string;
  source_asset_id: string | null;
  overlay: string | null;
  started_at: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface StoredReferenceImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
  name: string;
  assetId: string | null;
  url: string | null;
}

export interface VideoPlanResult {
  concept: string;
  visualPrompt: string;
  motionDirection: string;
  durationSeconds: number;
  overlayJson: string | null;
  cta: string | null;
}

export interface VideoGenerationPorts {
  now(): number;
  findActiveGeneration(ownerId: string, draftId: string): Promise<VideoJobRow | null>;
  findGeneration(ownerId: string, id: string): Promise<VideoJobRow | null>;
  findGenerationByIdempotency(ownerId: string, key: string): Promise<VideoJobRow | null>;
  countRecentJobs(ownerId: string, sinceIso: string): Promise<number>;
  sumMonthlyVideoCost(ownerId: string, monthStartIso: string): Promise<number>;
  insertGeneration(row: Record<string, unknown>): Promise<"inserted" | "idempotency_conflict" | "active_conflict" | "error">;
  updateGeneration(ownerId: string, id: string, patch: Record<string, unknown>, whereStatuses?: string[]): Promise<VideoJobRow | null>;
  claimGenerationForPoll?(ownerId: string, id: string, nowIso: string, eligibleBeforeIso: string): Promise<VideoJobRow | null>;
  planMedia(input: { concept: string; script: string; brief: string; contentType: "reel" | "instagram_story"; hasSourceImage: boolean }): Promise<VideoPlanResult>;
  generateBaseImage(input: { prompt: string; aspectRatio: MediaAspectRatio }): Promise<GeneratedMedia>;
  createVideoJob(input: { prompt: string; durationSeconds: number; referenceImage: ReferenceImage | null; name: string }): Promise<CreatedVideoJob>;
  pollVideoJob(providerJobId: string, pollingUrl?: string | null): Promise<VideoJobPoll>;
  uploadBaseImage(ownerId: string, draftId: string, bytes: Uint8Array, mimeType: string, extension: string): Promise<string>;
  signReferenceImage?(ownerId: string, storagePath: string): Promise<string | null>;
  loadReferenceImage(ownerId: string, storagePath: string, assetId: string | null): Promise<StoredReferenceImage | null>;
  storeFinalAsset(ownerId: string, draftId: string, input: { bytes: Uint8Array; mimeType: string; extension: string; displayName: string }): Promise<{ storagePath: string; previousStoragePath: string | null }>;
  removeAbandonedObject(ownerId: string, storagePath: string): Promise<void>;
  signPreview(storagePath: string): Promise<string | null>;
  /** V1 billing: reserve Voom credits before provider submission. Optional for test fakes. */
  reserveCredits?(input: { ownerId: string; generationId: string; mediaType: "video"; source: "user_request" | "autopilot" }): Promise<{ ok: boolean; reason?: string; message?: string }>;
  refundCredits?(ownerId: string, generationId: string): Promise<void>;
  settleCredits?(ownerId: string, generationId: string): Promise<void>;
}

export type StartResult =
  | { ok: true; generation: VideoJobRow; created: boolean }
  | { ok: false; status: 409; code: "active"; generation: VideoJobRow; message: string }
  | { ok: false; status: 429; code: "too_many"; message: string }
  | { ok: false; status: 402; code: "insufficient_credits" | "plan_not_allowed"; errorCode: string; message: string }
  | { ok: false; status: 503; code: "not_configured" | "plan_failed" | "provider_failed" | "spend_limit" | "unsupported_input" | "db_failure" | "automatic_media_disabled"; errorCode: string; message: string };

export interface StartInput {
  ownerId: string;
  draftId: string;
  conversationId: string;
  scope: "post" | "reel";
  kind: "reel" | "story";
  concept: string;
  script: string;
  brief: string;
  idempotencyKey: string;
  sourceAsset: { storagePath: string; assetId: string | null } | null;
  providerName: string;
  supportsImageToVideo: boolean;
  estimatedCostUsd: number | null;
  monthlySpendLimitUsd: number | null;
  source?: "user_request" | "assisted" | "autopilot";
  /** Optional pre-generated id for credit ledger traceability (if omitted, randomUUID is used). */
  generationId?: string;
}

const MAX_CONCURRENT_WINDOW_JOBS = 4;

export async function startVideoGeneration(ports: VideoGenerationPorts, input: StartInput): Promise<StartResult> {
  const now = ports.now();

  const active = await ports.findActiveGeneration(input.ownerId, input.draftId);
  if (active) {
    return {
      ok: false,
      status: 409,
      code: "active",
      generation: active,
      message: "A video generation is already running for this content. Check its status before starting another.",
    };
  }

  const since = new Date(now - 60_000).toISOString();
  const recent = await ports.countRecentJobs(input.ownerId, since);
  if (recent >= MAX_CONCURRENT_WINDOW_JOBS) {
    return { ok: false, status: 429, code: "too_many", message: "MARA is generating media too quickly. Wait a minute and retry." };
  }

  if (input.monthlySpendLimitUsd !== null) {
    const monthStart = new Date(new Date(now).toISOString().slice(0, 7) + "-01T00:00:00Z").toISOString();
    const spent = await ports.sumMonthlyVideoCost(input.ownerId, monthStart);
    if (spent + (input.estimatedCostUsd ?? 0) > input.monthlySpendLimitUsd) {
      return { ok: false, status: 503, code: "spend_limit", errorCode: "spend_limit", message: "This video would exceed your configured monthly media limit. No generation was started." };
    }
  }

  let plan: VideoPlanResult;
  try {
    plan = await ports.planMedia({
      concept: input.concept,
      script: input.script,
      brief: input.brief,
      contentType: input.kind === "reel" ? "reel" : "instagram_story",
      hasSourceImage: input.sourceAsset !== null,
    });
  } catch (reason) {
    const code = reason instanceof Error ? (reason as Error & { code?: string }).code ?? "plan_failed" : "plan_failed";
    if (code === "not_configured") {
      return { ok: false, status: 503, code: "not_configured", errorCode: "not_configured", message: "MARA's AI provider is not configured yet, so no video was planned." };
    }
    if (code === "rate_limited") {
      return { ok: false, status: 429, code: "too_many", message: "MARA is busy right now. Wait a moment and retry." };
    }
    return { ok: false, status: 503, code: "plan_failed", errorCode: "plan_failed", message: "MARA couldn't plan that video. Nothing was generated." };
  }

  let referenceImage: ReferenceImage | null = null;
  let baseImagePath: string | null = null;
  let mode: "image_to_video" | "generated_image_to_video" | "text_to_video";

  if (input.sourceAsset) {
    if (!input.supportsImageToVideo) {
      return { ok: false, status: 503, code: "unsupported_input", errorCode: "unsupported_input", message: "This video provider can't animate your image yet. Your previous asset is unchanged." };
    }
    const stored = await ports.loadReferenceImage(input.ownerId, input.sourceAsset.storagePath, input.sourceAsset.assetId);
    if (!stored) {
      return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "The uploaded image could not be read safely. Nothing was generated." };
    }
    referenceImage = { bytes: stored.bytes, mimeType: stored.mimeType, extension: stored.extension, name: stored.name, url: stored.url ?? null };
    mode = "image_to_video";
  } else if (input.supportsImageToVideo) {
    const basePrompt = `${plan.visualPrompt.trim().replace(/\\s+/g, " ")} Vertical 9:16 composition, clean commercial look, no text, no logos, no watermarks.`.slice(0, 1500);
    let base: GeneratedMedia | null = null;
    try {
      base = await ports.generateBaseImage({ prompt: basePrompt, aspectRatio: "9:16" });
    } catch (reason) {
      if (input.providerName !== "openrouter" || !(reason instanceof Error) || reason.message !== "image_provider_not_configured") {
        return { ok: false, status: 503, code: "provider_failed", errorCode: "unavailable", message: "MARA couldn't create the base visual for the video. Nothing was generated." };
      }
    }

    if (!base) {
      mode = "text_to_video";
    } else {
      const inspected = inspectImageBytes(base.bytes);
      if (!inspected || !aspectMatches(inspected.width, inspected.height, "9:16")) {
        return { ok: false, status: 503, code: "provider_failed", errorCode: "invalid_output", message: "The base visual didn't pass Voom's checks, so no video was generated. Nothing changed." };
      }
      const baseExtension = inspected.mimeType === "image/png" ? "png" as const : inspected.mimeType === "image/webp" ? "webp" as const : "jpg" as const;
      try {
        baseImagePath = await ports.uploadBaseImage(input.ownerId, input.draftId, base.bytes, inspected.mimeType, baseExtension);
      } catch {
        return { ok: false, status: 503, code: "provider_failed", errorCode: "storage_failure", message: "Voom couldn't store the base visual safely. Nothing was generated." };
      }
      let referenceUrl: string | null = null;
      if (ports.signReferenceImage) {
        try {
          referenceUrl = await ports.signReferenceImage(input.ownerId, baseImagePath);
        } catch {
          await ports.removeAbandonedObject(input.ownerId, baseImagePath).catch(() => undefined);
          return { ok: false, status: 503, code: "provider_failed", errorCode: "storage_failure", message: "Voom couldn't prepare the base visual safely. Nothing was generated." };
        }
      }
      referenceImage = {
        bytes: base.bytes,
        mimeType: inspected.mimeType,
        extension: baseExtension,
        name: `mara-base-${input.draftId}.${baseExtension}`,
        url: referenceUrl,
      };
      mode = "generated_image_to_video";
    }
  } else {
    mode = "text_to_video";
  }

  const providerPrompt = `${plan.visualPrompt.trim().replace(/\\s+/g, " ")} ${plan.motionDirection.trim().replace(/\\s+/g, " ")}`.slice(0, 4000);

  const generationId = input.generationId ?? randomUUID();

  // V1 billing: reserve credits BEFORE provider submission (hard boundary)
  if (ports.reserveCredits) {
    const creditSource = input.source === "autopilot" ? "autopilot" : "user_request";
    const reserve = await ports.reserveCredits({ ownerId: input.ownerId, generationId, mediaType: "video", source: creditSource });
    if (!reserve.ok) {
      if (baseImagePath) await ports.removeAbandonedObject(input.ownerId, baseImagePath).catch(() => undefined);
      const reason = reserve.reason ?? "spend_limit";
      if (reason === "insufficient_credits" || reason === "plan_not_allowed") {
        return { ok: false, status: 402, code: reason as any, errorCode: reason, message: reserve.message ?? "Not enough credits or plan does not allow generation." };
      }
      return { ok: false, status: 503, code: "automatic_media_disabled" as any, errorCode: reason, message: reserve.message ?? "Automatic media generation disabled." };
    }
  }

  const row: Record<string, unknown> = {
    id: generationId,
    owner_user_id: input.ownerId,
    conversation_id: input.conversationId,
    draft_id: input.draftId,
    media_type: "video",
    generation_mode: mode,
    prompt: providerPrompt.slice(0, 4000),
    aspect_ratio: "9:16",
    status: "queued",
    idempotency_key: input.idempotencyKey,
    source_asset_id: input.sourceAsset?.assetId ?? null,
    overlay: plan.overlayJson,
    duration_seconds: plan.durationSeconds,
    estimated_cost_usd: input.estimatedCostUsd,
    spend_source: input.source ?? null,
    provider_polling_url: null,
    provider_status: null,
    provider_retry_after_at: null,
    provider_diagnostic: null,
    attempt_count: 0,
  };
  const inserted = await ports.insertGeneration(row);
  if (inserted === "idempotency_conflict") {
    if (ports.refundCredits) await ports.refundCredits(input.ownerId, generationId).catch(() => null);
    const existing = await ports.findGenerationByIdempotency(input.ownerId, input.idempotencyKey);
    if (!existing) return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't verify that generation safely. Nothing changed." };
    if (isActiveVideoState(existing.status)) {
      return { ok: false, status: 409, code: "active", generation: existing, message: "A video generation is already running for this content. Check its status before starting another." };
    }
    if (ports.settleCredits) await ports.settleCredits(input.ownerId, existing.id).catch(() => null);
    return { ok: true, generation: existing, created: false };
  }
  if (inserted === "active_conflict") {
    if (ports.refundCredits) await ports.refundCredits(input.ownerId, generationId).catch(() => null);
    const activeNow = await ports.findActiveGeneration(input.ownerId, input.draftId);
    if (activeNow) return { ok: false, status: 409, code: "active", generation: activeNow, message: "A video generation is already running for this content. Check its status before starting another." };
    return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't start that generation safely. Nothing changed." };
  }
  if (inserted === "error") {
    if (ports.refundCredits) await ports.refundCredits(input.ownerId, generationId).catch(() => null);
    if (baseImagePath) await ports.removeAbandonedObject(input.ownerId, baseImagePath).catch(() => undefined);
    return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't start that generation safely. Nothing changed." };
  }

  let createdJob: CreatedVideoJob;
  try {
    createdJob = await ports.createVideoJob({
      prompt: providerPrompt,
      durationSeconds: plan.durationSeconds,
      referenceImage,
      name: `Voom ${input.kind} · ${plan.concept.slice(0, 60)}`.slice(0, 120),
    });
  } catch (reason) {
    const code = reason instanceof Error ? (reason as Error & { code?: string }).code ?? "unavailable" : "unavailable";
    await ports.updateGeneration(input.ownerId, generationId, {
      status: "failed",
      error_code: code,
      provider_diagnostic: reason instanceof MediaError ? reason.diagnostic : null,
    }).catch(() => undefined);
    if (ports.refundCredits) await ports.refundCredits(input.ownerId, generationId).catch(() => null);
    if (baseImagePath) await ports.removeAbandonedObject(input.ownerId, baseImagePath).catch(() => undefined);
    return {
      ok: false,
      status: 503,
      code: "provider_failed",
      errorCode: String(code),
      message: videoJobSafeError(String(code)) ?? "Generation couldn't finish. Nothing changed.",
    };
  }

  const started = await ports.updateGeneration(
    input.ownerId,
    generationId,
    {
      status: "generating",
      provider: input.providerName,
      provider_job_id: createdJob.providerJobId,
      provider_polling_url: createdJob.pollingUrl ?? null,
      provider_status: createdJob.providerStatus ?? "pending",
      provider_retry_after_at: null,
      provider_diagnostic: null,
      started_at: new Date(now).toISOString(),
      attempt_count: 1,
    },
    ["queued"],
  );
  if (!started) {
    if (ports.refundCredits) await ports.refundCredits(input.ownerId, generationId).catch(() => null);
    return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't record that generation safely. Nothing changed." };
  }
  if (ports.settleCredits) await ports.settleCredits(input.ownerId, generationId).catch(() => null);
  return { ok: true, generation: started, created: true };
}

export type AdvanceResult =
  | { ok: true; generation: VideoJobRow; previewUrl: string | null; attached: boolean; safeError: string | null }
  | { ok: false; notFound: true };

export async function advanceVideoGeneration(
  ports: VideoGenerationPorts,
  ownerId: string,
  generationId: string,
  kind: "reel" | "story",
  options: { reconcile?: boolean } = {},
): Promise<AdvanceResult> {
  const row = await ports.findGeneration(ownerId, generationId);
  if (!row) return { ok: false, notFound: true };

  const now = ports.now();
  const clock = { nowMs: now, createdAtMs: Date.parse(row.created_at) || 0, updatedAtMs: Date.parse(row.updated_at) || now };
  const reconciling = options.reconcile === true;
  const storedProviderJobId = typeof row.provider_job_id === "string" && row.provider_job_id ? row.provider_job_id : null;
  const recoveringTimedOut = reconciling
    && isTimedOutVideoGeneration(row.status, typeof row.error_code === "string" ? row.error_code : null)
    && storedProviderJobId !== null;

  const decision = staleDecision(row.status, clock);
  if (decision === "timeout" && !reconciling) {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "provider_timeout" }, isActiveVideoState(row.status) ? [row.status] : undefined);
    const finalRow = failed ?? row;
    return { ok: true, generation: finalRow, previewUrl: null, attached: false, safeError: videoJobSafeError("provider_timeout") };
  }
  if (decision === "reclaim") {
    const reclaimed = await ports.updateGeneration(ownerId, generationId, { status: "generating" }, ["processing"]);
    return { ok: true, generation: reclaimed ?? row, previewUrl: null, attached: false, safeError: null };
  }

  if (!isActiveVideoState(row.status) && !recoveringTimedOut) {
    const previewUrl = row.status === "completed" && typeof row.storage_path === "string" ? await ports.signPreview(row.storage_path) : null;
    return { ok: true, generation: row, previewUrl, attached: row.status === "completed", safeError: row.status === "failed" ? videoJobSafeError(row.error_code) : null };
  }

  if (row.status === "generating" && row.provider_retry_after_at) {
    const retryAt = Date.parse(row.provider_retry_after_at);
    if (Number.isFinite(retryAt) && retryAt > now) {
      return { ok: true, generation: row, previewUrl: null, attached: false, safeError: null };
    }
  }

  if (row.status === "queued" && !row.provider_job_id) {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "provider_timeout" }, ["queued"]);
    const finalRow = failed ?? row;
    return { ok: true, generation: finalRow, previewUrl: null, attached: false, safeError: videoJobSafeError("provider_timeout") };
  }

  const nowIso = new Date(now).toISOString();
  const eligibleBeforeIso = new Date(now - VIDEO_JOB_POLL_INTERVAL_MS).toISOString();
  const claimed: VideoJobRow | null = recoveringTimedOut
    ? await ports.updateGeneration(ownerId, generationId, { status: "processing", error_code: null }, ["failed"])
    : ports.claimGenerationForPoll
      ? await ports.claimGenerationForPoll(ownerId, generationId, nowIso, eligibleBeforeIso)
      : row.status === "processing"
        ? row
        : await ports.updateGeneration(ownerId, generationId, { status: "processing" }, [row.status]);
  if (!claimed) {
    const current = await ports.findGeneration(ownerId, generationId);
    if (!current) return { ok: false, notFound: true };
    const previewUrl = current.status === "completed" && typeof current.storage_path === "string" ? await ports.signPreview(current.storage_path) : null;
    return { ok: true, generation: current, previewUrl, attached: current.status === "completed", safeError: current.status === "failed" ? videoJobSafeError(current.error_code) : null };
  }

  const providerJobId = typeof claimed.provider_job_id === "string" ? claimed.provider_job_id : null;
  if (!providerJobId) {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "provider_timeout" }, ["processing"]);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError("provider_timeout") };
  }

  let poll: VideoJobPoll;
  try {
    poll = await ports.pollVideoJob(providerJobId, claimed.provider_polling_url);
  } catch (reason) {
    const code = reason instanceof Error ? (reason as Error & { code?: string }).code ?? "unavailable" : "unavailable";
    if (reason instanceof MediaError && isRetryableProviderError(reason) && reason.retryAfterMs !== null) {
      const retryPatch = recoveringTimedOut
        ? { status: "failed", error_code: "provider_timeout", provider_diagnostic: reason.diagnostic }
        : {
            status: "generating",
            provider_status: "retry_wait",
            provider_retry_after_at: new Date(now + reason.retryAfterMs).toISOString(),
            provider_diagnostic: reason.diagnostic,
          };
      const retrying = await ports.updateGeneration(ownerId, generationId, retryPatch, ["processing"]).catch(() => null);
      return {
        ok: true,
        generation: retrying ?? claimed,
        previewUrl: null,
        attached: false,
        safeError: recoveringTimedOut ? videoJobSafeError("provider_timeout") : null,
      };
    }
    const failed = await ports.updateGeneration(ownerId, generationId, {
      status: "failed",
      error_code: String(code),
      provider_diagnostic: reason instanceof MediaError ? reason.diagnostic : null,
    }, ["processing"]).catch(() => null);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError(String(code)) };
  }

  if (poll.kind === "pending") {
    if (recoveringTimedOut) {
      const restored = await ports.updateGeneration(ownerId, generationId, {
        status: "failed",
        error_code: "provider_timeout",
        provider_status: poll.providerStatus ?? claimed.provider_status ?? null,
        provider_polling_url: poll.pollingUrl ?? claimed.provider_polling_url ?? null,
        provider_retry_after_at: null,
      }, ["processing"]).catch(() => null);
      return { ok: true, generation: restored ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError("provider_timeout") };
    }
    const pending = await ports.updateGeneration(ownerId, generationId, {
      provider_status: poll.providerStatus ?? claimed.provider_status ?? null,
      provider_polling_url: poll.pollingUrl ?? claimed.provider_polling_url ?? null,
      provider_retry_after_at: null,
    }, ["processing"]).catch(() => null);
    return { ok: true, generation: pending ?? claimed, previewUrl: null, attached: false, safeError: null };
  }
  if (poll.kind === "failed") {
    const failed = await ports.updateGeneration(ownerId, generationId, {
      status: "failed",
      error_code: poll.code,
      provider_status: poll.providerStatus ?? claimed.provider_status ?? null,
      provider_polling_url: poll.pollingUrl ?? claimed.provider_polling_url ?? null,
      provider_retry_after_at: null,
      provider_diagnostic: poll.diagnostic ?? null,
    }, ["processing"]);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError(poll.code) };
  }

  const media = poll.media;

  const problem = validateGeneratedVideo(media.bytes, kind);
  if (problem) {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "invalid_output" }, ["processing"]);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError("invalid_output") };
  }
  const inspection = inspectVideoBytes(media.bytes)!;

  let stored: { storagePath: string; previousStoragePath: string | null };
  try {
    stored = await ports.storeFinalAsset(ownerId, claimed.draft_id, {
      bytes: media.bytes,
      mimeType: "video/mp4",
      extension: "mp4",
      displayName: `MARA video · ${String(claimed.prompt).slice(0, 60)}`.slice(0, 180),
    });
  } catch {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "storage_failure" }, ["processing"]);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError("storage_failure") };
  }

  const completed = await ports.updateGeneration(
    ownerId,
    generationId,
    {
      status: "completed",
      storage_path: stored.storagePath,
      mime_type: "video/mp4",
      byte_size: media.bytes.length,
      duration_seconds: Math.round(inspection.durationSeconds),
      completed_at: new Date(now).toISOString(),
      error_code: null,
      provider_status: poll.providerStatus ?? claimed.provider_status ?? "completed",
      provider_polling_url: poll.pollingUrl ?? claimed.provider_polling_url ?? null,
      provider_retry_after_at: null,
      provider_diagnostic: null,
    },
    ["processing"],
  );
  if (!completed) {
    await ports.removeAbandonedObject(ownerId, stored.storagePath).catch(() => undefined);
    return { ok: true, generation: claimed, previewUrl: null, attached: false, safeError: videoJobSafeError("db_failure") };
  }

  if (stored.previousStoragePath && stored.previousStoragePath !== stored.storagePath) {
    await ports.removeAbandonedObject(ownerId, stored.previousStoragePath).catch(() => undefined);
  }

  const previewUrl = await ports.signPreview(stored.storagePath);
  return { ok: true, generation: completed, previewUrl, attached: true, safeError: null };
}

function isRetryableProviderError(error: MediaError): boolean {
  return error.code === "rate_limited" || error.code === "unavailable";
}

function validateGeneratedVideo(bytes: Uint8Array, kind: "reel" | "story"): string | null {
  const detected = detectReelAsset(bytes);
  if (!detected || detected.kind !== "video" || detected.mimeType !== "video/mp4") return "signature";
  if (!bytes.length || bytes.length > GENERATED_VIDEO_MAX_BYTES) return "size";
  const inspection = inspectVideoBytes(bytes);
  if (!inspection) return "structure";
  if (!aspectMatches(inspection.width, inspection.height, "9:16")) return "aspect";
  const bounds = kind === "reel" ? { min: 4, max: 15 } : { min: 3, max: 30 };
  if (!durationMatches(inspection.durationSeconds, bounds.min, bounds.max)) return "duration";
  return null;
}

export { VIDEO_JOB_TIMEOUT_MINUTES };
