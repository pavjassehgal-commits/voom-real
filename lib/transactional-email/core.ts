import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { createResendApiClient } from "../email/core";
type Env = Record<string, string | undefined>;
export interface TransactionalConfig {
    key: string;
    from: string;
    site: string;
    secret: string;
    webhook: string;
    testRecipient: string | null;
}
const emailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export function transactionalConfig(env: Env = process.env): TransactionalConfig | null {
    if (env.VOOM_TRANSACTIONAL_EMAIL_ENABLED !== "true")
        return null;
    const key = env.VOOM_TRANSACTIONAL_RESEND_API_KEY?.trim(), secret = env.VOOM_AUTH_EMAIL_SECRET;
    const from = env.VOOM_TRANSACTIONAL_FROM_ADDRESS?.trim() || "no-reply@voom.today";
    const site = new URL(env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000");
    if (!key || !secret || secret.length < 32 || !emailPattern.test(from) || site.username || site.password || site.pathname !== "/")
        throw new Error("transactional_configuration_invalid");
    if (env.NODE_ENV === "production" && site.protocol !== "https:")
        throw new Error("transactional_https_required");
    if (env.VERCEL_ENV === "production" && (site.origin !== "https://voom.today" || from !== "no-reply@voom.today"))
        throw new Error("transactional_production_identity_invalid");
    const testRecipient = env.VOOM_TRANSACTIONAL_TEST_RECIPIENT?.trim().toLowerCase() || null;
    if (env.VERCEL_ENV === "preview" && (!testRecipient || !emailPattern.test(testRecipient) || site.hostname === "voom.today"))
        throw new Error("transactional_preview_isolation_required");
    return { key, from, site: site.origin, secret, webhook: env.VOOM_TRANSACTIONAL_WEBHOOK_SECRET || "", testRecipient };
}
export function hmac(secret: string, kind: string, value: string) { return createHmac("sha256", secret).update(kind + ":" + value).digest("hex"); }
function equal(a: string, b: string) { return /^[a-f0-9]{64}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function recoveryProof(userId: string, sessionId: string, secret: string, now = Date.now()) {
    if (secret.length < 32 || !userId || !sessionId)
        throw new Error("recovery_proof_unavailable");
    const expires = now + 10 * 60000;
    return expires + "." + hmac(secret, "recovery", [userId, sessionId, expires].join("|"));
}
export function validRecoveryProof(proof: string | undefined, userId: string, sessionId: string, secret: string, now = Date.now()) {
    if (secret.length < 32 || !proof || !userId || !sessionId)
        return false;
    const [expiry, signature, ...extra] = proof.split(".");
    const expires = Number(expiry);
    return extra.length === 0 && Number.isSafeInteger(expires) && expires > now && expires <= now + 10 * 60000 && equal(signature || "", hmac(secret, "recovery", [userId, sessionId, expires].join("|")));
}
export function emailDocument(title: string, message: string, label: string, url: string, site: string) {
    const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="UTF-8"><title>${escape(title)}</title></head>
<body style="margin:0;background:#f7f5fb;color:#211b35;font:16px Arial,sans-serif">
<table role="presentation" width="100%"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;table-layout:fixed;background:#fff;border-radius:16px"><tr><td style="padding:28px">
<img src="${escape(site)}/brand/voom-app-icon-e73c1c43.png" width="48" height="48" alt="Voom">
<h1 style="font-size:24px;line-height:1.3">${escape(title)}</h1><p style="line-height:1.6">${escape(message)}</p>
<p style="margin:28px 0"><a href="${escape(url)}" style="display:inline-block;background:#7640d9;color:#fff;padding:14px 20px;border-radius:8px;text-decoration:none">${escape(label)}</a></p>
<p style="font-size:13px;line-height:1.6">If the button does not work, copy this link:<br><a href="${escape(url)}" style="overflow-wrap:anywhere;word-break:break-all">${escape(url)}</a></p>
<hr style="border:0;border-top:1px solid #eee"><p style="font-size:12px;line-height:1.6;color:#655b75">This is a Voom account message, not a business marketing campaign. <a href="${escape(site)}/privacy">Privacy</a></p>
</td></tr></table></td></tr></table></body></html>`;
}
export interface EmailJob {
    id: string;
    owner_user_id: string;
    recipient: string;
    claim_token: string;
    payload: Record<string, unknown> | null;
}
export interface Rpc {
    rpc: (name: string, args?: Record<string, unknown>) => PromiseLike<{
        data: unknown;
        error: unknown;
    }>;
}
export async function processTransactionalEmail(db: Rpc, config: TransactionalConfig, fetchImpl: typeof fetch = fetch) {
    const rpc = async (name: string, args?: Record<string, unknown>) => { const r = await db.rpc(name, args); if (r.error)
        throw new Error("transactional_database_unavailable"); return r.data; };
    const rows = await rpc("claim_voom_transactional_email") as EmailJob[];
    if (!rows?.length)
        return { status: "idle" };
    const job = rows[0];
    let submitted = false;
    const finish = (status: string, messageId: string | null, error: string | null) => rpc("finish_voom_transactional_email", { p_id: job.id, p_claim: job.claim_token, p_status: status, p_message_id: messageId, p_error: error });
    try {
        if (config.testRecipient && config.testRecipient !== job.recipient.toLowerCase()) {
            await finish("failed", null, "test_recipient_not_allowed");
            return { status: "blocked" };
        }
        const url = config.site + "/app/onboarding";
        const proposed = { from: `Voom <${config.from}>`, to: [job.recipient], subject: "Welcome to Voom",
            html: emailDocument("Welcome to Voom", "Your Voom account is ready. Start by setting up your business, then review your marketing plan before approving any content.", "Open Voom", url, config.site),
            text: `Welcome to Voom. Your account is ready. Set up your business: ${url}\nNothing is published without the approvals required by your settings.`,
            tags: [{ name: "voom_tx_id", value: job.id }, { name: "voom_tx_proof", value: hmac(config.secret, "delivery", job.id + "|" + config.site) }] };
        // Freeze bytes durably BEFORE the provider call, reuse on definitive retries.
        const body = await rpc("prepare_voom_transactional_email", { p_id: job.id, p_claim: job.claim_token, p_payload: job.payload || proposed }) as Record<string, unknown>;
        if (!body || JSON.stringify(body.to) !== JSON.stringify([job.recipient]) || body.from !== proposed.from)
            throw new Error("transactional_payload_invalid");
        const client = createResendApiClient({ provider: "resend", apiKey: config.key, fromAddress: config.from, fromName: "Voom", webhookSecret: config.webhook, apiBaseUrl: "https://api.resend.com" }, { fetch: fetchImpl, timeoutMs: 15000 });
        submitted = true;
        const response = await client.post("emails", body, { redirect: "error", headers: { "Idempotency-Key": "voom-welcome/" + job.id } });
        let value: {
            id?: unknown;
        } = {};
        try {
            value = await response.json();
        }
        catch { /* ambiguous provider response */ }
        const id = typeof value?.id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value.id) ? value.id : null;
        if (response.ok && id) {
            await finish("accepted", id, null);
            return { status: "accepted" };
        }
        if (response.status === 429) {
            await finish("retryable", null, "provider_rate_limited");
            return { status: "retryable" };
        }
        const uncertain = response.ok || response.status >= 500 || response.status === 408 || response.status === 409;
        await finish(uncertain ? "uncertain" : "failed", null, uncertain ? "provider_outcome_uncertain" : "provider_rejected");
        return { status: uncertain ? "uncertain" : "failed" };
    }
    catch {
        // Lost acceptance/result writes are never converted into permission to retry.
        try {
            await finish(submitted ? "uncertain" : "failed", null, submitted ? "provider_outcome_uncertain" : "preparation_failed");
        }
        catch { /* Stale claim is fenced and becomes uncertain, never resubmitted. */ }
        return { status: submitted ? "uncertain" : "failed" };
    }
}
export async function handleTransactionalWebhook(request: Request, db: Rpc, config: TransactionalConfig) {
    if (!config.webhook)
        return new Response("Not configured", { status: 503 });
    const reader = request.body?.getReader();
    if (!reader)
        return new Response("Invalid body", { status: 400 });
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        bytes += value.length;
        if (bytes > 65536) {
            await reader.cancel();
            return new Response("Too large", { status: 413 });
        }
        chunks.push(value);
    }
    const payload = Buffer.concat(chunks).toString("utf8");
    let event: Record<string, unknown>;
    try {
        event = new Webhook(config.webhook).verify(payload, { "webhook-id": request.headers.get("svix-id") || "", "webhook-timestamp": request.headers.get("svix-timestamp") || "", "webhook-signature": request.headers.get("svix-signature") || "" }) as Record<string, unknown>;
    }
    catch {
        return new Response("Invalid signature", { status: 403 });
    }
    const data = event.data as Record<string, unknown> | undefined;
    if (Array.isArray(data?.tags) && data.tags.some(t => !t || typeof t !== "object" || typeof t.name !== "string" || typeof t.value !== "string"))
        return new Response("Invalid tags", { status: 400 });
    const tags = Array.isArray(data?.tags) ? Object.fromEntries(data.tags.map(t => [t.name, t.value])) : (data?.tags || {}) as Record<string, string>;
    const id = tags.voom_tx_id, proof = tags.voom_tx_proof;
    if (typeof id !== "string" || !(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(id) || typeof proof !== "string" || !equal(proof, hmac(config.secret, "delivery", id + "|" + config.site)))
        return new Response("Ignored", { status: 200 });
    const statuses: Record<string, string> = { "email.sent": "accepted", "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed" };
    const status = statuses[String(event.type)];
    if (!status)
        return new Response("Ignored", { status: 200 });
    if (typeof data?.email_id !== "string" || !data.email_id || data.email_id.length > 200)
        return new Response("Invalid message", { status: 400 });
    try {
        const result = await db.rpc("record_voom_transactional_receipt", { p_id: id, p_event_id: request.headers.get("svix-id"), p_message_id: data.email_id, p_status: status });
        if (result.error)
            throw new Error("receipt_failed");
    }
    catch {
        return new Response("Receipt not persisted; retry", { status: 503 });
    }
    return new Response("OK", { status: 200 });
}
// Interface only. A future verified billing-webhook adapter must supply these
// facts; no payment success is fabricated and no billing email is sent here.
export interface SubscriptionEmailHooks {
    onVerifiedSubscriptionEvent(event: {
        providerEventId: string;
        ownerId: string;
        kind: "subscription_changed" | "payment_failed";
        verifiedAt: string;
    }): Promise<void>;
}
