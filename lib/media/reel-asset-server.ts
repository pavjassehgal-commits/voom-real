import "server-only";

import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { defaultIngestionCodeForStatus, type IngestionErrorCode } from "./ingestion-error";
import { REEL_ASSET_PACK_LIMIT } from "./reel-asset";

export const REEL_ASSET_BUCKET = "mara-media";
export const REEL_ASSET_SIGNED_TTL_SECONDS = 600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReelAssetPackItem {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
  status: string;
  updatedAt: string;
  previewUrl: string | null;
}

/** Owner-scoped, ordered asset pack with short-lived private signed preview URLs. */
export async function loadReelAssetPack(admin: Awaited<ReturnType<typeof createAdminClient>>, userId: string, draftId: string): Promise<ReelAssetPackItem[]> {
  const { data: rows } = await admin.from("reel_draft_assets").select("id,display_name,mime_type,byte_size,status,storage_path,updated_at")
    .eq("owner_user_id", userId).eq("draft_id", draftId).order("created_at").order("id").limit(REEL_ASSET_PACK_LIMIT);
  const assets: ReelAssetPackItem[] = [];
  for (const row of rows ?? []) {
    const { data: signed } = await admin.storage.from(REEL_ASSET_BUCKET).createSignedUrl(row.storage_path, REEL_ASSET_SIGNED_TTL_SECONDS);
    assets.push({
      id: row.id,
      name: row.display_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      status: row.status,
      updatedAt: row.updated_at,
      previewUrl: signed?.signedUrl ?? null,
    });
  }
  return assets;
}

/** Shared owner/action guard for the Reel asset routes. */
export async function ownedReelAction(params: Promise<{ actionId: string }>, requireUploadChoice: boolean) {
  const user = await getCurrentUser();
  if (!user) return invalidJson("Please log in again.", 401);
  const { actionId } = await params;
  if (!UUID_RE.test(actionId)) return invalidJson("That Reel request is not valid.");
  const db = await createClient();
  const { data } = await db.from("mara_pending_actions").select("id,tool_name,new_value,status").eq("id", actionId).eq("owner_user_id", user.id).eq("tool_name", "choose_reel_production").eq("status", "pending").maybeSingle();
  if (!data || typeof data.new_value?.draftId !== "string" || !UUID_RE.test(data.new_value.draftId)) return invalidJson("That Reel request was not found.", 404);
  const selected = data.new_value.selectedProductionMethod;
  if (requireUploadChoice && selected !== "upload_asset" && selected !== "film_yourself") return invalidJson("Choose Upload asset or Film it myself first.");
  if (!requireUploadChoice && selected !== "upload_asset" && selected !== "film_yourself" && data.new_value.assetReceived !== true) return invalidJson("That Reel has no private source asset.");
  const kinds = Array.isArray(data.new_value.allowedAssetKinds) ? data.new_value.allowedAssetKinds.filter((kind: unknown): kind is "image" | "video" => kind === "image" || kind === "video") : ["image", "video"];
  return { userId: user.id, actionId, draftId: data.new_value.draftId as string, allowedAssetKinds: kinds.length ? kinds : ["image", "video"] };
}

export function invalidJson(error: string, status = 400, code: IngestionErrorCode = defaultIngestionCodeForStatus(status)) {
  return Response.json({ error, code }, { status });
}
