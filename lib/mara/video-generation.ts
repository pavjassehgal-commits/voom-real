import "server-only";
import { randomUUID } from "node:crypto";
import { detectReelAsset } from "@/lib/media/reel-asset";
import { aspectMatches, durationMatches, inspectImageBytes, inspectVideoBytes } from "@/lib/media/media-inspect";
import type { GeneratedMedia } from "@/lib/media/types";
import type { MediaAspectRatio } from "@/lib/media/types";
import { GENERATED_VIDEO_MAX_BYTES } from "@/lib/media/video-provider";
import type { ReferenceImage, VideoJobPoll } from "@/lib/media/video-provider";
import { VIDEO_JOB_TIMEOUT_MINUTES, isActiveVideoState, staleDecision, videoJobSafeError } from "./video-job";

/**
 * The MARA video generation orchestrator.
 *
 * `startVideoGeneration` and `advanceVideoGeneration` do the real work
 * (plan -> base image -> provider job -> poll -> validate -> store -> attach)
 * through small injected ports, so the whole state machine is unit tested
 * with fakes — the same pattern the Instagram publishing flow uses
 * (lib/instagram/publish-flow.ts). `buildVideoGenerationPorts` wires the real
 * Supabase + provider implementations for the API routes.
 *
 * Invariants:
 *   - a failed/timed-out job never touches the draft's current asset,
 *   - the draft asset is replaced atomically only after the new output is
 *     validated and stored (upload, then metadata row — putPostAsset),
 *   - provider job ids persist on the row, so a crash never re-pays for a
 *     second job on the same row.
 */

export const VIDEO_JOB_SELECT =
  "id,owner_user_id,draft_id,conversation_id,media_type,generation_mode,prompt,aspect_ratio,status,provider,provider_job_id,storage_path,mime_type,byte_size,duration_seconds,estimated_cost_usd,error_code,idempotency_key,source_asset_id,overlay,started_at,attempt_count,created_at,updated_at,completed_at";

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
}

export interface VideoPlanResult {
  concept: string;
  visualPrompt: string;
  motionDirection: string;
  durationSeconds: number;
  /** Deterministic Voom overlay plan (JSON) — never rendered by the provider. */
  overlayJson: string | null;
  cta: string | null;
}

export interface VideoGenerationPorts {
  now(): number;
  // -- durable job record (owner-scoped) --
  findActiveGeneration(ownerId: string, draftId: string): Promise<VideoJobRow | null>;
  findGeneration(ownerId: string, id: string): Promise<VideoJobRow | null>;
  findGenerationByIdempotency(ownerId: string, key: string): Promise<VideoJobRow | null>;
  countRecentJobs(ownerId: string, sinceIso: string): Promise<number>;
  sumMonthlyVideoCost(ownerId: string, monthStartIso: string): Promise<number>;
  insertGeneration(row: Record<string, unknown>): Promise<"inserted" | "idempotency_conflict" | "active_conflict" | "error">;
  updateGeneration(ownerId: string, id: string, patch: Record<string, unknown>, whereStatuses?: string[]): Promise<VideoJobRow | null>;
  // -- MARA planning + providers --
  planMedia(input: { concept: string; script: string; brief: string; contentType: "reel" | "instagram_story"; hasSourceImage: boolean }): Promise<VideoPlanResult>;
  generateBaseImage(input: { prompt: string; aspectRatio: MediaAspectRatio }): Promise<GeneratedMedia>;
  createVideoJob(input: { prompt: string; durationSeconds: number; referenceImage: ReferenceImage | null; name: string }): Promise<{ providerJobId: string }>;
  pollVideoJob(providerJobId: string): Promise<VideoJobPoll>;
  // -- private storage (mara-media bucket) --
  uploadBaseImage(ownerId: string, draftId: string, bytes: Uint8Array, mimeType: string, extension: string): Promise<string>;
  loadReferenceImage(ownerId: string, storagePath: string, assetId: string | null): Promise<StoredReferenceImage | null>;
  storeFinalAsset(ownerId: string, draftId: string, input: { bytes: Uint8Array; mimeType: string; extension: string; displayName: string }): Promise<{ storagePath: string; previousStoragePath: string | null }>;
  removeAbandonedObject(ownerId: string, storagePath: string): Promise<void>;
  signPreview(storagePath: string): Promise<string | null>;
}

export type StartResult =
  | { ok: true; generation: VideoJobRow; created: boolean }
  | { ok: false; status: 409; code: "active"; generation: VideoJobRow; message: string }
  | { ok: false; status: 429; code: "too_many"; message: string }
  | { ok: false; status: 503; code: "not_configured" | "plan_failed" | "provider_failed" | "spend_limit" | "unsupported_input" | "db_failure"; errorCode: string; message: string };

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
  /** User's private image asset (asset-assisted mode) when present. */
  sourceAsset: { storagePath: string; assetId: string | null } | null;
  providerName: string;
  supportsImageToVideo: boolean;
  estimatedCostUsd: number | null;
  monthlySpendLimitUsd: number | null;
}

const MAX_CONCURRENT_WINDOW_JOBS = 4;

export async function startVideoGeneration(ports: VideoGenerationPorts, input: StartInput): Promise<StartResult> {
  const now = ports.now();

  // 1) One active job per draft — the database unique index is the final
  // guard; this pre-check returns the existing job instead of a conflict.
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

  // 2) Global burst limit (same shape as the existing media endpoint).
  const since = new Date(now - 60_000).toISOString();
  const recent = await ports.countRecentJobs(input.ownerId, since);
  if (recent >= MAX_CONCURRENT_WINDOW_JOBS) {
    return { ok: false, status: 429, code: "too_many", message: "MARA is generating media too quickly. Wait a minute and retry." };
  }

  // 3) Monthly spend limit (safe: no job is created when the limit is hit).
  if (input.monthlySpendLimitUsd !== null) {
    const monthStart = new Date(new Date(now).toISOString().slice(0, 7) + "-01T00:00:00Z").toISOString();
    const spent = await ports.sumMonthlyVideoCost(input.ownerId, monthStart);
    if (spent + (input.estimatedCostUsd ?? 0) > input.monthlySpendLimitUsd) {
      return { ok: false, status: 503, code: "spend_limit", errorCode: "spend_limit", message: "This video would exceed your configured monthly media limit. No generation was started." };
    }
  }

  // 4) MARA's structured, business-aware plan (text-only context).
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

  // 5) Reference image: the user's asset when the provider can animate it,
  // otherwise MARA generates a clean 9:16 base frame first.
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
    referenceImage = { bytes: stored.bytes, mimeType: stored.mimeType, extension: stored.extension, name: stored.name };
    mode = "image_to_video";
  } else if (input.supportsImageToVideo) {
    const basePrompt = `${plan.visualPrompt.trim().replace(/\s+/g, " ")} Vertical 9:16 composition, clean commercial look, no text, no logos, no watermarks.`.slice(0, 1500);
    let base: GeneratedMedia;
    try {
      base = await ports.generateBaseImage({ prompt: basePrompt, aspectRatio: "9:16" });
    } catch {
      return { ok: false, status: 503, code: "provider_failed", errorCode: "unavailable", message: "MARA couldn't create the base visual for the video. Nothing was generated." };
    }
    const inspected = inspectImageBytes(base.bytes);
    if (!inspected || !aspectMatches(inspected.width, inspected.height, "9:16")) {
      return { ok: false, status: 503, code: "provider_failed", errorCode: "invalid_output", message: "The base visual didn't pass Voom's checks, so no video was generated. Nothing changed." };
    }
    // The storage filename, the upload content type and the provider's
    // filename hint all follow the container the bytes actually are — JPEG for
    // a Gemini base frame, PNG for an OpenAI one — never a hard-coded suffix.
    const baseExtension = inspected.mimeType === "image/png" ? "png" as const : inspected.mimeType === "image/webp" ? "webp" as const : "jpg" as const;
    try {
      baseImagePath = await ports.uploadBaseImage(input.ownerId, input.draftId, base.bytes, inspected.mimeType, baseExtension);
    } catch {
      return { ok: false, status: 503, code: "provider_failed", errorCode: "storage_failure", message: "Voom couldn't store the base visual safely. Nothing was generated." };
    }
    referenceImage = {
      bytes: base.bytes,
      mimeType: inspected.mimeType,
      extension: baseExtension,
      name: `mara-base-${input.draftId}.${baseExtension}`,
    };
    mode = "generated_image_to_video";
  } else {
    mode = "text_to_video";
  }

  const providerPrompt = `${plan.visualPrompt.trim().replace(/\s+/g, " ")} ${plan.motionDirection.trim().replace(/\s+/g, " ")}`.slice(0, 4000);

  // 6) Persist the durable job BEFORE any paid provider work.
  const row: Record<string, unknown> = {
    id: randomUUID(),
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
    attempt_count: 0,
  };
  const inserted = await ports.insertGeneration(row);
  if (inserted === "idempotency_conflict") {
    const existing = await ports.findGenerationByIdempotency(input.ownerId, input.idempotencyKey);
    if (!existing) return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't verify that generation safely. Nothing changed." };
    if (isActiveVideoState(existing.status)) {
      return { ok: false, status: 409, code: "active", generation: existing, message: "A video generation is already running for this content. Check its status before starting another." };
    }
    return { ok: true, generation: existing, created: false };
  }
  if (inserted === "active_conflict") {
    const activeNow = await ports.findActiveGeneration(input.ownerId, input.draftId);
    if (activeNow) return { ok: false, status: 409, code: "active", generation: activeNow, message: "A video generation is already running for this content. Check its status before starting another." };
    return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't start that generation safely. Nothing changed." };
  }
  if (inserted === "error") {
    if (baseImagePath) await ports.removeAbandonedObject(input.ownerId, baseImagePath).catch(() => undefined);
    return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't start that generation safely. Nothing changed." };
  }

  const generationId = String(row.id);

  // 7) The provider job. If this request dies after the job exists, the row
  // keeps its idempotency record and the stale-queued rule fails it safely.
  let providerJobId: string;
  try {
    const created = await ports.createVideoJob({
      prompt: providerPrompt,
      durationSeconds: plan.durationSeconds,
      referenceImage,
      name: `Voom ${input.kind} · ${plan.concept.slice(0, 60)}`.slice(0, 120),
    });
    providerJobId = created.providerJobId;
  } catch (reason) {
    const code = reason instanceof Error ? (reason as Error & { code?: string }).code ?? "unavailable" : "unavailable";
    await ports.updateGeneration(input.ownerId, generationId, { status: "failed", error_code: code }).catch(() => undefined);
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
    { status: "generating", provider: input.providerName, provider_job_id: providerJobId, started_at: new Date(now).toISOString(), attempt_count: 1 },
    ["queued"],
  );
  if (!started) {
    // The row vanished or moved underneath us — the provider job is
    // abandoned safely (its id is recorded nowhere, nothing was attached).
    return { ok: false, status: 503, code: "db_failure", errorCode: "db_failure", message: "Voom couldn't record that generation safely. Nothing changed." };
  }
  return { ok: true, generation: started, created: true };
}

export type AdvanceResult =
  | { ok: true; generation: VideoJobRow; previewUrl: string | null; attached: boolean; safeError: string | null }
  | { ok: false; notFound: true };

/**
 * Lazy-polls one job: provider status -> validation -> private storage ->
 * atomic draft-asset replacement. Safe to call repeatedly and concurrently;
 * only one caller ever claims a job (status guard on the update).
 */
export async function advanceVideoGeneration(ports: VideoGenerationPorts, ownerId: string, generationId: string, kind: "reel" | "story"): Promise<AdvanceResult> {
  const row = await ports.findGeneration(ownerId, generationId);
  if (!row) return { ok: false, notFound: true };

  const now = ports.now();
  const clock = { nowMs: now, createdAtMs: Date.parse(row.created_at) || 0, updatedAtMs: Date.parse(row.updated_at) || now };
  const decision = staleDecision(row.status, clock);
  if (decision === "timeout") {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "provider_timeout" }, isActiveVideoState(row.status) ? [row.status] : undefined);
    const finalRow = failed ?? row;
    return { ok: true, generation: finalRow, previewUrl: null, attached: false, safeError: videoJobSafeError("provider_timeout") };
  }
  if (decision === "reclaim") {
    const reclaimed = await ports.updateGeneration(ownerId, generationId, { status: "generating" }, ["processing"]);
    return { ok: true, generation: reclaimed ?? row, previewUrl: null, attached: false, safeError: null };
  }

  if (!isActiveVideoState(row.status)) {
    const previewUrl = row.status === "completed" && typeof row.storage_path === "string" ? await ports.signPreview(row.storage_path) : null;
    return { ok: true, generation: row, previewUrl, attached: row.status === "completed", safeError: row.status === "failed" ? videoJobSafeError(row.error_code) : null };
  }

  if (row.status === "queued") {
    // A queued row only becomes generating inside startVideoGeneration; if it
    // shows up here the start request died before creating the job.
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "provider_timeout" }, ["queued"]);
    const finalRow = failed ?? row;
    return { ok: true, generation: finalRow, previewUrl: null, attached: false, safeError: videoJobSafeError("provider_timeout") };
  }

  // Claim generating -> processing atomically.
  const claimed = await ports.updateGeneration(ownerId, generationId, { status: "processing" }, ["generating"]);
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
    poll = await ports.pollVideoJob(providerJobId);
  } catch (reason) {
    const code = reason instanceof Error ? (reason as Error & { code?: string }).code ?? "unavailable" : "unavailable";
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: String(code) }, ["processing"]).catch(() => null);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError(String(code)) };
  }

  if (poll.kind === "pending") {
    return { ok: true, generation: claimed, previewUrl: null, attached: false, safeError: null };
  }
  if (poll.kind === "failed") {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: poll.code }, ["processing"]);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError(poll.code) };
  }

  const media = poll.media;

  // Byte-level validation — provider metadata is never trusted.
  const problem = validateGeneratedVideo(media.bytes, kind);
  if (problem) {
    const failed = await ports.updateGeneration(ownerId, generationId, { status: "failed", error_code: "invalid_output" }, ["processing"]);
    return { ok: true, generation: failed ?? claimed, previewUrl: null, attached: false, safeError: videoJobSafeError("invalid_output") };
  }
  const inspection = inspectVideoBytes(media.bytes)!;

  // Store privately, then link. putPostAsset deletes its own orphan if the
  // metadata write fails, so a failed attach never leaves a dangling object.
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
    },
    ["processing"],
  );
  if (!completed) {
    // The object is stored but the job row moved underneath us; remove it so
    // the draft's own asset row (written by storeFinalAsset) stays the
    // single source of truth.
    await ports.removeAbandonedObject(ownerId, stored.storagePath).catch(() => undefined);
    return { ok: true, generation: claimed, previewUrl: null, attached: false, safeError: videoJobSafeError("db_failure") };
  }

  // The previous asset survives until this point — and removeAbandonedObject
  // refuses to delete an object any paid generation row still references.
  if (stored.previousStoragePath && stored.previousStoragePath !== stored.storagePath) {
    await ports.removeAbandonedObject(ownerId, stored.previousStoragePath).catch(() => undefined);
  }

  const previewUrl = await ports.signPreview(stored.storagePath);
  return { ok: true, generation: completed, previewUrl, attached: true, safeError: null };
}

/** Reel: 4-15s. Story video: 3-30s (Meta allows up to 60s; V1 stays short). */
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
