import AuthCard from "../auth/AuthCard";
import EmailForm from "../auth/EmailForm";
export default async function ForgotPassword({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <AuthCard title="Reset your password">
    {error && <p role="alert" className="text-red-300">{error === "reset_failed" ? "Your password could not be changed. Request a new link and choose a different strong password." : "This reset link is invalid, expired, already used, or was opened in another browser. Request a new link below."}</p>}
    <p>Enter your email. If an account is eligible, we&apos;ll email you a secure reset link.</p>
    <p>Open the newest link in this browser. Never share your link or password.</p>
    <EmailForm kind="recovery" />
  </AuthCard>;
}
