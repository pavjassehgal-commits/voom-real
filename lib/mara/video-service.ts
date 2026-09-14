import "server-only";
import { createMediaProvider, getMediaConfig } from "@/lib/media";
import { getVideoConfig } from "@/lib/media/video-config";
import { createVideoProvider } from "@/lib/media/video-provider";
import type { VideoConfig } from "@/lib/media/video-config";
import type { VideoGenerationProvider } from "@/lib/media/video-provider";
import { loadPostBrandContext, loadPostPlanContext, syncPostToCalendar, type AdminClient } from "@/lib/post/server-data";
import { advanceVideoGeneration, startVideoGeneration, type StartInput, type StartResult, type AdvanceResult, type VideoGenerationPorts, type VideoJobRow } from "./video-generation";
import { buildVideoGenerationPorts } from "./video-ports";
import { VIDEO_JOB_SELECT } from "./video-generation";
import {
  ACTIVE_VIDEO_STATES,
  VIDEO_JOB_TIMEOUT_ERROR_CODE,
  VIDEO_JOB_TIMEOUT_MINUTES,
  isActiveVideoState,
  staleDecision,
  videoIdempotencyKey,
} from "./video-job";
import { toClientGenerationView, type ClientGenerationView } from "./video-view";
import { estimateMediaCostUsd, type MediaSource } from "./media-spend";

export interface VideoService {
  admin: AdminClient;
  ownerId: string;
  ports: VideoGenerationPorts;
  videoConfig: VideoConfig;
}

/**
 * Resolves the server-side video generation stack for one owner. Returns null
 * (never throws) when the video provider is not configured — the UI then
 * shows the truthful "temporarily unavailable" state while everything else
 * keeps working.
 */
export async function buildVideoService(admin: AdminClient, ownerId: string): Promise<VideoService | null> {
  let videoConfig: VideoConfig;
  let provider: VideoGenerationProvider;
  try {
    videoConfig = getVideoConfig();
    provider = createVideoProvider(videoConfig);
  } catch {
    return null;
  }
  let imageProvider: ReturnType<typeof createMediaProvider>;
  try {
    imageProvider = createMediaProvider(getMediaConfig());
  } catch {
    // Video-only deployments: image-to-video is still possible from the
    // user's own asset; generated-base-image mode will fail safely per job.
    imageProvider = createNoImageProvider(provider);
  }
  const [brand, plan] = await Promise.all([loadPostBrandContext(admin, ownerId), loadPostPlanContext(admin, ownerId)]);
  if (!brand) return null;
  return {
    admin,
    ownerId,
    videoConfig,
    ports: buildVideoGenerationPorts({
      admin,
      provider,
      imageProvider,
      brand: {
        name: brand.brandName,
        description: brand.brandDescription,
        industry: brand.industry,
        targetCustomer: brand.targetCustomer,
        mainGoal: brand.mainGoal,
        brandPersonality: brand.brandPersonality,
      },
      plan: plan
        ? { businessGoal: plan.businessGoal, weeklyStrategy: plan.weeklyStrategy, topics: plan.topics }
        : null,
    }),
  };
}

function createNoImageProvider(video: VideoGenerationProvider) {
  return {
    generateImage: async () => {
      throw new Error("image_provider_not_configured");
    },
    generateVideo: async () => {
      throw new Error("use the video provider");
    },
    pollVideo: async () => {
      throw new Error("use the video provider");
    },
    // The orchestrator only calls generateImage; the rest exist so the
    // MediaProvider type stays satisfied without a second config.
    name: video.name,
  };
}

/**
 * The estimated provider cost of one video job, from the ONE centralized
 * model (lib/mara/media-spend.ts). The deployment-level
 * MEDIA_VIDEO_ESTIMATED_COST_PER_SECOND_USD override is honoured there, so no
 * cost constant is duplicated in this module.
 */
export function estimatedCostUsdForDuration(durationSeconds: number, env: NodeJS.ProcessEnv = process.env): number {
  return estimateMediaCostUsd({ mediaType: "video", durationSeconds, env });
}

export function monthlySpendLimitUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.MEDIA_MONTHLY_SPEND_LIMIT_USD?.trim();
  if (!raw) return null;
  const limit = Number(raw);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** The newest generation job for a draft (any status), owner-scoped. */
export async function latestVideoGeneration(admin: AdminClient, ownerId: string, draftId: string): Promise<VideoJobRow | null> {
  const { data, error } = await admin.from("mara_media_generations")
    .select(VIDEO_JOB_SELECT)
    .eq("owner_user_id", ownerId)
    .eq("draft_id", draftId)
    .eq("media_type", "video")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("video_job_read_failed");
  return (data as Record<string, unknown> | null) ? (data as unknown as VideoJobRow) : null;
}

/** One generation job by id (any status), owner-scoped. */
export async function findVideoGeneration(admin: AdminClient, ownerId: string, generationId: string): Promise<VideoJobRow | null> {
  const { data, error } = await admin.from("mara_media_generations")
    .select(VIDEO_JOB_SELECT)
    .eq("owner_user_id", ownerId)
    .eq("id", generationId)
    .maybeSingle();
  if (error) throw new Error("video_job_read_failed");
  return (data as Record<string, unknown> | null) ? (data as unknown as VideoJobRow) : null;
}

export interface HardTimeoutEnforcement {
  /** True when THIS call moved the row into its terminal timeout state. */
  enforced: boolean;
  /** The row as it is now (terminal), or null when it does not exist. */
  row: VideoJobRow | null;
}

/**
 * Enforces the durable video job's hard timeout with a DATABASE write only —
 * no provider call, no new job, no charge.
 *
 * Why this exists separately from `advanceVideoGeneration`: advancing needs the
 * whole provider stack (video config, brand context, polling), so a job that
 * outlived its hard timeout while that stack was unavailable stayed
 * `generating/pending` forever — the production incident behind this helper.
 * The hard timeout is a Voom-side lifetime rule, so Voom can always persist it.
 *
 * Guarantees:
 *   - only an ACTIVE row that `staleDecision` calls a timeout is touched (the
 *     status guard means concurrent callers cannot both transition it),
 *   - the row keeps its provider job id, its provider metadata and its history:
 *     it becomes terminal, it is never deleted or rewritten,
 *   - the draft's stored asset (if any) is untouched, and nothing is published.
 */
export async function enforceVideoJobHardTimeout(
  admin: AdminClient,
  ownerId: string,
  generationId: string,
  options: { now?: number } = {},
): Promise<HardTimeoutEnforcement> {
  const row = await findVideoGeneration(admin, ownerId, generationId);
  if (!row) return { enforced: false, row: null };
  if (!isActiveVideoState(row.status)) return { enforced: false, row };

  const nowMs = options.now ?? Date.now();
  const clock = {
    nowMs,
    createdAtMs: Date.parse(row.created_at) || nowMs,
    updatedAtMs: Date.parse(row.updated_at) || nowMs,
  };
  if (staleDecision(row.status, clock) !== "timeout") return { enforced: false, row };

  const { data, error } = await admin.from("mara_media_generations")
    .update({
      status: "failed",
      error_code: VIDEO_JOB_TIMEOUT_ERROR_CODE,
      // Bounded, server-only diagnostic: our own enforcement facts, never
      // credentials and never a raw provider payload.
      provider_diagnostic: {
        code: VIDEO_JOB_TIMEOUT_ERROR_CODE,
        reason: "hard_timeout_exceeded",
        limitMinutes: VIDEO_JOB_TIMEOUT_MINUTES,
        jobAgeMinutes: Math.round((nowMs - clock.createdAtMs) / 60_000),
        providerStatus: row.provider_status ?? null,
        enforcedAt: new Date(nowMs).toISOString(),
      },
    })
    .eq("id", generationId)
    .eq("owner_user_id", ownerId)
    .in("status", ACTIVE_VIDEO_STATES)
    .select(VIDEO_JOB_SELECT)
    .maybeSingle();
  if (error) throw new Error("video_job_update_failed");
  const updated = (data as Record<string, unknown> | null) ? (data as unknown as VideoJobRow) : null;
  if (updated) return { enforced: true, row: updated };
  // The status guard matched nothing: another caller moved the row first (it
  // may even have completed while we were writing). Report the row as it
  // actually is now — never a synthesised guess.
  const current = await findVideoGeneration(admin, ownerId, generationId);
  return { enforced: false, row: current ?? row };
}

export type StartJobInput = Omit<StartInput, "ownerId" | "providerName" | "supportsImageToVideo" | "estimatedCostUsd" | "monthlySpendLimitUsd">;

export async function startVideoJob(service: VideoService, input: StartJobInput & { durationTarget: number }): Promise<StartResult & { view: ClientGenerationView | null }> {
  const { durationTarget, ...rest } = input;
  const result: StartResult = await startVideoGeneration(service.ports, {
    ...rest,
    ownerId: service.ownerId,
    providerName: service.videoConfig.provider,
    supportsImageToVideo: service.videoConfig.supportsImageToVideo,
    // OpenRouter V1 pins the billable request to its six-second default;
    // legacy providers retain the planner's requested duration.
    estimatedCostUsd: estimatedCostUsdForDuration(service.videoConfig.durationSeconds ?? durationTarget),
    monthlySpendLimitUsd: monthlySpendLimitUsd(),
    // The audited source travels into the durable job row.
    source: input.source ?? "user_request",
  });
  if (!result.ok) return { ...result, view: "generation" in result ? toClientGenerationView(result.generation, null) : null };
  const previewUrl = result.generation.status === "completed" && typeof result.generation.storage_path === "string" ? await service.ports.signPreview(result.generation.storage_path) : null;
  return { ...result, view: toClientGenerationView(result.generation, previewUrl) };
}

export async function advanceVideoJob(service: VideoService, draftId: string, generationId: string, kind: "reel" | "story"): Promise<AdvanceResult & { view: ClientGenerationView | null }> {
  const result = await advanceVideoGeneration(service.ports, service.ownerId, generationId, kind);
  if (!result.ok) return { ...result, view: null };
  // The validated video arriving late must re-sync an approved item's
  // schedule: its queue row moves from 'waiting_for_media' to 'scheduled' so
  // the item publishes instead of silently dying with a dead schedule.
  if (result.attached) await syncPostToCalendar(service.admin, service.ownerId, draftId).catch(() => null);
  return { ...result, view: toClientGenerationView(result.generation, result.previewUrl) };
}

export interface PostStudioVideoStartArgs {
  admin: AdminClient;
  ownerId: string;
  post: {
    id: string;
    kind: "reel" | "story";
    conversationId: string;
    concept: string;
  };
  brief: string;
  idempotencyToken: string;
  /**
   * AI media spend control: what caused this job. Defaults to `user_request`
   * because every caller of this entry point is a user action ("Create with
   * MARA" / "Regenerate"); the workflow media path passes the automatic
   * source it resolved from the account's mode.
   */
  source?: MediaSource;
  /** MARA's plan script for plan-driven Reels (the Reel approval flow). */
  script?: string;
  /**
   * Explicit source image (plan-Reel asset packs live in a different table
   * than the draft's own asset). `undefined` = auto-resolve the draft's own
   * image asset; `null` = force no source image; a value = use exactly it.
   */
  sourceAsset?: { storagePath: string; assetId: string | null } | null;
}

export type PostStudioVideoStartResult =
  | { status: 200 | 202; generation: ClientGenerationView; message: string }
  | { status: number; error: string; generation: ClientGenerationView | null };

/**
 * One entry point for "Create with MARA" (and regenerate) video jobs from
 * Post Studio: Post Studio video drafts are Reel or Story 9:16 videos.
 * Repeated clicks with the same token resolve to the same job.
 */
export async function startPostStudioVideo(args: PostStudioVideoStartArgs): Promise<PostStudioVideoStartResult> {
  const { admin, ownerId, post } = args;
  const service = await buildVideoService(admin, ownerId);
  if (!service) {
    return { status: 503, error: "Create with MARA is temporarily unavailable. Your previous asset is unchanged.", generation: null };
  }
  let idempotencyKey: string;
  try {
    idempotencyKey = videoIdempotencyKey("post", post.id, args.idempotencyToken);
  } catch {
    return { status: 400, error: "That request was not valid.", generation: null };
  }
  const resolvedSource = args.sourceAsset === undefined ? await findSourceImageAsset(admin, ownerId, post.id) : args.sourceAsset;
  const result = await startVideoJob(service, {
    draftId: post.id,
    conversationId: post.conversationId,
    scope: "post",
    kind: post.kind,
    concept: post.concept,
    script: args.script ?? post.concept,
    brief: args.brief,
    idempotencyKey,
    sourceAsset: resolvedSource,
    // Explicit user entry point: recorded as user_request unless the caller
    // (the workflow media path) already resolved an automatic source.
    source: args.source ?? "user_request",
    durationTarget: 8,
  });
  if (!result.ok) {
    return {
      status: result.status,
      error: result.message,
      generation: "generation" in result ? result.view ?? toClientGenerationView(result.generation, null) : null,
    };
  }
  return {
    status: result.created ? 202 : 200,
    generation: result.view ?? toClientGenerationView(result.generation, null),
    message: result.created
      ? "MARA started generating this video. This can take a few minutes. Nothing was published."
      : "This generation was already started, so no new job was created.",
  };
}

/**
 * The draft's own image asset is the source for asset-assisted (image-to-
 * video) generation. A video visual never seeds a video job.
 */
export async function findSourceImageAsset(admin: AdminClient, ownerId: string, draftId: string): Promise<{ storagePath: string; assetId: string | null } | null> {
  const { data } = await admin.from("post_draft_assets")
    .select("id,storage_path,mime_type,status")
    .eq("owner_user_id", ownerId)
    .eq("draft_id", draftId)
    .maybeSingle();
  if (!data || data.status !== "uploaded") return null;
  const mime = String(data.mime_type ?? "");
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return null;
  if (typeof data.storage_path !== "string") return null;
  return { storagePath: data.storage_path, assetId: typeof data.id === "string" ? data.id : null };
}
