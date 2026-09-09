/**
 * MARA video generation and the existing publish pipeline.
 *
 * The requirement: generated assets feed the EXISTING pipeline unchanged —
 * draft -> approval -> schedule -> instagram_publish_queue -> cron -> Meta.
 * Video generation must attach through the same private-asset seam as
 * uploads and image generation, and nothing in the video path may publish.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("generated video enters the pipeline through the same asset seam as uploads", async () => {
  const ports = await read("lib/mara/video-ports.ts");
  // The attach is putPostAsset (post_draft_assets, origin 'mara') — the exact
  // seam the upload and image-generation paths use. Nothing else writes
  // draft assets on the video path.
  assert.match(ports, /putPostAsset\(admin, ownerId, draftId/);
  assert.match(ports, /origin: "mara"/);
  assert.match(ports, /removePostAssetObject\(admin, ownerId, storagePath\)/, "cleanup uses the existing guarded remover");
  const orchestrator = await read("lib/mara/video-generation.ts");
  assert.match(orchestrator, /storeFinalAsset/, "the orchestrator only ever attaches through the port");
  // Validation precedes storage: the bytes must pass before they are stored.
  const validateAt = orchestrator.indexOf("validateGeneratedVideo(media.bytes");
  const storeAt = orchestrator.indexOf("ports.storeFinalAsset(");
  assert.ok(validateAt > -1 && storeAt > -1 && validateAt < storeAt, "validate before store");
  // And the old asset is removed only after the new object is stored.
  const removedAt = orchestrator.indexOf("stored.previousStoragePath");
  assert.ok(removedAt > storeAt, "previous asset removed only after the new one is stored");
});

test("the publish pipeline never reads the video generation records", async () => {
  const queue = await read("lib/instagram/publish-queue.ts");
  const publishing = await read("lib/instagram/publishing.ts");
  for (const source of [queue, publishing]) {
    assert.doesNotMatch(source, /mara_media_generations/, "publishing is driven by draft + asset state, not generation rows");
    assert.doesNotMatch(source, /video-generation|video-service|video-ports|video-job/, "no video-module imports into the publish path");
  }
});

test("no video route or module publishes anywhere", async () => {
  const files = [
    "app/api/posts/[id]/generate/route.ts",
    "app/api/posts/[id]/generation/route.ts",
    "app/api/reels/produce/[actionId]/route.ts",
    "lib/mara/video-generation.ts",
    "lib/mara/video-ports.ts",
    "lib/mara/video-service.ts",
    "lib/mara/video-job.ts",
    "lib/mara/video-view.ts",
    "lib/media/video-provider.ts",
  ];
  for (const path of files) {
    const source = await read(path);
    assert.doesNotMatch(source, /instagram_publish_queue/, `${path} must not write the publish queue`);
    assert.doesNotMatch(source, /graph\.facebook\.com|graph\.instagram|instagram\.com\/api/i, `${path} must not call Meta`);
  }
  const produce = await read("app/api/reels/produce/[actionId]/route.ts");
  const service = await read("lib/mara/video-service.ts");
  assert.match(service, /Nothing was published\./, "the shared start entry tells the user nothing was published");
  assert.match(produce, /Nothing was published/i);
  assert.match(produce, /productionStatus: "produced"/);
});

test("regeneration semantics: one entry point, safe unconfigured state, atomic replace", async () => {
  const service = await read("lib/mara/video-service.ts");
  assert.match(service, /Create with MARA is temporarily unavailable\. Your previous asset is unchanged\./);
  assert.match(service, /videoIdempotencyKey\("post", post\.id, args\.idempotencyToken\)/);
  assert.match(service, /durationTarget: 8/);
  const generate = await read("app/api/posts/[id]/generate/route.ts");
  // The video branch runs BEFORE the image guards, and non-reel/story kinds
  // are refused for video truthfully.
  const wantsVideoAt = generate.indexOf('wantsVideo');
  const imageGuardAt = generate.indexOf('No visual was attached');
  assert.ok(wantsVideoAt > -1 && imageGuardAt > -1 && wantsVideoAt < imageGuardAt, "video branch precedes the image path");
  assert.match(generate, /MARA generates video for Reels and Stories\. Use the Post flow for feed images\./);
  assert.match(generate, /body\.media === "video"/);
  const generation = await read("app/api/posts/[id]/generation/route.ts");
  assert.match(generation, /action !== "regenerate"/);
  assert.match(generation, /action === "cancel"/);
  assert.match(generation, /already running with the provider/);
});

test("story and reel video share the same 9:16 pipeline with per-kind duration bounds", async () => {
  const orchestrator = await read("lib/mara/video-generation.ts");
  assert.match(orchestrator, /kind === "reel" \? \{ min: 4, max: 15 \} : \{ min: 3, max: 30 \}/);
  assert.match(orchestrator, /aspectMatches\(inspection\.width, inspection\.height, "9:16"\)/);
  const plan = await read("lib/mara/media-plan.ts");
  assert.match(plan, /durationSeconds: z\.number\(\)\.int\(\)\.min\(4\)\.max\(15\)/);
  assert.match(plan, /durationSeconds: z\.number\(\)\.int\(\)\.min\(3\)\.max\(15\)/);
  // Voom-controlled overlay: the provider prompt never carries the business's
  // text, which is applied deterministically by Voom instead.
  assert.match(plan, /Do NOT ask for readable text/);
});
