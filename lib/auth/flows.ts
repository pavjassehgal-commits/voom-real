import type { SupabaseClient } from "@supabase/supabase-js";
import { isVerifiedUser, normalizeEmail, passwordError, safeNext, validCode, validEmail, validFlowId } from "./policy";

type Auth = SupabaseClient["auth"];
export type AuthState = {
  formError?: string;
  message?: string;
  retryAfter?: number;
  fieldErrors?: { email?: string; password?: string; confirmPassword?: string };
};
export type AuthResult = { state: AuthState; destination?: string };
const MAIL_MESSAGE = "If this address is eligible, check your inbox and spam folder for an email. Delivery can take a few minutes. If you already have an account, sign in or reset your password. Wait at least a minute before trying again.";

export async function signupFlow(auth: Auth, form: FormData, callback: string): Promise<AuthResult> {
  const email = normalizeEmail(form.get("email"));
  const password = String(form.get("password") ?? "");
  const fieldErrors: NonNullable<AuthState["fieldErrors"]> = {};
  if (!validEmail(email)) fieldErrors.email = "Enter a valid email address.";
  const invalidPassword = passwordError(password);
  if (invalidPassword) fieldErrors.password = invalidPassword;
  if (form.get("confirmPassword") !== password) fieldErrors.confirmPassword = "Passwords do not match.";
  if (Object.keys(fieldErrors).length) return { state: { fieldErrors } };
  const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo: callback } });
  // A session at signup means confirmation is disabled/misconfigured. Never
  // silently promote it. Production MUST enable Confirm email before release.
  if (data.session) {
    await auth.signOut({ scope: "local" });
    return { state: { formError: "Email verification is temporarily unavailable. Please try again later." } };
  }
  if (error && !["user_already_exists", "email_exists", "over_email_send_rate_limit", "over_request_rate_limit"].includes(error.code ?? "")) {
    return { state: { formError: "We couldn't create your account. Please wait and try again." } };
  }
  // Includes Supabase's obfuscated duplicate-signup success. Never inspect identities.
  return { state: {}, destination: "/verify-email" };
}

export async function loginFlow(auth: Auth, form: FormData): Promise<AuthResult> {
  const email = normalizeEmail(form.get("email"));
  const password = String(form.get("password") ?? "");
  if (!validEmail(email) || !password || password.length > 4096) {
    return { state: { formError: "Enter your email address and password." } };
  }
  const { error } = await auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "email_not_confirmed") return { state: {}, destination: "/verify-email" };
    return { state: { formError: "Unable to sign in. Check your email and password, or wait before trying again." } };
  }
  const { data, error: userError } = await auth.getUser();
  if (userError || !data.user) {
    await auth.signOut({ scope: "local" });
    return { state: { formError: "Your session could not be validated. Please sign in again." } };
  }
  if (!isVerifiedUser(data.user)) {
    await auth.signOut({ scope: "local" });
    return { state: {}, destination: "/verify-email" };
  }
  // Login intentionally accepts existing passwords shorter than the NEW password policy.
  return { state: {}, destination: safeNext(form.get("next")) };
}

export async function emailFlow(auth: Auth, kind: "signup" | "recovery", form: FormData, callback: string): Promise<AuthState> {
  const email = normalizeEmail(form.get("email"));
  if (!validEmail(email)) return { fieldErrors: { email: "Enter a valid email address." } };
  // Supabase is the authoritative distributed rate limiter. No automatic retries.
  // Success, nonexistent, already confirmed, delivery failure and 429 look alike.
  if (kind === "signup") await auth.resend({ type: "signup", email, options: { emailRedirectTo: callback } });
  else await auth.resetPasswordForEmail(email, { redirectTo: callback });
  return { message: MAIL_MESSAGE, retryAfter: 60 };
}

export async function verificationFlow(auth: Auth, code: unknown, flowId: unknown, next: unknown): Promise<string> {
  if (!validCode(code) || (flowId != null && !validFlowId(flowId))) return "/verify-email?error=invalid_link";
  const { data, error } = await auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
  if (error) return "/verify-email?error=invalid_link";
  // Do not turn a recovery callback with a changed URL into the ordinary flow.
  if ("redirectType" in data && data.redirectType === "recovery") {
    await auth.signOut({ scope: "local" });
    return "/forgot-password?error=invalid_link";
  }
  const { data: current, error: userError } = await auth.getUser();
  if (userError || !isVerifiedUser(current.user)) {
    await auth.signOut({ scope: "local" });
    return "/verify-email?error=invalid_link";
  }
  return `/verify-email/success?next=${encodeURIComponent(safeNext(next))}`;
}

export type RecoveryCode = { code: string; flowId?: string };
export async function resetFlow(auth: Auth, form: FormData, recovery: RecoveryCode | null): Promise<AuthResult> {
  const password = String(form.get("password") ?? "");
  const invalidPassword = passwordError(password);
  if (invalidPassword) return { state: { fieldErrors: { password: invalidPassword } } };
  if (form.get("confirmPassword") !== password) return { state: { fieldErrors: { confirmPassword: "Passwords do not match." } } };
  if (!recovery || !validCode(recovery.code) || (recovery.flowId != null && !validFlowId(recovery.flowId))) {
    return { state: {}, destination: "/forgot-password?error=invalid_link" };
  }
  // Redeem the one-use PKCE code only on password submission. An existing login
  // or a forged recovery cookie alone never authorizes updateUser.
  const { data, error } = await auth.exchangeCodeForSession(recovery.code, recovery.flowId ? { flowId: recovery.flowId } : undefined);
  if (error) return { state: {}, destination: "/forgot-password?error=invalid_link" };
  const { data: current, error: userError } = await auth.getUser();
  if (!("redirectType" in data) || data.redirectType !== "recovery" || userError || !isVerifiedUser(current.user)) {
    await auth.signOut({ scope: "local" });
    return { state: {}, destination: "/forgot-password?error=invalid_link" };
  }
  const { error: updateError } = await auth.updateUser({ password });
  // Explicitly finish recovery; do not reuse its privileged session. Global
  // signout also invalidates refresh tokens on other devices after success.
  await auth.signOut({ scope: updateError ? "local" : "global" });
  return { state: {}, destination: updateError ? "/forgot-password?error=reset_failed" : "/reset-password/success" };
}
