import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/voom/server-data";
import { allowedAssetKindsFor, isPostDraftKind, isPostOrigin, postAssetKindForMime, type PostOrigin } from "@/lib/post/core";
import { POST_ASSET_MAX_BYTES, describeAllowedKinds, detectPostAsset, safePostAssetName } from "@/lib/post/asset";
import {
  deletePostAsset,
  getPostDraftForIngestion,
  // The strict diagnostic read supersedes nullable getPostDraft(admin, user.id, id).
  putPostAsset,
  removePostAssetObject,
  verifyPostAssetStored,
  syncPostToCalendar,
  type PostAssetIngestionDiagnostics,
} from "@/lib/post/server-data";
import {
  IngestionFailure,
  ingestionError,
  ingestionFailureResponse,
  logIngestionStage,
  requestIdFrom,
  statusForIngestionCode,
} from "@/lib/media/ingestion-error";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestContext(request: Request) {
  const requestId = requestIdFrom(request, randomUUID());
  const headerSize = Number(request.headers.get("content-length") ?? 0);
  const fileSize = Number.isSafeInteger(headerSize) && headerSize > 0 ? headerSize : null;
  logIngestionStage("received", { requestId, fileSize });
  return { requestId, fileSize };
}

function failureFor(reason: unknown, fallbackStage: "draft_read" | "storage_upload" | "db_upsert" | "stored") {
  return reason instanceof IngestionFailure ? reason : new IngestionFailure("db_failure", fallbackStage);
}

function diagnostics(requestId: string, file: File, detected: { kind: "image" | "video"; mimeType: string; extension: string }): PostAssetIngestionDiagnostics {
  return {
    requestId,
    fileSize: file.size,
    detectedKind: detected.kind,
    detectedMime: detected.mimeType,
    extension: detected.extension,
  };
}

/**
 * Uploads a user's own image (Instagram Post), or an existing image/video
 * (Existing content ingestion). The bytes are stored exactly as received:
 * no re-encode, no resize, and no provider call of any kind.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId } = requestContext(request);
  const user = await getCurrentUser();
  if (!user) return ingestionError("not_authenticated", "Please log in again.", 401, requestId);
  const { id } = await params;
  if (!UUID_RE.test(id)) return ingestionError("not_found", "That post was not found.", 404, requestId);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > POST_ASSET_MAX_BYTES + 500_000) {
    return ingestionError("file_too_large", "That file is too large. Choose one file up to 20 MB.", 413, requestId);
  }

  let form: FormData;
  try { form = await request.formData(); } catch { return ingestionError("invalid_file", "Choose one valid file.", 400, requestId); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return ingestionError("invalid_file", "Choose one valid file.", 400, requestId);
  if (file.size > POST_ASSET_MAX_BYTES) return ingestionError("file_too_large", "That file is too large. Choose one file up to 20 MB.", 413, requestId);

  const rawOrigin = form.get("origin");

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Magic bytes plus the original filename so a `qt`-branded MP4 stays an MP4.
  const detected = detectPostAsset(bytes, file.name);
  logIngestionStage("detected", {
    requestId,
    fileSize: file.size,
    kind: detected?.kind ?? null,
    mimeType: detected?.mimeType ?? null,
    extension: detected?.extension ?? null,
    code: detected ? undefined : (/\.mov$/i.test(file.name) ? "invalid_video" : "unsupported_format"),
  });
  if (!detected) {
    if (/\.mov$/i.test(file.name)) {
      return ingestionError("invalid_video", "That MOV isn't a QuickTime container we can store. Export it as MP4 and try again.", 400, requestId);
    }
    return ingestionError("unsupported_format", "Use JPEG, PNG, WebP, MP4, or MOV only.", 400, requestId);
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    const failure = new IngestionFailure("db_failure", "draft_read");
    logIngestionStage("draft_read", { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension, code: failure.code });
    return ingestionFailureResponse(failure, requestId);
  }

  let post;
  try {
    post = await getPostDraftForIngestion(admin, user.id, id, "draft_read");
  } catch (reason) {
    const failure = failureFor(reason, "draft_read");
    logIngestionStage(failure.stage, { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension, code: failure.code });
    return ingestionFailureResponse(failure, requestId);
  }
  if (!post) {
    logIngestionStage("draft_read", { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension, code: "ownership_failure" });
    return ingestionError("ownership_failure", "Voom couldn't access that draft safely. Please retry.", 404, requestId);
  }
  logIngestionStage("draft_read", { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension });
  if (!isPostDraftKind(post.kind)) return ingestionError("invalid_file", "That content type is not available.", 400, requestId);

  // Imported Reels and explicit existing-content uploads persist as
  // uploaded_existing; own-asset / MARA Post uploads persist as uploaded_asset.
  const origin: PostOrigin = rawOrigin === "existing_content" || post.kind === "reel" ? "existing_content" : "own_asset";
  if (!isPostOrigin(origin)) return ingestionError("invalid_file", "Choose a valid source for this file.", 400, requestId);

  const allowed = allowedAssetKindsFor(post.kind);
  const assetKind = postAssetKindForMime(detected.mimeType);
  if (!assetKind || !allowed.includes(assetKind)) {
    const wanted = post.kind === "reel" ? "video" : "image";
    return ingestionError("action_required", `This ${wanted === "video" ? "Reel" : "Instagram Post"} needs ${describeAllowedKinds(allowed)}.`, 400, requestId);
  }

  // The format is deliberately NOT read from the upload: the draft's persisted
  // format is the source of truth, so an upload can never overwrite it.
  // Storage failures retain the safe wording: Voom couldn't store that file safely. Nothing changed.
  // Their stable code is "storage_failure".
  const diagnostic = diagnostics(requestId, file, detected);
  let stored: { storagePath: string; previousStoragePath: string | null };
  try {
    stored = await putPostAsset(admin, user.id, id, {
      bytes,
      mimeType: detected.mimeType,
      extension: detected.extension,
      displayName: safePostAssetName(file.name),
      origin,
    }, diagnostic);
    await verifyPostAssetStored(admin, user.id, id, stored.storagePath, diagnostic);
  } catch (reason) {
    const failure = failureFor(reason, "db_upsert");
    // The helper logs its precise stage. This fallback log also covers an
    // unexpected SDK failure without serializing the caught error.
    logIngestionStage(failure.stage, { ...diagnostic, code: failure.code });
    return ingestionFailureResponse(failure, requestId, statusForIngestionCode(failure.code));
  }

  const { storagePath, previousStoragePath } = stored;
  // Only drop the replaced object, and never the one just written.
  if (previousStoragePath && previousStoragePath !== storagePath) {
    await removePostAssetObject(admin, user.id, previousStoragePath);
  }

  // A late-arriving visual can complete an already-approved, already-scheduled
  // post, so the auto-publish queue is re-synced here too.
  await syncPostToCalendar(admin, user.id, id).catch(() => null);

  try {
    const updated = await getPostDraftForIngestion(admin, user.id, id, "stored");
    if (!updated) {
      const failure = new IngestionFailure("ownership_failure", "stored");
      logIngestionStage("stored", { ...diagnostic, code: failure.code });
      return ingestionFailureResponse(failure, requestId);
    }
    logIngestionStage("stored", diagnostic);
    return Response.json({
      post: updated,
      requestId,
      message: origin === "existing_content"
        ? "Existing content stored privately in Voom. Nothing was published."
        : "Your image is stored privately in Voom, unchanged. Nothing was published.",
    }, { headers: { "X-Request-Id": requestId } });
  } catch (reason) {
    const failure = failureFor(reason, "stored");
    logIngestionStage(failure.stage, { ...diagnostic, code: failure.code });
    return ingestionFailureResponse(failure, requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId } = requestContext(request);
  const user = await getCurrentUser();
  if (!user) return ingestionError("not_authenticated", "Please log in again.", 401, requestId);
  const { id } = await params;
  if (!UUID_RE.test(id)) return ingestionError("not_found", "That post was not found.", 404, requestId);
  const admin = createAdminClient();
  try {
    const storagePath = await deletePostAsset(admin, user.id, id);
    if (storagePath) await removePostAssetObject(admin, user.id, storagePath);
    const post = await getPostDraftForIngestion(admin, user.id, id, "stored");
    if (!post) return ingestionError("ownership_failure", "Voom couldn't access that draft safely. Please retry.", 404, requestId);
    return Response.json({ post, requestId, message: "Visual removed. Nothing was published." }, { headers: { "X-Request-Id": requestId } });
  } catch {
    return ingestionError("db_failure", "Voom couldn't save that asset to your content. Nothing changed.", 503, requestId);
  }
}
