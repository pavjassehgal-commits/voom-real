import { detectPostAsset } from "../post/asset";

/**
 * TikTok draft video upload rules — pure and browser-safe, shared by the
 * editor, the upload-session and finalize routes, and the cleanup job.
 *
 * Video bytes never pass through a Vercel Function (4.5 MB request limit):
 * the browser uploads straight to the private `mara-media` bucket with
 * Supabase's resumable (TUS) protocol, using a short-lived signed token that
 * is valid for one path only. The server then verifies what actually arrived.
 *
 * 50 MB is the Supabase project-wide upload limit while the spend cap is on;
 * the bucket allows more, so this module (and the finalize step) enforce it.
 */

export const TIKTOK_VIDEO_UPLOAD_ACCEPT = ".mp4,video/mp4";
export const TIKTOK_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** Supabase's resumable endpoint requires 6 MB chunks. */
export const TIKTOK_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;
/** Bytes read back from storage to check the MP4 signature. */
export const TIKTOK_UPLOAD_HEADER_BYTES = 64 * 1024;
/** Folder under each owner's prefix that holds TikTok uploads. */
export const TIKTOK_UPLOAD_FOLDER = "tiktok-uploads";
/**
 * A TUS upload URL stays usable for 24 hours, so an object younger than this
 * may still be receiving bytes. Cleanup only touches objects older than it.
 */
export const TIKTOK_UPLOAD_STALE_MS = 26 * 60 * 60 * 1000;
/** Supabase signed upload tokens are valid for 2 hours. */
export const TIKTOK_UPLOAD_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");

export type TikTokUploadRequestError = "empty" | "too_large" | "not_mp4" | "invalid";

/** Checks what the browser declares before any upload permission is issued. */
export function validateTikTokUploadRequest(input: {
  fileName: unknown;
  fileSize: unknown;
  contentType?: unknown;
}): { ok: true; fileName: string; fileSize: number } | { ok: false; code: TikTokUploadRequestError } {
  const { fileName, fileSize, contentType } = input;
  if (typeof fileName !== "string" || fileName.length < 5 || fileName.length > 255) return { ok: false, code: "invalid" };
  if (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize)) return { ok: false, code: "invalid" };
  if (fileSize < 1) return { ok: false, code: "empty" };
  if (fileSize > TIKTOK_VIDEO_MAX_BYTES) return { ok: false, code: "too_large" };
  if (!/\.mp4$/i.test(fileName)) return { ok: false, code: "not_mp4" };
  if (contentType !== undefined && contentType !== null && contentType !== "" && contentType !== "video/mp4") {
    return { ok: false, code: "not_mp4" };
  }
  return { ok: true, fileName, fileSize };
}

/** The only shape a TikTok upload path may have: owner / folder / draft / upload id. */
export function tiktokUploadPath(ownerId: string, draftId: string, uploadId: string): string {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(draftId) || !UUID_RE.test(uploadId)) throw new Error("tiktok_upload_path_invalid");
  return `${ownerId}/${TIKTOK_UPLOAD_FOLDER}/${draftId}/${uploadId}.mp4`.toLowerCase();
}

/** The folder that holds one draft's uploads. */
export function tiktokUploadFolder(ownerId: string, draftId: string): string {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(draftId)) throw new Error("tiktok_upload_path_invalid");
  return `${ownerId}/${TIKTOK_UPLOAD_FOLDER}/${draftId}`.toLowerCase();
}

/**
 * True only when `path` is exactly an upload path for this owner and draft.
 * Anything else — another owner, another draft, `..`, extra segments, a
 * different extension — is rejected, so a client can never point the server
 * at an object it does not own.
 */
export function isTikTokUploadPathFor(path: unknown, ownerId: string, draftId: string): path is string {
  if (typeof path !== "string" || path.length > 200) return false;
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(draftId)) return false;
  const pattern = new RegExp(`^${ownerId.toLowerCase()}/${TIKTOK_UPLOAD_FOLDER}/${draftId.toLowerCase()}/${UUID}\\.mp4$`);
  return pattern.test(path);
}

/** True when the stored object's first bytes are a real MP4 (never the browser's word for it). */
export function isMp4Header(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes.length < 16) return false;
  const detected = detectPostAsset(bytes, "upload.mp4");
  return Boolean(detected && detected.kind === "video" && detected.mimeType === "video/mp4" && detected.extension === "mp4");
}

/** Plain-language messages for the editor. */
export function tiktokUploadErrorMessage(code: string): string {
  switch (code) {
    case "too_large": return "Choose an MP4 video up to 50 MB.";
    case "empty": return "That file is empty. Choose an MP4 video.";
    case "not_mp4":
    case "invalid_video": return "That file isn't a valid MP4 video. Export it as MP4 and try again.";
    case "unreadable_duration": return "Voom couldn't read this video's length. Export it again as a standard MP4 and retry.";
    case "upload_incomplete": return "The upload didn't finish. Retry the upload.";
    case "provider_owned": return "TikTok already has this video, so it can't be replaced.";
    default: return "Voom couldn't upload that video. Please retry.";
  }
}
