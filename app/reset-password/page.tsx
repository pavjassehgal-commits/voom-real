import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { AuthFrame } from "@/components/voom/auth/AuthFrame";
import { NewPasswordForm } from "@/components/voom/auth/AccountEmailForm";
import { validRecoveryProof } from "@/lib/transactional-email/core";
export const metadata = { title: "Choose a new password | Voom", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function ResetPasswordPage() {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const claims = await supabase.auth.getClaims();
    const sessionId = claims.data?.claims?.session_id;
    const valid = data.user && typeof sessionId === "string" && claims.data?.claims?.sub === data.user.id && validRecoveryProof((await cookies()).get("voom_password_recovery")?.value, data.user.id, sessionId, process.env.VOOM_AUTH_EMAIL_SECRET || "");
    return <AuthFrame title={valid ? "Choose a new password" : "Request a reset link"}>{valid ? <NewPasswordForm /> : <p className="mt-6 text-center text-sm text-text-2">Open a valid reset link from your email first. <Link href="/forgot-password" className="font-semibold text-[var(--brand)]">Request a new link</Link></p>}</AuthFrame>;
}
