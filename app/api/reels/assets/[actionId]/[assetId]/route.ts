import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";
import { invalidJson, loadReelAssetPack, ownedReelAction, REEL_ASSET_BUCKET } from "@/lib/media/reel-asset-server";
import { logIngestionStage, requestIdFrom } from "@/lib/media/ingestion-error";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(request: Request, { params }: { params: Promise<{ actionId: string; assetId: string }> }) {
  const requestId = requestIdFrom(request, randomUUID());
  logIngestionStage("received", { requestId });
  const context = await ownedReelAction(params, true, requestId);
  if (context instanceof Response) return context;
  const { assetId } = await params;
  if (!UUID_RE.test(assetId)) return invalidJson("That asset is not valid.", 400, "invalid_file", requestId);
  const admin = createAdminClient();
  const { data: removed, error } = await admin.rpc("remove_reel_draft_asset", {
    p_owner_user_id: context.userId, p_action_id: context.actionId, p_draft_id: context.draftId, p_asset_id: assetId,
  });
  if (error) {
    const migrationMissing = String(error.code ?? "") === "PGRST202" || /could not find the function/i.test(String(error.message ?? ""));
    if (/asset_not_found/i.test(String(error.message ?? ""))) return invalidJson("That asset was not found for this Reel. Nothing changed.", 404, "not_found", requestId);
    logIngestionStage("db_upsert", { requestId, code: migrationMissing ? "action_required" : "db_failure" });
    return invalidJson(migrationMissing ? "Removing individual assets needs the new asset-pack storage step, which is awaiting approval. Nothing changed." : "Voom couldn't save that asset to your content. Nothing changed.", 503, migrationMissing ? "action_required" : "db_failure", requestId);
  }
  const storagePath = Array.isArray(removed) && typeof removed[0]?.storage_path === "string" ? removed[0].storage_path : null;
  if (storagePath) await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
  const assets = await loadReelAssetPack(admin, context.userId, context.draftId);
  logIngestionStage("stored", { requestId });
  return Response.json({ deleted: true, assets, requestId, message: assets.length === 0 ? "Asset removed. Waiting for at least one asset." : `${assets.length} of 6 assets remain.` }, { headers: { "X-Request-Id": requestId } });
}
