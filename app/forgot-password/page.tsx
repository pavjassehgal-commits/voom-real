import { AuthFrame } from "@/components/voom/auth/AuthFrame";
import { AccountEmailForm } from "@/components/voom/auth/AccountEmailForm";
export const metadata = { title: "Reset password | Voom", robots: { index: false, follow: false } };
export default function ForgotPasswordPage() { return <AuthFrame title="Reset your password" subtitle="We’ll email a secure link if your account is eligible."><AccountEmailForm kind="reset"/></AuthFrame>; }
