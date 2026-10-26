import "server-only";
import { z } from "zod";
import type { LinkedInConfig } from "./config.ts";

export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"] as const;
export const isMemberId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
export const isPostUrn = (value: string) => /^urn:li:(share|ugcPost):[0-9]+$/.test(value);
export type LinkedInFailure = "reconnect" | "rate_limited" | "rejected" | "uncertain" | "unavailable";
export class LinkedInError extends Error {
  readonly category: LinkedInFailure;
  constructor(category: LinkedInFailure) { super(`linkedin_${category}`); this.category = category; this.name = "LinkedInError"; }
}
const tokensSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive().max(366 * 86400), scope: z.string().optional() });
const identitySchema = z.object({ sub: z.string().refine(isMemberId), name: z.string().min(1).max(300) });

export class LinkedInClient {
  private readonly config: LinkedInConfig;
  private readonly fetcher: typeof fetch;
  constructor(config: LinkedInConfig, fetcher: typeof fetch = fetch) { this.config = config; this.fetcher = fetcher; }
  authorizationUrl(state: string): string {
    const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
    url.search = new URLSearchParams({ response_type: "code", client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri, state, scope: LINKEDIN_SCOPES.join(" ") }).toString();
    return url.toString();
  }
  private async request(url: string, init: RequestInit, publishing = false): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000) });
    } catch { throw new LinkedInError(publishing ? "uncertain" : "unavailable"); }
    // Do not propagate provider bodies: they can contain credentials or PII.
    if (!response.ok) {
      throw new LinkedInError(response.status === 401 ? "reconnect" : response.status === 429 ? "rate_limited"
        : publishing && (response.status >= 500 || response.status === 408) ? "uncertain" : "rejected");
    }
    return response;
  }
  async exchangeCode(code: string) {
    const response = await this.request("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: this.config.clientId,
        client_secret: this.config.clientSecret, redirect_uri: this.config.redirectUri,
      }) });
    const result = tokensSchema.safeParse(await response.json().catch(() => null));
    if (!result.success) throw new LinkedInError("rejected");
    // LinkedIn may omit scope when it equals the requested scopes (OAuth 2.0).
    const scopes = result.data.scope === undefined ? [...LINKEDIN_SCOPES] : result.data.scope.split(/[ ,]+/).filter(Boolean);
    if (!LINKEDIN_SCOPES.every((scope) => scopes.includes(scope))) throw new LinkedInError("rejected");
    return { accessToken: result.data.access_token, expiresIn: result.data.expires_in, scopes };
  }
  async identity(accessToken: string) {
    const response = await this.request("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
    const identity = identitySchema.safeParse(await response.json().catch(() => null));
    if (!identity.success) throw new LinkedInError("rejected");
    // Use userinfo obtained with the new access token, never an unverified JWT
    // or browser-supplied profile id. VOOM authentication itself is unchanged.
    return identity.data;
  }
  async publishText(accessToken: string, memberId: string, text: string): Promise<string> {
    if (!isMemberId(memberId) || !text.trim() || text.length > 3000) throw new LinkedInError("rejected");
    const response = await this.request("https://api.linkedin.com/rest/posts", { method: "POST", headers: {
      Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
      "LinkedIn-Version": this.config.apiVersion, "X-Restli-Protocol-Version": "2.0.0",
    }, body: JSON.stringify({ author: `urn:li:person:${memberId}`, commentary: text,
      visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }) }, true);
    const post = response.headers.get("x-restli-id") ?? "";
    if (response.status !== 201 || !isPostUrn(post)) throw new LinkedInError("uncertain");
    return post;
  }
}
