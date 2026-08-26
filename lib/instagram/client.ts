import "server-only";

import type { InstagramConfig } from "./config";

const REQUEST_TIMEOUT_MS = 15_000;
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;

export class InstagramApiError extends Error {
  constructor(public readonly code: "rate_limited" | "unauthorized" | "unavailable" | "invalid_response") {
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
    url.searchParams.set("force_authentication", "1");
    return url.toString();
  }

  async exchangeCode(code: string) {
    const body = new URLSearchParams({ client_id: this.config.appId, client_secret: this.config.appSecret, grant_type: "authorization_code", redirect_uri: this.config.redirectUri, code });
    const short = await this.fetchJson("https://api.instagram.com/oauth/access_token", { method: "POST", body });
    const shortToken = stringField(short, "access_token");
    const userId = stringField(short, "user_id");
    const longUrl = new URL(`https://graph.instagram.com/${this.config.graphVersion}/access_token`);
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", this.config.appSecret);
    longUrl.searchParams.set("access_token", shortToken);
    const long = await this.fetchJson(longUrl);
    return { accessToken: stringField(long, "access_token"), userId, expiresIn: numberField(long, "expires_in") };
  }

  async getProfile(accessToken: string, userId: string) {
    const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/${encodeURIComponent(userId)}`);
    url.searchParams.set("fields", "user_id,username,name,account_type,profile_picture_url,followers_count,media_count");
    url.searchParams.set("access_token", accessToken);
    const value = await this.fetchJson(url);
    return {
      userId: optionalString(value, "user_id") ?? userId,
      username: stringField(value, "username"),
      name: optionalString(value, "name"),
      accountType: optionalString(value, "account_type"),
      profilePictureUrl: optionalString(value, "profile_picture_url"),
    };
  }

  private async fetchJson(input: string | URL, init?: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.request(input, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...init?.headers } });
      if (response.status === 429) throw new InstagramApiError("rate_limited");
      if (response.status === 401 || response.status === 403) throw new InstagramApiError("unauthorized");
      if (!response.ok) throw new InstagramApiError(response.status >= 500 ? "unavailable" : "invalid_response");
      const value: unknown = await response.json().catch(() => null);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstagramApiError("invalid_response");
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof InstagramApiError) throw error;
      throw new InstagramApiError("unavailable");
    } finally { clearTimeout(timeout); }
  }
}

function stringField(value: Record<string, unknown>, key: string) { const field = value[key]; if (typeof field !== "string" && typeof field !== "number") throw new InstagramApiError("invalid_response"); return String(field); }
function optionalString(value: Record<string, unknown>, key: string) { const field = value[key]; return typeof field === "string" || typeof field === "number" ? String(field) : null; }
function numberField(value: Record<string, unknown>, key: string) { const field = value[key]; if (typeof field !== "number" || !Number.isFinite(field)) throw new InstagramApiError("invalid_response"); return field; }
