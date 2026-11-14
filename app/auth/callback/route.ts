import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { queueWelcome } from "@/lib/transactional-email/server";

// Password recovery uses /auth/recovery and a separate session-bound proof.
const ALLOWED_NEXT_PATHS = new Set(["/app"]);

function resolveNext(next: string | null): string {
  if (next && ALLOWED_NEXT_PATHS.has(next)) {
    return next;
  }
  return "/app";
}

// Supabase verifies an email link before redirecting here with a PKCE code, so
// these exchange failures on a signup link mean "confirmed, but this browser
// cannot be signed in" (link opened after the ~5 minute flow window, on another
// device). Saying the link is invalid would be untrue. flow_state_not_found is
// deliberately excluded: a made-up or reused code produces it.
const CONFIRMED_BUT_NOT_SIGNED_IN = new Set([
  "flow_state_expired",
  "pkce_code_verifier_not_found",
  "bad_code_verifier",
]);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const signupLink = searchParams.get("flow") === "signup";
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
    const errorCode = (error as { code?: unknown }).code;
    if (signupLink && typeof errorCode === "string" && CONFIRMED_BUT_NOT_SIGNED_IN.has(errorCode)) {
      redirect("/login?notice=email_confirmed");
    }
  }

  redirect("/login?error=confirm_failed");
}
