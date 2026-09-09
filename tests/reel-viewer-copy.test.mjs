import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const SWIMWEAR = {
  concept: "Affordable swimwear for families",
  caption: "Summer is here and family swimwear is ready. Comfortable fits for kids and parents, made for pool days, beach trips and sunny weekends. Find your summer fit → #familytime #swimwear",
  brandName: "Decathlon",
};

const INTERNAL = /opening shot|quick cuts|close[- ]?up|end frame|shot\b|scene\b|frame\b|camera\b|face\s*\/|cta\b|call to action/i;

test("fallback viewer copy is short, viewer-facing and never leaks production direction", async () => {
  const { fallbackViewerCopy, isInternalDirection } = await import("../lib/mara/reel-copy.ts");
  const copy = fallbackViewerCopy(SWIMWEAR);
  assert.deepEqual(Object.keys(copy).sort(), ["cta", "hook", "message", "value"]);
  assert.equal(copy.hook, "Summer is here and family swimwear is ready.");
  assert.equal(copy.cta, "Find your summer fit →");
  assert.equal(copy.value, "Affordable swimwear for families");
  for (const line of Object.values(copy)) {
    assert.equal(isInternalDirection(line), false, `internal direction leaked: ${line}`);
    assert.doesNotMatch(line, INTERNAL);
    assert.doesNotMatch(line, /#|https?:/);
    assert.ok(line.length <= 76, `too long: ${line}`);
  }
});

test("educational MARA-only fallback works without an uploaded asset", async () => {
  const { fallbackViewerCopy, isInternalDirection } = await import("../lib/mara/reel-copy.ts");
  const copy = fallbackViewerCopy({ concept: "Three coffee storage tips", caption: "Keep beans in an airtight jar. Store them away from heat and light. Follow for more brewing tips.", brandName: "Synthetic Café" });
  assert.equal(copy.hook, "Keep beans in an airtight jar.");
  assert.equal(copy.message, "Store them away from heat and light.");
  assert.equal(copy.value, "Three coffee storage tips");
  assert.equal(copy.cta, "Follow for more brewing tips.");
  assert.equal(Object.values(copy).every((line) => !isInternalDirection(line)), true);
  const noCaption = fallbackViewerCopy({ concept: "Three coffee storage tips", caption: "", brandName: "Synthetic Café" });
  assert.equal(noCaption.hook, "Three coffee storage tips");
  assert.equal(Object.values(noCaption).every((line) => !isInternalDirection(line)), true);
});

test("enforceViewerCopy replaces poisoned AI copy with the deterministic fallback", async () => {
  const { enforceViewerCopy, fallbackViewerCopy, isInternalDirection } = await import("../lib/mara/reel-copy.ts");
  const poisoned = enforceViewerCopy(
    { hook: "Opening shot of a sunny poolside", message: "Quick cuts of kids and parents wearing swimwear", value: "Close-up of fabric texture", cta: "End frame with store location and CTA" },
    SWIMWEAR,
  );
  assert.deepEqual(poisoned, fallbackViewerCopy(SWIMWEAR));
  assert.equal(Object.values(poisoned).every((line) => !isInternalDirection(line)), true);
  const partial = enforceViewerCopy({ hook: "Opening shot", message: "Comfortable fits", value: "Affordable swimwear", cta: "Find your summer fit →" }, SWIMWEAR);
  assert.equal(Object.values(partial).every((line) => !isInternalDirection(line)), true);
});

test("composition v3 has four short viewer scenes inside 8-15 seconds", async () => {
  const { buildReelComposition, isReelComposition } = await import("../lib/mara/reel-composition.ts");
  const { fallbackViewerCopy } = await import("../lib/mara/reel-copy.ts");
  const composition = buildReelComposition({ concept: SWIMWEAR.concept, caption: SWIMWEAR.caption, brandName: SWIMWEAR.brandName, usesAsset: true, producedAt: "2026-08-30T10:00:00.000Z", viewerCopy: fallbackViewerCopy(SWIMWEAR) });
  assert.equal(composition.version, 3);
  assert.equal(composition.aspectRatio, "9:16");
  assert.equal(composition.scenes.length, 4);
  assert.deepEqual(composition.scenes.map((scene) => scene.role), ["hook", "message", "value", "cta"]);
  assert.deepEqual(composition.scenes.map((scene) => scene.durationMs), [2500, 3000, 3000, 3000]);
  assert.equal(composition.durationMs, 11500);
  assert.ok(composition.durationMs >= 8000 && composition.durationMs <= 15000);
  for (const scene of composition.scenes) {
    assert.ok(scene.text.length > 0);
    assert.ok(scene.text.split(" ").length <= 10, `${scene.role} too long: ${scene.text}`);
    assert.doesNotMatch(scene.text, INTERNAL);
    assert.doesNotMatch(scene.text, /#|https?:/);
  }
  assert.equal(isReelComposition(composition), true);
});

test("legacy v1 compositions remain playable and malformed values are rejected", async () => {
  const { isReelComposition } = await import("../lib/mara/reel-composition.ts");
  const legacy = {
    version: 1, format: "live_voom_composition", aspectRatio: "9:16", durationMs: 11500, brandName: "X", concept: "C", caption: "c", usesAsset: false,
    scenes: [{ role: "hook", text: "a", durationMs: 3500 }, { role: "body", text: "b", durationMs: 5000 }, { role: "cta", text: "c", durationMs: 3000 }],
    producedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(isReelComposition(legacy), true);
  assert.equal(isReelComposition({ ...legacy, version: 3 }), false);
  assert.equal(isReelComposition({ ...legacy, scenes: [{ role: "message", text: "x", durationMs: 1000 }] }), false);
  assert.equal(isReelComposition(null), false);
});

test("produce route generates text-only viewer copy with AI fallback and persists the composition", async () => {
  const [route, player, css, composition] = await Promise.all([
    read("app/api/reels/produce/[actionId]/route.ts"),
    read("components/voom/operating/ReelCompositionPlayer.tsx"),
    read("app/globals.css"),
    read("lib/mara/reel-composition.ts"),
  ]);
  assert.match(route, /createAiProvider/);
  assert.match(route, /provider\.structured/);
  assert.match(route, /viewerCopySchema\.parse/);
  assert.match(route, /enforceViewerCopy/);
  assert.match(route, /fallbackViewerCopy/);
  assert.match(route, /internalScriptForInterpretationOnly/);
  assert.match(route, /reelComposition: composition/);
  assert.match(route, /productionStatus: "produced"/);
  assert.match(route, /eq\("owner_user_id", user\.id\)/);
  assert.match(route, /reel_draft_assets/);
  // The AI copywriter receives textual context only — never private asset bytes.
  assert.doesNotMatch(route, /base64|Uint8Array|asset\.bytes/);
  // A signed URL may appear only as the short-TTL owner-scoped preview of a
  // generated video in the status GET — never in the AI prompt or action row.
  assert.match(route, /createSignedUrl\(generation\.storage_path, 600\)/);
  // The composition builder must not accept the internal script at all.
  assert.doesNotMatch(composition, /script: String|script\s*:\s*input/);
  assert.match(composition, /viewerCopy/);
  assert.doesNotMatch(composition, /^import\s+(?!type\b)/m);
  assert.match(player, /viewer-facing scenes/);
  assert.match(player, /voom-reel-kenburns/);
  assert.match(player, /objectPosition/);
  assert.match(player, /sharedVideoRef|sceneVideoRefs/);
  assert.match(player, /Produced inside Voom · Not published/);
  assert.match(player, /Play Reel/);
  assert.match(player, /aspect-\[9\/16\]/);
  assert.match(css, /@keyframes voom-reel-kenburns-a/);
  assert.match(css, /@keyframes voom-reel-kenburns-d/);
  assert.match(css, /@keyframes voom-reel-text-pop/);
  assert.doesNotMatch(route + player, /instagram|publish_jobs|generateVideo|setTimeout/);
});
