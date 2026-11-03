import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { AuthFrame } from "@/components/voom/auth/AuthFrame";
import LoginForm from "./LoginForm";

const SAFE_ERRORS: Record<string, string> = {
  confirm_failed:
    "Your confirmation link is invalid or has expired. Please log in, or sign up again to receive a new link.",
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

  const { error,notice } = await searchParams;
  const initialError = error ? SAFE_ERRORS[error] : undefined;

  return (
    <AuthFrame title="Welcome back" subtitle="Log in to your Voom account">
      {notice==="password_updated"&&<p role="status" className="mt-4 text-center text-sm text-text-2">Your password was updated. Log in with your new password.</p>}
      <LoginForm initialError={initialError} />
    </AuthFrame>
  );
}
