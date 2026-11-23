import { handleLifecycle, lifecycleConfig } from "@/lib/instagram/lifecycle";
import { acceptInstagramCallback } from "@/lib/instagram/callback-store";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta Instagram data-deletion request callback. Signature checked before any database work. */
export async function POST(request: Request) {
  return handleLifecycle(request, "deletion", lifecycleConfig(), (event) => acceptInstagramCallback(createAdminClient(), event));
}
