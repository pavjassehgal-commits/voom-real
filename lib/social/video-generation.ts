import "server-only";
import { randomUUID } from "node:crypto";
import { parseWorkflowSlotIdentity } from "@/lib/voom/workflow/channel-planner";
import { removePostAssetObject, type AdminClient } from "@/lib/post/server-data";
import { buildVideoService, latestVideoGeneration, startVideoJob, type VideoService } from "@/lib/mara/video-service";
import { isNativeVideoKind, type VideoGenerationPorts, type VideoJobRow } from "@/lib/mara/video-generation";
import { isActiveVideoState, videoIdempotencyKey } from "@/lib/mara/video-job";
import { toClientGenerationView } from "@/lib/mara/video-view";
import { MediaError } from "@/lib/media/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Exact owner + UUID + immutable native assignment. No date fallback. */
export async function loadNativePlanVideoDraft(admin: AdminClient, ownerId: string, draftId: string) {
  if (!UUID.test(draftId)) return null;
  const { data, error } = await admin.from("mara_drafts")
    .select("id,kind,owner_user_id,conversation_id,title,content,content_meta,status,source_plan_id,source_plan_item_key,social_channel,social_format")
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (error) throw new Error("native_video_read_failed");
  if (!data || !isNativeVideoKind(data.kind) || !data.source_plan_id || data.status === "rejected") return null;
  const key = parseWorkflowSlotIdentity(data.source_plan_item_key);
  const channel = data.kind === "tiktok_video" ? "tiktok" : "youtube";
  const format = data.kind === "tiktok_video" ? "video" : "short";
  if (!key || (!key.legacy && (key.channel !== channel || key.format !== format))
    || data.social_channel !== channel || data.social_format !== format) return null;
  return { ...data, kind: data.kind as "tiktok_video" | "youtube_short" };
}

/** Only the native adapter supplies the atomic hooks; Instagram stays unchanged. */
export function nativeVideoPorts(admin: AdminClient, base: VideoGenerationPorts, generationId: string): VideoGenerationPorts {
  let reservedOwner: string | null = null;
  return {
    ...base,
    async createVideoJob(input) {
      // Persist intent before crossing the non-transactional provider boundary.
      const ownerId = reservedOwner;
      if (!ownerId) throw new Error("native_video_job_unavailable");
      if (!await base.updateGeneration(ownerId, generationId, { provider_status: "submitting" }, ["queued"])) {
        throw new Error("native_video_submission_not_reserved");
      }
      try { return await base.createVideoJob(input); }
      catch (reason) {
        // A definite rejection is safely refundable. Network/5xx/malformed
        // responses may hide an accepted paid job: preserve its reservation.
        const rejected = reason instanceof MediaError && ["rejected", "rate_limited", "not_configured", "unsupported_input", "insufficient_credits"].includes(reason.code);
        await base.updateGeneration(ownerId, generationId, { provider_status: rejected ? "rejected" : "submission_uncertain" }, ["queued"]);
        throw reason;
      }
    },
    async updateGeneration(ownerId, id, patch, statuses) {
      if (patch.status === "failed") {
        const row = await base.findGeneration(ownerId, id);
        if (!row?.provider_job_id && ["submitting", "submission_uncertain"].includes(row?.provider_status ?? "")) {
          patch = { ...patch, error_code: "submission_uncertain" };
        }
      }
      return base.updateGeneration(ownerId, id, patch, statuses);
    },
    async prepareGeneration(input) {
      const result = await admin.rpc("begin_native_video_generation", {
        p_owner: input.ownerId, p_draft: input.draftId, p_generation: input.generationId, p_key: input.idempotencyKey,
      });
      if (result.error) throw new Error("native_video_reservation_failed");
      if (result.data === true) reservedOwner = input.ownerId;
      return result.data === true;
    },
    async insertGeneration(row) {
      const updated = await base.updateGeneration(String(row.owner_user_id), String(row.id), row, ["queued"]);
      return updated ? "inserted" : "error";
    },
    async refundCredits(ownerId, id) {
      // Pre-provider failures release the early lease as well as the credits.
      const row = await base.findGeneration(ownerId, id);
      if (!row?.provider_job_id && ["submitting", "submission_uncertain"].includes(row?.provider_status ?? "")) return;
      if (row?.status === "queued" && !row.provider_job_id) {
        await base.updateGeneration(ownerId, id, { status: "failed", error_code: "unavailable" }, ["queued"]);
      }
      await base.refundCredits?.(ownerId, id);
    },
    async storeFinalAsset(ownerId, draftId, input) {
      if (!await loadNativePlanVideoDraft(admin, ownerId, draftId)) throw new Error("native_video_draft_unavailable");
      const previous = await admin.from("post_draft_assets").select("storage_path")
        .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
      if (previous.error) throw new Error("native_video_asset_read_failed");
      const path = `${ownerId}/native-video/${draftId}/${generationId}.mp4`;
      const stored = await admin.storage.from("mara-media").upload(path, input.bytes, { contentType: "video/mp4", upsert: true });
      if (stored.error) throw new Error("native_video_storage_failed");
      // No asset row is linked until the completion RPC commits both records.
      return { storagePath: path, previousStoragePath: previous.data?.storage_path ?? null };
    },
    async completeGeneration(ownerId, id, input) {
      const result = await admin.rpc("complete_native_video_generation", {
        p_owner: ownerId, p_generation: id, p_path: input.storagePath, p_bytes: input.byteSize,
        p_duration: input.durationSeconds, p_name: input.displayName,
      });
      if (result.error || result.data !== true) return null;
      return base.findGeneration(ownerId, id);
    },
    removeAbandonedObject: (ownerId, path) => removePostAssetObject(admin, ownerId, path),
  };
}

export async function nativeGenerationView(admin: AdminClient, row: VideoJobRow | null) {
  if (!row) return null;
  let preview: string | null = null;
  if (row.status === "completed" && row.storage_path?.startsWith(`${row.owner_user_id}/`)) {
    const signed = await admin.storage.from("mara-media").createSignedUrl(row.storage_path, 600);
    preview = signed.data?.signedUrl ?? null;
  }
  return toClientGenerationView(row, preview);
}

export async function startNativePlanVideo(admin: AdminClient, ownerId: string, draftId: string, token: string,
  deps: { buildService?: typeof buildVideoService } = {}) {
  const draft = await loadNativePlanVideoDraft(admin, ownerId, draftId);
  if (!draft) return { status: 404, error: "That TikTok or YouTube Shorts recommendation was not found." };
  if (!UUID.test(token)) return { status: 400, error: "That generation request was not valid." };
  const key = videoIdempotencyKey("post", draftId, token);
  const latest = await latestVideoGeneration(admin, ownerId, draftId);
  if (latest && !latest.provider_job_id && ["submitting", "submission_uncertain"].includes(latest.provider_status ?? "")) {
    return { status: 409, error: "The provider may have accepted this generation. Its credits remain reserved; Voom will not submit another paid job until this attempt is reconciled.",
      generation: await nativeGenerationView(admin, latest) };
  }
  if (latest && isActiveVideoState(latest.status)) {
    return { status: 200, generation: await nativeGenerationView(admin, latest), message: "Generation is already running. Nothing new was started or charged." };
  }
  const service = await (deps.buildService ?? buildVideoService)(admin, ownerId);
  if (!service) return { status: 503, error: "MARA video generation is not configured. Nothing was charged." };
  const existing = await service.ports.findGenerationByIdempotency(ownerId, key);
  if (existing) return { status: 200, generation: await nativeGenerationView(admin, existing), message: "This generation request was already handled. Nothing new was charged." };
  const generationId = randomUUID();
  const native: VideoService = { ...service, ports: nativeVideoPorts(admin, service.ports, generationId) };
  const meta = draft.content_meta && typeof draft.content_meta === "object" ? draft.content_meta as Record<string, unknown> : {};
  const script = Array.isArray(meta.script) ? meta.script.filter((v): v is string => typeof v === "string").join("\n") : "";
  const result = await startVideoJob(native, {
    draftId, conversationId: String(draft.conversation_id), scope: "post", kind: draft.kind,
    concept: String(draft.title), script, brief: String(meta.productionGuidance ?? meta.concept ?? draft.title),
    idempotencyKey: key, sourceAsset: null, source: "user_request", durationTarget: 6, generationId,
  });
  if (!result.ok) {
    const row = result.view ? null : await service.ports.findGeneration(ownerId, generationId);
    const view = result.view ?? await nativeGenerationView(admin, row);
    return { status: result.status, error: row?.error_code === "submission_uncertain" ? view?.safeError ?? result.message : result.message, generation: view };
  }
  return { status: result.created ? 202 : 200, generation: result.view,
    message: "MARA is generating this recommendation's video. Review and explicitly approve it when ready. Nothing was queued or published." };
}
