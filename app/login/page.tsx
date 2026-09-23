import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { isVerifiedUser, safeNext } from "@/lib/auth/policy";
import Logo from "../components/Logo";
import LoginForm from "./LoginForm";

const SAFE_ERRORS: Record<string, string> = {
  confirm_failed:
    "Your confirmation link is invalid or has expired. Please sign in, or request a new link from the Verify email screen.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const user = await getAuthUser();
  if (isVerifiedUser(user)) {
    redirect("/app");
  }

  const { error, next } = await searchParams;
  const initialError = error ? SAFE_ERRORS[error] : undefined;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <LoginForm initialError={initialError} next={safeNext(next)} />
    </div>
  );
}
