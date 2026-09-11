/**
 * Regression: Gemini image generation must request AND store JPEG.
 *
 * Production evidence: the image request reached
 * `POST https://generativelanguage.googleapis.com/v1beta/interactions` with
 * `response_format.mime_type: "image/png"` and Gemini answered HTTP 400 —
 *
 *   The value 'image/png' is not supported for 'response_format.mime_type'.
 *   Supported values: 'image/jpeg'.
 *
 * The key, endpoint, model and prompt were all accepted; the response format
 * alone failed every MARA-generated visual. `image/jpeg` is the only value the
 * endpoint supports, so that is what Voom asks for, what the decoded output is
 * declared as, and what the stored asset is typed and named.
 *
 * Post Studio's provider and routes stay read-as-text (see
 * tests/post-studio.test.mjs: no test may import and execute a provider), but
 * the request and filename rules below are EXTRACTED FROM THE SHIPPING SOURCE
 * AND EVALUATED, and every consumer of the stored asset is exercised for real.
 * No network, no credentials, no generated production media.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const insp = await import("../lib/media/media-inspect.ts");
const { detectReelAsset } = await import("../lib/media/reel-asset.ts");
const postCore = await import("../lib/post/core.ts");
const postServer = await import("../lib/post/server-data.ts");
const pub = await import("../lib/instagram/publishing.ts");
const visuals = await import("../lib/mara/reel-visuals.ts");
const gen = await import("../lib/mara/video-generation.ts");

const provider = await read("lib/media/provider.ts");
const generateRoute = await read("app/api/posts/[id]/generate/route.ts");
const mediaRoute = await read("app/api/mara/media/[id]/route.ts");

/** The Gemini adapter only — the OpenAI adapter is deliberately untouched. */
const geminiSource = provider.slice(provider.indexOf("class GeminiMediaProvider"), provider.indexOf("class OpenAiMediaProvider"));
const openAiEnd = provider.indexOf("class OpenRouterMediaProvider");
const openAiSource = openAiEnd === -1
  ? provider.slice(provider.indexOf("class OpenAiMediaProvider"))
  : provider.slice(provider.indexOf("class OpenAiMediaProvider"), openAiEnd);

// ---------------------------------------------------------------------------
// Fixtures: real container bytes + the provider's own base64 round-trip
// ---------------------------------------------------------------------------

const U16BE = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const U32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

/** SOI + JFIF APP0 + SOF0 carrying the dimensions + EOI: a structurally real JPEG. */
function jpeg(width, height) {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), U16BE(16), Buffer.from("JFIF\0", "binary"), Buffer.from([1, 1, 0, 0x48, 0, 0x48, 0, 0, 0]),
    Buffer.from([0xff, 0xc0]), U16BE(17), Buffer.from([8]), U16BE(height), U16BE(width), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    Buffer.from([0xff, 0xd9]),
  ]));
}

function png(width, height) {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    U32(13), Buffer.from("IHDR", "ascii"), U32(width), U32(height), Buffer.from([8, 2, 0, 0, 0]), Buffer.alloc(16),
  ]));
}

/** decodeMedia()'s transport: what the provider hands downstream is this exact round-trip. */
const viaProviderBase64 = (bytes) => new Uint8Array(Buffer.from(Buffer.from(bytes).toString("base64"), "base64"));

/**
 * Evaluate one object/expression from the shipping source instead of restating
 * it, so a regression in the code is a failure here.
 */
function evaluate(source, pattern, ...names) {
  const match = source.match(pattern);
  assert.ok(match, `the expected expression is still in the source: ${pattern}`);
  return (...args) => new Function(...names, `return (${match[1]});`)(...args);
}

// ---------------------------------------------------------------------------
// 1. The request that the endpoint rejects when it says PNG
// ---------------------------------------------------------------------------

test("the Gemini Interactions image request asks for image/jpeg for every format", () => {
  const responseFormat = evaluate(geminiSource, /response_format: (\{[^{}]*\})/, "input");

  for (const aspectRatio of ["1:1", "4:5", "9:16", "16:9"]) {
    assert.deepEqual(
      responseFormat({ aspectRatio }),
      { type: "image", mime_type: "image/jpeg", aspect_ratio: aspectRatio },
      `the ${aspectRatio} request carries the only supported mime_type`,
    );
  }

  // Endpoint, credential handling and the prompt shape are exactly as before.
  assert.match(geminiSource, /jsonRequest\(`\$\{this\.config\.baseUrl\}\/interactions`/);
  assert.match(geminiSource, /"x-goog-api-key": this\.config\.apiKey/);
  assert.match(geminiSource, /model: this\.config\.imageModel, input: \[\{ type: "text", text: input\.prompt \}\]/);

  // The request body itself never names PNG, and no new knob appeared.
  const request = geminiSource.split("\n").filter((line) => /response_format:\s*\{/.test(line));
  assert.equal(request.length, 1, "the Gemini image request declares exactly one response_format");
  assert.match(request[0], /mime_type: "image\/jpeg"/);
  assert.doesNotMatch(request[0], /image\/png/, "the image request never asks for PNG");
  assert.doesNotMatch(geminiSource, /responseModalities|generationConfig|imageGenerationConfig/);
});

test("the decoded Gemini output is declared JPEG, while the OpenAI adapter stays PNG", () => {
  // What the provider reports when the response carries its own mime_type,
  // and what it falls back to when it does not.
  const declared = evaluate(geminiSource, /decodeMedia\(image\.data, ([^)]+)\)/, "image");
  assert.equal(declared({ mimeType: "image/jpeg" }), "image/jpeg");
  assert.equal(declared({ mimeType: null }), "image/jpeg", "an undeclared response is still treated as JPEG");

  // The provider's declared value never replaces the byte sniffing downstream.
  assert.match(generateRoute, /result\.mimeType = inspected\.mimeType;/);

  // The other provider is untouched: OpenAI still returns PNG.
  assert.match(openAiSource, /return decodeMedia\(data, "image\/png"\);/);
  assert.match(openAiSource, /response_format: "b64_json"/);
});

// ---------------------------------------------------------------------------
// 2. Byte-level validation is unchanged — JPEG simply passes it
// ---------------------------------------------------------------------------

test("generated JPEG bytes pass Voom's byte-level checks for every Post and Story format", () => {
  const sizes = { "1:1": [1024, 1024], "4:5": [1080, 1350], "9:16": [1080, 1920], "16:9": [1920, 1080] };
  for (const [format, [width, height]] of Object.entries(sizes)) {
    const bytes = viaProviderBase64(jpeg(width, height));
    const inspected = insp.inspectImageBytes(bytes);
    assert.deepEqual(inspected, { mimeType: "image/jpeg", width, height }, "the bytes arrive as JPEG, byte for byte");
    assert.equal(insp.aspectMatches(inspected.width, inspected.height, format), true, `the ${format} draft accepts its own frame`);
  }

  // PNG handling itself is untouched — an overlay output or a user-uploaded
  // PNG asset is still recognised and named as PNG.
  const stillPng = viaProviderBase64(png(1080, 1350));
  assert.deepEqual(insp.inspectImageBytes(stillPng), { mimeType: "image/png", width: 1080, height: 1350 });
  assert.equal(detectReelAsset(stillPng)?.extension, "png");
});

test("byte validation is not weakened: non-images, junk and empty output still fail closed", () => {
  const junk = new TextEncoder().encode("this is definitely not a JPEG");
  assert.equal(insp.inspectImageBytes(junk), null, "the sniffing stage still rejects non-images");
  assert.equal(detectReelAsset(junk), null, "the storage detector still rejects non-images");
  assert.equal(insp.inspectImageBytes(new Uint8Array(0)), null, "empty output is still invalid");
  // A landscape JPEG never becomes a vertical draft asset.
  assert.equal(insp.aspectMatches(1920, 1080, "9:16"), false);

  // The size and malformed-response guards around the provider call are intact.
  assert.match(generateRoute, /GENERATED_IMAGE_MAX_BYTES = 20 \* 1024 \* 1024;/);
  assert.match(generateRoute, /if \(!result\.bytes\.length \|\| result\.bytes\.length > GENERATED_IMAGE_MAX_BYTES\) throw new MediaError\("malformed_response"\);/);
  assert.match(generateRoute, /if \(!inspected \|\| !aspectMatches\(inspected\.width, inspected\.height, format\)\) throw new MediaError\("malformed_response"\);/);
  assert.match(geminiSource, /throw new MediaError\("malformed_response"\);/);
  assert.match(provider, /if \(!response\.ok\) \{/);
  assert.match(provider, /parseProviderDiagnostic\(response\)/);
});

// ---------------------------------------------------------------------------
// 3. Storage: the generated asset is typed image/jpeg and named .jpg
// ---------------------------------------------------------------------------

test("the storage filename rule maps the JPEG output to a .jpg object name", () => {
  const postStudioExtension = evaluate(generateRoute, /const extension = (result\.mimeType[^;]*);/, "result");
  assert.equal(postStudioExtension({ mimeType: "image/jpeg" }), "jpg", "a generated JPEG is stored as .jpg");
  assert.equal(postStudioExtension({ mimeType: "image/png" }), "png", "other formats are unchanged");
  assert.equal(postStudioExtension({ mimeType: "image/webp" }), "webp");

  const mediaExtension = evaluate(mediaRoute, /const ext = (media\.mimeType[^;]*);/, "media");
  assert.equal(mediaExtension({ mimeType: "image/jpeg" }), "jpeg", "the media library names the object .jpeg");
  assert.equal(mediaExtension({ mimeType: "video/mp4" }), "mp4");
});

const OWNER = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";

function fakeAdmin(captured) {
  const chain = (selectResult) => {
    const node = { select: () => node, eq: () => node, maybeSingle: async () => selectResult };
    node.upsert = async (row) => { captured.row = row; return { error: null }; };
    return node;
  };
  return {
    from: (table) => {
      if (table === "mara_drafts") return chain({ data: { id: DRAFT, kind: "instagram_post" }, error: null });
      if (table === "post_draft_assets") return chain({ data: null, error: null });
      throw new Error(`unexpected table: ${table}`);
    },
    storage: {
      from: (bucket) => ({
        upload: async (path, bytes, options) => { captured.upload = { bucket, path, bytes, options }; return { error: null }; },
        remove: async (paths) => { captured.removed = paths; return { error: null }; },
      }),
    },
  };
}

test("the generated JPEG is stored privately as image/jpeg with a .jpg object name", async () => {
  const bytes = viaProviderBase64(jpeg(1080, 1350));
  const inspected = insp.inspectImageBytes(bytes);
  assert.ok(inspected);
  const postStudioExtension = evaluate(generateRoute, /const extension = (result\.mimeType[^;]*);/, "result");

  const captured = {};
  const stored = await postServer.putPostAsset(fakeAdmin(captured), OWNER, DRAFT, {
    bytes,
    mimeType: inspected.mimeType,
    extension: postStudioExtension({ mimeType: inspected.mimeType }),
    displayName: "MARA visual · test",
    origin: "mara",
  });

  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  assert.equal(stored.storagePath, `${OWNER}/post-assets/${digest}-${DRAFT}.jpg`);
  assert.match(stored.storagePath, /\.jpg$/, "the stored object carries a JPEG filename");

  // Stored byte-for-byte, with the JPEG content type.
  assert.equal(captured.upload.bucket, "mara-media");
  assert.equal(captured.upload.options.contentType, "image/jpeg");
  assert.equal(captured.upload.options.upsert, true);
  assert.deepEqual(Array.from(new Uint8Array(captured.upload.bytes)), Array.from(bytes));

  // The metadata row Voom writes says image/jpeg and is legal for production
  // 0021 — no migration is needed for this fix.
  assert.equal(captured.row.mime_type, "image/jpeg");
  assert.equal(captured.row.byte_size, bytes.length);
  assert.equal(captured.row.storage_path, stored.storagePath);
  assert.equal(postCore.isProductionPostDraftAssetWrite(captured.row), true);
  assert.equal(captured.removed, undefined, "a successful store removes nothing");

  // Draft attachment, preview and the Reel asset pack classify it as an image.
  assert.equal(postCore.postAssetKindForMime(captured.row.mime_type), "image");
  assert.equal(visuals.assetKindForMime(captured.row.mime_type), "image");

  const migration = await read("supabase/migrations/0021_instagram_post_studio.sql");
  assert.match(migration, /mime_type text not null check \(mime_type in \('image\/jpeg',/);
  assert.match(mediaRoute, /const path = `\$\{ownerId\}\/\$\{row\.id\}\/\$\{digest\}\.\$\{ext\}`;/);
  assert.match(mediaRoute, /contentType: media\.mimeType/);
  assert.match(mediaRoute, /mime_type: media\.mimeType/);
  const mediaSql = await read("supabase/migrations/0008_mara_media_generation.sql");
  assert.match(mediaSql, /mime_type text check \(mime_type is null or mime_type in \('image\/jpeg',/);
});

// ---------------------------------------------------------------------------
// 4. The Reel/Story video base frame follows the same JPEG output
// ---------------------------------------------------------------------------

function fakeVideoPorts(base) {
  const calls = { uploadBase: [], lastJobInput: null };
  let row = null;
  const ports = {
    now: () => Date.parse("2026-09-11T12:00:00Z"),
    findActiveGeneration: async () => null,
    findGeneration: async () => row,
    findGenerationByIdempotency: async () => null,
    countRecentJobs: async () => 0,
    sumMonthlyVideoCost: async () => 0,
    insertGeneration: async (r) => { row = { ...r, updated_at: new Date().toISOString() }; return "inserted"; },
    updateGeneration: async (_owner, _id, patch) => { row = { ...row, ...patch }; return row; },
    planMedia: async () => ({ concept: "C", visualPrompt: "a clean 9:16 frame", motionDirection: "slow push-in", durationSeconds: 8, overlayJson: null, cta: "cta" }),
    // Shaped exactly like the media provider's output for a JPEG response.
    generateBaseImage: async () => ({ bytes: base, mimeType: "image/jpeg" }),
    createVideoJob: async (input) => { calls.lastJobInput = input; return { providerJobId: "mh-123" }; },
    pollVideoJob: async () => ({ kind: "pending" }),
    uploadBaseImage: async (_owner, _draft, bytes, mimeType, extension) => {
      calls.uploadBase.push({ bytes, mimeType, extension });
      return `owner-1/generated-base/draft-1.${extension}`;
    },
    loadReferenceImage: async () => null,
    storeFinalAsset: async () => ({ storagePath: "owner-1/post-assets/final.mp4", previousStoragePath: null }),
    removeAbandonedObject: async () => undefined,
    signPreview: async () => null,
  };
  return { ports, calls, row: () => row };
}

const videoStart = (overrides = {}) => ({
  ownerId: "owner-1",
  draftId: "draft-1",
  conversationId: "conv-1",
  scope: "post",
  kind: "story",
  concept: "Story teaser",
  script: "",
  brief: "",
  idempotencyKey: "idem-1",
  sourceAsset: null,
  providerName: "magic-hour",
  supportsImageToVideo: true,
  estimatedCostUsd: null,
  monthlySpendLimitUsd: null,
  ...overrides,
});

test("a generated 9:16 JPEG base frame seeds the video job as a JPEG reference", async () => {
  const bytes = viaProviderBase64(jpeg(1080, 1920));
  const { ports, calls, row } = fakeVideoPorts(bytes);
  const result = await gen.startVideoGeneration(ports, videoStart());

  assert.equal(result.ok, true, "the Story video job is still created");
  assert.equal(row().generation_mode, "generated_image_to_video");
  assert.equal(row().status, "generating");
  assert.equal(row().provider_job_id, "mh-123");

  assert.equal(calls.uploadBase.length, 1);
  assert.equal(calls.uploadBase[0].mimeType, "image/jpeg");
  assert.equal(calls.uploadBase[0].extension, "jpg", "the base visual is stored with a .jpg filename");
  assert.deepEqual(Array.from(calls.uploadBase[0].bytes), Array.from(bytes), "the base visual is stored byte-for-byte");

  const reference = calls.lastJobInput.referenceImage;
  assert.equal(reference.mimeType, "image/jpeg");
  assert.equal(reference.extension, "jpg", "the video provider gets the JPEG extension hint, not a .png one");
  assert.equal(reference.name, "mara-base-draft-1.jpg");
  assert.deepEqual(Array.from(reference.bytes), Array.from(bytes));
});

test("a base frame that is not 9:16 is still rejected before any video job", async () => {
  const { ports, calls } = fakeVideoPorts(viaProviderBase64(jpeg(1080, 1080)));
  const result = await gen.startVideoGeneration(ports, videoStart());
  assert.equal(result.status, 503);
  assert.equal(result.errorCode, "invalid_output");
  assert.equal(calls.lastJobInput, null, "no provider job is created");
});

// ---------------------------------------------------------------------------
// 5. Publishing and regeneration keep working with a stored JPEG
// ---------------------------------------------------------------------------

test("Instagram publishing accepts the stored JPEG for Post and Story formats", () => {
  assert.equal(pub.publishMediaKindForMime("image/jpeg", "instagram_post"), "image");
  assert.equal(pub.publishMediaKindForMime("image/jpeg", "story"), "story");
  assert.equal(pub.publishMediaKindForMime("image/jpeg", "reel"), null, "a still image never publishes as a Reel");
  assert.equal(pub.isPublishableMime("image/jpeg"), true);
  assert.equal(pub.isVideoPublishMime("image/jpeg"), false);
});

test("a stored JPEG visual stays eligible for regeneration and the draft preview", async () => {
  // Asset-assisted regeneration reads the draft's stored asset and accepts it
  // only by mime type — a JPEG MARA visual must stay eligible.
  const service = await read("lib/mara/video-service.ts");
  const eligible = evaluate(service, /if \((mime !== "[^"]*"(?: && mime !== "[^"]*")*)\) return null;/, "mime");
  const isEligible = (mime) => !eligible(mime);
  assert.equal(isEligible("image/jpeg"), true, "a stored JPEG still seeds a regenerated video");
  assert.equal(isEligible("image/png"), true, "existing PNG assets keep working");
  assert.equal(isEligible("image/webp"), true);
  assert.equal(isEligible("video/mp4"), false);

  // The reference-image upload keeps the sniffed type and a matching name.
  const ports = await read("lib/mara/video-ports.ts");
  const referenceMime = evaluate(ports, /const mimeType = (detected\.mimeType[^;]*);/, "detected");
  const referenceExtension = evaluate(ports, /const extension = (detected\.mimeType[^;]*);/, "detected");
  assert.deepEqual(
    { mimeType: referenceMime({ mimeType: "image/jpeg" }), extension: referenceExtension({ mimeType: "image/jpeg" }) },
    { mimeType: "image/jpeg", extension: "jpg" },
  );
  assert.equal(referenceExtension({ mimeType: "image/png" }), "png");

  // The preview is a signed URL of the stored object, so it never depends on
  // the extension: preview, draft attachment and regeneration are unchanged.
  assert.match(await read("lib/post/server-data.ts"), /createSignedUrl\(String\(asset!\.storage_path\), POST_ASSET_SIGNED_TTL_SECONDS\)/);
  assert.match(await read("lib/media/data.ts"), /createSignedUrl\(row\.storage_path, 3600\)/);
});
