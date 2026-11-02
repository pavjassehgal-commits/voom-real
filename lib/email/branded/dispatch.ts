/**
 * Branded Email Engine — the shared send path.
 *
 * ONE preparation pipeline and ONE provider dispatch for every marketing
 * email in Voom. Campaign sends and lifecycle flow sends both funnel through
 * `prepareBrandedSend` + `dispatchBrandedEmail` — there is no second email
 * stack, no second renderer and no second sender resolver.
 *
 *   business brand + assets
 *   + sender identity (provider-backed verification)
 *   + email objective/content
 *   → validated design spec (deterministic compiler or MARA proposal)
 *   → deterministic renderer (HTML + plain text)
 *   → quality guard (fail closed)
 *   → provider dispatch (idempotent)
 *
 * The provider call records ACCEPTED, never delivered — the webhook is the
 * only delivery evidence, exactly as before this engine existed.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResendApiClient, ResendConfig } from "@/lib/email/core";
import type { EmailDeliveryProvider } from "@/lib/email/provider";
import { createResendDeliveryProvider } from "@/lib/email/providers/resend";
import { resolveSiteUrl } from "@/utils/site-url";
import { loadEmailBrandProfile } from "./brand";
import {
  acceptProposedDesign,
  compileEmailDesign,
  type CompileEmailDesignInput,
  type CompiledEmailDesign,
  type EmailAssetRef,
  type EmailDesignSpec,
} from "./design";
import { getProviderDomainStatuses, loadEmailIdentity, type ProviderDomainOptions } from "./identity";
import { runEmailQualityChecks, type QualityFailure, type QualityResult } from "./quality";
import { renderEmail } from "./renderer";
import { isUnsubscribeMintingConfigured, mintUnsubscribeToken, unsubscribeUrl } from "./unsubscribe";
import { domainOf } from "./identity";
import { dispatchSafeMarketingEmail } from "../marketing-safety";
import { createAdminClient } from "@/utils/supabase/admin";

export interface BrandedSendDeps extends ProviderDomainOptions {
  admin?: SupabaseClient;
  /** Provider test seam. Production uses the configured Resend client. */
  client?: ResendApiClient | null;
  /** Provider-neutral test seam. Takes precedence over the legacy client. */
  provider?: EmailDeliveryProvider | null;
  /** Override the site URL for unsubscribe links (preview surfaces). */
  siteUrl?: string | null;
}

/**
 * The ONLY destinations a CTA may claim, per the brief:
 *   - the business's configured website (brand profile),
 *   - the explicitly configured destination for THIS send (the campaign's
 *     cta_url / the flow step's saved, owner-approved cta_url).
 * Anything else — including anything a model invents — is refused. Invalid
 * URLs never make the list.
 */
function allowedCtaUrls(website: string | null, explicit: string | null | undefined): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of [website, explicit ?? null]) {
    const value = (candidate ?? "").trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const key = url.toString().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url.toString());
    } catch {
      // Not a URL — never allowlisted.
    }
  }
  return urls;
}

export interface PrepareBrandedSendInput {
  admin: SupabaseClient;
  ownerId: string;
  /** Raw recipient address. */
  to: string;
  /** Stable per-send idempotency key (the claim's own key). */
  idempotencyKey: string;
  subject: string;
  previewText?: string | null;
  body: string;
  cta: string;
  ctaUrl?: string | null;
  flowType?: "welcome" | "re_engagement" | null;
  campaignObjective?: string | null;
  campaignName?: string | null;
  /** Contact first name, or null. */
  firstName?: string | null;
  /** An optional MARA-proposed design; validated and refused on any issue. */
  proposedDesign?: unknown;
  sourceKind?: "campaign" | "flow";
  sourceId?: string;
}

export interface BrandedSendPayload {
  ownerId: string;
  sourceKind?: "campaign" | "flow";
  sourceId?: string;
  to: string;
  from: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  subject: string;
  preheader: string;
  html: string;
  text: string;
  idempotencyKey: string;
  unsubscribeUrl: string;
  oneClickUnsubscribeUrl: string;
  design: EmailDesignSpec;
  layoutReason: string;
  designSource: "compiled" | "proposed";
  senderMode: "business_verified" | "voom_fallback";
}

export type PrepareBrandedSendResult =
  | { ok: true; payload: BrandedSendPayload }
  | {
      ok: false;
      code: string;
      message: string;
      /** Present when the quality guard found specific problems. */
      qualityFailures?: QualityFailure[];
      /** True when the failure will not change on retry (do not reschedule). */
      terminal: boolean;
    };

/**
 * Previews use the EXACT same pipeline as sends — same resolver, same
 * compiler, same renderer, same quality guard — but stop before the provider:
 * no send, no side effects. When a check that would block a real send is
 * failing, the preview still renders (so the owner can see the design) and
 * reports the exact guard failures.
 */
export interface EmailPreview {
  sender: {
    fromName: string;
    fromAddress: string;
    replyTo: string | null;
    mode: "business_verified" | "voom_fallback";
  } | null;
  verification: {
    status: "not_configured" | "pending" | "verified" | "failed" | "unknown";
    domain: string | null;
    providerConfigured: boolean;
  };
  subject: string;
  preheader: string;
  html: string;
  text: string;
  layout: EmailDesignSpec["layout"];
  layoutReason: string;
  designSource: "compiled" | "proposed";
  quality: QualityResult;
}

export interface EmailPreviewInput {
  subject: string;
  previewText?: string | null;
  body: string;
  cta: string;
  ctaUrl?: string | null;
  flowType?: "welcome" | "re_engagement" | null;
  campaignObjective?: string | null;
  campaignName?: string | null;
  /** Who the preview is addressed to (shown as the recipient). */
  recipientEmail?: string | null;
  /** Personalization: a real first name when the owner wants to see one. */
  firstName?: string | null;
  proposedDesign?: unknown;
}

export async function prepareEmailPreview(
  admin: SupabaseClient,
  ownerId: string,
  input: EmailPreviewInput,
  deps: BrandedSendDeps = {},
): Promise<EmailPreview> {
  const { readBusinessSender } = await import("./identity");

  const senderRead = await readBusinessSender(admin, ownerId, deps);
  const brand = await loadEmailBrandProfile(admin, ownerId);
  if (senderRead.identity?.legal_name && senderRead.identity.postal_address) {
    brand.footerLine = [senderRead.identity.legal_name, senderRead.identity.postal_address, senderRead.sender?.replyTo, brand.footerLine].filter(Boolean).join(" · ");
  }
  const to = input.recipientEmail ?? "preview@yourbusiness.example";

  const compiled = compileOrPropose({
    subject: input.subject,
    previewText: input.previewText,
    body: input.body,
    cta: input.cta,
    ctaUrl: input.ctaUrl,
    allowedUrls: allowedCtaUrls(brand.website, input.ctaUrl),
    assets: brand.assets as EmailAssetRef[],
    flowType: input.flowType ?? null,
    campaignObjective: input.campaignObjective ?? null,
    campaignName: input.campaignName ?? null,
    brandName: brand.name,
    tone: brand.tone,
    proposedDesign: input.proposedDesign,
  });
  const design = compiled.design;

  const sender = senderRead.sender
    ? {
        fromName: senderRead.sender.fromName,
        fromAddress: senderRead.sender.fromAddress,
        replyTo: senderRead.sender.replyTo,
        mode: senderRead.sender.mode,
      }
    : { fromName: brand.name, fromAddress: "not-configured@yourdomain.example", replyTo: null, mode: "voom_fallback" as const };

  // A real, working token for the preview recipient — the same link a real
  // send would carry for that address.
  const token = isUnsubscribeMintingConfigured() ? mintUnsubscribeToken(ownerId, to) : "unconfigured";
  const unsubscribeLink = isUnsubscribeMintingConfigured()
    ? unsubscribeUrl(deps.siteUrl ? new URL(deps.siteUrl) : resolveSiteUrl(null), token)
    : "https://example.invalid/unsubscribe?token=unconfigured";

  const rendered = renderEmail({
    design,
    brand: toRenderBrand(brand),
    identity: sender,
    unsubscribe: { url: unsubscribeLink, reason: whyTheyGetIt(brand.name) },
    assets: brand.assets as EmailAssetRef[],
    personalization: { firstName: input.firstName ?? null, businessName: brand.name },
  });

  const referenced = [design.heroAssetId].filter((id): id is string => Boolean(id));
  const quality = runEmailQualityChecks({
    sender: senderRead.sender ?? { fromName: sender.fromName, fromAddress: sender.fromAddress, replyTo: null },
    subject: rendered.subject,
    design,
    html: rendered.html,
    text: rendered.text,
    unsubscribeUrl: isUnsubscribeMintingConfigured() ? unsubscribeLink : null,
    referencedAssetIds: referenced,
    resolvedAssetIds: brand.assets.map((asset) => asset.assetId),
  });
  if (senderRead.sender?.mode !== "business_verified") quality.failures.push({ code: "sender_domain_not_verified", message: "Verify your business's own sending domain before sending marketing email." });
  if (!senderRead.identity?.legal_name || !senderRead.identity.postal_address || !senderRead.sender?.replyTo) quality.failures.push({ code: "sender_information_required", message: "Add your legal/business name, postal address and contact reply email." });
  quality.ok = quality.failures.length === 0;

  return {
    sender,
    verification: senderRead.verification,
    subject: rendered.subject,
    preheader: rendered.preheader,
    html: rendered.html,
    text: rendered.text,
    layout: design.layout,
    layoutReason: compiled.layoutReason,
    designSource: compiled.source,
    quality,
  };
}

function compileOrPropose(
  input: CompileEmailDesignInput & { proposedDesign?: unknown },
): CompiledEmailDesign {
  if (input.proposedDesign) {
    const proposed = acceptProposedDesign(input.proposedDesign, input);
    if (proposed) return { design: proposed, layoutReason: "MARA's validated design", source: "proposed" };
  }
  return compileEmailDesign(input);
}

/**
 * The full send preparation. Returns a ready payload or a stable failure the
 * caller records (quality failures are terminal — retrying a malformed email
 * produces the same malformed email).
 */
export async function prepareBrandedSend(
  input: PrepareBrandedSendInput,
  deps: BrandedSendDeps = {},
): Promise<PrepareBrandedSendResult> {
  const { admin, ownerId } = input;

  // 1) Sender identity — provider-backed verification, fail-safe fallback.
  const { readBusinessSender } = await import("./identity");
  const senderRead = await readBusinessSender(admin, ownerId, {
    client: deps.client ?? null,
    providerDomains: deps.providerDomains ?? undefined,
    txt: deps.txt,
  });
  if (!senderRead.sender) {
    return { ok: false, code: "sender_unresolvable", message: "No sending identity is configured on the server.", terminal: true };
  }
  if (senderRead.sender.mode !== "business_verified") {
    return { ok: false, code: "sender_domain_not_verified", message: "Verify a sending domain owned by your business before sending marketing email.", terminal: true };
  }
  if (!senderRead.identity?.legal_name?.trim() || !senderRead.identity?.postal_address?.trim() || !senderRead.sender.replyTo) {
    return { ok: false, code: "sender_information_required", message: "Add your real legal/business name, postal address and contact reply email before sending.", terminal: true };
  }

  // 2) Brand profile + assets.
  const brand = await loadEmailBrandProfile(admin, ownerId);
  brand.footerLine = [senderRead.identity.legal_name, senderRead.identity.postal_address, senderRead.sender.replyTo, brand.footerLine].filter(Boolean).join(" · ");

  // 3) Design: MARA's validated proposal, or the deterministic compiler.
  const compileInput = {
    subject: input.subject,
    previewText: input.previewText,
    body: input.body,
    cta: input.cta,
    ctaUrl: input.ctaUrl,
    allowedUrls: allowedCtaUrls(brand.website, input.ctaUrl),
    assets: brand.assets as EmailAssetRef[],
    flowType: input.flowType ?? null,
    campaignObjective: input.campaignObjective ?? null,
    campaignName: input.campaignName ?? null,
    brandName: brand.name,
    tone: brand.tone,
  };
  let compiled: CompiledEmailDesign;
  if (input.proposedDesign) {
    const proposed = acceptProposedDesign(input.proposedDesign, compileInput);
    if (proposed) compiled = { design: proposed, layoutReason: "MARA's validated design", source: "proposed" };
    else compiled = compileEmailDesign(compileInput);
  } else {
    compiled = compileEmailDesign(compileInput);
  }
  const design = compiled.design;

  // 4) The real unsubscribe link for THIS recipient.
  if (!isUnsubscribeMintingConfigured()) {
    return { ok: false, code: "unsubscribe_unavailable", message: "Unsubscribe links are not configured on the server, so no marketing email is sent.", terminal: true };
  }
  const token = mintUnsubscribeToken(ownerId, input.to);
  const unsubscribeLink = unsubscribeUrl(deps.siteUrl ? new URL(deps.siteUrl) : resolveSiteUrl(null), token);
  const oneClickLink = new URL(unsubscribeLink);
  oneClickLink.pathname = "/api/unsubscribe";

  // 5) Render — the same deterministic renderer the preview uses.
  const rendered = renderEmail({
    design,
    brand: toRenderBrand(brand),
    identity: senderRead.sender,
    unsubscribe: { url: unsubscribeLink, reason: whyTheyGetIt(brand.name) },
    assets: brand.assets as EmailAssetRef[],
    personalization: { firstName: input.firstName ?? null, businessName: brand.name },
  });

  // 6) Quality guard — fail closed.
  const referenced = [design.heroAssetId, ...design.sections.map(() => null)].filter((id): id is string => Boolean(id));
  const quality = runEmailQualityChecks({
    sender: senderRead.sender,
    subject: rendered.subject,
    design,
    html: rendered.html,
    text: rendered.text,
    unsubscribeUrl: unsubscribeLink,
    referencedAssetIds: referenced,
    resolvedAssetIds: brand.assets.map((asset) => asset.assetId),
  });
  if (!quality.ok) {
    return {
      ok: false,
      code: "email_quality_guard",
      message: quality.failures.map((failure) => failure.message).join(" "),
      qualityFailures: quality.failures,
      terminal: true,
    };
  }

  return {
    ok: true,
    payload: {
      ownerId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      to: input.to,
      from: senderRead.sender.from,
      fromName: senderRead.sender.fromName,
      fromAddress: senderRead.sender.fromAddress,
      replyTo: senderRead.sender.replyTo,
      subject: rendered.subject,
      preheader: rendered.preheader,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: input.idempotencyKey,
      unsubscribeUrl: unsubscribeLink,
      oneClickUnsubscribeUrl: oneClickLink.toString(),
      design,
      layoutReason: compiled.layoutReason,
      designSource: compiled.source,
      senderMode: senderRead.sender.mode,
    },
  };
}

function toRenderBrand(brand: Awaited<ReturnType<typeof loadEmailBrandProfile>>) {
  return {
    name: brand.name,
    description: brand.description,
    website: brand.website,
    logoUrl: brand.logo?.url ?? null,
    logoAlt: brand.logo ? `${brand.name} logo` : null,
    primaryColor: brand.primaryColor,
    secondaryColor: brand.secondaryColor,
    footerLine: brand.footerLine,
    industry: brand.industry,
  };
}

function whyTheyGetIt(brandName: string): string {
  return `You're receiving this because you subscribed to email updates from ${brandName || "this business"}.`;
}

/**
 * The single provider dispatch. Acceptance is returned; delivery is the
 * webhook's job, unchanged.
 */
export async function dispatchBrandedEmail(
  payload: BrandedSendPayload,
  deps: BrandedSendDeps = {},
): Promise<{
  ok: boolean;
  providerMessageId: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  errorKind: "configuration" | "rejected" | "ambiguous" | "network" | null;
  errorMessage: string | null;
  ambiguous: boolean;
}> {
  const provider = deps.provider ?? createResendDeliveryProvider(deps.client ?? undefined);
  return dispatchSafeMarketingEmail(deps.admin ?? createAdminClient(), payload, provider);
}

// Re-exported for callers that only need the resolver pieces.
export { loadEmailIdentity, getProviderDomainStatuses, domainOf };
export type { ResendConfig };
