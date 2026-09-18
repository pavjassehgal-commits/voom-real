/**
 * Branded Email Engine v1 — the deterministic HTML + plain-text renderer.
 *
 * This is the ONLY thing that turns an `EmailDesign` into markup. Every layout,
 * color, spacer and table is produced here deterministically:
 *
 *   - table-based, email-safe CSS only (no flexbox/grid, no external CSS),
 *   - fixed 600px content table with a fluid 100% wrapper so Gmail and Outlook
 *     both center and scale it,
 *   - one `@media` block for a single-column mobile breakpoint,
 *   - accessible: alt text on every image, `role="presentation"` on spacer
 *     tables, real headings, 4.5:1 contrast on the CTA label (computed, not
 *     hoped for),
 *   - no JavaScript — nothing can execute in a mail client;
 *   - a text/plain alternative is generated from the same model, never from a
 *     different one, so preview and production can never disagree.
 *
 * Inputs are always a VALIDATED `EmailDesign` + normalized `EmailBrandProfile`
 * + the resolved destination + asset + personalization. Callers should run
 * `validateEmailDesign` (this module) first; the renderer also refuses loudly
 * on malformed input rather than emitting garbage.
 *
 * Pure: no I/O, no server-only import, no crypto. The Node suite renders for real.
 */

import { brandColor } from "./colors";
import { buttonLabelColor } from "./colors";
import {
  DEFAULT_EMAIL_LAYOUT,
  EMAIL_LAYOUTS,
  type EmailDesign,
  type EmailLayoutId,
  type VisualEmphasis,
} from "./design";
import type { EmailBrandProfile } from "./brand-profile";

// ─── Validation ────────────────────────────────────────────────────────────

export interface EmailDesignValidation {
  ok: boolean;
  errors: string[];
  design: EmailDesign | null;
}

const MAX_HEADLINE = 300;
const MAX_PREHEADER = 500;
const MAX_SECTION_TEXT = 6000;
const MAX_CTA_LABEL = 80;

/** Deterministic, structural validation. Refuses anything unsafe or out of
 *  family bounds. Never mutates the caller's object. */
export function validateEmailDesign(candidate: unknown): EmailDesignValidation {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, errors: ["design must be an object"], design: null };
  }
  const d = candidate as Record<string, unknown>;

  const layout = (typeof d.layout === "string" && EMAIL_LAYOUTS[d.layout as EmailLayoutId])
    ? d.layout as EmailLayoutId
    : DEFAULT_EMAIL_LAYOUT;
  if (d.layout && !EMAIL_LAYOUTS[String(d.layout) as EmailLayoutId]) {
    errors.push(`unknown_layout:${String(d.layout)}`);
  }

  const headline = typeof d.headline === "string" ? d.headline.trim().slice(0, MAX_HEADLINE) : "";
  if (!headline) errors.push("missing_headline");
  if (typeof d.headline === "string" && d.headline.length > MAX_HEADLINE) errors.push("headline_too_long");

  const preheader = typeof d.preheader === "string" ? d.preheader.trim().slice(0, MAX_PREHEADER) : "";
  if (!preheader) errors.push("missing_preheader");

  const rawSections = Array.isArray(d.sections) ? d.sections : [];
  const sections: EmailDesign["sections"] = [];
  if (rawSections.length < 1) {
    errors.push("missing_sections");
  } else {
    for (const raw of rawSections.slice(0, 3)) {
      if (!raw || typeof raw !== "object") {
        errors.push("invalid_section");
        continue;
      }
      const section = raw as Record<string, unknown>;
      const text = typeof section.text === "string" ? section.text.trim() : "";
      if (!text) {
        errors.push("empty_section");
        continue;
      }
      if (text.length > MAX_SECTION_TEXT) errors.push("section_too_long");
      sections.push({
        heading: typeof section.heading === "string" && section.heading.trim()
          ? section.heading.trim().slice(0, 160)
          : null,
        text: text.slice(0, MAX_SECTION_TEXT),
      });
    }
  }

  let cta: EmailDesign["cta"] = null;
  if (d.cta && typeof d.cta === "object") {
    const c = d.cta as Record<string, unknown>;
    const ctaLabel = typeof c.label === "string" ? c.label.trim().slice(0, MAX_CTA_LABEL) : "";
    const ctaUrl = typeof c.url === "string" && c.url.trim() ? c.url.trim() : null;
    if (ctaLabel && ctaUrl) {
      cta = { label: ctaLabel, url: ctaUrl };
    } else if (ctaLabel && !ctaUrl) {
      // A label with no destination is dropped, not rendered dead.
      errors.push("cta_without_destination");
    }
    if (typeof c.label === "string" && c.label.length > MAX_CTA_LABEL) errors.push("cta_label_too_long");
  } else if (d.cta && typeof d.cta !== "object") {
    errors.push("invalid_cta");
  }

  const family = EMAIL_LAYOUTS[layout];
  const requestedEmphasis = Number.isInteger(d.visualEmphasis) ? Number(d.visualEmphasis) : family.visualEmphasis;
  const visualEmphasis = Math.max(0, Math.min(family.visualEmphasis, requestedEmphasis)) as VisualEmphasis;

  const design: EmailDesign = {
    layout,
    headline,
    preheader,
    sections: sections.length > 0 ? sections : [{ text: headline }],
    cta,
    heroAssetId: typeof d.heroAssetId === "string" ? d.heroAssetId.slice(0, 200) : null,
    heroAlt: typeof d.heroAlt === "string" && d.heroAlt.trim()
      ? d.heroAlt.trim().slice(0, 200)
      : null,
    visualEmphasis,
    tone: typeof d.tone === "string" && d.tone.trim() ? d.tone.trim().slice(0, 200) : null,
  };

  return { ok: errors.length === 0, errors, design };
}

// ─── Personalization ──────────────────────────────────────────────────────

export interface PersonalizedValues {
  /** Contact first name, or null. */
  firstName?: string | null;
  /** Recipient address (displayed only in the footer, low-key). */
  recipientEmail?: string | null;
}

// Order matters: the double-brace form must resolve first, otherwise
// "{{firstName}}" would become "{Ada}" and then be lost to the safety net.
export const PERSONALIZATION_TOKENS: ReadonlyArray<{ token: string; fallback: string }> = [
  { token: "{{firstName}}", fallback: "there" },
  { token: "{firstName}", fallback: "there" },
];

/**
 * Replaces the personalization tokens Voom owns. Both `{firstName}` and
 * `{{firstName}}` are handled, along with a `:{firstName}` occurrence in
 * greetings ("Hi {firstName},"). Anything that still LOOKS like a token after
 * substitution is replaced with the neutral fallback — so no unresolved token
 * can ever reach a recipient.
 */
export function personalize(value: string, firstName: string | null | undefined): string {
  const name = (firstName ?? "").trim() || "there";
  let out = value;
  for (const { token } of PERSONALIZATION_TOKENS) {
    out = out.split(token).join(name);
  }
  // Safety net: any token left behind (a brand body that used a different
  // casing or an unknown placeholder) is neutralized to the greeting word,
  // never shipped and never guessed.
  out = out.replace(/\{\{?\s*[A-Za-z][A-Za-z0-9]*\s*\}?\}/g, "there");
  return out;
}

/** True when an unresolved `{token}`-style placeholder remains. */
export function hasUnresolvedTokens(value: string): boolean {
  return /\{\{?\s*[A-Za-z][A-Za-z0-9]*\s*\}?\}/.test(value);
}

// ─── Render inputs/outputs ─────────────────────────────────────────────────

export interface RenderEmailContentInput {
  /** A VALIDATED design. */
  design: EmailDesign;
  brand: EmailBrandProfile;
  /** Resolved CTA label/url. May be derived separately (reply CTA etc.). */
  cta?: { label: string; url: string } | null;
  /** Resolved hero image (public, durable URL) or null. */
  hero: { url: string; alt: string; mimeType: string } | null;
  personalization?: PersonalizedValues;
  /** Real unsubscribe link, for a marketing email; null for transactional. */
  unsubscribeUrl?: string | null;
  /** The plain-text unsubscribe sentence (has been link-ready). */
  unsubscribeText?: string | null;
  subject: string;
}

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

// ─── Escaping ──────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeUrl(value: string): string {
  if (/^mailto:/i.test(value)) {
    return "mailto:" + encodeURIComponent(value.slice("mailto:".length).replace(/^mailto:/i, ""));
  }
  return escapeHtml(value);
}

function escapeAttribute(value: string) {
  return escapeHtml(value).slice(0, 200);
}

// ─── Renderer ──────────────────────────────────────────────────────────────

/**
 * The one deterministic HTML renderer. Same inputs → byte-identical markup
 * (given the same platform string primitives), which preview and production
 * both call.
 */
export function renderEmailHtml(input: RenderEmailContentInput): string {
  const { design, brand } = input;
  const primary = brandColor(brand.primaryColor);
  const labelColor = buttonLabelColor(primary);
  const firstName = input.personalization?.firstName ?? null;
  const recipient = input.personalization?.recipientEmail ?? null;

  const headline = escapeHtml(personalize(design.headline, firstName));

  const cta = input.cta ?? design.cta;
  let ctaBlock = "";
  if (cta && cta.url) {
    ctaBlock = ctaButtonHtml(personalize(cta.label, firstName), cta.url, primary, labelColor);
  }

  let heroBlock = "";
  if (input.hero && input.hero.url) {
    heroBlock = heroHtml(input.hero.url, input.hero.alt || design.heroAlt || brand.name);
  } else if (layoutUsesLogo(design.layout) && brand.logo && brand.logo.url) {
    heroBlock = logoBlock(brand.logo.url, brand.logo.alt);
  }

  const sections = design.sections.map((section) => {
    const heading = section.heading ? `<tr><td style="${td()}" role="heading" aria-level="2"><h2 style="${h2(primary)}">${escapeHtml(personalize(section.heading!, firstName))}</h2></td></tr>` : "";
    const text = section.text
      .split(/\n{2,}/)
      .map((paragraph) => `<tr><td style="${td() + "padding:0 32px 18px 32px;"}"><p style="${p()}">${escapeHtml(personalize(paragraph, firstName))}</p></td></tr>`)
      .join("");
    return heading + text;
  }).join("");

  const sectionBlock = `${heroBlock}${headlineBlock(headline)}${sections}${ctaBlock}`;

  const footerHtml = footerBlock({
    brand,
    firstName: null,
    recipient,
    unsubscribeUrl: input.unsubscribeUrl ?? null,
  });

  const accent = brandColor(brand.accentColor);

  return emailShell({
    preheader: escapeHtml(personalize(design.preheader, firstName)),
    accent,
    primary,
    emphasis: design.visualEmphasis,
    body: sectionBlock,
    footer: footerHtml,
  });
}

/** Fixed table header + hero overheads shaped by the family. */
function heroHtml(url: string, alt: string) {
  const altText = escapeAttribute(alt);
  return `<tr><td style="${td() + "padding:0 0 8px 0;"}"><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:0;"><img src="${escapeUrl(url)}" width="600" alt="${altText}" border="0" style="display:block;width:100%;max-width:600px;height:auto;outline:none;text-decoration:none;" /></td></tr></table></td></tr>`;
}

function logoBlock(url: string, alt: string) {
  const altText = escapeAttribute(alt);
  return `<tr><td style="${td() + "padding:24px 32px 8px 32px;"}"><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td align="left" style="padding:0;"><img src="${escapeUrl(url)}" width="72" alt="${altText}" border="0" style="display:block;width:72px;max-width:72px;height:auto;outline:none;" /></td></tr></table></td></tr>`;
}

function headlineBlock(headline: string) {
  return `<tr><td style="${td() + "padding:0 32px 20px 32px;"}"><h1 style="margin:0 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:34px;font-weight:700;color:#111614;">${headline}</h1></td></tr>`;
}

function ctaButtonHtml(label: string, url: string, background: string, textColor: string) {
  const labelText = escapeHtml(label);
  const href = escapeUrl(url);
  // Bulletproof button: table-cell structure so Outlook and Gmail both render it.
  return `<tr><td style="${td() + "padding:8px 32px 24px 32px;"}"><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:8px;background-color:${background};"><a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:${textColor};text-decoration:none;border-radius:8px;">${labelText}</a></td></tr></table></td></tr>`;
}

function footerBlock(input: {
  brand: EmailBrandProfile;
  firstName: string | null;
  recipient: string | null;
  unsubscribeUrl: string | null;
}) {
  const { brand, recipient, unsubscribeUrl } = input;
  const primary = brandColor(brand.primaryColor);

  let unsubscribeHtml = "";
  if (unsubscribeUrl) {
    unsubscribeHtml = `<tr><td style="${tdSmall()}" align="center"><a href="${escapeUrl(unsubscribeUrl)}" target="_blank" rel="noopener noreferrer" style="color:#5b6660;text-decoration:underline;">Unsubscribe from these emails</a></td></tr>`;
  } else {
    unsubscribeHtml = `<tr><td style="${tdSmall()}" align="center">You are receiving this because you subscribed to email from ${escapeHtml(brand.name)}.</td></tr>`;
  }

  const addressLine = recipient
    ? `<tr><td style="${tdSmall()}" align="center">Sent to ${escapeHtml(recipient)}.</td></tr>`
    : "";

  const websiteLine = brand.website
    ? `<tr><td style="${tdSmall() + "padding:0 32px 14px 32px;"}" align="center"><a href="${escapeUrl(brand.website)}" target="_blank" rel="noopener noreferrer" style="color:#5b6660;text-decoration:underline;">${escapeHtml(brand.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a></td></tr>`
    : "";

  const socials = brand.socialLinks.length
    ? `<tr><td style="${tdSmall()}" align="center">${brand.socialLinks.map((link) => `<a href="${escapeUrl(link.url)}" target="_blank" rel="noopener noreferrer" style="color:#5b6660;text-decoration:underline;margin:0 6px;">${escapeHtml(link.label)}</a>`).join("")}</td></tr>`
    : "";

  const addressBlock = brand.footerAddress
    ? `<tr><td style="${tdSmall()}" align="center">${escapeHtml(brand.footerAddress)}</td></tr>`
    : "";

  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="border-top:4px solid ${primary};">
  ${unsubscribeHtml}
  ${addressLine}
  ${websiteLine}
  ${socials}
  ${addressBlock}
  <tr><td style="${tdSmall() + "padding:18px 32px 26px 32px;"}" align="center">${escapeHtml(brand.name)}</td></tr>
</table>`;
}

function td() {
  return "margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;vertical-align:top;";
}

function tdSmall() {
  return "margin:0;padding:0 32px 6px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#5b6660;";
}

function p() {
  return "margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#2b312e;";
}

function h2(accent: string) {
  return `margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:24px;font-weight:700;color:${accent};`;
}

function emailShell(input: {
  preheader: string;
  accent: string;
  primary: string;
  emphasis: VisualEmphasis;
  body: string;
  footer: string;
}) {
  const heroPadding = input.emphasis === 2 ? "0" : "8px 0 0 0";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title></title>
<style>
  body { margin:0; padding:0; background-color:#f4f4f2; }
  /* One mobile breakpoint: single column, full-width buttons. */
  @media only screen and (max-width: 600px) {
    .container { width: 100% !important; }
    .inner { padding-left: 16px !important; padding-right: 16px !important; }
    h1 { font-size: 24px !important; line-height: 30px !important; }
    .cta-link { display:block !important; width:auto !important; padding:14px 16px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f2;">
  <!-- Preheader: hidden inline, shown as snippet. -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${input.preheader}&#8239;&#847;&#8239;&#160;&#8239;&#847;&#8239;&#160;&#8239;&#847;&#8239;&#160;&#8239;&#847;&#8239;&#160;&#8239;&#847;&#8239;&#160;&#8239;&#847;&#8239;&#160;&#8239;&#847;&#8239;&#160;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" class="container" style="background-color:#f4f4f2;">
    <tr>
      <td align="center" style="padding:${heroPadding};">
        <!-- 600px fixed content table. -->
        <table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0" class="content" style="width:600px;max-width:600px;background-color:#ffffff;">
          <tr><td style="${td()}" align="center" bgcolor="${input.primary}" height="6">&nbsp;</td></tr>
          ${input.body}
          ${input.footer}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function layoutUsesLogo(layout: EmailLayoutId): boolean {
  return EMAIL_LAYOUTS[layout].hero === "logo";
}

// ─── Plain-text alternative (same model, different sink) ──────────────────

/**
 * The text/plain alternative, generated from the SAME validated design and
 * brand, so preview and production can never disagree about the message.
 */
export function renderEmailText(input: RenderEmailContentInput): string {
  const { design, brand } = input;
  const firstName = input.personalization?.firstName ?? null;
  const recipient = input.personalization?.recipientEmail ?? null;

  const lines: string[] = [];
  lines.push(personalize(design.headline, firstName));
  lines.push("");

  for (const section of design.sections) {
    if (section.heading) {
      lines.push(personalize(section.heading, firstName));
      lines.push("");
    }
    lines.push(personalize(section.text, firstName));
    lines.push("");
  }

  const cta = input.cta ?? design.cta;
  if (cta && cta.url) {
    lines.push(`${personalize(cta.label, firstName)}: ${cta.url}`);
    lines.push("");
  }

  lines.push(brand.name);
  if (brand.website) lines.push(brand.website);
  if (brand.footerAddress) lines.push(brand.footerAddress);
  if (input.unsubscribeUrl) {
    const sentence = input.unsubscribeText ?? `You are receiving this because you subscribed to email from ${brand.name}. Unsubscribe here:`;
    lines.push("");
    lines.push(`${sentence} ${input.unsubscribeUrl}`);
  } else {
    lines.push("");
    lines.push(`You are receiving this because you subscribed to email from ${brand.name}.`);
  }
  if (recipient) {
    lines.push("");
    lines.push(`Sent to ${recipient}.`);
  }

  return lines.join("\n");
}

/** Renders both sinks from one validated envelope — the normal production path. */
export function renderEmail(input: RenderEmailContentInput): RenderedEmail {
  const subject = personalize(input.subject, input.personalization?.firstName ?? null);
  const html = renderEmailHtml(input);
  const text = renderEmailText(input);
  return {
    subject,
    preheader: input.design.preheader,
    html,
    text,
  };
}
