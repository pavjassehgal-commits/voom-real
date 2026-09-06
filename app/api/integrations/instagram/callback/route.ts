import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { InstagramApiError, InstagramClient } from "@/lib/instagram/client";
import { instagramKeyRing, requireInstagramConfig } from "@/lib/instagram/config";
import { consumeOAuthState, saveInstagramConnection } from "@/lib/instagram/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const STATE_COOKIE = "voom_instagram_oauth_state";

export async function GET(request: Request) {
  const fallback = new URL("/app/instagram", request.url);
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);
  if (!code || code.length > 2048 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !cookieState) return redirectWith(fallback, "invalid_state");
  let stage: "state" | "token" | "profile" | "save" = "state";
  try {
    const config = requireInstagramConfig();
    const admin = createAdminClient();
    if (!(await consumeOAuthState(admin, user.id, state, cookieState))) return redirectWith(fallback, "invalid_state");
    const client = new InstagramClient(config);
    stage = "token";
    const token = await client.exchangeCode(code);
    stage = "profile";
    const profile = await client.getProfile(token.accessToken, token.userId);
    stage = "save";
    await saveInstagramConnection(admin, { ownerId: user.id, instagramUserId: profile.userId, username: profile.username, name: profile.name, accountType: profile.accountType, profilePictureUrl: profile.profilePictureUrl, accessToken: token.accessToken, expiresIn: token.expiresIn, encryptionKey: instagramKeyRing(config) });
    fallback.searchParams.set("instagram", "connected");
    return NextResponse.redirect(fallback);
  } catch (error) {
    const reason = error instanceof InstagramApiError
      ? `${error.operation ?? "provider"}_${error.code}_${error.providerReason ?? "unknown"}`
      : "failed";
    return redirectWith(fallback, `${stage}_${reason}`);
  }
}

function redirectWith(url: URL, code: string) { url.searchParams.set("instagram_error", code); return NextResponse.redirect(url); }
