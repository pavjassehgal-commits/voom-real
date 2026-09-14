import "server-only";

import type { InstagramConfig } from "./config";
import { INSTAGRAM_SCOPES } from "./scopes";

export { INSTAGRAM_SCOPES } from "./scopes";

const REQUEST_TIMEOUT_MS = 15_000;

export class InstagramApiError extends Error {
  constructor(
    public readonly code: "rate_limited" | "unauthorized" | "unavailable" | "invalid_response",
    public readonly operation:
      | "code_exchange"
      | "long_token_exchange"
      | "profile"
      | "media_container"
      | "media_status"
      | "media_publish"
      // Read-only performance operations (never publish, never mutate).
      | "media_details"
      | "media_insights"
      | null = null,
    public readonly providerReason: "credentials" | "redirect" | "code" | "app_configuration" | "rejected" | null = null,
  ) {
    super(code);
  }
}

export class InstagramClient {
  constructor(private readonly config: InstagramConfig, private readonly request: typeof fetch = fetch) {}

  authorizationUrl(state: string) {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", this.config.appId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
    url.searchParams.set("state", state);
    url.searchParams.set("enable_fb_login", "0");
    url.searchParams.set("force_reauth", "true");
    return url.toString();
  }

  async exchangeCode(code: string) {
    const body = new URLSearchParams({ client_id: this.config.appId, client_secret: this.config.appSecret, grant_type: "authorization_code", redirect_uri: this.config.redirectUri, code });
    const short = await this.fetchJson("https://api.instagram.com/oauth/access_token", { method: "POST", body }, "code_exchange");
    const shortToken = stringField(short, "access_token");
    const userId = stringField(short, "user_id");
    // Meta's long-lived token exchange is intentionally unversioned. Graph
    // resource requests are versioned, but /access_token rejects that prefix.
    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", this.config.appSecret);
    longUrl.searchParams.set("access_token", shortToken);
    const long = await this.fetchJson(longUrl, undefined, "long_token_exchange");
    return { accessToken: stringField(long, "access_token"), userId, expiresIn: numberField(long, "expires_in") };
  }

  async getProfile(accessToken: string, userId: string) {
    const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/me`);
    // The Instagram Login identity endpoint reliably exposes these two fields.
    // Additional profile fields vary by API version and can reject the entire
    // request, so connection setup intentionally uses the minimum field set.
    url.searchParams.set("fields", "id,username");
    url.searchParams.set("access_token", accessToken);
    const value = await this.fetchJson(url, undefined, "profile");
    return {
      userId: optionalString(value, "id") ?? optionalString(value, "user_id") ?? userId,
      username: stringField(value, "username"),
      name: optionalString(value, "name"),
      accountType: optionalString(value, "account_type"),
      profilePictureUrl: optionalString(value, "profile_picture_url"),
    };
  }

  async getMedia(accessToken: string, limit = 12) {
    const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/me/media`);
    url.searchParams.set("fields", "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count");
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 25)));
    url.searchParams.set("access_token", accessToken);
    const value = await this.fetchJson(url, undefined, "profile");
    return Array.isArray(value.data) ? value.data.filter(isRecord) : [];
  }

  async getAccountInsights(accessToken: string) {
    const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/me/insights`);
    url.searchParams.set("metric", "views,reach,accounts_engaged,total_interactions,follower_count");
    url.searchParams.set("period", "day");
    url.searchParams.set("metric_type", "total_value");
    url.searchParams.set("access_token", accessToken);
    const value = await this.fetchJson(url, undefined, "profile");
    return Array.isArray(value.data) ? value.data.filter(isRecord) : [];
  }

  // -------------------------------------------------------------------------
  // Performance reads (READ-ONLY)
  //
  // These calls only ever GET an already-published media item and its
  // insights. They are used by the performance sync, which must never publish,
  // never create a container and never modify a media item or a caption — so
  // nothing in this section can mutate anything on Meta's side.
  // -------------------------------------------------------------------------

  /**
   * Documented media-node fields for ONE owned media id. `like_count` and
   * `comments_count` are real Meta values available with the basic read
   * permission, which is why they are the honest fallback when per-media
   * insights are not exposed for the account.
   *
   * The richer field set is tried first; a version that rejects
   * `media_product_type` still yields the minimal set instead of failing the
   * whole read.
   */
  async getMediaDetails(accessToken: string, mediaId: string): Promise<Record<string, unknown> | null> {
    const read = async (fields: string) => {
      const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/${mediaId}`);
      url.searchParams.set("fields", fields);
      url.searchParams.set("access_token", accessToken);
      return this.fetchJson(url, undefined, "media_details");
    };
    try {
      return await read("id,media_type,media_product_type,like_count,comments_count,timestamp,permalink");
    } catch (error) {
      if (!(error instanceof InstagramApiError) || error.code !== "invalid_response") throw error;
      return read("id,media_type,like_count,comments_count,timestamp");
    }
  }

  /**
   * Per-media insights for one media kind, tolerant of per-metric availability.
   *
   * Meta fails the WHOLE request when one requested metric is not supported for
   * that media kind/account, so the batch is attempted first and — only if it
   * is refused — each metric is retried on its own. Whatever Meta legitimately
   * returns is passed through as raw entries (normalized in lib/performance);
   * whatever it refuses is reported as unavailable and simply never stored.
   *
   * `rate_limited` and `unauthorized` are re-thrown: those are connection or
   * quota conditions, not metric availability, and the caller must stop rather
   * than hammer Meta.
   */
  async getMediaInsights(input: { accessToken: string; mediaId: string; metrics: string[] }): Promise<MediaInsightsRead> {
    const request = async (metrics: string[]) => {
      const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/${input.mediaId}/insights`);
      url.searchParams.set("metric", metrics.join(","));
      url.searchParams.set("access_token", input.accessToken);
      return this.fetchJson(url, undefined, "media_insights");
    };
    if (!input.metrics.length) return { entries: [], unavailable: [], refused: false };
    try {
      const value = await request(input.metrics);
      const entries = Array.isArray(value.data) ? value.data : [];
      return { entries, unavailable: input.metrics.filter((metric) => !mentionsMetric(entries, metric)), refused: false };
    } catch (error) {
      if (!(error instanceof InstagramApiError)) throw error;
      if (error.code === "rate_limited" || error.code === "unauthorized") throw error;
    }
    const entries: unknown[] = [];
    const unavailable: string[] = [];
    for (const metric of input.metrics) {
      try {
        const value = await request([metric]);
        const data = Array.isArray(value.data) ? value.data : [];
        if (data.length) entries.push(...data);
        else unavailable.push(metric);
      } catch (error) {
        if (!(error instanceof InstagramApiError)) throw error;
        if (error.code === "rate_limited" || error.code === "unauthorized") throw error;
        // Unsupported for this media kind, expired (Stories), or absent: the
        // metric is recorded as not exposed and nothing is stored for it.
        unavailable.push(metric);
      }
    }
    return { entries, unavailable, refused: entries.length === 0 };
  }

  // -------------------------------------------------------------------------
  // Content publishing (Instagram Login / graph.instagram.com)
  //
  // Requires the instagram_business_content_publish permission on the token.
  // Meta's flow is: create a media container, wait until it reports FINISHED,
  // then publish the container. Only media_publish returns a real media id —
  // that id is the ONLY thing Voom ever treats as "Published".
  // -------------------------------------------------------------------------

  /** Creates an IMAGE media container from a publicly fetchable image URL. */
  async createImageContainer(input: { accessToken: string; igUserId: string; imageUrl: string; caption: string }) {
    const body = new URLSearchParams({
      image_url: input.imageUrl,
      caption: input.caption,
      access_token: input.accessToken,
    });
    const value = await this.fetchJson(
      `https://graph.instagram.com/${this.config.graphVersion}/${input.igUserId}/media`,
      { method: "POST", body },
      "media_container",
    );
    return stringField(value, "id");
  }

  /** Creates a REELS media container. Reels are video and transcode async. */
  async createReelContainer(input: { accessToken: string; igUserId: string; videoUrl: string; caption: string; shareToFeed?: boolean }) {
    const body = new URLSearchParams({
      media_type: "REELS",
      video_url: input.videoUrl,
      caption: input.caption,
      share_to_feed: input.shareToFeed === false ? "false" : "true",
      access_token: input.accessToken,
    });
    const value = await this.fetchJson(
      `https://graph.instagram.com/${this.config.graphVersion}/${input.igUserId}/media`,
      { method: "POST", body },
      "media_container",
    );
    return stringField(value, "id");
  }

  /**
   * Creates a STORIES media container — Meta's only Story publishing form.
   * An image Story takes image_url; a video Story takes video_url (and, like
   * Reels, transcodes asynchronously). Meta's Story container request has NO
   * caption parameter: Instagram does not support captions on Stories, so
   * Voom never sends one.
   */
  async createStoryContainer(input: { accessToken: string; igUserId: string; mediaUrl: string; video: boolean }) {
    const body = new URLSearchParams({
      media_type: "STORIES",
      [input.video ? "video_url" : "image_url"]: input.mediaUrl,
      access_token: input.accessToken,
    });
    const value = await this.fetchJson(
      `https://graph.instagram.com/${this.config.graphVersion}/${input.igUserId}/media`,
      { method: "POST", body },
      "media_container",
    );
    return stringField(value, "id");
  }

  /** Reads a container's processing state: IN_PROGRESS / FINISHED / ERROR / EXPIRED. */
  async getContainerStatus(accessToken: string, containerId: string) {
    const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/${containerId}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", accessToken);
    const value = await this.fetchJson(url, undefined, "media_status");
    return {
      statusCode: optionalString(value, "status_code") ?? "IN_PROGRESS",
      detail: optionalString(value, "status"),
    };
  }

  /** Publishes a finished container. The returned id is the real media id. */
  async publishContainer(input: { accessToken: string; igUserId: string; containerId: string }) {
    const body = new URLSearchParams({ creation_id: input.containerId, access_token: input.accessToken });
    const value = await this.fetchJson(
      `https://graph.instagram.com/${this.config.graphVersion}/${input.igUserId}/media_publish`,
      { method: "POST", body },
      "media_publish",
    );
    return stringField(value, "id");
  }

  /**
   * Recovery read for an ambiguous publish response: lists the account's most
   * recent media so the worker can detect a post that actually succeeded
   * instead of blindly publishing a second copy.
   */
  async findRecentMediaId(accessToken: string, predicate: (media: Record<string, unknown>) => boolean) {
    const media = await this.getMedia(accessToken, 5);
    const match = media.find(predicate);
    return match && typeof match.id !== "undefined" ? String(match.id) : null;
  }

  private async fetchJson(input: string | URL, init?: RequestInit, operation: InstagramApiError["operation"] = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.request(input, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...init?.headers } });
      const value: unknown = await response.json().catch(() => null);
      if (response.status === 429) throw new InstagramApiError("rate_limited", operation);
      if (response.status === 401 || response.status === 403) throw new InstagramApiError("unauthorized", operation, classifyProviderReason(value));
      if (!response.ok) throw new InstagramApiError(response.status >= 500 ? "unavailable" : "invalid_response", operation, classifyProviderReason(value));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstagramApiError("invalid_response", operation);
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof InstagramApiError) throw error;
      throw new InstagramApiError("unavailable", operation);
    } finally { clearTimeout(timeout); }
  }
}

/**
 * Result of a read-only per-media insights call. `entries` are RAW provider
 * insight objects: the Instagram domain never normalizes them, lib/performance
 * does, so MARA depends on Voom's own model and not on a Meta response shape.
 */
export interface MediaInsightsRead {
  entries: unknown[];
  /** Requested provider metrics Meta did not return for this media. */
  unavailable: string[];
  /** True when Meta refused every requested metric (permission/kind/expiry). */
  refused: boolean;
}

function mentionsMetric(entries: unknown[], metric: string): boolean {
  return entries.some((entry) => isRecord(entry) && entry.name === metric);
}

function stringField(value: Record<string, unknown>, key: string) { const field = value[key]; if (typeof field !== "string" && typeof field !== "number") throw new InstagramApiError("invalid_response"); return String(field); }
function optionalString(value: Record<string, unknown>, key: string) { const field = value[key]; return typeof field === "string" || typeof field === "number" ? String(field) : null; }
function numberField(value: Record<string, unknown>, key: string) { const field = value[key]; if (typeof field !== "number" || !Number.isFinite(field)) throw new InstagramApiError("invalid_response"); return field; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function classifyProviderReason(value: unknown): InstagramApiError["providerReason"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "rejected";
  const record = value as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : record;
  const raw = [record.error_message, record.error_type, nested.message, nested.type]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  if (/client.secret|app.secret|invalid.client|client authentication/.test(raw)) return "credentials";
  if (/redirect|callback/.test(raw)) return "redirect";
  if (/authorization code|invalid code|code.+expired|code.+used|matching code/.test(raw)) return "code";
  if (/app.+invalid|platform app|app.+configuration|app.+setup/.test(raw)) return "app_configuration";
  return "rejected";
}
