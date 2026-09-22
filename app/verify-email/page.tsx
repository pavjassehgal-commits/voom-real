import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { isVerifiedUser } from "@/lib/auth/policy";
import AuthCard from "../auth/AuthCard";
import EmailForm from "../auth/EmailForm";
import { logout } from "../app/actions";
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getAuthUser();
  if (isVerifiedUser(user)) redirect("/verify-email/success");
  const { error } = await searchParams;
  return <AuthCard title="Verify your email">
    {error && <p role="alert" className="rounded-xl border border-red-900/40 bg-red-950/30 p-3 text-red-300">This link is invalid, expired, or already used. If you already verified, sign in. Otherwise request a new link below.</p>}
    <p>Before you can use Voom, you need to verify that you own your email address.</p>
    <p>If your signup is eligible, check your inbox and spam folder for a confirmation link. Open the newest link in the same browser where you requested it.</p>
    <EmailForm kind="signup" />
    <p>Already have an account? <Link className="underline" href="/login">Sign in</Link> or <Link className="underline" href="/forgot-password">reset your password</Link>.</p>
    {user && <form action={logout}><button className="underline">Sign out and use another account</button></form>}
  </AuthCard>;
}
