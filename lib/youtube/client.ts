import "server-only";

import type { YouTubeConfig } from "./config.ts";
import { YOUTUBE_SCOPES } from "./scopes.ts";
import {
  isRealYouTubeVideoId,
  receivedBytesFromRange,
  statusQueryRange,
  YOUTUBE_API_CALL_ALLOWANCE_MS,
} from "./publishing.ts";

export { YOUTUBE_SCOPES } from "./scopes.ts";

/**
 * The YouTube API client — official Google endpoints ONLY:
 *
 *   accounts.google.com/o/oauth2/v2/auth   authorization (browser redirect)
 *   oauth2.googleapis.com/token            code exchange + refresh
 *   oauth2.googleapis.com/revoke           explicit token revocation
 *   www.googleapis.com/youtube/v3/…        channels.list, videos.list,
 *                                          playlistItems.list (read-only)
 *   www.googleapis.com/upload/youtube/v3/… videos.insert resumable protocol
 *
 * No endpoint, parameter or response field is invented: the resumable upload
 * is Google's documented protocol (POST for a session URI, PUT chunks that
 * are exact multiples of 256 KiB, PUT `Content-Range: bytes * /size` to ask
 * what arrived, 308 = keep going, 200/201 = complete with the video
 * resource). There is NO separate Shorts endpoint — YouTube has none, so
 * Voom never invents one; a Short is the same videos.insert with a vertical
 * sub-3-minute video.
 *
 * Secrets discipline: the access token travels only in the Authorization
 * header of these calls; it is never placed in a URL, an error message, a
 * log line or a thrown exception. Errors carry Google's own documented
 * reason strings and nothing else.
 */

const REQUEST_TIMEOUT_MS = YOUTUBE_API_CALL_ALLOWANCE_MS;
/** Chunk PUTs move megabytes; they get a longer ceiling than metadata calls. */
const UPLOAD_REQUEST_TIMEOUT_MS = 120_000;

export type YouTubeApiErrorKind =
  | "quota"
  | "rate_limited"
  | "auth"
  | "not_found"
  | "invalid_request"
  | "server"
  | "network"
  | "unknown";

export type YouTubeApiOperation =
  | "code_exchange"
  | "token_refresh"
  | "token_revoke"
  | "channel"
  | "upload_session"
  | "upload_chunk"
  | "upload_status"
  | "video_read"
  | "uploads_list";

/** Google's documented quota/rate error reasons, mapped onto kinds. */
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "userRateLimitExceeded", "rateLimitExceeded"]);

export class YouTubeApiError extends Error {
  readonly kind: YouTubeApiErrorKind;
  readonly operation: YouTubeApiOperation;
  /** Google's own error reason string (e.g. quotaExceeded, invalidGrant). */
  readonly reason: string | null;
  readonly httpStatus: number | null;

  constructor(kind: YouTubeApiErrorKind, operation: YouTubeApiOperation, reason: string | null = null, httpStatus: number | null = null) {
    super(`youtube_api_${kind}`);
    this.name = "YouTubeApiError";
    this.kind = kind;
    this.operation = operation;
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export interface YouTubeTokenSet {
  accessToken: string;
  /** Present only when Google issued one (offline access, first consent). */
  refreshToken: string | null;
  expiresIn: number;
  /** The scopes Google actually granted. */
  grantedScopes: string[];
}

export interface YouTubeChannel {
  channelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string | null;
}

export interface YouTubeVideoRead {
  videoId: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  rejectionReason: string | null;
  failureReason: string | null;
  title: string | null;
  publishedAt: string | null;
  /** Real statistics ONLY when YouTube returned numbers; else absent. */
  statistics: { views?: number; likes?: number; comments?: number };
}

export interface UploadSessionStart {
  sessionUrl: string;
}

export type ChunkResult =
  | { outcome: "continue"; receivedBytes: number }
  | { outcome: "complete"; videoId: string; uploadStatus: string | null; privacyStatus: string | null }
  | { outcome: "gone" };

export class YouTubeClient {
  private readonly config: YouTubeConfig;
  private readonly request: typeof fetch;

  constructor(config: YouTubeConfig, request: typeof fetch = fetch) {
    this.config = config;
    this.request = request;
  }

  /**
   * The Google authorization URL. Server-side authorization-code flow with
   * offline access: `access_type=offline` + `prompt=consent` is how Google
   * issues the long-lived refresh token Voom needs to publish later without
   * the user present. The state is the caller's cryptographically strong,
   * single-use value.
   */
  authorizationUrl(state: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  }

  async exchangeCode(code: string): Promise<YouTubeTokenSet> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
    });
    const value = await this.postForm("https://oauth2.googleapis.com/token", body, "code_exchange");
    return toTokenSet(value);
  }

  async refreshAccessToken(refreshToken: string): Promise<YouTubeTokenSet> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
    });
    const value = await this.postForm("https://oauth2.googleapis.com/token", body, "token_refresh");
    // A refresh never returns a new refresh token; the existing one persists.
    return { ...toTokenSet(value), refreshToken };
  }

  /**
   * Explicit revocation (Google's documented endpoint). Best-effort by
   * design: Voom's local disconnect NEVER depends on it succeeding — the
   * tokens are destroyed locally first, and revocation failure is reported
   * truthfully instead of blocking the disconnect.
   */
  async revokeToken(token: string): Promise<boolean> {
    try {
      const response = await this.request("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * The authoritative channel identity: channels.list?mine=true with the
   * owner's own token. The channel id, title and handle come from YouTube —
   * never from user input.
   */
  async getMyChannel(accessToken: string): Promise<YouTubeChannel> {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("mine", "true");
    const value = await this.getJson(url, accessToken, "channel");
    const item = firstItem(value);
    if (!item || typeof item.id !== "string" || !item.id) {
      throw new YouTubeApiError("invalid_request", "channel", "no_channel", 200);
    }
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    const contentDetails = isRecord(item.contentDetails) ? item.contentDetails : {};
    const related = isRecord(contentDetails.relatedPlaylists) ? contentDetails.relatedPlaylists : {};
    const thumbnails = isRecord(snippet.thumbnails) ? snippet.thumbnails : {};
    const thumb = isRecord(thumbnails.default) ? thumbnails.default : isRecord(thumbnails.medium) ? thumbnails.medium : {};
    return {
      channelId: item.id,
      title: typeof snippet.title === "string" ? snippet.title : item.id,
      handle: typeof snippet.customUrl === "string" && snippet.customUrl ? snippet.customUrl : null,
      thumbnailUrl: typeof thumb.url === "string" ? thumb.url : null,
      uploadsPlaylistId: typeof related.uploads === "string" && related.uploads ? related.uploads : null,
    };
  }

  // -------------------------------------------------------------------------
  // Resumable upload protocol (Google's documented two-phase flow)
  // -------------------------------------------------------------------------

  /**
   * Phase 1: POST the video metadata; the response's Location header is the
   * resumable session URI (valid ~one week). X-Upload-Content-Type and
   * X-Upload-Content-Length declare the bytes that will follow.
   */
  async initiateUploadSession(
    accessToken: string,
    metadata: Record<string, unknown>,
    contentType: string,
    contentLength: number,
  ): Promise<UploadSessionStart> {
    const url = new URL("https://www.googleapis.com/upload/youtube/v3/videos");
    url.searchParams.set("part", "snippet,status");
    url.searchParams.set("uploadType", "resumable");
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": contentType,
          "X-Upload-Content-Length": String(contentLength),
        },
        body: JSON.stringify(metadata),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new YouTubeApiError("network", "upload_session");
    }
    if (!response.ok) throw await this.toApiError(response, "upload_session");
    const sessionUrl = response.headers.get("location");
    if (!sessionUrl) throw new YouTubeApiError("invalid_request", "upload_session", "no_location", response.status);
    return { sessionUrl };
  }

  /**
   * Phase 2: PUT one chunk. The body streams straight through — the client
   * never buffers a whole video. Google answers 308 (Resume Incomplete) with
   * a Range header, or 200/201 with the finished video resource.
   */
  async uploadChunk(
    sessionUrl: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    contentType: string,
    contentRange: string,
    contentLength: number,
  ): Promise<ChunkResult> {
    let response: Response;
    try {
      response = await this.request(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(contentLength),
          "Content-Range": contentRange,
        },
        body: body as BodyInit,
        // Node/undici requires this for streaming bodies; harmless elsewhere.
        ...({ duplex: "half" } as Record<string, string>),
        signal: AbortSignal.timeout(UPLOAD_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new YouTubeApiError("network", "upload_chunk");
    }
    return this.toChunkResult(response, "upload_chunk");
  }

  /**
   * Ask the session what it received: PUT with `Content-Range: bytes * /size`
   * and an empty body. 308 + Range = partial (resume from there); 200/201 =
   * it actually COMPLETED (recover the video id); 404/410 = the session is
   * gone (expired OR completed-then-discarded — the caller must treat that
   * as ambiguous and verify read-only before ever re-uploading).
   */
  async queryUploadStatus(sessionUrl: string, totalSize: number): Promise<ChunkResult> {
    let response: Response;
    try {
      response = await this.request(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Length": "0",
          "Content-Range": statusQueryRange(totalSize),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new YouTubeApiError("network", "upload_status");
    }
    return this.toChunkResult(response, "upload_status");
  }

  private async toChunkResult(response: Response, operation: YouTubeApiOperation): Promise<ChunkResult> {
    if (response.status === 308) {
      return { outcome: "continue", receivedBytes: receivedBytesFromRange(response.headers.get("range")) };
    }
    if (response.status === 404 || response.status === 410) {
      return { outcome: "gone" };
    }
    if (response.status === 200 || response.status === 201) {
      const value = await response.json().catch(() => null);
      const record = isRecord(value) ? value : {};
      const videoId = typeof record.id === "string" ? record.id : null;
      if (!isRealYouTubeVideoId(videoId)) {
        // A completion WITHOUT a real 11-character video id is not evidence
        // of publication. Fail closed: never store a fabricated id.
        throw new YouTubeApiError("invalid_request", operation, "completion_without_video_id", response.status);
      }
      const status = isRecord(record.status) ? record.status : {};
      return {
        outcome: "complete",
        videoId,
        uploadStatus: typeof status.uploadStatus === "string" ? status.uploadStatus : null,
        privacyStatus: typeof status.privacyStatus === "string" ? status.privacyStatus : null,
      };
    }
    throw await this.toApiError(response, operation);
  }

  // -------------------------------------------------------------------------
  // Read-only provider evidence
  // -------------------------------------------------------------------------

  /**
   * videos.list for ONE owned video id: processing status, privacy YouTube
   * actually applied, rejection reasons and public statistics. Returns null
   * when YouTube returns no item (the video does not exist / is not visible
   * to this token) — an honest "not found", never a zero-filled metric bag.
   */
  async getVideo(accessToken: string, videoId: string): Promise<YouTubeVideoRead | null> {
    if (!isRealYouTubeVideoId(videoId)) {
      throw new YouTubeApiError("invalid_request", "video_read", "video_id_shape");
    }
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,status,processingDetails,statistics");
    url.searchParams.set("id", videoId);
    const value = await this.getJson(url, accessToken, "video_read");
    const item = firstItem(value);
    if (!item) return null;
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    const status = isRecord(item.status) ? item.status : {};
    const processing = isRecord(item.processingDetails) ? item.processingDetails : {};
    const stats = isRecord(item.statistics) ? item.statistics : {};
    const uploadStatus = typeof processing.uploadStatus === "string" ? processing.uploadStatus
      : typeof status.uploadStatus === "string" ? status.uploadStatus : null;
    const statistics: { views?: number; likes?: number; comments?: number } = {};
    const views = parseCount(stats.viewCount);
    const likes = parseCount(stats.likeCount);
    const comments = parseCount(stats.commentCount);
    if (views !== null) statistics.views = views;
    if (likes !== null) statistics.likes = likes;
    if (comments !== null) statistics.comments = comments;
    return {
      videoId,
      uploadStatus,
      privacyStatus: typeof status.privacyStatus === "string" ? status.privacyStatus : null,
      rejectionReason: typeof status.rejectionReason === "string" ? status.rejectionReason : null,
      failureReason: typeof status.failureReason === "string" ? status.failureReason : null,
      title: typeof snippet.title === "string" ? snippet.title : null,
      publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : null,
      statistics,
    };
  }

  /**
   * The channel's most recent uploads, read-only, via the uploads playlist
   * YouTube exposes in channels.list contentDetails. This is the recovery
   * read for an ambiguous upload outcome: it can find the provider's own
   * video id WITHOUT ever risking a duplicate upload.
   */
  async listRecentUploads(accessToken: string, uploadsPlaylistId: string, maxResults = 10): Promise<Array<{ videoId: string; title: string | null; publishedAt: string | null }>> {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 50)));
    const value = await this.getJson(url, accessToken, "uploads_list");
    const items = Array.isArray(value.items) ? value.items.filter(isRecord) : [];
    const uploads: Array<{ videoId: string; title: string | null; publishedAt: string | null }> = [];
    for (const item of items) {
      const contentDetails = isRecord(item.contentDetails) ? item.contentDetails : {};
      const snippet = isRecord(item.snippet) ? item.snippet : {};
      const videoId = typeof contentDetails.videoId === "string" ? contentDetails.videoId : null;
      if (!isRealYouTubeVideoId(videoId)) continue;
      uploads.push({
        videoId,
        title: typeof snippet.title === "string" ? snippet.title : null,
        publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : null,
      });
    }
    return uploads;
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  private async getJson(url: URL, accessToken: string, operation: YouTubeApiOperation): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new YouTubeApiError("network", operation);
    }
    if (!response.ok) throw await this.toApiError(response, operation);
    const value = await response.json().catch(() => null);
    return isRecord(value) ? value : {};
  }

  private async postForm(url: string, body: URLSearchParams, operation: YouTubeApiOperation): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new YouTubeApiError("network", operation);
    }
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      // The token endpoint reports invalid_grant for a revoked/expired
      // refresh token — the truthful "authorization no longer valid".
      const reason = isRecord(value) && typeof value.error === "string" ? value.error : null;
      const kind: YouTubeApiErrorKind = response.status === 400 && (reason === "invalid_grant" || reason === "unauthorized_client")
        ? "auth"
        : response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "server"
            : "invalid_request";
      throw new YouTubeApiError(kind, operation, reason, response.status);
    }
    return isRecord(value) ? value : {};
  }

  /** Classifies a failed Data/upload API response using Google's own error body. */
  private async toApiError(response: Response, operation: YouTubeApiOperation): Promise<YouTubeApiError> {
    const value = await response.json().catch(() => null);
    const err = isRecord(value) && isRecord(value.error) ? value.error : null;
    // Google's documented error body: { error: { code, message, errors: [{ reason, domain }] } }
    // — the machine reason lives in the errors ARRAY; a top-level `reason`
    // (some gateway shapes) is only a fallback.
    const errItems = err && Array.isArray(err.errors) ? err.errors.filter(isRecord) : [];
    const reason = errItems.length && typeof errItems[0].reason === "string"
      ? errItems[0].reason
      : err && typeof err.reason === "string"
        ? err.reason
        : null;
    const status = response.status;
    let kind: YouTubeApiErrorKind;
    if (reason && QUOTA_REASONS.has(reason)) {
      kind = reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" ? "rate_limited" : "quota";
    } else if (status === 401 || status === 403) {
      // 403 without a quota reason is an authorization/permission problem
      // (token revoked, scope missing, accessNotConfigured).
      kind = "auth";
    } else if (status === 404) {
      kind = "not_found";
    } else if (status === 429) {
      kind = "rate_limited";
    } else if (status >= 500) {
      kind = "server";
    } else if (status >= 400) {
      kind = "invalid_request";
    } else {
      kind = "unknown";
    }
    return new YouTubeApiError(kind, operation, reason, status);
  }
}

// ---------------------------------------------------------------------------
// Response parsing — tolerant of Google's stringly-typed JSON, strict about
// what counts as evidence.
// ---------------------------------------------------------------------------

function toTokenSet(value: Record<string, unknown>): YouTubeTokenSet {
  const accessToken = typeof value.access_token === "string" ? value.access_token : null;
  if (!accessToken) throw new YouTubeApiError("invalid_request", "code_exchange", "missing_access_token", 200);
  const refreshToken = typeof value.refresh_token === "string" && value.refresh_token ? value.refresh_token : null;
  const expiresIn = Number(value.expires_in);
  const scope = typeof value.scope === "string" ? value.scope.split(" ").filter(Boolean) : [];
  return { accessToken, refreshToken, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600, grantedScopes: scope };
}

function firstItem(value: Record<string, unknown>): Record<string, unknown> | null {
  const items = Array.isArray(value.items) ? value.items.filter(isRecord) : [];
  return items[0] ?? null;
}

/** YouTube returns statistics as decimal STRINGS ("1234"). */
function parseCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
