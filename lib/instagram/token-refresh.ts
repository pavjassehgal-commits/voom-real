import "server-only";

const REQUEST_TIMEOUT_MS = 15_000;
/** Stays above the 1-day floor complete_instagram_token_refresh enforces. */
const MIN_REFRESHED_LIFETIME_S = 2 * 24 * 60 * 60;
const MAX_REFRESHED_LIFETIME_S = 90 * 24 * 60 * 60;

export type InstagramTokenRefreshCode = "rate_limited" | "unavailable" | "invalid_response" | "token_invalid" | "permission_missing";

/**
 * Why a token renewal failed. Carries no provider text, token or URL: only
 * the classification the renewal worker acts on.
 */
export class InstagramTokenRefreshError extends Error {
  readonly code: InstagramTokenRefreshCode;
  constructor(code: InstagramTokenRefreshCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Renews a long-lived Instagram Login token for another 60 days
 * (GET /refresh_access_token, grant_type=ig_refresh_token). Meta requires the
 * token to be at least 24 hours old, unexpired and granted
 * instagram_business_basic. Unversioned, like /access_token; no app secret.
 */
export async function refreshInstagramLongLivedToken(accessToken: string, request: typeof fetch = fetch): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", accessToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let value: unknown;
  try {
    response = await request(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    value = await response.json().catch(() => null);
  } catch {
    throw new InstagramTokenRefreshError("unavailable");
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new InstagramTokenRefreshError(classifyRefreshFailure(response.status, value));
  if (!isRecord(value)) throw new InstagramTokenRefreshError("invalid_response");
  const token = value.access_token;
  const expiresIn = value.expires_in;
  if (typeof token !== "string" || token.length === 0) throw new InstagramTokenRefreshError("invalid_response");
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < MIN_REFRESHED_LIFETIME_S || expiresIn > MAX_REFRESHED_LIFETIME_S) {
    throw new InstagramTokenRefreshError("invalid_response");
  }
  return { accessToken: token, expiresIn };
}

/**
 * Graph error codes: 190 invalid/expired/revoked token (reconnect), 10 and
 * 200-299 missing permission (reconnect), 4/17/32/613 throttling (retry).
 */
function classifyRefreshFailure(status: number, value: unknown): InstagramTokenRefreshCode {
  const error = isRecord(value) && isRecord(value.error) ? value.error : null;
  const code = error && typeof error.code === "number" ? error.code : null;
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) return "rate_limited";
  if (code === 190) return "token_invalid";
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return "permission_missing";
  if (status === 401) return "token_invalid";
  if (status === 403) return "permission_missing";
  if (status >= 500) return "unavailable";
  return "invalid_response";
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
