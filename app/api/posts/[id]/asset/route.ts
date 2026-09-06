import { getCurrentUser } from "@/lib/voom/server-data";
import { allowedAssetKindsFor, isPostDraftKind, isPostOrigin, postAssetKindForMime, type PostOrigin } from "@/lib/post/core";
import { POST_ASSET_MAX_BYTES, describeAllowedKinds, detectPostAsset, safePostAssetName } from "@/lib/post/asset";
import { deletePostAsset, getPostDraft, putPostAsset, removePostAssetObject } from "@/lib/post/server-data";
import { ingestionError } from "@/lib/media/ingestion-error";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Uploads a user's own image (Instagram Post), or an existing image/video
 * (Existing content ingestion). The bytes are stored exactly as received:
 * no re-encode, no resize, and no provider call of any kind.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return ingestionError("not_authenticated", "Please log in again.", 401);
  const { id } = await params;
  if (!UUID_RE.test(id)) return ingestionError("not_found", "That post was not found.", 404);

  const admin = createAdminClient();
  const post = await getPostDraft(admin, user.id, id);
  if (!post) return ingestionError("not_found", "That post was not found.", 404);
  if (!isPostDraftKind(post.kind)) return ingestionError("invalid_file", "That content type is not available.", 400);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > POST_ASSET_MAX_BYTES + 500_000) {
    return ingestionError("file_too_large", "That file is too large. Choose one file up to 20 MB.", 413);
  }

  let form: FormData;
  try { form = await request.formData(); } catch { return ingestionError("invalid_file", "Choose one valid file.", 400); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return ingestionError("invalid_file", "Choose one valid file.", 400);
  if (file.size > POST_ASSET_MAX_BYTES) return ingestionError("file_too_large", "That file is too large. Choose one file up to 20 MB.", 413);

  const rawOrigin = form.get("origin");
  const origin: PostOrigin = rawOrigin === "existing_content" ? "existing_content" : "own_asset";
  if (!isPostOrigin(origin)) return ingestionError("invalid_file", "Choose a valid source for this file.", 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Magic bytes plus the original filename so a `qt`-branded MP4 stays an MP4.
  const detected = detectPostAsset(bytes, file.name);
  if (!detected) {
    if (/\.mov$/i.test(file.name)) {
      return ingestionError("invalid_video", "That MOV isn't a QuickTime container we can store. Export it as MP4 and try again.", 400);
    }
    return ingestionError("unsupported_format", "Use JPEG, PNG, WebP, MP4, or MOV only.", 400);
  }

  const allowed = allowedAssetKindsFor(post.kind);
  const assetKind = postAssetKindForMime(detected.mimeType);
  if (!assetKind || !allowed.includes(assetKind)) {
    const wanted = post.kind === "reel" ? "video" : "image";
    return ingestionError("action_required", `This ${wanted === "video" ? "Reel" : "Instagram Post"} needs ${describeAllowedKinds(allowed)}.`, 400);
  }

  // The format is deliberately NOT read from the upload: the draft's persisted
  // format is the source of truth, so an upload can never overwrite it.
  try {
    const { storagePath, previousStoragePath } = await putPostAsset(admin, user.id, id, {
      bytes,
      mimeType: detected.mimeType,
      extension: detected.extension,
      displayName: safePostAssetName(file.name),
      origin,
    });
    // Only drop the replaced object, and never the one just written.
    if (previousStoragePath && previousStoragePath !== storagePath) {
      await removePostAssetObject(admin, user.id, previousStoragePath);
    }
    const updated = await getPostDraft(admin, user.id, id);
    return Response.json({
      post: updated,
      message: origin === "existing_content"
        ? "Existing content stored privately in Voom. Nothing was published."
        : "Your image is stored privately in Voom, unchanged. Nothing was published.",
    });
  } catch {
    return ingestionError("storage_failure", "Voom couldn't store that file safely. Nothing changed.", 503);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return ingestionError("not_authenticated", "Please log in again.", 401);
  const { id } = await params;
  if (!UUID_RE.test(id)) return ingestionError("not_found", "That post was not found.", 404);
  const admin = createAdminClient();
  try {
    const storagePath = await deletePostAsset(admin, user.id, id);
    if (storagePath) await removePostAssetObject(admin, user.id, storagePath);
    const post = await getPostDraft(admin, user.id, id);
    if (!post) return ingestionError("not_found", "That post was not found.", 404);
    return Response.json({ post, message: "Visual removed. Nothing was published." });
  } catch {
    return ingestionError("storage_failure", "Voom couldn't remove that visual. Please retry.", 503);
  }
}
