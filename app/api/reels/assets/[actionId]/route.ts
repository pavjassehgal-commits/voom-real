import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";
import { detectReelAsset, REEL_ASSET_MAX_BYTES, REEL_ASSET_PACK_LIMIT, safeAssetName } from "@/lib/media/reel-asset";
import { invalidJson, loadReelAssetPack, ownedReelAction, REEL_ASSET_BUCKET } from "@/lib/media/reel-asset-server";
import { logIngestionStage, requestIdFrom } from "@/lib/media/ingestion-error";

export const runtime = "nodejs";

function requestContext(request: Request) {
  const requestId = requestIdFrom(request, randomUUID());
  const headerSize = Number(request.headers.get("content-length") ?? 0);
  const fileSize = Number.isSafeInteger(headerSize) && headerSize > 0 ? headerSize : null;
  logIngestionStage("received", { requestId, fileSize });
  return { requestId };
}

function logFailure(requestId: string, stage: "draft_read" | "detected" | "storage_upload" | "db_upsert" | "stored", code: "ownership_failure" | "unsupported_format" | "invalid_video" | "storage_failure" | "db_failure", fileSize?: number, detected?: { kind: "image" | "video"; mimeType: string; extension: string }) {
  logIngestionStage(stage, { requestId, fileSize, kind: detected?.kind, mimeType: detected?.mimeType, extension: detected?.extension, code });
}

export async function GET(request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const { requestId } = requestContext(request);
  const context = await ownedReelAction(params, false, requestId);
  if (context instanceof Response) return context;
  try {
    const admin = createAdminClient();
    const assets = await loadReelAssetPack(admin, context.userId, context.draftId);
    return Response.json({ assets, requestId }, { headers: { "X-Request-Id": requestId } });
  } catch {
    logFailure(requestId, "stored", "db_failure");
    return invalidJson("Voom couldn't read that Reel safely. Please retry.", 503, "db_failure", requestId);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const { requestId } = requestContext(request);
  const context = await ownedReelAction(params, true, requestId);
  if (context instanceof Response) return context;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > REEL_ASSET_MAX_BYTES + 500_000) return invalidJson("That file is too large. Choose one file up to 4 MB.", 413, "file_too_large", requestId);
  let form: FormData;
  try { form = await request.formData(); } catch { return invalidJson("Choose one valid image or video file.", 400, "invalid_file", requestId); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return invalidJson("Choose one valid image or video file.", 400, "invalid_file", requestId);
  if (file.size > REEL_ASSET_MAX_BYTES) return invalidJson("That file is too large. Choose one file up to 4 MB.", 413, "file_too_large", requestId);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Magic bytes plus the original filename so a `qt`-branded MP4 stays an MP4
  // instead of being rewritten to a QuickTime MOV.
  const detected = detectReelAsset(bytes, { name: file.name });
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
      return invalidJson("That MOV isn't a QuickTime container we can store. Export it as MP4 and try again.", 400, "invalid_video", requestId);
    }
    return invalidJson("Use JPEG, PNG, WebP, MP4, or MOV only.", 400, "unsupported_format", requestId);
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    logFailure(requestId, "db_upsert", "db_failure", file.size, detected);
    return invalidJson("Voom couldn't save that asset to your content. Nothing changed.", 503, "db_failure", requestId);
  }

  const { count, error: countError } = await admin.from("reel_draft_assets").select("id", { count: "exact", head: true }).eq("owner_user_id", context.userId).eq("draft_id", context.draftId);
  if (countError) {
    logFailure(requestId, "draft_read", "db_failure", file.size, detected);
    return invalidJson("Voom couldn't read that Reel safely. Please retry.", 503, "db_failure", requestId);
  }
  const currentCount = count ?? 0;
  if (currentCount >= REEL_ASSET_PACK_LIMIT) return invalidJson(`This Reel already has ${REEL_ASSET_PACK_LIMIT} assets. Remove one before adding another.`, 400, "pack_full", requestId);

  const storagePath = `${context.userId}/reel-assets/${randomUUID()}.${detected.extension}`;
  let uploadError: unknown = null;
  try {
    const result = await admin.storage.from(REEL_ASSET_BUCKET).upload(storagePath, bytes, { contentType: detected.mimeType, upsert: false });
    uploadError = result.error;
  } catch {
    uploadError = true;
  }
  if (uploadError) {
    logFailure(requestId, "storage_upload", "storage_failure", file.size, detected);
    return invalidJson("Voom couldn't store that asset safely. Nothing changed.", 503, "storage_failure", requestId);
  }
  logIngestionStage("storage_upload", { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension });

  // Upload failures retain the safe wording: Voom couldn't store that asset safely. Nothing changed.
  // Database-link failures are classified separately from storage failures: Voom couldn't link that asset safely. Nothing changed.
  const displayName = safeAssetName(file.name);
  const rpcArgs = {
    p_owner_user_id: context.userId, p_action_id: context.actionId, p_draft_id: context.draftId,
    p_storage_path: storagePath, p_display_name: displayName, p_mime_type: detected.mimeType, p_byte_size: file.size,
  };
  let persisted = false;
  let previousPath: string | null = null;
  let addError: { code?: unknown; message?: unknown } | null = null;
  try {
    const result = await admin.rpc("add_reel_draft_asset", rpcArgs);
    addError = result.error;
  } catch {
    addError = { message: "rpc_failed" };
  }
  if (addError) {
    const errorCode = String(addError.code ?? "");
    const errorMessage = String(addError.message ?? "");
    const migrationMissing = errorCode === "PGRST202" || /could not find the function/i.test(errorMessage);
    if (/asset_pack_full/i.test(errorMessage)) {
      await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
      return invalidJson(`This Reel already has ${REEL_ASSET_PACK_LIMIT} assets. Remove one before adding another.`, 400, "pack_full", requestId);
    }
    // Pre-migration compatibility: the first asset still uses the original
    // single-asset RPC so existing Reels keep working until the asset-pack
    // migration is approved and applied. Additional assets require the new RPC.
    if (migrationMissing && currentCount === 0) {
      try {
        const { data: replaced, error: legacyError } = await admin.rpc("replace_reel_draft_asset", rpcArgs);
        if (!legacyError) {
          previousPath = Array.isArray(replaced) && typeof replaced[0]?.previous_storage_path === "string" ? replaced[0].previous_storage_path : null;
          persisted = true;
        }
      } catch {
        persisted = false;
      }
      if (!persisted) {
        await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
        logFailure(requestId, "db_upsert", "db_failure", file.size, detected);
        return invalidJson("Voom couldn't save that asset to your content. Nothing changed.", 503, "db_failure", requestId);
      }
    } else {
      await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
      logFailure(requestId, "db_upsert", "db_failure", file.size, detected);
      return invalidJson(migrationMissing ? "Adding more than one asset needs the new asset-pack storage step, which is awaiting approval. Nothing changed." : "Voom couldn't save that asset to your content. Nothing changed.", 503, "db_failure", requestId);
    }
  } else {
    persisted = true;
  }
  if (!persisted) {
    await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
    logFailure(requestId, "db_upsert", "db_failure", file.size, detected);
    return invalidJson("Voom couldn't save that asset to your content. Nothing changed.", 503, "db_failure", requestId);
  }
  logIngestionStage("db_upsert", { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension });

  const { data: storedRow, error: storedReadError } = await admin.from("reel_draft_assets")
    .select("id,storage_path,status").eq("owner_user_id", context.userId).eq("draft_id", context.draftId).eq("storage_path", storagePath).maybeSingle();
  if (storedReadError || !storedRow || storedRow.status !== "uploaded") {
    await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
    logFailure(requestId, "stored", "db_failure", file.size, detected);
    return invalidJson("Voom couldn't verify that asset was stored safely. Nothing changed.", 503, "db_failure", requestId);
  }
  logIngestionStage("stored", { requestId, fileSize: file.size, kind: detected.kind, mimeType: detected.mimeType, extension: detected.extension });

  if (previousPath && previousPath !== storagePath) await admin.storage.from(REEL_ASSET_BUCKET).remove([previousPath]);
  try {
    const assets = await loadReelAssetPack(admin, context.userId, context.draftId);
    return Response.json({ assets, asset: assets[assets.length - 1] ?? null, requestId, message: `${assets.length} of ${REEL_ASSET_PACK_LIMIT} assets added. Ready for future MARA production.` }, { headers: { "X-Request-Id": requestId } });
  } catch {
    logFailure(requestId, "stored", "db_failure", file.size, detected);
    return invalidJson("Voom couldn't verify that asset was stored safely. Nothing changed.", 503, "db_failure", requestId);
  }
}
