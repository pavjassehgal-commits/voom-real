import { disconnectInstagramLocally } from "@/lib/instagram/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const disconnected = await disconnectInstagramLocally(createAdminClient(), user.id);
    return Response.json({ disconnected });
  } catch {
    return Response.json({ error: "Instagram could not be disconnected. Please retry." }, { status: 503 });
  }
}
