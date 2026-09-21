import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { YouTubeApiError, YouTubeClient } from "@/lib/youtube/client";
import { requireYouTubeConfig, youTubeKeyRing } from "@/lib/youtube/config";
import { consumeYouTubeOAuthState, saveYouTubeConnection } from "@/lib/youtube/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const STATE_COOKIE = "voom_youtube_oauth_state";

/**
 * Completes the server-side authorization-code flow.
 *
 * Ownership + replay protection, in order:
 *   1. the user must be logged in — the connection binds to THIS owner;
 *   2. the URL state must equal the httpOnly cookie state (constant-time),
 *      match the 43-character base64url shape, and be unconsumed, unexpired
 *      and bound to this owner in youtube_oauth_states — a state captured
 *      from another flow (or replayed) fails here;
 *   3. only then is the code exchanged SERVER-SIDE for tokens. Google issues
 *      the refresh token because the authorization URL asked for offline
 *      access with prompt=consent; a response without one is refused
 *      truthfully instead of storing a connection that could never publish
 *      unattended.
 *
 * The channel identity comes from channels.list?mine=true with the new
 * token — YouTube's own authoritative answer, never user input. Tokens are
 * encrypted (AES-256-GCM) before they reach the database and are never
 * rendered, redirected, logged or sent to the browser.
 */
export async function GET(request: Request) {
  const fallback = new URL("/app/youtube", request.url);
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);
  if (!code || code.length > 2048 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !cookieState) {
    return redirectWith(fallback, "invalid_state");
  }
  let stage: "state" | "token" | "channel" | "save" = "state";
  try {
    const config = requireYouTubeConfig();
    const admin = createAdminClient();
    if (!(await consumeYouTubeOAuthState(admin, user.id, state, cookieState))) {
      return redirectWith(fallback, "invalid_state");
    }
    const client = new YouTubeClient(config);
    stage = "token";
    const tokens = await client.exchangeCode(code);
    if (!tokens.refreshToken) {
      // No offline access granted: Voom could never publish unattended, so
      // it refuses the connection instead of pretending it works.
      return redirectWith(fallback, "token_no_offline_access");
    }
    stage = "channel";
    const channel = await client.getMyChannel(tokens.accessToken);
    stage = "save";
    await saveYouTubeConnection(admin, {
      ownerId: user.id,
      channelId: channel.channelId,
      channelTitle: channel.title,
      channelHandle: channel.handle,
      thumbnailUrl: channel.thumbnailUrl,
      grantedScopes: tokens.grantedScopes,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      encryptionKey: youTubeKeyRing(config),
    });
    fallback.searchParams.set("youtube", "connected");
    return NextResponse.redirect(fallback);
  } catch (error) {
    const reason = error instanceof YouTubeApiError
      ? `${error.operation}_${error.kind}${error.reason ? `_${error.reason}` : ""}`
      : "failed";
    return redirectWith(fallback, `${stage}_${reason}`);
  }
}

function redirectWith(url: URL, code: string) {
  url.searchParams.set("youtube_error", code);
  return NextResponse.redirect(url);
}
