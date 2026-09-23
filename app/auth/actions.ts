"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { emailFlow, resetFlow, type AuthState } from "@/lib/auth/flows";
import { authCallbackUrl } from "@/lib/auth/site";
import { clearLocalAuthCookies } from "@/lib/auth/cookies";
import { readRecoveryCode, RECOVERY_COOKIE } from "@/lib/auth/recovery";

async function sendEmail(kind: "signup" | "recovery", form: FormData): Promise<AuthState> {
  const store = await cookies();
  const remaining = Math.ceil((Number(store.get("voom_auth_mail_after")?.value ?? 0) - Date.now()) / 1000);
  // A convenience cooldown only. Supabase enforces project/user/IP limits even
  // if this cookie is removed, forged, or requests hit different server instances.
  if (remaining > 0) return { message: "Please wait before requesting another email.", retryAfter: Math.min(remaining, 60) };
  const supabase = await createClient();
  let state: AuthState;
  try {
    state = await emailFlow(supabase.auth, kind, form, authCallbackUrl(kind));
  } catch {
    state = { message: "If this address is eligible, an email may arrive shortly. Please wait before trying again.", retryAfter: 60 };
  }
  if (state.retryAfter) store.set("voom_auth_mail_after", String(Date.now() + 60_000), {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60,
  });
  return state;
}
export async function resendVerification(_previous: AuthState, form: FormData): Promise<AuthState> {
  return sendEmail("signup", form);
}
export async function forgotPassword(_previous: AuthState, form: FormData): Promise<AuthState> {
  return sendEmail("recovery", form);
}
export async function resetPassword(_previous: AuthState, form: FormData): Promise<AuthState> {
  const store = await cookies();
  const recovery = readRecoveryCode(store.get(RECOVERY_COOKIE)?.value);
  const supabase = await createClient();
  let result;
  try { result = await resetFlow(supabase.auth, form, recovery); }
  catch {
    await clearLocalAuthCookies();
    redirect("/forgot-password?error=reset_failed");
  }
  if (result.destination) {
    await clearLocalAuthCookies();
    redirect(result.destination);
  }
  return result.state;
}
