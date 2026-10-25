import { json, sameOrigin } from "@/lib/linkedin/http";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({error:"Please log in again."},401);
  if (!sameOrigin(request)) return json({error:"That request was not valid."},403);
  try {
    const {error} = await createAdminClient().rpc("disconnect_linkedin_connection",{p_owner:user.id});
    if (error) throw new Error();
    return json({message:"Disconnected in VOOM and stored credentials removed. Unsubmitted jobs were cancelled; already submitted or published posts were not changed. You can also remove VOOM from LinkedIn's permitted services."});
  } catch { return json({error:"Disconnect could not be confirmed. Please retry."},503); }
}
