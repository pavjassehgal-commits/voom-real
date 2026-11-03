import { AuthFrame } from "@/components/voom/auth/AuthFrame";
import { AccountEmailForm } from "@/components/voom/auth/AccountEmailForm";
export const metadata = { title: "Confirm email | Voom", robots: { index: false, follow: false } };
export default function VerifyEmailPage() { return <AuthFrame title="Confirm your email" subtitle="Request a fresh confirmation link."><AccountEmailForm kind="verify"/></AuthFrame>; }
