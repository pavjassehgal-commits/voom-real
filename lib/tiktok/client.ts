import "server-only";

import type { TikTokConfig } from "./config.ts";
import {
  isRealTikTokPublishId,
  isTikTokPrivacy,
  isTikTokProviderStatus,
  uploadedBytesFromRange,
  TIKTOK_API_CALL_ALLOWANCE_MS,
  type TikTokApiErrorKind,
} from "./publishing.ts";
import { TIKTOK_SCOPES } from "./scopes.ts";

export { TIKTOK_SCOPES } from "./scopes.ts";

/**
 * The TikTok API client — official TikTok for Developers endpoints ONLY:
 *
 *   www.tiktok.com/v2/auth/authorize/            authorization (browser redirect)
 *   open.tiktokapis.com/v2/oauth/token/          code exchange + refresh
 *   open.tiktokapis.com/v2/oauth/revoke/         explicit token revocation
 *   open.tiktokapis.com/v2/user/info/            basic identity (user.info.basic)
 *   open.tiktokapis.com/v2/post/publish/
 *     creator_info/query/                        the creator's live posting options
 *     video/init/                                Direct Post init (video.publish)
 *     status/fetch/                              post status (the publication evidence)
 *   {upload_url returned by video/init}          chunked PUT transfer (FILE_UPLOAD)
 *
 * No endpoint, parameter or response field is invented. The chunked upload
 * follows TikTok's documented media-transfer protocol: PUT the declared
 * byte windows to the returned upload_url (including its query parameters)
 * with Content-Type / Content-Length / Content-Range; TikTok answers with a
 * `Content-Range: bytes 0-N/total` header stating the ACTUAL bytes it has
 * received, 416 when the range does not match its progress, 404 when the
 * upload task is gone, and 5xx as retryable.
 *
 * Secrets discipline: the access token travels only in the Authorization
 * header of these calls; it is never placed in a URL, an error message, a
 * log line or a thrown exception. The upload_url (which carries TikTok's
 * own upload token in its query string) is persisted in the durable queue
 * for resume purposes exactly like YouTube's session URL — it is never
 * rendered to the browser or written to a log.
 */

const REQUEST_TIMEOUT_MS = TIKTOK_API_CALL_ALLOWANCE_MS;
/** Chunk PUTs move megabytes; they get a longer ceiling than metadata calls. */
const UPLOAD_REQUEST_TIMEOUT_MS = 120_000;

export type TikTokApiOperation =
  | "code_exchange"
  | "token_refresh"
  | "token_revoke"
  | "user_info"
  | "creator_info"
  | "direct_post_init"
  | "upload_chunk"
  | "post_status";

/**
 * TikTok's documented machine error codes that mean "the token no longer
 * works" (expired, revoked by the creator, app permission removed, …).
 */
const AUTH_ERROR_CODES = new Set([
  "access_token_invalid",
  "invalid_token",
  "invalid_grant",
  "unauthorized_client",
  "scope_not_authorized",
  "invalid_authorization",
]);

/** Codes TikTok documents for throttling. */
const RATE_ERROR_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limited",
  "frequency_limited",
  "api_rate_limited",
]);

export class TikTokApiError extends Error {
  readonly kind: TikTokApiErrorKind;
  readonly operation: TikTokApiOperation;
  /** TikTok's own documented error code (e.g. privacy_level_option_mismatch). */
  readonly reason: string | null;
  /** The provider's own message, for diagnostics — never tokens or URLs. */
  readonly providerMessage: string | null;
  readonly httpStatus: number | null;

  constructor(
    kind: TikTokApiErrorKind,
    operation: TikTokApiOperation,
    reason: string | null = null,
    httpStatus: number | null = null,
    providerMessage: string | null = null,
  ) {
    super(`tiktok_api_${kind}${reason ? `_${reason}` : ""}`);
    this.name = "TikTokApiError";
    this.kind = kind;
    this.operation = operation;
    this.reason = reason;
    this.providerMessage = providerMessage;
    this.httpStatus = httpStatus;
  }
}

export interface TikTokTokenSet {
  /** The partner-facing user id — the authoritative connection identity. */
  openId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  refreshExpiresIn: number | null;
  /** The scopes TikTok actually granted (comma-separated in the response). */
  grantedScopes: string[];
}

export interface TikTokBasicUser {
  /** Null when TikTok's response did not carry the field — callers treat the token-exchange open_id as authoritative. */
  openId: string | null;
  unionId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** The creator's LIVE posting options (creator_info/query response). */
export interface TikTokCreatorInfo {
  creatorUsername: string | null;
  creatorNickname: string | null;
  creatorAvatarUrl: string | null;
  /** ONLY the values TikTok currently offers THIS creator — nothing invented. */
  privacyLevelOptions: string[];
  commentDisabled: boolean | null;
  duetDisabled: boolean | null;
  stitchDisabled: boolean | null;
  maxVideoPostDurationSec: number | null;
}

/** The post-status endpoint's answer — the publication evidence source. */
export interface TikTokPostStatus {
  status: string;
  /** Non-empty only when TikTok returned one (public posts, post-moderation). */
  postIds: string[];
  failReason: string | null;
}

export type ChunkUploadResult =
  | { outcome: "complete"; uploadedBytes: number }
  | { outcome: "range_mismatch"; uploadedBytes: number }
  | { outcome: "gone" };

export class TikTokClient {
  private readonly config: TikTokConfig;
  private readonly request: typeof fetch;

  constructor(config: TikTokConfig, request: typeof fetch = fetch) {
    this.config = config;
    this.request = request;
  }

  /**
   * The TikTok authorization URL. Server-side authorization-code flow:
   * response_type=code, the exact registered redirect_uri, the least-
   * privilege scope list, and the caller's cryptographically strong,
   * single-use state (CSRF protection — TikTok documents this check).
   */
  authorizationUrl(state: string): string {
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", this.config.clientKey);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  /**
   * Exchanges the one-time authorization code (valid 5 minutes) for tokens
   * SERVER-SIDE. TikTok documents a 24-hour access token and a 365-day
   * refresh token; a response without a refresh token cannot publish
   * unattended, so the caller refuses the connection truthfully.
   */
  async exchangeCode(code: string): Promise<TikTokTokenSet> {
    const body = new URLSearchParams({
      client_key: this.config.clientKey,
      client_secret: this.config.clientSecret,
      code,
      grant_type: "authorization_code",
      // TikTok binds the authorization code to the exact registered callback.
      // Keep this server-side validated value in lockstep with authorizationUrl.
      redirect_uri: this.config.redirectUri,
    });
    return this.tokenRequest("https://open.tiktokapis.com/v2/oauth/token/", body, "code_exchange");
  }

  /**
   * Refreshes the access token SERVER-SIDE. TikTok documents that the
   * returned refresh_token MAY ROTATE — when a different value comes back,
   * the new one is the only valid one, and the caller must persist it.
   */
  async refreshAccessToken(refreshToken: string): Promise<TikTokTokenSet> {
    const body = new URLSearchParams({
      client_key: this.config.clientKey,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return this.tokenRequest("https://open.tiktokapis.com/v2/oauth/token/", body, "token_refresh");
  }

  /**
   * Explicit revocation (TikTok's documented endpoint). Best-effort by
   * design: Voom's local disconnect NEVER depends on it succeeding — the
   * tokens are destroyed locally first, and revocation failure is reported
   * truthfully instead of blocking the disconnect.
   */
  async revokeAccessToken(accessToken: string): Promise<boolean> {
    try {
      const response = await this.request("https://open.tiktokapis.com/v2/oauth/revoke/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: this.config.clientKey,
          client_secret: this.config.clientSecret,
          token: accessToken,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * The authoritative basic identity (user.info.basic): open_id, union_id,
   * avatar_url and display_name — exactly the field set TikTok's scope
   * migration assigns to basic. The open_id from the token response is the
   * connection identity; this read fills the display fields TikTok itself
   * returned (never user-typed text).
   */
  async getBasicUser(accessToken: string): Promise<TikTokBasicUser> {
    const url = new URL("https://open.tiktokapis.com/v2/user/info/");
    url.searchParams.set(
      "fields",
      "open_id,union_id,avatar_url,avatar_url_100,avatar_url_200,avatar_large_url,display_name",
    );
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TikTokApiError("network", "user_info");
    }
    const text = await response.text().catch(() => "");
    const record = parseTikTokJsonBody(text) ?? {};
    const reason = extractTikTokErrorReason(record);
    if (!response.ok || (reason && reason !== "ok")) {
      throw await this.toApiError(response, "user_info", record);
    }
    const data = isRecord(record.data) ? record.data : {};
    const user = isRecord(data.user) ? data.user : {};
    return {
      openId: typeof user.open_id === "string" ? user.open_id : null,
      unionId: typeof user.union_id === "string" ? user.union_id : null,
      displayName: typeof user.display_name === "string" ? user.display_name : null,
      avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null,
    };
  }

  /**
   * The creator's LIVE posting options — TikTok requires the client to
   * query this before every post and to build the privacy/interaction
   * controls from the response. `privacyLevelOptions` is returned exactly
   * as TikTok lists it (public accounts get PUBLIC_TO_EVERYONE /
   * MUTUAL_FOLLOW_FRIENDS / SELF_ONLY; private accounts FOLLOWER_OF_CREATOR
   * / MUTUAL_FOLLOW_FRIENDS / SELF_ONLY). Unrecognized values are dropped;
   * an empty result is reported as such — never backfilled.
   */
  async queryCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    const value = await this.json("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", accessToken, "creator_info", {});
    const data = isRecord(value.data) ? value.data : {};
    const options = Array.isArray(data.privacy_level_options)
      ? data.privacy_level_options.filter((option): option is string => isTikTokPrivacy(option))
      : [];
    return {
      creatorUsername: typeof data.creator_username === "string" ? data.creator_username : null,
      creatorNickname: typeof data.creator_nickname === "string" ? data.creator_nickname : null,
      creatorAvatarUrl: typeof data.creator_avatar_url === "string" ? data.creator_avatar_url : null,
      privacyLevelOptions: options,
      commentDisabled: typeof data.comment_disabled === "boolean" ? data.comment_disabled : null,
      duetDisabled: typeof data.duet_disabled === "boolean" ? data.duet_disabled : null,
      stitchDisabled: typeof data.stitch_disabled === "boolean" ? data.stitch_disabled : null,
      maxVideoPostDurationSec: typeof data.max_video_post_duration_sec === "number" && Number.isFinite(data.max_video_post_duration_sec)
        ? Math.trunc(data.max_video_post_duration_sec)
        : null,
    };
  }

  /**
   * Direct Post init (video.publish). For FILE_UPLOAD TikTok returns the
   * publish_id (the provider tracking reference — NOT publication evidence)
   * and the upload_url the bytes must be PUT to. The caller persists the
   * publish_id BEFORE the first byte: a row that already carries a
   * publish_id is never re-initialized, which is what makes duplicate
   * posts structurally impossible on retry.
   */
  async initDirectPost(
    accessToken: string,
    metadata: Record<string, unknown>,
    sourceInfo: { source: "FILE_UPLOAD"; video_size: number; chunk_size: number; total_chunk_count: number },
  ): Promise<{ publishId: string; uploadUrl: string }> {
    const value = await this.json("https://open.tiktokapis.com/v2/post/publish/video/init/", accessToken, "direct_post_init", {
      ...metadata,
      source_info: sourceInfo,
    });
    const data = isRecord(value.data) ? value.data : {};
    const publishId = typeof data.publish_id === "string" ? data.publish_id : null;
    if (!isRealTikTokPublishId(publishId)) {
      // A "publish id" that does not have the documented shape is never
      // stored and never tracked.
      throw new TikTokApiError("invalid_request", "direct_post_init", "malformed_publish_id", 200);
    }
    const uploadUrl = typeof data.upload_url === "string" ? data.upload_url : null;
    if (!uploadUrl) {
      throw new TikTokApiError("invalid_request", "direct_post_init", "missing_upload_url", 200);
    }
    return { publishId, uploadUrl };
  }

  /**
   * One chunk of the FILE_UPLOAD transfer: PUT the declared byte window to
   * the EXACT url TikTok returned (its query string carries the upload
   * token). TikTok's documented answers: 200/201 with a Content-Range
   * header stating the real received progress; 416 when the window does
   * not match TikTok's own progress (the header tells where it is); 404
   * when the upload task is gone; 5xx as a transient retryable error.
   */
  async uploadChunk(
    uploadUrl: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    contentType: string,
    contentRange: string,
    contentLength: number,
  ): Promise<ChunkUploadResult> {
    let response: Response;
    try {
      response = await this.request(uploadUrl, {
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
      throw new TikTokApiError("network", "upload_chunk");
    }
    if (response.status === 200 || response.status === 201) {
      return { outcome: "complete", uploadedBytes: uploadedBytesFromRange(response.headers.get("content-range")) };
    }
    if (response.status === 416) {
      // Content-Range does not reflect TikTok's actual progress; its
      // response header (when present) states where TikTok really is.
      return { outcome: "range_mismatch", uploadedBytes: uploadedBytesFromRange(response.headers.get("content-range")) };
    }
    if (response.status === 404) {
      return { outcome: "gone" };
    }
    throw await this.toApiError(response, "upload_chunk");
  }

  /**
   * The post-status endpoint — the ONLY source of publication evidence.
   * PUBLISH_COMPLETE means TikTok posted the content; FAILED carries the
   * fail reason; PROCESSING_* means TikTok still owns the outcome. The
   * public post id is returned only for public-viewership posts that pass
   * TikTok's moderation — its absence is NOT a failure (private posts of
   * unaudited clients never get one).
   */
  async fetchPostStatus(accessToken: string, publishId: string): Promise<TikTokPostStatus> {
    if (!isRealTikTokPublishId(publishId)) {
      throw new TikTokApiError("invalid_request", "post_status", "publish_id_shape");
    }
    const value = await this.json("https://open.tiktokapis.com/v2/post/publish/status/fetch/", accessToken, "post_status", { publish_id: publishId });
    const data = isRecord(value.data) ? value.data : {};
    const status = typeof data.status === "string" ? data.status : null;
    if (!status || !isTikTokProviderStatus(status)) {
      throw new TikTokApiError("invalid_request", "post_status", "malformed_status", 200);
    }
    const postIds = Array.isArray(data.publicaly_available_post_id)
      ? data.publicaly_available_post_id.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return {
      status,
      postIds,
      failReason: typeof data.fail_reason === "string" ? data.fail_reason : null,
    };
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  private async tokenRequest(url: string, body: URLSearchParams, operation: "code_exchange" | "token_refresh"): Promise<TikTokTokenSet> {
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TikTokApiError("network", operation);
    }
    const text = await response.text().catch(() => "");
    const value = parseTikTokJsonBody(text);
    // A 200 with a non-ok error body is an error too (defensive: the
    // documented failures come as 4xx, but the classifier must not treat a
    // missing token as a successful exchange).
    const earlyReason = extractTikTokErrorReason(value);
    if (!response.ok || !value || (earlyReason && earlyReason !== "ok")) {
      const reason = earlyReason;
      const kind: TikTokApiErrorKind =
        (response.status === 400 || response.status === 401) && AUTH_ERROR_CODES.has(reason ?? "")
          ? "auth"
          : response.status === 429 || RATE_ERROR_CODES.has(reason ?? "")
            ? "rate_limited"
            : response.status >= 500
              ? "server"
              : response.status >= 400
                ? "invalid_request"
                : "unknown";
      throw new TikTokApiError(kind, operation, reason, response.status);
    }
    // v2 documents the token fields at the top level; the wrapped
    // `{ data: {...} }` envelope (v1 shape) is tolerated for robustness.
    const record = isRecord(value.data) ? (value.data as Record<string, unknown>) : value;
    return toTokenSet(record);
  }

  private async json(
    url: string | URL,
    accessToken: string,
    operation: TikTokApiOperation,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: body === undefined ? "{}" : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TikTokApiError("network", operation);
    }
    const text = await response.text().catch(() => "");
    const record = parseTikTokJsonBody(text) ?? {};
    const reason = extractTikTokErrorReason(record);
    if (!response.ok || (reason && reason !== "ok")) {
      throw await this.toApiError(response, operation, record);
    }
    return record;
  }

  /**
   * Classifies a failed TikTok API response using TikTok's own documented
   * error body: `{ error: { code, message, log_id } }` plus the HTTP status.
   * The exact codes that carry policy meaning (privacy/audit) are preserved
   * as `reason` so the failure taxonomy can act on them truthfully.
   * `parsed` carries the body when the caller already read it; otherwise the
   * body is read here (only when it has not been consumed).
   */
  private async toApiError(
    response: Response,
    operation: TikTokApiOperation,
    parsed: Record<string, unknown> | null = null,
  ): Promise<TikTokApiError> {
    let record = parsed;
    if (!record && !response.bodyUsed) {
      try {
        const text = await response.text();
        const candidate: unknown = text ? JSON.parse(text) : null;
        record = isRecord(candidate) ? candidate : null;
      } catch {
        record = null;
      }
    }
    const reason = record ? extractTikTokErrorReason(record) : null;
    const status = response.status;
    let kind: TikTokApiErrorKind;
    if (RATE_ERROR_CODES.has(reason ?? "") || status === 429) {
      kind = "rate_limited";
    } else if ((status === 401 || status === 403 || status === 400) && AUTH_ERROR_CODES.has(reason ?? "")) {
      kind = "auth";
    } else if (reason === "invalid_publish_id") {
      kind = "not_found";
    } else if (reason === "token_not_authorized_for_specified_publish_id") {
      // The token is valid but does not belong to this post's creator —
      // for Voom this is a "this post does not exist for this account".
      kind = "not_found";
    } else if (status >= 500) {
      kind = "server";
    } else if (status >= 400) {
      kind = "invalid_request";
    } else {
      kind = "unknown";
    }
    const errRecord = record && isRecord(record.error) ? record.error : null;
    const providerMessage = errRecord && typeof errRecord.message === "string" && errRecord.message
      ? errRecord.message.slice(0, 300)
      : null;
    return new TikTokApiError(kind, operation, reason, status, providerMessage);
  }
}

// ---------------------------------------------------------------------------
// Response parsing — tolerant of TikTok's JSON, strict about what counts
// as evidence.
// ---------------------------------------------------------------------------

function extractTikTokErrorReason(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const err = isRecord(value.error) ? value.error : null;
  if (err && typeof err.code === "string" && err.code) return err.code;
  return null;
}

function toTokenSet(value: Record<string, unknown>): TikTokTokenSet {
  const accessToken = typeof value.access_token === "string" ? value.access_token : null;
  if (!accessToken) {
    throw new TikTokApiError("invalid_request", "code_exchange", "missing_access_token", 200);
  }
  const openId = typeof value.open_id === "string" && value.open_id ? value.open_id : null;
  if (!openId) {
    // Without the open_id Voom cannot bind the connection to the
    // authoritative provider identity — refuse instead of guessing.
    throw new TikTokApiError("invalid_request", "code_exchange", "missing_open_id", 200);
  }
  const refreshToken = typeof value.refresh_token === "string" && value.refresh_token ? value.refresh_token : null;
  const expiresIn = Number(value.expires_in);
  const refreshExpiresInRaw = value.refresh_expires_in;
  const refreshExpiresIn = typeof refreshExpiresInRaw === "number" && Number.isFinite(refreshExpiresInRaw)
    ? refreshExpiresInRaw
    : null;
  const scope = typeof value.scope === "string" ? value.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return {
    openId,
    accessToken,
    refreshToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86400,
    refreshExpiresIn,
    grantedScopes: scope,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * JSON parsing that survives TikTok's 64-bit `publish_id`.
 *
 * TikTok documents publish_id as a bigInt that exceeds JavaScript's
 * safe integer range (2^53) — a plain `response.json()` would silently
 * round it and Voom would track (or status-check) the WRONG post. This
 * parser reads the body as text and quotes integer literals of 16 or more
 * digits before JSON.parse, so they land as exact strings. Small numbers
 * (expires_in, chunk counts) are untouched; string contents cannot match
 * the pattern (a quoted run is preceded by `"` or a digit, never by
 * `:`, `,` or `[`).
 */
export function parseTikTokJsonBody(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const protectedText = text.replace(/([:[,]\s*)(-?\d{16,})(\s*[,\]\}])/g, '$1"$2"$3');
  try {
    const value: unknown = JSON.parse(protectedText);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
