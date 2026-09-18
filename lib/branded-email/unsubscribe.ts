/**
 * Branded Email Engine v1 — unsubscribe token authority.
 *
 * The opt-out promise is real: every marketing email carries a working link,
 * scoped to the OWNER + recipient, that suppresses future marketing sends —
 * no login required, verifiable with only the token the recipient already has.
 *
 * The token is opaque and signed: HMAC-SHA256 over the owner id + address +
 * expiry, keyed by the provider webhook secret (which the server already
 * requires for the Resend webhook). A link can be minted and verified
 * server-side only, and it can never be replayed for a different recipient.
 *
 * Every token is `expires + "." + hex(hmac(payload))`. Requests are handled by
 * `app/api/email/unsubscribe/route.ts`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "v1";
/** Marketing-suppression links last one year. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface UnsubscribeMintInput {
  secret: string;
  ownerUserId: string;
  email: string;
  /** The contact/recipient id, when the owner has a contacts row to scope to. */
  contactId?: string | null;
  /** Email flow id (when the opt-out came from a lifecycle send). */
  flowId?: string | null;
  /** Campaign id (when the opt-out came from a campaign send). */
  campaignId?: string | null;
  now?: Date;
}

export interface UnsubscribeTokenPayload {
  ownerUserId: string;
  email: string;
  contactId: string | null;
  flowId: string | null;
  campaignId: string | null;
  /** epoch seconds; decoding refuses an expired token. */
  expiresAt: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function unsubscribePayload(input: UnsubscribeMintInput): UnsubscribeTokenPayload | null {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const ownerUserId = String(input.ownerUserId ?? "").trim();
  if (!ownerUserId || !EMAIL_RE.test(email)) return null;
  const now = input.now ?? new Date();
  return {
    ownerUserId,
    email,
    contactId: input.contactId?.trim() || null,
    flowId: input.flowId?.trim() || null,
    campaignId: input.campaignId?.trim() || null,
    expiresAt: Math.floor(now.getTime() / 1000) + Math.floor(UNSUBSCRIBE_TOKEN_TTL_MS / 1000),
  };
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/** HMAC-SHA256 over the underscore-joined payload. */
export function unsubscribeSignature(secret: string, payload: UnsubscribeTokenPayload): string {
  const canonical = [
    TOKEN_VERSION,
    payload.ownerUserId,
    payload.email,
    payload.contactId ?? "",
    payload.flowId ?? "",
    payload.campaignId ?? "",
    String(payload.expiresAt),
  ].join(".");
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

/**
 * Mints the opaque token: `base64url(payloadJson).base64url(hmac)`.
 */
export function mintUnsubscribeToken(input: UnsubscribeMintInput & { secret: string }): string | null {
  const payload = unsubscribePayload(input);
  if (!payload) return null;
  const body = base64url(JSON.stringify(payload));
  const signature = unsubscribeSignature(input.secret, payload);
  return `${body}.${signature}`;
}

export interface DecodeResult {
  ok: boolean;
  payload: UnsubscribeTokenPayload | null;
  reason: string | null;
}

/**
 * Verifies an opaque unsubscribe token. Fails closed on any mismatch: bad
 * payload, bad signature, or an expiration. Constant-time comparison for the
 * signature.
 */
export function verifyUnsubscribeToken(secret: string, token: string, now = new Date()): DecodeResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, payload: null, reason: "invalid_token" };
  }
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) {
    return { ok: false, payload: null, reason: "invalid_token" };
  }

  let payload: UnsubscribeTokenPayload;
  try {
    const parsed = JSON.parse(fromBase64url(body)) as Record<string, unknown>;
    if (typeof parsed.ownerUserId !== "string"
      || typeof parsed.email !== "string"
      || typeof parsed.expiresAt !== "number") {
      return { ok: false, payload: null, reason: "invalid_token" };
    }
    payload = {
      ownerUserId: parsed.ownerUserId,
      email: parsed.email,
      contactId: typeof parsed.contactId === "string" ? parsed.contactId : null,
      flowId: typeof parsed.flowId === "string" ? parsed.flowId : null,
      campaignId: typeof parsed.campaignId === "string" ? parsed.campaignId : null,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return { ok: false, payload: null, reason: "invalid_token" };
  }

  const expected = unsubscribeSignature(secret, payload);
  const actual = Buffer.from(signature, "base64url");
  const wanted = Buffer.from(expected, "base64url");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    return { ok: false, payload: null, reason: "invalid_signature" };
  }

  if (payload.expiresAt * 1000 < now.getTime()) {
    return { ok: false, payload: null, reason: "expired" };
  }

  return { ok: true, payload, reason: null };
}
