/**
 * Production incident fix: the stale Seedance recovery path for the Reel
 * "SynraPay Global Reach Showcase".
 *
 * The facts in production (13 Sep 2026, Asia/Dubai):
 *   generation aae4aaac-bd7a-47a8-868a-18aee5a44a11, created 7:17:21 AM,
 *   updated 7:17:26 AM, status 'generating', provider OpenRouter, provider
 *   status 'pending', provider job j4McHGlLAPqr6PSmyqf8, NO asset, NO
 *   post_draft_asset, queue 'waiting_for_media'. The user clicked
 *   "Retry generation" at 3:53 PM — 8.5 hours after the job started and 8
 *   hours past Voom's 30-minute hard timeout.
 *
 * What happened: the stale-video retry path re-advanced the SAME durable
 * provider job, but a job already beyond the hard timeout was never
 * transitioned to a terminal state, so the row stayed 'generating/pending'
 * indefinitely, the toast claimed work that was not happening, and the card
 * stayed stuck with no media.
 *
 * Real modules under test (no string matching where behaviour can be
 * exercised; NO OpenRouter call, NO paid generation, NO publishing, NO cron):
 *   lib/mara/video-job.ts             — the durable job's lifetime rules
 *   lib/mara/video-service.ts         — enforceVideoJobHardTimeout (DB write only)
 *   lib/voom/workflow/state.ts        — the ONE status derivation
 *   lib/voom/workflow/read.ts         — the shared read model
 *   lib/voom/workflow/next-actions.ts — the ONE next-action engine
 *   lib/voom/workflow/media.ts        — the explicit/idempotent retry policy
 *   lib/instagram/publishing.ts       — due-selection (queue semantics preserved)
 *
 * Behavioural guarantees proven here:
 *   1. pending video < stale threshold            -> Generating
 *   2. stale video < hard timeout                 -> Media generation delayed
 *   3. pending video > hard timeout               -> Generation timed out AND a
 *      terminal provider_timeout state is persisted (never left 'generating')
 *   4. detecting the timeout submits no provider job and charges nothing
 *   5. only the explicit "Retry as new generation" click creates ONE fresh job
 *   6. repeated/racing clicks cannot create two paid jobs
 *   7. the same draft stays 'waiting_for_media' until an asset exists
 *   plus: history and the original provider job id are preserved, the toast is
 *   truthful, and Manual mode / Instagram idempotency are unchanged.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeCreditLedger } from "./helpers/credit-ledger-fake.mjs";

const state = await import("../lib/voom/workflow/state.ts");
const readModel = await import("../lib/voom/workflow/read.ts");
const mediaMod = await import("../lib/voom/workflow/media.ts");
const nextActions = await import("../lib/voom/workflow/next-actions.ts");
const videoJob = await import("../lib/mara/video-job.ts");
const videoService = await import("../lib/mara/video-service.ts");
const publishing = await import("../lib/instagram/publishing.ts");
const tz = await import("../lib/voom/timezone.ts");

// ---------------------------------------------------------------------------
// The incident fixture, in real instants.
// ---------------------------------------------------------------------------

const TZ = "Asia/Dubai";
const OWNER = "owner-synrapay";
const DRAFT = "aae4aaac-0000-4000-8000-000000000001";
const GENERATION_ID = "aae4aaac-bd7a-47a8-868a-18aee5a44a11";
const PROVIDER_JOB_ID = "j4McHGlLAPqr6PSmyqf8";

/** 7:17:21 AM Dubai — the durable Seedance job was submitted. */
const CREATED_AT = "2026-09-13T03:17:21.000Z";
/** 7:17:26 AM Dubai — the last progress the row ever recorded. */
const UPDATED_AT = "2026-09-13T03:17:26.000Z";
/** 3:53 PM Dubai — the user clicked "Retry generation" (8h35m later). */
const NOW = new Date("2026-09-13T11:53:00.000Z");
/** 7:15 PM Dubai — the held schedule, still in the future at the click. */
const SCHEDULED = tz.localToUtcIso("2026-09-13", 19 * 60 + 15, TZ);

const HARD_TIMEOUT_MINUTES = videoJob.VIDEO_JOB_TIMEOUT_MINUTES;
const STALE_MINUTES = state.MEDIA_GENERATION_STALE_MINUTES;
const minutesBefore = (minutes, from = NOW) => new Date(from.getTime() - minutes * 60_000).toISOString();

assert.equal(HARD_TIMEOUT_MINUTES, 30, "the configured hard timeout is 30 minutes");
assert.equal(state.MEDIA_GENERATION_HARD_TIMEOUT_MINUTES, HARD_TIMEOUT_MINUTES, "one shared number, never a second one");
assert.ok(STALE_MINUTES < HARD_TIMEOUT_MINUTES, "the stale threshold sits under the hard timeout");

// ---------------------------------------------------------------------------
// In-memory, owner-scoped admin client shaped like the Supabase queries these
// modules issue. Every write is recorded (table, op and patch) so "no new
// provider submission", "the queue row is untouched" and "the provider job id
// survives" are asserted on real write attempts. It mirrors the database's
// final duplicate-generation guard (mara_media_active_per_draft_uq, migration
// 0025) and the (owner, idempotency_key) unique pair.
// ---------------------------------------------------------------------------

const ACTIVE_GEN_STATUSES = ["queued", "generating", "processing"];

function createFakeAdmin(tables) {
  const writes = [];
  // Plans + Credits v1: the explicit retry reserves credits BEFORE the
  // provider is asked for anything. The ledger RPCs of migration 0035 are
  // modelled in memory so the REAL guard runs, and "one fresh paid job" can
  // also be asserted as "one live reservation of exactly 40 credits".
  const ledger = createFakeCreditLedger(tables, { now: () => NOW });

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orderColumn = null;
      this.orderDirection = 1;
      this.limitCount = null;
      this.patch = null;
      this.insertRows = null;
    }
    select() { return this; }
    insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.patch = patch; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) {
      const set = new Set(values.map(String));
      this.filters.push((row) => set.has(String(row[column])));
      return this;
    }
    order(column, options = {}) {
      this.orderColumn = column;
      this.orderDirection = options.ascending === false ? -1 : 1;
      return this;
    }
    limit(count) { this.limitCount = count; return this; }
    _base() { return tables.get(this.table) ?? []; }
    _rows() { return this._base().filter((row) => this.filters.every((match) => match(row))); }
    _execute() {
      if (this.insertRows) {
        writes.push({ table: this.table, op: "insert", patch: this.insertRows[0] });
        if (this.table === "mara_media_generations") {
          const clash = this._base().some((existing) =>
            existing.owner_user_id === this.insertRows[0].owner_user_id
            && existing.draft_id === this.insertRows[0].draft_id
            && ACTIVE_GEN_STATUSES.includes(existing.status));
          if (clash) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint mara_media_active_per_draft_uq" } };
          }
        }
        for (const row of this.insertRows) this._base().push(row);
        return { data: [...this.insertRows], error: null };
      }
      if (this.patch) {
        writes.push({ table: this.table, op: "update", patch: this.patch });
        const targets = this._rows();
        for (const row of targets) Object.assign(row, this.patch);
        return { data: targets, error: null };
      }
      let rows = this._rows();
      if (this.orderColumn) {
        rows = [...rows].sort((a, b) => {
          if (a[this.orderColumn] < b[this.orderColumn]) return -this.orderDirection;
          if (a[this.orderColumn] > b[this.orderColumn]) return this.orderDirection;
          return 0;
        });
      }
      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      return { data: rows, error: null };
    }
    then(onFulfilled, onRejected) { return Promise.resolve(this._execute()).then(onFulfilled, onRejected); }
    async maybeSingle() {
      const { data, error } = this._execute();
      return { data: data?.[0] ?? null, error };
    }
  }

  return {
    writes,
    tables,
    ledger,
    generations: () => tables.get("mara_media_generations") ?? [],
    queueRows: () => tables.get("instagram_publish_queue") ?? [],
    writesTo: (table) => writes.filter((write) => write.table === table),
    from: (table) => new Query(table),
    async rpc(name, args) {
      return (await ledger.rpc(name, args)) ?? { data: null, error: null };
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path) => ({ data: { signedUrl: `https://signed.invalid/${path}` } }),
        createSignedUrls: async (paths) => ({ data: paths.map((path) => ({ signedUrl: `https://signed.invalid/${path}`, path })) }),
        download: async () => ({ data: null, error: { message: "not found" } }),
        upload: async () => ({ data: null, error: null }),
      }),
    },
  };
}

/**
 * The production row: one approved Reel, held in 'waiting_for_media', with a
 * durable Seedance job that has not progressed since 7:17 AM and NO asset.
 */
function seedIncident(options = {}) {
  const generations = options.generation === null ? [] : [{
    id: options.generationId ?? GENERATION_ID,
    owner_user_id: OWNER,
    conversation_id: "conv-1",
    draft_id: DRAFT,
    media_type: options.mediaType ?? "video",
    prompt: "Clean 9:16 global reach visual.",
    aspect_ratio: "9:16",
    status: options.generation ?? "generating",
    provider: "openrouter",
    provider_job_id: options.providerJobId ?? PROVIDER_JOB_ID,
    provider_status: "pending",
    provider_retry_after_at: null,
    error_code: options.errorCode ?? null,
    idempotency_key: `video:post:${DRAFT}:workflow-${DRAFT}`,
    created_at: options.createdAt ?? CREATED_AT,
    updated_at: options.updatedAt ?? UPDATED_AT,
  }];
  const assets = options.asset ? [{
    id: "asset-1", owner_user_id: OWNER, draft_id: DRAFT, mime_type: "video/mp4",
    origin: "mara", storage_path: `${OWNER}/post-assets/asset-1.mp4`, status: "uploaded",
  }] : [];
  const queue = options.queue === null ? [] : [{
    id: "queue-1", owner_user_id: OWNER, draft_id: DRAFT, calendar_item_id: "cal-1",
    media_kind: "reel", caption: "SynraPay Global Reach Showcase", scheduled_at: SCHEDULED,
    status: options.queue ?? "waiting_for_media", attempts: 0, instagram_media_id: null,
    failure_message: null,
  }];
  return new Map(Object.entries({
    businesses: [{
      owner_user_id: OWNER, content_frequency: "Daily", timezone: TZ,
      automation_level: options.mode ?? "assisted",
      // The SynraPay account is on Pro: Assisted is a Pro mode, and Pro is
      // what lets an explicit Create with MARA / Retry click spend credits.
      plan: options.plan ?? "pro",
    }],
    marketing_plans: [{
      id: "plan-1", owner_user_id: OWNER, business_goal: "Global reach", status: "active",
      valid_from: "2026-09-13", valid_until: "2026-09-19", created_at: "2026-09-13T00:00:00Z",
    }],
    mara_drafts: [{
      id: DRAFT, owner_user_id: OWNER, source_plan_id: "plan-1", kind: "reel",
      title: "SynraPay Global Reach Showcase", content: "Show the Global Reach milestone.",
      status: options.draftStatus ?? "approved", source_plan_item_key: "2026-09-13",
      proposed_publish_at: SCHEDULED, conversation_id: "conv-1",
      media_brief: "Clean 9:16 global reach visual.", created_at: CREATED_AT,
    }],
    post_draft_assets: assets,
    mara_media_generations: generations,
    instagram_publish_queue: queue,
    content_calendar_items: [{ id: "cal-1", owner_user_id: OWNER, source_draft_id: DRAFT }],
    mara_pending_actions: [],
  }));
}

/** The workflow media request the Marketing Plan card's retry action builds. */
function reelRequest(overrides = {}) {
  return {
    ownerId: OWNER,
    draftId: DRAFT,
    conversationId: "conv-1",
    contentType: "reel",
    concept: "SynraPay Global Reach Showcase",
    visualBrief: "Clean 9:16 global reach visual.",
    ...overrides,
  };
}

function facts(overrides = {}) {
  return {
    draftStatus: "approved",
    hasMedia: false,
    mediaStatus: "generating",
    mediaType: "video",
    mediaErrorCode: null,
    mediaCreatedAt: CREATED_AT,
    mediaUpdatedAt: UPDATED_AT,
    publishStatus: "waiting_for_media",
    awaitingApproval: false,
    publishAt: SCHEDULED,
    now: NOW,
    ...overrides,
  };
}

function cardFacts(item, overrides = {}) {
  return {
    contentType: "reel",
    stage: item.status ?? item,
    failedStage: item.failedStage ?? null,
    mode: "assisted",
    publishAt: item.publishAt ?? SCHEDULED,
    dayLabel: item.dayLabel ?? "Today",
    localTime: item.localTime ?? "7:15 PM",
    hasMedia: item.hasMedia ?? false,
    mediaStatus: item.mediaStatus ?? "generating",
    ...overrides,
  };
}

/**
 * The provider-side seam, faked: it records every call and mirrors the real
 * orchestrator's order of work (durable row first, provider job second) plus
 * the database's one-active-job and idempotency-key guards. No network.
 */
function fakeVideoDeps(db) {
  const calls = { advance: 0, start: 0, providerJobs: 0, tokens: [] };
  return {
    calls,
    deps: {
      advance: async () => { calls.advance += 1; return "advanced"; },
      startVideo: async (args) => {
        calls.start += 1;
        calls.tokens.push(args.idempotencyToken);
        const rows = db.tables.get("mara_media_generations");
        const key = `video:post:${args.post.id}:${args.idempotencyToken}`.replace(/[^a-zA-Z0-9-:]/g, "").slice(0, 200);
        // Planning happens before the durable insert, so two concurrent clicks
        // can both get this far — exactly like the real orchestrator.
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        // (owner, idempotency_key) is unique: the same token resolves to the
        // SAME job instead of paying twice.
        const existing = rows.find((row) => row.owner_user_id === args.ownerId && row.idempotency_key === key);
        if (existing) return { status: 200, generation: { id: existing.id }, message: "This generation was already started, so no new job was created." };
        // One active job per (owner, draft) — the database's atomic final guard
        // (mara_media_active_per_draft_uq): the loser of a race is refused
        // BEFORE any provider job exists, so it is never charged.
        const active = rows.find((row) => row.owner_user_id === args.ownerId
          && row.draft_id === args.post.id && ACTIVE_GEN_STATUSES.includes(row.status));
        if (active) {
          return { status: 409, error: "A video generation is already running for this content.", generation: null };
        }
        calls.providerJobs += 1;
        // Like the real orchestrator, the caller's pre-reserved ledger id IS the
        // durable row id (ledger row == generation row), else a fresh one.
        const freshId = args.generationId ?? `gen-fresh-${calls.providerJobs}`;
        rows.push({
          id: freshId,
          owner_user_id: args.ownerId,
          conversation_id: args.post.conversationId,
          draft_id: args.post.id,
          media_type: "video",
          prompt: args.brief,
          aspect_ratio: "9:16",
          status: "generating",
          provider: "openrouter",
          provider_job_id: `fresh-provider-job-${calls.providerJobs}`,
          provider_status: "pending",
          error_code: null,
          idempotency_key: key,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        });
        db.writes.push({ table: "mara_media_generations", op: "insert", patch: { via: "startVideo" } });
        return { status: 202, generation: { id: freshId }, message: "MARA started generating this video." };
      },
    },
  };
}

// ===========================================================================
// 1. The three UI states are distinct and truthful
// ===========================================================================

test("1a. a pending video inside the stale threshold is still 'Generating'", () => {
  assert.equal(state.WORKFLOW_STATUS_LABELS.generating, "Generating");
  const inFlight = { mediaCreatedAt: minutesBefore(5), mediaUpdatedAt: minutesBefore(5) };
  // Not scheduled yet: a fresh in-flight job is plainly "Generating".
  assert.equal(state.deriveWorkflowStatus(facts({ ...inFlight, draftStatus: "draft", publishStatus: null })), "generating");
  // The incident item IS approved and held: the same fresh job keeps the queue
  // truthfully in 'waiting_for_media' (never plain "Scheduled", never stale).
  assert.equal(state.deriveWorkflowStatus(facts(inFlight)), "waiting_for_media");
  assert.notEqual(state.deriveWorkflowStatus(facts(inFlight)), "media_timed_out");
  // The stale threshold is strict: exactly at it, nothing is "delayed" yet.
  const atThreshold = facts({
    mediaCreatedAt: minutesBefore(STALE_MINUTES),
    mediaUpdatedAt: minutesBefore(STALE_MINUTES),
  });
  assert.equal(state.deriveWorkflowStatus(atThreshold), "waiting_for_media");
  assert.equal(
    state.deriveWorkflowStatus({ ...atThreshold, draftStatus: "draft", publishStatus: null }),
    "generating",
  );
  // The card shows no retry button while a generation is genuinely in flight.
  const resolved = nextActions.planItemActions(cardFacts({ status: "generating" }));
  assert.equal(resolved.stageLabel, "Generating");
  assert.deepEqual(resolved.actions, [], "nothing to click while MARA is really working");
});

test("1b. a stale video inside the hard timeout is 'Media generation delayed'", () => {
  assert.equal(state.WORKFLOW_STATUS_LABELS.media_delayed, "Media generation delayed");
  const stale = facts({ mediaCreatedAt: minutesBefore(20), mediaUpdatedAt: minutesBefore(20) });
  assert.equal(state.deriveWorkflowStatus(stale), "media_delayed");
  // Every minute between the stale threshold and the hard timeout is delayed,
  // not timed out — the provider job may still legitimately finish.
  for (const minutes of [STALE_MINUTES + 1, 20, HARD_TIMEOUT_MINUTES - 1]) {
    const at = facts({ mediaCreatedAt: minutesBefore(minutes), mediaUpdatedAt: minutesBefore(minutes) });
    assert.equal(state.deriveWorkflowStatus(at), "media_delayed", `${minutes} minutes old is delayed`);
  }
  // The delayed card keeps the explicit trio, and its retry only re-checks the
  // existing job (it never claims to start a new one).
  const resolved = nextActions.planItemActions(cardFacts({ status: "media_delayed" }));
  assert.deepEqual(resolved.actions.map((action) => action.id), ["retry_media", "upload_asset", "cancel_schedule"]);
  assert.equal(resolved.actions[0].label, "Retry generation");
  assert.match(resolved.actions[0].hint, /never starts a second paid job/i);
});

test("1c. a pending video beyond the hard timeout is 'Generation timed out'", () => {
  assert.equal(state.WORKFLOW_STATUS_LABELS.media_timed_out, "Generation timed out");
  assert.ok(state.WORKFLOW_STATUSES.includes("media_timed_out"), "the state is part of the shared vocabulary");
  // The production facts: 8h35m old, still 'generating', still 'pending'.
  assert.equal(state.deriveWorkflowStatus(facts()), "media_timed_out");
  // The boundary is the hard timeout itself, and it is measured from the job's
  // lifetime (created_at), not from its last progress.
  const exactlyAt = facts({
    mediaCreatedAt: minutesBefore(HARD_TIMEOUT_MINUTES),
    mediaUpdatedAt: minutesBefore(HARD_TIMEOUT_MINUTES),
  });
  const justPast = facts({
    mediaCreatedAt: new Date(NOW.getTime() - HARD_TIMEOUT_MINUTES * 60_000 - 1_000).toISOString(),
    mediaUpdatedAt: minutesBefore(1),
  });
  assert.equal(state.deriveWorkflowStatus(exactlyAt), "media_delayed", "exactly at the limit is not beyond it");
  assert.equal(
    state.deriveWorkflowStatus(justPast),
    "media_timed_out",
    "one second past the limit is timed out even though the row was touched a minute ago",
  );
  // Once the terminal state is persisted the item is STILL timed out — the
  // derivation does not depend on which of the two happened first.
  assert.equal(
    state.deriveWorkflowStatus(facts({ mediaStatus: "failed", mediaErrorCode: "provider_timeout" })),
    "media_timed_out",
  );
  // A stored visual always wins: the timed-out job simply did not replace it.
  assert.equal(
    state.deriveWorkflowStatus(facts({ hasMedia: true, mediaStatus: "failed", mediaErrorCode: "provider_timeout" })),
    "scheduled",
  );
  assert.notEqual(state.deriveWorkflowStatus(facts({ hasMedia: true })), "media_timed_out");
  // A different failure reason stays a plain failure, never "timed out".
  assert.equal(state.deriveWorkflowStatus(facts({ mediaStatus: "failed", mediaErrorCode: "rejected" })), "failed");
  // Images are synchronous: the video hard timeout never applies to them.
  assert.equal(
    state.deriveWorkflowStatus(facts({ mediaType: "image", mediaStatus: "processing" })),
    "media_delayed",
  );
});

test("1d. the timed-out card is explicit about the three ways forward", () => {
  const resolved = nextActions.planItemActions(cardFacts({ status: "media_timed_out" }));
  assert.equal(resolved.stage, "media_timed_out");
  assert.equal(resolved.stageLabel, "Generation timed out");
  assert.match(resolved.headline, /timed out|30-minute limit/i);
  assert.match(resolved.headline, /nothing new was charged/i);
  assert.deepEqual(resolved.actions.map((action) => action.id), ["retry_media", "upload_asset", "cancel_schedule"]);
  assert.deepEqual(
    resolved.actions.map((action) => action.label),
    ["Retry as new generation", "Upload replacement", "Cancel schedule"],
  );
  const retry = resolved.actions[0];
  assert.equal(retry.tone, "primary");
  assert.ok(!retry.disabled, "the explicit retry is available — it is the only way forward");
  assert.match(retry.hint, /only action that can/i);
  assert.match(retry.hint, /repeated click never starts a second paid job/i);
  assert.match(resolved.explanation.autoPublish, /timed out/i);
  assert.match(resolved.explanation.autoPublish, /nothing new was charged/i);
  assert.equal(state.isRetryable("media_timed_out"), true);
  // Manual mode: the same explicit trio, and Voom still publishes nothing.
  const manual = nextActions.planItemActions(cardFacts({ status: "media_timed_out" }, { mode: "manual" }));
  assert.deepEqual(manual.actions.map((action) => action.id), ["retry_media", "upload_asset", "cancel_schedule"]);
  assert.match(manual.explanation.approval, /Manual mode|only prepares the work you ask for/i);
});

test("1e. the shared read model derives the timed-out state from the real rows", async () => {
  const db = createFakeAdmin(seedIncident());
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.equal(snapshot.items.length, 1);
  const item = snapshot.items[0];
  assert.equal(item.concept, "SynraPay Global Reach Showcase");
  assert.equal(item.status, "media_timed_out");
  assert.equal(item.statusLabel, "Generation timed out");
  assert.equal(item.hasMedia, false);
  assert.equal(item.mediaStatus, "generating", "the row is reported as it really is");
  assert.equal(item.queueStatus, "waiting_for_media", "the queue row is untouched and still held");
  assert.equal(item.localTime, "7:15 PM");
  // Reading never writes: the terminal transition needs the explicit retry.
  assert.deepEqual(db.writes, [], "the read model is read-only");
  // Today keeps it in the held-schedule bucket, never in "Scheduled".
  const summary = readModel.todaySummary(snapshot);
  assert.deepEqual(summary.waitingForMedia.map((row) => row.draftId), [DRAFT]);
  assert.ok(!summary.scheduled.some((row) => row.draftId === DRAFT));
  assert.ok(!summary.generating.some((row) => row.draftId === DRAFT), "it is never counted as still generating");
  // A held schedule beyond the horizon stays visible.
  assert.equal(
    readModel.isCurrentWorkflowItem({ slotDate: "2026-09-25", localDate: "2026-09-25", status: "media_timed_out" }, { today: "2026-09-13" }),
    true,
  );
});

test("1f. a passed schedule still outranks a stale generation (missed preserved)", () => {
  const later = new Date(new Date(SCHEDULED).getTime() + 60 * 60_000);
  // Stale but inside the hard timeout, schedule already passed -> missed.
  assert.equal(state.deriveWorkflowStatus(facts({
    mediaCreatedAt: minutesBefore(20, later), mediaUpdatedAt: minutesBefore(20, later), now: later,
  })), "missed");
  // A TERMINAL media timeout keeps the precedence a media failure always had.
  assert.equal(state.deriveWorkflowStatus(facts({
    mediaStatus: "failed", mediaErrorCode: "provider_timeout", now: later,
  })), "media_timed_out");
});

// ===========================================================================
// 2. The retry policy (pure): only an explicit click may pay again
// ===========================================================================

function latest(overrides = {}) {
  return {
    id: GENERATION_ID,
    status: "generating",
    mediaType: "video",
    errorCode: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

test("2a. inside the limits nothing at all happens, even on an explicit click", () => {
  // Fresh in flight: a repeated click is a no-op — nothing starts, nothing is charged.
  const fresh = latest({ createdAt: minutesBefore(5), updatedAt: minutesBefore(5) });
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: fresh, hasAsset: false, now: NOW }), { kind: "exists" });
  assert.deepEqual(
    mediaMod.decideMediaStart({ contentType: "reel", latest: fresh, hasAsset: false, now: NOW, explicit: true }),
    { kind: "exists" },
    "an explicit click cannot bypass a live job either",
  );
});

test("2b. stale but inside the hard timeout re-checks the SAME job", () => {
  const stale = latest({ createdAt: minutesBefore(20), updatedAt: minutesBefore(20) });
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: stale, hasAsset: false, now: NOW }),
    { kind: "advance", generationId: GENERATION_ID });
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: stale, hasAsset: false, now: NOW, explicit: true }),
    { kind: "advance", generationId: GENERATION_ID }, "explicit or not: never a second provider job for a live one");
});

test("2c. beyond the hard timeout the job is stopped — and only a click may replace it", () => {
  const timedOut = latest();
  // Viewing / polling / the automatic plan run: stop it, submit nothing.
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: timedOut, hasAsset: false, now: NOW }),
    { kind: "timeout", generationId: GENERATION_ID });
  // The explicit "Retry as new generation" click: stop it, then ONE fresh job.
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: timedOut, hasAsset: false, now: NOW, explicit: true }),
    { kind: "start_after_timeout", generationId: GENERATION_ID, token: "fresh" });
  // Already terminal: the same rules, and the automatic path still pays nothing.
  const terminal = latest({ status: "failed", errorCode: "provider_timeout" });
  assert.equal(mediaMod.isTimedOutGeneration(terminal), true);
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: terminal, hasAsset: false, now: NOW }), { kind: "exists" });
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: terminal, hasAsset: false, now: NOW, explicit: true }),
    { kind: "start_after_timeout", generationId: GENERATION_ID, token: "fresh" });
  // A dead queued start (no provider job ever existed) is stopped the same way.
  const deadQueued = latest({ status: "queued", createdAt: minutesBefore(20), updatedAt: minutesBefore(20) });
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: deadQueued, hasAsset: false, now: NOW }),
    { kind: "timeout", generationId: GENERATION_ID });
  // A non-timeout failure keeps its existing behaviour: an explicit retry is a
  // fresh attempt, and the automatic plan run may still retry it.
  const rejected = latest({ status: "failed", errorCode: "rejected" });
  assert.equal(mediaMod.isTimedOutGeneration(rejected), false);
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: rejected, hasAsset: false, now: NOW }),
    { kind: "start", token: "fresh", retireGenerationId: null });
  // Images keep their dead-synchronous-attempt handling.
  const staleImage = latest({ mediaType: "image", status: "processing", createdAt: minutesBefore(20), updatedAt: minutesBefore(20) });
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "post", latest: staleImage, hasAsset: false, now: NOW }),
    { kind: "start", token: "fresh", retireGenerationId: GENERATION_ID });
});

test("2d. the automatic path is blocked by a timed-out generation", () => {
  assert.equal(mediaMod.blocksAutomaticMedia({ hasAsset: false, hasActiveGeneration: false, latest: null }), false);
  assert.equal(mediaMod.blocksAutomaticMedia({ hasAsset: false, hasActiveGeneration: true, latest: latest() }), true);
  assert.equal(mediaMod.blocksAutomaticMedia({ hasAsset: true, hasActiveGeneration: false, latest: null }), true);
  assert.equal(
    mediaMod.blocksAutomaticMedia({ hasAsset: false, hasActiveGeneration: false, latest: latest({ status: "failed", errorCode: "provider_timeout" }) }),
    true,
    "after a timeout only the user may pay for a new generation",
  );
  assert.equal(
    mediaMod.blocksAutomaticMedia({ hasAsset: false, hasActiveGeneration: false, latest: latest({ status: "failed", errorCode: "rejected" }) }),
    false,
    "an ordinary failure keeps the existing automatic retry behaviour",
  );
});

// ===========================================================================
// 3. Beyond the hard timeout the terminal state is PERSISTED — with no
//    provider submission and no charge
// ===========================================================================

test("3a. the production row transitions generating -> failed/provider_timeout", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  const outcome = await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, deps: fake.deps });
  assert.deepEqual(outcome, { ok: true, state: "timed_out" });

  const row = db.generations().find((candidate) => candidate.id === GENERATION_ID);
  assert.equal(row.status, "failed", "never left 'generating'");
  assert.equal(row.error_code, "provider_timeout");
  assert.equal(row.provider_job_id, PROVIDER_JOB_ID, "the original provider job id stays on the row");
  assert.equal(row.provider_status, "pending", "the provider metadata is history, not rewritten");
  assert.equal(row.created_at, CREATED_AT, "the row is kept, never replaced");
  assert.deepEqual(row.provider_diagnostic.reason, "hard_timeout_exceeded");
  assert.equal(row.provider_diagnostic.limitMinutes, HARD_TIMEOUT_MINUTES);
  assert.ok(row.provider_diagnostic.jobAgeMinutes > 500, "8.5 hours old");
  assert.equal(db.generations().length, 1, "generation history is preserved: one row, terminal");
});

test("3b. detecting the timeout submits no provider job and charges nothing", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  const outcome = await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, deps: fake.deps });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.state, "timed_out");
  assert.equal(fake.calls.start, 0, "startVideo (the only paid path) was never called");
  assert.equal(fake.calls.providerJobs, 0, "no provider job was submitted");
  assert.equal(fake.calls.advance, 0, "a dead job is not re-polled either");
  assert.equal(db.writesTo("mara_media_generations").filter((write) => write.op === "insert").length, 0, "no new generation row");
  assert.equal(db.writesTo("mara_media_generations").length, 1, "exactly one write: the terminal transition");
  assert.deepEqual(db.writesTo("post_draft_assets"), [], "the draft's asset state is untouched");
  // The whole video provider stack is irrelevant here: the hard timeout is a
  // Voom-side rule, so it is enforced even with no provider configured.
  assert.equal(process.env.VIDEO_PROVIDER, undefined, "no video provider is configured in tests");
});

test("3c. the held queue row and Instagram idempotency are preserved", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, deps: fake.deps });
  assert.deepEqual(db.writesTo("instagram_publish_queue"), [], "the queue is never touched by a timeout");
  assert.deepEqual(db.writesTo("mara_drafts"), [], "the draft is never touched by a timeout");
  const queue = db.queueRows()[0];
  assert.equal(queue.status, "waiting_for_media", "still held truthfully");
  assert.equal(queue.instagram_media_id, null);
  assert.equal(queue.scheduled_at, SCHEDULED);
  // Publishing semantics unchanged: the held row is claimable at its time and
  // can never publish without an asset, and a published row is never re-claimed.
  assert.equal(publishing.isDueForPublishing({
    status: "waiting_for_media", scheduledAt: SCHEDULED, draftStatus: "approved", attempts: 0, instagramMediaId: null,
  }, NOW.getTime()), false, "never before the scheduled time");
  assert.equal(publishing.isDueForPublishing({
    status: "waiting_for_media", scheduledAt: SCHEDULED, draftStatus: "approved", attempts: 0, instagramMediaId: null,
  }, new Date(SCHEDULED).getTime() + 1_000), true);
  assert.equal(publishing.isDueForPublishing({
    status: "published", scheduledAt: SCHEDULED, draftStatus: "approved", attempts: 1, instagramMediaId: "ig-media-9001",
  }, new Date(SCHEDULED).getTime() + 1_000), false, "one publish identity per item, forever");
});

test("3d. the enforcement is idempotent and never touches a job inside its limit", async () => {
  // Already terminal: nothing to do, nothing written again.
  const terminal = createFakeAdmin(seedIncident({ generation: "failed", errorCode: "provider_timeout" }));
  const again = await videoService.enforceVideoJobHardTimeout(terminal, OWNER, GENERATION_ID, { now: NOW.getTime() });
  assert.equal(again.enforced, false);
  assert.equal(again.row.status, "failed");
  assert.deepEqual(terminal.writesTo("mara_media_generations").filter((write) => write.op === "update").length, 0);

  // Inside the hard timeout: the same call is a no-op, so a stale-but-live job
  // is never stopped early.
  const live = createFakeAdmin(seedIncident({ createdAt: minutesBefore(20), updatedAt: minutesBefore(20) }));
  const skipped = await videoService.enforceVideoJobHardTimeout(live, OWNER, GENERATION_ID, { now: NOW.getTime() });
  assert.equal(skipped.enforced, false);
  assert.equal(live.generations()[0].status, "generating");
  assert.deepEqual(live.writes, []);

  // Twice in a row beyond the limit: one transition, one row, terminal.
  const db = createFakeAdmin(seedIncident());
  const first = await videoService.enforceVideoJobHardTimeout(db, OWNER, GENERATION_ID, { now: NOW.getTime() });
  const second = await videoService.enforceVideoJobHardTimeout(db, OWNER, GENERATION_ID, { now: NOW.getTime() });
  assert.equal(first.enforced, true);
  assert.equal(second.enforced, false);
  assert.equal(db.generations().length, 1);
  assert.equal(db.generations()[0].status, "failed");
  assert.equal(db.writesTo("mara_media_generations").filter((write) => write.op === "update").length, 1);

  // A row that does not exist is not an error and writes nothing.
  const missing = await videoService.enforceVideoJobHardTimeout(db, OWNER, "00000000-0000-4000-8000-000000000000", { now: NOW.getTime() });
  assert.deepEqual(missing, { enforced: false, row: null });
});

test("3e. an unavailable provider stack neither charges nor stops a live job", async () => {
  // Stale but INSIDE the hard timeout, with no video provider configured at all
  // (the default deps): the retry reports the truthful degraded state instead
  // of implying a poll happened — and it is not a licence to start a new job.
  const live = createFakeAdmin(seedIncident({ createdAt: minutesBefore(20), updatedAt: minutesBefore(20) }));
  assert.deepEqual(
    await mediaMod.produceWorkflowMedia(live, reelRequest(), { now: NOW, explicit: true }),
    { ok: false, code: "video_provider_unavailable" },
  );
  assert.equal(live.generations()[0].status, "generating", "a job inside its limit is never stopped early");
  assert.equal(live.generations().length, 1);
  assert.deepEqual(live.writes, []);

  // Beyond the hard timeout the terminal state needs NO provider stack at all —
  // that is the whole fix: the default production deps persist it from the
  // database alone.
  const dead = createFakeAdmin(seedIncident());
  assert.deepEqual(await mediaMod.produceWorkflowMedia(dead, reelRequest(), { now: NOW }), { ok: true, state: "timed_out" });
  assert.equal(dead.generations()[0].status, "failed");
  assert.equal(dead.generations()[0].error_code, "provider_timeout");
  assert.equal(dead.generations().length, 1);
});

// ===========================================================================
// 4. "Retry as new generation" is the ONLY path to a new paid job — and it is
//    idempotent under repeated and racing clicks
// ===========================================================================

test("4a. an explicit retry after the timeout creates exactly one fresh generation", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  const outcome = await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, explicit: true, deps: fake.deps });
  assert.deepEqual(outcome, { ok: true, state: "queued" }, "truthfully: a NEW generation was submitted");

  const rows = db.generations();
  assert.equal(rows.length, 2, "the timed-out row is kept as history and one fresh row exists");
  const old = rows.find((row) => row.id === GENERATION_ID);
  const fresh = rows.find((row) => row.id !== GENERATION_ID);
  assert.equal(old.status, "failed");
  assert.equal(old.error_code, "provider_timeout");
  assert.equal(old.provider_job_id, PROVIDER_JOB_ID, "the original provider job id is preserved on the timed-out row");
  assert.equal(fresh.status, "generating");
  assert.notEqual(fresh.provider_job_id, PROVIDER_JOB_ID, "the fresh job has its own provider identity");
  assert.notEqual(fresh.idempotency_key, old.idempotency_key, "a new attempt is a new identity, never a rewrite");
  assert.equal(fake.calls.providerJobs, 1, "exactly one fresh provider job");
  assert.equal(fake.calls.start, 1);
  assert.match(fake.calls.tokens[0], new RegExp(`^workflow-${DRAFT}:`), "a fresh per-attempt token");
  // Credits: the reservation is taken BEFORE the provider seam (the ledger
  // call precedes the fake's startVideo) and settled once the job is live —
  // one video, 40 credits, one row, sharing the fresh generation's identity.
  assert.deepEqual(db.ledger.calls.map((call) => call.name), ["reserve_media_credits", "settle_media_credits"]);
  assert.deepEqual(db.ledger.rows().map((row) => [row.media_type, row.credits, row.status, row.source]), [["video", 40, "settled", "user_request"]]);
  assert.equal(db.ledger.rows()[0].generation_id, fresh.id, "the ledger row is keyed by the fresh generation");
  assert.deepEqual(db.ledger.usage(OWNER), { used: 40, allowance: 150, remaining: 110 });
  // The held schedule is untouched until a real asset exists.
  assert.equal(db.queueRows()[0].status, "waiting_for_media");
  assert.deepEqual(db.writesTo("instagram_publish_queue"), []);
});

test("4a-free. the same explicit retry on a Free account is refused before any provider or ledger work", async () => {
  const db = createFakeAdmin(seedIncident({ plan: "free" }));
  const fake = fakeVideoDeps(db);
  const outcome = await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, explicit: true, deps: fake.deps });
  assert.deepEqual(outcome, { ok: false, code: "plan_not_allowed" }, "Free has no AI media: refused truthfully");
  assert.equal(fake.calls.start, 0, "the paid path was never entered");
  assert.equal(fake.calls.providerJobs, 0);
  assert.deepEqual(db.ledger.rows(), [], "nothing was reserved");
  assert.equal(db.generations().length, 1, "no fresh row; the timed-out row is all there is");
  assert.equal(db.queueRows()[0].status, "waiting_for_media");
});

test("4b. repeated retry clicks create at most one fresh paid job", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  const outcomes = [];
  for (let click = 0; click < 4; click += 1) {
    outcomes.push(await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, explicit: true, deps: fake.deps }));
  }
  assert.deepEqual(outcomes[0], { ok: true, state: "queued" }, "the first click starts the new generation");
  for (const outcome of outcomes.slice(1)) {
    assert.deepEqual(outcome, { ok: true, state: "exists" }, "every later click is a no-op");
  }
  assert.equal(fake.calls.providerJobs, 1, "one fresh provider job, never two");
  assert.equal(fake.calls.start, 1, "the paid path was entered once");
  assert.equal(db.generations().length, 2, "the timed-out row plus exactly one fresh row");
  assert.equal(db.generations().filter((row) => ACTIVE_GEN_STATUSES.includes(row.status)).length, 1);
  assert.equal(db.ledger.rows().length, 1, "the later clicks reserved nothing");
  assert.deepEqual(db.ledger.usage(OWNER), { used: 40, allowance: 150, remaining: 110 }, "charged once");
});

test("4c. two racing clicks still create only one paid job (the database guard)", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  const [first, second] = await Promise.all([
    mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, explicit: true, deps: fake.deps }),
    mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, explicit: true, deps: fake.deps }),
  ]);
  const states = [first, second].map((outcome) => (outcome.ok ? outcome.state : outcome.code)).sort();
  assert.deepEqual(states, ["queued", "video_start_conflict"], "one job started, the other refused by the one-active-job guard");
  assert.equal(fake.calls.providerJobs, 1, "at most one fresh provider job was ever submitted");
  assert.equal(db.generations().length, 2);
  assert.equal(db.generations().filter((row) => ACTIVE_GEN_STATUSES.includes(row.status)).length, 1);
  // The loser of the race is refused BEFORE any provider job exists, so it is
  // never charged: its pre-reservation must be released, leaving exactly the
  // winner's 40 credits live — never 80 for one video.
  const live = db.ledger.live(OWNER);
  assert.deepEqual(live.map((row) => [row.credits, row.status]), [[40, "settled"]], "one live reservation for one job");
  assert.deepEqual(db.ledger.usage(OWNER), { used: 40, allowance: 150, remaining: 110 }, "the losing click cost nothing");
  const winner = db.generations().find((row) => ACTIVE_GEN_STATUSES.includes(row.status));
  assert.equal(live[0].generation_id, winner.id, "the live reservation belongs to the job that actually started");
});

test("4d. the same token resolves to the same job instead of paying twice", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  const token = `workflow-${DRAFT}:fixed-click-token`;
  const first = await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, idempotencyToken: token, explicit: true, deps: fake.deps });
  assert.equal(first.ok, true);
  assert.equal(first.state, "queued");
  // The fresh job is live now, so the policy refuses to start anything else —
  // and even if it did not, the same token maps to the same durable key.
  const second = await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, idempotencyToken: token, explicit: true, deps: fake.deps });
  assert.deepEqual(second, { ok: true, state: "exists" });
  assert.equal(fake.calls.providerJobs, 1);
  assert.equal(db.generations().length, 2);
  assert.equal(db.ledger.rows().length, 1, "the same token never pays twice");
});

test("4e. nothing automatic ever submits a fresh paid generation for a timed-out job", async () => {
  // The rolling-plan automatic path: 'already handled' short-circuits it.
  const db = createFakeAdmin(seedIncident({ generation: "failed", errorCode: "provider_timeout" }));
  assert.equal(await mediaMod.mediaAlreadyHandled(db, OWNER, DRAFT), true);
  const fake = fakeVideoDeps(db);
  assert.deepEqual(await mediaMod.ensureWorkflowMedia(db, reelRequest()), { ok: true, state: "exists" });
  assert.equal(fake.calls.start, 0);

  // Still active but beyond the hard timeout: the automatic path STOPS it (so
  // it cannot stay 'generating' forever) and submits nothing at all.
  const active = createFakeAdmin(seedIncident());
  assert.equal(await mediaMod.mediaAlreadyHandled(active, OWNER, DRAFT), true, "an in-flight job is handled, stale or not");
  const activeFake = fakeVideoDeps(active);
  assert.deepEqual(await mediaMod.ensureWorkflowMedia(active, reelRequest(), { now: NOW }), { ok: true, state: "timed_out" });
  assert.equal(active.generations()[0].status, "failed");
  assert.equal(active.generations()[0].error_code, "provider_timeout");
  const produced = await mediaMod.produceWorkflowMedia(active, reelRequest(), { now: NOW, deps: activeFake.deps });
  assert.deepEqual(produced, { ok: true, state: "exists" }, "already terminal, no click: nothing to do and nothing to pay");
  assert.equal(activeFake.calls.start, 0, "viewing/polling/re-advancing never pays");
  assert.equal(activeFake.calls.providerJobs, 0);
  assert.equal(active.generations().length, 1);
});

test("4f. the automatic plan run stops a dead job and leaves a live one alone", async () => {
  // Beyond the hard timeout: stopped (terminal), and nothing was submitted.
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  assert.deepEqual(await mediaMod.ensureWorkflowMedia(db, reelRequest(), { now: NOW, deps: fake.deps }),
    { ok: true, state: "timed_out" });
  const row = db.generations()[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "provider_timeout");
  assert.equal(row.provider_job_id, PROVIDER_JOB_ID);
  assert.equal(db.generations().length, 1);
  assert.equal(fake.calls.start, 0);
  assert.equal(fake.calls.providerJobs, 0);
  assert.equal(fake.calls.advance, 0);

  // Stale but inside the hard timeout: the automatic path neither restarts nor
  // re-polls it — the job is left exactly as it is for its owner to decide.
  const live = createFakeAdmin(seedIncident({ createdAt: minutesBefore(20), updatedAt: minutesBefore(20) }));
  const liveFake = fakeVideoDeps(live);
  assert.deepEqual(await mediaMod.ensureWorkflowMedia(live, reelRequest(), { now: NOW, deps: liveFake.deps }),
    { ok: true, state: "exists" });
  assert.equal(live.generations()[0].status, "generating");
  assert.deepEqual(live.writes, []);
  assert.equal(liveFake.calls.advance, 0);
  assert.equal(liveFake.calls.start, 0);
});

// ===========================================================================
// 5. The toast and the state are truthful
// ===========================================================================
test("5a. each outcome says exactly what happened", () => {
  const advanced = mediaMod.mediaOutcomeMessage("advanced");
  const timedOut = mediaMod.mediaOutcomeMessage("timed_out");
  const queued = mediaMod.mediaOutcomeMessage("queued");
  const exists = mediaMod.mediaOutcomeMessage("exists");

  assert.match(advanced, /re-checked/i);
  assert.match(advanced, /no new video was started/i);
  assert.match(advanced, /nothing new was charged/i);

  assert.match(timedOut, /30-minute limit/);
  assert.match(timedOut, /no new generation was started/i);
  assert.match(timedOut, /nothing was charged/i);
  assert.match(timedOut, /retry it as a new generation/i);

  assert.match(queued, /started a NEW generation/i, "a new paid generation is announced plainly");
  assert.match(exists, /nothing new was started/i);

  // A re-check or a timeout must never read like a new video was started.
  for (const message of [advanced, timedOut, exists]) {
    assert.ok(!/started a NEW generation/i.test(message));
    assert.ok(!/MARA is generating/i.test(message));
  }
});

// ===========================================================================
// 6. The draft stays waiting_for_media until a real asset exists
// ===========================================================================

test("6a. the item is held until an asset exists, then it is plainly scheduled", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, explicit: true, deps: fake.deps });

  // The fresh job is in flight: held, and NOT timed out (a new lifetime).
  let snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.equal(snapshot.items[0].status, "waiting_for_media");
  assert.equal(snapshot.items[0].queueStatus, "waiting_for_media");
  assert.equal(snapshot.items[0].hasMedia, false);

  // Still held five minutes later while the new job runs.
  snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: new Date(NOW.getTime() + 5 * 60_000) });
  assert.equal(snapshot.items[0].status, "waiting_for_media");

  // The new job times out too: the SAME draft is still held, and the item is
  // truthful about it instead of claiming progress.
  const rows = db.generations();
  const fresh = rows.find((row) => row.id !== GENERATION_ID);
  fresh.created_at = minutesBefore(45, new Date(NOW.getTime() + 6 * 60_000));
  fresh.updated_at = minutesBefore(45, new Date(NOW.getTime() + 6 * 60_000));
  snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: new Date(NOW.getTime() + 6 * 60_000) });
  assert.equal(snapshot.items[0].status, "media_timed_out");
  assert.equal(snapshot.items[0].queueStatus, "waiting_for_media");

  // The moment Voom owns the bytes the SAME item is on the normal schedule.
  db.tables.get("post_draft_assets").push({
    id: "asset-1", owner_user_id: OWNER, draft_id: DRAFT, mime_type: "video/mp4",
    origin: "mara", storage_path: `${OWNER}/post-assets/asset-1.mp4`, status: "uploaded",
  });
  fresh.status = "completed";
  snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: new Date(NOW.getTime() + 7 * 60_000) });
  assert.equal(snapshot.items[0].status, "scheduled");
  assert.equal(snapshot.items[0].hasMedia, true);
  assert.ok(readModel.todaySummary(snapshot).scheduled.some((row) => row.draftId === DRAFT));
});

test("6b. an upload replacement is the other way out and needs no provider", async () => {
  const db = createFakeAdmin(seedIncident());
  const fake = fakeVideoDeps(db);
  await mediaMod.produceWorkflowMedia(db, reelRequest(), { now: NOW, deps: fake.deps });
  assert.equal(db.generations()[0].status, "failed");

  // The user uploads their own clip through the existing ingestion route.
  db.tables.get("post_draft_assets").push({
    id: "asset-2", owner_user_id: OWNER, draft_id: DRAFT, mime_type: "video/mp4",
    origin: "user", storage_path: `${OWNER}/post-assets/asset-2.mp4`, status: "uploaded",
  });
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.equal(snapshot.items[0].status, "scheduled");
  assert.equal(snapshot.items[0].hasMedia, true);
  assert.equal(snapshot.items[0].mediaFromMara, false);
  assert.equal(fake.calls.providerJobs, 0, "no provider job was ever submitted for this recovery");
});
