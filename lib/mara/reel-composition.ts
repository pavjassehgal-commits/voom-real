export interface ReelScene { role: "hook" | "body" | "cta"; text: string; durationMs: number; }
export interface ReelComposition { version: 1; format: "live_voom_composition"; aspectRatio: "9:16"; durationMs: number; brandName: string; concept: string; caption: string; usesAsset: boolean; scenes: ReelScene[]; producedAt: string; }

export function buildReelComposition(input: { concept: string; script: string; caption: string; brandName: string; usesAsset: boolean; producedAt?: string }): ReelComposition {
  const concept = clean(input.concept, 180) || "A useful idea from Voom";
  const script = clean(input.script, 1200) || concept;
  const parts = script.split(/(?<=[.!?])\s+|\n+/).map((part) => clean(part, 180)).filter(Boolean);
  const hook = parts[0] && parts[0].toLowerCase() !== concept.toLowerCase() ? parts[0] : concept;
  const body = parts.slice(hook === parts[0] ? 1 : 0).join(" ") || script;
  const brandName = clean(input.brandName, 80) || "Voom business";
  const scenes: ReelScene[] = [
    { role: "hook", text: hook, durationMs: 3500 },
    { role: "body", text: clean(body, 260), durationMs: 5000 },
    { role: "cta", text: `Follow ${brandName} for more.`, durationMs: 3000 },
  ];
  return { version: 1, format: "live_voom_composition", aspectRatio: "9:16", durationMs: scenes.reduce((sum, scene) => sum + scene.durationMs, 0), brandName, concept, caption: clean(input.caption, 12000), usesAsset: input.usesAsset, scenes, producedAt: input.producedAt ?? new Date().toISOString() };
}

export function isReelComposition(value: unknown): value is ReelComposition {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReelComposition>;
  return item.version === 1 && item.format === "live_voom_composition" && item.aspectRatio === "9:16" && typeof item.durationMs === "number" && item.durationMs > 0 && Array.isArray(item.scenes) && item.scenes.length >= 2 && item.scenes.every((scene) => typeof scene?.text === "string" && typeof scene?.durationMs === "number");
}

function clean(value: string, max: number) { return value.replace(/\s+/g, " ").trim().slice(0, max); }
