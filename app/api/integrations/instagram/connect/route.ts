import { cookies } from "next/headers";
import { InstagramClient } from "@/lib/instagram/client";
import { InstagramConfigurationError, requireInstagramConfig } from "@/lib/instagram/config";
import { createOAuthState } from "@/lib/instagram/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const STATE_COOKIE = "voom_instagram_oauth_state";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "That connection request was not valid." }, { status: 403 });
  try {
    const config = requireInstagramConfig();
    const state = await createOAuthState(createAdminClient(), user.id);
    (await cookies()).set(STATE_COOKIE, state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/integrations/instagram/callback", maxAge: 600 });
    return Response.json({ authorizationUrl: new InstagramClient(config).authorizationUrl(state) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InstagramConfigurationError) return Response.json({ error: "Instagram setup is not configured yet." }, { status: 503 });
    return Response.json({ error: "Instagram connection could not be started. Please retry." }, { status: 503 });
  }
}
