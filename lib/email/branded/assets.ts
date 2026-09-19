/**
 * Branded Email Engine — email-safe asset delivery.
 *
 * Email images must stay reachable by the recipient's mail client for years,
 * and they must never be private objects or short-lived signed URLs. The
 * strategy:
 *
 *   1. an owner EXPLICITLY publishes an image (uploads one, or picks an
 *      asset they already own in a content draft);
 *   2. the server copies the bytes into the PUBLIC `voom-email-assets`
 *      bucket under a random key owned by that business;
 *   3. the durable, non-expiring public URL is stored in
 *      `voom_email_assets` (owner-scoped RLS) and only that URL is ever
 *      referenced from an email.
 *
 * Nothing private is exposed: the private `mara-media` bucket keeps its
 * short-lived signed URLs for in-app previews, and no object leaves that
 * bucket except the explicit, owner-authorized copies above. A published
 * asset can only be used in this owner's own emails — the design validator
 * refuses any asset id the owner did not publish.
 *
 * The storage boundary is injectable so the Node suite can prove the security
 * behaviour without touching real storage.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectReelAsset } from "@/lib/media/reel-asset";
import type { EmailAssetRow } from "./types";

export const EMAIL_ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const EMAIL_ASSET_MAX_WIDTH = 1200;

export interface EmailAssetStorage {
  /** Uploads bytes into the public email bucket. Returns the object path. */
  putObject(path: string, bytes: Uint8Array, mimeType: string): Promise<{ path: string }>;
  /** Reads an object from the PRIVATE media bucket (service role). */
  getPrivateObject(path: string): Promise<Uint8Array | null>;
  /** Deletes a public email-asset object. Best-effort. */
  deleteObject(path: string): Promise<void>;
  /** The public base URL the bucket serves objects from. */
  publicUrlFor(path: string): string;
}

export interface PublishEmailAssetInput {
  ownerId: string;
  /** Owner-validated bytes (already size-capped by the route). */
  bytes: Uint8Array;
  /** The name the recipient's mail client / screen reader should see. */
  altText: string;
  sourceKind: EmailAssetRow["source_kind"];
  sourceDraftId?: string | null;
}

export type PublishedEmailAsset = EmailAssetRow;

export class EmailAssetError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "EmailAssetError";
    this.code = code;
  }
}

/**
 * Publishes owner-supplied bytes as a durable email asset.
 *
 * Security properties the tests pin:
 *   - only image/* magic-verified bytes are accepted;
 *   - the object lands in the public email bucket under a random key —
 *     never in the private bucket, never a signed URL;
 *   - the row is owner-scoped and only "ready" assets are renderable.
 */
export async function publishEmailAsset(
  admin: SupabaseClient,
  storage: EmailAssetStorage,
  input: PublishEmailAssetInput,
): Promise<PublishedEmailAsset> {
  const detected = detectReelAsset(input.bytes);
  if (!detected || detected.kind !== "image") {
    throw new EmailAssetError("invalid_image", "That file is not a usable image (JPEG, PNG or WebP).");
  }
  const mimeType = detected.mimeType === "image/jpeg" || detected.mimeType === "image/png" || detected.mimeType === "image/webp"
    ? detected.mimeType
    : null;
  if (!mimeType) throw new EmailAssetError("unsupported_mime", "Use a JPEG, PNG or WebP image.");

  // Shrink large images for email: a 10 MB hero is hostile to inboxes.
  // Best-effort — when the optimizer is unavailable the original bytes ship.
  const { bytes: finalBytes, width, height } = await optimizeForEmail(input.bytes, mimeType);

  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const path = `${input.ownerId}/${randomUUID()}.${extension}`;
  await storage.putObject(path, finalBytes, mimeType);

  const { data, error } = await admin.rpc("create_email_asset", {
    p_owner_user_id: input.ownerId,
    p_payload: {
      publicPath: path,
      publicUrl: storage.publicUrlFor(path),
      mimeType,
      byteSize: finalBytes.byteLength,
      altText: input.altText.slice(0, 200) || null,
      width: width ?? null,
      height: height ?? null,
      sourceKind: input.sourceKind,
      sourceDraftId: input.sourceDraftId ?? null,
    },
  }).single();

  if (error || !data) {
    // Roll the object back so the public bucket never holds orphan bytes.
    await storage.deleteObject(path).catch(() => null);
    throw new EmailAssetError("persist_failed", "Voom couldn't register that image safely. Nothing was published.");
  }

  return data as unknown as PublishedEmailAsset;
}

/**
 * Copies an owner's EXISTING draft asset (private mara-media) into the public
 * email bucket. The ownership re-check happens against the private asset
 * table with the owner's scope — another owner's draft can never be copied.
 */
export async function publishDraftAssetAsEmailAsset(
  admin: SupabaseClient,
  storage: EmailAssetStorage,
  input: { ownerId: string; draftId: string; altText: string },
): Promise<PublishedEmailAsset> {
  const { data, error } = await admin.from("post_draft_assets")
    .select("id,draft_id,storage_path,mime_type")
    .eq("owner_user_id", input.ownerId)
    .eq("draft_id", input.draftId)
    .maybeSingle();

  if (error || !data) {
    throw new EmailAssetError("source_not_found", "That asset was not found in your workspace.");
  }
  const asset = data as { id: string; draft_id: string; storage_path: string; mime_type: string };
  if (!["image/jpeg", "image/png", "image/webp"].includes(asset.mime_type)) {
    throw new EmailAssetError("unsupported_mime", "Only image assets can be used in emails.");
  }

  const bytes = await storage.getPrivateObject(asset.storage_path);
  if (!bytes || bytes.byteLength === 0) {
    throw new EmailAssetError("source_unreadable", "Voom couldn't read that image safely. Nothing was published.");
  }
  if (bytes.byteLength > EMAIL_ASSET_MAX_BYTES) {
    throw new EmailAssetError("file_too_large", "That image is too large for email (max 5 MB).");
  }

  return publishEmailAsset(admin, storage, {
    ownerId: input.ownerId,
    bytes,
    altText: input.altText,
    sourceKind: "from_draft_asset",
    sourceDraftId: asset.draft_id,
  });
}

export async function removeEmailAsset(
  admin: SupabaseClient,
  storage: EmailAssetStorage,
  input: { ownerId: string; assetId: string },
): Promise<{ path: string | null }> {
  const { data, error } = await admin.rpc("remove_email_asset", {
    p_owner_user_id: input.ownerId,
    p_asset_id: input.assetId,
  });
  if (error || !data) {
    throw new EmailAssetError("asset_not_found", "That email image was not found.");
  }
  const row = data as unknown as EmailAssetRow;
  const path = row.public_path ?? null;
  if (path) await storage.deleteObject(path).catch(() => null);
  return { path };
}

export async function listEmailAssets(
  db: SupabaseClient,
  ownerId: string,
): Promise<Array<Partial<EmailAssetRow> & { id: string }>> {
  const { data, error } = await db.from("voom_email_assets")
    .select("id,public_url,mime_type,byte_size,alt_text,width,height,source_kind,status,created_at")
    .eq("owner_user_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return [];
  return (data ?? []) as unknown as Array<Partial<EmailAssetRow> & { id: string }>;
}

// ─── Email-safe optimization (best-effort) ───────────────────────────────────

interface OptimizedImage {
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}

/**
 * Re-encodes oversized images for the email context: max 1200px wide, JPEG
 * quality ~82 (PNG/WebP pass through with a width cap). Purely a size
 * optimization on an explicit copy — the owner's original asset is untouched.
 * Falls back to the original bytes whenever sharp is unavailable or fails, so
 * publishing an email asset can never fail on an optimization hiccup.
 */
export async function optimizeForEmail(bytes: Uint8Array, mimeType: string): Promise<OptimizedImage> {
  if (bytes.byteLength <= 300 * 1024) {
    const meta = await readImageMeta(bytes).catch(() => null);
    return { bytes, width: meta?.width ?? null, height: meta?.height ?? null };
  }

  try {
    const sharp = (await import("sharp")).default;
    const pipeline = sharp(Buffer.from(bytes), { failOn: "error" }).rotate();
    const metadata = await pipeline.metadata();
    const needsResize = (metadata.width ?? 0) > EMAIL_ASSET_MAX_WIDTH;
    const resized = needsResize ? pipeline.resize({ width: EMAIL_ASSET_MAX_WIDTH, withoutEnlargement: true }) : pipeline;

    let output: Buffer;
    if (mimeType === "image/png" && (metadata.width ?? 0) <= 1600) {
      output = await resized.png({ compressionLevel: 9 }).toBuffer();
    } else if (mimeType === "image/webp" && (metadata.width ?? 0) <= 1600) {
      output = await resized.webp({ quality: 85 }).toBuffer();
    } else {
      output = await resized.jpeg({ quality: 82, progressive: true }).toBuffer();
    }

    const finalMeta = await sharp(output).metadata();
    return {
      bytes: new Uint8Array(output),
      width: finalMeta.width ?? null,
      height: finalMeta.height ?? null,
    };
  } catch {
    const meta = await readImageMeta(bytes).catch(() => null);
    return { bytes, width: meta?.width ?? null, height: meta?.height ?? null };
  }
}

async function readImageMeta(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from(bytes), { failOn: "error" }).metadata();
    return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
  } catch {
    return null;
  }
}
