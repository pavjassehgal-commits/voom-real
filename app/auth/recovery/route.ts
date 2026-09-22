import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { validCode, validFlowId } from "@/lib/auth/policy";
import { RECOVERY_COOKIE, recoveryCookieOptions } from "@/lib/auth/recovery";

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const flowId = params.get("sb_flow_id");
  const store = await cookies();
  store.delete(RECOVERY_COOKIE);
  if (params.has("error") || !validCode(code) || (flowId != null && !validFlowId(flowId))) {
    redirect("/forgot-password?error=invalid_link");
  }
  // This is only transport for Supabase's code, NOT a verified recovery grant.
  // Exchange on POST prevents ordinary page loading from creating a session.
  store.set(RECOVERY_COOKIE, JSON.stringify({ code, ...(flowId ? { flowId } : {}) }), recoveryCookieOptions);
  redirect("/reset-password");
}
