import "server-only";

import { randomUUID } from "node:crypto";
import { createMediaProvider, getMediaConfig, MediaError } from "@/lib/media";
import { aspectMatches, inspectImageBytes } from "@/lib/media/media-inspect";
import { putPostAsset, removePostAssetObject, type AdminClient } from "@/lib/post/server-data";
import { startPostStudioVideo } from "@/lib/mara/video-service";
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
 * Duplicate-charge protection: a generation is started only when the draft has
 * no stored visual and no live job. Retrying a failed item reuses the same
 * idempotency identity for video jobs, so a retry cannot double-bill.
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

/** True when the draft already owns stored bytes or has a live generation. */
export async function mediaAlreadyHandled(admin: AdminClient, ownerId: string, draftId: string): Promise<boolean> {
  const [{ data: asset }, { data: live }] = await Promise.all([
    admin.from("post_draft_assets").select("id").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle(),
    admin.from("mara_media_generations").select("id")
      .eq("owner_user_id", ownerId).eq("draft_id", draftId).in("status", ["queued", "processing"]).limit(1).maybeSingle(),
  ]);
  return Boolean(asset?.id || live?.id);
}

export async function ensureWorkflowMedia(admin: AdminClient, request: MediaRequest): Promise<MediaOutcome> {
  if (await mediaAlreadyHandled(admin, request.ownerId, request.draftId)) return { ok: true, state: "exists" };

  if (request.contentType === "reel") {
    const result = await startPostStudioVideo({
      admin,
      ownerId: request.ownerId,
      post: { id: request.draftId, kind: "reel", conversationId: request.conversationId, concept: request.concept },
      brief: request.visualBrief,
      // Stable per-draft token: a retry reuses the same job identity instead of
      // paying for a second generation.
      idempotencyToken: `workflow-${request.draftId}`,
    });
    if ("error" in result) return { ok: false, code: "video_start_failed" };
    return { ok: true, state: "queued" };
  }

  return generateWorkflowImage(admin, request);
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
