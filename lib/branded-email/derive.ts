/**
 * Branded Email Engine v1 — deterministic design derivation.
 *
 * When a stored email has NO explicit design in its structured content (a
 * historical flow, a hand-edited campaign, or the very first lifecycle email),
 * the renderer still needs a validated design envelope. This module derives one
 * deterministically from the stored subject/preheader/body/CTA — never from a
 * prompt, never inventing a destination.
 *
 * Pure: no I/O, no server-only import.
 */

import { DEFAULT_EMAIL_LAYOUT, EMAIL_LAYOUTS, type EmailDesign, type EmailLayoutId } from "./design";
import { validateEmailDesign } from "./render";

export interface DeriveDesignInput {
  subject: string;
  preheader?: string | null;
  body: string;
  cta?: string | null;
  ctaUrl?: string | null;
  /** Which layout family to use; falls back per flow position when unset. */
  layout?: EmailLayoutId | null;
  /** Deployment hint: the first email of a welcome flow stays "welcome". */
  position?: number | null;
  /** "welcome" | "re_engagement" | "campaign" | "announcement" etc. */
  kind?: string | null;
}

const BODY_WORDS_MAX = 40;

/** The first line of a body is the greeting/headline; the rest are sections. */
export function deriveEmailDesign(input: DeriveDesignInput): EmailDesign {
  const bodyText = (input.body ?? "").trim();
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  // The greeting line ("Hi {firstName},") is the headline; when the body does
  // not open with a greeting, the first paragraph becomes the headline.
  const firstParagraph = paragraphs[0] ?? "";
  const firstBreak = firstParagraph.indexOf("\n");
  const firstLine = (firstBreak >= 0 ? firstParagraph.slice(0, firstBreak) : firstParagraph).trim();
  const opensWithGreeting = /\{firstName\}|^Hi\b|^Hello\b/i.test(firstLine);

  const headline = (firstLine || input.subject || input.body || "Hello").slice(0, 300);

  // When the greeting and the first sentence share a paragraph, the remainder
  // below the greeting line is real content and must be kept.
  let sectionParagraphs: string[];
  if (opensWithGreeting) {
    const restOfFirst = firstBreak >= 0 ? firstParagraph.slice(firstBreak + 1).trim() : "";
    sectionParagraphs = restOfFirst ? [restOfFirst, ...paragraphs.slice(1)] : paragraphs.slice(1);
  } else {
    sectionParagraphs = paragraphs;
  }

  const sections = sectionParagraphs.length > 0
    ? sectionParagraphs.slice(0, 3).map((text) => ({ heading: null, text: text.slice(0, 6000) }))
    : [{ heading: null, text: (firstLine || bodyText).slice(0, 6000) }];

  const ctaLabel = (input.cta ?? "").trim().slice(0, 80);
  const ctaUrl = input.ctaUrl ? String(input.ctaUrl).trim().slice(0, 500) : null;

  const design: EmailDesign = {
    layout: pickLayout(input.layout, input.position, input.kind),
    headline,
    preheader: (input.preheader ?? "").trim().slice(0, 500) || input.subject.slice(0, 500),
    sections,
    cta: ctaLabel ? { label: ctaLabel, url: ctaUrl } : null,
    heroAssetId: null,
    heroAlt: null,
    visualEmphasis: (input.position ?? 0) === 0 ? 2 : 1,
    tone: null,
  };

  // The derived design is validated like any MARA-emitted design, so the
  // renderer never sees an unvalidated envelope.
  const validated = validateEmailDesign(design);
  return validated.design ?? design;
}

function pickLayout(
  explicit: EmailLayoutId | null | undefined,
  position: number | null | undefined,
  kind: string | null | undefined,
): EmailLayoutId {
  if (explicit && EMAIL_LAYOUTS[explicit]) return explicit;

  if (kind === "welcome" || kind === "re_engagement") {
    return position === 0 ? "welcome" : "editorial";
  }

  const pos = Number(position ?? 0);
  if (pos === 0) return "minimal";
  if (pos === 1) return "feature";
  return "editorial";
}

/**
 * Design from a stored email (campaign row or flow snapshot). The campaign
 * content is re-tokenized the same way — no layout survives from a prompt.
 */
export function designFromStoredEmail(input: DeriveDesignInput): EmailDesign {
  return deriveEmailDesign(input);
}

/** Never rendered, but kept for callers that need the default family explicitly. */
export function defaultLayoutFor(kind: string | null | undefined): EmailLayoutId {
  if (kind === "welcome") return "welcome";
  if (kind === "announcement" || kind === "launch") return "announcement";
  if (kind === "feature" || kind === "product") return "feature";
  return DEFAULT_EMAIL_LAYOUT;
}

export { BODY_WORDS_MAX };
