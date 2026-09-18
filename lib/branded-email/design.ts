/**
 * Branded Email Engine v1 — MARA design model.
 *
 * The pipeline is one-directional and structural, exactly like campaign and
 * flow intelligence:
 *
 *   brand + assets + objective/content → MARA structured design →
 *   strict schema validation → deterministic renderer → HTML + plain text.
 *
 * MARA never emits HTML. It emits this envelope — a layout id from the
 * validated registry plus headlines/sections/CTA/hero asset/emphasis — and the
 * renderer turns that into markup. Every capability in the registry is a real
 * renderer capability; a layout outside the registry can never be requested,
 * let alone rendered.
 *
 * Pure: no I/O, no server-only import.
 */

import { z } from "zod";

// ─── Layout registry (the ONLY renderer capabilities) ─────────────────────

export type EmailLayoutId =
  | "welcome"
  | "announcement"
  | "feature"
  | "editorial"
  | "minimal"
  | "product";

export interface EmailLayoutDefinition {
  id: EmailLayoutId;
  label: string;
  /** Which hero asset slot this family renders (null = none). */
  hero: "logo" | "image" | "none";
  /** 0–2: how visually prominent the hero is. */
  visualEmphasis: 0 | 1 | 2;
  /** One human sentence shown in the admin UI. */
  description: string;
}

/**
 * The six email design families. Character counts are a property of the data
 * model + renderer, never of a prompt: they are enforced in validateDesign.
 */
export const EMAIL_LAYOUTS: Record<EmailLayoutId, EmailLayoutDefinition> = {
  welcome: {
    id: "welcome",
    label: "Welcome",
    hero: "logo",
    visualEmphasis: 1,
    description: "Warm open with the brand mark and a single next step.",
  },
  announcement: {
    id: "announcement",
    label: "Announcement / launch",
    hero: "image",
    visualEmphasis: 2,
    description: "Big headline and an optional hero image for launches.",
  },
  feature: {
    id: "feature",
    label: "Product / feature",
    hero: "image",
    visualEmphasis: 2,
    description: "One feature story, supporting bullets, one button.",
  },
  editorial: {
    id: "editorial",
    label: "Editorial / update",
    hero: "none",
    visualEmphasis: 1,
    description: "Prose-forward update with a hairline-branded header.",
  },
  minimal: {
    id: "minimal",
    label: "Minimal professional",
    hero: "logo",
    visualEmphasis: 0,
    description: "Quiet, text-first note for transactional or low-key sends.",
  },
  product: {
    id: "product",
    label: "Product showcase",
    hero: "image",
    visualEmphasis: 2,
    description: "Showcase one product with a price-free, feature-driven block.",
  },
};

export const EMAIL_LAYOUT_IDS = Object.keys(EMAIL_LAYOUTS) as EmailLayoutId[];

/** A default family that is always safe when no layout is configured. */
export const DEFAULT_EMAIL_LAYOUT: EmailLayoutId = "minimal";

// ─── The structured design envelope ────────────────────────────────────────

export interface EmailDesignSection {
  /** Optional eyebrow/eyebrow label. */
  heading?: string | null;
  /** Paragraph text. Plain text — the renderer does the line breaks. */
  text: string;
}

export interface EmailDesignCta {
  label: string;
  url: string | null;
}

export type VisualEmphasis = 0 | 1 | 2;

export interface EmailDesign {
  layout: EmailLayoutId;
  /** The greeting line start; renderer always resolves firstName. */
  headline: string;
  preheader: string;
  /** 0..3 sections. */
  sections: EmailDesignSection[];
  cta: EmailDesignCta | null;
  /** Validated hero image asset, or null to fall back to text/logo. */
  heroAssetId?: string | null;
  heroAlt?: string | null;
  /** 0..2 intensity per family. Clamped to the family's ceiling. */
  visualEmphasis: VisualEmphasis;
  tone: string | null;
}

// ─── MARA's structured response contract (mirrored to the JSON schema) ────

export const emailDesignSectionSchema = z.object({
  heading: z.string().max(160).nullable().optional(),
  text: z.string().min(1).max(6000),
}).strict();

export const emailDesignCtaSchema = z.object({
  label: z.string().min(1).max(80),
  /**
   * A real destination the renderer receives resolved. Raw URLs are NOT
   * accepted here: the merge layer validates against the destination context
   * and hands back null or a validated URL.
   */
  url: z.string().max(500).nullable(),
}).strict();

export const emailDesignSchema = z.object({
  layout: z.enum(EMAIL_LAYOUT_IDS),
  headline: z.string().min(1).max(300),
  preheader: z.string().max(500),
  sections: z.array(emailDesignSectionSchema).min(1).max(3),
  cta: emailDesignCtaSchema.nullable(),
  heroAssetId: z.string().max(200).nullable().optional(),
  heroAlt: z.string().max(200).nullable().optional(),
  visualEmphasis: z.number().int().min(0).max(2),
  tone: z.string().max(200).nullable(),
}).strict();

export type MaraEmailDesign = z.infer<typeof emailDesignSchema>;

/** The strict provider-side json_schema, mirroring the zod schema EXACTLY. */
export const emailDesignJsonSchema = {
  name: "mara_email_design",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["layout", "headline", "preheader", "sections", "cta", "visualEmphasis", "tone"],
    properties: {
      layout: {
        type: "string",
        enum: EMAIL_LAYOUT_IDS,
        description: "One of the registered email layout families.",
      },
      headline: { type: "string", minLength: 1, maxLength: 300 },
      preheader: { type: "string", maxLength: 500 },
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["heading", "text"],
          properties: {
            heading: { type: ["string", "null"], maxLength: 160 },
            text: { type: "string", minLength: 1, maxLength: 6000 },
          },
        },
      },
      cta: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["label", "url"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 80 },
          url: { type: ["string", "null"], maxLength: 500 },
        },
      },
      heroAssetId: { type: ["string", "null"], maxLength: 200 },
      heroAlt: { type: ["string", "null"], maxLength: 200 },
      visualEmphasis: { type: "integer", minimum: 0, maximum: 2 },
      tone: { type: ["string", "null"], maxLength: 200 },
    },
  },
} as const;
