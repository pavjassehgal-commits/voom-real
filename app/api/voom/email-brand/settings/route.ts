/**
 * Read surface for the Branded Email settings card: what recipients will see
 * (resolved sender identity + truthful verification status) plus the brand
 * profile the renderer consumes.
 */

import { readEmailBrandSettings } from "@/lib/branded-email/settings-server";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  try {
    const admin = createAdminClient();
    const settings = await readEmailBrandSettings(admin, user.id);
    return Response.json({ settings }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Email brand settings are temporarily unavailable." }, { status: 503 });
  }
}
