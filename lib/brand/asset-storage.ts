import "server-only";

/**
 * Brand Kit v2, slice 5: the private `brand-kit` bucket (migration 0075).
 *
 * The bucket has no storage policies for users: every read and write goes
 * through server code with the service-role client, and every path is checked
 * to sit inside the caller's own folder first (`isOwnBrandAssetPath`).
 * Previews use short-lived signed links (one hour), never public URLs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRAND_KIT_TABLE } from "./context";
import { BRAND_ASSET_KINDS, BRAND_KIT_BUCKET, cleanBrandAssets, isOwnBrandAssetPath, type BrandAsset } from "./assets";

export const BRAND_ASSET_PREVIEW_TTL_SECONDS = 3600;

export async function putBrandAssetObject(admin: SupabaseClient, path: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  const { error } = await admin.storage.from(BRAND_KIT_BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false });
  if (error) throw new Error("brand_asset_storage_failed");
}

export async function readBrandAssetObject(admin: SupabaseClient, ownerId: string, path: string): Promise<Uint8Array | null> {
  if (!isOwnBrandAssetPath(ownerId, path)) return null;
  try {
    const { data, error } = await admin.storage.from(BRAND_KIT_BUCKET).download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/** Best-effort delete of objects inside the owner's folder; anything else is ignored. */
export async function removeBrandAssetObjects(admin: SupabaseClient, ownerId: string, paths: readonly string[]): Promise<void> {
  const own = paths.filter((path) => isOwnBrandAssetPath(ownerId, path));
  if (!own.length) return;
  try {
    const { error } = await admin.storage.from(BRAND_KIT_BUCKET).remove(own);
    if (error) console.error("[brand-assets] remove failed", { count: own.length });
  } catch {
    console.error("[brand-assets] remove failed", { count: own.length });
  }
}

/**
 * Deletes every file in the owner's three folders that the newest kit version
 * does not reference (`keep`): the previous set after a restarted onboarding
 * replaced it, and uploads from an onboarding that was never finished.
 * Best-effort: a listing failure leaves the folder alone and is logged.
 */
export async function removeUnreferencedBrandAssets(admin: SupabaseClient, ownerId: string, keep: readonly string[]): Promise<void> {
  const kept = new Set(keep);
  const orphans: string[] = [];
  for (const kind of BRAND_ASSET_KINDS) {
    const folder = `${ownerId}/${kind}`;
    try {
      const { data, error } = await admin.storage.from(BRAND_KIT_BUCKET).list(folder, { limit: 1000 });
      if (error || !Array.isArray(data)) {
        console.error("[brand-assets] sweep listing failed", { kind });
        continue;
      }
      for (const entry of data) {
        const name = (entry as { name?: unknown })?.name;
        if (typeof name !== "string") continue;
        const path = `${folder}/${name}`;
        if (!kept.has(path) && isOwnBrandAssetPath(ownerId, path, kind)) orphans.push(path);
      }
    } catch {
      console.error("[brand-assets] sweep listing failed", { kind });
    }
  }
  if (orphans.length) await removeBrandAssetObjects(admin, ownerId, orphans);
}

/** One-hour preview links for the owner's own paths. Missing objects are simply left out. */
export async function signBrandAssetUrls(admin: SupabaseClient, ownerId: string, paths: readonly string[]): Promise<Record<string, string>> {
  const own = [...new Set(paths.filter((path) => isOwnBrandAssetPath(ownerId, path)))];
  if (!own.length) return {};
  try {
    const { data, error } = await admin.storage.from(BRAND_KIT_BUCKET).createSignedUrls(own, BRAND_ASSET_PREVIEW_TTL_SECONDS);
    if (error || !Array.isArray(data)) return {};
    const urls: Record<string, string> = {};
    for (const item of data) {
      if (item && typeof item.path === "string" && typeof item.signedUrl === "string" && !item.error) urls[item.path] = item.signedUrl;
    }
    return urls;
  } catch {
    return {};
  }
}

/** The asset list of the owner's newest kit version ([] when none or unreadable). */
export async function loadNewestBrandAssets(db: SupabaseClient, ownerId: string): Promise<BrandAsset[]> {
  try {
    const { data, error } = await db.from(BRAND_KIT_TABLE)
      .select("assets").eq("owner_user_id", ownerId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return [];
    return cleanBrandAssets((data as { assets?: unknown }).assets) ?? [];
  } catch {
    return [];
  }
}
