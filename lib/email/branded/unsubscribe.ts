/**
 * Branded Email Engine — the real, working unsubscribe.
 *
 * Every marketing email renders a working unsubscribe link. The link carries
 * an opaque, server-signed token:
 *
 *   token = base64url(`${ownerId}:${email}`) + "." + base64url(HMAC-SHA256(key, payload))
 *
 * Properties:
 *   - opaque: it encodes no readable IDs (only the HMAC of the payload);
 *   - stateless verification: the server recomputes the HMAC — a tampered or
 *     forged token simply does not verify and is rejected with a generic
 *     not-found;
 *   - no login required: the public /unsubscribe page works for any
 *     recipient;
 *   - durable effect: processing writes voom_email_unsubscribes (0041) PLUS
 *     the durable voom_email_suppressions row (reason 'manual') PLUS flips the
 *     contact's consent to unsubscribed — so campaign sends, audience sends
 *     and lifecycle flows all fail closed against it.
 *
 * The token is minted at send time (one per recipient per business) and never
 * stored: the same business emailing the same contact again re-derives the
 * same token, so a second click is an idempotent no-op.
 */

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const UNSUBSCRIBE_TOKEN_VERSION = "v1";

function hmacKey(): string {
  // Exclusive by design: EMAIL_UNSUBSCRIBE_SECRET is the ONLY credential
  // accepted for unsubscribe token signing/verification. No fallback to
  // SUPABASE_SECRET_KEY, CRON_SECRET, encryption keys, provider/API keys, or
  // any derived/runtime-generated secret — sharing a signing key across
  // subsystems widens the blast radius of a leak and silently couples
  // unsubscribe-token validity to an unrelated credential's rotation.
  // Unset ⇒ fail closed: minting is refused and verification returns
  // not_configured (generic not-found on the public page).
  return process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim() || "";
}

export function isUnsubscribeMintingConfigured(): boolean {
  return hmacKey() !== "";
}

function base64urlEncode(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64url");
}

function hmac(payload: string): string {
  return base64urlEncode(createHmac("sha256", hmacKey()).update(payload).digest());
}

/**
 * Mints the unsubscribe token for one recipient. Deterministic per
 * (owner, email): re-deriving it for a later send yields the same token, so
 * the link stays stable across the recipient's whole relationship.
 */
export function mintUnsubscribeToken(ownerId: string, email: string): string {
  const normalized = email.trim().toLowerCase();
  const payload = `${UNSUBSCRIBE_TOKEN_VERSION}:${ownerId}:${normalized}`;
  return `${base64urlEncode(payload)}.${hmac(payload)}`;
}

/** The full unsubscribe URL for a token, relative to the app's public site. */
export function unsubscribeUrl(siteUrl: string | URL, token: string): string {
  const base = siteUrl instanceof URL ? siteUrl : new URL(siteUrl);
  const url = new URL("/unsubscribe", base);
  url.searchParams.set("token", token);
  return url.toString();
}

export type UnsubscribeTokenCheck =
  | { ok: true; ownerId: string; email: string }
  | { ok: false; reason: "malformed" | "signature_invalid" | "not_configured" };

/**
 * Verifies a token from an incoming /unsubscribe request.
 *
 * Constant-time signature comparison; any malformed or forged token is
 * rejected with a reason that does NOT reveal whether an owner or address
 * exists — the public page shows the same generic not-found either way.
 */
export function verifyUnsubscribeToken(token: string | null | undefined): UnsubscribeTokenCheck {
  const key = hmacKey();
  if (!key) return { ok: false, reason: "not_configured" };
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(payloadPart, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const parts = payload.split(":");
  if (parts.length !== 3 || parts[0] !== UNSUBSCRIBE_TOKEN_VERSION) return { ok: false, reason: "malformed" };
  const [, ownerId, email] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) return { ok: false, reason: "malformed" };
  const normalizedEmail = (email ?? "").toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedEmail)) return { ok: false, reason: "malformed" };

  const expected = hmac(payload);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signaturePart, "utf8");
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, reason: "signature_invalid" };
  }

  return { ok: true, ownerId, email: normalizedEmail };
}

export interface ProcessUnsubscribeResult {
  ok: boolean;
  reason: "unsubscribed" | "already_unsubscribed" | "invalid_token" | "processing_failed";
  businessName: string | null;
}

/**
 * The work behind a verified unsubscribe click: durable record + suppression
 * + consent flip, all through the guarded service-role RPC. The RPC is
 * idempotent, so a double-click (or a second email's link) is a safe no-op.
 */
export async function processEmailUnsubscribe(
  admin: SupabaseClient,
  input: { ownerId: string; email: string },
): Promise<ProcessUnsubscribeResult> {
  const { data: business } = await admin.from("businesses")
    .select("brand_name")
    .eq("owner_user_id", input.ownerId)
    .maybeSingle();
  const businessName = String((business as { brand_name?: string | null } | null)?.brand_name ?? "").trim() || null;

  const { data, error } = await admin.rpc("record_email_unsubscribe", {
    p_owner_user_id: input.ownerId,
    p_email: input.email,
    p_contact_id: null,
    p_source: "email_footer",
  });

  if (error) {
    return { ok: false, reason: "processing_failed", businessName };
  }

  return {
    ok: true,
    reason: (data as { status?: string } | null)?.status === "unsubscribed" ? "unsubscribed" : "already_unsubscribed",
    businessName,
  };
}
