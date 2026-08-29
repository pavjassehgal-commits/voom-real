import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { detectReelAsset, REEL_ASSET_MAX_BYTES, safeAssetName } from "@/lib/media/reel-asset";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = "mara-media";

export async function GET(_request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const context = await ownedReelAction(params, false);
  if (context instanceof Response) return context;
  const admin = createAdminClient();
  const { data: asset } = await admin.from("reel_draft_assets").select("display_name,mime_type,byte_size,status,storage_path,updated_at").eq("owner_user_id", context.userId).eq("draft_id", context.draftId).maybeSingle();
  if (!asset) return Response.json({ asset: null });
  const { data: signed, error } = await admin.storage.from(BUCKET).createSignedUrl(asset.storage_path, 600);
  if (error) return Response.json({ error: "Voom couldn't open that private asset." }, { status: 503 });
  return Response.json({ asset: publicAsset(asset, signed.signedUrl) });
}

export async function POST(request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const context = await ownedReelAction(params, true);
  if (context instanceof Response) return context;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > REEL_ASSET_MAX_BYTES + 500_000) return invalid("That file is too large. Choose one file up to 4 MB.", 413);
  let form: FormData;
  try { form = await request.formData(); } catch { return invalid("Choose one valid image or video file."); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return invalid("Choose one valid image or video file.");
  if (file.size > REEL_ASSET_MAX_BYTES) return invalid("That file is too large. Choose one file up to 4 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectReelAsset(bytes);
  if (!detected) return invalid("Use JPEG, PNG, WebP, MP4, or MOV only.");
  if (!context.allowedAssetKinds.includes(detected.kind)) return invalid(`This Reel needs a ${context.allowedAssetKinds.join(" or ")} asset.`);

  const admin = createAdminClient();
  const storagePath = `${context.userId}/reel-assets/${randomUUID()}.${detected.extension}`;
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, bytes, { contentType: detected.mimeType, upsert: false });
  if (uploadError) return Response.json({ error: "Voom couldn't store that asset safely. Nothing changed." }, { status: 503 });

  const displayName = safeAssetName(file.name);
  const { data: replaced, error: persistError } = await admin.rpc("replace_reel_draft_asset", {
    p_owner_user_id: context.userId, p_action_id: context.actionId, p_draft_id: context.draftId,
    p_storage_path: storagePath, p_display_name: displayName, p_mime_type: detected.mimeType, p_byte_size: file.size,
  });
  if (persistError) {
    await admin.storage.from(BUCKET).remove([storagePath]);
    return Response.json({ error: "Voom couldn't link that asset safely. Nothing changed." }, { status: 503 });
  }
  const previousPath = Array.isArray(replaced) ? replaced[0]?.previous_storage_path : null;
  if (typeof previousPath === "string" && previousPath !== storagePath) await admin.storage.from(BUCKET).remove([previousPath]);
  const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(storagePath, 600);
  return Response.json({ asset: publicAsset({ display_name: displayName, mime_type: detected.mimeType, byte_size: file.size, status: "uploaded", updated_at: new Date().toISOString() }, signed?.signedUrl ?? null), message: "Asset received. This Reel is ready for future MARA production." });
}

async function ownedReelAction(params: Promise<{ actionId: string }>, requireUploadChoice: boolean) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { actionId } = await params;
  if (!UUID_RE.test(actionId)) return invalid("That Reel request is not valid.");
  const db = await createClient();
  const { data } = await db.from("mara_pending_actions").select("id,tool_name,new_value,status").eq("id", actionId).eq("owner_user_id", user.id).eq("tool_name", "choose_reel_production").eq("status", "pending").maybeSingle();
  if (!data || typeof data.new_value?.draftId !== "string" || !UUID_RE.test(data.new_value.draftId)) return Response.json({ error: "That Reel request was not found." }, { status: 404 });
  const selected = data.new_value.selectedProductionMethod;
  if (requireUploadChoice && selected !== "upload_asset" && selected !== "film_yourself") return invalid("Choose Upload asset or Film it myself first.");
  if (!requireUploadChoice && selected !== "upload_asset" && selected !== "film_yourself" && data.new_value.assetReceived !== true) return invalid("That Reel has no private source asset.");
  const kinds = Array.isArray(data.new_value.allowedAssetKinds) ? data.new_value.allowedAssetKinds.filter((kind: unknown): kind is "image" | "video" => kind === "image" || kind === "video") : ["image", "video"];
  return { userId: user.id, actionId, draftId: data.new_value.draftId as string, allowedAssetKinds: kinds.length ? kinds : ["image", "video"] };
}

function publicAsset(asset: { display_name: string; mime_type: string; byte_size: number; status: string; updated_at: string }, previewUrl: string | null) {
  return { name: asset.display_name, mimeType: asset.mime_type, byteSize: asset.byte_size, status: asset.status, updatedAt: asset.updated_at, previewUrl };
}
function invalid(error: string, status = 400) { return Response.json({ error }, { status }); }
