/**
 * Branded Email Engine v1 — authoritative sender identity.
 *
 * Who an email appears to come FROM, per business. Rules, in strict order:
 *
 *   1. Never spoof. A business-supplied sending address is only used when it
 *      is tied to a provider-verified sending domain from the account's own
 *      sender rows. Verification state is stored truthfully as
 *      `not_configured` | `pending` | `verified` | `failed` (or `unverified`).
 *   2. When no verified identity exists, the send fails safe to the approved
 *      Voom-managed identity (`EMAIL_FROM_NAME` / `EMAIL_FROM_ADDRESS`,
 *      provider-verified out-of-band), preserving the business's display name
 *      in the from-name where the provider permits it.
 *   3. Reply-to is only ever the business's own validated reply address; when
 *      absent it is left unset rather than pointing at a Voom ops inbox.
 *
 * Truthfulness: verification status is NEVER inferred from a domain string —
 *      it comes only from stored provider-backed state. When nothing is
 *      verified the status says so, and the UI/guard both require configuration.
 */

import { readResendConfig } from "@/lib/email/core";

// ─── State vocabulary ──────────────────────────────────────────────────────

export const SENDER_STATUSES = [
  "not_configured",
  "pending",
  "verified",
  "failed",
  "unverified",
] as const;
export type SenderVerificationStatus = (typeof SENDER_STATUSES)[number];

export interface BusinessSenderRecord {
  id?: string | null;
  ownerId?: string | null;
  /** business-supplied sending address, exactly as stored. */
  address: string | null;
  /** optional business-supplied friendly name. */
  name?: string | null;
  /** the provider domain this address belongs to. */
  domain?: string | null;
  /** truthfully stored provider state — never inferred. */
  status: SenderVerificationStatus | null;
}

export interface ResolvedSender {
  /** The business display name used for the from-name (never "Voom"). */
  fromName: string;
  /** The actual sending address handed to the provider. */
  fromAddress: string;
  /**
   * True when the sending address is the business's OWN verified address.
   * False means the send went through the Voom-managed identity.
   */
  onBusinessIdentity: boolean;
  /** The business's validated reply-to address, or null. */
  replyTo: string | null;
  /** Truthful verification status of the business identity. */
  verificationStatus: SenderVerificationStatus;
  /** Each problem that forced the fallback, for the needs-attention UI. */
  fallbackReasons: string[];
  /** The display identity recipients actually see, as a single string. */
  display: string;
}

export interface SenderResolveInput {
  businessName: string | null | undefined;
  /** Business-supplied sender address (candidate only). */
  senderAddress: string | null | undefined;
  /** Business-supplied friendly from-name override (candidate only). */
  senderName: string | null | undefined;
  /** Real, validated business reply-to address, else null. */
  replyTo: string | null | undefined;
  /** The owner-scoped sender rows from the domain store (see 0041). */
  senderRows?: BusinessSenderRecord[];
}

/**
 * Provider-verified sending domains: a business identity may only send through
 * one of these. The list comes ENTIRELY from stored rows (`business_email_sender_domains`
 * / `business_email_senders`) or from the Voom-managed config — never from a
 * guessed domain string.
 */
export function domainOfAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const normalized = String(address).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized.slice(normalized.lastIndexOf("@") + 1);
}

const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The email-safe shape check shared by the sender layer and the guard. */
export function isValidSenderAddress(value: unknown): value is string {
  return typeof value === "string" && VALID_EMAIL_RE.test(value.trim()) && value.trim().length <= 320;
}

const NAME_LIMIT = 120;

function cleanName(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  // A from-name must be a real display name; a bare address never qualifies.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return fallback;
  if (/[<>]/u.test(raw)) return fallback;
  return raw.slice(0, NAME_LIMIT);
}

/** The business label shown to recipients — never "Voom", never empty. */
export function businessDisplayName(businessName: string | null | undefined): string {
  const name = cleanName(businessName, "");
  if (!name) return "Your business";
  return name;
}

/**
 * Decides whether a business-supplied address may actually send. Only an
 * address whose domain carries a `verified` provider-backed row may be used;
 * anything else is a spoof risk and is refused.
 */
export function businessIdentityStatus(
  address: string | null | undefined,
  senderRows: BusinessSenderRecord[] = [],
): SenderVerificationStatus {
  if (!isValidSenderAddress(address) || !senderRows.length) return "not_configured";
  const domain = domainOfAddress(address);
  const rows = senderRows.filter((row) => {
    const rowDomain = domainOfAddress(row.address) ?? row.domain;
    return row.address?.trim().toLowerCase() === address!.trim().toLowerCase()
      || (domain && rowDomain && rowDomain.toLowerCase() === domain.toLowerCase());
  });

  if (rows.some((row) => row.status === "verified")) return "verified";
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (rows.some((row) => row.status === "pending")) return "pending";
  return "unverified";
}

/** Does a sender row exist at all for this owner's domain? */
export function hasSenderRows(senderRows: BusinessSenderRecord[] = []): boolean {
  return senderRows.length > 0;
}

/**
 * Resolves the authoritative per-business sender.
 *
 * The ONLY way off the Voom-managed identity is a provider-verified business
 * address (`status === "verified"`). Every other state — including "pending",
 * a business address with no stored rows, or an invalid address — fails safe to
 * the Voom-managed identity with the business's display name preserved.
 */
export function resolveSenderIdentity(
  input: SenderResolveInput,
  config: { fromName: string; fromAddress: string } | null,
): ResolvedSender {
  const displayName = businessDisplayName(input.businessName);
  const status = businessIdentityStatus(input.senderAddress, input.senderRows);
  const address = isValidSenderAddress(input.senderAddress)
    ? input.senderAddress!.trim().toLowerCase()
    : null;

  const fallbackReasons: string[] = [];
  const managedAddress = config?.fromAddress ?? null;
  const managedName = config?.fromName ?? null;

  // The business identity may only be the from-address when verified.
  if (status === "verified" && address) {
    const fromName = cleanName(input.senderName, displayName);
    const replyTo = normalizedReplyTo(input.replyTo);
    return {
      fromName,
      fromAddress: address,
      onBusinessIdentity: true,
      replyTo,
      verificationStatus: "verified",
      fallbackReasons,
      display: `${fromName} <${address}>`,
    };
  }

  // Fail safe: Voom-managed sending identity, business name preserved.
  if (!address) {
    fallbackReasons.push("No business sending address is configured");
  } else if (status === "not_configured" || status === "unverified") {
    fallbackReasons.push("The business sending domain is not provider-verified");
  } else if (status === "pending") {
    fallbackReasons.push("The business sending domain is still pending verification");
  } else if (status === "failed") {
    fallbackReasons.push("The business sending domain failed verification");
  } else {
    fallbackReasons.push("The business identity could not be used safely");
  }

  // The business's display name is preserved wherever the provider permits it
  // (a from-name is free-form; only the from-ADDRESS is the identity that can
  // be spoofed). So the recipient still experiences the business as the sender
  // even while the envelope rides on the Voom-managed, provider-verified domain.
  const fallbackAddress = managedAddress || "sender@resend.dev";
  const fallbackName = displayName;

  if (!managedAddress) {
    fallbackReasons.push("No Voom-managed sending address is configured");
  }

  void managedName;

  return {
    fromName: fallbackName,
    fromAddress: fallbackAddress,
    onBusinessIdentity: false,
    replyTo: normalizedReplyTo(input.replyTo),
    verificationStatus: status,
    fallbackReasons: fallbackReasons.slice(0, 4),
    display: `${fallbackName} <${fallbackAddress}>`,
  };
}

/** The Voom-managed identity from env, or null when not configured. */
export function managedSenderConfig(env: NodeJS.ProcessEnv = process.env): {
  fromName: string;
  fromAddress: string;
} | null {
  const config = readResendConfig(env);
  if (!config) {
    // The send fields alone may exist even when the webhook secret does not.
    const name = (env.EMAIL_FROM_NAME ?? "").trim();
    const address = (env.EMAIL_FROM_ADDRESS ?? "").trim();
    if (name && isValidSenderAddress(address)) return { fromName: name, fromAddress: address };
    return null;
  }
  return { fromName: config.fromName, fromAddress: config.fromAddress };
}

function normalizedReplyTo(value: string | null | undefined): string | null {
  if (!value) return null;
  const address = String(value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && address.length <= 320 ? address : null;
}

/**
 * Preserves the business display name in a provider-safe way: for a Voom-managed
 * identity the from-name is the Voom account name (config), while the business
 * name can be carried in a reply/signature context rather than spoofing "from".
 * Returned for the UI to explain truthfully.
 */
export function senderVerificationLabel(status: SenderVerificationStatus): string {
  switch (status) {
    case "verified": return "Verified";
    case "pending": return "Pending";
    case "failed": return "Failed";
    case "unverified": return "Unverified";
    case "not_configured": return "Not configured";
  }
}
