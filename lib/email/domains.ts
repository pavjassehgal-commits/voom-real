import "server-only";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { domainToASCII } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResendApiClient } from "./core";

export interface EmailDomainClaim {
  domain: string; owner_user_id: string; business_id: string; challenge: string;
  provider_domain_id: string | null; dns_verified_at: string | null; provider_verified_at: string | null;
}
export interface DomainDeps {
  client: ResendApiClient;
  txt?: (name: string) => Promise<string[][]>;
}
export const ownershipName = (domain: string) => `_voom-email.${domain}`;
export const ownershipValue = (claim: EmailDomainClaim) => `voom-email=${claim.challenge}`;

export function normalizeSendingDomain(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("invalid_sending_domain");
  if (/[\s/@:\\?#]/.test(value.trim())) throw new Error("invalid_sending_domain");
  const domain = domainToASCII(value.trim().toLowerCase());
  if (domain.length > 253 || !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error("invalid_sending_domain");
  const managed = process.env.EMAIL_FROM_ADDRESS?.split("@")[1]?.toLowerCase();
  if (managed && (domain === managed || domain.endsWith(`.${managed}`) || managed.endsWith(`.${domain}`))) throw new Error("managed_domain_reserved");
  return domain;
}

async function resolveTxtBounded(name: string) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  return resolver.resolveTxt(name);
}

export async function hasOwnershipProof(claim: EmailDomainClaim, txt = resolveTxtBounded): Promise<boolean> {
  try { return (await txt(ownershipName(claim.domain))).some(parts => parts.join("") === ownershipValue(claim)); }
  catch { return false; }
}

export async function readDomainClaim(db: SupabaseClient, owner: string, domain: string): Promise<EmailDomainClaim | null> {
  const { data, error } = await db.from("voom_email_domains").select("*").eq("owner_user_id", owner).eq("domain", domain).maybeSingle();
  if (error) throw new Error("domain_registry_unavailable");
  return data as EmailDomainClaim | null;
}

export async function beginDomainClaim(db: SupabaseClient, owner: string, input: string) {
  const domain = normalizeSendingDomain(input);
  const result = await db.rpc("claim_marketing_email_domain", { p_owner: owner, p_domain: domain, p_challenge: randomBytes(32).toString("hex") });
  if (result.error || !result.data) throw new Error("domain_unavailable");
  return result.data as EmailDomainClaim;
}

type ProviderDomain = { id: string; name: string; status: string; records?: unknown[]; capabilities?: { sending?: string } };
async function getDomain(client: ResendApiClient, id: string): Promise<ProviderDomain> {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) throw new Error("invalid_provider_domain");
  const response = await client.request("GET", `domains/${id}`);
  if (!response.ok) throw new Error("domain_provider_unavailable");
  return await response.json() as ProviderDomain;
}

/** Checks used at send time. A global provider domain list can NEVER
 * confer authorization. Owner's registry row + current DNS + provider ID/name
 * must all match. Provider/DNS errors mean not verified, never managed fallback. */
export async function checkOwnedDomain(db: SupabaseClient, owner: string, domain: string, deps: DomainDeps) {
  const claim = await readDomainClaim(db, owner, domain);
  if (!claim?.provider_domain_id || !claim.dns_verified_at || !claim.provider_verified_at || !(await hasOwnershipProof(claim, deps.txt))) return false;
  const remote = await getDomain(deps.client, claim.provider_domain_id);
  const verified = remote.name === domain && remote.id === claim.provider_domain_id && remote.status === "verified" && remote.capabilities?.sending !== "disabled";
  if (verified) {
    const now = new Date().toISOString();
    const refreshed = await db.from("voom_email_domains").update({ dns_verified_at: now, provider_verified_at: now }).eq("owner_user_id", owner).eq("domain", domain);
    if (refreshed.error) throw new Error("domain_registry_unavailable");
  }
  return verified;
}

/** Explicit owner action, not called by sends/previews. No remote domain is
 * created or adopted until this owner's independent DNS challenge is proven. */
export async function verifyDomainClaim(db: SupabaseClient, owner: string, input: string, deps: DomainDeps) {
  const domain = normalizeSendingDomain(input);
  const claim = await readDomainClaim(db, owner, domain);
  if (!claim || !(await hasOwnershipProof(claim, deps.txt))) throw new Error("dns_ownership_not_verified");
  let providerId = claim.provider_domain_id;
  if (!providerId) {
    // Check all pages before creating; an uncertain creation is never blindly retried.
    let after = "";
    for (let page = 0; page < 20; page++) {
      const response = await deps.client.request("GET", `domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      if (!response.ok) throw new Error("domain_provider_unavailable");
      const body = await response.json() as { data?: ProviderDomain[]; has_more?: boolean };
      providerId = body.data?.find(d => d.name === domain)?.id ?? null;
      if (providerId || !body.has_more) break;
      after = body.data?.at(-1)?.id ?? "";
      if (!after || page === 19) throw new Error("domain_inventory_incomplete");
    }
    if (!providerId) {
      const response = await deps.client.request("POST", "domains", { name: domain });
      if (!response.ok) throw new Error("domain_setup_not_completed");
      const created = await response.json() as ProviderDomain;
      if (created.name !== domain || !created.id) throw new Error("domain_setup_uncertain");
      providerId = created.id;
    }
  }
  // Persist the ID before verification, making subsequent owner retries recoverable.
  const saved = await db.rpc("bind_marketing_email_domain", { p_owner: owner, p_domain: domain, p_provider: providerId, p_verified: false });
  if (saved.error) throw new Error("domain_registry_unavailable");
  const remote = await getDomain(deps.client, providerId);
  if (remote.name !== domain || remote.id !== providerId) throw new Error("domain_identity_mismatch");
  if (remote.status !== "verified") {
    const response = await deps.client.request("POST", `domains/${providerId}/verify`);
    if (!response.ok) throw new Error("domain_verification_pending");
  }
  const updated = await db.from("voom_email_domains").update({ provider_verified_at: remote.status === "verified" ? new Date().toISOString() : null }).eq("owner_user_id", owner).eq("domain", domain);
  if (updated.error) throw new Error("domain_registry_unavailable");
  return { verified: remote.status === "verified", records: remote.records ?? [] };
}
