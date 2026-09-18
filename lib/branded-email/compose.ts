/**
 * Branded Email Engine v1 — shared send composition.
 *
 * Campaigns and Email Automation build their final message through exactly this
 * path: stored content → derived/validated design → resolved destination →
 * deterministic renderer → quality guard. Explorer never forks the pipeline,
 * so "the same renderer + sender identity system" is a fact, not a claim.
 *
 * Pure: no I/O, no server-only import, no provider client. It returns either a
 * ready-to-send envelope or the blockers the sender must surface as
 * needs-attention. When it returns blockers, the caller MUST NOT send.
 */

import type { EmailBrandProfile } from "./brand-profile";
import { deriveEmailDesign } from "./derive";
import type { EmailLayoutId } from "./design";
import { resolveCtaDestination } from "./destinations";
import { evaluateEmailQualityGuard, type EmailQualityBlocker } from "./quality-guard";
import { renderEmail } from "./render";
import type { ResolvedSender } from "./sender";

export interface ComposeEmailInput {
  recipientEmail: string;
  firstName: string | null;
  subject: string;
  previewText: string;
  body: string;
  cta: string | null;
  /** Raw candidate destination; only a validated URL is ever rendered. */
  ctaUrl: string | null;
  brand: EmailBrandProfile;
  sender: ResolvedSender | null;
  unsubscribeUrl: string | null;
  /** Transactional (optomechanical) sends may omit an unsubscribe link. */
  marketing: boolean;
  /** Resolved hero image or null (brand text/logo design instead). */
  hero?: { url: string; alt: string; mimeType: string } | null;
  /** True when the design references a hero asset that must be present. */
  heroAssetExpected?: boolean;
  layout?: EmailLayoutId | null;
  kind?: string | null;
  position?: number | null;
}

export type ComposeEmailResult =
  | { ok: true; subject: string; html: string; text: string; preheader: string }
  | { ok: false; blockers: EmailQualityBlocker[]; needsAttentionMessage: string | null };

/** Composes (never sends) the final email for a campaign or flow send. */
export function composeEmail(input: ComposeEmailInput): ComposeEmailResult {
  const design = deriveEmailDesign({
    subject: input.subject,
    preheader: input.previewText,
    body: input.body,
    cta: input.cta,
    ctaUrl: input.ctaUrl,
    layout: input.layout,
    position: input.position,
    kind: input.kind,
  });

  // The destination is resolved by the ONE destination authority: only a
  // validated URL (business website or the supplied destination) renders.
  const destination = resolveCtaDestination({
    website: input.brand.website,
    siteUrl: null,
    campaignDestination: input.ctaUrl,
    allowedUrls: input.ctaUrl ? [input.ctaUrl] : [],
  });

  const cta = design.cta && destination.ctaUrl
    ? { label: design.cta.label, url: destination.ctaUrl }
    : null;

  const rendered = renderEmail({
    design,
    brand: input.brand,
    cta,
    hero: input.hero ?? null,
    personalization: {
      firstName: input.firstName,
      recipientEmail: input.recipientEmail,
    },
    unsubscribeUrl: input.unsubscribeUrl,
    unsubscribeText: unsubscribeSentence(input.brand.name),
    subject: input.subject,
  });

  const guard = evaluateEmailQualityGuard({
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    sender: input.sender
      ? { fromName: input.sender.fromName, fromAddress: input.sender.fromAddress }
      : null,
    marketing: input.marketing,
    unsubscribeUrl: input.unsubscribeUrl,
    ctaUrl: cta?.url ?? null,
    hero: input.hero
      ? { url: input.hero.url, mimeType: input.hero.mimeType, alt: input.hero.alt ?? null }
      : null,
    heroAssetExpected: input.heroAssetExpected ?? false,
  });

  if (!guard.ok) {
    return { ok: false, blockers: guard.blockers, needsAttentionMessage: guard.needsAttentionMessage };
  }

  return {
    ok: true,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    preheader: rendered.preheader,
  };
}

function unsubscribeSentence(brandName: string): string {
  return `You are receiving this because you subscribed to email from ${brandName}. Unsubscribe at any time:`;
}
