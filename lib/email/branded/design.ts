/**
 * Branded Email Engine — the validated email design specification.
 *
 * This is the ONLY structure between "content that was written" (deterministic
 * copy or MARA's structured output) and "the final HTML" (the deterministic
 * renderer). MARA and the deterministic layer never emit HTML; they emit — at
 * most — a design spec that is validated here against the renderer's actual
 * capabilities:
 *
 *   - layout must be one of the five implemented layout families;
 *   - image references must name assets the caller supplied (owner-verified
 *     email assets); MARA can point at one it was shown, never at anything
 *     else;
 *   - a CTA url must be in the allowed destination set, otherwise it is
 *     dropped (the renderer then uses a safe non-link action);
 *   - sections are plain text blocks only. There is no `html` field anywhere
 *     in this schema — arbitrary markup cannot enter the pipeline.
 *
 * The deterministic compiler below is the default producer of the spec:
 * both campaigns and flows compile through it, so one renderer serves both
 * stacks.
 *
 * Pure: no I/O, no server-only import — the Node suite executes it for real.
 */

import { z } from "zod";

// ─── Renderer capabilities (the validated set) ──────────────────────────────

export const EMAIL_LAYOUTS = ["welcome", "announcement", "product", "editorial", "minimal"] as const;
export type EmailLayout = (typeof EMAIL_LAYOUTS)[number];

export const EMAIL_VISUAL_EMPHASIS = ["brand", "image", "none"] as const;
export type EmailVisualEmphasis = (typeof EMAIL_VISUAL_EMPHASIS)[number];

/** A rendered image block. The caller resolves asset ids to these before the
 *  renderer runs, so the renderer itself never touches storage. */
export interface EmailAssetRef {
  assetId: string;
  url: string;
  altText: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** Known intrinsic size, when available — used for stable layout. */
  width?: number | null;
  height?: number | null;
}

// ─── The spec schema ─────────────────────────────────────────────────────────

export const emailDesignSectionSchema = z.object({
  /** v1 renders text sections only. There is no html field on purpose. */
  kind: z.literal("text"),
  text: z.string().min(1).max(6000),
}).strict();

export type EmailDesignSection = z.infer<typeof emailDesignSectionSchema>;

export const emailDesignSpecSchema = z.object({
  layout: z.enum(EMAIL_LAYOUTS),
  subject: z.string().min(1).max(300),
  /** Hidden preview line shown next to the subject in inboxes. */
  preheader: z.string().max(200).default(""),
  headline: z.string().min(1).max(200),
  /** Ordered body blocks. Bounded so a runaway model response cannot bloat
   *  an email. */
  sections: z.array(emailDesignSectionSchema).min(1).max(8),
  cta: z.object({
    label: z.string().min(1).max(80),
    /** A validated destination, or null for a reply-oriented non-link action. */
    url: z.string().max(500).nullable(),
  }).strict(),
  /** One hero image at most, and only from assets the caller supplied. */
  heroAssetId: z.string().uuid().nullable().default(null),
  tone: z.string().max(200).default(""),
  visualEmphasis: z.enum(EMAIL_VISUAL_EMPHASIS).default("brand"),
  /** Free-form personalization hint; the renderer only substitutes the two
   *  supported tokens, so this is display metadata, not code. */
  greeting: z.string().max(120).default("Hi {firstName},"),
}).strict();

export type EmailDesignSpec = z.infer<typeof emailDesignSpecSchema>;

/** Result of validating/normalizing a proposed spec. */
export type EmailDesignValidation =
  | { ok: true; design: EmailDesignSpec }
  | { ok: false; reason: string };

/**
 * The gate between any content source (deterministic compiler, MARA) and the
 * renderer. Anything that is not valid JSON against the schema, that names a
 * layout or asset the renderer cannot honour, that carries a URL outside the
 * allowed set, or that contains markup is refused with a stable reason — and
 * the caller falls back to a deterministic design.
 */
export function validateEmailDesign(
  candidate: unknown,
  options: {
    /** Destinations a CTA may actually point at (verified website, configured
     *  campaign URL, or an asset-free reply action). */
    allowedUrls?: readonly string[];
    /** Asset ids the business has published for email use. */
    allowedAssetIds?: readonly string[];
  } = {},
): EmailDesignValidation {
  const allowedUrls = new Set((options.allowedUrls ?? []).map((url) => normalizeUrl(url)));
  const allowedAssetIds = new Set(options.allowedAssetIds ?? []);

  const parsed = emailDesignSpecSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "schema_rejected" };

  const design = parsed.data;

  if (!EMAIL_LAYOUTS.includes(design.layout)) return { ok: false, reason: "layout_not_supported" };

  for (const section of design.sections) {
    if (/<\s*(script|iframe|img|a\s|form|input|object|embed|link|meta)/i.test(section.text)) {
      // Sections are plain prose. Markup in copy is refused, not sanitized —
      // the deterministic compiler re-derives clean sections instead.
      return { ok: false, reason: "markup_in_sections" };
    }
  }

  if (design.heroAssetId && !allowedAssetIds.has(design.heroAssetId)) {
    return { ok: false, reason: "hero_asset_not_authorized" };
  }

  if (design.cta.url && !allowedUrls.has(normalizeUrl(design.cta.url))) {
    // An invented destination is a hard refusal: a spec that lies about where
    // a button goes is worse than no button. The caller falls back and the
    // CTA degrades to the safe reply-oriented action.
    return { ok: false, reason: "cta_url_not_allowed" };
  }

  return { ok: true, design };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

// ─── Deterministic layout selection ──────────────────────────────────────────

export interface LayoutSelectionInput {
  /** "welcome" | "re_engagement" for flow steps. */
  flowType?: "welcome" | "re_engagement" | null;
  campaignObjective?: string | null;
  campaignName?: string | null;
  content?: string | null;
  /** A hero image is available and appropriate for this send. */
  hasImage?: boolean;
}

const LAYOUT_KEYWORDS: Array<{ layout: Exclude<EmailLayout, "welcome" | "minimal">; pattern: RegExp }> = [
  { layout: "announcement", pattern: /\b(announc|launch|coming soon|we (?:are|have) (?:launched|opened)|big (?:news|day)|introducing)\b/i },
  { layout: "product", pattern: /\b(new (?:product|feature|service|menu|collection|release)|feature|product|upgrade|what'?: new|now available|added to (?:the )?(?:menu|service|catalog|catalogue))\b/i },
  { layout: "editorial", pattern: /\b(update|news|notes|what'?:|reflection|story|behind the scenes|season|monthly|letter)\b/i },
];

/**
 * Chooses the layout family from business + objective + step + available
 * assets. Deterministic and explainable: flow type wins, then objective
 * keywords, then image availability, then the minimal professional default.
 */
export function selectEmailLayout(input: LayoutSelectionInput): { layout: EmailLayout; reason: string } {
  if (input.flowType === "welcome") return { layout: "welcome", reason: "welcome flow step" };
  if (input.flowType === "re_engagement") return { layout: "editorial", reason: "re-engagement step reads as a short update" };

  const haystack = `${input.campaignObjective ?? ""}\n${input.campaignName ?? ""}`;
  for (const { layout, pattern } of LAYOUT_KEYWORDS) {
    if (pattern.test(haystack)) return { layout, reason: `objective mentions ${layout} territory` };
  }

  if (input.hasImage) return { layout: "product", reason: "content leads with imagery" };
  return { layout: "minimal", reason: "no stronger signal — the quiet professional default" };
}

// ─── The deterministic compiler ──────────────────────────────────────────────

export interface CompileEmailDesignInput {
  subject: string;
  previewText?: string | null;
  /** The full plain-text body as stored (may contain the greeting line and
   *  the unsubscribe footer). */
  body: string;
  cta: string;
  ctaUrl?: string | null;
  allowedUrls?: string[];
  /** Assets the business published for email, in preference order. */
  assets?: EmailAssetRef[];
  flowType?: "welcome" | "re_engagement" | null;
  campaignObjective?: string | null;
  campaignName?: string | null;
  brandName?: string | null;
  tone?: string | null;
}

export interface CompiledEmailDesign {
  design: EmailDesignSpec;
  layoutReason: string;
  /** True when a caller-supplied proposal was used; false when compiled. */
  source: "compiled" | "proposed";
}

/**
 * Compiles stored email content into a validated design spec.
 *
 * The stored body is prose: a greeting line, paragraphs, the business name
 * and the unsubscribe footer. The compiler splits that prose into the
 * layout's blocks. The unsubscribe footer itself is NOT a design section —
 * the renderer appends the real footer (with the working link) separately,
 * so no layout can accidentally ship a footer without a link.
 */
export function compileEmailDesign(input: CompileEmailDesignInput): CompiledEmailDesign {
  const assets = (input.assets ?? []).filter((asset) => asset.mimeType.startsWith("image/"));
  const selection = selectEmailLayout({
    flowType: input.flowType ?? null,
    campaignObjective: input.campaignObjective ?? null,
    campaignName: input.campaignName ?? null,
    hasImage: assets.length > 0,
  });

  const { greeting, paragraphs, closingLine } = splitBody(input.body, input.brandName);
  const layout = selection.layout;

  // Hero image: only the layouts that have a hero slot, and only when the
  // business actually published an asset. No image → a clean text/brand-color
  // layout. Voom never decorates with unrelated imagery.
  const heroAssetId = layout === "product" || layout === "announcement" || layout === "welcome"
    ? (assets[0]?.assetId ?? null)
    : layout === "editorial"
      ? (assets[0]?.assetId ?? null)
      : null;

  // CTA: only a destination the business is allowed to claim. Otherwise the
  // renderer draws the reply-oriented non-link action.
  const allowed = new Set((input.allowedUrls ?? []).map((url) => normalizeUrl(url)));
  const ctaUrl = input.ctaUrl && allowed.has(normalizeUrl(input.ctaUrl)) ? input.ctaUrl.trim() : null;

  // The layout's headline comes from the first content paragraph (or the
  // subject when the body starts with the greeting only).
  const headlineSource = paragraphs[0] ?? input.subject;
  const headline = clipToOneLine(headlineSource, 200) || input.subject;

  // Sections: the body paragraphs minus the headline (which the layout shows
  // large). A single-paragraph body IS the headline — never repeat it.
  const bodySections = paragraphs
    .filter((paragraph, index) => !(index === 0 && clipToOneLine(paragraph, 200) === headline))
    .slice(0, 6)
    .map((text) => ({ kind: "text" as const, text }));
  // A closing line (the signature brand name) is only worth a section of its
  // own when real body copy precedes it.
  const sections: EmailDesignSection[] =
    bodySections.length > 0
      ? bodySections
      : closingLine && paragraphs.length > 1
        ? [{ kind: "text" as const, text: closingLine }]
        : [];

  const design: EmailDesignSpec = {
    layout,
    subject: input.subject.trim(),
    preheader: (input.previewText ?? "").trim().slice(0, 200),
    headline,
    sections,
    cta: { label: clipToOneLine(input.cta || "Reply to this email", 80), url: ctaUrl },
    heroAssetId,
    tone: (input.tone ?? "").trim().slice(0, 200),
    visualEmphasis: heroAssetId ? "image" : "brand",
    greeting,
  };

  return { design, layoutReason: selection.reason, source: "compiled" };
}

/**
 * Validates a caller-proposed design (e.g. MARA's optional design block) and
 * returns it when it is fully inside the renderer's capabilities, otherwise
 * null so the caller can fall back to `compileEmailDesign`.
 */
export function acceptProposedDesign(
  candidate: unknown,
  input: CompileEmailDesignInput,
): EmailDesignSpec | null {
  const result = validateEmailDesign(candidate, {
    allowedUrls: input.allowedUrls,
    allowedAssetIds: (input.assets ?? []).map((asset) => asset.assetId),
  });
  if (!result.ok) return null;
  // The proposal fills the visual structure; the stored copy stays the
  // authoritative subject/body source.
  return {
    ...result.design,
    subject: input.subject.trim(),
    sections: result.design.sections.length > 0
      ? result.design.sections
      : compileEmailDesign(input).design.sections,
    cta: {
      label: result.design.cta.label || clipToOneLine(input.cta || "Reply to this email", 80),
      url: result.design.cta.url ?? null,
    },
  };
}

// ─── Prose splitting ─────────────────────────────────────────────────────────


function splitBody(body: string, brandName: string | null | undefined): { greeting: string; paragraphs: string[]; closingLine: string } {
  let text = (body ?? "").replace(/\r\n/g, "\n").trim();

  // The deterministic unsubscribe footer (and any provider-style opt-out
  // line) belongs to the renderer's footer, never to a design section.
  text = text.replace(/(^|\n)\s*You are receiving this because[^\n]*(?:\n[^\n]+)*?(?:immediately|one click|honour it)[^\n]*$/i, "").trimEnd();
  text = text.replace(/(^|\n)[^\n]*unsubscribe link[^\n]*$/i, "").trimEnd();

  const rawParagraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

  const brand = (brandName ?? "").trim();
  let greeting = "Hi {firstName},";
  const paragraphs: string[] = [];
  let closingLine = "";

  for (const paragraph of rawParagraphs) {
    if (paragraphs.length === 0 && /^\{firstName\}|^hi\b|^hello\b|^dear\b/i.test(paragraph) && paragraph.length <= 60 && !paragraph.includes(".")) {
      greeting = paragraph;
      continue;
    }
    if (brand && paragraphs.length >= 2 && /^(you're receiving|unsubscribe)/i.test(paragraph)) continue;
    paragraphs.push(paragraph);
  }

  // A trailing bare brand name is a signature, not copy.
  if (paragraphs.length > 1 && brand && paragraphs[paragraphs.length - 1].toLowerCase() === brand.toLowerCase()) {
    closingLine = paragraphs.pop() as string;
  }

  return { greeting, paragraphs, closingLine };
}

function clipToOneLine(value: string, max: number): string {
  const firstLine = (value ?? "").split(/\n+/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max - 1).trimEnd()}…`;
}
