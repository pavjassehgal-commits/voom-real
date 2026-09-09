import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAiProvider } from "@/lib/ai";
import { detectReelAsset } from "@/lib/media/reel-asset";
import type { GeneratedMedia, MediaAspectRatio } from "@/lib/media/types";
import type { MediaProvider } from "@/lib/media/types";
import {
  buildMediaPlanContext,
  REEL_VIDEO_SYSTEM_PROMPT,
  STORY_VIDEO_SYSTEM_PROMPT,
  reelVideoPlanSchema,
  storyVideoPlanSchema,
  type ReelVideoPlan,
  type StoryVideoPlan,
} from "@/lib/mara/media-plan";
import { removePostAssetObject, putPostAsset } from "@/lib/post/server-data";
import type {
  StoredReferenceImage,
  VideoGenerationPorts,
  VideoJobRow,
  VideoPlanResult,
} from "./video-generation";
import { VIDEO_JOB_SELECT } from "./video-generation";
import type { ReferenceImage, VideoJobPoll, VideoGenerationProvider } from "@/lib/media/video-provider";

export const MEDIA_GENERATIONS_TABLE = "mara_media_generations";
const POST_ASSET_BUCKET = "mara-media";
const PREVIEW_TTL_SECONDS = 600;

export interface VideoPortDependencies {
  admin: SupabaseClient;
  provider: VideoGenerationProvider;
  imageProvider: MediaProvider;
  brand: {
    name: string;
    description: string;
    industry: string;
    targetCustomer: string;
    mainGoal: string;
    brandPersonality: string;
  };
  plan: { businessGoal: string; weeklyStrategy: string; topics: string[] } | null;
}

/**
 * Wires the durable Supabase records, the AI planner and the media providers
 * into the port interface. Everything owner-scoped; every query carries the
 * owner id so RLS and application checks agree.
 */
export function buildVideoGenerationPorts(deps: VideoPortDependencies): VideoGenerationPorts {
  const { admin, provider, imageProvider, brand, plan } = deps;

  const readRow = (data: Record<string, unknown> | null): VideoJobRow | null => {
    if (!data) return null;
    return data as unknown as VideoJobRow;
  };

  return {
    now: () => Date.now(),

    async findActiveGeneration(ownerId, draftId) {
      const { data, error } = await admin.from(MEDIA_GENERATIONS_TABLE)
        .select(VIDEO_JOB_SELECT)
        .eq("owner_user_id", ownerId)
        .eq("draft_id", draftId)
        .in("status", ["queued", "generating", "processing"])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("video_job_read_failed");
      return readRow((data as Record<string, unknown> | null) ?? null);
    },

    async findGeneration(ownerId, id) {
      const { data, error } = await admin.from(MEDIA_GENERATIONS_TABLE)
        .select(VIDEO_JOB_SELECT)
        .eq("owner_user_id", ownerId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error("video_job_read_failed");
      return readRow((data as Record<string, unknown> | null) ?? null);
    },

    async findGenerationByIdempotency(ownerId, key) {
      const { data, error } = await admin.from(MEDIA_GENERATIONS_TABLE)
        .select(VIDEO_JOB_SELECT)
        .eq("owner_user_id", ownerId)
        .eq("idempotency_key", key)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("video_job_read_failed");
      return readRow((data as Record<string, unknown> | null) ?? null);
    },

    async countRecentJobs(ownerId, sinceIso) {
      const { count, error } = await admin.from(MEDIA_GENERATIONS_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("owner_user_id", ownerId)
        .gte("updated_at", sinceIso)
        .in("status", ["queued", "generating", "processing", "completed"]);
      if (error) throw new Error("video_job_count_failed");
      return count ?? 0;
    },

    async sumMonthlyVideoCost(ownerId, monthStartIso) {
      const { data, error } = await admin.from(MEDIA_GENERATIONS_TABLE)
        .select("estimated_cost_usd")
        .eq("owner_user_id", ownerId)
        .eq("media_type", "video")
        .gte("created_at", monthStartIso)
        .in("status", ["queued", "generating", "processing", "completed"]);
      if (error) throw new Error("video_job_cost_failed");
      return (data ?? []).reduce((total: number, row) => total + Number((row as { estimated_cost_usd?: unknown }).estimated_cost_usd ?? 0), 0);
    },

    async insertGeneration(row) {
      const { error } = await admin.from(MEDIA_GENERATIONS_TABLE).insert(row);
      if (!error) return "inserted";
      const code = String(error.code ?? "");
      const message = String(error.message ?? "").toLowerCase();
      if (code === "23505") {
        if (message.includes("mara_media_active_per_draft_uq")) return "active_conflict";
        return "idempotency_conflict";
      }
      return "error";
    },

    async updateGeneration(ownerId, id, patch, whereStatuses) {
      let query = admin.from(MEDIA_GENERATIONS_TABLE).update(patch).eq("owner_user_id", ownerId).eq("id", id);
      if (whereStatuses && whereStatuses.length) query = query.in("status", whereStatuses);
      const { data, error } = await query.select(VIDEO_JOB_SELECT).maybeSingle();
      if (error) throw new Error("video_job_update_failed");
      return readRow((data as Record<string, unknown> | null) ?? null);
    },

    async planMedia(input): Promise<VideoPlanResult> {
      const contentType = input.contentType;
      const systemPrompt = contentType === "reel" ? REEL_VIDEO_SYSTEM_PROMPT : STORY_VIDEO_SYSTEM_PROMPT;
      const context = buildMediaPlanContext({
        brand,
        plan,
        contentType,
        concept: input.concept,
        script: input.script,
        brief: input.brief,
        hasSourceImage: input.hasSourceImage,
      });
      const parsed = await createAiProvider().structured({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(context) },
        ],
        temperature: 0.6,
        maxTokens: 900,
        parse: (value) => (contentType === "reel" ? reelVideoPlanSchema.parse(value) : storyVideoPlanSchema.parse(value)),
      });
      if (contentType === "reel") {
        const reel = parsed as unknown as ReelVideoPlan;
        return {
          concept: reel.concept,
          visualPrompt: reel.visualPrompt,
          motionDirection: reel.motionDirection,
          durationSeconds: reel.durationSeconds,
          overlayJson: JSON.stringify(reel.overlayCopy),
          cta: reel.cta,
        };
      }
      const story = parsed as unknown as StoryVideoPlan;
      return {
        concept: story.concept,
        visualPrompt: story.visualPrompt,
        motionDirection: story.motionDirection,
        durationSeconds: story.durationSeconds,
        overlayJson: null,
        cta: null,
      };
    },

    async generateBaseImage(input: { prompt: string; aspectRatio: MediaAspectRatio }): Promise<GeneratedMedia> {
      return imageProvider.generateImage(input);
    },

    async createVideoJob(input: { prompt: string; durationSeconds: number; referenceImage: ReferenceImage | null; name: string }) {
      return provider.createVideoJob({
        prompt: input.prompt,
        aspectRatio: "9:16",
        durationSeconds: input.durationSeconds,
        referenceImage: input.referenceImage,
        name: input.name,
      });
    },

    async pollVideoJob(providerJobId): Promise<VideoJobPoll> {
      return provider.pollVideoJob(providerJobId);
    },

    async uploadBaseImage(ownerId, draftId, bytes, mimeType, extension) {
      const path = `${ownerId}/generated-base/${draftId}-${randomUUID().slice(0, 8)}.${extension}`;
      const { error } = await admin.storage.from(POST_ASSET_BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false });
      if (error) throw new Error("base_image_upload_failed");
      return path;
    },

    async loadReferenceImage(ownerId, storagePath, assetId): Promise<StoredReferenceImage | null> {
      if (!storagePath.startsWith(`${ownerId}/`)) return null;
      const { data, error } = await admin.storage.from(POST_ASSET_BUCKET).download(storagePath);
      if (error || !data) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      const detected = detectReelAsset(bytes);
      if (!detected || detected.kind !== "image") return null;
      const mimeType = detected.mimeType === "image/jpeg" ? "image/jpeg" : detected.mimeType === "image/png" ? "image/png" : "image/webp";
      const extension = detected.mimeType === "image/jpeg" ? "jpg" : detected.mimeType === "image/png" ? "png" : "webp";
      return { bytes, mimeType, extension, name: assetId ?? "source-image", assetId };
    },

    async storeFinalAsset(ownerId, draftId, input) {
      const result = await putPostAsset(admin, ownerId, draftId, {
        bytes: input.bytes,
        mimeType: input.mimeType,
        extension: input.extension,
        displayName: input.displayName,
        origin: "mara",
      });
      return { storagePath: result.storagePath, previousStoragePath: result.previousStoragePath };
    },

    async removeAbandonedObject(ownerId, storagePath) {
      await removePostAssetObject(admin, ownerId, storagePath);
    },

    async signPreview(storagePath) {
      const { data } = await admin.storage.from(POST_ASSET_BUCKET).createSignedUrl(storagePath, PREVIEW_TTL_SECONDS);
      return data?.signedUrl ?? null;
    },
  };
}
