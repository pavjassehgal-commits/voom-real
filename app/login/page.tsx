import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { AuthFrame } from "@/components/voom/auth/AuthFrame";
import LoginForm from "./LoginForm";

// Only these fixed keys can put text on the page; the address bar is never echoed.
const SAFE_ERRORS: Record<string, string> = {
  confirm_failed:
    "Your confirmation link is invalid or has expired. Please log in, or sign up again to receive a new link.",
  google_failed:
    "Google sign-in didn't complete. Please try again, or log in with your email.",
};
const SAFE_NOTICES: Record<string, string> = {
  password_reset: "Your password has been updated. Log in with your new password.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) {
    redirect("/app");
  }

  const { error, notice } = await searchParams;
  const initialError = error ? SAFE_ERRORS[error] : undefined;
  const initialNotice = notice ? SAFE_NOTICES[notice] : undefined;

  return (
    <AuthFrame title="Welcome back" subtitle="Log in to your Voom account">
      <LoginForm initialError={initialError} initialNotice={initialNotice} />
    </AuthFrame>
  );
}
