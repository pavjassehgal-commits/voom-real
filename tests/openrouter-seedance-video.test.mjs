/**
 * OpenRouter Seedance video adapter tests.
 *
 * Every provider call is intercepted with an in-memory fetch. These tests prove
 * the request shape, durable handle reuse, authenticated MP4 download and
 * capability preflight without contacting OpenRouter or generating paid media.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configModule = await import("../lib/media/video-config.ts");
const providerModule = await import("../lib/media/video-provider.ts");
const generation = await import("../lib/mara/video-generation.ts");
const root = new URL("../", import.meta.url);

const MODEL = "bytedance/seedance-2.0-mini";
const API_KEY = "server-openrouter-test-key";
const BASE_URL = "https://openrouter.ai/api/v1";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function mp4Bytes({ width = 720, height = 1280, durationSeconds = 6, timescale = 1000 } = {}) {
  const u32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0);
    return buffer;
  };
  const box = (type, payload) => Buffer.concat([u32(8 + payload.length), Buffer.from(type, "ascii"), payload]);
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "ascii"), u32(0x200)]));
  const units = Math.round(durationSeconds * timescale);
  const mvhd = box("mvhd", Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(units)]));
  const hdlr = box("hdlr", Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(0), Buffer.from("vide", "ascii")]));
  const mdhd = box("mdhd", Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(units)]));
  const mdia = box("mdia", Buffer.concat([hdlr, mdhd]));
  const tkhdPayload = Buffer.alloc(24);
  u32(width << 16).copy(tkhdPayload, 16);
  u32(height << 16).copy(tkhdPayload, 20);
  const trak = box("trak", Buffer.concat([mdia, box("tkhd", tkhdPayload)]));
  const moov = box("moov", Buffer.concat([mvhd, trak]));
  return new Uint8Array(Buffer.concat([ftyp, moov, Buffer.from("mdat-filler")]));
}

function videoConfig(overrides = {}) {
  return configModule.getVideoConfig({
    VIDEO_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: API_KEY,
    ...overrides,
  });
}

function modelCatalog(overrides = {}) {
  return {
    id: MODEL,
    supported_durations: [4, 6, 8],
    supported_resolutions: ["720p", "1080p"],
    supported_aspect_ratios: ["9:16", "16:9"],
    supported_frame_images: ["first_frame"],
    ...overrides,
  };
}

async function withFakeFetch(handler, callback) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers ?? {});
    calls.push({ url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return handler({ url, init, headers, calls });
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("OpenRouter video config selects Seedance with the V1 production defaults", () => {
  const config = videoConfig();
  assert.equal(config.provider, "openrouter");
  assert.equal(config.apiKey, API_KEY);
  assert.equal(config.baseUrl, BASE_URL);
  assert.equal(config.model, MODEL);
  assert.equal(config.resolution, "720p");
  assert.equal(config.durationSeconds, 6);
  assert.equal(config.supportsImageToVideo, true);
  assert.equal(config.supportsTextToVideo, true);
});

test("text-to-video submits exactly once to /api/v1/videos with the V1 request", async () => {
  const provider = providerModule.createVideoProvider(videoConfig());
  const result = await withFakeFetch(({ url, init }) => {
    if (url === `${BASE_URL}/videos/models`) return jsonResponse({ data: [modelCatalog()] });
    if (url === `${BASE_URL}/videos`) {
      assert.equal(init.method, "POST");
      return jsonResponse({ id: "job-text-1", polling_url: `${BASE_URL}/videos/job-text-1`, status: "pending" }, 202);
    }
    throw new Error(`unexpected network call: ${url}`);
  }, async (calls) => {
    const created = await provider.createVideoJob({
      prompt: "A product rotates gently in warm studio light.",
      aspectRatio: "9:16",
      durationSeconds: 8,
      referenceImage: null,
      name: "Voom Reel",
    });
    return { created, calls };
  });

  assert.deepEqual(result.created, {
    providerJobId: "job-text-1",
    pollingUrl: `${BASE_URL}/videos/job-text-1`,
    providerStatus: "pending",
  });
  const post = result.calls.find((call) => call.url === `${BASE_URL}/videos`);
  assert.ok(post, "the paid request uses the dedicated video endpoint");
  assert.equal(post.body.model, MODEL);
  assert.equal(post.body.duration, 6, "OpenRouter V1 pins the default duration to six seconds");
  assert.equal(post.body.resolution, "720p");
  assert.equal(post.body.aspect_ratio, "9:16");
  assert.equal(post.body.generate_audio, false);
  assert.equal("frame_images" in post.body, false, "text-only generation does not invent a reference image");
  for (const call of result.calls) assert.equal(call.headers.get("authorization"), `Bearer ${API_KEY}`);
});

test("reference-image generation uses the first-frame path and capability preflight", async () => {
  const provider = providerModule.createVideoProvider(videoConfig());
  const result = await withFakeFetch(({ url }) => {
    if (url === `${BASE_URL}/videos/models`) return jsonResponse({ data: [modelCatalog()] });
    if (url === `${BASE_URL}/videos`) return jsonResponse({ id: "job-image-1", polling_url: `${BASE_URL}/videos/job-image-1`, status: "pending" }, 202);
    throw new Error(`unexpected network call: ${url}`);
  }, async (calls) => {
    await provider.createVideoJob({
      prompt: "Animate the supplied first frame with a subtle push-in.",
      aspectRatio: "9:16",
      durationSeconds: 6,
      referenceImage: {
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mimeType: "image/png",
        extension: "png",
        name: "private-source.png",
        url: "https://storage.example.test/signed/private-source.png?token=short-lived",
      },
      name: "Voom Reel",
    });
    return calls;
  });

  const post = result.find((call) => call.url === `${BASE_URL}/videos`);
  assert.deepEqual(post.body.frame_images, [{
    type: "image_url",
    image_url: { url: "https://storage.example.test/signed/private-source.png?token=short-lived" },
    frame_type: "first_frame",
  }]);
  assert.equal(post.body.duration, 6);
  assert.equal(post.body.generate_audio, false);
  assert.equal("bytes" in post.body, false, "private image bytes are never embedded in the provider JSON");
});

test("unsupported capability fails before the billable POST", async () => {
  const provider = providerModule.createVideoProvider(videoConfig());
  const result = await withFakeFetch(({ url }) => {
    if (url === `${BASE_URL}/videos/models`) return jsonResponse({ data: [modelCatalog({ supported_durations: [4, 8] })] });
    if (url === `${BASE_URL}/videos`) throw new Error("the paid endpoint must not be reached");
    throw new Error(`unexpected network call: ${url}`);
  }, async (calls) => {
    await assert.rejects(
      provider.createVideoJob({ prompt: "prompt", aspectRatio: "9:16", durationSeconds: 6, referenceImage: null, name: "Voom" }),
      (error) => error.code === "rejected" && error.diagnostic?.http_status === 400,
    );
    return calls;
  });
  assert.equal(result.filter((call) => call.url === `${BASE_URL}/videos`).length, 0);
});

test("provider HTTP diagnostics preserve status/body safely and Retry-After without submitting", async () => {
  const provider = providerModule.createVideoProvider(videoConfig());
  const result = await withFakeFetch(({ url }) => {
    if (url === `${BASE_URL}/videos/models`) {
      return jsonResponse({ error: { code: 429, message: "Too many requests", status: "RATE_LIMITED" } }, 429, { "retry-after": "7" });
    }
    throw new Error(`the paid endpoint must not be reached: ${url}`);
  }, async (calls) => {
    await assert.rejects(
      provider.createVideoJob({ prompt: "prompt", aspectRatio: "9:16", durationSeconds: 6, referenceImage: null, name: "Voom" }),
      (error) => {
        assert.equal(error.code, "rate_limited");
        assert.equal(error.retryAfterMs, 7000);
        assert.equal(error.diagnostic.http_status, 429);
        assert.equal(error.diagnostic.provider_message, "Too many requests");
        return true;
      },
    );
    return calls;
  });
  assert.equal(result.filter((call) => call.url === `${BASE_URL}/videos`).length, 0);
});

test("polling reuses the persisted polling URL and downloads the first MP4 without resubmitting", async () => {
  const provider = providerModule.createVideoProvider(videoConfig());
  const bytes = mp4Bytes();
  const result = await withFakeFetch(({ url, init }) => {
    if (url === `${BASE_URL}/videos/job-complete`) {
      return jsonResponse({ id: "job-complete", polling_url: `${BASE_URL}/videos/job-complete`, status: "completed", unsigned_urls: ["https://cdn.example.test/not-used.mp4"] });
    }
    if (url === `${BASE_URL}/videos/job-complete/content?index=0`) {
      assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected network call: ${url}`);
  }, async (calls) => {
    const polled = await provider.pollVideoJob("job-complete", `${BASE_URL}/videos/job-complete`);
    return { polled, calls };
  });

  assert.equal(result.polled.kind, "complete");
  assert.deepEqual(result.polled.media.bytes, bytes);
  assert.equal(result.polled.media.mimeType, "video/mp4");
  assert.equal(result.calls.filter((call) => call.method === "POST").length, 0, "polling never submits a second paid job");
  assert.deepEqual(result.calls.map((call) => call.url), [
    `${BASE_URL}/videos/job-complete`,
    `${BASE_URL}/videos/job-complete/content?index=0`,
  ]);
});

test("MARA persists and reuses the provider job handle while polling", async () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  const state = { row: null, createCalls: 0, pollCalls: [] };
  const ports = {
    now: () => now,
    findActiveGeneration: async () => (state.row && ["queued", "generating", "processing"].includes(state.row.status) ? state.row : null),
    findGeneration: async (_owner, id) => state.row?.id === id ? state.row : null,
    findGenerationByIdempotency: async () => state.row,
    countRecentJobs: async () => 0,
    sumMonthlyVideoCost: async () => 0,
    insertGeneration: async (row) => { state.row = { ...row, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }; return "inserted"; },
    updateGeneration: async (_owner, id, patch, statuses) => {
      if (!state.row || state.row.id !== id || (statuses && !statuses.includes(state.row.status))) return null;
      state.row = { ...state.row, ...patch, updated_at: new Date(now).toISOString() };
      return state.row;
    },
    planMedia: async () => ({ concept: "C", visualPrompt: "vertical product frame", motionDirection: "slow push-in", durationSeconds: 8, overlayJson: null, cta: null }),
    generateBaseImage: async () => { throw new Error("not used"); },
    createVideoJob: async () => { state.createCalls += 1; return { providerJobId: "or-job-1", pollingUrl: `${BASE_URL}/videos/or-job-1`, providerStatus: "pending" }; },
    pollVideoJob: async (jobId, pollingUrl) => { state.pollCalls.push({ jobId, pollingUrl }); return { kind: "pending", providerStatus: "in_progress", pollingUrl }; },
    uploadBaseImage: async () => "unused",
    loadReferenceImage: async () => null,
    storeFinalAsset: async () => ({ storagePath: "unused", previousStoragePath: null }),
    removeAbandonedObject: async () => undefined,
    signPreview: async () => null,
  };
  const input = {
    ownerId: "owner-1", draftId: "draft-1", conversationId: "conversation-1", scope: "post", kind: "reel",
    concept: "concept", script: "script", brief: "", idempotencyKey: "video:post:draft-1:test",
    sourceAsset: null, providerName: "openrouter", supportsImageToVideo: false, estimatedCostUsd: null, monthlySpendLimitUsd: null,
  };

  const started = await generation.startVideoGeneration(ports, input);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(state.createCalls, 1);
  assert.equal(state.row.provider_job_id, "or-job-1");
  assert.equal(state.row.provider_polling_url, `${BASE_URL}/videos/or-job-1`);
  assert.equal(state.row.provider_status, "pending");

  const duplicateStart = await generation.startVideoGeneration(ports, input);
  assert.equal(duplicateStart.ok, false);
  assert.equal(duplicateStart.status, 409);
  assert.equal(state.createCalls, 1, "an active retry never submits another paid job");

  const advanced = await generation.advanceVideoGeneration(ports, "owner-1", state.row.id, "reel");
  assert.equal(advanced.ok, true);
  assert.deepEqual(state.pollCalls, [{ jobId: "or-job-1", pollingUrl: `${BASE_URL}/videos/or-job-1` }]);
  assert.equal(state.createCalls, 1, "polling reuses the persisted provider job");
  assert.equal(state.row.provider_status, "in_progress");
});

test("Magic Hour remains a selectable fallback implementation", () => {
  const magic = configModule.getVideoConfig({ VIDEO_PROVIDER: "magic-hour", VIDEO_API_KEY: "magic-hour-test" });
  const provider = providerModule.createVideoProvider(magic);
  assert.equal(provider.name, "magic-hour");
  assert.equal(provider.supportsImageToVideo, true);
  assert.equal(provider.supportsTextToVideo, true);
});

test("the provider implementation is server-only and does not log the key", async () => {
  const source = await readFile(new URL("lib/media/video-provider.ts", root), "utf8");
  assert.doesNotMatch(source, /NEXT_PUBLIC_OPENROUTER_API_KEY/);
  assert.doesNotMatch(source, /console\.(log|error|warn)/);
  assert.match(source, /Authorization: `Bearer \$\{this\.config\.apiKey\}`/);
});
