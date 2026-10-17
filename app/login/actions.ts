"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";

export type LoginState = {
  email?: string;
  submissionId?: number;
  formError?: string;
  fieldErrors?: {
    email?: string;
    password?: string;
  };
};

function safeLoginError(error: { code?: string; status?: number }) {
  if (error.status === 429 || error.code === "over_request_rate_limit") {
    return "Too many login attempts. Wait a moment, then try again.";
  }
  if (error.code === "email_not_confirmed") {
    return "Confirm your email address before logging in.";
  }
  if (error.code === "invalid_credentials") {
    return "Incorrect email or password.";
  }
  return "We couldn't complete login right now. Please try again.";
}

export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const submissionId = (_prevState.submissionId ?? 0) + 1;

  const fieldErrors: LoginState["fieldErrors"] = {};
  if (!email) {
    fieldErrors.email = "Enter your email address.";
  }
  if (!password) {
    fieldErrors.password = "Enter your password.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { email, submissionId, fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return {
      email,
      submissionId,
      formError: safeLoginError(error),
    };
  }

  redirect("/app");
}
