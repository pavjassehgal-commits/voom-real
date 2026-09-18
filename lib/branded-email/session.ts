/**
 * Branded Email Engine v1 — the per-send email session.
 *
 * Loads everything the shared composer needs for ONE send, exactly once:
 *   - the authoritative brand profile (businesses + profile),
 *   - the resolved per-business sender identity (verified-domain store),
 *   - a real, signed unsubscribe token minted for this owner + recipient
 *     (marketing only; transactional sends omit it).
 *
 * When migration 0041 has not been applied yet (the live production state for
 * this change), every loader degrades gracefully: the brand profile falls back
 * to the business name, the sender falls back to the Voom-managed identity, and
 * the unsubscribe token is minted from the provider secret. The send always
 * composes, never crashes.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readResendConfig } from "@/lib/email/core";
import { resolveSiteUrl } from "@/utils/site-url";
import { loadEmailBrandProfile } from "./brand";
import type { EmailBrandProfile } from "./brand-profile";
import { composeEmail, type ComposeEmailInput } from "./compose";
import { mintUnsubscribeToken } from "./unsubscribe";
import { loadResolvedSender } from "./sender-server";
import type { ResolvedSender } from "./sender";

export interface EmailSessionInput {
  ownerId: string;
  recipientEmail: string;
  firstName: string | null;
  subject: string;
  previewText: string | null;
  body: string;
  cta: string | null;
  ctaUrl: string | null;
  marketing: boolean;
  /** A validated hero image to embed, or null for brand text/logo design. */
  hero?: { url: string; alt: string; mimeType: string } | null;
  heroAssetExpected?: boolean;
  businessName?: string | null;
  /** Campaign-level sender context (validated separately by the campaign layer). */
  senderAddress?: string | null;
  senderName?: string | null;
  replyTo?: string | null;
  layout?: import("./design").EmailLayoutId | null;
  kind?: string | null;
  position?: number | null;
  /** Scope the unsubscribe token to a specific flow/campaign. */
  flowId?: string | null;
  campaignId?: string | null;
  /** The contact row id, when known (flips consent status on opt-out). */
  contactId?: string | null;
}

export interface EmailSessionBrand {
  brand: EmailBrandProfile;
  sender: ResolvedSender;
  unsubscribeUrl: string | null;
}

/** Loads the brand + sender + unsubscribe inputs for one send. */
export async function buildEmailSession(
  db: SupabaseClient,
  input: EmailSessionInput,
): Promise<EmailSessionBrand> {
  const [brand, sender] = await Promise.all([
    loadEmailBrandProfile(db, input.ownerId),
    loadResolvedSender(db, input.ownerId, {
      businessName: input.businessName,
      senderAddress: input.senderAddress,
      senderName: input.senderName,
      replyTo: input.replyTo,
    }),
  ]);

  const unsubscribeUrl = input.marketing
    ? mintUnsubscribeUrl(sender.replyTo ?? sender.fromAddress, input)
    : null;

  return { brand, sender, unsubscribeUrl };
}

/**
 * Mints the real unsubscribe link: `/api/email/unsubscribe?t=<opaque>` on the
 * app's own site URL, signed with the provider webhook secret. When the secret
 * is unavailable the link is null and the quality guard blocks the send (a
 * marketing email without a working link is never shipped).
 */
function mintUnsubscribeUrl(recipientEmail: string, input: EmailSessionInput): string | null {
  const config = readResendConfig();
  if (!config?.webhookSecret) return null;
  const token = mintUnsubscribeToken({
    secret: config.webhookSecret,
    ownerUserId: input.ownerId,
    email: recipientEmail,
    contactId: input.contactId ?? null,
    flowId: input.flowId ?? null,
    campaignId: input.campaignId ?? null,
  });
  if (!token) return null;
  const site = resolveSiteUrl(null);
  return `${site.origin}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
}

/** Composes (never sends) the branded email for a flow/campaign session. */
export async function composeEmailForSession(
  db: SupabaseClient,
  input: EmailSessionInput,
) {
  const session = await buildEmailSession(db, input);
  const composed = composeEmail({
    recipientEmail: input.recipientEmail,
    firstName: input.firstName,
    subject: input.subject,
    previewText: input.previewText ?? "",
    body: input.body,
    cta: input.cta,
    ctaUrl: input.ctaUrl,
    brand: session.brand,
    sender: session.sender,
    unsubscribeUrl: session.unsubscribeUrl,
    marketing: input.marketing,
    hero: input.hero ?? null,
    heroAssetExpected: input.heroAssetExpected ?? false,
    layout: input.layout,
    kind: input.kind,
    position: input.position,
  });

  return { composed, sender: session.sender, unsubscribeUrl: session.unsubscribeUrl };
}

export type { ComposeEmailInput };
