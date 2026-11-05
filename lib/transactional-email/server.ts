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
export async function allowAuthEmail(email: string) {
    const secret = process.env.VOOM_AUTH_EMAIL_SECRET;
    if (!secret || secret.length < 32)
        return false;
    try {
        const h = await headers();
        // On Vercel this header is overwritten by the edge, unlike caller-supplied XFF.
        const ip = process.env.VERCEL ? h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() : "local";
        if (!ip)
            return false;
        const result = await createAdminClient().rpc("consume_voom_auth_email_limit", { p_ip_hash: hmac(secret, "auth-ip", ip), p_email_hash: hmac(secret, "auth-email", email.toLowerCase()) }).abortSignal(AbortSignal.timeout(2500));
        return !result.error && result.data === true;
    }
    catch {
        return false;
    }
}
