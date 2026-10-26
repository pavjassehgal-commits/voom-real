import { cookies } from "next/headers";
import { LinkedInClient } from "@/lib/linkedin/client";
import { readLinkedInConfig } from "@/lib/linkedin/config";
import { createLinkedInState } from "@/lib/linkedin/data";
import { json, sameOrigin, LINKEDIN_STATE_COOKIE } from "@/lib/linkedin/http";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({error:"Please log in again."},401);
  if (!sameOrigin(request)) return json({error:"That connection request was not valid."},403);
  const config = readLinkedInConfig();
  if (!config) return json({error:"LinkedIn is not configured yet."},503);
  try {
    const state = await createLinkedInState(createAdminClient(), user.id);
    (await cookies()).set(LINKEDIN_STATE_COOKIE,state,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",
      path:"/api/integrations/linkedin/callback",maxAge:600});
    return json({authorizationUrl:new LinkedInClient(config).authorizationUrl(state)});
  } catch { return json({error:"LinkedIn connection could not be started. A VOOM business is required."},503); }
}
