/** Native uploads only. Existing AI/social media limits remain unchanged. */
export const YOUTUBE_DIRECT_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
export const YOUTUBE_UPLOAD_BUCKET = "youtube-uploads";
export const YOUTUBE_TUS_CHUNK_BYTES = 6 * 1024 * 1024;
export const YOUTUBE_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const YOUTUBE_UPLOAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function youtubeMediaBucket(path: string): string {
  return /^[0-9a-f-]{36}\/youtube-uploads\/[0-9a-f-]{36}\.mp4$/.test(path) ? YOUTUBE_UPLOAD_BUCKET : "mara-media";
}

/**
 * What hosted Storage actually accepts today. The architecture (bucket,
 * database and validation) supports 256 MiB, but a project's GLOBAL Storage
 * limit caps every upload; Production's is 52,428,800 bytes (50 MiB) while
 * its organisation spend cap is on. Customers are offered only this effective
 * limit, so they never upload bytes Storage would refuse. Raise it with the
 * server-only YOUTUBE_UPLOAD_MAX_BYTES once the global limit is raised.
 */
export const YOUTUBE_UPLOAD_DEFAULT_EFFECTIVE_MAX_BYTES = 50 * 1024 * 1024;

/** Parses the configured effective limit; anything invalid falls back to the safe default. */
export function youtubeEffectiveMaxBytes(configured: string | undefined): number {
  if (configured === undefined || configured === "") return YOUTUBE_UPLOAD_DEFAULT_EFFECTIVE_MAX_BYTES;
  if (!/^[1-9][0-9]*$/.test(configured)) return YOUTUBE_UPLOAD_DEFAULT_EFFECTIVE_MAX_BYTES;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value <= YOUTUBE_DIRECT_UPLOAD_MAX_BYTES ? value : YOUTUBE_UPLOAD_DEFAULT_EFFECTIVE_MAX_BYTES;
}

/** A customer-facing size that never overstates the limit (whole MiB, shown as MB). */
export function youtubeUploadLimitLabel(maxBytes: number): string {
  return `${Math.floor(maxBytes / (1024 * 1024))} MB`;
}

export function validYouTubeUploadFile(name: unknown, size: unknown, maxBytes = YOUTUBE_DIRECT_UPLOAD_MAX_BYTES): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= 180 && /\.mp4$/i.test(name)
    && Number.isSafeInteger(size) && Number(size) > 0 && Number(size) <= Math.min(maxBytes, YOUTUBE_DIRECT_UPLOAD_MAX_BYTES);
}
