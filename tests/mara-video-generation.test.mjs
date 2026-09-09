/**
 * MARA video generation: the durable job state machine, exercised with fake
 * ports — no network, no Supabase, no provider. This is where the money and
 * the user's asset are protected:
 *
 *   - one active job per draft (duplicate protection, idempotency),
 *   - the provider job id persists BEFORE the job starts,
 *   - a failed / timed-out job never touches the draft's current asset,
 *   - the asset is replaced only after the new output is validated and stored,
 *   - provider metadata is never trusted (byte-level validation),
 *   - stale and crashed jobs are abandoned or reclaimed safely.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const gen = await import("../lib/mara/video-generation.ts");
const job = await import("../lib/mara/video-job.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const U32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
function mp4({ width = 1080, height = 1920, durationSeconds = 8, timescale = 1000 } = {}) {
  const box = (type, payload) => Buffer.concat([U32(8 + payload.length), Buffer.from(type, "ascii"), payload]);
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "ascii"), U32(0x200)]));
  const units = Math.round(durationSeconds * timescale);
  const mvhd = box("mvhd", Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), U32(0), U32(timescale), U32(units)]));
  const hdlr = box("hdlr", Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), Buffer.from("vide", "ascii")]));
  const mdhd = box("mdhd", Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), U32(0), U32(timescale), U32(units)]));
  const mdia = box("mdia", Buffer.concat([hdlr, mdhd]));
  const tkhdPayload = Buffer.alloc(24);
  U32(width << 16).copy(tkhdPayload, 16);
  U32(height << 16).copy(tkhdPayload, 20);
  const trak = box("trak", Buffer.concat([mdia, box("tkhd", tkhdPayload)]));
  const moov = box("moov", Buffer.concat([mvhd, trak]));
  return new Uint8Array(Buffer.concat([ftyp, moov, Buffer.from("mdat-filler")]));
}
function png(width, height) {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    U32(13), Buffer.from("IHDR", "ascii"), U32(width), U32(height), Buffer.from([8, 2, 0, 0, 0]), Buffer.alloc(16),
  ]));
}

const NOW = Date.parse("2026-09-09T12:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

function row(overrides = {}) {
  return {
    id: "gen-1",
    owner_user_id: "owner-1",
    draft_id: "draft-1",
    conversation_id: "conv-1",
    media_type: "video",
    generation_mode: null,
    prompt: "prompt",
    aspect_ratio: "9:16",
    status: "queued",
    provider: null,
    provider_job_id: null,
    storage_path: null,
    mime_type: null,
    byte_size: null,
    duration_seconds: 8,
    estimated_cost_usd: null,
    error_code: null,
    idempotency_key: "video:post:draft-1:t1",
    source_asset_id: null,
    overlay: null,
    started_at: null,
    attempt_count: 0,
    created_at: minutesAgo(1),
    updated_at: minutesAgo(0.5),
    completed_at: null,
    ...overrides,
  };
}

function fakePorts(overrides = {}) {
  const calls = { plan: 0, baseImage: 0, createJob: 0, poll: 0, insert: 0, update: [], store: 0, sign: 0, remove: [], loadRef: 0, uploadBase: 0 };
  const state = { active: null, byIdempotency: null, row: null, recentJobs: 0, spent: 0, pollResult: { kind: "pending" }, updateResult: undefined };
  const ports = {
    now: () => NOW,
    findActiveGeneration: async () => state.active,
    findGeneration: async (_owner, id) => (state.row && state.row.id === id ? state.row : null),
    findGenerationByIdempotency: async () => state.byIdempotency,
    countRecentJobs: async () => state.recentJobs,
    sumMonthlyVideoCost: async () => state.spent,
    insertGeneration: async (r) => { calls.insert += 1; state.row = { ...r, id: String(r.id) }; return overrides.insertResult ?? "inserted"; },
    updateGeneration: async (_owner, id, patch, where) => {
      calls.update.push({ id, patch, where });
      if (!state.row || state.row.id !== id) return null;
      if (where && !where.includes(state.row.status)) return null;
      state.row = { ...state.row, ...patch, updated_at: new Date(NOW).toISOString() };
      return state.row;
    },
    planMedia: async () => {
      calls.plan += 1;
      if (overrides.planThrows) throw Object.assign(new Error("plan"), { code: overrides.planThrows });
      return {
        concept: "C",
        visualPrompt: "a clean 9:16 frame",
        motionDirection: "slow push-in",
        durationSeconds: 8,
        overlayJson: JSON.stringify({ hook: "h" }),
        cta: "cta",
      };
    },
    generateBaseImage: async () => {
      calls.baseImage += 1;
      if (overrides.baseImageThrows) throw overrides.baseImageThrows;
      return { bytes: overrides.baseImageBytes ?? png(720, 1280), mimeType: "image/png", model: "test" };
    },
    createVideoJob: async (input) => {
      calls.createJob += 1;
      calls.lastJobInput = input;
      if (overrides.jobThrows) throw Object.assign(new Error("job"), { code: overrides.jobThrows });
      return { providerJobId: "mh-123" };
    },
    pollVideoJob: async () => {
      calls.poll += 1;
      if (overrides.pollThrows) throw Object.assign(new Error("poll"), { code: overrides.pollThrows });
      return state.pollResult;
    },
    uploadBaseImage: async () => { calls.uploadBase += 1; return "owner-1/generated-base/draft-1-x.png"; },
    loadReferenceImage: async () => {
      calls.loadRef += 1;
      return overrides.reference ?? { bytes: png(1080, 1920), mimeType: "image/png", extension: "png", name: "source", assetId: "asset-1" };
    },
    storeFinalAsset: async () => {
      calls.store += 1;
      if (overrides.storeThrows) throw new Error("store");
      return { storagePath: "owner-1/generated-base/draft-1-final.mp4", previousStoragePath: "owner-1/uploads/old.mp4" };
    },
    removeAbandonedObject: async (_o, path) => { calls.remove.push(path); },
    signPreview: async (path) => { calls.sign += 1; return `signed:${path}`; },
  };
  return { ports, state, calls };
}

const startInput = (overrides = {}) => ({
  ownerId: "owner-1",
  draftId: "draft-1",
  conversationId: "conv-1",
  scope: "post",
  kind: "reel",
  concept: "Summer fitting tip",
  script: "Show three looks.",
  brief: "short brief",
  idempotencyKey: "video:post:draft-1:t1",
  sourceAsset: null,
  providerName: "magic-hour",
  supportsImageToVideo: true,
  estimatedCostUsd: null,
  monthlySpendLimitUsd: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Start: duplicate protection, idempotency, limits
// ---------------------------------------------------------------------------

test("one active job per draft: a running job blocks a new start with 409", async () => {
  const { ports, state } = fakePorts();
  state.active = row({ status: "generating", provider_job_id: "mh-1" });
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "active");
  assert.equal(result.generation.provider_job_id, "mh-1");
});

test("burst limit: four jobs in the last minute -> 429, nothing created", async () => {
  const { ports, state, calls } = fakePorts();
  state.recentJobs = 4;
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.status, 429);
  assert.equal(calls.insert, 0);
});

test("monthly spend limit blocks before any provider work", async () => {
  const { ports, state, calls } = fakePorts();
  state.spent = 9;
  const result = await gen.startVideoGeneration(ports, startInput({ monthlySpendLimitUsd: 10, estimatedCostUsd: 2 }));
  assert.equal(result.status, 503);
  assert.equal(result.code, "spend_limit");
  assert.equal(calls.plan, 0);
  assert.equal(calls.insert, 0);
});

test("a repeated click (same idempotency key) resolves to the same terminal job", async () => {
  const { ports, state } = fakePorts({ insertResult: "idempotency_conflict" });
  state.byIdempotency = row({ status: "completed", storage_path: "owner-1/x.mp4" });
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.generation.id, "gen-1");
});

test("a repeated click while the first job is still active is a 409, not a new job", async () => {
  const { ports, state, calls } = fakePorts({ insertResult: "idempotency_conflict" });
  state.byIdempotency = row({ status: "generating" });
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(calls.createJob, 0);
});

test("plan failure: no job row, no provider job, safe 503", async () => {
  const { ports, calls } = fakePorts({ planThrows: "plan_failed" });
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.status, 503);
  assert.equal(result.code, "plan_failed");
  assert.equal(calls.insert, 0);
  assert.equal(calls.createJob, 0);
});

test("provider job creation failure fails the row and cleans up the base image", async () => {
  const { ports, calls } = fakePorts({ jobThrows: "rate_limited" });
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.status, 503);
  assert.equal(result.code, "provider_failed");
  assert.equal(calls.insert, 1, "the durable row exists so nothing is re-billed");
  const failed = calls.update.find((u) => u.patch.status === "failed");
  assert.ok(failed, "the row is marked failed");
  assert.equal(failed.patch.error_code, "rate_limited");
  assert.ok(calls.remove.includes("owner-1/generated-base/draft-1-x.png"), "abandoned base image removed");
  assert.match(result.message, /unchanged|expect|retry/i);
});

test("generated-image-to-video: base frame is validated, stored, and persisted on the row", async () => {
  const { ports, state, calls } = fakePorts();
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(calls.baseImage, 1);
  assert.equal(calls.uploadBase, 1);
  assert.equal(state.row.generation_mode, "generated_image_to_video");
  assert.equal(state.row.status, "generating");
  assert.equal(state.row.provider, "magic-hour");
  assert.equal(state.row.provider_job_id, "mh-123");
  assert.equal(state.row.aspect_ratio, "9:16");
  assert.equal(state.row.attempt_count, 1);
  assert.ok(calls.lastJobInput.referenceImage, "the validated base frame seeds the video job");
  assert.equal(calls.lastJobInput.referenceImage.mimeType, "image/png");
});

test("a base frame that is not 9:16 is rejected before any video job", async () => {
  const { ports, calls } = fakePorts({ baseImageBytes: png(1080, 1080) });
  const result = await gen.startVideoGeneration(ports, startInput());
  assert.equal(result.status, 503);
  assert.equal(result.errorCode, "invalid_output");
  assert.equal(calls.createJob, 0);
  assert.equal(calls.insert, 0);
});

test("asset-assisted: the user's uploaded image seeds the job as image_to_video", async () => {
  const { ports, state, calls } = fakePorts();
  const result = await gen.startVideoGeneration(ports, startInput({ sourceAsset: { storagePath: "owner-1/uploads/a.png", assetId: "asset-1" } }));
  assert.equal(result.ok, true);
  assert.equal(state.row.generation_mode, "image_to_video");
  assert.equal(state.row.source_asset_id, "asset-1");
  assert.equal(calls.baseImage, 0, "no base image is generated when the user supplies one");
  assert.equal(calls.loadRef, 1);
  assert.ok(calls.lastJobInput.referenceImage);
});

test("asset-assisted with a provider that cannot animate images is a safe 503", async () => {
  const { ports, calls } = fakePorts();
  const result = await gen.startVideoGeneration(ports, startInput({ sourceAsset: { storagePath: "owner-1/uploads/a.png", assetId: "asset-1" }, supportsImageToVideo: false }));
  assert.equal(result.status, 503);
  assert.equal(result.code, "unsupported_input");
  assert.equal(calls.createJob, 0);
});

test("text-to-video: no reference image at all when the provider has no i2v", async () => {
  const { ports, state, calls } = fakePorts();
  const result = await gen.startVideoGeneration(ports, startInput({ supportsImageToVideo: false }));
  assert.equal(result.ok, true);
  assert.equal(state.row.generation_mode, "text_to_video");
  assert.equal(calls.baseImage, 0);
  assert.equal(calls.lastJobInput.referenceImage, null);
});

test("the provider job id persists before the job can be polled", async () => {
  const { ports, state } = fakePorts();
  await gen.startVideoGeneration(ports, startInput());
  assert.equal(state.row.provider_job_id, "mh-123");
  assert.ok(state.row.started_at, "started_at is recorded on the claim");
});

// ---------------------------------------------------------------------------
// Advance: lazy polling, validation, atomic attach, safe abandonment
// ---------------------------------------------------------------------------

const complete = (bytes = mp4()) => ({ kind: "complete", media: { bytes, mimeType: "video/mp4", model: "test" } });

test("advance polls the provider exactly once per request and stays processing while pending", async () => {
  const { ports, state, calls } = fakePorts();
  state.row = row({ status: "generating", provider_job_id: "mh-123" });
  state.pollResult = { kind: "pending" };
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(result.ok, true);
  assert.equal(calls.poll, 1);
  assert.equal(state.row.status, "processing", "the claim is durable (crash-safe)");
  assert.equal(result.attached, false);
  assert.equal(calls.store, 0);
});

test("a completed job validates the BYTES, stores privately, attaches, and cleans up the old asset", async () => {
  const { ports, state, calls } = fakePorts();
  state.row = row({ status: "generating", provider_job_id: "mh-123" });
  state.pollResult = complete();
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(result.ok, true);
  assert.equal(result.attached, true);
  assert.equal(calls.store, 1);
  assert.equal(state.row.status, "completed");
  assert.equal(state.row.mime_type, "video/mp4");
  assert.equal(state.row.duration_seconds, 8);
  assert.ok(state.row.completed_at);
  assert.equal(result.previewUrl, "signed:owner-1/generated-base/draft-1-final.mp4");
  assert.ok(calls.remove.includes("owner-1/uploads/old.mp4"), "previous asset removed only after the new one is stored");
});

test("a failed regeneration never destroys the current asset: invalid output -> failed, nothing attached", async () => {
  const { ports, state, calls } = fakePorts();
  state.row = row({ status: "generating", provider_job_id: "mh-123" });
  state.pollResult = complete(new Uint8Array(Buffer.from("this is not an mp4, just text")));
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(result.ok, true);
  assert.equal(result.attached, false);
  assert.equal(state.row.status, "failed");
  assert.equal(state.row.error_code, "invalid_output");
  assert.equal(calls.store, 0, "the bad bytes are never stored or attached");
  assert.match(result.safeError, /previous asset is unchanged/i);
});

test("a landscape 16:9 provider output is rejected for a 9:16 draft", async () => {
  const { ports, state } = fakePorts();
  state.row = row({ status: "generating", provider_job_id: "mh-123" });
  state.pollResult = complete(mp4({ width: 1920, height: 1080 }));
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(state.row.status, "failed");
  assert.equal(state.row.error_code, "invalid_output");
  assert.equal(result.attached, false);
});

test("reel duration bounds: 4-15s; story bounds: 3-30s", async () => {
  const mk = (bytes) => { const { ports, state } = fakePorts(); state.row = row({ status: "generating", provider_job_id: "mh-123" }); state.pollResult = complete(bytes); return gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel"); };
  const mkStory = (bytes) => { const { ports, state } = fakePorts(); state.row = row({ status: "generating", provider_job_id: "mh-123" }); state.pollResult = complete(bytes); return gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "story"); };
  assert.equal((await mk(mp4({ durationSeconds: 4 }))).attached, true);
  assert.equal((await mk(mp4({ durationSeconds: 15 }))).attached, true);
  assert.equal((await mk(mp4({ durationSeconds: 16 }))).attached, false, "16s is over the reel bound");
  assert.equal((await mkStory(mp4({ durationSeconds: 3 }))).attached, true);
  assert.equal((await mkStory(mp4({ durationSeconds: 30 }))).attached, true);
  assert.equal((await mkStory(mp4({ durationSeconds: 31 }))).attached, false, "31s is over the story bound");
});

test("a timed-out generating job is abandoned safely (no provider call, no asset change)", async () => {
  const { ports, state, calls } = fakePorts();
  state.row = row({ status: "generating", provider_job_id: "mh-123", created_at: minutesAgo(31) });
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(state.row.status, "failed");
  assert.equal(state.row.error_code, "provider_timeout");
  assert.equal(calls.poll, 0);
  assert.equal(calls.store, 0);
  assert.match(result.safeError, /stopped|unchanged/i);
});

test("a crashed processing claim older than 10 minutes is reclaimed back to generating", async () => {
  const { ports, state, calls } = fakePorts();
  state.row = row({ status: "processing", provider_job_id: "mh-123", created_at: minutesAgo(5), updated_at: minutesAgo(11) });
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(state.row.status, "generating", "crashed claim is re-claimable");
  assert.equal(calls.poll, 0, "no duplicate provider work on the reclaim itself");
  assert.equal(result.attached, false);
});

test("a queued row that never got a provider job is failed safely", async () => {
  const { ports, state } = fakePorts();
  state.row = row({ status: "queued", created_at: minutesAgo(12) });
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(state.row.status, "failed");
  assert.equal(state.row.error_code, "provider_timeout");
  assert.match(result.safeError, /stopped/i);
});

test("provider poll failure and provider-reported failure both fail the job with safe codes", async () => {
  {
    const { ports, state } = fakePorts({ pollThrows: "unavailable" });
    state.row = row({ status: "generating", provider_job_id: "mh-123" });
    const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
    assert.equal(state.row.status, "failed");
    assert.equal(state.row.error_code, "unavailable");
    assert.match(result.safeError, /unchanged/i);
  }
  {
    const { ports, state } = fakePorts();
    state.row = row({ status: "generating", provider_job_id: "mh-123" });
    state.pollResult = { kind: "failed", code: "rejected" };
    const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
    assert.equal(state.row.status, "failed");
    assert.equal(state.row.error_code, "rejected");
    assert.match(result.safeError, /couldn't finish/i);
  }
});

test("a lost claim (a concurrent caller won) does no provider work; the winner's result is returned", async () => {
  const { ports, state, calls } = fakePorts();
  state.row = row({ status: "generating", provider_job_id: "mh-123" });
  const origUpdate = ports.updateGeneration;
  ports.updateGeneration = async (owner, id, patch, where) => {
    if (patch.status === "processing") {
      // Another caller won the race and completed the job underneath us.
      state.row = { ...state.row, status: "completed", storage_path: "owner-1/x.mp4" };
      return null;
    }
    return origUpdate(owner, id, patch, where);
  };
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(calls.poll, 0, "no duplicate provider work after losing the claim");
  assert.equal(result.attached, true, "the winner's completed state is what we return");
  assert.equal(result.previewUrl, "signed:owner-1/x.mp4");
});

test("a completed job returns a fresh signed preview on every advance (no provider work)", async () => {
  const { ports, state, calls } = fakePorts();
  state.row = row({ status: "completed", storage_path: "owner-1/x.mp4" });
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "gen-1", "reel");
  assert.equal(result.attached, true);
  assert.equal(result.previewUrl, "signed:owner-1/x.mp4");
  assert.equal(calls.poll, 0);
  assert.equal(calls.store, 0);
});

test("advance of an unknown job is a clean notFound, not a throw", async () => {
  const { ports } = fakePorts();
  const result = await gen.advanceVideoGeneration(ports, "owner-1", "missing", "reel");
  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
});

// ---------------------------------------------------------------------------
// The pure state machine
// ---------------------------------------------------------------------------

test("phases map to the real job states (no fake progress)", () => {
  assert.equal(job.phaseForState("queued"), "generating");
  assert.equal(job.phaseForState("generating"), "generating");
  assert.equal(job.phaseForState("processing"), "processing");
  assert.equal(job.phaseForState("completed"), "ready");
  assert.equal(job.phaseForState("failed"), "failed");
  assert.equal(job.phaseForState("cancelled"), "cancelled");
  assert.equal(job.phaseForState("nothing"), "preparing");
});

test("only terminal states may start a regeneration", () => {
  assert.equal(job.mayStartGeneration(null), true);
  assert.equal(job.mayStartGeneration("completed"), true);
  assert.equal(job.mayStartGeneration("failed"), true);
  assert.equal(job.mayStartGeneration("cancelled"), true);
  assert.equal(job.mayStartGeneration("queued"), false);
  assert.equal(job.mayStartGeneration("generating"), false);
  assert.equal(job.mayStartGeneration("processing"), false);
});

test("stale decision: timeout, reclaim, ok", () => {
  const clock = { nowMs: NOW, createdAtMs: Date.parse(minutesAgo(5)), updatedAtMs: Date.parse(minutesAgo(0.5)) };
  assert.equal(job.staleDecision("generating", clock), "ok");
  assert.equal(job.staleDecision("generating", { ...clock, createdAtMs: Date.parse(minutesAgo(31)) }), "timeout");
  assert.equal(job.staleDecision("processing", { ...clock, updatedAtMs: Date.parse(minutesAgo(11)) }), "reclaim");
  assert.equal(job.staleDecision("queued", { ...clock, updatedAtMs: Date.parse(minutesAgo(11)) }), "timeout");
  assert.equal(job.staleDecision("completed", clock), "ok");
});

test("idempotency keys are deterministic, bounded, and sanitized", () => {
  assert.equal(job.videoIdempotencyKey("post", "d1", "tok-123"), "video:post:d1:tok-123");
  assert.equal(job.videoIdempotencyKey("reel", "d1", "tok-123"), job.videoIdempotencyKey("reel", "d1", "tok-123"));
  assert.equal(job.videoIdempotencyKey("post", "d1", "a/b c!"), job.videoIdempotencyKey("post", "d1", "abc"));
  assert.ok(job.videoIdempotencyKey("post", "d".repeat(200), "t").length <= 200);
  assert.throws(() => job.videoIdempotencyKey("post", "d1", "!!!"));
});

test("safe error messages never leak provider internals", () => {
  for (const code of ["not_configured", "rate_limited", "rejected", "unsupported_input", "invalid_output", "provider_timeout", "storage_failure", "db_failure", "insufficient_credits", "something-else", null]) {
    const message = job.videoJobSafeError(code);
    if (code === null) assert.equal(message, null);
    else assert.match(message, /^[A-Z].*\.$/);
    assert.ok(!/key|token|bearer|secret|password|api|supabase|stack|error at|exception/i.test(message ?? ""), `safe message leaks: ${message}`);
  }
  assert.match(job.videoJobSafeError("invalid_output"), /not attached/i);
  assert.match(job.videoJobSafeError("not_configured"), /temporarily unavailable/i);
});

test("generation mode records how the output was produced (for later cost accounting)", () => {
  assert.equal(job.generationModeFor(true, true), "image_to_video");
  assert.equal(job.generationModeFor(true, false), "generated_image_to_video");
  assert.equal(job.generationModeFor(false, false), "text_to_video");
});
