import { POST_ASSET_MAX_BYTES, detectPostAsset, type DetectedPostAsset } from "../post/asset";

export const TIKTOK_VIDEO_UPLOAD_ACCEPT = ".mp4,video/mp4";

export type TikTokVideoUploadError = "empty" | "too_large" | "not_mp4";

/**
 * TikTok draft uploads are deliberately narrower than Post Studio uploads:
 * one real MP4 container, at most the existing 20 MB asset limit. Browser
 * MIME metadata is never authoritative; the server passes the actual bytes.
 */
export function validateTikTokVideoUpload(
  bytes: Uint8Array,
  filename: string,
): { ok: true; detected: DetectedPostAsset } | { ok: false; code: TikTokVideoUploadError } {
  if (bytes.length < 1) return { ok: false, code: "empty" };
  if (bytes.length > POST_ASSET_MAX_BYTES) return { ok: false, code: "too_large" };
  if (!/\.mp4$/i.test(filename)) return { ok: false, code: "not_mp4" };
  const detected = detectPostAsset(bytes, filename);
  if (!detected || detected.kind !== "video" || detected.mimeType !== "video/mp4" || detected.extension !== "mp4") {
    return { ok: false, code: "not_mp4" };
  }
  return { ok: true, detected };
}
