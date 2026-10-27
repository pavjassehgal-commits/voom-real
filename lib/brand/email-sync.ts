import "server-only";

/**
 * Brand Kit v2, slice 5: the brand logo and colours fill the EMAIL brand only
 * where it is still empty, so the owner does not upload their logo twice.
 *
 * Settings -> Email identity stays the owner's own choice: a logo or colour
 * already set there is never replaced. When the email brand has no logo, the
 * kit logo is copied through the existing publish path (public email bucket,
 * `create_email_asset`) and set with `upsert_email_brand`, which keeps every
 * field it is not sent. No email code changes. Best-effort: a failure is
 * logged and never fails the save that triggered it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { publishEmailAsset } from "@/lib/email/branded/assets";
import { createEmailAssetStorage } from "@/lib/email/branded/storage";
import type { BrandAsset, BrandColours } from "./assets";
import { readBrandAssetObject } from "./asset-storage";

export type EmailSyncOutcome = "synced" | "skipped" | "failed";

export async function syncBrandToEmail(
  admin: SupabaseClient,
  ownerId: string,
  input: { assets: readonly BrandAsset[]; colours: BrandColours | null; brandName: string },
): Promise<EmailSyncOutcome> {
  const logo = input.assets.find((asset) => asset.kind === "logo") ?? null;
  if (!logo && !input.colours) return "skipped";
  try {
    const { data: current, error } = await admin.from("voom_email_brands")
      .select("logo_asset_id,primary_color,secondary_color").eq("owner_user_id", ownerId).maybeSingle();
    if (error) throw new Error("email_brand_read_failed");
    const existing = (current ?? {}) as { logo_asset_id?: string | null; primary_color?: string | null; secondary_color?: string | null };

    const payload: Record<string, string> = {};
    if (logo && !existing.logo_asset_id) {
      const bytes = await readBrandAssetObject(admin, ownerId, logo.path);
      if (bytes) {
        const published = await publishEmailAsset(admin, createEmailAssetStorage(admin), {
          ownerId,
          bytes,
          altText: `${input.brandName.trim() || "Brand"} logo`.slice(0, 200),
          sourceKind: "uploaded",
        });
        payload.logoAssetId = published.id;
      }
    }
    if (input.colours?.primary && !existing.primary_color) payload.primaryColor = input.colours.primary;
    if (input.colours?.secondary && !existing.secondary_color) payload.secondaryColor = input.colours.secondary;
    if (!Object.keys(payload).length) return "skipped";

    const { error: upsertError } = await admin.rpc("upsert_email_brand", { p_owner_user_id: ownerId, p_payload: payload });
    if (upsertError) throw new Error("email_brand_upsert_failed");
    return "synced";
  } catch (reason) {
    console.error("[brand-assets] email sync failed", reason instanceof Error ? reason.message : "unknown");
    return "failed";
  }
}
