/**
 * Branded Email Engine — per-business sender identity.
 *
 * The recipient experiences the BUSINESS, not Voom. This module decides, for
 * every send, exactly what the inbox shows:
 *
 *   From display name   the business name (or the name the owner configured)
 *   From address        the business address — but ONLY when the provider
 *                       confirms that domain is verified on the Resend
 *                       account. Otherwise the approved Voom-managed sending
 *                       identity (the existing EMAIL_FROM_ADDRESS) is used.
 *   Reply-To            the business's configured reply address, when set.
 *
 * Anti-spoofing is the whole point: a business can type "ceo@nike.com" into
 * the settings, but that address is never used as a From address. It is only
 * ever sent when `getProviderDomainStatuses()` — a live read of the provider's
 * own domains API — says the domain is verified. If the provider is
 * unreachable, every domain is treated as unverified and the safe fallback is
 * used. Voom never claims a domain is verified unless provider-backed state
 * confirms it, at resolve time.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResendApiClient, ResendConfig } from "@/lib/email/core";
import type { EmailIdentityRow, ProviderDomainMap, ProviderDomainStatus } from "./types";

export interface ResolvedSenderIdentity {
  /** Display name for the inbox. Always the business's name when available. */
  fromName: string;
  /** The actual sending address. */
  fromAddress: string;
  /** The `From` header value for the provider. */
  from: string;
  replyTo: string | null;
  /** Which identity was used — drives the settings UI and audit trails. */
  mode: "business_verified" | "voom_fallback";
  /** The domain of the From address. */
  domain: string;
}

export interface ResolveBusinessSenderInput {
  /** The Voom-managed sending identity (existing global Resend config). */
  config: ResendConfig;
  /** The business's stored identity row, or null when nothing is configured. */
  identity: EmailIdentityRow | null;
  /** The business display name from `businesses`. */
  brandName: string;
  /** Live provider state for each domain. Absent = unknown to the provider. */
  providerDomains: ProviderDomainMap;
}

/**
 * The single decision point for every marketing send. Deterministic:
 * the same inputs always produce the same From.
 *
 * Rules:
 *   1. The business address is used ONLY when the provider has verified that
 *      domain — provider-backed state, checked live (see
 *      getProviderDomainStatuses). The stored verification_status column is a
 *      UI hint and is deliberately NOT consulted here.
 *   2. Otherwise the approved Voom-managed address is used, with the
 *      business display name kept as the From name (safe, honest, and still
 *      "the business" in the inbox).
 *   3. Reply-To is the business's configured reply address, validated
 *      server-side; it is never a From address.
 */
export function resolveBusinessSender(input: ResolveBusinessSenderInput): ResolvedSenderIdentity {
  const { config, identity, brandName, providerDomains } = input;
  const displayName = (identity?.display_name ?? "").trim() || brandName.trim() || config.fromName;

  const requested = (identity?.from_address ?? "").trim().toLowerCase();
  const requestedDomain = requested.includes("@") ? requested.slice(requested.indexOf("@") + 1) : "";
  const verified = requested !== "" && requestedDomain !== "" && providerDomains.get(requestedDomain) === "verified";

  const replyTo = validateReplyTo(identity?.reply_to);

  if (verified) {
    return {
      fromName: displayName,
      fromAddress: requested,
      from: `${displayName} <${requested}>`,
      replyTo,
      mode: "business_verified",
      domain: requestedDomain,
    };
  }

  return {
    fromName: displayName,
    fromAddress: config.fromAddress,
    from: `${displayName} <${config.fromAddress}>`,
    replyTo,
    mode: "voom_fallback",
    domain: domainOf(config.fromAddress),
  };
}

function validateReplyTo(candidate: string | null | undefined): string | null {
  const value = (candidate ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value.length > 320) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return null;
  return value;
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

// ─── Provider-backed verification state ──────────────────────────────────────

export interface ProviderDomainsResult {
  /** domain (lowercase) → status, from the provider's own records. */
  domains: ProviderDomainMap;
  /** The provider answered; an empty map means no domains are known. */
  ok: boolean;
  reason?: string;
}

/**
 * Test/dependency seam: when `providerDomains` is supplied (a Map, including
 * an empty one) it is used verbatim and NO provider network call is made.
 * `null`/`undefined` means "ask the provider live".
 */
export interface ProviderDomainOptions {
  providerDomains?: ProviderDomainMap | null;
  client?: ResendApiClient | null;
}

/**
 * Reads the provider's verified/pending/failing domains, LIVE.
 *
 * This is the only source that can make a domain "verified". The Resend
 * domains endpoint returns each domain with a `status` of `pending`,
 * `verified` or `failing`; anything else is dropped. A failed or missing
 * provider call returns { ok: false } and the caller must treat every domain
 * as unverified (fail-safe), never as verified.
 */
export async function getProviderDomainStatuses(
  options: ProviderDomainOptions = {},
): Promise<ProviderDomainsResult> {
  if (options.providerDomains) {
    return { domains: options.providerDomains, ok: true };
  }
  try {
    const api = options.client ?? (await import("@/lib/email/client")).createResendClient();
    if (typeof api.request !== "function") {
      // A client without a request surface (e.g. an old test double) can be
      // asked nothing — fail safe, never claim verification.
      return { domains: new Map(), ok: false, reason: "provider_unavailable" };
    }
    const response = await api.request("GET", "domains");
    if (!response.ok) {
      return { domains: new Map(), ok: false, reason: `HTTP_${response.status}` };
    }
    const body = (await response.json()) as { data?: Array<{ name?: string; status?: string }> };
    const map: ProviderDomainMap = new Map();
    for (const entry of body.data ?? []) {
      const name = (entry.name ?? "").trim().toLowerCase();
      const status = entry.status;
      if (!name) continue;
      if (status === "verified" || status === "pending" || status === "failing") {
        map.set(name, status as ProviderDomainStatus);
      }
    }
    return { domains: map, ok: true };
  } catch {
    return { domains: new Map(), ok: false, reason: "provider_unavailable" };
  }
}

// ─── Database reads ──────────────────────────────────────────────────────────

/** The owner's stored sender identity, or null. Never throws for absence. */
export async function loadEmailIdentity(
  db: SupabaseClient,
  ownerId: string,
): Promise<EmailIdentityRow | null> {
  const { data, error } = await db.from("voom_email_identities")
    .select("id,owner_user_id,business_id,display_name,from_address,reply_to,verification_status,last_checked_at,created_at,updated_at")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  if (error) return null;
  return (data as unknown as EmailIdentityRow | null) ?? null;
}

export interface BusinessSenderRead {
  identity: EmailIdentityRow | null;
  /**
   * Null only when the global Voom-managed sending identity itself is missing
   * (EMAIL_FROM_ADDRESS unset) — the send path already fails closed in that
   * case, and the UI shows "not configured".
   */
  sender: ResolvedSenderIdentity | null;
  /** Live provider status of the requested domain, for truthful UI. */
  verification: {
    status: "not_configured" | "pending" | "verified" | "failed" | "unknown";
    domain: string | null;
    providerConfigured: boolean;
  };
}

/**
 * Resolves the full sender picture for one owner: stored identity + live
 * provider state + the From decision. This is what the send path and the
 * settings/preview surfaces both use, so what the owner sees is exactly what
 * the recipient will get.
 */
export async function readBusinessSender(
  db: SupabaseClient,
  ownerId: string,
  options: ProviderDomainOptions = {},
): Promise<BusinessSenderRead> {
  const { requireResendConfig } = await import("@/lib/email/config");
  let config: ResendConfig;
  let providerConfigured = false;
  try {
    config = requireResendConfig();
    providerConfigured = true;
  } catch {
    // No global sending identity configured: the send path will fail closed
    // anyway (the engine checks this). The UI shows "not configured".
    config = {
      provider: "resend",
      apiKey: "",
      fromAddress: "",
      fromName: "Voom",
      webhookSecret: "",
      apiBaseUrl: "https://api.resend.com",
    };
  }

  const [identity, businessRow] = await Promise.all([
    loadEmailIdentity(db, ownerId),
    db.from("businesses").select("brand_name").eq("owner_user_id", ownerId).maybeSingle(),
  ]);
  const brandName = String((businessRow as { brand_name?: string | null } | null)?.brand_name ?? "");

  let domains: ProviderDomainMap = new Map();
  if (providerConfigured) {
    const provider = await getProviderDomainStatuses(options);
    if (provider.ok) domains = provider.domains;
  }

  const requested = (identity?.from_address ?? "").trim().toLowerCase();
  const requestedDomain = domainOf(requested);

  let verification: BusinessSenderRead["verification"] = {
    status: "not_configured",
    domain: requestedDomain || null,
    providerConfigured,
  };
  if (requested && providerConfigured) {
    const status = domains.get(requestedDomain);
    verification = {
      status: status === "verified" ? "verified" : status === "pending" ? "pending" : status === "failed" ? "failed" : "unknown",
      domain: requestedDomain,
      providerConfigured,
    };
  } else if (!providerConfigured) {
    verification = { status: "not_configured", domain: requestedDomain || null, providerConfigured: false };
  }

  const sender = config.fromAddress
    ? resolveBusinessSender({ config, identity, brandName, providerDomains: domains })
    : null;

  return { identity, sender, verification };
}
