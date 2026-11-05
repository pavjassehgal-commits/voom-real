"use server";

import { headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { resolveSiteUrl } from "@/utils/site-url";

export type ForgotPasswordState = {
  success?: boolean;
  fieldErrors?: {
    email?: string;
  };
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Asks Supabase to email a password-reset link.
 *
 * The reply is IDENTICAL whether or not the address has an account: Supabase's
 * result is deliberately not inspected, so this form can never be used to
 * discover who has signed up. Only a malformed address gets a field error,
 * which reveals nothing.
 *
 * The link in the email returns to /auth/callback, which exchanges the code
 * for a session and then lands on /reset-password (allowlisted there).
 */
export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    return { fieldErrors: { email: "Enter your email address." } };
  }
  if (!EMAIL_RE.test(email)) {
    return { fieldErrors: { email: "Enter a valid email address." } };
  }

  const origin = (await headers()).get("origin");
  const redirectTo = new URL("/auth/callback", resolveSiteUrl(origin));
  redirectTo.searchParams.set("next", "/reset-password");

  const supabase = await createClient();
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo.toString(),
    });
    // Logged for operators (no address included); never surfaced to the form.
    if (error) console.error("[forgot-password] reset request not accepted:", error.code ?? error.message);
  } catch (reason) {
    console.error("[forgot-password] reset request failed:", reason instanceof Error ? reason.message : "unknown");
  }

  return { success: true };
}
