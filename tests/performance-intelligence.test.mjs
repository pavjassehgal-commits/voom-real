/**
 * Voom Performance Intelligence v1 — behavioural acceptance suite.
 *
 * Real modules under test (no string matching where behaviour can be driven):
 *   lib/performance/types.ts       — the ONE normalized performance model
 *   lib/performance/classify.ts    — deterministic purpose/topic derivation
 *   lib/performance/insights.ts    — relative comparisons, small-sample honesty
 *   lib/performance/sync.ts        — the read-only published-content collector
 *   lib/performance/data.ts        — the owner-scoped read model
 *   lib/performance/plan-context.ts— the advisory context for MARA
 *   lib/voom/workflow/prompt.ts    — the planning payload + system prompt
 *   lib/voom/workflow/service.ts   — production planning ports (real wiring)
 *   lib/voom/workflow/rolling-plan.ts — the real rolling horizon engine
 *   lib/instagram/metrics.ts       — which Meta metrics are requested
 *   lib/instagram/crypto.ts        — real token encryption for the fake store
 *
 * Nothing external is touched: Meta is a fake read-only port, the model is a
 * stub provider, Supabase is an in-memory table store, and no cron, publish or
 * media-generation path is invoked anywhere in this file.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sync = await import("../lib/performance/sync.ts");
const perfTypes = await import("../lib/performance/types.ts");
const insights = await import("../lib/performance/insights.ts");
const planContext = await import("../lib/performance/plan-context.ts");
const perfData = await import("../lib/performance/data.ts");
const classify = await import("../lib/performance/classify.ts");
const promptMod = await import("../lib/voom/workflow/prompt.ts");
const service = await import("../lib/voom/workflow/service.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const igMetrics = await import("../lib/instagram/metrics.ts");
const igCrypto = await import("../lib/instagram/crypto.ts");

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const KEY = "performance-test-key-0123456789abcdef";
const NOW = new Date("2026-09-14T09:00:00.000Z");
const TZ = "Asia/Dubai";

// ---------------------------------------------------------------------------
// In-memory, owner-aware Supabase-shaped store. Writes are recorded so the
// tests can prove what the sync touched (and what it never touched).
// ---------------------------------------------------------------------------

function createFakeAdmin(tables = {}, secrets = {}) {
  const store = new Map(Object.entries(tables).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const writes = [];
  const rpcCalls = [];

  const rowsOf = (table) => {
    if (!store.has(table)) store.set(table, []);
    return store.get(table);
  };

  const compare = (left, right) => {
    if (typeof left === "string" && typeof right === "string") {
      const a = Date.parse(left);
      const b = Date.parse(right);
      if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    }
    return left === right ? 0 : left < right ? -1 : 1;
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = "select";
      this.rows = null;
      this.patch = null;
      this.onConflict = null;
      this.orderSpec = null;
      this.limitCount = null;
    }
    select() { return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) {
      const set = new Set(values.map(String));
      this.filters.push((row) => set.has(String(row[column])));
      return this;
    }
    not(column, operator, value) {
      if (operator !== "is" || value !== null) throw new Error(`fake admin: unsupported not(${column}, ${operator})`);
      this.filters.push((row) => row[column] !== null && row[column] !== undefined);
      return this;
    }
    gte(column, value) { this.filters.push((row) => compare(row[column], value) >= 0); return this; }
    order(column, options = {}) { this.orderSpec = { column, ascending: options.ascending !== false }; return this; }
    limit(count) { this.limitCount = count; return this; }
    insert(rows) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.op = "update"; this.patch = patch; return this; }
    upsert(rows, options = {}) { this.op = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.onConflict = options.onConflict ?? null; return this; }
    async maybeSingle() { const rows = await this.#run(); return { data: rows[0] ?? null, error: null }; }
    async single() {
      const rows = await this.#run();
      return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "no rows" } };
    }
    then(onFulfilled, onRejected) {
      return Promise.resolve(this.#run()).then((rows) => ({ data: rows, error: null })).then(onFulfilled, onRejected);
    }
    async #run() {
      const table = this.table;
      if (this.op === "insert" || this.op === "upsert") {
        writes.push({ table, op: this.op });
        const conflictColumns = (this.onConflict ?? "").split(",").map((value) => value.trim()).filter(Boolean);
        const inserted = [];
        for (const row of this.rows) {
          const existing = this.op === "upsert" && conflictColumns.length
            ? rowsOf(table).find((candidate) => conflictColumns.every((column) => candidate[column] === row[column]))
            : undefined;
          if (existing) Object.assign(existing, row);
          else rowsOf(table).push({ ...row });
          inserted.push(existing ?? row);
        }
        return inserted;
      }
      if (this.op === "update") {
        writes.push({ table, op: "update" });
        const matched = rowsOf(table).filter((row) => this.filters.every((match) => match(row)));
        for (const row of matched) Object.assign(row, this.patch);
        return matched;
      }
      let rows = rowsOf(table).filter((row) => this.filters.every((match) => match(row))).map((row) => ({ ...row }));
      if (this.orderSpec) {
        const { column, ascending } = this.orderSpec;
        rows.sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
      }
      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      return rows;
    }
  }

  return {
    store,
    writes,
    rpcCalls,
    from: (table) => new Query(table),
    rpc: (name, args = {}) => {
      rpcCalls.push({ name, args });
      const data = name === "get_instagram_connection_secret" ? secrets[args.p_owner_user_id] ?? null : null;
      return { maybeSingle: async () => ({ data, error: null }) };
    },
  };
}

/** A real (encrypted) connection secret row, produced with Voom's own crypto. */
function secretFor(ownerId, token) {
  const encrypted = igCrypto.encryptInstagramToken(token, KEY);
  return {
    connection_status: "connected",
    instagram_user_id: `ig-${ownerId}`,
    encrypted_access_token: encrypted.encryptedToken,
    token_iv: encrypted.iv,
    token_auth_tag: encrypted.authTag,
    token_expires_at: "2026-12-01T00:00:00.000Z",
    key_version: encrypted.keyVersion,
  };
}

// ---------------------------------------------------------------------------
// Fake Meta port — READ ONLY by construction: it exposes exactly the two read
// methods the sync is allowed to use, and records every call.
// ---------------------------------------------------------------------------

function createFakeInstagram(options = {}) {
  const calls = { media: [], insights: [] };
  const mutable = { details: { ...(options.details ?? {}) }, insights: { ...(options.insights ?? {}) } };
  return {
    calls,
    mutable,
    async getMediaDetails(accessToken, mediaId) {
      calls.media.push({ accessToken, mediaId });
      const failure = options.mediaError?.[mediaId];
      if (failure) throw failure;
      return mutable.details[mediaId] ?? null;
    },
    async getMediaInsights({ accessToken, mediaId, metrics }) {
      calls.insights.push({ accessToken, mediaId, metrics });
      const failure = options.insightsError?.[mediaId];
      if (failure) throw failure;
      const value = mutable.insights[mediaId];
      if (!value) return { entries: [], unavailable: metrics, refused: true };
      return { entries: value.entries ?? [], unavailable: value.unavailable ?? [], refused: value.refused ?? false };
    },
  };
}

function providerError(code) {
  return Object.assign(new Error(code), { code });
}

function queueRow(overrides) {
  return {
    id: "queue-1", owner_user_id: OWNER_A, draft_id: "draft-1", calendar_item_id: "cal-1",
    media_kind: "image", caption: "caption", scheduled_at: "2026-09-12T15:00:00.000Z",
    status: "published", instagram_media_id: "media-1", attempts: 1, last_attempt_at: null,
    claimed_at: null, failure_code: null, failure_message: null,
    published_at: "2026-09-12T15:00:00.000Z", ...overrides,
  };
}

function connectionRow(overrides = {}) {
  return {
    owner_user_id: OWNER_A, status: "connected",
    scopes: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"],
    token_expires_at: null, ...overrides,
  };
}

function syncDeps({ tables, secrets, port, config = true, now = NOW, limit, budgetMs } = {}) {
  return {
    db: createFakeAdmin(tables, secrets),
    config: config === false ? null : {
      appId: "app", appSecret: "secret", graphVersion: "v22.0",
      redirectUri: "https://example.com/callback", encryptionKey: KEY, legacyEncryptionKeys: [],
    },
    client: port,
    now,
    // The injected fixed `now` represents the collection instant, so the
    // real wall-clock budget must be anchored to real time, not the fixed
    // fixture; otherwise the deadline expires as soon as the real clock
    // passes the fixture. A huge explicit budget keeps these tests
    // deterministic at any hour.
    budgetMs: budgetMs ?? 10_000_000_000,
    ...(limit ? { limit } : {}),
  };
}

/** Meta-shaped insight entry used throughout the sync tests. */
/** Snapshot rows written so far (the table only exists once it is touched). */
function snapshotRows(db) {
  return db.store.get("instagram_performance_snapshots") ?? [];
}

function insightEntry(name, value) {
  return { name, period: "lifetime", values: [{ value }] };
}

// ---------------------------------------------------------------------------
// 1. Normalization
// ---------------------------------------------------------------------------

test("normalization: Meta envelopes become Voom's model, and nothing is invented", () => {
  const normalized = perfTypes.normalizeInsightPayload({
    data: [
      insightEntry("reach", 812),
      insightEntry("saved", 9),
      { name: "plays", total_value: { value: 44 } },
      { name: "views", value: 1200 },
      // Unknown / non-count / absurd payloads must be ignored, not guessed.
      { name: "ig_reels_avg_watch_time", values: [{ value: 7420 }] },
      { name: "navigation", values: [{ value: 12 }] },
      { name: "shares", values: [{ value: -3 }] },
      { name: "comments", values: [{ value: Number.NaN }] },
      { name: "likes", values: [{ value: "not-a-number" }] },
      { values: [{ value: 99 }] },
      null,
    ],
  });
  assert.deepEqual(normalized.metrics, { reach: 812, saves: 9, plays: 44, views: 1200 });
  assert.deepEqual([...normalized.metricsAvailable].sort(), ["plays", "reach", "saves", "views"]);
  // A duplicate metric is never summed into a number Meta never returned.
  assert.deepEqual(perfTypes.normalizeInsightPayload({ data: [insightEntry("reach", 10), insightEntry("reach", 40)] }).metrics, { reach: 10 });
  // The media node contributes only its documented counters.
  assert.deepEqual(perfTypes.normalizeMediaNode({ like_count: 12, comments_count: "7", media_type: "IMAGE" }), { likes: 12, comments: 7 });
  assert.deepEqual(perfTypes.normalizeMediaNode({ media_type: "IMAGE" }), {});
  // Insights win over the media-node fallback for the same metric.
  assert.deepEqual(perfTypes.mergeMetrics({ likes: 4 }, { likes: 99, comments: 1 }), { likes: 4, comments: 1 });
  // Only current, count metrics are requested; impressions is deprecated.
  assert.doesNotMatch(igMetrics.INSIGHTS_METRICS_BY_KIND.post.join(","), /impressions/);
  assert.match(igMetrics.INSIGHTS_METRICS_BY_KIND.reel.join(","), /plays/);
  assert.match(igMetrics.INSIGHTS_METRICS_BY_KIND.story.join(","), /replies/);
  assert.deepEqual(igMetrics.INSIGHTS_METRICS_BY_KIND.story.filter((metric) => ["likes", "comments", "saved"].includes(metric)), []);
  assert.equal(igMetrics.hasInsightsPermission([]), true, "an empty scope list is unknown, so the call is attempted");
  assert.equal(igMetrics.hasInsightsPermission(["instagram_business_basic"]), false);
  assert.equal(igMetrics.hasInsightsPermission(["instagram_business_basic", "instagram_business_manage_insights"]), true);
});

test("deterministic purpose and topic derivation from stored text only", () => {
  assert.equal(classify.classifyPurpose("Get 20% off this week in Dubai"), "promotional");
  assert.equal(classify.classifyPurpose("How to choose the right payment provider"), "educational");
  assert.equal(classify.classifyPurpose("What our customers say about us"), "trust");
  assert.equal(classify.classifyPurpose("Meet the team behind the scenes"), "community");
  assert.equal(classify.classifyPurpose("", null), "general");
  const items = [
    { key: "1", text: "Faster payment speed settlement" },
    { key: "2", text: "Instant payment speed verification" },
    { key: "3", text: "Weekend trading hours" },
    { key: "4", text: "Weekend trading hours" },
    { key: "5", text: "A one-off announcement about nothing shared" },
  ];
  const first = classify.assignTopics(items);
  const second = classify.assignTopics(items);
  assert.deepEqual([...first.entries()], [...second.entries()], "classification is deterministic");
  assert.equal(first.get("1"), "payment speed");
  assert.equal(first.get("2"), "payment speed");
  assert.equal(first.get("3"), "trading hours");
  assert.equal(first.get("5"), null, "an item that shares no theme with another item is not given one");
});

// ---------------------------------------------------------------------------
// 2. Collection strategy: published-only, idempotent, honest about missing data
// ---------------------------------------------------------------------------

test("collection reads ONLY already-published items that carry a real Meta media id", async () => {
  const port = createFakeInstagram({
    details: { "media-published": { id: "media-published", media_type: "IMAGE", like_count: 11, comments_count: 2 } },
    insights: { "media-published": { entries: [insightEntry("reach", 500), insightEntry("saved", 6)], unavailable: [] } },
  });
  const deps = syncDeps({
    port,
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
    tables: {
      instagram_connections: [connectionRow()],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [
        queueRow({ id: "q-published", instagram_media_id: "media-published" }),
        queueRow({ id: "q-scheduled", status: "scheduled", instagram_media_id: "media-scheduled" }),
        queueRow({ id: "q-failed", status: "failed", instagram_media_id: "media-failed" }),
        queueRow({ id: "q-waiting", status: "waiting_for_media", instagram_media_id: null }),
        queueRow({ id: "q-cancelled", status: "cancelled", instagram_media_id: "media-cancelled" }),
        // Published long ago: outside the refresh lookback window.
        queueRow({ id: "q-old", instagram_media_id: "media-old", published_at: "2026-06-01T10:00:00.000Z" }),
      ],
    },
  });
  const result = await sync.runInstagramPerformanceSync(deps);

  assert.deepEqual(port.calls.media.map((call) => call.mediaId), ["media-published"], "only published media is ever read");
  assert.deepEqual(port.calls.insights.map((call) => call.mediaId), ["media-published"]);
  assert.equal(result.checked, 1);
  assert.equal(result.stored, 1);
  assert.equal(result.failed, 0);
  const snapshots = snapshotRows(deps.db);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(
    {
      owner: snapshots[0].owner_user_id, business: snapshots[0].business_id, draft: snapshots[0].draft_id,
      queue: snapshots[0].publish_queue_id, media: snapshots[0].instagram_media_id, type: snapshots[0].content_type,
      published: snapshots[0].published_at, collected: snapshots[0].collected_at,
    },
    {
      owner: OWNER_A, business: "biz-a", draft: "draft-1", queue: "q-published",
      media: "media-published", type: "post", published: "2026-09-12T15:00:00.000Z",
      // Collection instant is bucketed to the hour-long window.
      collected: "2026-09-14T09:00:00.000Z",
    },
  );
  assert.deepEqual(snapshots[0].metrics, { reach: 500, saves: 6, likes: 11, comments: 2 });
  assert.deepEqual(snapshots[0].metric_sources, { likes: "media_node", comments: "media_node", reach: "insights", saves: "insights" });
  assert.equal(result.items[0].outcome, "stored");
  // The only writes the whole run performed are performance snapshots.
  assert.deepEqual([...new Set(deps.db.writes.map((write) => `${write.table}:${write.op}`))], ["instagram_performance_snapshots:upsert"]);
});

test("sync is idempotent: a rerun in the same collection window refreshes one row", async () => {
  const port = createFakeInstagram({
    details: { "media-1": { id: "media-1", media_type: "IMAGE", like_count: 5, comments_count: 1 } },
    insights: { "media-1": { entries: [insightEntry("reach", 100)], unavailable: [] } },
  });
  const deps = syncDeps({
    port,
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
    tables: {
      instagram_connections: [connectionRow()],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [queueRow({ instagram_media_id: "media-1" })],
    },
  });
  const first = await sync.runInstagramPerformanceSync(deps);
  assert.equal(first.stored, 1);
  assert.equal(first.refreshed, 0);

  // Meta's numbers move; the SAME window updates the SAME row.
  port.mutable.insights["media-1"] = { entries: [insightEntry("reach", 175)], unavailable: [] };
  port.mutable.details["media-1"] = { id: "media-1", media_type: "IMAGE", like_count: 9, comments_count: 2 };
  const second = await sync.runInstagramPerformanceSync(deps);

  assert.equal(second.stored, 0);
  assert.equal(second.refreshed, 1);
  assert.equal(second.items[0].outcome, "refreshed");
  const snapshots = snapshotRows(deps.db);
  assert.equal(snapshots.length, 1, "an idempotent refresh never duplicates a snapshot");
  assert.deepEqual(snapshots[0].metrics, { reach: 175, likes: 9, comments: 2 });

  // A later window is a new snapshot, i.e. history is kept.
  const later = await sync.runInstagramPerformanceSync({ ...deps, now: new Date("2026-09-14T10:30:00.000Z") });
  assert.equal(later.stored, 1);
  assert.equal(snapshotRows(deps.db).length, 2);
});

test("metrics Meta does not expose are ABSENT, never stored as zero", async () => {
  const port = createFakeInstagram({
    // Meta refused the insights permission: only the media node is readable.
    details: { "media-1": { id: "media-1", media_type: "IMAGE", like_count: 7, comments_count: 3 } },
    insights: { "media-1": { entries: [], unavailable: ["reach", "views", "likes", "comments", "saved", "shares", "total_interactions"], refused: true } },
  });
  const deps = syncDeps({
    port,
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
    tables: {
      instagram_connections: [connectionRow()],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [queueRow({ instagram_media_id: "media-1" })],
    },
  });
  const result = await sync.runInstagramPerformanceSync(deps);
  const snapshot = snapshotRows(deps.db)[0];

  assert.equal(result.stored, 1, "the media-node metrics are real, so they are stored");
  assert.deepEqual(snapshot.metrics, { likes: 7, comments: 3 });
  for (const metric of ["reach", "views", "saves", "shares", "total_interactions"]) {
    assert.equal(Object.hasOwn(snapshot.metrics, metric), false, `${metric} must be absent, not zero`);
  }
  assert.deepEqual([...snapshot.metric_sources.keys?.() ?? Object.keys(snapshot.metric_sources)], ["likes", "comments"]);
  assert.equal(result.items[0].code, "insights_refused");
  assert.ok(result.items[0].unavailableMetrics.includes("reach"));

  // And when Meta exposes nothing at all, NOTHING is written.
  const empty = syncDeps({
    port: createFakeInstagram({ details: { "media-2": { id: "media-2", media_type: "IMAGE" } } }),
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
    tables: {
      instagram_connections: [connectionRow()],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [queueRow({ instagram_media_id: "media-2" })],
    },
  });
  const emptyResult = await sync.runInstagramPerformanceSync(empty);
  assert.equal(emptyResult.items[0].outcome, "insights_unavailable");
  assert.equal(snapshotRows(empty.db).length, 0);
});

test("without the insights permission Voom still stores the real node metrics and says what it could not read", async () => {
  const port = createFakeInstagram({
    details: { "media-1": { id: "media-1", media_type: "IMAGE", like_count: 12, comments_count: 4 } },
  });
  const deps = syncDeps({
    port,
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
    tables: {
      instagram_connections: [connectionRow({ scopes: ["instagram_business_basic", "instagram_business_content_publish"] })],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [queueRow({ instagram_media_id: "media-1" })],
    },
  });
  const result = await sync.runInstagramPerformanceSync(deps);

  assert.equal(port.calls.insights.length, 0, "no insights call is made without the permission");
  assert.equal(result.stored, 1, "the media node metrics are real and are stored");
  assert.deepEqual(snapshotRows(deps.db)[0].metrics, { likes: 12, comments: 4 });
  assert.equal(result.items[0].code, "insights_scope_missing");
  assert.ok(result.items[0].unavailableMetrics.includes("reach"), "unreadable metrics are reported as unavailable, never invented");
  assert.deepEqual(snapshotRows(deps.db)[0].metric_sources, { likes: "media_node", comments: "media_node" });
});

test("a disconnected, revoked or expired Meta connection is skipped without a Meta call", async () => {
  for (const [label, connection, code] of [
    ["revoked", connectionRow({ status: "revoked" }), "connection_revoked"],
    ["expired status", connectionRow({ status: "expired" }), "connection_expired"],
    ["expired token", connectionRow({ token_expires_at: "2026-09-01T00:00:00.000Z" }), "connection_token_expired"],
    ["missing row", undefined, "connection_missing"],
  ]) {
    const port = createFakeInstagram({ details: { "media-1": { id: "media-1", like_count: 3 } } });
    const deps = syncDeps({
      port,
      secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
      tables: {
        instagram_connections: connection ? [connection] : [],
        businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
        instagram_publish_queue: [queueRow({ instagram_media_id: "media-1" })],
      },
    });
    const result = await sync.runInstagramPerformanceSync(deps);
    assert.equal(result.ownersProcessed[0].outcome, "connection_unavailable", label);
    assert.equal(result.ownersProcessed[0].code, code, label);
    assert.equal(port.calls.media.length, 0, `${label}: no Meta read may happen`);
    assert.equal(snapshotRows(deps.db).length, 0);
    assert.equal(result.ownersProcessed[0].checked, 1, "the item is still reported as checked, just not measured");
  }

  // Undecryptable credentials behave exactly like "not connected".
  const port = createFakeInstagram({});
  const deps = syncDeps({
    port,
    secrets: {},
    tables: {
      instagram_connections: [connectionRow()],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [queueRow({ instagram_media_id: "media-1" })],
    },
  });
  const result = await sync.runInstagramPerformanceSync(deps);
  assert.equal(result.ownersProcessed[0].code, "connection_credentials_unavailable");
  assert.equal(port.calls.media.length, 0);
});

test("a refused token aborts that owner only, and never mutates the connection row", async () => {
  const port = createFakeInstagram({
    details: { "media-a": { id: "media-a", like_count: 3 }, "media-b": { id: "media-b", like_count: 8, comments_count: 1 } },
    mediaError: { "media-a": providerError("unauthorized") },
  });
  const connection = connectionRow();
  const deps = syncDeps({
    port,
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a"), [OWNER_B]: secretFor(OWNER_B, "token-b") },
    tables: {
      instagram_connections: [connection, connectionRow({ owner_user_id: OWNER_B })],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }, { id: "biz-b", owner_user_id: OWNER_B }],
      instagram_publish_queue: [
        queueRow({ id: "q-a", owner_user_id: OWNER_A, instagram_media_id: "media-a" }),
        queueRow({ id: "q-b", owner_user_id: OWNER_B, draft_id: "draft-b", instagram_media_id: "media-b", published_at: "2026-09-11T15:00:00.000Z" }),
      ],
    },
  });
  const result = await sync.runInstagramPerformanceSync(deps);

  const ownerA = result.ownersProcessed.find((owner) => owner.ownerId === OWNER_A);
  const ownerB = result.ownersProcessed.find((owner) => owner.ownerId === OWNER_B);
  assert.equal(ownerA.outcome, "unauthorized");
  assert.equal(ownerA.code, "connection_unauthorized");
  assert.equal(ownerB.outcome, "synced", "one refused owner must not stop the rest");
  assert.equal(ownerB.stored, 1);
  assert.deepEqual(port.calls.media.map((call) => call.mediaId), ["media-a", "media-b"]);
  // A refused INSIGHT read must never disable publishing state.
  assert.deepEqual(connection, connectionRow());
  assert.deepEqual(deps.db.store.get("instagram_connections")[0], connectionRow());

  // Rate limiting stops the whole run instead of hammering Meta.
  const limited = syncDeps({
    port: createFakeInstagram({ mediaError: { "media-1": providerError("rate_limited") } }),
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
    tables: {
      instagram_connections: [connectionRow()],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [queueRow({ instagram_media_id: "media-1" })],
    },
  });
  const limitedResult = await sync.runInstagramPerformanceSync(limited);
  assert.equal(limitedResult.ownersProcessed[0].outcome, "rate_limited");
  assert.equal(limitedResult.truncated, true);
});

test("owner isolation: one owner's token is never used for another owner's media", async () => {
  const port = createFakeInstagram({
    details: {
      "media-a": { id: "media-a", media_type: "IMAGE", like_count: 4 },
      "media-b": { id: "media-b", media_type: "REELS", like_count: 40 },
    },
  });
  const deps = syncDeps({
    port,
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a"), [OWNER_B]: secretFor(OWNER_B, "token-b") },
    tables: {
      instagram_connections: [connectionRow(), connectionRow({ owner_user_id: OWNER_B })],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }, { id: "biz-b", owner_user_id: OWNER_B }],
      instagram_publish_queue: [
        queueRow({ id: "q-a", owner_user_id: OWNER_A, draft_id: "draft-a", instagram_media_id: "media-a" }),
        queueRow({ id: "q-b", owner_user_id: OWNER_B, draft_id: "draft-b", media_kind: "reel", instagram_media_id: "media-b", published_at: "2026-09-11T15:00:00.000Z" }),
      ],
    },
  });
  await sync.runInstagramPerformanceSync(deps);

  for (const call of port.calls.media) {
    const expected = call.mediaId === "media-a" ? "token-a" : "token-b";
    assert.equal(call.accessToken, expected, `${call.mediaId} must be read with its own owner's token`);
  }
  const snapshots = snapshotRows(deps.db);
  // Newest published first, each written with its own owner and content type.
  assert.deepEqual(snapshots.map((row) => [row.owner_user_id, row.instagram_media_id, row.content_type]), [
    [OWNER_A, "media-a", "post"], [OWNER_B, "media-b", "reel"],
  ]);

  // The read model is owner-scoped too, and resolves titles from that owner's drafts.
  const readDeps = createFakeAdmin({
    instagram_performance_snapshots: snapshots,
    instagram_publish_queue: deps.db.store.get("instagram_publish_queue"),
    mara_drafts: [
      { id: "draft-a", owner_user_id: OWNER_A, title: "A's post", content: "caption a" },
      { id: "draft-b", owner_user_id: OWNER_B, title: "B's reel", content: "caption b" },
    ],
  });
  const model = await perfData.loadPerformanceModel(readDeps, OWNER_A, { now: NOW });
  assert.deepEqual(model.measurements.map((item) => item.instagramMediaId), ["media-a"]);
  assert.equal(model.measurements[0].title, "A's post");
});

test("no publish or media-generation path is reachable from the performance sync", async () => {
  const port = createFakeInstagram({ details: { "media-1": { id: "media-1", like_count: 1 } } });
  const deps = syncDeps({
    port,
    secrets: { [OWNER_A]: secretFor(OWNER_A, "token-a") },
    tables: {
      instagram_connections: [connectionRow()],
      businesses: [{ id: "biz-a", owner_user_id: OWNER_A }],
      instagram_publish_queue: [queueRow({ instagram_media_id: "media-1" })],
    },
  });
  await sync.runInstagramPerformanceSync(deps);

  // The port itself can only read.
  assert.deepEqual(Object.keys(port).filter((key) => typeof port[key] === "function").sort(), ["getMediaDetails", "getMediaInsights"]);
  // No publishing RPC was issued and no publishing/generation table was written.
  assert.deepEqual(deps.db.rpcCalls.map((call) => call.name), ["get_instagram_connection_secret"]);
  assert.deepEqual([...new Set(deps.db.writes.map((write) => write.table))], ["instagram_performance_snapshots"]);

  // And the module cannot even reach one: no publish, generation or provider import.
  const source = await readFile(new URL("../lib/performance/sync.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "publish-flow", "publish-worker", "publish-queue", "createImageContainer", "createReelContainer",
    "createStoryContainer", "publishContainer", "createAiProvider", "mara_media_generations",
    "reel-production", "video-generation", "media/index",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden), `sync must not reference ${forbidden}`);
  }
  const route = await readFile(new URL("../app/api/cron/instagram-performance/route.ts", import.meta.url), "utf8");
  assert.match(route, /runInstagramPerformanceSync/);
  assert.deepEqual(
    [...route.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).sort(),
    ["@/lib/performance/sync", "@/utils/bearer-auth"],
    "the worker may only reach the read-only performance sync (plus the shared cron auth helper)",
  );
  // The shared auth helper is itself inert: it only reaches node:crypto.
  const bearer = await readFile(new URL("../utils/bearer-auth.ts", import.meta.url), "utf8");
  assert.deepEqual(
    [...bearer.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).sort(),
    ["node:crypto"],
    "the cron auth helper reaches nothing but node:crypto",
  );
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  assert.doesNotMatch(routeCode, /InstagramClient|createAiProvider|publish|generat/i, "no publishing or generation call may exist in the worker");
});

// ---------------------------------------------------------------------------
// 3. Relative scoring, small samples, best content
// ---------------------------------------------------------------------------

/** Seven measured items: 3 winning Reels + 4 lower-reaching Posts. */
function measuredItems() {
  const published = (day) => `2026-09-${String(day).padStart(2, "0")}T15:00:00.000Z`;
  return [
    { instagramMediaId: "m-reel-1", draftId: "d-1", contentType: "reel", title: "Faster payment speed settlement", caption: "payment speed", publishedAt: published(13), collectedAt: "2026-09-14T08:00:00.000Z", metrics: { reach: 900, likes: 30, comments: 3, saves: 9, shares: 4, total_interactions: 46 }, sources: {} },
    { instagramMediaId: "m-reel-2", draftId: "d-2", contentType: "reel", title: "Instant payment speed verification", caption: "payment speed", publishedAt: published(12), collectedAt: "2026-09-14T08:00:00.000Z", metrics: { reach: 1000, likes: 40, comments: 5, saves: 12, shares: 6, total_interactions: 63 }, sources: {} },
    { instagramMediaId: "m-reel-3", draftId: "d-3", contentType: "reel", title: "Clearer payment speed reporting", caption: "payment speed", publishedAt: published(11), collectedAt: "2026-09-14T08:00:00.000Z", metrics: { reach: 800, likes: 22, comments: 2, saves: 7, shares: 3, total_interactions: 34 }, sources: {} },
    { instagramMediaId: "m-post-1", draftId: "d-4", contentType: "post", title: "Weekend trading hours", caption: "trading hours", publishedAt: published(6), collectedAt: "2026-09-14T08:00:00.000Z", metrics: { reach: 300, likes: 5, comments: 1, saves: 1, shares: 0, total_interactions: 7 }, sources: {} },
    { instagramMediaId: "m-post-2", draftId: "d-5", contentType: "post", title: "Weekend trading hours", caption: "trading hours", publishedAt: published(5), collectedAt: "2026-09-14T08:00:00.000Z", metrics: { reach: 350, likes: 6, comments: 1, saves: 2, shares: 1, total_interactions: 10 }, sources: {} },
    { instagramMediaId: "m-post-3", draftId: "d-6", contentType: "post", title: "Weekend trading hours", caption: "trading hours", publishedAt: published(4), collectedAt: "2026-09-14T08:00:00.000Z", metrics: { reach: 320, likes: 7, comments: 0, saves: 1, shares: 0, total_interactions: 8 }, sources: {} },
    { instagramMediaId: "m-post-4", draftId: "d-7", contentType: "post", title: "Weekend trading hours", caption: "trading hours", publishedAt: published(3), collectedAt: "2026-09-14T08:00:00.000Z", metrics: { reach: 330, likes: 4, comments: 1, saves: 1, shares: 1, total_interactions: 7 }, sources: {} },
  ];
}

function reportFor(measurements, extra = {}) {
  return insights.buildPerformanceReport({ measurements, publishedWithoutMetrics: 0, now: NOW, windowDays: 30, ...extra });
}

test("relative comparison: multiples are measured against the account's own recent average", () => {
  const report = reportFor(measuredItems());
  assert.equal(report.confidence, "moderate");
  assert.equal(report.basis.key, "reach");
  assert.equal(report.measuredItems, 7);
  assert.equal(report.baselineSample, 7);

  const reel2 = report.items.find((item) => item.instagramMediaId === "m-reel-2");
  // Baseline excludes the item itself: (900+800+300+350+320+330) / 6 = 500.
  assert.equal(Math.round(reel2.multiple * 100) / 100, 2);
  assert.equal(reel2.difference, 500);

  const reelGroup = report.byContentType.find((group) => group.key === "reel");
  assert.equal(reelGroup.sampleSize, 3);
  assert.equal(Math.round(reelGroup.average), 900);
  // 900 vs the four Posts' 325.
  assert.equal(Math.round(reelGroup.multiple * 100) / 100, 2.77);

  const topic = report.byTopic.find((group) => group.label.includes("payment speed"));
  assert.equal(topic.sampleSize, 3);
  assert.ok(topic.multiple > 2, "the winning theme must beat the account's baseline");

  assert.ok(report.signals.length >= 2);
  assert.ok(report.signals.some((signal) => /Reels are averaging 2\.\d× your recent average/.test(signal)));
  assert.ok(report.signals.some((signal) => /Content about “payment speed” is averaging/.test(signal)));
  assert.ok(report.signals.every((signal) => !/score/i.test(signal)), "no scores are ever produced");
  assert.ok(report.headline.includes("payment speed"));
  assert.ok(report.headline.includes("better than your recent average"));
});

test("small samples are handled honestly: no winner, no multiple, no headline", () => {
  const two = measuredItems().slice(0, 2);
  const report = reportFor(two);
  assert.equal(report.confidence, "none");
  assert.equal(report.emptyReason, "not_enough_history");
  assert.equal(report.best, null);
  assert.equal(report.headline, null);
  assert.equal(report.signals.length, 0);
  assert.ok(report.items.every((item) => item.multiple === null && item.difference === null));
  assert.equal(planContext.buildPerformancePlanContext(report), null, "no context may be invented from 2 items");

  const three = measuredItems().slice(0, 3);
  const small = reportFor(three);
  assert.equal(small.confidence, "low");
  assert.equal(small.emptyReason, null);
  assert.equal(small.headline, null, "a headline needs more than three measured items");

  // A baseline of 1-2 units is never divided into an impressive ratio.
  const tiny = reportFor([
    { ...measuredItems()[0], instagramMediaId: "a", metrics: { likes: 1 } },
    { ...measuredItems()[1], instagramMediaId: "b", metrics: { likes: 2 } },
    { ...measuredItems()[2], instagramMediaId: "c", metrics: { likes: 1 } },
  ]);
  assert.ok(tiny.items.every((item) => item.multiple === null), "a 1-unit average does not produce a multiple");

  const nothing = reportFor([]);
  assert.equal(nothing.emptyReason, "no_published_content");
  const pending = insights.buildPerformanceReport({ measurements: [], publishedWithoutMetrics: 4, now: NOW, windowDays: 30 });
  assert.equal(pending.emptyReason, "no_metrics_yet");
  assert.equal(pending.publishedItems, 4);
});

test("engagement rate is only computed when reach is a legitimate denominator", () => {
  assert.equal(perfTypes.engagementRateOf({ reach: 200, likes: 10, comments: 2 }), 12 / 200);
  assert.equal(perfTypes.engagementRateOf({ reach: 200, total_interactions: 30 }), 0.15);
  assert.equal(perfTypes.engagementRateOf({ likes: 10, comments: 2 }), null, "no reach means no rate");
  assert.equal(perfTypes.engagementRateOf({ reach: 0, likes: 10 }), null, "never divide by zero reach");
  assert.equal(perfTypes.interactionCount({ likes: 1, comments: 2, saves: 3, shares: 4, replies: 5 }), 15);
  assert.equal(perfTypes.interactionCount({ total_interactions: 99, likes: 1 }), 99, "Meta's own total wins");
  assert.equal(perfTypes.interactionCount({ reach: 500 }), null, "no engagement metric is not zero engagement");
});

test("best-performing content detection uses the relative signal, not an invented score", () => {
  const report = reportFor(measuredItems());
  assert.equal(report.best.instagramMediaId, "m-reel-2");
  assert.equal(Math.round(report.best.multiple * 100) / 100, 2);
  assert.equal(report.best.contentType, "reel");
  assert.equal(report.best.topic, "payment speed");
  assert.ok(report.signals.some((signal) => signal.startsWith("Best recent performer:")));
});

test("trend compares the last 7 days with the 7 before, only when both halves have data", () => {
  const report = reportFor(measuredItems());
  assert.ok(report.trend, "7 days of 3 items vs the previous 7 days of 4 items is comparable");
  assert.equal(report.trend.recentSample, 3);
  assert.equal(report.trend.previousSample, 4);
  assert.ok(report.trend.multiple > 2);
  assert.ok(report.signals.some((signal) => /Your last 7 days are/.test(signal)));

  const oneSided = reportFor(measuredItems().slice(0, 3));
  assert.equal(oneSided.trend, null, "nothing to compare against means no trend claim");
});

// ---------------------------------------------------------------------------
// 4. Feed learning into MARA planning
// ---------------------------------------------------------------------------

function stubMara(captured) {
  return {
    async complete() { throw new Error("complete() is not used in this suite"); },
    async *stream() { throw new Error("stream() is not used in this suite"); },
    async decideTools() { throw new Error("decideTools() is not used in this suite"); },
    async structured(request) {
      captured.push(request);
      const payload = JSON.parse(request.messages[1].content);
      // A deterministic stand-in for MARA that FOLLOWS the advisory rules it
      // was given: bias toward the measured winner, never duplicate a concept.
      const winner = payload.recentPerformance?.recentWinners?.[0]?.label ?? "our usual themes";
      const angle = captured.length;
      return request.parse({
        concept: `${winner} — angle ${angle}`,
        hook: "A clear opening hook.",
        caption: `A ${payload.contentType} about ${winner} (angle ${angle}).`,
        cta: "Talk to us",
        hashtags: payload.contentType === "instagram_story" ? [] : ["steady"],
        description: "",
        script: ["Open with the idea", "Show one useful detail", "Close with a simple next step"],
        visualBrief: "Warm natural light, clean composition, no text.",
      });
    },
  };
}

test("MARA's planning request carries the measured context, and only reads it once per run", async () => {
  const report = reportFor(measuredItems());
  const context = planContext.buildPerformancePlanContext(report);
  assert.ok(context, "a 7-item report must produce an advisory context");
  assert.equal(context.confidence, "moderate");
  assert.equal(context.sampleSize, 7);
  assert.equal(context.basis, "reach (accounts reached)");
  assert.equal(context.strongestTopic.label, "“payment speed”");
  assert.equal(context.bestContentType.label, "Reels");
  assert.ok(context.underperformingThemes.every((theme) => theme.multiple < 1));
  assert.ok(context.recentWinners.length <= planContext.MAX_CONTEXT_WINNERS);
  assert.ok(context.guidance.some((rule) => /advisory, never a rule/i.test(rule)));
  assert.ok(context.guidance.some((rule) => /duplicat/i.test(rule)));

  const admin = createFakeAdmin({ mara_conversations: [] });
  const captured = [];
  let loads = 0;
  const ports = await service.buildWorkflowPorts(admin, {
    ownerId: OWNER_A, businessId: "biz-a",
    business: { brand_name: "SynraPay", brand_description: "Payments", main_goal: "Get more enquiries" },
    timeZone: TZ, cadence: "3x_week", goal: "Get more enquiries", now: NOW,
    mode: "assisted", trigger: "scheduled",
    planningDeps: { provider: stubMara(captured), performanceContext: async () => { loads += 1; return context; } },
  });
  const first = await ports.generateContent({ date: "2026-09-14", slotKey: "2026-09-14|instagram_reel", index: 0, channel: "instagram", format: "reel", contentType: "reel", publishAt: "2026-09-14T15:00:00.000Z" });
  const second = await ports.generateContent({ date: "2026-09-16", slotKey: "2026-09-16|instagram_post", index: 1, channel: "instagram", format: "post", contentType: "post", publishAt: "2026-09-16T15:00:00.000Z" });

  assert.equal(loads, 1, "the account's measured results are read once per plan run, not per slot");
  assert.equal(captured.length, 2);
  const payload = JSON.parse(captured[0].messages[1].content);
  assert.equal(payload.recentPerformance.basis, "reach (accounts reached)");
  assert.equal(payload.recentPerformance.confidence, "moderate");
  assert.equal(payload.recentPerformance.recentWinners[0].topic, "payment speed");
  assert.equal(payload.recentPerformance.strongestTopic.label, "“payment speed”");
  assert.equal(payload.recentPerformance.guidance, undefined, "the rules stay in the system prompt, not the data");
  assert.ok(captured[0].messages[0].content.includes(promptMod.PLANNED_CONTENT_SYSTEM_PROMPT));
  for (const rule of planContext.PERFORMANCE_ADVISORY_RULES) {
    assert.ok(captured[0].messages[0].content.includes(rule), `the system prompt must state: ${rule}`);
  }
  assert.notEqual(first.concept, second.concept, "diversity rule: no repeated concept across the horizon");

  // With no measured history there is no performance section at all — and
  // planning still works exactly as before.
  const quiet = [];
  const quietPorts = await service.buildWorkflowPorts(admin, {
    ownerId: OWNER_A, businessId: "biz-a", business: { brand_name: "SynraPay" },
    timeZone: TZ, cadence: "3x_week", goal: "Get more enquiries", now: NOW,
    mode: "assisted", trigger: "scheduled",
    planningDeps: { provider: stubMara(quiet), performanceContext: async () => null },
  });
  const quietContent = await quietPorts.generateContent({ date: "2026-09-14", slotKey: "2026-09-14|instagram_post", index: 0, channel: "instagram", format: "post", contentType: "post", publishAt: "2026-09-14T15:00:00.000Z" });
  assert.equal(JSON.parse(quiet[0].messages[1].content).recentPerformance, null);
  assert.match(quietContent.concept, /our usual themes/);
});

test("the next rolling 7-day plan changes when real performance evidence exists", async () => {
  const context = planContext.buildPerformancePlanContext(reportFor(measuredItems()));
  assert.ok(context);

  const runPlan = async (performance) => {
    const captured = [];
    const store = { drafts: new Map(), slots: new Map(), providerCalls: 0 };
    const provider = stubMara(captured);
    const ports = {
      async ensurePlan() { return "plan-1"; },
      async listItems() { return []; },
      async generateContent(slot) {
        // The production planning call, with the real payload builder.
        return service.generateWorkflowPlannedContent({
          business: { brand_name: "SynraPay", main_goal: "Get more enquiries" },
          goal: "Get more enquiries", cadence: "3x_week", timeZone: TZ, slot,
          plannedConcepts: [...store.drafts.values()].map((item) => item.concept),
          performance, provider,
        });
      },
      async createDraft({ slot, content }) {
        const item = { draftId: `draft-${slot.date}`, slotKey: slot.date, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" };
        store.drafts.set(slot.date, item);
        return item;
      },
      async ensureMedia() { store.providerCalls += 1; return { ok: true }; },
      async requestApproval() {},
      async autoApproveAndSchedule() { return { approved: false }; },
      async savePlanItems() {},
    };
    const result = await rolling.ensureRollingPlan(ports, {
      now: NOW, timeZone: TZ, cadence: "3x_week", mode: "assisted", goal: "Get more enquiries", stage: "planning_only", selectedChannels: ["instagram"],
    });
    return { result, drafts: [...store.drafts.values()], captured, providerCalls: store.providerCalls };
  };

  const informed = await runPlan(context);
  const control = await runPlan(null);

  assert.equal(informed.result.slots, control.result.slots, "the horizon itself is unchanged");
  assert.ok(informed.drafts.length >= 3);
  assert.ok(informed.drafts.every((draft) => /payment speed/i.test(draft.concept)), "an informed plan leans on what measurably worked");
  assert.ok(control.drafts.every((draft) => /usual themes/i.test(draft.concept)), "the control plan had no performance evidence");
  assert.equal(new Set(informed.drafts.map((draft) => draft.concept)).size, informed.drafts.length, "no duplicated concept inside one plan");
  assert.equal(informed.providerCalls, 0, "planning-only never reaches a paid media path");
});

// ---------------------------------------------------------------------------
// 5. Today insight + Performance page wiring
// ---------------------------------------------------------------------------

test("the Today insight exists only when there is enough measured data", async () => {
  const enough = reportFor(measuredItems());
  const notEnough = reportFor(measuredItems().slice(0, 2));
  assert.ok(enough.headline);
  assert.equal(notEnough.headline, null);

  const card = await readFile(new URL("../components/voom/performance/PerformanceIntelligence.tsx", import.meta.url), "utf8");
  assert.match(card, /if \(!report\.headline\) return null;/, "the card renders nothing without a data-backed statement");
  assert.doesNotMatch(card, /collecting data|learning\.\.\.|placeholder/i);

  const today = await readFile(new URL("../app/app/(shell)/today/page.tsx", import.meta.url), "utf8");
  const operatingData = await readFile(new URL("../lib/voom/operating-data.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../components/voom/today/TodayDashboard.tsx", import.meta.url), "utf8");
  // Today's performance props come from the one shared owner-scoped read of
  // the real performance read model (loaded by getOperatingData alongside the
  // coordinator's own consumption of it) — never a second, disagreeing source.
  assert.match(operatingData, /loadPerformanceReport/, "the shared operating read loads the real performance report");
  assert.match(today, /await data\.performance/, "Today awaits the shared report");
  assert.match(today, /performance=\{performance\}/);
  assert.match(dashboard, /report\.headline/, "Today V2 only presents a performance claim backed by the real report");
  assert.doesNotMatch(dashboard, /fake|sample chart|12\.4K/i);

  const page = await readFile(new URL("../app/app/(shell)/performance/page.tsx", import.meta.url), "utf8");
  assert.match(page, /loadPerformanceReport/);
  assert.match(page, /createClient/, "the page reads through the session client, so RLS is the isolation boundary");
  for (const section of ["Best-performing recent content", "Recent published content", "What is working", "Performance intelligence"]) {
    assert.match(page, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // Comments may explain that no score exists; rendered code must never show one.
  assert.doesNotMatch(page.replace(/\/\*[\s\S]*?\*\//g, " "), /score/i, "the page never presents a performance score");
});

test("the migration is additive, owner-scoped and truth-constrained", async () => {
  const sql = await readFile(new URL("../supabase/migrations/0032_instagram_performance_intelligence.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.instagram_performance_snapshots/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /instagram_performance_snapshots_select_own/);
  assert.match(sql, /auth\.uid\(\)\) = owner_user_id/);
  assert.match(sql, /instagram_media_id text not null/);
  assert.match(sql, /published_at timestamptz not null/);
  assert.match(sql, /collected_at timestamptz not null/);
  assert.match(sql, /unique \(owner_user_id, instagram_media_id, collected_at\)/);
  assert.match(sql, /jsonb_path_exists\(metrics/, "stored metrics must be non-negative numbers at the schema level");
  assert.match(sql, /PREPARED FOR REVIEW/);
  // Additive only: no existing table is altered or dropped. Comments (including
  // the documented rollback) are not executable SQL, so they are stripped
  // before the destructive-statement check.
  const executable = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(executable, /alter table public\.(instagram_publish_queue|mara_drafts|content_calendar_items|businesses)[\s\S]*?;/i);
  assert.doesNotMatch(executable, /\bdrop table\b/i, "the migration must not drop anything");
  assert.ok(/rollback/i.test(sql), "the rollback procedure is documented");
  // Existing metrics are the sync's own table, never the pre-existing account blob.
  assert.doesNotMatch(executable, /instagram_insight_snapshots/);
});
