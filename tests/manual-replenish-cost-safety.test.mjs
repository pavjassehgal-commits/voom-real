/**
 * Manual + Replenish plan is planning-only — the SynraPay cost-control incident.
 *
 * Production facts reproduced here: automation_level = "manual", the owner
 * clicked "Replenish plan" (POST /api/plan without stage), the route coerced
 * Manual into an Assisted-style run, `ensureMedia` ran, and one paid Seedream
 * request was submitted (OpenRouter $47.99 → $47.45) for a Premium Payment
 * Pulse image the user never asked MARA to create.
 *
 * Real modules under test (behaviour, not string matching):
 *   lib/voom/automation.ts             — mayAutomaticallyGeneratePaidMedia(mode, trigger)
 *   lib/voom/workflow/rolling-plan.ts  — the engine + resolveWorkflowStage
 *   lib/voom/workflow/service.ts       — runOwnerWorkflow / buildWorkflowPorts
 *                                        (the REAL ports, incl. the hard guard)
 *   lib/voom/workflow/media.ts         — produceWorkflowMedia (explicit click)
 *   lib/voom/workflow/read.ts          — the Marketing Plan read model
 *   lib/voom/workflow/next-actions.ts  — the card actions
 *
 * Everything external is faked in memory: Supabase (a table-backed admin
 * client, including the credit-ledger RPCs of migration 0035), the AI copy
 * provider (global fetch is intercepted and every request is recorded) and the
 * two paid provider seams of lib/voom/workflow/media.ts (`generateImage` =
 * Seedream, `startVideo` = Seedance), which are swapped for recording fakes
 * via the module's own `deps` port — production wiring is never touched. No
 * OpenRouter call, no cron, no publishing. "Zero provider requests" is
 * asserted at both boundaries: the seams AND the network.
 *
 * Plans + Credits v1 (the authoritative policy this suite now pins):
 *   Free = Manual only, 0 credits, no AI media at all;
 *   Pro  = Manual + Assisted, 150 credits, explicit generation only;
 *   Max  = Manual + Assisted + Autopilot, 500 credits.
 *   Image = 5 credits, video = 40 credits. ONLY Autopilot may generate paid
 *   media automatically — Assisted, like Manual, plans and drafts and waits
 *   for an explicit Create with MARA click.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFakeCreditLedger, waitFor } from "./helpers/credit-ledger-fake.mjs";

// MARA copy is the free internal planning step; it is answered by the fake
// fetch below (AI_PROVIDER=local needs no API key). No media provider is
// configured in this process — and the paid seams are intercepted anyway.
process.env.AI_PROVIDER = "local";
process.env.AI_BASE_URL = "http://ai.test.invalid/v1";
process.env.AI_MODEL = "fake-copy-model";

const automation = await import("../lib/voom/automation.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const service = await import("../lib/voom/workflow/service.ts");
const mediaMod = await import("../lib/voom/workflow/media.ts");
const readModel = await import("../lib/voom/workflow/read.ts");
const nextActions = await import("../lib/voom/workflow/next-actions.ts");
const tz = await import("../lib/voom/timezone.ts");

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const OWNER = "owner-synrapay";
const TZ = "Asia/Dubai";
// 2026-09-12 09:00 Dubai (05:00 UTC): a deterministic "today".
const NOW = new Date("2026-09-12T05:00:00.000Z");

// ---------------------------------------------------------------------------
// Network boundary: every fetch is recorded; nothing leaves the process.
// ---------------------------------------------------------------------------

const network = { calls: [], imageResponder: null };
const realFetch = globalThis.fetch;

function U16BE(value) { return Buffer.from([(value >> 8) & 0xff, value & 0xff]); }
function jpeg(width, height) {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), U16BE(16), Buffer.from("JFIF\0", "binary"), Buffer.from([1, 1, 0, 0x48, 0, 0x48, 0, 0, 0]),
    Buffer.from([0xff, 0xc0]), U16BE(17), Buffer.from([8]), U16BE(height), U16BE(width), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    Buffer.from([0xff, 0xd9]),
  ]));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
  network.calls.push({ url: href, method: init.method ?? "GET", body });

  // MARA copy (free-tier internal planning logic): a canned structured reply.
  if (href.endsWith("/chat/completions")) {
    const user = body?.messages?.find((m) => m.role === "user")?.content ?? "{}";
    let slotDate = "unknown";
    let contentType = "post";
    try { const payload = JSON.parse(user); slotDate = payload.localDate ?? slotDate; contentType = payload.contentType ?? contentType; } catch { /* fine */ }
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        concept: `Premium Payment Pulse ${contentType} ${slotDate}`,
        caption: "A calm look at how SynraPay keeps checkout moving. Visit us this week.",
        cta: "Visit us this week",
        hashtags: contentType === "story" ? [] : ["#synrapay", "#payments"],
        visualBrief: "Warm natural light, clean composition, no text.",
      }) } }],
    });
  }

  // Nothing else may leave the process: not OpenRouter's image or video
  // endpoints, not Magic Hour, not Meta.
  throw new Error(`unexpected network call in test: ${href}`);
};

test.after(() => { globalThis.fetch = realFetch; });

/**
 * The paid provider seams, faked and recorded. `generateImage` is the only
 * place a Seedream request can originate; `startVideo` the only place a
 * Seedance job can. Every call is a "provider request" for the assertions.
 */
const provider = { image: [], video: [], imageResponder: null };
const fakeMediaDeps = {
  async generateImage(input) {
    provider.image.push(input);
    if (provider.imageResponder) return provider.imageResponder(input);
    const dims = input.aspectRatio === "9:16" ? [1080, 1920] : [1024, 1024];
    return { provider: "openrouter", bytes: jpeg(...dims) };
  },
  async startVideo(args) {
    provider.video.push(args);
    return { status: 503, error: "no video provider in tests", generation: null };
  },
  async advance() { return "unavailable"; },
  async enforceTimeout() { return { enforced: false }; },
};

function resetNetwork() { network.calls.length = 0; provider.image.length = 0; provider.video.length = 0; provider.imageResponder = null; }
const imageRequests = () => provider.image;
const videoRequests = () => provider.video;
const copyRequests = () => network.calls.filter((call) => call.url.endsWith("/chat/completions"));
const nonCopyNetwork = () => network.calls.filter((call) => !call.url.endsWith("/chat/completions"));

// ---------------------------------------------------------------------------
// In-memory Supabase admin: table-backed, records writes and RPCs.
// ---------------------------------------------------------------------------

let idSeq = 0;
const nextId = (prefix) => `${prefix}-${++idSeq}`;

function containsMatch(value, needle) {
  if (needle && typeof needle === "object" && !Array.isArray(needle)) {
    if (!value || typeof value !== "object") return false;
    return Object.entries(needle).every(([key, expected]) => value[key] === expected);
  }
  return value === needle;
}

function createFakeAdmin(tables) {
  const writes = [];
  const rpcs = [];
  // The credit ledger of migration 0035, in memory: the REAL entitlement guard
  // and ledger module run against it, so "exactly one paid job" is also
  // "exactly one reservation" — and a Free account is refused before any seam.
  const ledger = createFakeCreditLedger(tables, { now: () => NOW });

  class Query {
    constructor(table) {
      this.table = table; this.filters = []; this.orderColumn = null; this.orderDirection = 1;
      this.limitCount = null; this.patch = null; this.insertRows = null; this.upsertOptions = null;
      this.deleting = false; this.selectOptions = null;
    }
    select(_columns, options) { this.selectOptions = options ?? null; return this; }
    insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, options = {}) { this.insertRows = Array.isArray(rows) ? rows : [rows]; this.upsertOptions = options; return this; }
    update(patch) { this.patch = patch; return this; }
    delete() { this.deleting = true; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { const set = new Set(values.map(String)); this.filters.push((row) => set.has(String(row[column]))); return this; }
    gte(column, value) { this.filters.push((row) => String(row[column] ?? "") >= String(value)); return this; }
    contains(column, needle) { this.filters.push((row) => containsMatch(row[column], needle)); return this; }
    order(column, options = {}) { this.orderColumn = column; this.orderDirection = options.ascending === false ? -1 : 1; return this; }
    limit(count) { this.limitCount = count; return this; }
    _base() { if (!tables.has(this.table)) tables.set(this.table, []); return tables.get(this.table); }
    _rows() { return this._base().filter((row) => this.filters.every((match) => match(row))); }
    _execute() {
      const base = this._base();
      if (this.insertRows) {
        const out = [];
        for (const incoming of this.insertRows) {
          const row = { id: nextId(this.table), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...incoming };
          writes.push({ table: this.table, op: this.upsertOptions ? "upsert" : "insert", row });
          if (this.upsertOptions?.onConflict) {
            const keys = this.upsertOptions.onConflict.split(",").map((key) => key.trim());
            const existing = base.find((candidate) => keys.every((key) => candidate[key] === row[key]));
            if (existing) {
              if (this.upsertOptions.ignoreDuplicates) continue; // no row returned, like PostgREST
              Object.assign(existing, incoming, { updated_at: new Date().toISOString() });
              out.push(existing);
              continue;
            }
          }
          // Mirror the database's one-active-generation-per-draft guard.
          if (this.table === "mara_media_generations") {
            const clash = base.some((existing) => existing.owner_user_id === row.owner_user_id
              && existing.draft_id === row.draft_id && ["queued", "generating", "processing"].includes(existing.status));
            if (clash) return { data: null, error: { code: "23505", message: "mara_media_active_per_draft_uq" }, count: null };
          }
          base.push(row);
          out.push(row);
        }
        return { data: out, error: null, count: out.length };
      }
      if (this.patch) {
        const targets = this._rows();
        writes.push({ table: this.table, op: "update", patch: this.patch, count: targets.length });
        for (const row of targets) Object.assign(row, this.patch, { updated_at: new Date().toISOString() });
        return { data: targets, error: null, count: targets.length };
      }
      if (this.deleting) {
        const targets = this._rows();
        writes.push({ table: this.table, op: "delete", count: targets.length });
        for (const row of targets) base.splice(base.indexOf(row), 1);
        return { data: targets, error: null, count: targets.length };
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
      if (this.selectOptions?.head) return { data: null, error: null, count: rows.length };
      return { data: rows, error: null, count: rows.length };
    }
    then(onFulfilled, onRejected) { return Promise.resolve(this._execute()).then(onFulfilled, onRejected); }
    async maybeSingle() { const { data, error } = this._execute(); return { data: data?.[0] ?? null, error }; }
    async single() {
      const { data, error } = this._execute();
      if (error) return { data: null, error };
      if (!data?.[0]) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: data[0], error: null };
    }
  }

  return {
    writes, rpcs, tables, ledger,
    rows: (table) => tables.get(table) ?? [],
    writesTo: (table) => writes.filter((write) => write.table === table),
    from: (table) => new Query(table),
    async rpc(name, args) {
      rpcs.push({ name, args });
      return (await ledger.rpc(name, args)) ?? { data: null, error: null };
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: null }),
        remove: async () => ({ data: null, error: null }),
        createSignedUrl: async (path) => ({ data: { signedUrl: `https://signed.invalid/${path}` } }),
        download: async () => ({ data: null, error: { message: "not found" } }),
      }),
    },
  };
}

/**
 * The SynraPay account: a Manual (by default) business, no marketing plan yet.
 * `plan` is the billing plan column (free / pro / max); it defaults to the
 * production default for an account that never chose one — Free — so the
 * tests that need explicit generation opt into Pro deliberately.
 */
function seedAccount(options = {}) {
  return createFakeAdmin(new Map(Object.entries({
    businesses: [{
      id: "biz-synrapay", owner_user_id: OWNER, brand_name: "SynraPay", brand_description: "Payments for growing teams.",
      industry: "Fintech", target_customer: ["SMB founders"], main_goal: "Grow awareness", brand_personality: ["Confident"],
      preferred_channels: ["Instagram"], content_frequency: options.cadence ?? "3x per week",
      automation_level: options.mode ?? "manual", timezone: TZ, onboarding_completed: true,
      ...(options.plan ? { plan: options.plan } : {}),
    }],
    profiles: [{ user_id: OWNER, display_name: "SynraPay" }],
    marketing_plans: [], mara_drafts: [], mara_conversations: [], mara_media_generations: [],
    post_draft_assets: [], mara_pending_actions: [], mara_tool_runs: [], content_calendar_items: [],
    instagram_publish_queue: [],
  })));
}

/** Everything a Manual Replenish must NOT have done. */
function assertNoPaidOrAutomaticSideEffects(db, run) {
  assert.equal(imageRequests().length, 0, "zero image provider (Seedream) requests");
  assert.equal(videoRequests().length, 0, "zero video provider (Seedance / Magic Hour) requests");
  assert.equal(nonCopyNetwork().length, 0, "nothing but MARA copy ever touched the network");
  assert.equal(db.rows("mara_media_generations").length, 0, "no paid media-generation rows");
  assert.equal(db.writesTo("mara_media_generations").length, 0, "no media-generation write at all");
  assert.equal(db.rows("post_draft_assets").length, 0, "no stored media bytes");
  assert.equal(run.mediaQueued, 0);
  assert.equal(run.autoApproved, 0, "no auto-approval");
  assert.equal(run.awaitingApproval, 0, "no approval card opened");
  assert.equal(run.heldForReview, 0);
  assert.equal(db.rows("mara_pending_actions").length, 0, "no approval rows");
  assert.equal(db.rows("mara_tool_runs").length, 0, "no autopilot audit rows");
  assert.equal(db.rows("content_calendar_items").length, 0, "no calendar scheduling");
  assert.equal(db.rows("instagram_publish_queue").length, 0, "no Instagram queue entry");
  assert.deepEqual(db.rpcs, [], "no publish-queue RPC (enqueue/cancel) was invoked");
  for (const draft of db.rows("mara_drafts")) assert.equal(draft.status, "draft", "every item stays an unapproved draft");
  assert.equal(run.failures.filter((failure) => failure.stage !== "content").length, 0, "no media/approval stage was even attempted");
}

// ===========================================================================
// 1. The central policy
// ===========================================================================

test("1. mayAutomaticallyGeneratePaidMedia: Manual is never allowed; Assisted never (v1); only Autopilot", () => {
  const { mayAutomaticallyGeneratePaidMedia: may, WORKFLOW_TRIGGERS, AUTOMATION_MODES } = automation;
  assert.deepEqual([...WORKFLOW_TRIGGERS], ["scheduled", "replenish"]);
  assert.equal(may("manual", "replenish"), false, "Manual + Replenish must return false");
  assert.equal(may("manual", "scheduled"), false);
  // Plans + Credits v1: Assisted prepares and waits — paid media needs an
  // explicit user generation action, so the automatic policy denies it too.
  assert.equal(may("assisted", "replenish"), false, "Assisted never generates paid media automatically (v1)");
  assert.equal(may("assisted", "scheduled"), false);
  assert.equal(may("autopilot", "replenish"), true, "Autopilot behaviour preserved");
  assert.equal(may("autopilot", "scheduled"), true);
  // Exhaustive: every non-Autopilot pair is denied, nothing else is.
  const denied = AUTOMATION_MODES.flatMap((mode) => WORKFLOW_TRIGGERS.filter((trigger) => !may(mode, trigger)).map((trigger) => `${mode}/${trigger}`));
  assert.deepEqual(denied, ["manual/scheduled", "manual/replenish", "assisted/scheduled", "assisted/replenish"]);

  // The engine derives its stage from the same policy — a requested "full"
  // (or any forged value) cannot widen a Manual or an Assisted run.
  for (const mode of ["manual", "assisted"]) {
    for (const stage of [undefined, "full", "bogus", "planning_only"]) {
      assert.equal(rolling.resolveWorkflowStage({ mode, trigger: "replenish", stage }), "planning_only", `${mode}/${stage}`);
      assert.equal(rolling.resolveWorkflowStage({ mode, trigger: "scheduled", stage }), "planning_only", `${mode}/${stage}`);
    }
  }
  assert.equal(rolling.resolveWorkflowStage({ mode: "autopilot", trigger: "scheduled" }), "full");
  assert.equal(rolling.resolveWorkflowStage({ mode: "autopilot", trigger: "replenish" }), "full");
  assert.equal(rolling.resolveWorkflowStage({ mode: "autopilot", trigger: "replenish", stage: "planning_only" }), "planning_only");
});

// ===========================================================================
// 2. The production incident, through the REAL service and ports
// ===========================================================================

test("2a. Manual + Replenish creates the plan and its drafts — and submits nothing paid", async () => {
  resetNetwork();
  const db = seedAccount({ mode: "manual", cadence: "3x per week" });

  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  // Manual remains Manual throughout the run — never coerced into Assisted.
  assert.equal(run.mode, "manual");
  assert.equal(run.trigger, "replenish");
  assert.equal(run.stage, "planning_only");

  // The plan and its slots exist: this is what Replenish is for.
  assert.ok(run.planId, "an active marketing plan exists");
  assert.equal(db.rows("marketing_plans").length, 1);
  assert.equal(run.slots, 3);
  assert.equal(run.created, 3);
  assert.equal(run.reused, 0);
  assert.equal(db.rows("mara_drafts").length, 3, "one executable draft per slot");
  assert.deepEqual(
    db.rows("mara_drafts").map((draft) => draft.source_plan_item_key).sort(),
    run.plan.items.map((item) => item.slotKey).sort(),
  );
  assert.ok(run.plan.items.every((item) => Date.parse(item.publishAt) > NOW.getTime()), "no slot in the past");
  assert.equal(db.rows("marketing_plans")[0].planned_posts.length, 3, "the horizon is mirrored onto the plan");

  // Copy/strategy came from the internal planning logic only.
  assert.equal(copyRequests().length, 3, "MARA copy for each new slot");
  assert.equal(network.calls.length, 3, "and NOTHING else left the process");

  assertNoPaidOrAutomaticSideEffects(db, run);
});

test("2b. a second Manual Replenish reuses every item and still submits nothing", async () => {
  resetNetwork();
  const db = seedAccount({ mode: "manual", cadence: "Daily" });
  const first = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  assert.equal(first.created, 7);
  const copyAfterFirst = copyRequests().length;

  const second = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  assert.equal(second.mode, "manual");
  assert.equal(second.stage, "planning_only");
  assert.equal(second.created, 0);
  assert.equal(second.reused, 7, "existing slot items are reused, never duplicated");
  assert.equal(db.rows("mara_drafts").length, 7);
  assert.equal(db.rows("marketing_plans").length, 1);
  assert.equal(copyRequests().length, copyAfterFirst, "no duplicate MARA copy");
  assertNoPaidOrAutomaticSideEffects(db, second);
});

test("2c. a Manual account on the SCHEDULED trigger still creates nothing at all", async () => {
  resetNetwork();
  const db = seedAccount({ mode: "manual" });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, mediaDeps: fakeMediaDeps }); // cron: no trigger
  assert.equal(run.mode, "manual");
  assert.equal(run.trigger, "scheduled");
  assert.equal(run.planId, null);
  assert.equal(run.created, 0);
  assert.equal(db.rows("mara_drafts").length, 0);
  assert.equal(db.rows("marketing_plans").length, 0);
  assert.equal(network.calls.length, 0, "not even a copy request");
  assertNoPaidOrAutomaticSideEffects(db, run);
});

test("2d. the resulting Manual cards expose Create with MARA / Upload asset / Film it myself", async () => {
  resetNetwork();
  const db = seedAccount({ mode: "manual", cadence: "3x per week" });
  await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.equal(snapshot.mode, "manual");
  assert.equal(snapshot.items.length, 3);
  const types = new Set();
  for (const item of snapshot.items) {
    assert.equal(item.status, "planned", `${item.contentType} waits for the owner's production choice`);
    assert.equal(item.hasMedia, false);
    types.add(item.contentType);
    const card = nextActions.planItemActions({
      contentType: item.contentType, stage: item.status, failedStage: item.failedStage, mode: "manual",
      publishAt: item.publishAt, dayLabel: item.dayLabel, localTime: item.localTime,
      hasMedia: item.hasMedia, mediaFromMara: item.mediaFromMara, mediaStatus: item.mediaStatus, production: null,
    });
    const ids = card.actions.map((action) => action.id);
    assert.ok(ids.includes("produce_with_mara"), "Create with MARA is offered");
    assert.ok(ids.includes("upload_asset"), "Upload asset is offered");
    if (item.contentType === "reel") assert.ok(ids.includes("film_yourself"), "Film it myself is offered for a Reel");
    else assert.ok(!ids.includes("film_yourself"));
    assert.ok(!ids.includes("approve_schedule"), "nothing is presented as approvable yet");
  }
  assert.ok(types.has("reel"), "the 3x/week mix includes a Reel, so the film-it path is exercised");
});

// ===========================================================================
// 3. The hard server-side guard — independent of the engine and of any UI
// ===========================================================================

test("3a. the Manual+Replenish ports refuse media and auto-approval even when called directly", async () => {
  resetNetwork();
  const db = seedAccount({ mode: "manual" });
  const business = db.rows("businesses")[0];
  const ports = await service.buildWorkflowPorts(db, {
    ownerId: OWNER, businessId: business.id, business, timeZone: TZ, cadence: "3x_week",
    goal: "Grow awareness", now: NOW, mode: "manual", trigger: "replenish", mediaDeps: fakeMediaDeps,
  });
  db.rows("mara_drafts").push({
    id: "draft-forged", owner_user_id: OWNER, conversation_id: db.rows("mara_conversations")[0].id, source_plan_id: "plan-x",
    source_plan_item_key: "2026-09-12", kind: "instagram_post", channel: "Instagram", title: "Premium Payment Pulse: SynraPay Live Demo",
    content: "Caption", proposed_publish_at: tz.localToUtcIso("2026-09-12", 18 * 60 + 30, TZ), status: "draft",
    media_brief: "A premium payments visual.", created_at: NOW.toISOString(),
  });
  const item = {
    draftId: "draft-forged", slotKey: "2026-09-12", channel: "instagram", format: "post", contentType: "post", concept: "Premium Payment Pulse: SynraPay Live Demo",
    caption: "Caption", publishAt: tz.localToUtcIso("2026-09-12", 18 * 60 + 30, TZ), status: "draft",
  };

  // A caller that bypasses the engine and invokes the paid port directly is
  // still refused server-side: no read, no insert, no provider request.
  const media = await ports.ensureMedia(item);
  assert.deepEqual(media, { ok: false, code: service.AUTOMATIC_MEDIA_FORBIDDEN });
  assert.equal(imageRequests().length, 0);
  assert.equal(videoRequests().length, 0);
  assert.equal(db.rows("mara_media_generations").length, 0);
  assert.equal(db.writesTo("mara_media_generations").length, 0);

  const decision = await ports.autoApproveAndSchedule(item);
  assert.equal(decision.approved, false);
  assert.equal(db.rows("mara_drafts")[0].status, "draft", "never approved");
  assert.equal(db.rows("content_calendar_items").length, 0);
  assert.deepEqual(db.rpcs, []);
});

test("3b. even a forged 'full' stage cannot make the engine reach media for Manual+Replenish", async () => {
  // Counting ports where the paid port would be a loud failure.
  const calls = { ensureMedia: 0, requestApproval: 0, autoApprove: 0, createDraft: 0 };
  const ports = {
    async ensurePlan() { return "plan-1"; },
    async listItems() { return []; },
    async generateContent(slot) { return { concept: `c-${slot.date}`, caption: "cap", cta: "cta", hashtags: [], visualBrief: "vb" }; },
    async createDraft({ slot, content }) { calls.createDraft += 1; return { draftId: `d-${slot.slotKey}`, slotKey: slot.slotKey, channel: slot.channel, format: slot.format, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" }; },
    async ensureMedia() { calls.ensureMedia += 1; throw new Error("PAID PATH REACHED"); },
    async requestApproval() { calls.requestApproval += 1; },
    async autoApproveAndSchedule() { calls.autoApprove += 1; return { approved: true }; },
    async savePlanItems() {},
  };
  for (const stage of ["full", "bogus", undefined]) {
    const run = await rolling.ensureRollingPlan(ports, { now: NOW, timeZone: TZ, cadence: "daily", mode: "manual", goal: "awareness", trigger: "replenish", stage, selectedChannels: ["instagram"] });
    assert.equal(run.mode, "manual");
    assert.equal(run.stage, "planning_only", `stage ${JSON.stringify(stage)} is narrowed to planning_only`);
    assert.equal(run.created, 7);
    assert.deepEqual(run.failures, []);
  }
  assert.equal(calls.createDraft, 21);
  assert.equal(calls.ensureMedia, 0, "ensureMedia is never invoked for Manual");
  assert.equal(calls.requestApproval, 0);
  assert.equal(calls.autoApprove, 0);
});

test("3c. runOwnerWorkflow reads the SAVED mode — no caller can run a Manual account as Assisted", async () => {
  const source = await read("lib/voom/workflow/service.ts");
  assert.doesNotMatch(source, /mode\?:\s*"manual"\s*\|\s*"assisted"\s*\|\s*"autopilot"/, "WorkflowRunInput has no mode override");
  assert.match(source, /let mode = normalizeAutomationMode\(business\.automation_level\)/, "the mode comes from the saved row");
  // The only thing that can change the saved mode is the plan entitlement,
  // and it can only NARROW it (Free -> Manual, Pro -> at most Assisted).
  assert.match(source, /if \(!canUseAutomationMode\(planId, mode\)\) \{\s*mode = planId === "pro" \? "assisted" : "manual";/);
  assert.doesNotMatch(source, /mode = "autopilot"/, "nothing ever widens a run to Autopilot");
  assert.match(source, /if \(!mayAutomaticallyGeneratePaidMedia\(context\.mode, context\.trigger\)\)/, "the ensureMedia port carries the guard");

  // Executed, not only read: a Free account whose row still says "assisted"
  // is run as Manual — the plan gate narrows, so a Replenish stays planning-only
  // and nothing paid is even reachable.
  resetNetwork();
  const free = seedAccount({ mode: "assisted", cadence: "3x per week" });
  const run = await service.runOwnerWorkflow(free, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  assert.equal(run.mode, "manual", "Free cannot run Assisted: the saved mode is narrowed, never widened");
  assert.equal(run.stage, "planning_only");
  assert.equal(run.created, 3);
  assertNoPaidOrAutomaticSideEffects(free, run);
  const route = await read("app/api/plan/route.ts");
  assert.doesNotMatch(route, /"assisted" as const|"autopilot" as const|\bmode\s*[:=]/, "the route no longer computes or passes a mode");
  assert.doesNotMatch(route, /automation_level/, "the route does not read the mode at all");
  assert.match(route, /trigger: "replenish"/);
});

// ===========================================================================
// 4. Assisted is planning-only too (v1); Autopilot is unchanged
// ===========================================================================

function countingPorts() {
  const calls = { ensureMedia: 0, requestApproval: 0, autoApprove: 0, createDraft: 0, image: 0, video: 0 };
  const ports = {
    async ensurePlan() { return "plan-1"; },
    async listItems() { return []; },
    async generateContent(slot) { return { concept: `c-${slot.date}`, caption: "A calm look at our work today. Visit us this week.", cta: "Visit", hashtags: [], visualBrief: "vb" }; },
    async createDraft({ slot, content }) { calls.createDraft += 1; return { draftId: `d-${slot.slotKey}`, slotKey: slot.slotKey, channel: slot.channel, format: slot.format, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" }; },
    async ensureMedia(item) { calls.ensureMedia += 1; if (item.contentType === "reel") calls.video += 1; else calls.image += 1; return { ok: true }; },
    async requestApproval() { calls.requestApproval += 1; },
    async autoApproveAndSchedule() { calls.autoApprove += 1; return { approved: true }; },
    async savePlanItems() {},
  };
  return { ports, calls };
}

test("4a. Assisted: Replenish and scheduled runs plan and draft every slot, and never reach the paid stage (v1)", async () => {
  for (const trigger of ["replenish", "scheduled", undefined]) {
    const { ports, calls } = countingPorts();
    const run = await rolling.ensureRollingPlan(ports, { now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "awareness", trigger, selectedChannels: ["instagram"] });
    assert.equal(run.mode, "assisted");
    assert.equal(run.stage, "planning_only", `Assisted/${trigger} is planning-only: paid media needs an explicit click`);
    assert.equal(run.created, 7, "Assisted still prepares the whole horizon");
    assert.equal(calls.createDraft, 7);
    assert.equal(calls.ensureMedia, 0, `Assisted/${trigger} never runs the paid media stage`);
    assert.equal(calls.image + calls.video, 0);
    assert.equal(run.mediaQueued, 0);
    assert.equal(calls.autoApprove, 0, "Assisted never auto-approves");
    // Approval is asked for once the owner has produced the item's media
    // (the planned card offers Create with MARA / Upload), not at planning.
    assert.equal(calls.requestApproval, 0);
    assert.equal(run.awaitingApproval, 0);
    assert.equal(run.autoApproved, 0);
    assert.deepEqual(run.failures, []);
  }
});

test("4b. Autopilot: Replenish and scheduled runs still generate media and auto-approve safe items", async () => {
  for (const trigger of ["replenish", "scheduled", undefined]) {
    const { ports, calls } = countingPorts();
    const run = await rolling.ensureRollingPlan(ports, { now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness", trigger, selectedChannels: ["instagram"] });
    assert.equal(run.mode, "autopilot");
    assert.equal(run.stage, "full");
    assert.equal(calls.ensureMedia, 7);
    assert.equal(run.mediaQueued, 7);
    assert.equal(calls.autoApprove, 7);
    assert.equal(run.autoApproved, 7);
    assert.equal(run.awaitingApproval, 0);
  }
});

test("4c. through the REAL service, an Assisted (Pro) Replenish drafts the horizon and submits nothing paid (v1)", async () => {
  resetNetwork();
  // Pro is the plan that includes Assisted, so the saved mode is honoured.
  const db = seedAccount({ mode: "assisted", cadence: "3x per week", plan: "pro" });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  assert.equal(run.mode, "assisted", "a Pro account keeps its saved Assisted mode");
  assert.equal(run.stage, "planning_only", "Assisted is planning-only: paid media needs an explicit click");
  assert.equal(run.created, 3);
  assert.equal(run.plan.items.length, 3);
  assert.ok(run.plan.items.some((item) => item.contentType !== "reel") && run.plan.items.some((item) => item.contentType === "reel"));
  // Drafts and copy exist; the paid seams were never reached at either
  // boundary, no generation row exists, and no credit was reserved.
  assert.equal(db.rows("mara_drafts").length, 3);
  assert.equal(imageRequests().length, 0, "Assisted submits no Seedream request on its own");
  assert.equal(videoRequests().length, 0, "Assisted submits no Seedance request on its own");
  assert.deepEqual(run.failures, [], "nothing paid ran, so nothing paid could fail");
  assert.deepEqual(db.ledger.rows(), [], "no credit reservation was even attempted");
  assertNoPaidOrAutomaticSideEffects(db, run);
  // Approval comes after the owner produces media on the planned card, so
  // nothing sits in Approvals yet and nothing was auto-approved.
  assert.equal(run.awaitingApproval, 0);
  assert.equal(run.autoApproved, 0);
  assert.equal(db.rows("mara_pending_actions").length, 0);
  for (const draft of db.rows("mara_drafts")) assert.equal(draft.status, "draft");
});

// ===========================================================================
// 5. Manual: the explicit click still works (on a plan with credits), and
//    stays idempotent — and a Free account is refused before any provider
// ===========================================================================

/**
 * A Manual account with a planned Post. `plan` defaults to Pro: Manual is
 * allowed on every plan, but only Pro/Max include AI media credits, so an
 * explicit Create with MARA click can actually reach the (fake) provider.
 */
async function manualPlannedItem(options = {}) {
  resetNetwork();
  const db = seedAccount({ mode: "manual", cadence: "3x per week", plan: options.plan ?? "pro" });
  await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  const draft = db.rows("mara_drafts").find((row) => row.kind === "instagram_post");
  assert.ok(draft);
  assert.deepEqual(db.ledger.rows(), [], "planning reserved nothing");
  resetNetwork();
  return {
    db,
    draft,
    request: {
      ownerId: OWNER, draftId: draft.id, conversationId: draft.conversation_id, contentType: "post",
      concept: draft.title, visualBrief: draft.media_brief,
    },
  };
}

test("5a. an explicit Create with MARA click in Manual (Pro) starts exactly ONE paid generation and reserves it once", async () => {
  const { db, draft, request } = await manualPlannedItem();
  // This is what the Marketing Plan card's server action calls (explicit: true).
  const outcome = await mediaMod.produceWorkflowMedia(db, request, { explicit: true, now: NOW, deps: fakeMediaDeps });
  assert.deepEqual(outcome, { ok: true, state: "completed" });
  assert.equal(imageRequests().length, 1, "exactly one Seedream request");
  assert.equal(videoRequests().length, 0);
  const generations = db.rows("mara_media_generations");
  assert.equal(generations.length, 1);
  assert.equal(generations[0].draft_id, draft.id);
  assert.equal(generations[0].media_type, "image");
  assert.equal(generations[0].status, "completed");
  assert.equal(generations[0].provider, "openrouter");
  assert.equal(db.rows("post_draft_assets").length, 1, "the visual is attached to the SAME item");
  // Credits: reserved BEFORE the provider call, settled after the bytes are
  // stored — one image, 5 credits, one ledger row, keyed by the generation.
  assert.deepEqual(db.ledger.calls.map((call) => call.name), ["reserve_media_credits", "settle_media_credits"]);
  // The only other RPC is the calendar sync withdrawing a publish-queue row
  // for a still-draft post — there is none, so nothing is enqueued or cancelled.
  assert.deepEqual(
    db.rpcs.map((call) => call.name).filter((name) => !name.endsWith("_media_credits")),
    ["cancel_instagram_publish_queue_item"],
  );
  const ledgerRows = db.ledger.rows();
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0].credits, 5);
  assert.equal(ledgerRows[0].media_type, "image");
  assert.equal(ledgerRows[0].source, "user_request");
  assert.equal(ledgerRows[0].status, "settled");
  assert.equal(ledgerRows[0].generation_id, generations[0].id, "the ledger row and the generation row share one identity");
  assert.deepEqual(db.ledger.usage(OWNER), { used: 5, allowance: 150, remaining: 145 });
  // Still Manual: nothing was approved, scheduled or queued by the click.
  assert.equal(db.rows("mara_drafts").find((row) => row.id === draft.id).status, "draft");
  assert.equal(db.rows("content_calendar_items").length, 0);
  assert.equal(db.rows("instagram_publish_queue").length, 0);
  assert.equal(mediaMod.mediaOutcomeMessage("completed"), "MARA generated the visual for this item. Nothing was published.");
});

test("5a-free. the same explicit click on a Free account is refused before any provider or ledger work", async () => {
  const { db, request } = await manualPlannedItem({ plan: "free" });
  const outcome = await mediaMod.produceWorkflowMedia(db, request, { explicit: true, now: NOW, deps: fakeMediaDeps });
  assert.deepEqual(outcome, { ok: false, code: "plan_not_allowed" }, "Free has no AI media: the guard refuses, truthfully");
  assert.equal(imageRequests().length, 0, "no Seedream request");
  assert.equal(videoRequests().length, 0);
  assert.equal(network.calls.length, 0, "no network activity of any kind");
  assert.equal(db.rows("mara_media_generations").length, 0, "no generation row is created for a refused click");
  assert.equal(db.rows("post_draft_assets").length, 0);
  assert.deepEqual(db.ledger.rows(), [], "nothing was reserved");
  assert.deepEqual(db.rpcs, [], "the plan check happens before the ledger is even consulted");
});

test("5b. repeated explicit generation is idempotent: a second click while one is in flight pays nothing", async () => {
  const { db, request } = await manualPlannedItem();
  // Hold the first provider response open, like a slow Seedream call.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.imageResponder = async () => {
    await gate;
    return { provider: "openrouter", bytes: jpeg(1024, 1024) };
  };
  const first = mediaMod.produceWorkflowMedia(db, request, { explicit: true, now: NOW, deps: fakeMediaDeps });
  try {
    // Let the first click reach the provider (its generation row is now live).
    // Bounded: if the click is refused before the seam (e.g. by the plan or
    // credit guard), the wait fails with the refusal instead of spinning.
    await waitFor(async () => {
      if (imageRequests().length > 0) return true;
      const settled = await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 0, null))]);
      if (settled) throw new Error(`the first click finished without reaching the provider: ${JSON.stringify(settled)}`);
      return false;
    }, { timeoutMs: 2_000, message: "the first click to reach the image provider" });
    assert.equal(db.rows("mara_media_generations").length, 1);
    assert.equal(db.ledger.live(OWNER).length, 1, "the in-flight click holds exactly one reservation");

    const second = await mediaMod.produceWorkflowMedia(db, request, { explicit: true, now: new Date(NOW.getTime() + 1_000), deps: fakeMediaDeps });
    assert.deepEqual(second, { ok: true, state: "exists" }, "the repeat click is a no-op");
    assert.equal(imageRequests().length, 1, "still exactly one provider request");
    assert.equal(db.rows("mara_media_generations").length, 1, "still exactly one generation row");
    assert.equal(db.ledger.rows().length, 1, "the repeat click reserved nothing");
  } finally {
    release();
  }
  assert.deepEqual(await first, { ok: true, state: "completed" });
  assert.equal(imageRequests().length, 1);
  assert.equal(db.rows("mara_media_generations").length, 1);
  assert.equal(db.rows("post_draft_assets").length, 1);
  assert.deepEqual(db.ledger.rows().map((row) => [row.credits, row.status]), [[5, "settled"]], "one image, charged once");
  assert.equal(mediaMod.mediaOutcomeMessage("exists"), "A generation is already in flight for this item — nothing new was started, so nothing was charged.");
});

test("5c. after the explicit generation, a Manual Replenish reuses the item and still submits nothing", async () => {
  const { db, request } = await manualPlannedItem();
  await mediaMod.produceWorkflowMedia(db, request, { explicit: true, now: NOW, deps: fakeMediaDeps });
  assert.equal(imageRequests().length, 1);
  resetNetwork();

  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  assert.equal(run.mode, "manual");
  assert.equal(run.stage, "planning_only");
  assert.equal(run.reused, 3);
  assert.equal(run.created, 0);
  assert.equal(network.calls.length, 0, "no network activity of any kind");
  assert.equal(db.rows("mara_media_generations").length, 1, "the one explicit generation is the only one that ever existed");
  assert.equal(db.ledger.rows().length, 1, "the one explicit reservation is the only one that ever existed");
  assert.equal(run.mediaQueued, 0);
  assert.equal(run.awaitingApproval, 0);
  assert.equal(run.autoApproved, 0);
});

// ===========================================================================
// 6. Truthful copy
// ===========================================================================

test("6. Replenish copy is truthful per mode and the Manual card never implies finished media", async () => {
  assert.equal(
    automation.replenishPlanDescription("manual"),
    "Replenish plan creates your upcoming content plan. Media is generated only when you ask MARA to create it.",
  );
  // v1: Assisted prepares and waits, so its sentence must NOT promise
  // automatic media; only Autopilot may, and only within the credit limits.
  assert.match(automation.replenishPlanDescription("assisted"), /waits for your approval/i);
  assert.match(automation.replenishPlanDescription("assisted"), /only when you ask MARA to create it/i);
  assert.doesNotMatch(automation.replenishPlanDescription("assisted"), /generates? media automatically/i);
  assert.match(automation.replenishPlanDescription("autopilot"), /may generate media automatically within your credit limits/i, "Autopilot states the automatic generation plainly, and its limit");
  assert.doesNotMatch(automation.replenishPlanDescription("manual"), /automatically|finished|generates media/i);

  const manual = automation.AUTOMATION_MODE_COPY.manual;
  assert.match(manual.media, /^No automatic media generation\./);
  assert.match(manual.media, /only from an explicit Create with MARA click/i);
  assert.match(manual.media, /only if your plan includes AI media credits/i);
  assert.doesNotMatch(manual.media, /building your plan, Create with MARA/i, "building the plan is no longer listed as a paid-media trigger");

  const workspace = await read("components/voom/operating/PlanWorkspace.tsx");
  assert.match(workspace, /replenishPlanDescription\(snapshot\.mode\)/, "the Marketing Plan renders the per-mode sentence");
  assert.match(workspace, /Replenish plan/);
  const [today, dashboard] = await Promise.all([
    read("app/app/(shell)/today/page.tsx"),
    read("components/voom/today/TodayDashboard.tsx"),
  ]);
  assert.match(today, /normalizeAutomationMode\(data\.business\.automation_level\)/, "Today passes the authoritative saved mode");
  assert.match(dashboard, /<AutomationMode compact showPlanSummary=\{false\} initial=\{automationMode\}/, "Today keeps mode changing compact");
  assert.doesNotMatch(today + dashboard, /finished media|media automatically/i, "Today never implies a plan already produced media");
});
