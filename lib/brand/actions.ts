"use server";

/**
 * Brand Hub save (Brand Kit v2, slice 2): ONE server action for every
 * section. It validates only that section's values, updates the matching
 * `businesses` columns (today's planner still reads the core fields there),
 * then appends a kit version through the carry-forward rule. The kit is the
 * hub's own record, so a failed kit insert IS a failed save here (unlike the
 * best-effort dual write from onboarding and Settings).
 */
import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { getCurrentUser } from "@/lib/voom/server-data";
import { appendBrandKitVersion } from "./versions";
import { isOwnBrandAssetPath, type BrandAsset } from "./assets";
import { loadNewestBrandAssets, removeBrandAssetObjects, removeUnreferencedBrandAssets } from "./asset-storage";
import { syncBrandToEmail } from "./email-sync";
import { brandSectionMeta, validateBrandSection, answerKeyLabel, type BrandSectionId, type BrandSectionValues } from "./sections";

export type SaveBrandSectionResult =
  | { ok: true; version: number; changedKeys: string[]; values: BrandSectionValues[BrandSectionId]; changeSummary: string }
  | { ok: false; error: string };

export async function saveBrandSection(sectionId: string, raw: unknown): Promise<SaveBrandSectionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please log in again." };

  const validated = validateBrandSection(sectionId, raw);
  if (!validated.ok) return validated;
  const meta = brandSectionMeta(validated.id);

  // Slice 5: every image must sit in this owner's own folder of the bucket.
  if (validated.assets && validated.assets.some((asset) => !isOwnBrandAssetPath(user.id, asset.path, asset.kind))) {
    return { ok: false, error: "One of those images is not in your brand kit. Remove it and try again." };
  }

  const supabase = await createClient();
  const previousAssets = validated.assets ? await loadNewestBrandAssets(supabase, user.id) : [];

  if (Object.keys(validated.business).length > 0) {
    const { error } = await supabase.from("businesses").update(validated.business).eq("owner_user_id", user.id);
    if (error) {
      console.error("[brand-hub] businesses update failed", error.message);
      return { ok: false, error: "Voom couldn't save that. Please try again." };
    }
  }

  const changeSummary = `${meta.title} updated`;
  const appended = await appendBrandKitVersion(supabase, user.id, {
    source: "brand_hub",
    answers: validated.answers,
    ...(validated.brief !== undefined ? { brief: validated.brief } : {}),
    ...(validated.assets ? { assets: validated.assets } : {}),
    changeSummary,
  });
  if (appended === null) {
    return { ok: false, error: "Voom couldn't record that change. Apply the latest Supabase migration (0059), then try again." };
  }

  if (validated.assets) await afterAssetsSaved(user.id, previousAssets, validated.assets, validated.values as BrandSectionValues["assets"]);

  // The history line names the keys that really changed, the same set the
  // row records, so a save that changed nothing in a field does not claim it.
  const { version, changedKeys } = appended;
  revalidatePath("/app", "layout");
  return { ok: true, version, changedKeys, values: validated.values, changeSummary: changedKeys.length ? `${changedKeys.map(answerKeyLabel).join(", ")} saved` : `${meta.title} saved without changes` };
}

/**
 * After an images save: files the owner removed are deleted from storage (a
 * removed image is gone, not hidden), and the logo and colours fill the email
 * brand where it is still empty. Both best-effort: the version is saved.
 */
async function afterAssetsSaved(ownerId: string, previous: BrandAsset[], next: BrandAsset[], values: BrandSectionValues["assets"]): Promise<void> {
  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); } catch { return; }
  const kept = new Set(next.map((asset) => asset.path));
  const removed = previous.map((asset) => asset.path).filter((path) => !kept.has(path));
  if (removed.length) await removeBrandAssetObjects(admin, ownerId, removed);
  // Also any file nothing references any more (leftovers of an onboarding never finished).
  await removeUnreferencedBrandAssets(admin, ownerId, [...kept]);
  const { data: business } = await admin.from("businesses").select("brand_name").eq("owner_user_id", ownerId).maybeSingle()
    .then((result) => result, () => ({ data: null }));
  await syncBrandToEmail(admin, ownerId, { assets: next, colours: values.colours, brandName: String((business as { brand_name?: string } | null)?.brand_name ?? "") });
}
