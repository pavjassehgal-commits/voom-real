import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { isVerifiedUser, safeNext } from "@/lib/auth/policy";
import AuthCard from "../../auth/AuthCard";
export default async function VerificationSuccess({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!isVerifiedUser(await getAuthUser())) redirect("/verify-email");
  const { next } = await searchParams;
  return <AuthCard title="Email verified">
    <p>Your email is verified. You can now continue to Voom.</p>
    <Link className="voom-grad flex min-h-12 items-center justify-center rounded-xl px-4 font-semibold text-white" href={safeNext(next)}>Continue to Voom</Link>
  </AuthCard>;
}
