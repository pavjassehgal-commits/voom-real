import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/server";

// Exact allowlist of where an email link may land after the code exchange:
// signup confirmation → /app, password reset → /reset-password. Anything else
// (open redirects, deep links) falls back to /app.
const ALLOWED_NEXT_PATHS = new Set(["/app", "/reset-password"]);

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
    const { error } = await supabase.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined,
    );
    if (!error) {
      redirect(next);
    }
  }

  // A password-reset link that cannot be exchanged (expired, already used, or
  // opened in a different browser than the one that asked for it) is explained
  // on the reset page itself, with a way to request a new one.
  if (next === "/reset-password") {
    redirect("/reset-password?error=link_invalid");
  }
  redirect("/login?error=confirm_failed");
}
