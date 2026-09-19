/**
 * Branded Email Engine — the deterministic HTML + plain-text renderer.
 *
 * One renderer serves every marketing email in Voom: campaign sends and
 * lifecycle flow steps both compile to an `EmailDesignSpec` and render here.
 * There is no second "preview" renderer — the owner preview is exactly this
 * function's output.
 *
 * Email-client constraints honoured:
 *   - table-based structure, no structural CSS floats/flex/grid;
 *   - inline CSS only (one small <style> block for media queries, which
 *     degrades to the 600px desktop layout in clients without support);
 *   - 600px content column, fluid on mobile;
 *   - system font stack only (no web fonts), no JavaScript, no external CSS;
 *   - every <img> has alt text and explicit width handling;
 *   - MSO conditional comments keep Outlook from collapsing key spacing;
 *   - accessible contrast: brand colours are only ever used on surfaces with
 *     a computed readable text colour, body copy sits on white/near-black.
 *
 * The renderer is pure and deterministic: the same inputs always produce the
 * same bytes, so previews and production sends cannot drift apart.
 */

import {
  type EmailAssetRef,
  type EmailDesignSpec,
} from "./design";
import { applyPersonalization, scrubUnresolvedTokens } from "./personalize";

export interface RenderedBrand {
  name: string;
  description?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  logoAlt?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  footerLine?: string | null;
  industry?: string | null;
}

export interface RenderedIdentity {
  /** Display name the recipient's inbox shows. */
  fromName: string;
  fromAddress: string;
  replyTo?: string | null;
}

export interface RenderedSenderBlock {
  senderName: string;
  senderAddress: string;
  replyTo: string | null;
}

export interface RenderedUnsubscribe {
  /** Real, working unsubscribe URL for this recipient. */
  url: string;
  /** Why the recipient gets these emails, in one honest sentence. */
  reason: string;
}

export interface RenderEmailInput {
  design: EmailDesignSpec;
  brand: RenderedBrand;
  identity: RenderedIdentity;
  unsubscribe: RenderedUnsubscribe;
  /** Resolved image assets for any asset ids the design references. */
  assets?: EmailAssetRef[];
  /** Personalization values; missing values fall back to neutral wording. */
  personalization?: { firstName?: string | null; businessName?: string | null };
}

export interface RenderedEmail {
  html: string;
  text: string;
  subject: string;
  preheader: string;
}

const EMAIL_MAX_WIDTH = 600;
const NEUTRAL_PRIMARY = "#18181b";
const BODY_TEXT = "#1f2937";
const MUTED_TEXT = "#5b6472";
const SURFACE_BORDER = "#e5e7eb";
const PAGE_BG = "#f3f4f6";
const FOOTER_BG = "#f9fafb";
const FOOTER_TEXT = "#6b7280";

// ─── Colour safety ───────────────────────────────────────────────────────────

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Validates + normalizes a brand colour. Anything else → null (the renderer
 *  falls back to a neutral palette rather than shipping a broken colour). */
export function safeBrandColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) return null;
  let hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (hex.length === 3) hex = hex.split("").map((char) => char + char).join("");
  return `#${hex.toLowerCase()}`;
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The readable text colour for a brand-coloured surface (white or near-black). */
export function readableTextOn(surface: string): string {
  return relativeLuminance(surface) > 0.45 ? "#111827" : "#ffffff";
}

// ─── Small HTML helpers ──────────────────────────────────────────────────────

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain-text link extraction for alt text and the text alternative. */
function visibleHref(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

interface Palette {
  primary: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
}

function paletteFor(brand: RenderedBrand): Palette {
  const primary = safeBrandColor(brand.primaryColor) ?? NEUTRAL_PRIMARY;
  const secondary = safeBrandColor(brand.secondaryColor);
  const accent = secondary ?? primary;
  return {
    primary,
    onPrimary: readableTextOn(primary),
    accent,
    onAccent: readableTextOn(accent),
  };
}

// ─── HTML renderer ───────────────────────────────────────────────────────────

export function renderEmailHtml(input: RenderEmailInput): string {
  const { design, brand, identity, unsubscribe } = input;
  const personalization = input.personalization ?? {};
  const values = {
    firstName: personalization.firstName ?? null,
    businessName: personalization.businessName ?? brand.name,
  };

  const p = paletteFor(brand);
  const assets = input.assets ?? [];

  const subject = scrubUnresolvedTokens(applyPersonalization(design.subject, values));
  const preheader = scrubUnresolvedTokens(applyPersonalization(design.preheader || (design.sections[0]?.text?.slice(0, 120) ?? ""), values));
  const headline = scrubUnresolvedTokens(applyPersonalization(design.headline, values));
  const greeting = scrubUnresolvedTokens(applyPersonalization(design.greeting, values));
  const sections = design.sections.map((section) => scrubUnresolvedTokens(applyPersonalization(section.text, values)));
  const ctaLabel = scrubUnresolvedTokens(applyPersonalization(design.cta.label, values));

  const hero = design.heroAssetId ? assets.find((asset) => asset.assetId === design.heroAssetId) : null;
  const cta = design.cta.url
    ? ctaButton(design.cta.url, ctaLabel, p)
    : replyAction(ctaLabel);

  const rows = [];
  rows.push(`<tr><td style="padding:24px 28px 0 28px">${logoRow(brand)}</td></tr>`);

  if (hero) {
    rows.push(`<tr><td style="padding:16px 20px 0 20px">${heroImage(hero, headline)}</td></tr>`);
  }

  if (design.layout === "announcement") {
    rows.push(`<tr><td style="padding:16px 20px 0 20px">${heroBand(headline, p, design.layout === "announcement" ? sections[0] : null)}</td></tr>`);
  }

  const bodyFont = design.layout === "minimal" ? "font-size:15px" : "font-size:16px";
  rows.push(`<tr><td style="padding:16px 28px 8px 28px;${bodyFont};line-height:24px;color:${BODY_TEXT}">${esc(greeting)}</td></tr>`);

  // The headline always renders — in the hero band/caption when the layout
  // carries one, otherwise as its own prominent line.
  if (!hero && design.layout !== "announcement") {
    rows.push(`<tr><td style="padding:0 28px;${bodyFont};line-height:26px;font-weight:700;color:${BODY_TEXT}">${esc(headline)}</td></tr>`);
  }

  for (const [index, text] of sections.entries()) {
    if (design.layout === "announcement" && index === 0) continue; // shown in the hero band
    const block = design.layout === "product" && index === 0
      ? featureBlock(text, p)
      : `<p style="margin:0 0 16px 0">${esc(text)}</p>`;
    rows.push(`<tr><td style="padding:0 28px;${bodyFont};line-height:24px;color:${BODY_TEXT}">${block}</td></tr>`);
  }

  rows.push(`<tr><td style="padding:8px 28px 8px 28px">${cta}</td></tr>`);

  rows.push(`<tr><td style="padding:20px 0 0 0">${footer(brand, identity, unsubscribe, p)}</td></tr>`);

  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="X-UA-Compatible" content="IE=edge">`,
    `<meta name="x-apple-disable-message-reformatting">`,
    `<title>${esc(subject)}</title>`,
    `<style type="text/css">`,
    `  @media only screen and (max-width: 620px) {`,
    `    .voom-container { width: 100% !important; }`,
    `    .voom-padding { padding-left: 20px !important; padding-right: 20px !important; }`,
    `  }`,
    `  @media only screen and (max-width: 620px) { table.voom-cta td { padding: 12px 20px !important; } }`,
    `</style>`,
    `</head>`,
    `<body style="margin:0;padding:0;background-color:${PAGE_BG};word-spacing:normal;">`,
    // Hidden preheader: shows in inbox previews, never in the body.
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;" aria-hidden="true">${esc(preheader)}&zwnj;&nbsp;</div>`,
    `<center role="article" aria-roledescription="email" lang="en" style="width:100%;background-color:${PAGE_BG};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" class="voom-container" width="${EMAIL_MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${EMAIL_MAX_WIDTH}px;max-width:${EMAIL_MAX_WIDTH}px;background-color:#ffffff;border-radius:12px;overflow:hidden;">`,
    ...rows.map((row) => `  ${row}`),
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</center>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}

function logoRow(brand: RenderedBrand): string {
  const name = esc(brand.name || "Your business");
  if (brand.logoUrl) {
    return [
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">`,
      `<tr>`,
      `<td style="text-align:center;padding-bottom:4px;">`,
      `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.logoAlt || `${brand.name} logo`)}" width="120" height="44" style="display:block;max-width:140px;height:auto;border:0;">`,
      `</td>`,
      `</tr>`,
      `</table>`,
    ].join("");
  }
  // No logo: a quiet wordmark so the business identity is still present.
  return `<div style="text-align:center;font-size:18px;font-weight:700;letter-spacing:0.2px;color:${BODY_TEXT};padding:4px 0 2px 0;">${name}</div>`;
}

function heroImage(asset: EmailAssetRef, headline: string): string {
  const width = asset.width ?? 1160;
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    `<tr><td style="text-align:center;">`,
    `<img src="${esc(asset.url)}" alt="${esc(asset.altText || headline)}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;">`,
    `</td></tr>`,
    `</table>`,
  ].join("");
}

function heroBand(headline: string, p: Palette, firstSection: string | null): string {
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    `<tr><td align="center" style="background-color:${p.primary};padding:32px 32px;">`,
    `<div style="font-size:24px;line-height:32px;font-weight:700;color:${p.onPrimary};text-align:center;">${esc(headline)}</div>`,
    firstSection ? `<div style="margin-top:10px;font-size:15px;line-height:22px;color:${p.onPrimary};opacity:0.92;text-align:center;">${esc(firstSection)}</div>` : "",
    `</td></tr>`,
    `</table>`,
  ].join("");
}

function featureBlock(text: string, p: Palette): string {
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">`,
    `<tr><td style="background-color:${PAGE_BG};border-left:3px solid ${p.primary};border-radius:6px;padding:16px 18px;">`,
    `<div style="font-size:16px;line-height:24px;color:${BODY_TEXT};font-weight:600;">${esc(text)}</div>`,
    `</td></tr>`,
    `</table>`,
  ].join("");
}

function ctaButton(url: string, label: string, p: Palette): string {
  return [
    `<table role="presentation" class="voom-cta" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:12px auto 4px auto;">`,
    `<tr>`,
    `<td align="center" bgcolor="${p.primary}" style="background-color:${p.primary};border-radius:8px;padding:4px;">`,
    `<a href="${esc(url)}" target="_blank" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;line-height:20px;color:${p.onPrimary};text-decoration:none;border-radius:8px;">${esc(label)}&nbsp;&#8594;</a>`,
    `</td>`,
    `</tr>`,
    `</table>`,
    `<div style="text-align:center;font-size:12px;color:${MUTED_TEXT};padding:0 0 8px 0;">${esc(visibleHref(url))}</div>`,
  ].join("");
}

/** The safe non-link CTA: an action the recipient can take without a URL. */
function replyAction(label: string): string {
  return [
    `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:12px auto 4px auto;max-width:360px;">`,
    `<tr><td align="center" style="border:1px solid ${SURFACE_BORDER};border-radius:8px;padding:14px 24px;">`,
    `<div style="font-size:15px;font-weight:600;line-height:22px;color:${BODY_TEXT};">${esc(label)}</div>`,
    `<div style="font-size:12.5px;line-height:18px;color:${MUTED_TEXT};margin-top:2px;">Just reply to this email — a person will answer.</div>`,
    `</td></tr>`,
    `</table>`,
  ].join("");
}

function footer(brand: RenderedBrand, identity: RenderedIdentity, unsubscribe: RenderedUnsubscribe, p: Palette): string {
  const website = brand.website ? `<div style="padding-top:6px;"><a href="${esc(brand.website)}" style="color:${p.primary};text-decoration:underline;">${esc(visibleHref(brand.website))}</a></div>` : "";
  const footerLine = brand.footerLine ? `<div style="padding-top:6px;">${esc(brand.footerLine)}</div>` : "";

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${FOOTER_BG};border-top:1px solid ${SURFACE_BORDER};">`,
    `<tr><td align="center" style="padding:22px 28px 24px 28px;">`,
    `<div style="font-size:13px;font-weight:700;color:${BODY_TEXT};">${esc(brand.name || "Your business")}</div>`,
    website,
    footerLine,
    `<div style="margin-top:12px;font-size:12px;line-height:18px;color:${FOOTER_TEXT};max-width:480px;margin-left:auto;margin-right:auto;">${esc(unsubscribe.reason)}</div>`,
    `<div style="margin-top:10px;">`,
    `<a href="${esc(unsubscribe.url)}" style="font-size:12px;color:${MUTED_TEXT};text-decoration:underline;">Unsubscribe</a>`,
    `<span style="font-size:12px;color:${FOOTER_TEXT};"> &nbsp;·&nbsp; you can also reply to <span style="color:${MUTED_TEXT};">${esc(identity.replyTo ? identity.replyTo : identity.fromAddress)}</span></span>`,
    `</div>`,
    `</td></tr>`,
    `</table>`,
  ].join("");
}

// ─── Plain-text renderer ─────────────────────────────────────────────────────

/**
 * The plain-text alternative. Every marketing email ships with one: clients
 * that strip HTML (or accessibility tools) still get the full message, the
 * CTA as a real line and the working unsubscribe link.
 */
export function renderEmailText(input: RenderEmailInput): string {
  const { design, brand, identity, unsubscribe } = input;
  const values = {
    firstName: input.personalization?.firstName ?? null,
    businessName: input.personalization?.businessName ?? brand.name,
  };
  const personalize = (value: string) => scrubUnresolvedTokens(applyPersonalization(value, values));

  const lines: string[] = [];
  lines.push(personalize(design.greeting));
  lines.push("");
  lines.push(personalize(design.headline));
  lines.push("");
  for (const section of design.sections) {
    lines.push(personalize(section.text));
    lines.push("");
  }
  lines.push(personalize(design.cta.label) + (design.cta.url ? `: ${design.cta.url}` : " — just reply to this email"));
  lines.push("");
  lines.push("—");
  lines.push(brand.name || "Your business");
  if (brand.website) lines.push(brand.website);
  if (brand.footerLine) lines.push(brand.footerLine);
  lines.push("");
  lines.push(unsubscribe.reason);
  lines.push(`Unsubscribe: ${unsubscribe.url}`);
  if (identity.replyTo) lines.push(`Or reply to: ${identity.replyTo}`);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The full render: HTML + text + subject + preheader in one deterministic pass. */
export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const values = {
    firstName: input.personalization?.firstName ?? null,
    businessName: input.personalization?.businessName ?? input.brand.name,
  };
  const subject = scrubUnresolvedTokens(applyPersonalization(input.design.subject, values));
  const preheader = scrubUnresolvedTokens(applyPersonalization(input.design.preheader || "", values));
  return {
    html: renderEmailHtml(input),
    text: renderEmailText(input),
    subject,
    preheader,
  };
}
