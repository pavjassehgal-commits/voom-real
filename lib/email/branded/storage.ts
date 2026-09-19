/**
 * Branded Email Engine — the production storage boundary for email assets.
 *
 * Objects live in the PUBLIC `voom-email-assets` bucket under
 * `{ownerId}/{random}.ext` keys (created by migration 0041). Reads for
 * publishing-from-a-draft go through the PRIVATE `mara-media` bucket with a
 * short-lived service-role signed URL that is consumed server-side and never
 * leaves this process.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { EmailAssetError, type EmailAssetStorage } from "./assets";

export const EMAIL_ASSET_BUCKET = "voom-email-assets";
export const PRIVATE_MEDIA_BUCKET = "mara-media";

/** Seconds a private read may stay valid: just long enough for one copy. */
const PRIVATE_READ_TTL_SECONDS = 60;

export function createEmailAssetStorage(admin: SupabaseClient): EmailAssetStorage {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

  return {
    async putObject(path, bytes, mimeType) {
      const { error } = await admin.storage.from(EMAIL_ASSET_BUCKET).upload(path, bytes, {
        contentType: mimeType,
        upsert: false,
      });
      if (error) {
        throw new EmailAssetError("storage_failure", "Voom couldn't store that image safely. Nothing was published.");
      }
      return { path };
    },

    async getPrivateObject(path) {
      const { data, error } = await admin.storage.from(PRIVATE_MEDIA_BUCKET).createSignedUrl(path, PRIVATE_READ_TTL_SECONDS);
      if (error || !data?.signedUrl) return null;
      try {
        const response = await fetch(data.signedUrl, { cache: "no-store" });
        if (!response.ok) return null;
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        return null;
      }
    },

    async deleteObject(path) {
      await admin.storage.from(EMAIL_ASSET_BUCKET).remove([path]).catch(() => null);
    },

    publicUrlFor(path) {
      const base = baseUrl.replace(/\/+$/, "");
      return `${base}/storage/v1/object/public/${EMAIL_ASSET_BUCKET}/${path}`;
    },
  };
}
