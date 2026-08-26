import { readInstagramConfig } from "@/lib/instagram/config";
import { getInstagramConnection } from "@/lib/instagram/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    return Response.json({ connection: await getInstagramConnection(await createClient(), user.id, Boolean(readInstagramConfig())) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Instagram connection status is temporarily unavailable." }, { status: 503 });
  }
}
