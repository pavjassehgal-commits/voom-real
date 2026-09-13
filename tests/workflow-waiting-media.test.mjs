/**
 * Production incident fix: the SynraPay Reel "SynraPay Global Reach Showcase"
 * sat as draft=approved, scheduled 7:15 PM Dubai, mara_media_generations=
 * generating (OpenRouter pending), NO produced asset, NO post_draft_asset,
 * Instagram queue=waiting_for_media — and every UI showed "Scheduled /
 * Voom will publish it at the scheduled time" for an item that could never
 * publish.
 *
 * Real modules under test (no string matching where behaviour can be
 * exercised; no OpenRouter call, no paid generation, no real publishing):
 *   lib/voom/workflow/state.ts         — the ONE status derivation
 *   lib/voom/workflow/read.ts          — the shared read model (Plan/Today/Calendar)
 *   lib/voom/workflow/next-actions.ts  — the ONE next-action engine
 *   lib/voom/workflow/media.ts         — explicit + idempotent retry policy
 *   lib/instagram/publishing.ts        — due-selection + duplicate protection
 *   lib/instagram/publish-flow.ts      — the EXISTING Instagram publish sequence
 *
 * Behavioural guarantees proven here:
 *   1. approved + future schedule + no asset + waiting_for_media => Waiting for media
 *   2. stale pending generation => Media generation delayed
 *   3. no asset => cannot publish (the worker parks, never publishes)
 *   4. retry is explicit, not automatic
 *   5. repeated retry actions cannot create a duplicate paid generation
 *   6. asset arrival transitions the SAME item to the normal scheduled/publish flow
 *   plus: missed-schedule handling, the terminal published state and the
 *   Instagram idempotency guarantees are preserved, not regressed.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const state = await import("../lib/voom/workflow/state.ts");
const readModel = await import("../lib/voom/workflow/read.ts");
const mediaMod = await import("../lib/voom/workflow/media.ts");
const nextActions = await import("../lib/voom/workflow/next-actions.ts");
const flow = await import("../lib/instagram/publish-flow.ts");
const pub = await import("../lib/instagram/publishing.ts");
const tz = await import("../lib/voom/timezone.ts");

const TZ = "Asia/Dubai";
const OWNER = "owner-synrapay";
const DRAFT = "draft-reel-1";
// 1:00 PM Dubai on 2026-09-13 — well before the scheduled time.
const NOW = new Date("2026-09-13T09:00:00.000Z");
// 7:15 PM Dubai on 2026-09-13 — the incident's schedule, in the future.
const SCHEDULED = tz.localToUtcIso("2026-09-13", 19 * 60 + 15, TZ);
// A healthy in-flight generation (started 5 minutes ago) and one that has
// been "generating" for 20 minutes (beyond the 15-minute stale threshold).
const FRESH_GEN_AT = new Date(NOW.getTime() - 5 * 60_000).toISOString();
const STALE_GEN_AT = new Date(NOW.getTime() - 20 * 60_000).toISOString();

// ---------------------------------------------------------------------------
// In-memory, owner-scoped admin client shaped like the Supabase queries the
// read model and the workflow media module issue. It records every write so
// "the read model is read-only" and "no duplicate paid generation" are
// asserted on real write attempts, and it mirrors the database's final
// duplicate-generation guard (mara_media_active_per_draft_uq, migration 0025):
// a second ACTIVE generation for the same (owner, draft) is refused.
// ---------------------------------------------------------------------------

const ACTIVE_GEN_STATUSES = ["queued", "generating", "processing"];

function createFakeAdmin(tables) {
  const writes = [];

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
    upsert() { throw new Error(`fake admin: ${this.table} upsert not needed`); }
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
        writes.push({ table: this.table, op: "insert" });
        if (this.table === "mara_media_generations") {
          for (const row of this.insertRows) {
            const clash = this._base().some((existing) =>
              existing.owner_user_id === row.owner_user_id
              && existing.draft_id === row.draft_id
              && ACTIVE_GEN_STATUSES.includes(existing.status));
            if (clash) {
              return { data: null, error: { message: "duplicate key value violates unique constraint mara_media_active_per_draft_uq" } };
            }
          }
        }
        for (const row of this.insertRows) this._base().push(row);
        return { data: [...this.insertRows], error: null };
      }
      if (this.patch) {
        writes.push({ table: this.table, op: "update" });
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
    from: (table) => new Query(table),
    storage: {
      from: () => ({
        createSignedUrl: async (path) => ({ data: { signedUrl: `https://signed.invalid/${path}` } }),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// The incident fixture: one approved Reel scheduled 7:15 PM Dubai, a
// generating video job (OpenRouter pending), no stored asset, and the queue
// row held truthfully in 'waiting_for_media'.
// ---------------------------------------------------------------------------

function seedIncident(options = {}) {
  const generations = [];
  const assets = [];
  const queue = [];
  if (options.generation !== null) {
    generations.push({
      id: "gen-1", owner_user_id: OWNER, conversation_id: "conv-1", draft_id: DRAFT,
      media_type: "video", prompt: "Clean 9:16 global reach visual.", aspect_ratio: "9:16",
      status: options.generation ?? "generating",
      updated_at: options.updatedAt ?? FRESH_GEN_AT,
      created_at: options.updatedAt ?? FRESH_GEN_AT,
      idempotency_key: "video:post:00000000000000000000000000000000:workflow-00000000000000000000000000000000",
    });
  }
  if (options.asset) {
    assets.push({
      id: "asset-1", owner_user_id: OWNER, draft_id: DRAFT, mime_type: "video/mp4",
      origin: "mara", storage_path: `${OWNER}/post-assets/asset-1.mp4`, status: "uploaded",
    });
  }
  if (options.queue !== null) {
    queue.push({
      id: "queue-1", owner_user_id: OWNER, draft_id: DRAFT, calendar_item_id: "cal-1",
      media_kind: "reel", caption: "SynraPay Global Reach Showcase", scheduled_at: SCHEDULED,
      status: options.queue ?? "waiting_for_media", attempts: 0, instagram_media_id: null, failure_message: null,
    });
  }
  return new Map(Object.entries({
    businesses: [{ owner_user_id: OWNER, content_frequency: "Daily", automation_level: "assisted", timezone: TZ }],
    marketing_plans: [{
      id: "plan-1", owner_user_id: OWNER, business_goal: "Global reach", status: "active",
      valid_from: "2026-09-13", valid_until: "2026-09-19", created_at: "2026-09-13T08:00:00Z",
    }],
    mara_drafts: [{
      id: DRAFT, owner_user_id: OWNER, source_plan_id: "plan-1", kind: "reel",
      title: "SynraPay Global Reach Showcase", content: "Show the Global Reach milestone.",
      status: "approved", source_plan_item_key: "2026-09-13", proposed_publish_at: SCHEDULED,
      conversation_id: "conv-1", media_brief: "Clean 9:16 global reach visual.",
      created_at: "2026-09-13T08:00:00Z",
    }],
    post_draft_assets: assets,
    mara_media_generations: generations,
    instagram_publish_queue: queue,
    content_calendar_items: [{ id: "cal-1", owner_user_id: OWNER, source_draft_id: DRAFT }],
    mara_pending_actions: [],
  }));
}

function incidentFacts(overrides = {}) {
  return {
    draftStatus: "approved", hasMedia: false,
    mediaStatus: "generating", mediaUpdatedAt: FRESH_GEN_AT,
    publishStatus: "waiting_for_media", awaitingApproval: false,
    publishAt: SCHEDULED, now: NOW,
    ...overrides,
  };
}

function planCardFacts(item) {
  return {
    contentType: "reel", stage: item.status, failedStage: item.failedStage, mode: "assisted",
    publishAt: item.publishAt, dayLabel: item.dayLabel, localTime: item.localTime,
    hasMedia: item.hasMedia, mediaStatus: item.mediaStatus,
  };
}

// ===========================================================================
// 1. approved + future schedule + no asset + waiting_for_media => Waiting
//    for media — never plain "Scheduled"
// ===========================================================================

test("1a. the incident's exact facts derive Waiting for media, never Scheduled", () => {
  const status = state.deriveWorkflowStatus(incidentFacts());
  assert.equal(status, "waiting_for_media");
  assert.notEqual(status, "scheduled", "the production UI bug: plain Scheduled for an item that cannot publish");
  assert.equal(state.WORKFLOW_STATUS_LABELS.waiting_for_media, "Waiting for media");
  // The schedule is real and future: a missed derivation must not fire either.
  assert.notEqual(status, "missed");
});

test("1b. waiting_for_media holds whether the generation is fresh, queued, or never started", () => {
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "generating" })), "waiting_for_media");
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "queued" })), "waiting_for_media");
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "processing" })), "waiting_for_media");
  // Approved but the generation was never started (or was cancelled): still
  // truthfully waiting, with an explicit retry available — not "Scheduled".
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: null })), "waiting_for_media");
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "cancelled" })), "waiting_for_media");
});

test("1c. the shared read model (Marketing Plan / Today / Calendar) shows the truth", async () => {
  const db = createFakeAdmin(seedIncident());
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.equal(snapshot.items.length, 1);
  const item = snapshot.items[0];
  assert.equal(item.draftId, DRAFT);
  assert.equal(item.localTime, "7:15 PM");
  assert.equal(item.status, "waiting_for_media");
  assert.equal(item.statusLabel, "Waiting for media");
  assert.equal(item.queueStatus, "waiting_for_media");
  assert.equal(item.hasMedia, false);
  assert.equal(item.mediaStatus, "generating");

  // Today: the item is bucketed as waiting for media, NOT as scheduled.
  const summary = readModel.todaySummary(snapshot);
  assert.deepEqual(summary.waitingForMedia.map((row) => row.draftId), [DRAFT]);
  assert.ok(!summary.scheduled.some((row) => row.draftId === DRAFT), "never counted as Scheduled on Today");

  // The card's ONE next-action engine agrees with the label and explains that
  // the content is scheduled but cannot publish until the visual is ready.
  const resolved = nextActions.planItemActions(planCardFacts(item));
  assert.equal(resolved.stage, "waiting_for_media");
  assert.equal(resolved.stageLabel, "Waiting for media");
  assert.match(resolved.headline, /scheduled/i);
  assert.match(resolved.headline, /cannot publish until the visual is ready/i);
  assert.match(resolved.explanation.autoPublish, /cannot publish until the visual is ready/i);
  assert.deepEqual(resolved.actions.map((action) => action.id), ["retry_media", "upload_asset", "cancel_schedule"]);
});

// ===========================================================================
// 2. stale pending generation => Media generation delayed
// ===========================================================================

test("2a. a generation pending beyond the stale threshold derives Media generation delayed", () => {
  assert.equal(state.WORKFLOW_STATUS_LABELS.media_delayed, "Media generation delayed");
  // 20 minutes "generating" (OpenRouter pending) — beyond the 15-minute threshold.
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "generating", mediaUpdatedAt: STALE_GEN_AT })), "media_delayed");
  // "queued" for 20 minutes (the start request died before the provider job).
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "queued", mediaUpdatedAt: STALE_GEN_AT })), "media_delayed");
  // The threshold is strict: exactly at it is still waiting, one second past it is delayed.
  const atThreshold = new Date(NOW.getTime() - state.MEDIA_GENERATION_STALE_MINUTES * 60_000).toISOString();
  const pastThreshold = new Date(NOW.getTime() - state.MEDIA_GENERATION_STALE_MINUTES * 60_000 - 1_000).toISOString();
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "generating", mediaUpdatedAt: atThreshold })), "waiting_for_media");
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "generating", mediaUpdatedAt: pastThreshold })), "media_delayed");
  // A FINISHED attempt is never "stale" — a failed generation is a failure, full stop.
  assert.equal(state.deriveWorkflowStatus(incidentFacts({ mediaStatus: "failed", mediaUpdatedAt: STALE_GEN_AT })), "failed");
});

test("2b. the read model derives delayed from the generation row's updated_at", async () => {
  const db = createFakeAdmin(seedIncident({ updatedAt: STALE_GEN_AT }));
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  const item = snapshot.items[0];
  assert.equal(item.status, "media_delayed");
  assert.equal(item.statusLabel, "Media generation delayed");

  // The delayed card offers the explicit, ordered action trio.
  const resolved = nextActions.planItemActions(planCardFacts(item));
  assert.deepEqual(resolved.actions.map((action) => action.id), ["retry_media", "upload_asset", "cancel_schedule"]);
  const retry = resolved.actions[0];
  assert.equal(retry.id, "retry_media");
  assert.equal(retry.tone, "primary");
  assert.match(retry.hint, /double[- ](charge|bill)/i);
});

test("2c. a stale generation never hides a missed schedule (missed handling preserved)", () => {
  // 9:15 PM Dubai: the 7:15 PM schedule passed with no media and the job is stale.
  const later = new Date(new Date(SCHEDULED).getTime() + 60 * 60_000);
  const facts = incidentFacts({ mediaStatus: "generating", mediaUpdatedAt: STALE_GEN_AT, now: later });
  assert.equal(state.deriveWorkflowStatus(facts), "missed");
  assert.match(String(state.missedReason(facts)), /waiting for the visual/i);
  // The missed card keeps its explicit recovery actions (never an auto late publish).
  const resolved = nextActions.planItemActions({
    contentType: "reel", stage: "missed", failedStage: null, mode: "assisted",
    publishAt: SCHEDULED, dayLabel: "Today", localTime: "7:15 PM", hasMedia: false,
  });
  // With NO stored visual, "Post now" cannot succeed — Instagram has nothing
  // to publish — so it is offered but disabled, and the card leads with the
  // actions that actually recover the item.
  assert.deepEqual(resolved.actions.map((action) => action.id), ["post_now", "retry_media", "upload_asset", "reschedule", "cancel_schedule"]);
  const postNow = resolved.actions[0];
  assert.equal(postNow.disabled, true, "an item with no stored media can never be posted now");
  assert.match(String(postNow.disabledReason), /no stored visual/i);

  // Once the visual exists, the same missed card offers the normal recovery.
  const withMedia = nextActions.planItemActions({
    contentType: "reel", stage: "missed", failedStage: null, mode: "assisted",
    publishAt: SCHEDULED, dayLabel: "Today", localTime: "7:15 PM", hasMedia: true,
  });
  assert.deepEqual(withMedia.actions.map((action) => action.id), ["post_now", "reschedule", "cancel_schedule"]);
  assert.notEqual(withMedia.actions[0].disabled, true);
});

// ===========================================================================
// 3. no asset => cannot publish
// ===========================================================================

function publishPorts(asset, counters) {
  return {
    loadDraft: async () => ({ status: "approved", content: "caption" }),
    loadConnection: async () => ({ status: "connected", scopes: [pub.INSTAGRAM_PUBLISH_PERMISSION], tokenExpiresAt: null }),
    loadCredentials: async () => ({ igUserId: "ig-1", accessToken: "token" }),
    loadAsset: async () => asset,
    signMediaUrl: async () => { counters.signCalls += 1; return "https://signed.invalid/x"; },
    createContainer: async () => { counters.containerCalls += 1; return "container-1"; },
    containerStatus: async () => { counters.pollCalls += 1; return "FINISHED"; },
    publishContainer: async () => { counters.publishCalls += 1; return "ig-media-9001"; },
    findPublishedMediaId: async () => null,
    persistContainerId: async () => {},
    markPublished: async () => { counters.markPublishedCalls += 1; },
    markFailed: async (_item, input) => { counters.markFailed = input; },
    sleep: async () => {},
    now: () => NOW.getTime(),
  };
}

function flowItem() {
  return {
    id: "queue-1", ownerUserId: OWNER, draftId: DRAFT, mediaKind: "reel",
    caption: "SynraPay Global Reach Showcase", attempts: 0, containerId: null, instagramMediaId: null,
  };
}

test("3a. with no stored visual the publish flow parks as waiting_for_media — it never publishes", async () => {
  const counters = { signCalls: 0, containerCalls: 0, pollCalls: 0, publishCalls: 0, markPublishedCalls: 0, markFailed: null };
  const outcome = await flow.runPublishFlow(flowItem(), publishPorts(null, counters));
  assert.equal(outcome.outcome, "retrying");
  assert.equal(outcome.code, "media_missing");
  assert.equal(counters.markFailed.status, "waiting_for_media", "the truthful queue state, not a fake failure");
  assert.equal(counters.containerCalls, 0, "no Meta container is created without an asset");
  assert.equal(counters.publishCalls, 0, "media_publish is never called without an asset");
  assert.equal(counters.markPublishedCalls, 0, "nothing is ever marked published");
});

test("3b. the due-selection still claims a waiting row at its time — so the park, not a publish, is what happens", () => {
  // Claimable once due (it carries the future scheduled_at as its retry time)…
  assert.equal(pub.isDueForPublishing({
    status: "waiting_for_media", scheduledAt: SCHEDULED, draftStatus: "approved", attempts: 0, instagramMediaId: null,
  }, NOW.getTime()), false, "…but never before the scheduled time");
  const atDue = new Date(SCHEDULED).getTime() + 1000;
  assert.equal(pub.isDueForPublishing({
    status: "waiting_for_media", scheduledAt: SCHEDULED, draftStatus: "approved", attempts: 0, instagramMediaId: null,
  }, atDue), true);
});

test("3c. Post now is blocked without a stored visual (server action guard)", async () => {
  const source = await readFile(new URL("../lib/voom/workflow/actions-server.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function postPlanItemNow");
  const body = source.slice(start, source.indexOf("export async function", start + 10));
  const guard = body.slice(0, body.indexOf("enqueuePublishItem"));
  assert.match(guard, /visualReady/, "post-now requires a stored visual");
  assert.match(guard, /no stored visual yet/i);
});

// ===========================================================================
// 4. retry is explicit, not automatic
// ===========================================================================

test("4a. the automatic path never restarts a generation (live or stale)", async () => {
  // The rolling-plan auto path asks mediaAlreadyHandled first; an in-flight
  // generation — even a stale one — is "handled", so no automatic retry and
  // no second paid generation is ever started by automation.
  const db = createFakeAdmin(seedIncident({ updatedAt: STALE_GEN_AT }));
  assert.equal(await mediaMod.mediaAlreadyHandled(db, OWNER, DRAFT), true);
  const fresh = createFakeAdmin(seedIncident());
  assert.equal(await mediaMod.mediaAlreadyHandled(fresh, OWNER, DRAFT), true);
});

test("4b. reading the workflow never mutates anything, even for a delayed item", async () => {
  const db = createFakeAdmin(seedIncident({ updatedAt: STALE_GEN_AT }));
  await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.deepEqual(db.writes, [], "the read model never inserts/updates/deletes");
});

test("4c. the card only ever offers retry as a user action — disabled while a job is in flight", () => {
  const inFlight = nextActions.planItemActions({
    contentType: "reel", stage: "waiting_for_media", failedStage: null, mode: "assisted",
    publishAt: SCHEDULED, hasMedia: false, mediaStatus: "generating",
  });
  const retry = inFlight.actions.find((action) => action.id === "retry_media");
  assert.ok(retry, "retry is offered");
  assert.ok(retry.disabled, "…but disabled while a generation is in flight, so a click starts nothing");
  const noJob = nextActions.planItemActions({
    contentType: "reel", stage: "waiting_for_media", failedStage: null, mode: "assisted",
    publishAt: SCHEDULED, hasMedia: false, mediaStatus: null,
  });
  assert.ok(!noJob.actions.find((action) => action.id === "retry_media").disabled, "enabled when nothing is in flight");
});

// ===========================================================================
// 5. repeated retry actions cannot create a duplicate paid generation
// ===========================================================================

test("5a. the retry policy (decideMediaStart) is explicit and idempotent", () => {
  // Fresh in-flight: every repeated click is a no-op — nothing starts, nothing is charged.
  assert.deepEqual(mediaMod.decideMediaStart({
    contentType: "post", latest: { id: "gen-1", status: "processing", updatedAt: FRESH_GEN_AT }, hasAsset: false, now: NOW,
  }), { kind: "exists" });
  // Stale in-flight VIDEO: re-advance the SAME job — a second provider job is never submitted.
  assert.deepEqual(mediaMod.decideMediaStart({
    contentType: "reel", latest: { id: "gen-1", status: "generating", updatedAt: STALE_GEN_AT }, hasAsset: false, now: NOW,
  }), { kind: "advance", generationId: "gen-1" });
  // Stale in-flight IMAGE: the dead synchronous attempt is retired and ONE fresh attempt starts.
  assert.deepEqual(mediaMod.decideMediaStart({
    contentType: "post", latest: { id: "gen-1", status: "processing", updatedAt: STALE_GEN_AT }, hasAsset: false, now: NOW,
  }), { kind: "start", token: "fresh", retireGenerationId: "gen-1" });
  // First run: the stable per-draft token (repeated clicks resolve to the same job).
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "reel", latest: null, hasAsset: false, now: NOW }),
    { kind: "start", token: "stable", retireGenerationId: null });
  // Explicit retry after a FINISHED attempt: a fresh identity — the old row is
  // terminal, so a new attempt is an attempt, never a duplicate of anything running.
  assert.deepEqual(mediaMod.decideMediaStart({
    contentType: "reel", latest: { id: "gen-1", status: "failed", updatedAt: STALE_GEN_AT }, hasAsset: false, now: NOW,
  }), { kind: "start", token: "fresh", retireGenerationId: null });
  // Stored asset + plain retry: no-op. Only an explicit Regenerate pays again.
  assert.deepEqual(mediaMod.decideMediaStart({
    contentType: "reel", latest: { id: "gen-1", status: "completed", updatedAt: STALE_GEN_AT }, hasAsset: true, now: NOW,
  }), { kind: "exists" });
  // Explicit regenerate token always passes through unchanged.
  assert.deepEqual(mediaMod.decideMediaStart({ contentType: "post", latest: null, hasAsset: false, now: NOW, explicitToken: "regen-token" }),
    { kind: "start", token: "regen-token", retireGenerationId: null });
});

test("5b. repeated retry clicks through the real media path create zero extra generation rows", async () => {
  // Image: a fresh in-flight attempt — three repeated retries, zero new rows, zero provider work.
  const imageDb = createFakeAdmin(seedIncident({ generation: "processing", updatedAt: FRESH_GEN_AT, queue: null }));
  const request = { ownerId: OWNER, draftId: DRAFT, conversationId: "conv-1", contentType: "post", concept: "A post", visualBrief: "brief" };
  for (let click = 0; click < 3; click += 1) {
    assert.deepEqual(await mediaMod.produceWorkflowMedia(imageDb, request, { now: NOW }), { ok: true, state: "exists" });
  }
  assert.equal(
    imageDb.writes.filter((write) => write.table === "mara_media_generations" && write.op === "insert").length,
    0, "no second (paid) generation row is ever created while one is in flight",
  );

  // Video: a stale in-flight job (still INSIDE the 30-minute hard timeout) —
  // retry re-checks the same job; still no new row. The outcome is truthfully
  // "advanced", never "queued": nothing new was started, so the toast cannot
  // claim a new video generation began.
  const videoDb = createFakeAdmin(seedIncident({ generation: "generating", updatedAt: STALE_GEN_AT, queue: null }));
  const reelRequest = { ...request, contentType: "reel" };
  let advanceCalls = 0;
  for (let click = 0; click < 2; click += 1) {
    const outcome = await mediaMod.produceWorkflowMedia(videoDb, reelRequest, {
      now: NOW,
      explicit: true,
      deps: { advance: async () => { advanceCalls += 1; return "advanced"; } },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.state, "advanced");
    assert.match(mediaMod.mediaOutcomeMessage("advanced"), /no new video was started/i);
  }
  assert.equal(advanceCalls, 2, "the SAME durable job is re-checked, never replaced");
  assert.equal(
    videoDb.writes.filter((write) => write.table === "mara_media_generations" && write.op === "insert").length,
    0, "an in-flight video job is never replaced by a second paid job",
  );

  // No provider stack at all: the retry cannot even re-check the job, and it
  // says so instead of implying a poll happened. Still nothing was started.
  const unconfigured = createFakeAdmin(seedIncident({ generation: "generating", updatedAt: STALE_GEN_AT, queue: null }));
  const unavailable = await mediaMod.produceWorkflowMedia(unconfigured, reelRequest, { now: NOW, explicit: true });
  assert.deepEqual(unavailable, { ok: false, code: "video_provider_unavailable" });
  assert.equal(
    unconfigured.writes.filter((write) => write.table === "mara_media_generations" && write.op === "insert").length,
    0, "an unavailable provider never becomes a new paid generation",
  );
});

test("5c. the duplicate-generation guard also lives in the database", async () => {
  const migration = await readFile(new URL("../supabase/migrations/0025_mara_media_video_generation.sql", import.meta.url), "utf8");
  assert.match(migration, /unique index if not exists mara_media_active_per_draft_uq[\s\S]*?where draft_id is not null and status in \('queued','generating','processing'\)/);
  // And the app-level policy never even attempts a conflicting insert: the
  // image path inserts the row BEFORE any provider call, so a conflict fails
  // safely without a charge.
  const media = await readFile(new URL("../lib/voom/workflow/media.ts", import.meta.url), "utf8");
  const imageStart = media.indexOf("async function generateWorkflowImage");
  const imageBody = media.slice(imageStart, media.indexOf("export function buildVisualPrompt", imageStart));
  const insertAt = imageBody.indexOf(".insert(");
  const providerAt = imageBody.indexOf("createMediaProvider");
  assert.ok(insertAt !== -1 && providerAt !== -1 && insertAt < providerAt, "row persisted before any paid provider call");
});

test("5d. the video token resolves to the same job identity on repeated first-run clicks", () => {
  assert.equal(mediaMod.resolveGenerationToken("stable", DRAFT), `workflow-${DRAFT}`);
  assert.equal(mediaMod.resolveGenerationToken("my-token", DRAFT), "my-token");
  const a = mediaMod.resolveGenerationToken("fresh", DRAFT);
  const b = mediaMod.resolveGenerationToken("fresh", DRAFT);
  assert.match(a, new RegExp(`^workflow-${DRAFT}:`));
  assert.notEqual(a, b, "a fresh token is a NEW attempt identity, only used for explicit retries");
});

// ===========================================================================
// 6. asset arrival transitions the SAME item to the normal scheduled/publish flow
// ===========================================================================

test("6a. once Voom owns the bytes the held item derives Scheduled, not Waiting", () => {
  // The late-media sync has not flipped the queue row yet — still, a stored
  // visual means the item is on the normal schedule, never "waiting" forever.
  assert.equal(state.deriveWorkflowStatus({
    draftStatus: "approved", hasMedia: true, mediaStatus: "completed",
    publishStatus: "waiting_for_media", awaitingApproval: false, publishAt: SCHEDULED, now: NOW,
  }), "scheduled");
  // And once the sync flips the row, it is plainly scheduled.
  assert.equal(state.deriveWorkflowStatus({
    draftStatus: "approved", hasMedia: true, mediaStatus: "completed",
    publishStatus: "scheduled", awaitingApproval: false, publishAt: SCHEDULED, now: NOW,
  }), "scheduled");
});

test("6b. the read model: the incident item with a stored visual is Scheduled", async () => {
  const db = createFakeAdmin(seedIncident({ generation: "completed", updatedAt: NOW.toISOString(), asset: true }));
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  const item = snapshot.items[0];
  assert.equal(item.status, "scheduled");
  assert.equal(item.statusLabel, "Scheduled");
  assert.equal(item.hasMedia, true);
  assert.equal(item.mediaFromMara, true);
  assert.ok(item.mediaPreviewUrl, "the stored visual has a short-lived preview");
  const summary = readModel.todaySummary(snapshot);
  assert.ok(!summary.waitingForMedia.some((row) => row.draftId === DRAFT), "no longer waiting for media");
  assert.ok(summary.scheduled.some((row) => row.draftId === DRAFT), "back on the normal scheduled flow");
});

test("6c. the SAME queue row publishes exactly once when the asset is there", async () => {
  const counters = { signCalls: 0, containerCalls: 0, pollCalls: 0, publishCalls: 0, markPublishedCalls: 0, markFailed: null };
  const asset = { storagePath: `${OWNER}/post-assets/asset-1.mp4`, mimeType: "video/mp4", status: "uploaded" };
  const atDue = new Date(SCHEDULED).getTime() + 1000;
  assert.equal(pub.isDueForPublishing({
    status: "waiting_for_media", scheduledAt: SCHEDULED, draftStatus: "approved", attempts: 0, instagramMediaId: null,
  }, atDue), true);
  const outcome = await flow.runPublishFlow(flowItem(), publishPorts(asset, counters));
  assert.equal(outcome.outcome, "published");
  assert.equal(outcome.mediaId, "ig-media-9001");
  assert.equal(counters.publishCalls, 1, "media_publish is called exactly once");
  assert.equal(counters.markFailed, null, "no failure is recorded");
  // Terminal state + Instagram idempotency preserved: a published row is
  // never claimable again, and a rerun of the flow is a no-op.
  assert.equal(pub.isDueForPublishing({
    status: "published", scheduledAt: SCHEDULED, draftStatus: "approved", attempts: 0, instagramMediaId: "ig-media-9001",
  }, atDue), false);
  const rerun = await flow.runPublishFlow({ ...flowItem(), instagramMediaId: "ig-media-9001" }, publishPorts(asset, counters));
  assert.equal(rerun.outcome, "published");
  assert.equal(counters.publishCalls, 1, "the rerun must not call Meta again");
});

// ===========================================================================
// Cross-view consistency + the other preserved guarantees
// ===========================================================================

test("7a. waiting/delayed items rescheduled beyond the horizon stay visible in every view", () => {
  const today = "2026-09-13";
  for (const status of ["waiting_for_media", "media_delayed"]) {
    assert.equal(
      readModel.isCurrentWorkflowItem({ slotDate: "2026-09-25", localDate: "2026-09-25", status }, { today }),
      true, `${status} beyond the horizon is live scheduled work and must not be hidden`,
    );
  }
});

test("7b. every workflow status has a shared label, and the new states are in the shared vocabulary", () => {
  assert.ok(state.WORKFLOW_STATUSES.includes("waiting_for_media"));
  assert.ok(state.WORKFLOW_STATUSES.includes("media_delayed"));
  for (const status of state.WORKFLOW_STATUSES) {
    assert.equal(typeof state.WORKFLOW_STATUS_LABELS[status], "string", `${status} needs a shared label`);
    const resolved = nextActions.planItemActions({
      contentType: "post", stage: status, failedStage: status === "failed" ? "media" : null,
      mode: "assisted", publishAt: SCHEDULED, hasMedia: false,
    });
    assert.equal(resolved.stageLabel, state.WORKFLOW_STATUS_LABELS[status], `${status} uses the shared label`);
    assert.ok(resolved.headline.length > 0, `${status} has a next-step headline`);
  }
});

test("7c. waiting_for_media is retryable; publishing/missed semantics are unchanged", () => {
  assert.equal(state.isRetryable("media_delayed"), true);
  assert.equal(state.isRetryable("failed"), true);
  assert.equal(state.isRetryable("missed"), true);
  assert.equal(state.isRetryable("scheduled"), false);
  assert.equal(state.isRetryable("waiting_for_media"), false, "waiting is in progress, not a failure to retry blindly");
  // Terminal published never regresses, even with odd media facts.
  assert.equal(state.deriveWorkflowStatus({
    draftStatus: "approved", hasMedia: true, mediaStatus: "failed",
    publishStatus: "published", awaitingApproval: false, publishAt: SCHEDULED, now: NOW,
  }), "published");
});
