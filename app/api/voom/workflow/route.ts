import { getCurrentUser } from "@/lib/voom/server-data";
import { loadWorkflowSnapshot } from "@/lib/voom/workflow/read";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * Owner-scoped read of the ONE executable content workflow. Today, the
 * Marketing Plan and the Content Calendar all render this payload, so no
 * screen can invent content or dates of its own.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const snapshot = await loadWorkflowSnapshot(createAdminClient(), user.id);
    return Response.json({ snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Your schedule couldn't load. Please retry." }, { status: 503 });
  }
}
