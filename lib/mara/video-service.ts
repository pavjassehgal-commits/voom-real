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
    name: video.name,
  };
}

export function estimatedCostUsdForDuration(durationSeconds: number, env: NodeJS.ProcessEnv = process.env): number {
  return estimateMediaCostUsd({ mediaType: "video", durationSeconds, env });
}

export function monthlySpendLimitUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.MEDIA_MONTHLY_SPEND_LIMIT_USD?.trim();
  if (!raw) return null;
  const limit = Number(raw);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

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
  enforced: boolean;
  row: VideoJobRow | null;
}

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
    estimatedCostUsd: estimatedCostUsdForDuration(service.videoConfig.durationSeconds ?? durationTarget),
    monthlySpendLimitUsd: monthlySpendLimitUsd(),
    source: input.source ?? "user_request",
  });
  if (!result.ok) return { ...result, view: "generation" in result ? toClientGenerationView(result.generation, null) : null };
  const previewUrl = result.generation.status === "completed" && typeof result.generation.storage_path === "string" ? await service.ports.signPreview(result.generation.storage_path) : null;
  return { ...result, view: toClientGenerationView(result.generation, previewUrl) };
}

export async function advanceVideoJob(service: VideoService, draftId: string, generationId: string, kind: "reel" | "story"): Promise<AdvanceResult & { view: ClientGenerationView | null }> {
  const result = await advanceVideoGeneration(service.ports, service.ownerId, generationId, kind);
  if (!result.ok) return { ...result, view: null };
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
  source?: MediaSource;
  script?: string;
  sourceAsset?: { storagePath: string; assetId: string | null } | null;
  /** Optional pre-generated ledger id to avoid double reservation (used by Post Studio route). */
  generationId?: string;
}

export type PostStudioVideoStartResult =
  | { status: 200 | 202; generation: ClientGenerationView; message: string }
  | { status: number; error: string; generation: ClientGenerationView | null };

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
    source: args.source ?? "user_request",
    durationTarget: 8,
    generationId: args.generationId,
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
