import type { ViewerReelCopy } from "./reel-copy";
import type { ReelSceneVisual } from "./reel-visuals";

export type ReelSceneRole = "hook" | "message" | "value" | "cta";

export interface ReelScene {
  role: ReelSceneRole;
  text: string;
  durationMs: number;
  /** Private asset id assigned by MARA for this scene (v3). Absent in v1/v2 compositions. */
  assetId?: string | null;
  assetKind?: "image" | "video" | null;
}

export interface ReelComposition {
  version: 3;
  format: "live_voom_composition";
  aspectRatio: "9:16";
  durationMs: number;
  brandName: string;
  concept: string;
  caption: string;
  usesAsset: boolean;
  scenes: ReelScene[];
  producedAt: string;
}

/** v2 compositions: four viewer-facing scenes without per-scene asset assignment. */
export interface V2ReelComposition extends Omit<ReelComposition, "version"> { version: 2; }

/** v1 compositions (3 scenes: hook/body/cta) remain readable and playable. */
export interface LegacyReelScene { role: "hook" | "body" | "cta"; text: string; durationMs: number; }
export interface LegacyReelComposition { version: 1; format: "live_voom_composition"; aspectRatio: "9:16"; durationMs: number; brandName: string; concept: string; caption: string; usesAsset: boolean; scenes: LegacyReelScene[]; producedAt: string; }

export type AnyReelComposition = ReelComposition | V2ReelComposition | LegacyReelComposition;

const SCENE_BUILD: Array<{ role: ReelSceneRole; durationMs: number }> = [
  { role: "hook", durationMs: 2500 },
  { role: "message", durationMs: 3000 },
  { role: "value", durationMs: 3000 },
  { role: "cta", durationMs: 3000 },
];

/**
 * Builds the persisted viewer-facing composition. Only validated viewer copy
 * is accepted here — the produce route generates and enforces it through
 * lib/mara/reel-copy, so internal production script and shot instructions
 * can never reach the screen. `visuals` carries MARA's deterministic asset
 * assignment across the four scenes (safe asset ids, never storage paths).
 */
export function buildReelComposition(input: { concept: string; caption: string; brandName: string; usesAsset: boolean; viewerCopy: ViewerReelCopy; visuals?: ReelSceneVisual[]; producedAt?: string }): ReelComposition {
  const concept = clean(input.concept, 180) || "A useful idea from Voom";
  const brandName = clean(input.brandName, 80) || "Voom business";
  const scenes: ReelScene[] = SCENE_BUILD.map(({ role, durationMs }, index) => ({
    role,
    text: clip(input.viewerCopy[role], role),
    durationMs,
    assetId: input.visuals?.[index]?.assetId ?? null,
    assetKind: input.visuals?.[index]?.assetKind ?? null,
  }));
  return {
    version: 3, format: "live_voom_composition", aspectRatio: "9:16",
    durationMs: scenes.reduce((sum, scene) => sum + scene.durationMs, 0),
    brandName, concept, caption: clean(input.caption, 12000), usesAsset: input.usesAsset,
    scenes, producedAt: input.producedAt ?? new Date().toISOString(),
  };
}

export function isReelComposition(value: unknown): value is AnyReelComposition {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const baseOk = item.format === "live_voom_composition" && item.aspectRatio === "9:16"
    && typeof item.durationMs === "number" && item.durationMs > 0
    && Array.isArray(item.scenes) && item.scenes.length >= 2
    && item.scenes.every((scene) => Boolean(scene) && typeof (scene as { text?: unknown }).text === "string" && typeof (scene as { durationMs?: unknown }).durationMs === "number");
  if (!baseOk) return false;
  if (item.version === 2 || item.version === 3) return (item.scenes as Array<{ role?: unknown }>).every((scene) => scene.role === "hook" || scene.role === "message" || scene.role === "value" || scene.role === "cta");
  if (item.version === 1) return (item.scenes as Array<{ role?: unknown }>).every((scene) => scene.role === "hook" || scene.role === "body" || scene.role === "cta");
  return false;
}

function clip(value: string, role: ReelSceneRole) {
  const maxWords = role === "hook" ? 8 : role === "cta" ? 6 : 10;
  const maxChars = role === "hook" ? 52 : role === "cta" ? 46 : 76;
  let capped = String(value ?? "").replace(/\s+/g, " ").trim().split(/\s+/).slice(0, maxWords).join(" ");
  if (capped.length > maxChars) capped = capped.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return capped.trim();
}

function clean(value: string, max: number) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
