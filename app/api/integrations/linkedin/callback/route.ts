import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { LinkedInClient } from "@/lib/linkedin/client";
import { readLinkedInConfig } from "@/lib/linkedin/config";
import { consumeLinkedInState, saveLinkedInConnection } from "@/lib/linkedin/data";
import { LINKEDIN_STATE_COOKIE } from "@/lib/linkedin/http";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login",request.url));
  const fallback = new URL("/app/linkedin",request.url);
  const redirect = (error: string) => { fallback.searchParams.set("linkedin_error",error); return NextResponse.redirect(fallback); };
  const params = new URL(request.url).searchParams;
  const store = await cookies();
  const cookieState = store.get(LINKEDIN_STATE_COOKIE)?.value ?? "";
  store.set(LINKEDIN_STATE_COOKIE,"",{path:"/api/integrations/linkedin/callback",maxAge:0,httpOnly:true,
    secure:process.env.NODE_ENV==="production",sameSite:"lax"});
  const config = readLinkedInConfig();
  if (!config) return redirect("not_configured");
  try {
    const admin = createAdminClient();
    const businessId = await consumeLinkedInState(admin,user.id,params.get("state") ?? "",cookieState);
    if (!businessId) return redirect("invalid_state");
    if (params.has("error")) return redirect("cancelled");
    const code = params.get("code");
    if (!code || code.length>4096) return redirect("invalid_state");
    const client = new LinkedInClient(config);
    const token = await client.exchangeCode(code);
    const identity = await client.identity(token.accessToken);
    await saveLinkedInConnection(admin,{ownerId:user.id,businessId,memberSub:identity.sub,displayName:identity.name,
      scopes:token.scopes,accessToken:token.accessToken,expiresIn:token.expiresIn,encryptionKey:config.encryptionKey,state:params.get("state")!});
    fallback.searchParams.set("linkedin","connected");
    return NextResponse.redirect(fallback);
  } catch (error) {
    // Fixed allowlist only: never reflect provider errors, tokens or names in URLs.
    return redirect(error instanceof Error && ["linkedin_already_linked","linkedin_save_failed"].includes(error.message)
      ? error.message : "connection_failed");
  }
}
