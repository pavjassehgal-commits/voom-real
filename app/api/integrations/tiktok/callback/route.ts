import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { TikTokApiError, TikTokClient } from "@/lib/tiktok/client";
import { requireTikTokConfig, tikTokKeyRing } from "@/lib/tiktok/config";
import { consumeTikTokOAuthState, saveTikTokConnection } from "@/lib/tiktok/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const STATE_COOKIE = "voom_tiktok_oauth_state";

/**
 * Completes the server-side authorization-code flow.
 *
 * Ownership + replay protection, in order:
 *   1. the user must be logged in — the connection binds to THIS owner;
 *   2. the URL state must equal the httpOnly cookie state (constant-time),
 *      match the 43-character base64url shape, and be unconsumed, unexpired
 *      and bound to this owner in tiktok_oauth_states — a state captured
 *      from another flow (or replayed) fails here;
 *   3. only then is the one-time code (valid 5 minutes) exchanged
 *      SERVER-SIDE for tokens.
 *
 * Identity: the authoritative open_id comes from the token exchange itself
 * (the partner-facing id TikTok returns). The display name and avatar are
 * read from user.info.basic with the new token — TikTok's own authoritative
 * answer, never user input. Tokens are encrypted (AES-256-GCM) before they
 * reach the database and are never rendered, redirected, logged or sent to
 * the browser.
 */
export async function GET(request: Request) {
  const fallback = new URL("/app/tiktok", request.url);
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);
  if (params.get("error")) return redirectWith(fallback, "provider_denied");
  if (!code || code.length > 2048 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !cookieState) {
    return redirectWith(fallback, "invalid_state");
  }
  let stage: "state" | "token" | "user" | "save" = "state";
  try {
    const config = requireTikTokConfig();
    const admin = createAdminClient();
    if (!(await consumeTikTokOAuthState(admin, user.id, state, cookieState))) {
      return redirectWith(fallback, "invalid_state");
    }
    const client = new TikTokClient(config);
    stage = "token";
    const tokens = await client.exchangeCode(code);
    if (!tokens.refreshToken) {
      // No refresh token: Voom could never publish unattended, so it
      // refuses the connection instead of pretending it works.
      return redirectWith(fallback, "token_no_refresh");
    }
    stage = "user";
    const basicUser = await client.getBasicUser(tokens.accessToken);
    stage = "save";
    await saveTikTokConnection(admin, {
      ownerId: user.id,
      openId: tokens.openId,
      displayName: basicUser.displayName,
      avatarUrl: basicUser.avatarUrl,
      grantedScopes: tokens.grantedScopes,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      refreshTokenExpiresAt: tokens.refreshExpiresIn
        ? new Date(Date.now() + tokens.refreshExpiresIn * 1000).toISOString()
        : null,
      encryptionKey: tikTokKeyRing(config),
    });
    fallback.searchParams.set("tiktok", "connected");
    return NextResponse.redirect(fallback);
  } catch (error) {
    const reason = error instanceof TikTokApiError
      ? `${error.operation}_${error.kind}${error.reason ? `_${error.reason}` : ""}`
      : "failed";
    return redirectWith(fallback, `${stage}_${reason}`);
  }
}

function redirectWith(url: URL, code: string) {
  url.searchParams.set("tiktok_error", code);
  return NextResponse.redirect(url);
}
