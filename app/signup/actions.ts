"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { resolveSiteUrl } from "@/utils/site-url";

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
  if (password.length < 8) {
    fieldErrors.password = "Password must be at least 8 characters.";
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

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: emailRedirectTo.toString(),
    },
  });

  if (error) {
    return {
      formError: "We couldn't create your account. Please try again.",
    };
  }

  if (data.session) {
    redirect("/app/onboarding");
  }

  return { success: true };
}
