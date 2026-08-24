import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import Logo from "../components/Logo";
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
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <LoginForm initialError={initialError} />
    </div>
  );
}
