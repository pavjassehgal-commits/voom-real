/**
 * TikTok direct-upload lifecycle: start a session, finalize what arrived, and
 * clean up uploads that never finished. Dependency-injected (no Next, no
 * Supabase import) so every security rule is unit tested with fakes; the
 * production ports live in upload-session-server.ts.
 *
 *   start     identity → draft is the owner's TikTok Video → business exists →
 *             not already with TikTok → declared size/type OK → unique path →
 *             signed upload token for that one path (2 hours).
 *   finalize  identity and ownership again → the path is exactly this
 *             owner's and draft's upload path → the object exists → its real
 *             size is within 50 MB → its first bytes are MP4 → its duration
 *             can be read → withdraw any TikTok approval/consent → link it to
 *             post_draft_assets → delete the previous video. Repeating it for
 *             an already-linked path is a no-op success.
 *   cleanup   deletes this draft's upload objects that are older than the
 *             TUS window (26 h) and are not the draft's current video.
 *
 * Invalid uploads are deleted as soon as they are rejected. No step here
 * contacts TikTok or touches the publishing queue other than through the
 * existing withdraw-approval path (which cancels only rows TikTok does not own).
 */

import {
  isMp4Header,
  isTikTokUploadPathFor,
  tiktokUploadFolder,
  tiktokUploadPath,
  TIKTOK_UPLOAD_CHUNK_BYTES,
  TIKTOK_UPLOAD_HEADER_BYTES,
  TIKTOK_UPLOAD_STALE_MS,
  TIKTOK_UPLOAD_TOKEN_TTL_MS,
  TIKTOK_VIDEO_MAX_BYTES,
  validateTikTokUploadRequest,
} from "./video-upload";

const PROVIDER_OWNED = new Set(["posting", "provider_processing", "published"]);

export interface TikTokUploadDraft {
  kind: string;
  status: string;
  queueStatus: string | null;
  hasConsent: boolean;
}

export interface TikTokUploadPorts {
  loadDraft(ownerId: string, draftId: string): Promise<TikTokUploadDraft | null>;
  hasBusiness(ownerId: string): Promise<boolean>;
  createSignedUpload(path: string): Promise<{ token: string }>;
  /** The stored object's real size, or null when it does not exist. */
  statObject(path: string): Promise<{ size: number } | null>;
  /** The first `length` bytes of the stored object (bounded read). */
  readHeader(path: string, length: number): Promise<Uint8Array | null>;
  /** Trusted duration from the stored object, or null when unreadable. */
  inspectDuration(path: string, size: number): Promise<number | null>;
  currentAssetPath(ownerId: string, draftId: string): Promise<string | null>;
  /** Moves the draft back to draft, withdrawing TikTok consent and any queue row TikTok does not own. */
  withdrawApproval(ownerId: string, draftId: string): Promise<void>;
  linkAsset(input: { ownerId: string; draftId: string; path: string; size: number; displayName: string }): Promise<void>;
  /** Deletes a previously linked video (keeps objects other records still reference). */
  removeReplaced(ownerId: string, path: string): Promise<void>;
  /** Deletes an object that was never linked. */
  removeObject(path: string): Promise<void>;
  listUploads(folder: string): Promise<{ path: string; createdAt: string | null }[]>;
  newUploadId(): string;
  now(): number;
}

export type TikTokUploadFailure =
  | "not_found"
  | "not_tiktok"
  | "no_business"
  | "provider_owned"
  | "invalid"
  | "empty"
  | "too_large"
  | "not_mp4"
  | "invalid_path"
  | "upload_incomplete"
  | "invalid_video"
  | "unreadable_duration"
  | "storage_failure";

export type StartResult =
  | { ok: true; path: string; token: string; expiresAt: string; maxBytes: number; chunkSize: number }
  | { ok: false; code: TikTokUploadFailure };

export type FinalizeResult =
  | { ok: true; path: string; size: number; alreadyLinked: boolean }
  | { ok: false; code: TikTokUploadFailure };

async function checkDraft(ports: TikTokUploadPorts, ownerId: string, draftId: string): Promise<TikTokUploadFailure | null> {
  const draft = await ports.loadDraft(ownerId, draftId);
  if (!draft) return "not_found";
  if (draft.kind !== "tiktok_video") return "not_tiktok";
  if (!(await ports.hasBusiness(ownerId))) return "no_business";
  if (draft.queueStatus && PROVIDER_OWNED.has(draft.queueStatus)) return "provider_owned";
  return null;
}

export async function startTikTokUpload(
  ports: TikTokUploadPorts,
  input: { ownerId: string; draftId: string; fileName: unknown; fileSize: unknown; contentType?: unknown },
): Promise<StartResult> {
  const request = validateTikTokUploadRequest(input);
  if (!request.ok) return { ok: false, code: request.code };
  const refused = await checkDraft(ports, input.ownerId, input.draftId);
  if (refused) return { ok: false, code: refused };

  // Best effort: remove this draft's abandoned uploads before adding another.
  await cleanupTikTokUploads(ports, { ownerId: input.ownerId, draftId: input.draftId }).catch(() => undefined);

  const path = tiktokUploadPath(input.ownerId, input.draftId, ports.newUploadId());
  let token: string;
  try {
    ({ token } = await ports.createSignedUpload(path));
  } catch {
    return { ok: false, code: "storage_failure" };
  }
  if (!token) return { ok: false, code: "storage_failure" };
  return {
    ok: true,
    path,
    token,
    expiresAt: new Date(ports.now() + TIKTOK_UPLOAD_TOKEN_TTL_MS).toISOString(),
    maxBytes: TIKTOK_VIDEO_MAX_BYTES,
    chunkSize: TIKTOK_UPLOAD_CHUNK_BYTES,
  };
}

export async function finalizeTikTokUpload(
  ports: TikTokUploadPorts,
  input: { ownerId: string; draftId: string; path: unknown; displayName: string },
): Promise<FinalizeResult> {
  if (!isTikTokUploadPathFor(input.path, input.ownerId, input.draftId)) return { ok: false, code: "invalid_path" };
  const path = input.path;
  const refused = await checkDraft(ports, input.ownerId, input.draftId);
  if (refused) return { ok: false, code: refused };

  // Retrying a finalize that already succeeded changes nothing.
  const current = await ports.currentAssetPath(input.ownerId, input.draftId);
  const stat = await ports.statObject(path);
  if (current === path && stat) return { ok: true, path, size: stat.size, alreadyLinked: true };
  if (!stat) return { ok: false, code: "upload_incomplete" };

  const reject = async (code: TikTokUploadFailure): Promise<FinalizeResult> => {
    await ports.removeObject(path).catch(() => undefined);
    return { ok: false, code };
  };
  if (!Number.isSafeInteger(stat.size) || stat.size < 1) return reject("empty");
  if (stat.size > TIKTOK_VIDEO_MAX_BYTES) return reject("too_large");
  const header = await ports.readHeader(path, Math.min(TIKTOK_UPLOAD_HEADER_BYTES, stat.size)).catch(() => null);
  if (!isMp4Header(header)) return reject("invalid_video");
  const duration = await ports.inspectDuration(path, stat.size).catch(() => null);
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return reject("unreadable_duration");

  // A TikTok confirmation covers one specific video, so replacing it always
  // withdraws the approval and consent before the new video is linked.
  const draft = await ports.loadDraft(input.ownerId, input.draftId);
  if (draft && (draft.status !== "draft" || draft.hasConsent)) await ports.withdrawApproval(input.ownerId, input.draftId);

  try {
    await ports.linkAsset({ ownerId: input.ownerId, draftId: input.draftId, path, size: stat.size, displayName: input.displayName });
  } catch {
    return reject("storage_failure");
  }
  if (current && current !== path) await ports.removeReplaced(input.ownerId, current).catch(() => undefined);
  return { ok: true, path, size: stat.size, alreadyLinked: false };
}

/**
 * Deletes one draft's upload objects that are stale (older than the TUS
 * window) and are not the draft's current video. An upload still in progress
 * is younger than the window, and the linked video is always skipped.
 */
export async function cleanupTikTokUploads(
  ports: Pick<TikTokUploadPorts, "listUploads" | "currentAssetPath" | "removeObject" | "now">,
  input: { ownerId: string; draftId: string },
): Promise<{ removed: string[]; kept: number }> {
  const folder = tiktokUploadFolder(input.ownerId, input.draftId);
  const objects = await ports.listUploads(folder);
  const current = await ports.currentAssetPath(input.ownerId, input.draftId);
  const cutoff = ports.now() - TIKTOK_UPLOAD_STALE_MS;
  const removed: string[] = [];
  let kept = 0;
  for (const object of objects) {
    const created = object.createdAt ? Date.parse(object.createdAt) : NaN;
    const stale = Number.isFinite(created) && created < cutoff;
    if (!stale || object.path === current || !isTikTokUploadPathFor(object.path, input.ownerId, input.draftId)) {
      kept += 1;
      continue;
    }
    await ports.removeObject(object.path);
    removed.push(object.path);
  }
  return { removed, kept };
}
