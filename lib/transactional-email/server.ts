import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/utils/supabase/admin";
import { hmac } from "./core";
export async function queueWelcome(userId: string) {
    if (process.env.VOOM_TRANSACTIONAL_EMAIL_ENABLED !== "true")
        return;
    try {
        const result = await createAdminClient().rpc("queue_voom_welcome", { p_owner: userId }).abortSignal(AbortSignal.timeout(1500));
        if (result.error)
            throw new Error("queue_failed");
    }
    catch {
        console.error("[transactional-email] welcome_queue_unavailable");
    }
}
export type AuthEmailAction = "request" | "recovery" | "password-update";
export type AuthEmailLimit = "allowed" | "limited" | "unavailable";
export async function allowAuthEmail(action: AuthEmailAction, subject: string): Promise<AuthEmailLimit> {
    const secret = process.env.VOOM_AUTH_EMAIL_SECRET;
    if (!secret || secret.length < 32)
        return "unavailable";
    try {
        const h = await headers();
        // On Vercel this header is overwritten by the edge, unlike caller-supplied XFF.
        const ip = process.env.VERCEL ? h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() : "local";
        if (!ip)
            return "unavailable";
        // Requests share one budget; recovery and update get separate IP budgets.
        // The database function still enforces its shared global hourly budget.
        const result = await createAdminClient().rpc("consume_voom_auth_email_limit", { p_ip_hash: hmac(secret, `auth-ip:${action}`, ip), p_email_hash: hmac(secret, `auth-subject:${action}`, subject.toLowerCase()) }).abortSignal(AbortSignal.timeout(2500));
        if (result.error || typeof result.data !== "boolean") return "unavailable";
        return result.data ? "allowed" : "limited";
    }
    catch {
        return "unavailable";
    }
}
