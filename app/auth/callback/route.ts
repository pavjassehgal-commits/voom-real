import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { queueWelcome } from "@/lib/transactional-email/server";

const ALLOWED_NEXT_PATHS = new Set(["/app"]);

function resolveNext(next: string | null): string {
  if (next && ALLOWED_NEXT_PATHS.has(next)) {
    return next;
  }
  return "/app";
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const flowId = searchParams.get("sb_flow_id");
  const next = resolveNext(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined,
    );
    if (!error) {
      if(data.user)await queueWelcome(data.user.id);
      redirect(next);
    }
  }

  redirect("/login?error=confirm_failed");
}
