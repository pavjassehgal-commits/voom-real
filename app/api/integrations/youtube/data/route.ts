import { readYouTubeConfig, youTubeKeyRing } from "@/lib/youtube/config";
import { YouTubeClient } from "@/lib/youtube/client";
import { eraseYouTubeData, retryYouTubeRevocations } from "@/lib/youtube/privacy";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/** Owner-only explicit erasure; body cannot name another owner. No YouTube video DELETE. */
export async function DELETE(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({error:"Invalid request origin."},{status:403});
  const user = await getCurrentUser();
  if (!user) return Response.json({error:"Please log in again."},{status:401});
  const body = await request.json().catch(()=>null);
  if (body?.confirmation !== "DELETE YOUTUBE DATA" || Object.keys(body).length !== 1) return Response.json({error:"Explicit YouTube data deletion confirmation is required."},{status:400});
  try {
    const db = createAdminClient();
    const result = await eraseYouTubeData(db,user.id);
    const config = readYouTubeConfig();
    let revocationPending = result.revocationPending;
    if (config && revocationPending) {
      const revocations = await retryYouTubeRevocations(db,youTubeKeyRing(config),new YouTubeClient(config),user.id);
      revocationPending = revocations.completed === 0;
    }
    return Response.json({erased:true,revocationPending},{headers:{"Cache-Control":"no-store"}});
  } catch { return Response.json({error:"YouTube data deletion could not be confirmed. Please check the connection before retrying."},{status:503}); }
}
