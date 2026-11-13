"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { resolveSiteUrl } from "@/utils/site-url";
import { allowAuthEmail, queueWelcome } from "@/lib/transactional-email/server";
import { recoveryProof, validRecoveryProof } from "@/lib/transactional-email/core";
import { requestAuthEmail, validAuthEmail } from "@/lib/transactional-email/auth-requests";
export type AccountEmailState = {
    success?: boolean;
    message?: string;
    error?: string;
};
export async function requestPasswordReset(_state: AccountEmailState, form: FormData): Promise<AccountEmailState> {
    const email = String(form.get("email") || "").trim();
    if (!validAuthEmail(email))
        return { error: "Enter a valid email address." };
    return requestAuthEmail(() => allowAuthEmail("request", email), async () => {
        const supabase = await createClient();
        await supabase.auth.resetPasswordForEmail(email, { redirectTo: new URL("/auth/recovery", resolveSiteUrl(null)).toString() });
    });
}
export async function requestVerification(_state: AccountEmailState, form: FormData): Promise<AccountEmailState> {
    const email = String(form.get("email") || "").trim();
    if (!validAuthEmail(email))
        return { error: "Enter a valid email address." };
    return requestAuthEmail(() => allowAuthEmail("request", email), async () => {
        const supabase = await createClient();
        const callback = new URL("/auth/callback", resolveSiteUrl(null));
        callback.searchParams.set("next", "/app");
        callback.searchParams.set("flow", "signup");
        await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: callback.toString() } });
    });
}
// Supabase supplies a hex TokenHash, optionally prefixed with pkce_. Bound the
// input without assuming a digest size; Auth validates the token and lifetime.
function validTokenHash(hash: string) { return hash.length <= 256 && /^(?:pkce_)?[a-f0-9]{32,256}$/.test(hash); }
export async function confirmEmail(_state: AccountEmailState, form: FormData): Promise<AccountEmailState> {
    const failure = { error: "This confirmation link is invalid, expired or already used. If you already confirmed your email, log in; otherwise request a new link." };
    const hash = String(form.get("token_hash") || "");
    if (!validTokenHash(hash))
        return failure;
    const limit = await allowAuthEmail("confirm", hash);
    if (limit === "unavailable") return { error: "This service is temporarily unavailable. Please try again later." };
    if (limit === "limited") return { error: "Please wait before trying again." };
    let userId: string;
    try {
        const supabase = await createClient();
        // token_hash verification needs no PKCE verifier, so it works in any browser or device.
        const result = await supabase.auth.verifyOtp({ token_hash: hash, type: "email" });
        if (result.error)
            return failure;
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user)
            return failure;
        userId = data.user.id;
    }
    catch {
        return failure;
    }
    await queueWelcome(userId);
    redirect("/app");
}
export async function continueRecovery(_state: AccountEmailState, form: FormData): Promise<AccountEmailState> {
    const failure = { error: "This reset link is invalid or expired. Request a new link." };
    const code = String(form.get("code") || "");
    const hash = String(form.get("token_hash") || "");
    const secret = process.env.VOOM_AUTH_EMAIL_SECRET || "";
    // Supabase supplies a hex TokenHash, optionally prefixed with pkce_.
    // Bound the input without assuming a digest size. Auth validates the token and its lifetime.
    const malformedHash = hash && (hash.length > 256 || !/^(?:pkce_)?[a-f0-9]{32,256}$/.test(hash));
    if (secret.length < 32 || Boolean(code) === Boolean(hash) || code.length > 2048 || malformedHash)
        return failure;
    const limit = await allowAuthEmail("recovery", hash || code);
    if (limit === "unavailable") return { error: "This service is temporarily unavailable. Please try again later." };
    if (limit === "limited") return { error: "Please wait before trying again." };
    try {
        const supabase = await createClient();
        const flowId = String(form.get("sb_flow_id") || "");
        if (flowId.length > 128)
            return failure;
        const result = hash ? await supabase.auth.verifyOtp({ token_hash: hash, type: "recovery" }) : await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
        if (result.error)
            return failure;
        const { data, error } = await supabase.auth.getUser();
        const claims = await supabase.auth.getClaims();
        const sessionId = claims.data?.claims?.session_id;
        if (error || !data.user || typeof sessionId !== "string" || claims.data?.claims?.sub !== data.user.id)
            return failure;
        const jar = await cookies();
        jar.set("voom_password_recovery", recoveryProof(data.user.id, sessionId, secret), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/reset-password", maxAge: 600 });
    }
    catch {
        return failure;
    }
    redirect("/reset-password");
}
export async function changeRecoveredPassword(_state: AccountEmailState, form: FormData): Promise<AccountEmailState> {
    const password = String(form.get("password") || "");
    const confirmation = String(form.get("confirmPassword") || "");
    if (password.length < 8 || password.length > 128)
        return { error: "Use a password between 8 and 128 characters." };
    if (password !== confirmation)
        return { error: "Passwords do not match." };
    let allSessionsRevoked = false;
    try {
        const supabase = await createClient();
        const { data, error } = await supabase.auth.getUser();
        const claims = await supabase.auth.getClaims();
        const sessionId = claims.data?.claims?.session_id;
        const jar = await cookies();
        if (error || !data.user || typeof sessionId !== "string" || claims.data?.claims?.sub !== data.user.id || !validRecoveryProof(jar.get("voom_password_recovery")?.value, data.user.id, sessionId, process.env.VOOM_AUTH_EMAIL_SECRET || ""))
            return { error: "Request a new password-reset link." };
        const limit = await allowAuthEmail("password-update", data.user.id);
        if (limit === "unavailable") return { error: "This service is temporarily unavailable. Please try again later." };
        if (limit === "limited")
            return { error: "Please wait before trying again." };
        const result = await supabase.auth.updateUser({ password });
        if (result.error)
            return { error: "Your password could not be updated. Please try again or request a new link." };
        jar.set("voom_password_recovery", "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/reset-password", maxAge: 0 });
        try {
            const signOut = await supabase.auth.signOut({ scope: "global" });
            allSessionsRevoked = !signOut.error;
        } catch {
            allSessionsRevoked = false;
        }
        if (!allSessionsRevoked) {
            // The password has already changed. Try to clear this browser, but
            // do not claim that the other sessions were revoked.
            try { await supabase.auth.signOut({ scope: "local" }); } catch { /* best effort */ }
        }
    }
    catch {
        return { error: "Your password could not be updated safely. Request a new link if needed." };
    }
    if (!allSessionsRevoked) return { error: "Your password was updated, but we could not confirm that other sessions were signed out. Please contact support." };
    redirect("/login?notice=password_updated");
}
