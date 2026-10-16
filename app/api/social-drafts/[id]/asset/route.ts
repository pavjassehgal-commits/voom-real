import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/voom/server-data";
import { getSocialDraft, updateSocialDraft } from "@/lib/social/server-drafts";
import { POST_ASSET_MAX_BYTES, safePostAssetName } from "@/lib/post/asset";
import { putPostAsset, removePostAssetObject, verifyPostAssetStored } from "@/lib/post/server-data";
import { IngestionFailure, ingestionError, ingestionFailureResponse, logIngestionStage, requestIdFrom } from "@/lib/media/ingestion-error";
import { validateTikTokVideoUpload } from "@/lib/tiktok/video-upload";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stores one authenticated owner's MP4 privately; it never calls TikTok. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFrom(request, randomUUID());
  const user = await getCurrentUser();
  if (!user) return ingestionError("not_authenticated", "Please log in again.", 401, requestId);
  const { id } = await params;
  if (!UUID_RE.test(id)) return ingestionError("not_found", "That TikTok draft was not found.", 404, requestId);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > POST_ASSET_MAX_BYTES + 500_000) {
    return ingestionError("file_too_large", "Choose an MP4 up to 20 MB.", 413, requestId);
  }

  let form: FormData;
  try { form = await request.formData(); } catch {
    return ingestionError("invalid_file", "Choose one MP4 video.", 400, requestId);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) {
    return ingestionError("invalid_file", "Choose one MP4 video.", 400, requestId);
  }
  if (file.size > POST_ASSET_MAX_BYTES) {
    return ingestionError("file_too_large", "Choose an MP4 up to 20 MB.", 413, requestId);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validated = validateTikTokVideoUpload(bytes, file.name);
  if (!validated.ok) {
    if (validated.code === "too_large") return ingestionError("file_too_large", "Choose an MP4 up to 20 MB.", 413, requestId);
    return ingestionError("invalid_video", "That file isn't a valid MP4 video. Export it as MP4 and try again.", 400, requestId);
  }
  const detected = validated.detected;
  const diagnostic = {
    requestId,
    fileSize: file.size,
    detectedKind: detected.kind,
    detectedMime: detected.mimeType,
    extension: detected.extension,
  } as const;
  logIngestionStage("detected", { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension });

  const admin = createAdminClient();
  try {
    const draft = await getSocialDraft(admin, user.id, id);
    if (!draft || draft.kind !== "tiktok_video") {
      return ingestionError("ownership_failure", "Voom couldn't access that TikTok draft safely.", 404, requestId);
    }
    const { data: business, error: businessError } = await admin.from("businesses")
      .select("id").eq("owner_user_id", user.id).maybeSingle();
    if (businessError) throw new IngestionFailure("db_failure", "draft_read");
    if (!business) return ingestionError("ownership_failure", "Voom couldn't confirm this draft's business safely.", 404, requestId);

    // A TikTok confirmation covers a specific video. Replacing media therefore
    // withdraws consent and safely cancels any queue row TikTok does not own.
    // Provider-owned states fail closed inside updateSocialDraft.
    if (draft.status !== "draft" || draft.tiktokPost) {
      await updateSocialDraft(admin, user.id, id, { decision: "draft" });
    }

    const stored = await putPostAsset(admin, user.id, id, {
      bytes,
      mimeType: "video/mp4",
      extension: "mp4",
      displayName: safePostAssetName(file.name),
      origin: "existing_content",
    }, diagnostic);
    await verifyPostAssetStored(admin, user.id, id, stored.storagePath, diagnostic);
    if (stored.previousStoragePath && stored.previousStoragePath !== stored.storagePath) {
      await removePostAssetObject(admin, user.id, stored.previousStoragePath);
    }

    const updated = await getSocialDraft(admin, user.id, id);
    if (!updated?.asset) throw new IngestionFailure("db_failure", "stored");
    return Response.json({
      draft: updated,
      requestId,
      message: "Video stored privately in Voom. Review and confirm it before posting to TikTok.",
    }, { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
  } catch (reason) {
    const code = reason instanceof Error ? reason.message : "";
    if (code === "social_draft_provider_owned") {
      return ingestionError("action_required", "TikTok already owns this video, so it cannot be replaced.", 409, requestId);
    }
    if (code.includes("publish_cancel_failed") || code === "social_draft_queue_cancel_not_confirmed") {
      return ingestionError("db_failure", "Voom couldn't safely withdraw the previous TikTok queue item. Nothing was uploaded.", 503, requestId);
    }
    const failure = reason instanceof IngestionFailure ? reason : new IngestionFailure("db_failure", "db_upsert");
    logIngestionStage(failure.stage, { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension, code: failure.code });
    return ingestionFailureResponse(failure, requestId);
  }
}
