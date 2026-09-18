/**
 * Branded Email Engine v1 — color helpers.
 *
 * Pure: no I/O, no server-only import. The renderer depends on these so the
 * Node suite can execute the real renderer for real.
 *
 * Voom renders email from a curated palette (see `OB_COLORS`, the onboarding
 * color set). A stored color is validated here — never trusted verbatim — and
 * a missing color fails closed to a neutral brand neutral (`#111614`), so a
 * business with no color choice yet still gets a legible, deterministic email.
 */

/** A #RRGGBB hex literal. */
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Voom's onboarding palette (one shared source of truth for the colorings). */
export const BRAND_PALETTE = [
  "#e8481f", // warm red
  "#c9306b", // magenta
  "#0f6f68", // teal
  "#f2a516", // amber
  "#2f6f9f", // blue
  "#1c8a52", // green
  "#7b4bd1", // violet
  "#111614", // near-black neutral
] as const;

/** Neutral fallback used when a business has no stored color yet. */
export const BRAND_NEUTRAL = "#111614";

/** Returns a #RRGGBB literal, or null when the value is not a color. */
export function parseBrandColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!HEX_RE.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * The deterministic brand color: the stored value when it is a valid hex, else
 * the neutral fallback. Never used to store or invent a brand color.
 */
export function brandColor(value: unknown): string {
  return parseBrandColor(value) ?? BRAND_NEUTRAL;
}

/** True when `parsed` reads as a specific brand color chosen by the business. */
export function hasBrandColor(value: unknown): boolean {
  return parseBrandColor(value) !== null;
}

/** A legible shade to render smaller type/borders on top of a given brand color. */
export function brandMutedColor(value: unknown): string {
  const primary = brandColor(value);
  const hex = primary.replace("#", "");
  const n = Number.parseInt(hex, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;

  // Blend 35% towards white for a tint that keeps WCAG contrast against the
  // flat brand color while remaining deterministic. The contrast guarantee for
  // button labels is handled separately in renderLayout via white text.
  const mix = (channel: number) => Math.round(channel + (255 - channel) * 0.35);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One accent color per design family. The deterministic renderer derives a
 * contrast-safe accent when the business has no stored color.
 */
export function resolveAccentColor(primary: unknown, accent: unknown): string {
  return brandColor(accent) ?? brandColor(primary);
}

/** WCAG relative luminance for a #RRGGBB literal (sRGB). */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (start: number) => {
    const c = Number.parseInt(value.slice(start, start + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Contrast ratio between two #RRGGBB literals (WCAG 2.x), 1..21.
 *
 * The renderer uses this to choose white or the brand neutral as the button
 * label so the CTA always meets an accessible contrast floor.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** The 4.5:1 WCAG AA floor the renderer guarantees for CTA label text. */
export const MIN_CONTRAST = 4.5;

/**
 * The best label color for a button rendered on `background`: white when white
 * reads clearly, else the near-black neutral. Deterministic, not arbitrary.
 */
export function buttonLabelColor(background: string): string {
  const onWhite = contrastRatio(background, "#ffffff");
  const onNeutral = contrastRatio(background, BRAND_NEUTRAL);
  return onWhite >= MIN_CONTRAST && onWhite >= onNeutral ? "#ffffff" : BRAND_NEUTRAL;
}
