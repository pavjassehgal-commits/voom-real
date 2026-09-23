/**
 * Marketing Plan lifecycle + Replenish feedback — acceptance tests.
 *
 * The Marketing Plan is a ROLLING next-7-days horizon (today → today + 6 in the
 * account timezone), never a Monday–Sunday week. Every Replenish must end in
 * one explicit, server-reported outcome — added / already up to date / no
 * supported social channels / genuine failure — and the primary view must
 * follow the live window without deleting any record.
 *
 * What runs for real: the `POST /api/plan` and `GET /api/plan` route handlers,
 * `runOwnerWorkflow` (lib/voom/workflow/service.ts), the rolling engine and
 * its coverage evaluator, the shared read model, and the pure lifecycle module.
 * Only the session lookup and the admin client factory are replaced (test
 * resolve hooks below), the clock is mocked with node:test timers, and MARA's
 * structured-output provider is a local fake behind the existing `local`
 * provider fetch seam. No production access, no provider credentials, no paid
 * media, no publishing and no real content generation happen anywhere.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/voom/server-data") {
      return {
        url: `data:text/javascript,${encodeURIComponent("export async function getCurrentUser() { return globalThis.__VOOM_LIFECYCLE_USER__ ?? null; }")}`,
        shortCircuit: true,
      };
    }
    if (specifier === "@/utils/supabase/admin") {
      return {
        url: `data:text/javascript,${encodeURIComponent("export function createAdminClient() { return globalThis.__VOOM_LIFECYCLE_ADMIN__; }")}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const route = await import("../app/api/plan/route.ts");
const lifecycle = await import("../lib/voom/workflow/plan-lifecycle.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const channels = await import("../lib/social/channels.ts");
const channelPlanner = await import("../lib/voom/workflow/channel-planner.ts");
const coordinator = await import("../lib/coordinator/service.ts");
const tz = await import("../lib/voom/timezone.ts");

const OWNER = "owner-plan-lifecycle";
const BUSINESS = "business-plan-lifecycle";
const TZ = "Asia/Dubai";
/** Saturday 2026-09-12, 09:00 in Dubai. */
const DAY_1 = new Date("2026-09-12T05:00:00.000Z");
/** The next local day, same wall-clock time. */
const DAY_2 = new Date("2026-09-13T05:00:00.000Z");
const HORIZON_1 = ["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];

// ---------------------------------------------------------------------------
// Harness: an in-memory Supabase-shaped admin client, the real route handlers
// and a local MARA content fake behind the existing provider fetch seam.
// ---------------------------------------------------------------------------

function createMemoryAdmin(seed) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const writes = [];
  const failures = { draftInsert: null, planItemsSave: false };
  let sequence = 0;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.ordering = [];
      this.limitCount = null;
      this.insertRows = null;
      this.upsertOptions = null;
      this.patch = null;
      this.deleting = false;
      this.head = false;
    }
    select(_columns, options = {}) { this.head = options.head === true; return this; }
    insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, options = {}) { this.insertRows = Array.isArray(rows) ? rows : [rows]; this.upsertOptions = options; return this; }
    update(patch) { this.patch = patch; return this; }
    delete() { this.deleting = true; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
    in(column, values) {
      const selected = new Set((values ?? []).map(String));
      this.filters.push((row) => selected.has(String(row[column])));
      return this;
    }
    gte(column, value) { this.filters.push((row) => String(row[column] ?? "") >= String(value)); return this; }
    lte(column, value) { this.filters.push((row) => String(row[column] ?? "") <= String(value)); return this; }
    not(column, operator, value) {
      this.filters.push((row) => (operator === "is" && value === null ? row[column] !== null && row[column] !== undefined : row[column] !== value));
      return this;
    }
    contains(column, value) {
      this.filters.push((row) => {
        const actual = row[column];
        if (Array.isArray(actual)) return Array.isArray(value) ? value.every((entry) => actual.includes(entry)) : actual.includes(value);
        if (actual && value && typeof actual === "object" && typeof value === "object") {
          return Object.entries(value).every(([key, expected]) => actual[key] === expected);
        }
        return false;
      });
      return this;
    }
    order(column, options = {}) { this.ordering.push({ column, ascending: options.ascending !== false }); return this; }
    limit(count) { this.limitCount = count; return this; }
    _table() {
      if (!tables.has(this.table)) tables.set(this.table, []);
      return tables.get(this.table);
    }
    _selected() {
      let rows = this._table().filter((row) => this.filters.every((filter) => filter(row)));
      for (const { column, ascending } of this.ordering) {
        rows = [...rows].sort((a, b) => {
          const left = String(a[column] ?? "");
          const right = String(b[column] ?? "");
          return (left === right ? 0 : left < right ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      return rows;
    }
    _execute() {
      const table = this._table();
      const nowIso = new Date().toISOString();
      if (this.insertRows) {
        if (this.table === "mara_drafts" && failures.draftInsert?.(this.insertRows[0])) {
          return { data: null, error: { code: "XX000", message: "simulated storage failure" }, count: 0 };
        }
        const output = [];
        for (const incoming of this.insertRows) {
          const row = { id: `${this.table}-${++sequence}`, created_at: nowIso, updated_at: nowIso, ...incoming };
          if (this.upsertOptions?.onConflict) {
            const keys = this.upsertOptions.onConflict.split(",").map((key) => key.trim());
            const existing = table.find((candidate) => keys.every((key) => candidate[key] === row[key]));
            if (existing) {
              if (this.upsertOptions.ignoreDuplicates) continue;
              Object.assign(existing, incoming, { updated_at: nowIso });
              output.push(existing);
              continue;
            }
          }
          table.push(row);
          output.push(row);
        }
        writes.push({ table: this.table, operation: this.upsertOptions ? "upsert" : "insert", count: output.length });
        return { data: output, error: null, count: output.length };
      }
      if (this.patch) {
        if (this.table === "marketing_plans" && failures.planItemsSave && "planned_posts" in this.patch) {
          return { data: null, error: { code: "XX000", message: "simulated plan save failure" }, count: 0 };
        }
        const rows = this._selected();
        for (const row of rows) Object.assign(row, this.patch, { updated_at: nowIso });
        writes.push({ table: this.table, operation: "update", count: rows.length, patch: Object.keys(this.patch) });
        return { data: rows, error: null, count: rows.length };
      }
      if (this.deleting) {
        const rows = this._selected();
        for (const row of rows) table.splice(table.indexOf(row), 1);
        writes.push({ table: this.table, operation: "delete", count: rows.length });
        return { data: rows, error: null, count: rows.length };
      }
      const rows = this._selected();
      return { data: this.head ? null : rows, error: null, count: rows.length };
    }
    then(resolve, reject) { return Promise.resolve(this._execute()).then(resolve, reject); }
    async maybeSingle() {
      const result = this._execute();
      return { data: result.data?.[0] ?? null, error: result.error };
    }
    async single() {
      const result = this._execute();
      if (result.error) return { data: null, error: result.error };
      if (!result.data?.[0]) return { data: null, error: { code: "PGRST116", message: "No row returned" } };
      return { data: result.data[0], error: null };
    }
  }

  return {
    tables,
    writes,
    failures,
    from: (table) => new Query(table),
    async rpc() { return { data: null, error: { message: "RPC not configured in this test" } }; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
}

function seedTables({ preferredChannels, cadence = "daily", mode = "assisted", drafts = [], plans = [] }) {
  return {
    businesses: [{
      id: BUSINESS,
      owner_user_id: OWNER,
      brand_name: "Lifecycle Studio",
      brand_description: "A small, practical business.",
      industry: "Services",
      target_customer: ["Local teams"],
      main_goal: "Grow useful awareness",
      brand_personality: ["Clear"],
      preferred_channels: preferredChannels,
      content_frequency: cadence,
      automation_level: mode,
      timezone: TZ,
      plan: "pro",
      allow_automatic_paid_media: false,
      onboarding_completed: true,
    }],
    marketing_plans: plans,
    mara_drafts: drafts,
    mara_conversations: [],
    mara_pending_actions: [],
    mara_media_generations: [],
    mara_tool_runs: [],
    post_draft_assets: [],
    instagram_publish_queue: [],
    tiktok_publish_queue: [],
    youtube_publish_queue: [],
    content_calendar_items: [],
    instagram_performance_snapshots: [],
    voom_campaigns: [],
    voom_campaign_actions: [],
    campaign_sends: [],
    contacts: [],
    voom_email_flows: [],
    voom_credit_ledger: [],
    voom_coordinator_runs: [],
  };
}

/**
 * MARA's structured-output provider, faked behind the real `local` provider
 * fetch seam. Returns valid native content for whatever slot the SERVER
 * assigned; `failWhen(payload)` turns a request into a provider failure.
 */
function installLocalMara({ failWhen = () => false } = {}) {
  const saved = { provider: process.env.AI_PROVIDER, base: process.env.AI_BASE_URL, model: process.env.AI_MODEL };
  process.env.AI_PROVIDER = "local";
  process.env.AI_BASE_URL = "http://mara.test.invalid/v1";
  process.env.AI_MODEL = "lifecycle-test";
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.endsWith("/chat/completions")) throw new Error(`Unexpected outbound test request: ${href}`);
    const request = JSON.parse(String(init.body ?? "{}"));
    const payload = JSON.parse(request.messages.find((message) => message.role === "user")?.content ?? "{}");
    requests.push(payload);
    if (failWhen(payload)) return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    const slot = payload.assignedSocialSlot;
    const content = {
      concept: `${slot.label} for ${payload.scheduledFor?.date}`,
      hook: "A clear, native opening hook.",
      caption: `A useful ${slot.label} caption.`,
      cta: "Learn more.",
      hashtags: ["local"],
      description: slot.channel === "youtube" ? "A useful YouTube description with real context." : "",
      script: slot.channel === "instagram" && slot.format === "post"
        ? []
        : ["Open with the idea", "Explain one useful detail", "Show the payoff", "Close with a next step"],
      visualBrief: `Production direction for ${slot.label}.`,
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
      for (const [key, value] of [["AI_PROVIDER", saved.provider], ["AI_BASE_URL", saved.base], ["AI_MODEL", saved.model]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** Wires the REAL route handlers to this test's owner, admin client and clock. */
function harness(t, seed, { now = DAY_1, mara = {} } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const admin = createMemoryAdmin(seed);
  globalThis.__VOOM_LIFECYCLE_ADMIN__ = admin;
  globalThis.__VOOM_LIFECYCLE_USER__ = { id: OWNER, email: "owner@example.test" };
  const network = installLocalMara(mara);
  t.after(() => {
    network.restore();
    delete globalThis.__VOOM_LIFECYCLE_ADMIN__;
    delete globalThis.__VOOM_LIFECYCLE_USER__;
  });
  return {
    admin,
    network,
    setNow(instant) { t.mock.timers.setTime(instant.getTime()); },
    async replenish(body = {}) {
      const response = await route.POST(new Request("http://voom.test/api/plan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() };
    },
    async read() {
      const response = await route.GET();
      return { status: response.status, body: await response.json() };
    },
  };
}

const planDrafts = (admin) => admin.tables.get("mara_drafts").filter((draft) => draft.source_plan_id);
const localDateOf = (draft) => tz.isoToLocalDate(draft.proposed_publish_at, TZ);
const deletes = (admin) => admin.writes.filter((write) => write.operation === "delete");

// ---------------------------------------------------------------------------
// 1. A complete horizon: 0 new items, "already up to date".
// ---------------------------------------------------------------------------

test("1. a complete rolling horizon adds 0 items and reports up to date with the exact copy", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram"] }));
  const first = await h.replenish();
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome.status, "added");
  assert.equal(first.body.snapshot.coverage.status, "complete", "the GET/POST read model reports a covered horizon");
  const draftsBefore = JSON.stringify(h.admin.tables.get("mara_drafts"));
  const generatedBefore = h.network.requests.length;

  const second = await h.replenish();
  assert.equal(second.status, 200);
  assert.equal(second.body.outcome.status, "up_to_date");
  assert.equal(second.body.outcome.added, 0);
  assert.deepEqual(second.body.outcome.addedItems, []);
  assert.equal(second.body.outcome.coveredThrough, "2026-09-18", "the rolling window's last local day, never a Sunday week end");
  assert.equal(second.body.run.created, 0);
  assert.equal(h.network.requests.length, generatedBefore, "no MARA generation ran for a complete horizon");
  assert.equal(JSON.stringify(h.admin.tables.get("mara_drafts")), draftsBefore, "no draft was created or rewritten");

  const feedback = lifecycle.planOutcomeFeedback(second.body.outcome);
  assert.equal(feedback.title, "Your marketing plan is already up to date");
  assert.equal(feedback.body, "You have complete marketing coverage through 18 September 2026. Voom will add more content when it's needed.");
  assert.equal(feedback.summary, null);
  assert.equal(lifecycle.planIsUpToDate(second.body.snapshot), true, "the button can say ✓ Plan up to date");
  assert.equal(lifecycle.PLAN_UP_TO_DATE_LABEL, "✓ Plan up to date");
});

// ---------------------------------------------------------------------------
// 2. Uncovered slots: exactly that many are added, and reported.
// ---------------------------------------------------------------------------

test("2. uncovered slots add exactly that many recommendations and the response says so", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram"] }));
  await h.replenish();
  // Three unexecuted slots disappear from the plan (e.g. detached earlier).
  const removed = planDrafts(h.admin).filter((draft) => ["2026-09-13", "2026-09-15", "2026-09-17"].includes(localDateOf(draft)));
  assert.equal(removed.length, 3);
  for (const draft of removed) Object.assign(draft, { source_plan_id: null, source_plan_item_key: null });

  const before = await h.read();
  assert.equal(before.body.snapshot.coverage.status, "incomplete");
  assert.equal(before.body.snapshot.coverage.uncovered, 3);
  assert.deepEqual(before.body.snapshot.coverage.uncoveredDates, ["2026-09-13", "2026-09-15", "2026-09-17"]);
  assert.equal(lifecycle.planIsUpToDate(before.body.snapshot), false, "the button offers Replenish again");

  const result = await h.replenish();
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome.status, "added");
  assert.equal(result.body.outcome.added, 3);
  assert.equal(result.body.run.created, 3);
  assert.equal(result.body.run.reused, 4);
  assert.deepEqual(result.body.outcome.addedItems.map((item) => item.date), ["2026-09-13", "2026-09-15", "2026-09-17"]);
  assert.equal(planDrafts(h.admin).length, 7);
  assert.equal(result.body.snapshot.coverage.status, "complete");

  const feedback = lifecycle.planOutcomeFeedback(result.body.outcome);
  assert.equal(feedback.title, "Your plan is ready ✓");
  assert.equal(feedback.body, "Added 3 recommendations for the next 7 days.");
  assert.equal(
    lifecycle.planOutcomeFeedback({ ...result.body.outcome, added: 1, addedItems: result.body.outcome.addedItems.slice(0, 1) }).body,
    "Added 1 recommendation for the next 7 days.",
  );
});

// ---------------------------------------------------------------------------
// 3. The response reports the real native channels and formats added.
// ---------------------------------------------------------------------------

test("3. the response reports the real native channel/format of every added recommendation", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram", "TikTok", "YouTube"] }));
  const result = await h.replenish();
  assert.equal(result.status, 200);
  const { outcome } = result.body;
  assert.equal(outcome.status, "added");
  assert.equal(outcome.added, 7);
  assert.equal(outcome.addedItems.length, 7);

  // Every reported item is exactly the persisted draft for that date.
  const persisted = new Map(planDrafts(h.admin).map((draft) => [localDateOf(draft), draft]));
  for (const item of outcome.addedItems) {
    const draft = persisted.get(item.date);
    assert.ok(draft, `a draft exists for ${item.date}`);
    assert.equal(item.channel, draft.social_channel);
    assert.equal(item.format, draft.social_format);
    assert.ok(channels.isValidChannelFormat(item.channel, item.format));
    assert.equal(item.label, channelPlanner.socialFormatLabel(item.channel, item.format));
  }
  // Grouped summary: counts add up, labels are native, product order.
  assert.equal(outcome.addedFormats.reduce((sum, group) => sum + group.count, 0), 7);
  const summary = lifecycle.planOutcomeFeedback(outcome).summary;
  const expected = outcome.addedFormats.map((group) => (group.count > 1 ? `${group.label} ×${group.count}` : group.label)).join(" · ");
  assert.equal(summary, expected);
  assert.match(summary, /Instagram (Post|Reel|Story)/);
  assert.match(summary, /TikTok Video/);
  assert.match(summary, /YouTube (Short|Video)/);
  assert.ok(outcome.addedFormats.findIndex((group) => group.channel === "tiktok") > outcome.addedFormats.findIndex((group) => group.channel === "instagram"));
  assert.ok(outcome.addedFormats.findIndex((group) => group.channel === "youtube") > outcome.addedFormats.findIndex((group) => group.channel === "tiktok"));
});

// ---------------------------------------------------------------------------
// 4. Repeated Replenish creates no duplicates.
// ---------------------------------------------------------------------------

test("4. repeated Replenish clicks create zero duplicate recommendations", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["TikTok", "YouTube"] }));
  const first = await h.replenish();
  assert.equal(first.body.outcome.added, 7);
  const generated = h.network.requests.length;

  // Two concurrent clicks and a third sequential one.
  const [a, b] = await Promise.all([h.replenish(), h.replenish()]);
  const c = await h.replenish();
  for (const response of [a, b, c]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome.status, "up_to_date");
    assert.equal(response.body.outcome.added, 0);
  }
  const drafts = planDrafts(h.admin);
  assert.equal(drafts.length, 7, "still exactly one recommendation per slot");
  assert.equal(new Set(drafts.map((draft) => draft.source_plan_item_key)).size, 7, "no slot identity repeats");
  assert.equal(new Set(drafts.map(localDateOf)).size, 7, "no date is doubled");
  assert.equal(h.network.requests.length, generated, "no content was generated again");
  assert.equal(h.admin.tables.get("marketing_plans").length, 1, "one active plan, reused");
});

// ---------------------------------------------------------------------------
// 5. When the window advances, newly uncovered dates become replenishable.
// ---------------------------------------------------------------------------

test("5. the rolling window advances daily: the new date becomes replenishable, then up to date again", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram"] }));
  await h.replenish();
  assert.equal((await h.replenish()).body.outcome.status, "up_to_date");

  h.setNow(DAY_2);
  const rolled = await h.read();
  assert.equal(rolled.body.snapshot.today, "2026-09-13");
  assert.equal(rolled.body.snapshot.coverage.horizonStart, "2026-09-13");
  assert.equal(rolled.body.snapshot.coverage.horizonEnd, "2026-09-19");
  assert.equal(rolled.body.snapshot.coverage.status, "incomplete", "the button is no longer ✓ Plan up to date");
  assert.deepEqual(rolled.body.snapshot.coverage.uncoveredDates, ["2026-09-19"]);
  assert.equal(lifecycle.planIsUpToDate(rolled.body.snapshot), false);

  const refill = await h.replenish();
  assert.equal(refill.status, 200);
  assert.equal(refill.body.outcome.status, "added");
  assert.equal(refill.body.outcome.added, 1);
  assert.deepEqual(refill.body.outcome.addedItems.map((item) => item.date), ["2026-09-19"]);
  assert.equal(refill.body.outcome.coveredThrough, "2026-09-19");
  assert.equal(refill.body.snapshot.coverage.status, "complete");

  const again = await h.replenish();
  assert.equal(again.body.outcome.status, "up_to_date");
  assert.equal(lifecycle.planOutcomeFeedback(again.body.outcome).body,
    "You have complete marketing coverage through 19 September 2026. Voom will add more content when it's needed.");
});

test("5b. coverage follows the engine exactly for every cadence and channel mix, before and after the window rolls", () => {
  const ports = () => {
    const drafts = new Map();
    let next = 0;
    return {
      drafts,
      ports: {
        async ensurePlan() { return "plan-1"; },
        async getActivePlan() { return "plan-1"; },
        async listItems() { return [...drafts.values()].filter((draft) => draft.planId === "plan-1"); },
        async detachDrafts(_plan, ids) { for (const id of ids) { const draft = drafts.get(id); if (draft?.status === "draft") draft.planId = null; } },
        async generateContent(slot) { return { concept: slot.slotKey, hook: "", caption: "c", cta: "", hashtags: [], description: "", script: [], visualBrief: "v" }; },
        async createDraft({ slot, content }) {
          const draft = { draftId: `d-${++next}`, planId: "plan-1", slotKey: slot.slotKey, channel: slot.channel, format: slot.format, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" };
          drafts.set(draft.draftId, draft);
          return draft;
        },
        async ensureMedia() { return { ok: true }; },
        async requestApproval() {},
        async autoApproveAndSchedule() { return { approved: false }; },
        async savePlanItems() {},
      },
    };
  };
  return (async () => {
    for (const cadence of ["daily", "5x_week", "3x_week", "weekly"]) {
      for (const selectedChannels of [["instagram"], ["tiktok", "youtube"], ["instagram", "tiktok", "youtube"]]) {
        const store = ports();
        let existing = [];
        for (const now of [DAY_1, DAY_2, new Date("2026-09-15T05:00:00.000Z")]) {
          const input = { now, timeZone: TZ, cadence, mode: "assisted", goal: "awareness", selectedChannels, trigger: "replenish" };
          const predicted = rolling.evaluatePlanCoverage({ ...input, existing });
          const run = await rolling.ensureRollingPlan(store.ports, input);
          assert.equal(run.created, predicted.uncovered, `${cadence}/${selectedChannels}: coverage predicts exactly what Replenish creates`);
          assert.deepEqual(run.plan.items.filter((item) => item.created).map((item) => item.slot).sort(), [...predicted.uncoveredDates].sort());
          existing = await store.ports.listItems();
          assert.equal(rolling.evaluatePlanCoverage({ ...input, existing }).status, "complete");
        }
      }
    }
  })();
});

test("5c. read-model coverage honours the engine's protection rule, so ✓ never lies after a channel change", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram", "TikTok"] }));
  await h.replenish();
  const tiktok = planDrafts(h.admin).filter((draft) => draft.social_channel === "tiktok");
  assert.ok(tiktok.length >= 2);
  const [queued, approvalOpen, ...unexecuted] = tiktok;
  // Execution facts on two TikTok drafts: a live provider queue row, and an
  // open approval card keyed by new_value (as getOperatingData reads it).
  h.admin.tables.get("tiktok_publish_queue").push({ owner_user_id: OWNER, draft_id: queued.id, status: "scheduled", failure_message: null });
  h.admin.tables.get("mara_pending_actions").push({
    id: "approval-open", owner_user_id: OWNER, tool_name: "propose_calendar_item", status: "pending",
    sanitized_arguments: {}, new_value: { sourceDraftId: approvalOpen.id },
  });
  h.admin.tables.get("businesses")[0].preferred_channels = ["Instagram"];

  const { body } = await h.read();
  // Protected TikTok work still covers its dates; unexecuted TikTok work does not.
  assert.equal(body.snapshot.coverage.status, "incomplete");
  assert.deepEqual([...body.snapshot.coverage.uncoveredDates].sort(), unexecuted.map(localDateOf).sort());
  const result = await h.replenish();
  assert.equal(result.body.outcome.status, "added");
  assert.equal(result.body.outcome.added, unexecuted.length, "the server's prediction matched what Replenish created");
  assert.equal(queued.source_plan_id, result.body.run.planId, "queued work keeps its place");
  assert.equal(approvalOpen.source_plan_id, result.body.run.planId, "work awaiting approval keeps its place");
  assert.equal(result.body.snapshot.coverage.status, "complete");
});

test("5d. with no schedulable slot left, the plan never claims complete coverage", async (t) => {
  // 23:40 in Dubai on a weekly cadence: today's only slot has no valid time.
  const h = harness(t, seedTables({ preferredChannels: ["Instagram"], cadence: "weekly" }), { now: new Date("2026-09-12T19:40:00.000Z") });
  const { body } = await h.read();
  assert.equal(body.snapshot.coverage.slots, 0);
  assert.equal(lifecycle.planIsUpToDate(body.snapshot), false, "no ✓ Plan up to date without a covered slot");
  const result = await h.replenish();
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome.status, "up_to_date");
  assert.equal(result.body.outcome.added, 0);
  assert.equal(result.body.outcome.coveredThrough, null, "no coverage date is invented");
  assert.equal(lifecycle.planOutcomeFeedback(result.body.outcome).body, "Nothing more can be scheduled right now. Voom will add more content when it's needed.");
});

// ---------------------------------------------------------------------------
// 6. Out-of-window cards leave the primary view; no record is deleted.
// ---------------------------------------------------------------------------

test("6. old cards leave the primary view as the window rolls — every record stays in the database", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram"] }));
  await h.replenish();
  const draftsBefore = h.admin.tables.get("mara_drafts").map((draft) => ({ ...draft }));
  const planPostsBefore = h.admin.tables.get("marketing_plans")[0].planned_posts.length;

  // A week later the whole original horizon is in the past. Two historic
  // items progressed: one was published, one missed its time.
  const sep12 = draftsBefore.find((draft) => localDateOf(draft) === "2026-09-12");
  const sep14 = draftsBefore.find((draft) => localDateOf(draft) === "2026-09-14");
  for (const draft of h.admin.tables.get("mara_drafts")) {
    if (draft.id === sep12.id || draft.id === sep14.id) draft.status = "approved";
  }
  h.admin.tables.get("instagram_publish_queue").push(
    { owner_user_id: OWNER, draft_id: sep12.id, status: "published", instagram_media_id: "ig-1", failure_message: null },
    { owner_user_id: OWNER, draft_id: sep14.id, status: "scheduled", instagram_media_id: null, failure_message: null },
  );
  h.setNow(new Date("2026-09-19T05:00:00.000Z"));

  const { body } = await h.read();
  const view = lifecycle.planWorkspaceView(body.snapshot);
  assert.equal(view.start, "2026-09-19");
  assert.equal(view.end, "2026-09-25");
  assert.equal(view.current.length, 0, "no past recommendation clutters the live window");
  assert.deepEqual(view.outside.map((item) => item.draftId), [sep14.id], "missed work that still needs the owner stays reachable");
  assert.equal(view.outside[0].status, "missed");
  assert.ok(!view.outside.some((item) => item.status === "published"), "finished history lives in Calendar/Performance, not the plan");
  assert.ok(body.snapshot.items.some((item) => item.draftId === sep12.id && item.status === "published"), "Calendar/Today still read published history");
  assert.equal(body.snapshot.coverage.status, "incomplete", "the rolled window is open for Replenish");

  // Nothing was deleted, detached or rewritten by rolling or reading.
  assert.deepEqual(deletes(h.admin), []);
  assert.equal(h.admin.tables.get("mara_drafts").length, draftsBefore.length);
  for (const before of draftsBefore) {
    const after = h.admin.tables.get("mara_drafts").find((draft) => draft.id === before.id);
    assert.equal(after.source_plan_id, before.source_plan_id);
    assert.equal(after.source_plan_item_key, before.source_plan_item_key);
    assert.equal(after.title, before.title);
  }

  // Replenishing the new window adds the new week and still deletes nothing.
  const refill = await h.replenish();
  assert.equal(refill.body.outcome.status, "added");
  assert.equal(refill.body.outcome.added, 7);
  assert.deepEqual(deletes(h.admin), []);
  assert.equal(h.admin.tables.get("mara_drafts").length, draftsBefore.length + 7);
  for (const before of draftsBefore) {
    const after = h.admin.tables.get("mara_drafts").find((draft) => draft.id === before.id);
    assert.equal(after.source_plan_id, before.source_plan_id, "historical recommendations keep their plan link for audit");
    assert.equal(after.status, before.id === sep12.id || before.id === sep14.id ? "approved" : "draft");
  }
  assert.equal(h.admin.tables.get("instagram_publish_queue").find((row) => row.draft_id === sep14.id).status, "scheduled", "scheduled work is untouched");
  assert.equal(h.admin.tables.get("instagram_publish_queue").find((row) => row.draft_id === sep12.id).status, "published", "published work is untouched");
  assert.ok(planPostsBefore > 0);
  const refilledView = lifecycle.planWorkspaceView(refill.body.snapshot);
  assert.deepEqual([...new Set(refilledView.current.map((item) => item.localDate))], [
    "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
  ]);
});

// ---------------------------------------------------------------------------
// 7. No selected supported social channels: the channel-selection state.
// ---------------------------------------------------------------------------

test("7. no selected supported social channel returns the channel-selection state — never an Instagram fallback", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Email", "Threads"] }));
  const result = await h.replenish();
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome.status, "no_channels");
  assert.equal(result.body.outcome.added, 0);
  assert.equal(result.body.outcome.coveredThrough, null);
  assert.equal(result.body.run.blockedReason, "no_supported_social_channels_selected");
  assert.equal(result.body.snapshot.coverage.status, "no_channels");
  assert.equal(lifecycle.planIsUpToDate(result.body.snapshot), false, "the button never claims up to date without channels");
  assert.equal(h.admin.tables.get("mara_drafts").length, 0, "nothing was invented");
  assert.equal(h.network.requests.length, 0, "MARA was not asked for anything");

  const feedback = lifecycle.planOutcomeFeedback(result.body.outcome);
  assert.equal(feedback.title, "Choose your marketing channels");
  assert.equal(feedback.body, "Select at least one social channel before building your Marketing Plan.");
});

// ---------------------------------------------------------------------------
// 8. A genuine failure: failure feedback, never a false success.
// ---------------------------------------------------------------------------

test("8a. a failed run reports failure and verifies the existing plan is unchanged", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram"] }));
  await h.replenish();
  const before = JSON.stringify(h.admin.tables.get("mara_drafts"));
  h.admin.failures.planItemsSave = true;
  h.setNow(DAY_2);

  const result = await h.replenish();
  assert.equal(result.status, 503);
  assert.equal(result.body.outcome.status, "failed");
  assert.equal(result.body.run, undefined, "no run summary is presented as a result");
  assert.equal(result.body.outcome.coveredThrough, null);
  const feedback = lifecycle.planOutcomeFeedback(result.body.outcome);
  assert.equal(feedback.title, "We couldn't replenish your plan");
  // The day-2 run created the Sep 19 draft before the save failed, so the plan
  // is NOT unchanged — and the copy must not pretend it is.
  assert.equal(result.body.outcome.planUnchanged, false);
  assert.equal(result.body.outcome.added, 1);
  assert.notEqual(feedback.body, "Your existing plan hasn't been changed. Try again.");
  assert.match(feedback.body, /saved 1 new recommendation before something went wrong/);
  assert.notEqual(JSON.stringify(h.admin.tables.get("mara_drafts")), before);

  // A failure before anything is persisted: the plan is verified unchanged.
  const untouched = JSON.stringify(h.admin.tables.get("mara_drafts"));
  h.admin.failures.draftInsert = () => true;
  h.admin.failures.planItemsSave = false;
  h.setNow(new Date("2026-09-14T05:00:00.000Z"));
  const failed = await h.replenish();
  assert.equal(failed.status, 503);
  assert.equal(failed.body.outcome.status, "failed");
  assert.equal(failed.body.outcome.planUnchanged, true);
  assert.equal(failed.body.outcome.added, 0);
  assert.equal(lifecycle.planOutcomeFeedback(failed.body.outcome).body, "Your existing plan hasn't been changed. Try again.");
  assert.equal(JSON.stringify(h.admin.tables.get("mara_drafts")), untouched);
  const decision = lifecycle.replenishResponseFeedback(false, failed.body);
  assert.equal(decision.feedback.tone, "error");
  assert.equal(decision.feedback.title, "We couldn't replenish your plan");
});

test("8b. partial persistence is a failure, not a success, and says what was saved", async (t) => {
  // TikTok generation fails; Instagram and YouTube succeed.
  const h = harness(t, seedTables({ preferredChannels: ["Instagram", "TikTok", "YouTube"] }), {
    mara: { failWhen: (payload) => payload.assignedSocialSlot?.channel === "tiktok" },
  });
  const result = await h.replenish();
  assert.equal(result.status, 503, "a partially filled horizon is never a 200");
  assert.equal(result.body.outcome.status, "failed");
  assert.ok(result.body.outcome.unfilled > 0);
  const saved = planDrafts(h.admin).length;
  assert.ok(saved > 0 && saved < 7);
  assert.equal(result.body.outcome.added, saved, "the count comes from the re-read plan");
  assert.equal(result.body.outcome.planUnchanged, false);
  const feedback = lifecycle.planOutcomeFeedback(result.body.outcome);
  assert.equal(feedback.title, "We couldn't replenish your plan");
  assert.notEqual(feedback.title, "Your plan is ready ✓");
  assert.doesNotMatch(feedback.body, /hasn't been changed/);
  assert.match(feedback.body, new RegExp(`saved ${saved} new recommendations`));
  assert.ok(result.body.snapshot, "the view is refreshed to the plan as it really stands");
  assert.equal(lifecycle.replenishResponseFeedback(false, result.body).feedback.tone, "error");
});

test("8c. media-spend refusals are not failures; the client never infers success", () => {
  const run = {
    planId: "plan-1", mode: "autopilot", trigger: "replenish", stage: "full", blockedReason: null,
    plan: {
      cadence: "daily", timeZone: TZ, horizonDays: 7, validFrom: "2026-09-12", validUntil: "2026-09-18",
      items: [{ slot: "2026-09-12", slotKey: "2026-09-12|instagram_post", publishAt: "2026-09-12T14:30:00.000Z", localDate: "2026-09-12", localTime: "6:30 PM", channel: "instagram", format: "post", contentType: "post", draftId: "d-1", created: true }],
    },
    slots: 1, created: 1, reused: 0, mediaQueued: 0, awaitingApproval: 1, autoApproved: 0, heldForReview: 1,
    failures: [{ slot: "2026-09-12", stage: "media", code: "budget_exhausted" }, { slot: "2026-09-12", stage: "approval", code: "x" }],
  };
  assert.equal(lifecycle.planRunOutcome(run).status, "added", "a refused media spend leaves a real, added recommendation");
  assert.equal(lifecycle.planRunOutcome({ ...run, failures: [{ slot: "2026-09-12", stage: "content", code: "content_generation_failed" }] }).status, "failed");
  assert.equal(lifecycle.planRunOutcome({ ...run, plan: null, created: 0 }).status, "failed", "a run with no plan is never reported as up to date");

  // The client shows success ONLY for a 2xx whose server outcome says so.
  const added = lifecycle.planRunOutcome(run);
  assert.equal(lifecycle.replenishResponseFeedback(false, { outcome: added, error: "x" }).feedback, null, "a non-2xx can never show success");
  assert.equal(lifecycle.replenishResponseFeedback(false, { error: "Voom is already building your content. Give it a few minutes." }).error,
    "Voom is already building your content. Give it a few minutes.");
  assert.equal(lifecycle.replenishResponseFeedback(true, {}).feedback, null, "no outcome, no invented message");
  assert.equal(lifecycle.replenishResponseFeedback(true, { outcome: added }).feedback.title, "Your plan is ready ✓");
  // Verified-vs-unverified failure copy.
  assert.equal(lifecycle.failedPlanRunOutcome({ run: null, before: ["a"], after: ["a"] }).planUnchanged, true);
  assert.equal(lifecycle.failedPlanRunOutcome({ run: null, before: null, after: ["a"] }).planUnchanged, false, "an unreadable plan is never claimed unchanged");
  assert.equal(lifecycle.planOutcomeFeedback(lifecycle.failedPlanRunOutcome({ run: null, before: null, after: null })).body,
    "None of your existing recommendations were deleted. Try again.");
  assert.equal(lifecycle.failedPlanRunOutcome({ run: null, before: ["a", "b"], after: ["a"] }).planUnchanged, false, "a removed item is a change");
});

// ---------------------------------------------------------------------------
// 9. PR #65 multi-channel planning stays intact.
// ---------------------------------------------------------------------------

test("9. PR #65 Instagram/TikTok/YouTube planning stays intact through the new route contract", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["YouTube", "TikTok", "Instagram"] }));
  const result = await h.replenish();
  assert.equal(result.status, 200);
  const drafts = planDrafts(h.admin);
  assert.equal(drafts.length, 7);
  // One native item per date, deterministic balance, composite slot identity.
  assert.equal(new Set(drafts.map(localDateOf)).size, 7);
  const counts = ["instagram", "tiktok", "youtube"].map((channel) => drafts.filter((draft) => draft.social_channel === channel).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `balanced: ${counts}`);
  for (const draft of drafts) {
    const identity = channelPlanner.parseWorkflowSlotIdentity(draft.source_plan_item_key);
    assert.equal(identity.channel, draft.social_channel);
    assert.equal(identity.format, draft.social_format);
    assert.equal(identity.date, localDateOf(draft));
  }
  const expected = rolling.buildSlots({ now: DAY_1, timeZone: TZ, cadence: "daily", selectedChannels: ["instagram", "tiktok", "youtube"] });
  assert.deepEqual(drafts.map((draft) => draft.source_plan_item_key).sort(), expected.map((slot) => slot.slotKey).sort(), "the same deterministic assignment as the engine");
  // Planning while disconnected: no provider queue rows, no connection reads.
  assert.equal(h.admin.tables.get("tiktok_publish_queue").length, 0);
  assert.equal(h.admin.tables.get("youtube_publish_queue").length, 0);
  assert.equal(h.admin.tables.has("tiktok_connections"), false);
  assert.equal(h.admin.tables.has("youtube_connections"), false);
  // Native routing: TikTok/YouTube use social drafts, Instagram its own kinds.
  for (const draft of drafts) {
    if (draft.social_channel === "tiktok") assert.equal(draft.kind, "tiktok_video");
    if (draft.social_channel === "youtube") assert.equal(draft.kind, draft.social_format === "short" ? "youtube_short" : "youtube_video");
    if (draft.social_channel === "instagram") assert.ok(["instagram_post", "reel", "story"].includes(draft.kind));
  }
  // Selected-vs-connected + protected work: dropping TikTok detaches only
  // unexecuted TikTok drafts; approved TikTok work keeps its identity.
  const tiktok = drafts.filter((draft) => draft.social_channel === "tiktok");
  const protectedDraft = tiktok[0];
  protectedDraft.status = "approved";
  h.admin.tables.get("businesses")[0].preferred_channels = ["Instagram", "YouTube"];
  const changed = await h.replenish();
  assert.equal(changed.status, 200);
  assert.equal(changed.body.outcome.status, "added", "the freed dates were refilled on selected channels");
  assert.equal(changed.body.outcome.added, tiktok.length - 1);
  assert.ok(changed.body.outcome.addedItems.every((item) => item.channel !== "tiktok"), "no unselected channel is added");
  assert.equal(protectedDraft.source_plan_id, result.body.run.planId);
  assert.equal(protectedDraft.social_channel, "tiktok");
  for (const draft of tiktok.slice(1)) assert.equal(draft.source_plan_id, null, "unexecuted unselected work is detached, not deleted");
  assert.deepEqual(deletes(h.admin), []);
  assert.equal(changed.body.snapshot.coverage.status, "complete");
});

test("9b. coordinator gap filling still fills only uncovered dates and reports actual outcomes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: DAY_1 });
  const network = installLocalMara();
  t.after(network.restore);
  const commitment = {
    id: "standalone-tiktok", owner_user_id: OWNER, source_plan_id: null, source_plan_item_key: null,
    kind: "tiktok_video", social_channel: "tiktok", social_format: "video", channel: "TikTok · 9:16",
    title: "Existing TikTok commitment", content: "A standalone draft already covers this date.",
    proposed_publish_at: tz.localToUtcIso("2026-09-14", 18 * 60 + 30, TZ), status: "draft", created_at: DAY_1.toISOString(),
  };
  const admin = createMemoryAdmin(seedTables({ preferredChannels: ["TikTok", "YouTube"], cadence: "3x per week", drafts: [commitment] }));
  const result = await coordinator.runCoordinatorForOwner(admin, OWNER, BUSINESS, { now: DAY_1, trigger: "scheduled" });
  const action = result.actionsTaken.find((entry) => entry.type === "fill_calendar_gaps");
  assert.ok(action);
  assert.equal(action.details.gapsFilled, action.details.gapsRequested);
  assert.equal(action.details.gapsRemaining, 0);
  assert.equal(planDrafts(admin).length, action.details.gapsRequested);
  assert.equal(admin.tables.get("mara_drafts").find((draft) => draft.id === "standalone-tiktok").source_plan_id, null);
});

// ---------------------------------------------------------------------------
// Contract + wiring guards.
// ---------------------------------------------------------------------------

test("the API contract: GET carries server coverage, POST keeps its fields, auth and rate limit unchanged", async (t) => {
  const h = harness(t, seedTables({ preferredChannels: ["Instagram"] }));
  const empty = await h.read();
  assert.equal(empty.status, 200);
  assert.equal(empty.body.snapshot.coverage.status, "incomplete");
  assert.equal(empty.body.snapshot.coverage.uncovered, 7);
  assert.deepEqual(empty.body.snapshot.coverage.uncoveredDates, HORIZON_1);

  const result = await h.replenish();
  for (const key of ["run", "snapshot", "mediaSpendNotice", "outcome"]) assert.ok(key in result.body, `POST still returns ${key}`);
  assert.deepEqual(Object.keys(result.body.outcome).sort(),
    ["added", "addedFormats", "addedItems", "coveredThrough", "horizonDays", "status", "unfilled"].sort());
  assert.ok(lifecycle.PLAN_RUN_OUTCOME_STATUSES.includes(result.body.outcome.status));

  // 429 keeps its body and never runs the workflow.
  for (let index = 0; index < 30; index += 1) {
    h.admin.tables.get("mara_media_generations").push({ id: `g-${index}`, owner_user_id: OWNER, created_at: new Date().toISOString() });
  }
  const limited = await h.replenish();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "Voom is already building your content. Give it a few minutes.");
  assert.equal(limited.body.outcome, undefined);

  globalThis.__VOOM_LIFECYCLE_USER__ = null;
  assert.equal((await h.replenish()).status, 401);
  assert.equal((await h.read()).status, 401);
});

test("the Marketing Plan renders only server outcomes and derives the button from server coverage", async () => {
  const [workspace, routeSource] = await Promise.all([
    readFile(new URL("../components/voom/operating/PlanWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/plan/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /replenishResponseFeedback\(response\.ok, body\)/, "feedback comes from the server response");
  assert.match(workspace, /planIsUpToDate\(snapshot\)/, "the up-to-date label comes from server coverage");
  assert.match(workspace, /PLAN_UP_TO_DATE_LABEL/);
  assert.match(workspace, /planWorkspaceView\(snapshot\)/, "the primary view is the live rolling window");
  assert.doesNotMatch(workspace, /run\.created|body\.run|addedItems|\.created\b/, "the client never counts or lists additions itself");
  assert.doesNotMatch(workspace, /\bdelete\b|DELETE/, "the plan view never deletes");
  assert.match(routeSource, /planRunOutcome\(run\)/);
  assert.match(routeSource, /failedPlanRunOutcome\(/);
  assert.match(routeSource, /status: 503/);
});
