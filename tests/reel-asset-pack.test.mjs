import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const asset = (id, kind) => ({ id, mimeType: kind === "image" ? "image/jpeg" : "video/mp4", kind });

test("asset pack limit is six and invalid mime kinds are rejected", async () => {
  const { REEL_ASSET_PACK_LIMIT } = await import("../lib/media/reel-asset.ts");
  const { assetKindForMime } = await import("../lib/mara/reel-visuals.ts");
  assert.equal(REEL_ASSET_PACK_LIMIT, 6);
  assert.equal(assetKindForMime("image/jpeg"), "image");
  assert.equal(assetKindForMime("image/png"), "image");
  assert.equal(assetKindForMime("image/webp"), "image");
  assert.equal(assetKindForMime("video/mp4"), "video");
  assert.equal(assetKindForMime("video/quicktime"), "video");
  assert.equal(assetKindForMime("application/pdf"), null);
});

test("MARA assigns one, two, three, and four-plus assets deterministically", async () => {
  const { assignReelVisuals } = await import("../lib/mara/reel-visuals.ts");
  const one = assignReelVisuals([asset("a", "image")]);
  assert.deepEqual(one.map((item) => item.assetId), ["a", "a", "a", "a"]);
  const two = assignReelVisuals([asset("a", "image"), asset("b", "image")]);
  assert.deepEqual(two.map((item) => item.assetId), ["a", "b", "b", "a"]);
  const three = assignReelVisuals([asset("a", "image"), asset("b", "image"), asset("c", "image")]);
  assert.deepEqual(three.map((item) => item.assetId), ["a", "b", "c", "a"]);
  const four = assignReelVisuals([asset("a", "image"), asset("b", "image"), asset("c", "image"), asset("d", "image")]);
  assert.deepEqual(four.map((item) => item.assetId), ["a", "b", "c", "d"]);
  const six = assignReelVisuals([asset("a", "image"), asset("b", "image"), asset("c", "image"), asset("d", "image"), asset("e", "image"), asset("f", "image")]);
  assert.deepEqual(six.map((item) => item.assetId), ["a", "b", "c", "d"]);
  assert.equal(six.every((item) => item.assetKind === "image"), true);
  assert.equal(assignReelVisuals([]).every((item) => item.assetId === null), true);
});

test("CTA scene prefers the first uploaded image", async () => {
  const { assignReelVisuals } = await import("../lib/mara/reel-visuals.ts");
  const videoFirst = assignReelVisuals([asset("v", "video"), asset("i", "image")]);
  assert.equal(videoFirst[3].assetId, "i");
  assert.equal(videoFirst[3].assetKind, "image");
  const videoOnly = assignReelVisuals([asset("v", "video"), asset("w", "video")]);
  assert.deepEqual(videoOnly.map((item) => item.assetId), ["v", "w", "w", "v"]);
});

test("mixed pack and video-first assignment keep distinct visuals per scene", async () => {
  const { assignReelVisuals } = await import("../lib/mara/reel-visuals.ts");
  const pack = assignReelVisuals([asset("v", "video"), asset("a", "image"), asset("b", "image")]);
  assert.equal(new Set(pack.map((item) => item.assetId)).size, 3);
  assert.equal(pack[3].assetKind, "image");
});

test("composition v3 persists MARA's per-scene asset assignment and legacy versions stay readable", async () => {
  const { buildReelComposition, isReelComposition } = await import("../lib/mara/reel-composition.ts");
  const { assignReelVisuals } = await import("../lib/mara/reel-visuals.ts");
  const visuals = assignReelVisuals([asset("a", "image"), asset("b", "image"), asset("c", "image"), asset("d", "image")]);
  const composition = buildReelComposition({
    concept: "Affordable swimwear for families", caption: "Summer is here. Find your summer fit →", brandName: "Decathlon", usesAsset: true, viewerCopy: { hook: "Summer is here", message: "Swimwear for the whole family", value: "Comfortable and affordable", cta: "Find your summer fit →" }, visuals, producedAt: "2026-08-30T10:00:00.000Z",
  });
  assert.equal(composition.version, 3);
  assert.deepEqual(composition.scenes.map((scene) => scene.assetId), ["a", "b", "c", "d"]);
  assert.deepEqual(composition.scenes.map((scene) => scene.assetKind), ["image", "image", "image", "image"]);
  assert.equal(isReelComposition(composition), true);
  const legacyV2 = { ...composition, version: 2 };
  assert.equal(isReelComposition(legacyV2), true);
  const legacyV1 = { version: 1, format: "live_voom_composition", aspectRatio: "9:16", durationMs: 11500, brandName: "X", concept: "C", caption: "c", usesAsset: false, scenes: [{ role: "hook", text: "a", durationMs: 3500 }, { role: "body", text: "b", durationMs: 5000 }, { role: "cta", text: "c", durationMs: 3000 }], producedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(isReelComposition(legacyV1), true);
  assert.equal(isReelComposition({ ...composition, version: 9 }), false);
});

test("asset routes: pack list is ordered, add enforces six, delete is owner-scoped", async () => {
  const [getPost, remove, helper, migration] = await Promise.all([
    read("app/api/reels/assets/[actionId]/route.ts"),
    read("app/api/reels/assets/[actionId]/[assetId]/route.ts"),
    read("lib/media/reel-asset-server.ts"),
    read("supabase/migrations/0017_reel_asset_pack.sql"),
  ]);
  assert.match(helper, /order\("created_at"\)/);
  assert.match(helper, /order\("id"\)/);
  assert.match(helper, /\.limit\(REEL_ASSET_PACK_LIMIT\)/);
  assert.match(helper, /createSignedUrl\(row\.storage_path, REEL_ASSET_SIGNED_TTL_SECONDS\)/);
  assert.match(getPost, /add_reel_draft_asset/);
  assert.match(getPost, /replace_reel_draft_asset/);
  assert.match(getPost, /currentCount >= REEL_ASSET_PACK_LIMIT/);
  assert.match(getPost, /asset_pack_full/);
  assert.match(getPost, /This Reel already has \$\{REEL_ASSET_PACK_LIMIT\} assets/);
  assert.match(getPost, /randomUUID\(\)/);
  assert.match(getPost, /detectReelAsset\(bytes, \{ name: file\.name \}\)/);
  assert.match(remove, /remove_reel_draft_asset/);
  assert.match(remove, /asset_not_found/);
  assert.match(remove, /That asset was not found for this Reel/);
  assert.match(remove, /p_owner_user_id: context\.userId/);
  assert.match(remove, /p_asset_id: assetId/);
  assert.match(remove, /storage\.from\(REEL_ASSET_BUCKET\)\.remove\(\[storagePath\]\)/);
  assert.doesNotMatch(getPost + remove, /NEXT_PUBLIC.*SECRET|publish|instagram|generateVideo/);
  assert.match(migration, /-- PREPARED ONLY/);
  assert.match(migration, /v_count >= 6 then raise exception 'asset_pack_full'/);
  assert.match(migration, /select rda\.storage_path into v_storage from public\.reel_draft_assets rda where/);
  assert.doesNotMatch(migration, /select storage_path into v_storage from public\.reel_draft_assets where/);
  assert.match(migration, /grant execute on function public\.add_reel_draft_asset.*to service_role/);
  assert.match(migration, /grant execute on function public\.remove_reel_draft_asset.*to service_role/);
  assert.match(migration, /revoke all on function public\.add_reel_draft_asset.*from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.remove_reel_draft_asset.*from public, anon, authenticated/);
  assert.doesNotMatch(migration, /grant .*insert.*authenticated|grant .*delete.*authenticated/);
  assert.match(migration, /Existing rows are preserved as-is/);
});

test("produce route assembles the pack into visuals without sending media to AI", async () => {
  const [route, player, board] = await Promise.all([
    read("app/api/reels/produce/[actionId]/route.ts"),
    read("components/voom/operating/ReelCompositionPlayer.tsx"),
    read("components/voom/operating/ApprovalsBoard.tsx"),
  ]);
  assert.match(route, /assignReelVisuals/);
  assert.match(route, /assetKindForMime/);
  assert.match(route, /assetCount: assetPack\.length/);
  assert.match(route, /reelComposition: composition/);
  assert.doesNotMatch(route, /previewUrl|signedUrl|base64|Uint8Array|asset\.bytes/);
  assert.match(board, /of \{REEL_ASSET_PACK_LIMIT\} assets added/);
  assert.match(board, /Add another asset/);
  assert.match(board, /Replace asset/);
  assert.match(board, />Remove</);
  assert.match(player, /sceneAsset\(index\)/);
  assert.match(player, /transition-opacity duration-500/);
  assert.match(player, /sceneVideoRefs/);
  assert.match(player, /sharedVideo/);
  assert.match(player, /MARA automatically assembled your provided assets into the Reel/);
  assert.match(player, /Play Reel/);
  assert.match(player, /aspect-\[9\/16\]/);
});
