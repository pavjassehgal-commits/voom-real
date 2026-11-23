import { lifecycleConfig } from "@/lib/instagram/lifecycle";
import { readInstagramDeletionStatus } from "@/lib/instagram/callback-store";
import { renderDeletionStatus } from "@/lib/instagram/deletion-status-page";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Status URL returned to Meta by the data-deletion callback. */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  return renderDeletionStatus(code, lifecycleConfig() !== null, (c) => readInstagramDeletionStatus(createAdminClient(), c));
}
