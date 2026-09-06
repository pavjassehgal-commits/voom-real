import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";
import { detectReelAsset, REEL_ASSET_MAX_BYTES, REEL_ASSET_PACK_LIMIT, safeAssetName } from "@/lib/media/reel-asset";
import { invalidJson, loadReelAssetPack, ownedReelAction, REEL_ASSET_BUCKET } from "@/lib/media/reel-asset-server";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const context = await ownedReelAction(params, false);
  if (context instanceof Response) return context;
  const admin = createAdminClient();
  const assets = await loadReelAssetPack(admin, context.userId, context.draftId);
  return Response.json({ assets });
}

export async function POST(request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const context = await ownedReelAction(params, true);
  if (context instanceof Response) return context;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > REEL_ASSET_MAX_BYTES + 500_000) return invalidJson("That file is too large. Choose one file up to 4 MB.", 413, "file_too_large");
  let form: FormData;
  try { form = await request.formData(); } catch { return invalidJson("Choose one valid image or video file.", 400, "invalid_file"); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return invalidJson("Choose one valid image or video file.", 400, "invalid_file");
  if (file.size > REEL_ASSET_MAX_BYTES) return invalidJson("That file is too large. Choose one file up to 4 MB.", 413, "file_too_large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Magic bytes plus the original filename so a `qt`-branded MP4 stays an MP4
  // instead of being rewritten to a QuickTime MOV.
  const detected = detectReelAsset(bytes, { name: file.name });
  if (!detected) {
    if (/\.mov$/i.test(file.name)) {
      return invalidJson("That MOV isn't a QuickTime container we can store. Export it as MP4 and try again.", 400, "invalid_video");
    }
    return invalidJson("Use JPEG, PNG, WebP, MP4, or MOV only.", 400, "unsupported_format");
  }
  if (!context.allowedAssetKinds.includes(detected.kind)) return invalidJson(`This Reel needs a ${context.allowedAssetKinds.join(" or ")} asset.`, 400, "action_required");

  const admin = createAdminClient();
  const { count } = await admin.from("reel_draft_assets").select("id", { count: "exact", head: true }).eq("owner_user_id", context.userId).eq("draft_id", context.draftId);
  const currentCount = count ?? 0;
  if (currentCount >= REEL_ASSET_PACK_LIMIT) return invalidJson(`This Reel already has ${REEL_ASSET_PACK_LIMIT} assets. Remove one before adding another.`, 400, "pack_full");

  const storagePath = `${context.userId}/reel-assets/${randomUUID()}.${detected.extension}`;
  const { error: uploadError } = await admin.storage.from(REEL_ASSET_BUCKET).upload(storagePath, bytes, { contentType: detected.mimeType, upsert: false });
  if (uploadError) return invalidJson("Voom couldn't store that asset safely. Nothing changed.", 503, "storage_failure");

  const displayName = safeAssetName(file.name);
  const rpcArgs = {
    p_owner_user_id: context.userId, p_action_id: context.actionId, p_draft_id: context.draftId,
    p_storage_path: storagePath, p_display_name: displayName, p_mime_type: detected.mimeType, p_byte_size: file.size,
  };
  let persisted = false;
  let previousPath: string | null = null;
  const { error: addError } = await admin.rpc("add_reel_draft_asset", rpcArgs);
  if (addError) {
    const migrationMissing = String(addError.code ?? "") === "PGRST202" || /could not find the function/i.test(String(addError.message ?? ""));
    if (/asset_pack_full/i.test(String(addError.message ?? ""))) {
      await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
      return invalidJson(`This Reel already has ${REEL_ASSET_PACK_LIMIT} assets. Remove one before adding another.`, 400, "pack_full");
    }
    // Pre-migration compatibility: the first asset still uses the original
    // single-asset RPC so existing Reels keep working until the asset-pack
    // migration is approved and applied. Additional assets require the new RPC.
    if (migrationMissing && currentCount === 0) {
      const { data: replaced, error: legacyError } = await admin.rpc("replace_reel_draft_asset", rpcArgs);
      if (legacyError) {
        await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
        return invalidJson("Voom couldn't link that asset safely. Nothing changed.", 503, "db_failure");
      }
      previousPath = Array.isArray(replaced) && typeof replaced[0]?.previous_storage_path === "string" ? replaced[0].previous_storage_path : null;
      persisted = true;
    } else {
      await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
      return invalidJson(migrationMissing ? "Adding more than one asset needs the new asset-pack storage step, which is awaiting approval. Nothing changed." : "Voom couldn't link that asset safely. Nothing changed.", 503, "db_failure");
    }
  } else {
    persisted = true;
  }
  if (!persisted) {
    await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
    return invalidJson("Voom couldn't link that asset safely. Nothing changed.", 503, "db_failure");
  }
  if (previousPath && previousPath !== storagePath) await admin.storage.from(REEL_ASSET_BUCKET).remove([previousPath]);
  const assets = await loadReelAssetPack(admin, context.userId, context.draftId);
  return Response.json({ assets, asset: assets[assets.length - 1] ?? null, message: `${assets.length} of ${REEL_ASSET_PACK_LIMIT} assets added. Ready for future MARA production.` });
}
