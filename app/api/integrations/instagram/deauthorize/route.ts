import { handleLifecycle, lifecycleConfig } from "@/lib/instagram/lifecycle";
import { acceptInstagramCallback } from "@/lib/instagram/callback-store";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta Instagram deauthorize callback. Signature checked before any database work. */
export async function POST(request: Request) {
  return handleLifecycle(request, "deauthorize", lifecycleConfig(), (event) => acceptInstagramCallback(createAdminClient(), event));
}
