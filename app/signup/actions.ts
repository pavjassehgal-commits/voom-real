"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { resolveSiteUrl } from "@/utils/site-url";
import { queueWelcome } from "@/lib/transactional-email/server";
import { isWeakPasswordError, passwordPolicyError, WEAK_PASSWORD_MESSAGE } from "@/lib/auth/password-policy";

export type SignupState = {
  success?: boolean;
  formError?: string;
  fieldErrors?: {
    email?: string;
    password?: string;
    confirmPassword?: string;
  };
};

export async function signup(
  _prevState: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const fieldErrors: SignupState["fieldErrors"] = {};
  if (!email) {
    fieldErrors.email = "Enter your email address.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fieldErrors.email = "Enter a valid email address.";
  }
  const passwordError = passwordPolicyError(password);
  if (passwordError) {
    fieldErrors.password = passwordError;
  }
  if (confirmPassword !== password) {
    fieldErrors.confirmPassword = "Passwords do not match.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  const origin = (await headers()).get("origin");
  const siteUrl = resolveSiteUrl(origin);
  const emailRedirectTo = new URL("/auth/callback", siteUrl);
  emailRedirectTo.searchParams.set("next", "/app");
  emailRedirectTo.searchParams.set("flow", "signup");

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: emailRedirectTo.toString(),
    },
  });

  if (error) {
    if(error.code==="user_already_exists")return {success:true};
    // Supabase checks password strength (including leaked-password protection,
    // when it is on) BEFORE looking up the address, so this answer is the same
    // whether or not an account exists. Only the fixed code is read; provider
    // text and its reasons are never shown.
    if (isWeakPasswordError(error)) {
      return { fieldErrors: { password: WEAK_PASSWORD_MESSAGE } };
    }
    return {
      formError: "We couldn't create your account. Please try again.",
    };
  }

  if (data.session) {
    await queueWelcome(data.session.user.id);
    redirect("/app/onboarding");
  }

  return { success: true };
}
