import "server-only";

import { randomUUID } from "node:crypto";

import { buildPostDraftAssetWrite } from "@/lib/post/core";
import { POST_ASSET_BUCKET, removePostAssetObject } from "@/lib/post/server-data";
import { getSocialDraft, updateSocialDraft } from "@/lib/social/server-drafts";
import { inspectTikTokVideoDurationFromUrl } from "@/lib/tiktok/video-duration-server";
import type { createAdminClient } from "@/utils/supabase/admin";

import { cleanupTikTokUploads, type TikTokUploadPorts } from "./upload-session";

type AdminClient = ReturnType<typeof createAdminClient>;

/** Short-lived read URL for server-side checks of an uploaded object. */
const CHECK_URL_TTL_SECONDS = 120;

/**
 * Production ports for lib/tiktok/upload-session.ts. Every database read and
 * write is filtered by the authenticated owner; storage access uses the
 * service-role client on the server only and is limited to paths the pure
 * module has already validated as this owner's TikTok upload paths.
 */
export function createTikTokUploadPorts(admin: AdminClient): TikTokUploadPorts {
  const bucket = () => admin.storage.from(POST_ASSET_BUCKET);

  async function signedReadUrl(path: string): Promise<string | null> {
    const { data, error } = await bucket().createSignedUrl(path, CHECK_URL_TTL_SECONDS);
    return error || !data?.signedUrl ? null : data.signedUrl;
  }

  return {
    async loadDraft(ownerId, draftId) {
      const draft = await getSocialDraft(admin, ownerId, draftId);
      if (!draft) return null;
      return { kind: draft.kind, status: draft.status, queueStatus: draft.queueStatus, hasConsent: Boolean(draft.tiktokPost) };
    },
    async hasBusiness(ownerId) {
      const { data, error } = await admin.from("businesses").select("id").eq("owner_user_id", ownerId).maybeSingle();
      if (error) throw new Error("business_read_failed");
      return Boolean(data);
    },
    async createSignedUpload(path) {
      // upsert stays false: a path is unique per session and is never reused.
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error || !data?.token) throw new Error("signed_upload_failed");
      return { token: data.token };
    },
    async statObject(path) {
      const { data, error } = await bucket().info(path);
      if (error || !data) return null;
      const size = Number((data as { size?: unknown }).size);
      return Number.isFinite(size) ? { size } : null;
    },
    async readHeader(path, length) {
      const url = await signedReadUrl(path);
      if (!url || length < 1) return null;
      const response = await fetch(url, { headers: { Range: `bytes=0-${length - 1}` }, cache: "no-store" });
      if (!response.ok || !response.body) return null;
      // Bounded read: never more than `length` bytes, even if Range is ignored.
      const reader = response.body.getReader();
      const output = new Uint8Array(length);
      let offset = 0;
      try {
        while (offset < length) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          const take = Math.min(value.length, length - offset);
          output.set(value.subarray(0, take), offset);
          offset += take;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return output.subarray(0, offset);
    },
    async inspectDuration(path, size) {
      const url = await signedReadUrl(path);
      return url ? inspectTikTokVideoDurationFromUrl(url, size) : null;
    },
    async currentAssetPath(ownerId, draftId) {
      const { data, error } = await admin.from("post_draft_assets").select("storage_path")
        .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
      if (error) throw new Error("asset_read_failed");
      return typeof data?.storage_path === "string" ? data.storage_path : null;
    },
    async withdrawApproval(ownerId, draftId) {
      await updateSocialDraft(admin, ownerId, draftId, { decision: "draft" });
    },
    async linkAsset({ ownerId, draftId, path, size, displayName }) {
      const row = buildPostDraftAssetWrite({
        ownerUserId: ownerId,
        draftId,
        storagePath: path,
        displayName,
        mimeType: "video/mp4",
        byteSize: size,
        origin: "existing_content",
        kind: "tiktok_video",
      });
      const { error } = await admin.from("post_draft_assets").upsert(row, { onConflict: "owner_user_id,draft_id" });
      if (error) throw new Error("asset_link_failed");
    },
    async removeReplaced(ownerId, path) {
      await removePostAssetObject(admin, ownerId, path);
    },
    async removeObject(path) {
      await bucket().remove([path]);
    },
    async listUploads(folder) {
      const { data, error } = await bucket().list(folder, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
      if (error) throw new Error("upload_list_failed");
      return (data ?? [])
        .filter((item) => item.id)
        .map((item) => ({ path: `${folder}/${item.name}`, createdAt: item.created_at ?? null }));
    },
    newUploadId: () => randomUUID(),
    now: () => Date.now(),
  };
}

/** The resumable-upload endpoint for this project (Supabase's direct storage host). */
export function tiktokResumableEndpoint(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
    return match
      ? `https://${match[1]}.storage.supabase.co/storage/v1/upload/resumable`
      : `${url.origin}/storage/v1/upload/resumable`;
  } catch {
    return null;
  }
}

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Removes abandoned TikTok uploads across owners, one draft folder at a time,
 * with the same rule as the per-draft cleanup (older than the TUS window and
 * not the draft's linked video). Bounded per run; safe to run repeatedly.
 */
export async function cleanupAbandonedTikTokUploads(
  admin: AdminClient,
  limits: { owners?: number; draftsPerOwner?: number } = {},
): Promise<{ owners: number; drafts: number; removed: number; failed: number }> {
  const ports = createTikTokUploadPorts(admin);
  const bucket = admin.storage.from(POST_ASSET_BUCKET);
  const result = { owners: 0, drafts: 0, removed: 0, failed: 0 };
  const { data: owners, error } = await bucket.list("", { limit: limits.owners ?? 200 });
  if (error) throw new Error("upload_cleanup_list_failed");
  for (const owner of owners ?? []) {
    if (owner.id || !UUID_NAME.test(owner.name)) continue; // folders only
    result.owners += 1;
    const { data: drafts } = await bucket.list(`${owner.name}/tiktok-uploads`, { limit: limits.draftsPerOwner ?? 50 });
    for (const draft of drafts ?? []) {
      if (draft.id || !UUID_NAME.test(draft.name)) continue;
      result.drafts += 1;
      try {
        const { removed } = await cleanupTikTokUploads(ports, { ownerId: owner.name, draftId: draft.name });
        result.removed += removed.length;
      } catch {
        result.failed += 1;
      }
    }
  }
  return result;
}
