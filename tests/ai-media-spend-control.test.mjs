/**
 * AI Media Spend Control — the cost-control layer around automatic MARA media.
 *
 * Real modules under test (behaviour, not string matching):
 *   lib/mara/media-spend.ts            — the ONE policy + the ONE estimated-cost model
 *   lib/mara/spend-control.ts          — the server-side, database-backed gate
 *   lib/voom/workflow/media.ts         — the paid submission choke point
 *   lib/voom/workflow/service.ts       — runOwnerWorkflow / buildWorkflowPorts (the REAL ports)
 *   lib/mara/video-generation.ts       — the durable video job row
 *   supabase/migrations/0031_ai_media_spend_control.sql
 *
 * Everything external is faked in memory: Supabase (a table-backed admin
 * client with a controllable clock), MARA's copy provider (global fetch is
 * intercepted and recorded) and the two paid provider seams of
 * lib/voom/workflow/media.ts (`generateImage` = Seedream, `startVideo` =
 * Seedance). No OpenRouter call, no cron, no publishing, no migration run.
 *
 * Proven here:
 *   1. the estimated-cost model is centralized (one file owns the numbers),
 *   2. Manual never auto-generates paid media, whatever the toggle says,
 *   3. Assisted/Autopilot respect `allow_automatic_paid_media`,
 *   4. an exhausted monthly budget blocks NEW automatic media,
 *   5. a block never fails planning: plan, copy and drafts are created and the
 *      item simply waits for media, with the truthful reason surfaced,
 *   6. "Create with MARA" (an explicit request) still works while automatic
 *      generation is disabled and is recorded as `user_request`,
 *   7. the recorded source is correct for image and video generations,
 *   8. no duplicate provider submission, however often a run or a click repeats.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// MARA copy is the free internal planning step; the fake fetch below answers it.
process.env.AI_PROVIDER = "local";
process.env.AI_BASE_URL = "http://ai.test.invalid/v1";
process.env.AI_MODEL = "fake-copy-model";

const spend = await import("../lib/mara/media-spend.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const service = await import("../lib/voom/workflow/service.ts");
const mediaMod = await import("../lib/voom/workflow/media.ts");
const videoGen = await import("../lib/mara/video-generation.ts");
const videoJob = await import("../lib/mara/video-job.ts");
const videoPorts = await import("../lib/mara/video-ports.ts");
const videoService = await import("../lib/mara/video-service.ts");

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const OWNER = "owner-spend-control";
const TZ = "Asia/Dubai";
/** 2026-09-12 09:00 Dubai (05:00 UTC): a deterministic "today". */
const NOW = new Date("2026-09-12T05:00:00.000Z");

// ---------------------------------------------------------------------------
// Network boundary: every fetch is recorded; nothing leaves the process.
// ---------------------------------------------------------------------------

const network = { calls: [] };
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
  if (href.endsWith("/chat/completions")) {
    const user = body?.messages?.find((m) => m.role === "user")?.content ?? "{}";
    const system = body?.messages?.find((m) => m.role === "system")?.content ?? "";
    let payload = {};
    try { payload = JSON.parse(user); } catch { /* fine */ }
    // MARA's video plan step asks for a video plan; the copy step does not.
    if (/video/i.test(system)) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        concept: "Cost-control reel", visualObjective: "Show the product plainly.",
        visualPrompt: "Clean vertical frame of a calm workspace, warm light, no text.",
        motionDirection: "Slow push-in with a soft light change.",
        overlayCopy: { hook: "Money that moves", message: "Built for growing teams", value: "Simple and clear", cta: "Visit us" },
        cta: "Visit us", durationSeconds: 6,
      }) } }] });
    }
    const slotDate = payload.localDate ?? "unknown";
    const contentType = payload.contentType ?? "post";
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        concept: `Cost-control ${contentType} ${slotDate}`,
        caption: "A calm look at how we keep the work moving. Visit us this week.",
        cta: "Visit us this week",
        hashtags: contentType === "story" ? [] : ["#voom", "#marketing"],
        visualBrief: "Warm natural light, clean composition, no text.",
      }) } }],
    });
  }
  // Nothing else may leave the process: not OpenRouter (image or video), not
  // Magic Hour, not Meta.
  throw new Error(`unexpected network call in test: ${href}`);
};

test.after(() => { globalThis.fetch = realFetch; });

/**
 * The two paid provider seams. Images go through this file's fake image
 * provider; a Reel goes through the REAL durable video job service (real
 * `startVideoGeneration`, real `buildVideoGenerationPorts`, real row writes) so
 * its idempotency and its audited `spend_source` are exercised, not simulated.
 * The one thing faked below the service is the provider itself: `createVideoJob`
 * is THE paid submission, and every call is recorded.
 */
const provider = { image: [], baseFrame: [], video: [] };

const fakeImageProvider = {
  name: "openrouter",
  async generateImage(input) {
    provider.image.push(input);
    const dims = input.aspectRatio === "9:16" ? [1080, 1920] : [1024, 1024];
    return { provider: "openrouter", bytes: jpeg(...dims) };
  },
};

/** A Reel's base frame is its own paid image call inside the video pipeline. */
const fakeVideoImageProvider = {
  name: "openrouter",
  async generateImage(input) { provider.baseFrame.push(input); return { provider: "openrouter", bytes: jpeg(1080, 1920) }; },
};

const fakeVideoProvider = {
  name: "openrouter",
  async createVideoJob(input) {
    provider.video.push(input);
    return { providerJobId: `provider-job-${provider.video.length}`, providerStatus: "queued" };
  },
  async pollVideoJob() { return { kind: "pending" }; },
};

const fakeMediaDeps = {
  async generateImage(input) { return fakeImageProvider.generateImage(input); },
  async startVideo(args) {
    // The production seam calls startPostStudioVideo; this builds the same
    // service from the same ports module, with the provider faked.
    const ports = videoPorts.buildVideoGenerationPorts({
      admin: args.admin,
      provider: fakeVideoProvider,
      imageProvider: fakeVideoImageProvider,
      brand: {
        name: "SynraPay", description: "Payments for growing teams.", industry: "Fintech",
        targetCustomer: "SMB founders", mainGoal: "Grow awareness", brandPersonality: "Confident",
      },
      plan: null,
    });
    const result = await videoGen.startVideoGeneration(ports, {
      ownerId: args.ownerId,
      draftId: args.post.id,
      conversationId: args.post.conversationId,
      scope: "post",
      kind: args.post.kind,
      concept: args.post.concept,
      script: args.script ?? args.post.concept,
      brief: args.brief,
      idempotencyKey: videoJob.videoIdempotencyKey("post", args.post.id, args.idempotencyToken),
      sourceAsset: null,
      providerName: "openrouter",
      supportsImageToVideo: true,
      // The same delegation the shipped service uses: OpenRouter V1 pins the
      // billable request to its six-second default.
      estimatedCostUsd: videoService.estimatedCostUsdForDuration(6),
      monthlySpendLimitUsd: null,
      source: args.source,
    });
    if (!result.ok) return { status: result.status, error: result.message, generation: null };
    return { status: result.created ? 202 : 200, generation: null, message: "accepted" };
  },
  async advance() { return "unavailable"; },
  async enforceTimeout() { return { enforced: false }; },
};
/**
 * The paid submissions the test counts: one image per image slot, and for a
 * Reel one video job (its base frame is recorded separately in `provider.baseFrame`).
 */
const videoSubmissions = () => provider.video.length;
const paidSubmissions = () => provider.image.length + videoSubmissions();

function resetRecords() {
  network.calls.length = 0;
  provider.image.length = 0; provider.baseFrame.length = 0; provider.video.length = 0;
}
const copyRequests = () => network.calls.filter((call) => call.url.endsWith("/chat/completions"));

// ---------------------------------------------------------------------------
// In-memory Supabase admin: table-backed, recorded writes, controllable clock.
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

const ACTIVE_GEN_STATUSES = ["queued", "generating", "processing"];

function createFakeAdmin(tables, options = {}) {
  const writes = [];
  const rpcs = [];
  let spendReads = 0;
  const clock = { now: options.now ?? NOW };

  class Query {
    constructor(table) {
      this.table = table; this.filters = []; this.orderColumn = null; this.orderDirection = 1;
      this.limitCount = null; this.patch = null; this.insertRows = null; this.upsertOptions = null;
      this.deleting = false; this.selectOptions = null;
    }
    select(columns, selectOptions) { this.columns = columns ?? null; this.selectOptions = selectOptions ?? null; return this; }
    insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, upsertOptions = {}) { this.insertRows = Array.isArray(rows) ? rows : [rows]; this.upsertOptions = upsertOptions; return this; }
    update(patch) { this.patch = patch; return this; }
    delete() { this.deleting = true; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { const set = new Set(values.map(String)); this.filters.push((row) => set.has(String(row[column]))); return this; }
    gte(column, value) { this.filters.push((row) => String(row[column] ?? "") >= String(value)); return this; }
    contains(column, needle) { this.filters.push((row) => containsMatch(row[column], needle)); return this; }
    order(column, orderOptions = {}) { this.orderColumn = column; this.orderDirection = orderOptions.ascending === false ? -1 : 1; return this; }
    limit(count) { this.limitCount = count; return this; }
    _base() { if (!tables.has(this.table)) tables.set(this.table, []); return tables.get(this.table); }
    _rows() { return this._base().filter((row) => this.filters.every((match) => match(row))); }
    _execute() {
      const base = this._base();
      // The month's spend accounting is one query shape: count it, and let a
      // test make it unreadable.
      const readingSpend = this.table === "mara_media_generations" && typeof this.columns === "string"
        && this.columns.includes("estimated_cost_usd") && !this.insertRows && !this.patch;
      if (readingSpend) {
        spendReads += 1;
        if (options.failSpendRead) return { data: null, error: { message: "accounting unavailable" }, count: null };
      }
      if (this.insertRows) {
        const out = [];
        for (const incoming of this.insertRows) {
          const stamp = clock.now.toISOString();
          const row = { id: nextId(this.table), created_at: stamp, updated_at: stamp, ...incoming };
          writes.push({ table: this.table, op: this.upsertOptions ? "upsert" : "insert", row });
          if (this.upsertOptions?.onConflict) {
            const keys = this.upsertOptions.onConflict.split(",").map((key) => key.trim());
            const existing = base.find((candidate) => keys.every((key) => candidate[key] === row[key]));
            if (existing) {
              if (this.upsertOptions.ignoreDuplicates) continue;
              Object.assign(existing, incoming, { updated_at: stamp });
              out.push(existing);
              continue;
            }
          }
          // Mirror the database's two guards on mara_media_generations: one
          // ACTIVE generation per (owner, draft) and one row per
          // (owner, idempotency_key).
          if (this.table === "mara_media_generations") {
            const clash = base.some((existing) => existing.owner_user_id === row.owner_user_id
              && existing.draft_id === row.draft_id && ACTIVE_GEN_STATUSES.includes(existing.status));
            if (clash) return { data: null, error: { code: "23505", message: "mara_media_active_per_draft_uq" }, count: null };
            const sameKey = row.idempotency_key && base.some((existing) => existing.owner_user_id === row.owner_user_id
              && existing.idempotency_key === row.idempotency_key);
            if (sameKey) return { data: null, error: { code: "23505", message: "mara_media_generations_idempotency_key_key" }, count: null };
          }
          base.push(row);
          out.push(row);
        }
        return { data: out, error: null, count: out.length };
      }
      if (this.patch) {
        const targets = this._rows();
        writes.push({ table: this.table, op: "update", patch: this.patch, count: targets.length });
        for (const row of targets) Object.assign(row, this.patch, { updated_at: clock.now.toISOString() });
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
    writes, rpcs, tables,
    get spendReads() { return spendReads; },
    rows: (table) => tables.get(table) ?? [],
    writesTo: (table) => writes.filter((write) => write.table === table),
    from: (table) => new Query(table),
    async rpc(name, args) { rpcs.push({ name, args }); return { data: null, error: null }; },
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

/** One account with the AI Media Spending settings under test. */
function seedAccount(options = {}) {
  const { mode = "assisted", cadence = "3x per week", allowAutomatic = true, budget = 25, spentRows = [], failSpendRead = false } = options;
  return createFakeAdmin(new Map(Object.entries({
    businesses: [{
      id: "biz-spend", owner_user_id: OWNER, brand_name: "SynraPay", brand_description: "Payments for growing teams.",
      industry: "Fintech", target_customer: ["SMB founders"], main_goal: "Grow awareness", brand_personality: ["Confident"],
      preferred_channels: ["Instagram"], content_frequency: cadence, automation_level: mode, timezone: TZ,
      onboarding_completed: true,
      allow_automatic_paid_media: allowAutomatic,
      monthly_media_budget_usd: budget,
    }],
    profiles: [{ user_id: OWNER, display_name: "SynraPay" }],
    marketing_plans: [], mara_drafts: [], mara_conversations: [], mara_media_generations: [], post_draft_assets: [],
    mara_pending_actions: [], mara_tool_runs: [], content_calendar_items: [], instagram_publish_queue: [],
    ...(spentRows.length ? { mara_media_generations: spentRows } : {}),
  })), { now: options.now ?? NOW, failSpendRead });
}

/** A prior generation of this month, so budget accounting has real rows. */
function spentGeneration(usd, overrides = {}) {
  return {
    id: nextId("spent"), owner_user_id: OWNER, conversation_id: "conv-past", draft_id: `draft-past-${idSeq}`,
    media_type: "image", prompt: "prior", aspect_ratio: "1:1", status: "completed",
    estimated_cost_usd: usd, spend_source: "assisted", idempotency_key: `prior-${idSeq}`,
    created_at: "2026-09-02T10:00:00.000Z", updated_at: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

/** A workflow draft that already exists for the plan (the direct-call tests). */
function seedDraft(db, id, contentType = "post") {
  db.rows("mara_drafts").push({
    id, owner_user_id: OWNER, conversation_id: "conv-direct", source_plan_id: "plan-direct", source_plan_item_key: "2026-09-12",
    kind: contentType === "reel" ? "reel" : "instagram_post", channel: "Instagram", title: "Cost-control visual",
    content: "Caption", proposed_publish_at: "2026-09-12T14:00:00.000Z", status: "draft", media_brief: "A calm visual.",
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  });
}

const mediaRequestFor = (draftId, contentType = "post") => ({
  ownerId: OWNER, draftId, conversationId: "conv-direct", contentType, concept: "Cost-control visual", visualBrief: "A calm visual.",
});

// ===========================================================================
// 1. The centralized estimated-cost model
// ===========================================================================

test("1. the estimated-cost model lives in one module and no cost constant is duplicated", async () => {
  assert.equal(spend.estimateMediaCostUsd({ mediaType: "image" }), spend.ESTIMATED_MEDIA_COST.imageUsd);
  assert.deepEqual(
    { ...spend.ESTIMATED_MEDIA_COST, imageEnvVar: undefined, videoPerSecondEnvVar: undefined },
    { imageUsd: 0.05, videoUsdPerSecond: 0.1, videoMinimumSeconds: 4, videoDefaultSeconds: 6, imageEnvVar: undefined, videoPerSecondEnvVar: undefined },
    "the shipped model is the documented conservative estimate",
  );
  assert.equal(spend.estimateMediaCostUsd({ mediaType: "video", durationSeconds: 6 }), 0.6);
  assert.equal(spend.estimateMediaCostUsd({ mediaType: "video", durationSeconds: 6, env: {} }), 0.6, "the default needs no env");
  assert.equal(spend.estimateMediaCostUsd({ mediaType: "video", durationSeconds: 2 }), 0.4, "a very short clip still pays the floor");
  assert.equal(spend.estimateMediaCostUsd({ mediaType: "video", env: { MEDIA_VIDEO_ESTIMATED_COST_PER_SECOND_USD: "0.2" } }), 1.2, "the deployment override is honoured");
  assert.equal(spend.estimateMediaCostUsd({ mediaType: "image", env: { MEDIA_IMAGE_ESTIMATED_COST_USD: "0.11" } }), 0.11);
  assert.ok(spend.estimateMediaCostUsd({ mediaType: "image" }) > 0, "an estimate is never zero");
  assert.equal(spend.estimateMediaCostUsd({ mediaType: "video", durationSeconds: 6, env: { MEDIA_VIDEO_ESTIMATED_COST_PER_SECOND_USD: "nonsense" } }), 0.6);

  // The cost constants live in exactly one place: every paid path delegates.
  const videoService = await read("lib/mara/video-service.ts");
  const maraRoute = await read("app/api/mara/route.ts");
  const generateRoute = await read("app/api/posts/[id]/generate/route.ts");
  const paths = [["lib/mara/video-service.ts", videoService], ["app/api/mara/route.ts", maraRoute], ["app/api/posts/[id]/generate/route.ts", generateRoute]];
  for (const [path, source] of paths) {
    assert.ok(source.includes("estimateMediaCostUsd"), `${path} must use the centralized model`);
    // The cost constants may only live in lib/mara/media-spend.ts: no paid path
    // may carry its own price arithmetic. (The env-var NAMES are fine — they are
    // resolved inside the one model.)
    const scrubbed = source.replaceAll("MEDIA_VIDEO_ESTIMATED_COST_PER_SECOND_USD", "ENV").replaceAll("MEDIA_IMAGE_ESTIMATED_COST_USD", "ENV");
    assert.ok(!/[0-9]\.[0-9]+\s*\*|\*\s*[0-9]\.[0-9]+/.test(scrubbed), `${path} must not hardcode cost arithmetic`);
  }
  const env = await read(".env.example");
  assert.match(env, /^MEDIA_IMAGE_ESTIMATED_COST_USD=$/m, "the image override is documented by name only");
  assert.match(env, /^MEDIA_VIDEO_ESTIMATED_COST_PER_SECOND_USD=$/m, "the video override stays documented by name only");
});

// ===========================================================================
// 2. Owner settings + the pure gate
// ===========================================================================

test("2. the settings default to automatic-on with a $25 month, and only an explicit false disables", () => {
  assert.deepEqual(spend.normalizeMediaSpendSettings(null), { allowAutomaticPaidMedia: true, monthlyMediaBudgetUsd: 25 });
  assert.deepEqual(spend.normalizeMediaSpendSettings(undefined), { allowAutomaticPaidMedia: true, monthlyMediaBudgetUsd: 25 });
  assert.deepEqual(spend.normalizeMediaSpendSettings({}), { allowAutomaticPaidMedia: true, monthlyMediaBudgetUsd: 25 });
  assert.deepEqual(
    spend.normalizeMediaSpendSettings({ allow_automatic_paid_media: false, monthly_media_budget_usd: "40.5" }),
    { allowAutomaticPaidMedia: false, monthlyMediaBudgetUsd: 40.5 },
  );
  assert.equal(spend.normalizeMonthlyMediaBudgetUsd(0), 0, "a $0 budget is a deliberate owner choice");
  assert.equal(spend.normalizeMonthlyMediaBudgetUsd(-3), 25, "an unusable budget falls back to the shipped default");
  assert.equal(spend.normalizeMonthlyMediaBudgetUsd("not a number"), 25);
  assert.equal(spend.normalizeAllowAutomaticPaidMedia(undefined), true);
  assert.equal(spend.normalizeAllowAutomaticPaidMedia(true), true);
  assert.equal(spend.normalizeAllowAutomaticPaidMedia(false), false);
});

test("3. the gate: Manual and toggle-off block, budget exhaustion blocks, explicit always allows", () => {
  const gate = (overrides = {}) => spend.evaluateMediaSpendGate({
    mode: "assisted", explicit: false, allowAutomaticPaidMedia: true,
    monthlyMediaBudgetUsd: 25, spentThisMonthUsd: 0, estimatedCostUsd: 0.05, ...overrides,
  });

  // Manual: never, even with the toggle on and the whole budget unused.
  const manual = gate({ mode: "manual" });
  assert.equal(manual.allow, false);
  assert.equal(manual.reason, "automatic_media_disabled");
  assert.match(manual.message, /Automatic media generation disabled/);

  // Assisted/Autopilot honour the toggle.
  for (const mode of ["assisted", "autopilot"]) {
    const off = gate({ mode, allowAutomaticPaidMedia: false });
    assert.equal(off.allow, false, `${mode} + toggle off is blocked`);
    assert.equal(off.reason, "automatic_media_disabled");
    const on = gate({ mode });
    assert.equal(on.allow, true, `${mode} + toggle on + budget available generates`);
    assert.equal(on.source, mode, "the recorded source is the account's mode");
  }

  // Budget: inclusive at the cap, blocked past it.
  assert.equal(gate({ spentThisMonthUsd: 24.95 }).allow, true, "spending exactly to the cap is allowed");
  const exhausted = gate({ spentThisMonthUsd: 24.96 });
  assert.equal(exhausted.allow, false);
  assert.equal(exhausted.reason, "budget_exhausted");
  assert.match(exhausted.message, /Monthly AI media budget reached/);
  assert.equal(gate({ spentThisMonthUsd: 100 }).allow, false);

  // An explicit request is the owner's own decision: allowed even with Manual,
  // the toggle off and a used-up budget — and recorded as user_request.
  const explicit = gate({ mode: "manual", explicit: true, allowAutomaticPaidMedia: false, spentThisMonthUsd: 999, monthlyMediaBudgetUsd: 0 });
  assert.equal(explicit.allow, true);
  assert.equal(explicit.source, "user_request");
  assert.equal(explicit.reason, null);
  assert.equal(spend.mediaSourceForRun("autopilot", false), "autopilot");
  assert.equal(spend.mediaSourceForRun("assisted", false), "assisted");
  assert.equal(spend.mediaSourceForRun("manual", true), "user_request");
});

test("4. blocked reasons and the run notice are one shared, truthful vocabulary", () => {
  assert.match(spend.MEDIA_SPEND_BLOCK_TITLES.automatic_media_disabled, /^Automatic media generation disabled/);
  assert.match(spend.MEDIA_SPEND_BLOCK_TITLES.budget_exhausted, /^Monthly AI media budget reached/);
  assert.deepEqual([...spend.MEDIA_SPEND_BLOCK_REASONS], ["automatic_media_disabled", "budget_exhausted"]);
  assert.deepEqual([...spend.MEDIA_SOURCES], ["user_request", "assisted", "autopilot"]);

  assert.equal(spend.mediaSpendRunNotice([]), null);
  assert.equal(spend.mediaSpendRunNotice([{ slot: "2026-09-12", stage: "content", code: "x" }]), null);
  const disabled = spend.mediaSpendRunNotice([{ slot: "2026-09-12", stage: "media", code: "automatic_media_disabled" }]);
  assert.match(disabled, /Automatic media generation disabled/);
  assert.match(disabled, /Create with MARA/, "the notice names the action that still works");
  const budget = spend.mediaSpendRunNotice([{ stage: "media", code: "budget_exhausted" }]);
  assert.match(budget, /Monthly AI media budget reached/);
  // Repeated blocks collapse into one sentence per reason.
  assert.equal(
    spend.mediaSpendRunNotice([{ stage: "media", code: "budget_exhausted" }, { stage: "media", code: "budget_exhausted" }]),
    budget,
  );
  assert.match(spend.MANUAL_NEVER_AUTO_SPENDS, /Manual mode never spends on media/);
  // Accounting Voom could not read is surfaced too — never silent, never a lie.
  assert.equal(spend.MEDIA_SPEND_UNVERIFIED_CODE, "media_spend_read_failed");
  const unreadable = spend.mediaSpendRunNotice([{ stage: "media", code: spend.MEDIA_SPEND_UNVERIFIED_CODE }]);
  assert.match(unreadable, /couldn't check this month's AI media spending/);
  assert.equal(
    spend.mediaSpendRunNotice([{ stage: "media", code: "media_job_failed" }]),
    null,
    "an ordinary media failure is not dressed up as a spend decision",
  );
});

// ===========================================================================
// 3. Schema + settings surface
// ===========================================================================

test("5. migration 0031 adds the owner settings and the audited source, and touches no publishing object", async () => {
  const sql = await read("supabase/migrations/0031_ai_media_spend_control.sql");
  assert.match(sql, /\bbegin;/i);
  assert.match(sql, /\bcommit;/i);
  assert.match(sql, /alter table public\.businesses\s+add column if not exists allow_automatic_paid_media boolean not null default true/i);
  assert.match(sql, /alter table public\.businesses\s+add column if not exists monthly_media_budget_usd numeric\(10,2\) not null default 25/i);
  assert.match(sql, /monthly_media_budget_usd >= 0/i);
  assert.match(sql, /alter table public\.mara_media_generations\s+add column if not exists spend_source text/i);
  assert.match(sql, /spend_source is null or spend_source in \('user_request', 'assisted', 'autopilot'\)/i);
  // Budget accounting reuses the existing estimated_cost_usd column.
  assert.match(sql, /estimated_cost_usd is not null/i);
  // Publishing is deliberately untouched by this migration.
  assert.doesNotMatch(sql, /instagram_publish_queue|instagram_publish_jobs|content_calendar_items|cron\.|pg_cron/i);
  const statements = sql.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(statements, /\bdrop table\b|\bcreate table\b|\bgrant\b|\brevoke\b|\bpolicy\b/i, "no table/policy/privilege statement");
  assert.doesNotMatch(statements, /alter table public\.mara_media_generations\s+alter column/i);

  const files = await readdir(new URL("../supabase/migrations/", import.meta.url));
  assert.deepEqual(files.filter((name) => /^0031_/.test(name)), ["0031_ai_media_spend_control.sql"], "the only 0031 is AI media spend control");
});

test("6. the settings screen saves through the owner-scoped path with the shared copy", async () => {
  const page = await read("app/app/(shell)/settings/page.tsx");
  assert.match(page, /AI Media Spending/);
  assert.match(page, /Allow MARA to generate paid media automatically/);
  assert.match(page, /Monthly AI media budget \(USD\)/);
  assert.match(page, /MANUAL_NEVER_AUTO_SPENDS/, "the Manual-never-auto-spends copy is shared, not retyped");
  assert.match(page, /saveMediaSpend\(/);
  assert.match(page, /inputMode="decimal"/);

  const mutations = await read("lib/voom/mutations.ts");
  assert.match(mutations, /export async function saveMediaSpendSettings/);
  assert.match(mutations, /allow_automatic_paid_media: settings\.allowAutomaticPaidMedia/);
  assert.match(mutations, /monthly_media_budget_usd: settings\.monthlyMediaBudgetUsd/);
  assert.match(mutations, /\.eq\("owner_user_id", user\.id\)/, "the save is owner-scoped");
  assert.match(mutations, /normalizeMediaSpendSettings/, "the saved value is normalized by the same helper the gate uses");

  const store = await read("lib/voom/store.tsx");
  assert.match(store, /mediaSpend: normalizeMediaSpendSettings\(init\.business\)/, "the UI is seeded from the saved row");
  assert.match(store, /saveMediaSpendSettings as saveMediaSpendAction/);

  const types = await read("lib/voom/types.ts");
  assert.match(types, /allow_automatic_paid_media/);
  assert.match(types, /monthly_media_budget_usd/);
});

// ===========================================================================
// 4. Behaviour through the REAL service, ports and media module
// ===========================================================================

test("7. Manual never auto-generates paid media — even with the toggle on and budget available", async () => {
  resetRecords();
  const db = seedAccount({ mode: "manual", allowAutomatic: true, budget: 25 });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  assert.equal(run.mode, "manual");
  assert.equal(run.stage, "planning_only");
  assert.ok(run.planId, "the plan was still created");
  assert.equal(db.rows("mara_drafts").length, 3, "drafts are created");
  assert.equal(provider.image.length, 0, "no Seedream request");
  assert.equal(provider.video.length, 0, "no Seedance request");
  assert.equal(db.rows("mara_media_generations").length, 0, "no generation row");
  assert.equal(db.writesTo("mara_media_generations").length, 0, "no generation write at all");
  assert.equal(db.rows("post_draft_assets").length, 0, "no stored bytes");
  assert.equal(db.rpcs.length, 0, "no publish-queue RPC");
});

test("8. Assisted with the toggle off plans the work, submits no media and says why", async () => {
  resetRecords();
  const db = seedAccount({ mode: "assisted", allowAutomatic: false, budget: 25 });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  // Planning is NOT broken by the block: plan, copy and drafts exist.
  assert.equal(run.mode, "assisted");
  assert.equal(run.stage, "full");
  assert.ok(run.planId);
  assert.equal(db.rows("mara_drafts").length, 3);
  assert.equal(db.rows("marketing_plans")[0].planned_posts.length, 3);
  assert.ok(copyRequests().length >= 1, "MARA still writes the copy");

  // No money moved.
  assert.equal(provider.image.length, 0, "no Seedream request");
  assert.equal(provider.video.length, 0, "no Seedance request");
  assert.equal(db.rows("mara_media_generations").length, 0);
  assert.equal(db.writesTo("mara_media_generations").length, 0);

  // The truthful reason is recorded on the run and surfaced to the screen.
  const mediaFailures = run.failures.filter((failure) => failure.stage === "media");
  assert.equal(mediaFailures.length, 3, "every blocked slot is recorded, none silently");
  assert.ok(mediaFailures.every((failure) => failure.code === "automatic_media_disabled"));
  assert.match(spend.mediaSpendRunNotice(run.failures), /Automatic media generation disabled/);

  // Assisted still stops at Needs approval for the items it planned.
  assert.ok(run.awaitingApproval >= 1, "the items wait for the owner, as before");
  assert.equal(db.rows("instagram_publish_queue").length, 0, "nothing is queued to publish");
});

test("9. Assisted with the toggle on and budget available generates and records 'assisted'", async () => {
  resetRecords();
  const db = seedAccount({ mode: "assisted", allowAutomatic: true, budget: 25 });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  assert.equal(run.stage, "full");
  assert.ok(run.mediaQueued >= 1, "media was generated automatically");
  assert.equal(paidSubmissions(), run.mediaQueued, "every queued item reached exactly one paid provider submission");

  const rows = db.rows("mara_media_generations");
  const rowsOf = (type) => rows.filter((row) => row.media_type === type);
  assert.equal(rowsOf("image").length, provider.image.length, "one generation row per image submission");
  assert.equal(rowsOf("video").length, videoSubmissions(), "one durable video job row per provider job");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.spend_source === "assisted"), "every automatic generation records 'assisted'");
  assert.ok(rowsOf("image").every((row) => row.estimated_cost_usd === spend.ESTIMATED_MEDIA_COST.imageUsd), "the centralized image estimate is persisted");
  assert.ok(rowsOf("video").every((row) => row.estimated_cost_usd === videoService.estimatedCostUsdForDuration(6)), "the centralized video estimate is persisted");
  assert.equal(provider.baseFrame.length, videoSubmissions(), "one base frame per video job, never a spare");
  assert.deepEqual(run.failures.filter((failure) => failure.stage === "media"), []);
});

test("10. Autopilot with the toggle on and budget available records 'autopilot'", async () => {
  resetRecords();
  const db = seedAccount({ mode: "autopilot", allowAutomatic: true, budget: 25 });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  assert.equal(run.mode, "autopilot");
  assert.ok(paidSubmissions() >= 1, "media was generated automatically");
  const rows = db.rows("mara_media_generations");
  assert.ok(rows.length >= 1);
  assert.equal(rows.length, paidSubmissions());
  assert.ok(rows.every((row) => row.spend_source === "autopilot"), "every automatic generation records 'autopilot'");
  assert.ok(rows.some((row) => row.media_type === "video" && row.spend_source === "autopilot"), "including the durable video job");
  assert.deepEqual(run.failures.filter((failure) => failure.stage === "media"), []);
});

test("11. an exhausted month blocks NEW automatic media — and still does not break planning", async () => {
  resetRecords();
  const db = seedAccount({
    mode: "assisted", allowAutomatic: true, budget: 25,
    // This month has already used the owner's budget (video + image rows).
    spentRows: [spentGeneration(12.5, { media_type: "video" }), spentGeneration(12.5)],
  });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  assert.equal(provider.image.length, 0, "no Seedream request once the budget is reached");
  assert.equal(videoSubmissions(), 0, "no Seedance request once the budget is reached");
  assert.equal(db.rows("mara_media_generations").length, 2, "no new generation row — only the seeded spend history");

  // Planning is untouched.
  assert.ok(run.planId);
  assert.equal(db.rows("mara_drafts").length, 3, "the drafts still exist and wait for media");
  assert.equal(db.rows("marketing_plans")[0].planned_posts.length, 3);
  const mediaFailures = run.failures.filter((failure) => failure.stage === "media");
  assert.ok(mediaFailures.length >= 1);
  assert.ok(mediaFailures.every((failure) => failure.code === "budget_exhausted"));
  assert.match(spend.mediaSpendRunNotice(run.failures), /Monthly AI media budget reached/);
});

test("12. the budget boundary is inclusive and enforced per submission", async () => {
  resetRecords();
  const db = seedAccount({ mode: "assisted", allowAutomatic: true, budget: 25, spentRows: [spentGeneration(24.95)] });
  seedDraft(db, "draft-a");
  seedDraft(db, "draft-b");

  const first = await mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-a"), {
    now: NOW, mode: "assisted", deps: fakeMediaDeps,
  });
  assert.deepEqual(first, { ok: true, state: "completed" }, "the submission that lands exactly on the cap is allowed");
  assert.equal(provider.image.length, 1);

  const second = await mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-b"), {
    now: NOW, mode: "assisted", deps: fakeMediaDeps,
  });
  assert.deepEqual(second, { ok: false, code: "budget_exhausted" }, "the next submission is refused");
  assert.equal(provider.image.length, 1, "and it never reached the provider");
  assert.equal(db.rows("mara_media_generations").length, 2, "the month's one prior row plus the one allowed submission — refused submissions write nothing");
});

test("13. explicit Create with MARA works while automatic generation is disabled, and is audited", async () => {
  resetRecords();
  const db = seedAccount({
    mode: "manual", allowAutomatic: false, budget: 0,
    spentRows: [spentGeneration(500)], // even with the month's budget used up
  });
  seedDraft(db, "draft-explicit");

  const outcome = await mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-explicit"), {
    now: NOW, explicit: true, deps: fakeMediaDeps,
  });
  assert.deepEqual(outcome, { ok: true, state: "completed" }, "the user's own request still runs");
  assert.equal(provider.image.length, 1, "exactly one Seedream request");
  const rows = db.rows("mara_media_generations");
  assert.equal(rows.length, 2);
  const created = rows.find((row) => row.draft_id === "draft-explicit");
  assert.equal(created.spend_source, "user_request", "the request is recorded as user-requested");
  assert.equal(created.estimated_cost_usd, spend.ESTIMATED_MEDIA_COST.imageUsd, "and it is accounted for");

  // The user's own visual now satisfies the item: the automatic path (the
  // rolling-plan run) never buys a second one for it. The engine asks this
  // question before it reaches the gate at all.
  assert.equal(await mediaMod.mediaAlreadyHandled(db, OWNER, "draft-explicit"), true, "the automatic path sees media it must not replace");
  assert.equal(provider.image.length, 1, "so nothing new is submitted");
  assert.equal(db.rows("mara_media_generations").length, 2, "and no second generation row is written");
});

test("14. no duplicate provider submission: repeated runs and racing clicks submit once", async () => {
  resetRecords();
  const db = seedAccount({ mode: "assisted", allowAutomatic: true, budget: 25 });

  const first = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  const afterFirst = paidSubmissions();
  assert.ok(afterFirst > 0);
  assert.equal(db.rows("mara_media_generations").length, afterFirst, "one generation record per paid submission");

  const second = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });
  assert.equal(second.created, 0, "the second run reuses every slot");
  assert.equal(second.reused, first.reused + first.created);
  assert.equal(paidSubmissions(), afterFirst, "the second run submits nothing to either provider");
  assert.equal(db.rows("mara_media_generations").length, afterFirst, "and writes no second generation");

  // Two racing clicks on one fresh draft: the database's one-active-job guard
  // lets exactly one request through.
  seedDraft(db, "draft-race");
  const imagesBeforeRace = provider.image.length;
  const raced = await Promise.all([
    mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-race"), { now: NOW, explicit: true, deps: fakeMediaDeps }),
    mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-race"), { now: NOW, explicit: true, deps: fakeMediaDeps }),
  ]);
  assert.equal(provider.image.length, imagesBeforeRace + 1, "exactly one of the two racing calls reached the provider");
  assert.ok(raced.some((outcome) => outcome.ok === false), "the other is refused truthfully instead of charging again");
});

test("15. the durable video job row persists the audited source", async () => {
  const inserted = [];
  const planRow = {
    concept: "Reel", visualPrompt: "clean frame", motionDirection: "slow push-in", durationSeconds: 6,
    overlayJson: null, cta: null,
  };
  const row = () => ({
    id: "gen-video-1", owner_user_id: OWNER, draft_id: "draft-reel", media_type: "video",
    status: "generating", provider_job_id: "job-1", created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  });
  const ports = {
    now: () => NOW.getTime(),
    findActiveGeneration: async () => null,
    findGeneration: async () => null,
    findGenerationByIdempotency: async () => null,
    countRecentJobs: async () => 0,
    sumMonthlyVideoCost: async () => 0,
    insertGeneration: async (row) => { inserted.push(row); return "inserted"; },
    updateGeneration: async () => row(),
    planMedia: async () => planRow,
    generateBaseImage: async () => ({ kind: "complete", bytes: jpeg(1080, 1920), mimeType: "image/jpeg" }),
    // (the fixture must survive lib/media/media-inspect: real JPEG bytes, 9:16)
    createVideoJob: async () => ({ providerJobId: "job-1" }),
    pollVideoJob: async () => ({ kind: "pending" }),
    uploadBaseImage: async () => "owner/base.jpg",
    loadReferenceImage: async () => null,
    storeFinalAsset: async () => ({ storagePath: "p", previousStoragePath: null }),
    removeAbandonedObject: async () => {},
    signPreview: async () => null,
  };
  const result = await videoGen.startVideoGeneration(ports, {
    ownerId: OWNER, draftId: "draft-reel", conversationId: "conv-1", scope: "post", kind: "reel",
    concept: "Reel", script: "script", brief: "", idempotencyKey: `video:post:draft-reel:${"a".repeat(24)}`,
    sourceAsset: null, providerName: "openrouter", supportsImageToVideo: true,
    estimatedCostUsd: spend.estimateMediaCostUsd({ mediaType: "video", durationSeconds: 6 }), monthlySpendLimitUsd: null,
    source: "autopilot",
  });
  assert.equal(result.ok, true, "the job was accepted");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].spend_source, "autopilot", "the automatic source is persisted on the job row");
  assert.equal(inserted[0].estimated_cost_usd, 0.6, "with the centralized estimate");
  assert.equal(inserted[0].status, "queued");
});

test("17. unreadable accounting blocks the spend, never the plan, and never authorises a charge", async () => {
  resetRecords();
  const db = seedAccount({ mode: "assisted", allowAutomatic: true, budget: 25, failSpendRead: true });
  const run = await service.runOwnerWorkflow(db, { ownerId: OWNER, now: NOW, trigger: "replenish", mediaDeps: fakeMediaDeps });

  // Planning is untouched — the same plan, copy and drafts, no media.
  assert.equal(run.stage, "full");
  assert.ok(run.planId);
  assert.equal(db.rows("mara_drafts").length, 3, "drafts are still created");
  assert.ok(copyRequests().length >= 1, "MARA still writes the copy");
  assert.equal(paidSubmissions(), 0, "a database that cannot be read never authorises a charge");
  assert.equal(db.rows("mara_media_generations").length, 0, "and no generation row is written");
  const mediaFailures = run.failures.filter((failure) => failure.stage === "media");
  assert.equal(mediaFailures.length, 3);
  assert.ok(mediaFailures.every((failure) => failure.code === spend.MEDIA_SPEND_UNVERIFIED_CODE));
  assert.match(spend.mediaSpendRunNotice(run.failures), /couldn't check this month's AI media spending/);

  // The same refusal at the module level: it throws instead of allowing.
  seedDraft(db, "draft-unreadable");
  await assert.rejects(
    () => mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-unreadable"), { now: NOW, mode: "assisted", deps: fakeMediaDeps }),
    /media_spend_read_failed/,
    "automatic media fails closed when the accounting cannot be read",
  );
  assert.equal(paidSubmissions(), 0);

  // The owner's own click needs no accounting read at all.
  const spendReadsBefore = db.spendReads;
  const explicit = await mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-unreadable"), { now: NOW, explicit: true, deps: fakeMediaDeps });
  assert.deepEqual(explicit, { ok: true, state: "completed" }, "Create with MARA keeps working");
  assert.equal(db.spendReads, spendReadsBefore, "an explicit request reads no spend accounting");
  assert.equal(db.rows("mara_media_generations").length, 1, "and is recorded");
  assert.equal(db.rows("mara_media_generations")[0].spend_source, "user_request");
});

test("16. the workflow media module refuses BEFORE any write or provider call", async () => {
  resetRecords();
  const db = seedAccount({ mode: "assisted", allowAutomatic: false, budget: 25 });
  seedDraft(db, "draft-refused");

  const outcome = await mediaMod.produceWorkflowMedia(db, mediaRequestFor("draft-refused"), {
    now: NOW, mode: "assisted", deps: fakeMediaDeps,
  });
  assert.deepEqual(outcome, { ok: false, code: "automatic_media_disabled" });
  assert.equal(provider.image.length, 0);
  assert.equal(db.rows("mara_media_generations").length, 0);
  // The refusal is not routed through the engine's automatic path either.
  assert.deepEqual(db.writesTo("mara_media_generations"), []);
  assert.deepEqual(db.writes.filter((write) => write.table === "post_draft_assets"), []);

  // The engine keeps the item and records the media-stage reason truthfully.
  const run = await rolling.ensureRollingPlan({
    async ensurePlan() { return "plan-x"; },
    async listItems() { return []; },
    async generateContent(slot) {
      return { concept: `c-${slot.date}`, caption: "cap", cta: "cta", hashtags: [], visualBrief: "vb" };
    },
    async createDraft({ slot, content }) {
      return { draftId: `d-${slot.date}`, slotKey: slot.date, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" };
    },
    async ensureMedia() { return { ok: false, code: "automatic_media_disabled" }; },
    async requestApproval() {},
    async autoApproveAndSchedule() { return { approved: false }; },
    async savePlanItems() {},
  }, { now: NOW, timeZone: TZ, cadence: "3x_week", mode: "assisted", goal: "awareness", trigger: "scheduled" });
  assert.equal(run.created, 3, "planning completed");
  assert.equal(run.awaitingApproval, 3, "every item still reached the approval step");
  assert.ok(run.failures.every((failure) => failure.stage === "media" && failure.code === "automatic_media_disabled"));
});
