"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { queueWelcome } from "@/lib/transactional-email/server";
import { EMAIL_NOT_CONFIRMED_MESSAGE, INVALID_LOGIN_MESSAGE } from "./messages";

export type LoginState = {
  formError?: string;
  /** The password was correct but the address is not confirmed yet. */
  unconfirmed?: boolean;
  fieldErrors?: {
    email?: string;
    password?: string;
  };
};

export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  const fieldErrors: LoginState["fieldErrors"] = {};
  if (!email) {
    fieldErrors.email = "Enter your email address.";
  }
  if (!password) {
    fieldErrors.password = "Enter your password.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Supabase Auth returns email_not_confirmed only after it has verified the
    // password, so this reveals nothing to someone who doesn't already know it.
    // Every other failure keeps the one generic message; provider text is never shown.
    if ((error as { code?: unknown }).code === "email_not_confirmed") {
      return { formError: EMAIL_NOT_CONFIRMED_MESSAGE, unconfirmed: true };
    }
    return { formError: INVALID_LOGIN_MESSAGE };
  }

  if(data.user)await queueWelcome(data.user.id);
  redirect("/app");
}
