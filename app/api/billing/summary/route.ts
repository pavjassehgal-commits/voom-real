import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { normalizePlan } from "@/lib/billing/plans";
import { getCreditSummary } from "@/lib/billing/ledger";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const admin = createAdminClient();
  try {
    const { data } = await admin.from("businesses").select("plan").eq("owner_user_id", user.id).maybeSingle();
    const planId = normalizePlan((data as any)?.plan);
    const summary = await getCreditSummary(admin, user.id, planId);
    return Response.json({ summary }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Billing summary unavailable." }, { status: 503 });
  }
}
