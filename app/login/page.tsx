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
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) {
    redirect("/app");
  }

  const { error } = await searchParams;
  const initialError = error ? SAFE_ERRORS[error] : undefined;

  return (
    <AuthFrame title="Welcome back" subtitle="Log in to your Voom account">
      <LoginForm initialError={initialError} />
    </AuthFrame>
  );
}
