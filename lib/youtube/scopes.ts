/**
 * The permissions Voom asks Google for when a channel connects — least
 * privilege, and nothing else.
 *
 *   youtube.upload    the ONLY scope that permits videos.insert (uploading a
 *                     video with its metadata). It cannot read channel data,
 *                     cannot modify existing videos, cannot delete anything.
 *   youtube.readonly  read-only channel identity (channels.list?mine=true —
 *                     the authoritative channel id/title/handle), video
 *                     status (processingDetails.uploadStatus, the published
 *                     evidence) and public statistics (viewCount, likeCount,
 *                     commentCount) for Performance.
 *
 * Deliberately ABSENT:
 *   youtube.force-ssl / youtube        would allow editing or deleting the
 *                                      customer's existing videos. Voom never
 *                                      edits or deletes a video after upload,
 *                                      so it never asks for that power.
 *   yt-analytics.readonly /            monetary analytics. Voom Performance
 *   yt-analytics-monetary.readonly     reports public Data API statistics
 *                                      only — never revenue.
 *   userinfo/openid                    Voom already knows who the user is;
 *                                      the channel identity comes from
 *                                      channels.list, not from Google profile
 *                                      scopes.
 */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export const YOUTUBE_SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE] as const;

/** True when the granted scopes permit uploading a video. */
export function hasUploadPermission(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(YOUTUBE_UPLOAD_SCOPE);
}

/** True when the granted scopes permit reading channel/video/statistics data. */
export function hasReadPermission(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(YOUTUBE_READONLY_SCOPE);
}
