/**
 * Durable server-side video polling tests.
 *
 * All provider and storage work is faked in memory. These tests never call
 * OpenRouter, never submit a paid job, never generate real media, never publish,
 * and never invoke the production cron route.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const poller = await import("../lib/mara/video-poller.ts");
const pollLog = await import("../lib/mara/video-poll-log.ts");

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const OWNER = "owner-1";
const DRAFT = "draft-1";
const GENERATION = "generation-1";

const U32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value >>> 0); return buffer; };
function testMp4({ width = 1080, height = 1920, durationSeconds = 8, timescale = 1000 } = {}) {
  const box = (type, payload) => Buffer.concat([U32(8 + payload.length), Buffer.from(type, "ascii"), payload]);
  const units = Math.round(durationSeconds * timescale);
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "ascii"), U32(0x200)]));
  const mvhd = box("mvhd", Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), U32(0), U32(timescale), U32(units)]));
  const hdlr = box("hdlr", Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), Buffer.from("vide", "ascii")]));
  const mdhd = box("mdhd", Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), U32(0), U32(timescale), U32(units)]));
  const mdia = box("mdia", Buffer.concat([hdlr, mdhd]));
  const tkhd = Buffer.alloc(24);
  U32(width << 16).copy(tkhd, 16);
  U32(height << 16).copy(tkhd, 20);
  const trak = box("trak", Buffer.concat([mdia, box("tkhd", tkhd)]));
  const moov = box("moov", Buffer.concat([mvhd, trak]));
  return new Uint8Array(Buffer.concat([ftyp, moov, Buffer.from("mdat-test-only")]));
}

function videoRow(overrides = {}) {
  return {
    id: GENERATION,
    owner_user_id: OWNER,
    draft_id: DRAFT,
    conversation_id: "conversation-1",
    media_type: "video",
    generation_mode: "text_to_video",
    prompt: "A safe test prompt.",
    aspect_ratio: "9:16",
    status: "generating",
    provider: "openrouter",
    provider_job_id: "provider-job-test",
    provider_polling_url: "https://provider.invalid/jobs/provider-job-test",
    provider_status: "pending",
    provider_retry_after_at: null,
    provider_diagnostic: null,
    storage_path: null,
    mime_type: null,
    byte_size: null,
    duration_seconds: 8,
    estimated_cost_usd: 1,
    error_code: null,
    idempotency_key: "video:post:draft-1:test-token",
    source_asset_id: null,
    overlay: null,
    started_at: new Date(NOW - 60_000).toISOString(),
    attempt_count: 1,
    created_at: new Date(NOW - 60_000).toISOString(),
    updated_at: new Date(NOW - 30_000).toISOString(),
    completed_at: null,
    ...overrides,
  };
}

function providerStub() {
  const calls = { create: 0 };
  return {
    calls,
    provider: {
      name: "openrouter",
      supportsImageToVideo: true,
      supportsTextToVideo: true,
      createVideoJob: async () => { calls.create += 1; throw new Error("a poller must never submit"); },
      pollVideoJob: async () => ({ kind: "pending" }),
    },
  };
}

function fakePorts(initialRow, pollResult) {
  const state = { row: initialRow };
  const calls = { poll: 0, create: 0, store: 0, remove: 0 };
  const ports = {
    now: () => NOW,
    findActiveGeneration: async () => null,
    findGeneration: async (_owner, id) => state.row.id === id ? state.row : null,
    findGenerationByIdempotency: async () => null,
    countRecentJobs: async () => 0,
    sumMonthlyVideoCost: async () => 0,
    insertGeneration: async () => "inserted",
    updateGeneration: async (_owner, id, patch, whereStatuses) => {
      if (state.row.id !== id || (whereStatuses && !whereStatuses.includes(state.row.status))) return null;
      Object.assign(state.row, patch, { updated_at: new Date(NOW).toISOString() });
      return state.row;
    },
    planMedia: async () => { throw new Error("the poller must not plan"); },
    generateBaseImage: async () => { throw new Error("the poller must not generate a base image"); },
    createVideoJob: async () => { calls.create += 1; throw new Error("the poller must not submit"); },
    pollVideoJob: async () => { calls.poll += 1; return typeof pollResult === "function" ? pollResult() : pollResult; },
    uploadBaseImage: async () => { throw new Error("the poller must not upload a base image"); },
    loadReferenceImage: async () => null,
    storeFinalAsset: async () => {
      calls.store += 1;
      return { storagePath: `${OWNER}/post-assets/test-video.mp4`, previousStoragePath: null };
    },
    removeAbandonedObject: async () => { calls.remove += 1; },
    signPreview: async (path) => `signed:${path}`,
  };
  return { ports, state, calls };
}

function runOptions(row, ports, provider, extra = {}) {
  return {
    admin: {},
    now: () => NOW,
    jobs: [{ row, kind: "reel" }],
    ports,
    provider,
    syncCalendar: async () => undefined,
    logger: () => undefined,
    ...extra,
  };
}

class ListQuery {
  constructor(table, rows) {
    this.table = table;
    this.rows = rows;
    this.filters = [];
    this.limitCount = null;
    this.orderColumns = [];
  }
  select() { return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
  not(column, operator, value) {
    if (operator === "is" && value === null) this.filters.push((row) => row[column] !== null && row[column] !== undefined);
    return this;
  }
  or() { return this; }
  order(column, options = {}) { this.orderColumns.push({ column, ascending: options.ascending !== false }); return this; }
  limit(value) { this.limitCount = value; return this; }
  _result() {
    let result = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    for (const { column, ascending } of this.orderColumns) {
      result = [...result].sort((a, b) => ascending ? String(a[column]).localeCompare(String(b[column])) : String(b[column]).localeCompare(String(a[column])));
    }
    return this.limitCount === null ? result : result.slice(0, this.limitCount);
  }
  async maybeSingle() { return { data: this._result()[0] ?? null, error: null }; }
  then(resolve, reject) { return Promise.resolve({ data: this._result(), error: null }).then(resolve, reject); }
}

function listAdmin(generations, drafts) {
  return { from: (table) => new ListQuery(table, table === "mara_media_generations" ? generations : drafts) };
}

function logEvents() {
  const events = [];
  return { events, logger: (event, input) => events.push({ event, input }) };
}

test("background poll finds an active provider job and respects the two-minute cadence", async () => {
  const active = videoRow({ updated_at: new Date(NOW - 3 * 60_000).toISOString() });
  const activeQueued = videoRow({ id: "queued-with-handle", status: "queued", updated_at: new Date(NOW - 4 * 60_000).toISOString() });
  const ignoredNoHandle = videoRow({ id: "no-handle", provider_job_id: null, updated_at: new Date(NOW - 10 * 60_000).toISOString() });
  const ignoredCompleted = videoRow({ id: "completed", status: "completed", updated_at: new Date(NOW - 10 * 60_000).toISOString() });
  const admin = listAdmin([active, activeQueued, ignoredNoHandle, ignoredCompleted], [{ id: DRAFT, owner_user_id: OWNER, kind: "reel" }]);
  const found = await poller.listDueVideoGenerations(admin, { now: NOW, providerName: "openrouter", limit: 10 });
  assert.deepEqual(new Set(found.map((job) => job.row.id)), new Set([GENERATION, "queued-with-handle"]));
  assert.ok(found.every((job) => job.kind === "reel"));
});

test("polling a pending job creates no new provider submission and persists the latest status", async () => {
  const row = videoRow();
  const fake = fakePorts(row, { kind: "pending", providerStatus: "pending" });
  const stub = providerStub();
  const output = await poller.runVideoGenerationPoller(runOptions(row, fake.ports, stub.provider));
  assert.equal(output.pending, 1);
  assert.equal(fake.calls.poll, 1);
  assert.equal(fake.calls.create, 0);
  assert.equal(stub.calls.create, 0);
  assert.equal(fake.state.row.provider_job_id, "provider-job-test");
  assert.equal(fake.state.row.provider_status, "pending");
  assert.equal(fake.state.row.status, "processing");
});

test("a completed provider job is downloaded, validated, stored, attached, and re-syncs the same queue item", async () => {
  const row = videoRow();
  const fake = fakePorts(row, { kind: "complete", providerStatus: "completed", media: { kind: "complete", bytes: testMp4(), mimeType: "video/mp4" } });
  const stub = providerStub();
  const syncCalls = [];
  const logs = logEvents();
  const output = await poller.runVideoGenerationPoller(runOptions(row, fake.ports, stub.provider, {
    syncCalendar: async (_admin, ownerId, draftId) => syncCalls.push({ ownerId, draftId }),
    logger: logs.logger,
  }));
  assert.equal(output.completed, 1);
  assert.equal(fake.calls.poll, 1);
  assert.equal(fake.calls.store, 1);
  assert.equal(stub.calls.create, 0, "completion polling never reaches the paid create path");
  assert.deepEqual(syncCalls, [{ ownerId: OWNER, draftId: DRAFT }]);
  assert.equal(fake.state.row.status, "completed");
  assert.equal(fake.state.row.mime_type, "video/mp4");
  assert.ok(fake.state.row.storage_path);
  assert.ok(logs.events.some((entry) => entry.event === "provider_completed"));
  assert.ok(logs.events.some((entry) => entry.event === "asset_stored"));
});

test("a provider-reported failure becomes terminal and is not retried as a new paid job", async () => {
  const row = videoRow();
  const fake = fakePorts(row, { kind: "failed", code: "rejected", providerStatus: "failed" });
  const stub = providerStub();
  const logs = logEvents();
  const output = await poller.runVideoGenerationPoller(runOptions(row, fake.ports, stub.provider, { logger: logs.logger }));
  assert.equal(output.failed, 1);
  assert.equal(fake.state.row.status, "failed");
  assert.equal(fake.state.row.error_code, "rejected");
  assert.equal(fake.calls.store, 0);
  assert.equal(stub.calls.create, 0);
  assert.ok(logs.events.some((entry) => entry.event === "provider_failed"));
});

test("a job beyond the 30-minute hard timeout becomes provider_timeout without a provider call", async () => {
  const row = videoRow({ created_at: new Date(NOW - 31 * 60_000).toISOString(), updated_at: new Date(NOW - 3 * 60_000).toISOString() });
  const fake = fakePorts(row, { kind: "pending" });
  const stub = providerStub();
  const logs = logEvents();
  const output = await poller.runVideoGenerationPoller(runOptions(row, fake.ports, stub.provider, {
    logger: logs.logger,
    enforceTimeout: async (_admin, _ownerId, _generationId, at) => {
      assert.equal(at, NOW);
      fake.state.row.status = "failed";
      fake.state.row.error_code = "provider_timeout";
      return { enforced: true, row: fake.state.row };
    },
  }));
  assert.equal(output.timedOut, 1);
  assert.equal(fake.calls.poll, 0);
  assert.equal(fake.calls.create, 0);
  assert.equal(fake.state.row.error_code, "provider_timeout");
  assert.ok(logs.events.some((entry) => entry.event === "timed_out"));
});

test("the same job completes normally when no UI or browser request runs", async () => {
  const row = videoRow();
  const fake = fakePorts(row, { kind: "complete", providerStatus: "completed", media: { kind: "complete", bytes: testMp4(), mimeType: "video/mp4" } });
  const stub = providerStub();
  const output = await poller.runVideoGenerationPoller(runOptions(row, fake.ports, stub.provider));
  assert.equal(output.completed, 1);
  assert.equal(fake.state.row.status, "completed");
  assert.equal(fake.calls.store, 1);
});

test("repeated cron runs are idempotent: one provider handle, one stored asset, one attach", async () => {
  const row = videoRow();
  const fake = fakePorts(row, { kind: "complete", providerStatus: "completed", media: { kind: "complete", bytes: testMp4(), mimeType: "video/mp4" } });
  const stub = providerStub();
  const syncCalls = [];
  const options = runOptions(row, fake.ports, stub.provider, { syncCalendar: async () => syncCalls.push(true) });
  const first = await poller.runVideoGenerationPoller(options);
  const second = await poller.runVideoGenerationPoller(options);
  assert.equal(first.completed, 1);
  assert.equal(second.completed, 1, "a terminal read is safe and does not start anything");
  assert.equal(fake.calls.poll, 1, "the completed row is never polled again");
  assert.equal(fake.calls.create, 0);
  assert.equal(fake.calls.store, 1, "at most one asset is attached");
  assert.deepEqual(syncCalls, [true], "the same workflow queue row is re-synced once");
});

test("poll logs are allow-listed and never include provider secrets or signed URLs", () => {
  const record = pollLog.buildVideoPollLogRecord("provider_status", {
    generationId: "https://signed.invalid/private.mp4?token=secret",
    provider: "openrouter",
    providerStatus: "pending",
    errorCode: "rejected",
  }, NOW);
  assert.equal(record.generationId, null);
  assert.equal(record.provider, "openrouter");
  assert.equal(record.providerStatus, "pending");
  assert.equal(record.errorCode, "rejected");
  assert.doesNotMatch(JSON.stringify(record), /signed|secret|token|https?:\/\//i);
});

test("the worker source has a server route and never delegates provider lifecycle to the browser", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/cron/media-generation/route.ts", import.meta.url), "utf8");
  const source = await readFile(new URL("../lib/mara/video-poller.ts", import.meta.url), "utf8");
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /VIDEO_GENERATION_POLL_INTERVAL_MINUTES/);
  assert.match(source, /pollVideoJob/);
  assert.doesNotMatch(source, /createVideoJob\(/);
});
