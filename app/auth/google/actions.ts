"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { resolveSiteUrl } from "@/utils/site-url";

/**
 * "Continue with Google" for both login and signup. Asks Supabase for the
 * Google sign-in URL and sends the browser there. Google returns to Supabase,
 * which returns to our /auth/callback?next=/app with a code; the existing
 * callback exchanges it for a session. A brand-new Google user has no
 * business row, so the app's onboarding gate takes over. Same email as an
 * existing email/password account → Supabase links it to that account.
 *
 * The Google client ID and secret live in the Supabase dashboard
 * (Authentication → Providers → Google), not in this code or in env vars,
 * so switching Supabase projects needs no code change.
 */
export async function continueWithGoogle(): Promise<void> {
  const origin = (await headers()).get("origin");
  const redirectTo = new URL("/auth/callback", resolveSiteUrl(origin));
  redirectTo.searchParams.set("next", "/app");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: redirectTo.toString() },
  });

  if (error || !data?.url) {
    console.error("[auth/google] could not start Google sign-in", error?.message ?? "no URL returned");
    redirect("/login?error=google_failed");
  }

  redirect(data.url);
}
