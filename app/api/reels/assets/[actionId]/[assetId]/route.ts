import { createAdminClient } from "@/utils/supabase/admin";
import { invalidJson, loadReelAssetPack, ownedReelAction, REEL_ASSET_BUCKET } from "@/lib/media/reel-asset-server";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, { params }: { params: Promise<{ actionId: string; assetId: string }> }) {
  const context = await ownedReelAction(params, true);
  if (context instanceof Response) return context;
  const { assetId } = await params;
  if (!UUID_RE.test(assetId)) return invalidJson("That asset is not valid.");
  const admin = createAdminClient();
  const { data: removed, error } = await admin.rpc("remove_reel_draft_asset", {
    p_owner_user_id: context.userId, p_action_id: context.actionId, p_draft_id: context.draftId, p_asset_id: assetId,
  });
  if (error) {
    const migrationMissing = String(error.code ?? "") === "PGRST202" || /could not find the function/i.test(String(error.message ?? ""));
    return invalidJson(migrationMissing ? "Removing individual assets needs the new asset-pack storage step, which is awaiting approval. Nothing changed." : "Voom couldn't remove that asset safely. Nothing changed.", 503);
  }
  const storagePath = Array.isArray(removed) && typeof removed[0]?.storage_path === "string" ? removed[0].storage_path : null;
  if (storagePath) await admin.storage.from(REEL_ASSET_BUCKET).remove([storagePath]);
  const assets = await loadReelAssetPack(admin, context.userId, context.draftId);
  return Response.json({ deleted: true, assets, message: assets.length === 0 ? "Asset removed. Waiting for at least one asset." : `${assets.length} of 6 assets remain.` });
}
