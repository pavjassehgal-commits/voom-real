import { cookies } from "next/headers";
import { TikTokClient } from "@/lib/tiktok/client";
import { TikTokConfigurationError, requireTikTokConfig } from "@/lib/tiktok/config";
import { createTikTokOAuthState } from "@/lib/tiktok/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const STATE_COOKIE = "voom_tiktok_oauth_state";

/**
 * Starts the server-side TikTok authorization-code flow.
 *
 * The state is 256 bits of CSPRNG output, stored server-side ONLY as a
 * SHA-256 hash bound to this owner, single-use, expiring in 10 minutes —
 * and echoed into an httpOnly cookie scoped to the callback path, so the
 * callback can verify double-submit ownership. The client secret never
 * leaves the server; the browser only ever receives the authorization URL.
 * The requested scopes are the minimum set that can publish:
 * user.info.basic + video.publish (nothing broader, nothing speculative).
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "That connection request was not valid." }, { status: 403 });
  try {
    const config = requireTikTokConfig();
    const state = await createTikTokOAuthState(createAdminClient(), user.id);
    (await cookies()).set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/integrations/tiktok/callback",
      maxAge: 600,
    });
    return Response.json(
      { authorizationUrl: new TikTokClient(config).authorizationUrl(state) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TikTokConfigurationError) return Response.json({ error: "TikTok setup is not configured yet." }, { status: 503 });
    return Response.json({ error: "TikTok connection could not be started. Please retry." }, { status: 503 });
  }
}
