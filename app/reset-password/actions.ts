"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";

export type ResetPasswordState = {
  formError?: string;
  /** The recovery session is gone: the link expired, was used, or was opened elsewhere. */
  linkExpired?: boolean;
  fieldErrors?: {
    password?: string;
    confirmPassword?: string;
  };
};

const LINK_EXPIRED_MESSAGE =
  "This reset link is invalid or has expired. Request a new one to continue.";

/**
 * Sets the new password for the recovery session that /auth/callback created
 * from the emailed link. Same rules as signup: at least 8 characters, and the
 * two fields must match. On success every session for the account is ended
 * (this browser and any other device) and the user is sent to the login page
 * to sign in with the new password. See DECISIONS 2026-10-20.
 */
export async function resetPassword(
  _prevState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const fieldErrors: ResetPasswordState["fieldErrors"] = {};
  if (password.length < 8) {
    fieldErrors.password = "Password must be at least 8 characters.";
  }
  if (confirmPassword !== password) {
    fieldErrors.confirmPassword = "Passwords do not match.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    // Supabase names the two user-fixable cases; everything else means the
    // recovery session behind this page is gone.
    if (error.code === "same_password") {
      return { fieldErrors: { password: "Choose a password you haven't used before." } };
    }
    if (error.code === "weak_password") {
      return { fieldErrors: { password: "That password is too easy to guess. Try a longer one." } };
    }
    return { formError: LINK_EXPIRED_MESSAGE, linkExpired: true };
  }

  // The password is already changed at this point. "global" also ends sessions
  // on other devices, so anyone else using the account is logged out too. If
  // the sign-out call itself fails, the user still goes to login: the recovery
  // session is single-use and the new password is in place either way.
  const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
  if (signOutError) {
    console.error("[reset-password] sign-out after password change failed", signOutError.message);
  }

  redirect("/login?notice=password_reset");
}
