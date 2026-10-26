import { isLinkedInOneShotStaging, readLinkedInConfig } from "@/lib/linkedin/config";
import { getLinkedInConnection } from "@/lib/linkedin/data";
import { json } from "@/lib/linkedin/http";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return json({error:"Please log in again."},401);
  try { return json({connection:await getLinkedInConnection(await createClient(),user.id,Boolean(readLinkedInConfig())),
    oneShotPublishingAvailable:isLinkedInOneShotStaging()}); }
  catch { return json({error:"LinkedIn status could not be loaded."},503); }
}
