import { cookies } from "next/headers";
import { YouTubeClient } from "@/lib/youtube/client";
import { YouTubeConfigurationError, requireYouTubeConfig } from "@/lib/youtube/config";
import { createYouTubeOAuthState } from "@/lib/youtube/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const STATE_COOKIE = "voom_youtube_oauth_state";

/**
 * Starts the server-side Google authorization-code flow.
 *
 * The state is 256 bits of CSPRNG output, stored server-side ONLY as a
 * SHA-256 hash bound to this owner, single-use, expiring in 10 minutes —
 * and echoed into an httpOnly cookie scoped to the callback path, so the
 * callback can verify double-submit ownership. The client secret never
 * leaves the server; the browser only ever receives the authorization URL.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "That connection request was not valid." }, { status: 403 });
  try {
    const config = requireYouTubeConfig();
    const state = await createYouTubeOAuthState(createAdminClient(), user.id);
    (await cookies()).set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/integrations/youtube/callback",
      maxAge: 600,
    });
    return Response.json(
      { authorizationUrl: new YouTubeClient(config).authorizationUrl(state) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof YouTubeConfigurationError) return Response.json({ error: "YouTube setup is not configured yet." }, { status: 503 });
    return Response.json({ error: "YouTube connection could not be started. Please retry." }, { status: 503 });
  }
}
