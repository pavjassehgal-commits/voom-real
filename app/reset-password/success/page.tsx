import Link from "next/link";
import AuthCard from "../../auth/AuthCard";
export default function ResetSuccess() {
  return <AuthCard title="Password reset complete"><p>You can now sign in with your new password. Other devices may need to sign in again too.</p><Link href="/login" className="voom-grad flex min-h-12 items-center justify-center rounded-xl px-4 font-semibold text-white">Sign in</Link></AuthCard>;
}
