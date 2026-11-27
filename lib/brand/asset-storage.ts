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
import { BrandKitReadError, BRAND_KIT_TABLE } from "./context";
import { BRAND_KIT_BUCKET, cleanBrandAssets, isOwnBrandAssetPath, type BrandAsset } from "./assets";

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

/**
 * Physical deletion is deferred. A reference check followed by Storage.remove
 * cannot be atomic with a concurrent kit save or an upload still in a wizard.
 * Retain objects until a separate lease/reference-aware garbage collector exists.
 */
export async function removeBrandAssetObjects(_admin: SupabaseClient, ownerId: string, paths: readonly string[]): Promise<void> {
  const count = paths.filter((path) => isOwnBrandAssetPath(ownerId, path)).length;
  if (count) console.info("[brand-assets] deletion deferred", { count, reason: "concurrent_save_protection" });
}

/** Verify the successfully saved/reused snapshot, never infer keep from a failed pre-read. */
export async function removeUnreferencedBrandAssets(admin: SupabaseClient, ownerId: string, savedVersion: number): Promise<void> {
  try {
    const { data, error } = await admin.from(BRAND_KIT_TABLE).select("assets")
      .eq("owner_user_id", ownerId).eq("version", savedVersion).maybeSingle();
    const assets = data ? cleanBrandAssets(data.assets) : null;
    if (error || !assets) {
      console.error("[brand-assets] cleanup skipped: saved references unavailable");
      return;
    }
    // This snapshot is authoritative for this save, but cannot prove that other
    // historical versions or in-flight saves no longer need an object.
    console.info("[brand-assets] cleanup deferred", { version: savedVersion, kept: assets.length, reason: "concurrent_save_protection" });
  } catch {
    console.error("[brand-assets] cleanup skipped: saved references unavailable");
  }
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

/** A successful missing row is empty; unavailable references must never authorize deletion. */
export async function loadNewestBrandAssets(db: SupabaseClient, ownerId: string): Promise<BrandAsset[]> {
  try {
    const { data, error } = await db.from(BRAND_KIT_TABLE)
      .select("assets").eq("owner_user_id", ownerId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new BrandKitReadError();
    if (!data) return [];
    return cleanBrandAssets((data as { assets?: unknown }).assets) ?? [];
  } catch {
    console.error("[brand-assets] asset read failed");
    throw new BrandKitReadError();
  }
}
