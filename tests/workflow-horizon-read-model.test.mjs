/**
 * Regression tests: the shared workflow read model must surface ONLY the
 * ACTIVE rolling horizon.
 *
 * Production finding (SynraPay): the active plan held 7 new date-keyed rolling
 * items (2026-09-12 … 2026-09-18) plus 3 legacy ordinal-slot rows
 * (`source_plan_item_key` "0"→Sep 8, "1"→Sep 10, "2"→Sep 12 3:00 PM). Every
 * operational screen (Marketing Plan / Today / Content Calendar / Approvals)
 * rendered all of them because the read model queried every draft on the
 * active plan without constraining to the current horizon or the new
 * date-based slot semantics.
 *
 * What is proven here, behaviourally, against the REAL
 * `lib/voom/workflow/read.ts` (driven through an in-memory owner-scoped
 * Supabase-shaped admin client — no network, no Supabase, no providers):
 *
 *   1. Active horizon Sep 12–18 + legacy ordinal rows Sep 8/Sep 10/Sep 12
 *      -> exactly the 7 current rolling items come back.
 *   2. Today on Sep 12 never surfaces Sep 8 or Sep 10 (no approval needs,
 *      no scheduled/generating/failed/published work from stale dates).
 *   3. Marketing Plan's payload is 7 current items, not 10.
 *   4. Content Calendar excludes stale legacy rows while keeping legitimate
 *      scheduled/published work.
 *   5. Valid date-keyed current-horizon rows stay visible regardless of
 *      `created_at` (the rule is workflow validity, never creation time).
 *   6. Loading the snapshot performs no writes: every legacy row is preserved
 *      untouched for history/debugging (the fake client has no write path at
 *      all, and rows are byte-compared before/after).
 *
 * No media is generated, nothing is approved, scheduled, queued or published.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const readModel = await import("../lib/voom/workflow/read.ts");
const tz = await import("../lib/voom/timezone.ts");

// A deterministic Dubai moment: Friday 2026-09-12, 09:00 local (= 05:00 UTC).
const NOW = new Date("2026-09-12T05:00:00.000Z");
const TZ = "Asia/Dubai";
const OWNER = "owner-synrapay";
const HORIZON = [
  "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15",
  "2026-09-16", "2026-09-17", "2026-09-18",
];
const EVENING = 18 * 60 + 30;
const at = (date, minutes = EVENING) => tz.localToUtcIso(date, minutes, TZ);

// ---------------------------------------------------------------------------
// In-memory, owner-scoped admin client shaped like the Supabase queries the
// read model issues. It is strictly READ-ONLY: any write attempt throws, which
// is itself part of the "no destructive migration / no row mutation" contract.
// ---------------------------------------------------------------------------

function createAdminClient(tables) {
  const writes = [];
  const refuse = (method) => () => {
    writes.push(method);
    throw new Error(`read model attempted a write: ${method}`);
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orderColumn = null;
      this.orderDirection = 1;
      this.limitCount = null;
    }
    select() { return this; }
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
    _execute() {
      let rows = [...(tables.get(this.table) ?? [])].filter((row) => this.filters.every((match) => match(row)));
      if (this.orderColumn) {
        rows.sort((a, b) => {
          if (a[this.orderColumn] < b[this.orderColumn]) return -this.orderDirection;
          if (a[this.orderColumn] > b[this.orderColumn]) return this.orderDirection;
          return 0;
        });
      }
      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      return rows;
    }
    async maybeSingle() {
      const rows = this._execute();
      return { data: rows[0] ?? null, error: null };
    }
    then(onFulfilled, onRejected) {
      return Promise.resolve({ data: this._execute(), error: null }).then(onFulfilled, onRejected);
    }
  }

  return {
    tables,
    writes,
    from: (table) => new Query(table),
    // Write traps: the shared read model must never mutate anything.
    insert: refuse("insert"),
    update: refuse("update"),
    upsert: refuse("upsert"),
    delete: refuse("delete"),
  };
}

// ---------------------------------------------------------------------------
// The production-shaped fixture.
// ---------------------------------------------------------------------------

function draftRow(overrides = {}) {
  return {
    id: "draft", owner_user_id: OWNER, source_plan_id: "plan-1", kind: "instagram_post",
    title: "A planned item", content: "Caption.", status: "draft",
    source_plan_item_key: "2026-09-12", proposed_publish_at: at("2026-09-12"),
    created_at: "2026-09-12T08:55:57Z",
    ...overrides,
  };
}

/** SynraPay today: 7 date-keyed rolling items + 3 legacy ordinal-slot rows. */
function synrapayDrafts() {
  return [
    ...HORIZON.map((date, index) => draftRow({
      id: `draft-${date}`,
      source_plan_item_key: date,
      proposed_publish_at: at(date),
      title: `SynraPay ${date}`,
      // One current item predates the fix by six weeks: it must stay visible.
      created_at: index === 0 ? "2026-08-01T06:00:00Z" : "2026-09-12T08:55:57Z",
    })),
    draftRow({ id: "legacy-0", source_plan_item_key: "0", proposed_publish_at: at("2026-09-08"), title: "Legacy Sep 8", created_at: "2026-09-08T06:00:00Z" }),
    draftRow({ id: "legacy-1", source_plan_item_key: "1", proposed_publish_at: at("2026-09-10"), title: "Legacy Sep 10", created_at: "2026-09-10T06:00:00Z" }),
    draftRow({ id: "legacy-2", source_plan_item_key: "2", proposed_publish_at: at("2026-09-12", 15 * 60), title: "Legacy Sep 12, 3:00 PM", created_at: "2026-09-12T06:00:00Z" }),
  ];
}

function seedDb(drafts, extra = {}) {
  return new Map(Object.entries({
    businesses: [{ owner_user_id: OWNER, content_frequency: "Daily", automation_level: "assisted", timezone: TZ }],
    marketing_plans: [{
      id: "plan-1", owner_user_id: OWNER, business_goal: "Launch SynraPay", status: "active",
      valid_from: "2026-09-12", valid_until: "2026-09-18", created_at: "2026-09-12T08:55:57Z",
    }],
    mara_drafts: drafts,
    post_draft_assets: [],
    mara_media_generations: [],
    instagram_publish_queue: [],
    content_calendar_items: [],
    mara_pending_actions: [],
    ...extra,
  }));
}

/** Loads the snapshot with the production approvals state: legacy Sep 8 + today's item both have open cards. */
function synrapayDb() {
  return createAdminClient(seedDb(synrapayDrafts(), {
    mara_pending_actions: [
      {
        id: "act-legacy-0", owner_user_id: OWNER, tool_name: "propose_calendar_item", status: "pending",
        sanitized_arguments: { sourceDraftId: "legacy-0", title: "Legacy Sep 8" },
      },
      {
        id: "act-today", owner_user_id: OWNER, tool_name: "propose_calendar_item", status: "pending",
        sanitized_arguments: { sourceDraftId: "draft-2026-09-12", title: "SynraPay 2026-09-12" },
      },
    ],
  }));
}

// ---------------------------------------------------------------------------
// 1 + 3. The active horizon returns exactly the 7 current rolling items.
// ---------------------------------------------------------------------------

test("SynraPay's active horizon surfaces exactly the 7 date-keyed items Sep 12–18 — never the legacy ordinal rows", async () => {
  const db = synrapayDb();
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });

  assert.equal(snapshot.today, "2026-09-12");
  assert.equal(snapshot.timeZone, TZ);
  assert.equal(snapshot.planId, "plan-1");

  // Exactly the 7 current rolling items, Sep 12 through Sep 18, in order.
  assert.deepEqual(snapshot.items.map((item) => item.slotDate), HORIZON);
  assert.deepEqual(snapshot.items.map((item) => item.localDate), HORIZON);

  const ids = snapshot.items.map((item) => item.draftId);
  for (const legacy of ["legacy-0", "legacy-1", "legacy-2"]) {
    assert.ok(!ids.includes(legacy), `${legacy} must not be surfaced`);
  }
  // No Sep 8 / Sep 10 date anywhere; and the legacy "2" row — which sits
  // INSIDE the horizon at 3:00 PM on Sep 12 — is excluded purely by its
  // ordinal key (all current items publish at 6:30 PM).
  for (const item of snapshot.items) {
    assert.ok(!["2026-09-08", "2026-09-10"].includes(item.localDate), `stale date ${item.localDate} leaked`);
    assert.notEqual(item.localTime, "3:00 PM", "the legacy Sep 12 3:00 PM row leaked into the horizon");
  }

  // History/debugging: the snapshot still knows ALL 10 plan drafts exist.
  assert.equal(snapshot.planDraftIds.length, 10);
  for (const legacy of ["legacy-0", "legacy-1", "legacy-2"]) {
    assert.ok(snapshot.planDraftIds.includes(legacy));
  }
});

test("Marketing Plan's payload is 7 current items, not 10", async () => {
  // GET /api/plan returns this snapshot verbatim and PlanWorkspace renders
  // snapshot.items — the count the screen shows is the count of these items.
  const db = synrapayDb();
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.equal(snapshot.items.length, 7, "7 current items, not the pre-fix 10");
});

// ---------------------------------------------------------------------------
// 2. Today on Sep 12 never shows Sep 8 (or Sep 10).
// ---------------------------------------------------------------------------

test("Today on Sep 12 has no Sep 8/Sep 10 approval needs, scheduled, generating, failed or published work", async () => {
  const db = synrapayDb();
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  const summary = readModel.todaySummary(snapshot);

  // The legacy Sep 8 row HAS an open approval card in the fixture (that is the
  // reported bug) — it must still not reach Today's "Needs approval".
  const seen = [
    ...summary.publishingToday, ...summary.needsApproval, ...summary.generating,
    ...summary.failed, ...summary.scheduled, ...summary.published,
    ...(summary.next ? [summary.next] : []),
  ];
  for (const item of seen) {
    assert.ok(!["2026-09-08", "2026-09-10"].includes(item.localDate), `Today leaked ${item.localDate}`);
    assert.doesNotMatch(item.draftId, /^legacy-/);
  }

  // The only current approval need is today's own rolling item.
  assert.deepEqual(summary.needsApproval.map((item) => item.draftId), ["draft-2026-09-12"]);
  // "Due today" is exactly the Sep 12 slot.
  assert.deepEqual(summary.publishingToday.map((item) => item.localDate), ["2026-09-12"]);
  assert.equal(readModel.itemsForToday(snapshot).length, 1);
});

// ---------------------------------------------------------------------------
// 4. Content Calendar: stale rows out, legitimate scheduled/published work in.
// ---------------------------------------------------------------------------

test("the Calendar feed drops stale rows but keeps legitimate scheduled/published content", async () => {
  const drafts = [
    ...synrapayDrafts(),
    // Moved by the owner beyond the horizon and approved: still real work.
    draftRow({ id: "future-scheduled", source_plan_item_key: "2026-09-25", proposed_publish_at: at("2026-09-25"), status: "approved", title: "Owner moved me out" }),
    // Published history from before today: stays on the calendar.
    draftRow({ id: "past-published", source_plan_item_key: "2026-09-05", proposed_publish_at: at("2026-09-05"), status: "approved", title: "Published last week" }),
    // Stale, still-unapproved planner draft from before the horizon: hidden.
    draftRow({ id: "stale-approval", source_plan_item_key: "2026-09-05", proposed_publish_at: at("2026-09-05"), title: "Stale past approval" }),
    // Malformed/legacy keys and unusable publish times: never surfaced.
    draftRow({ id: "impossible-date", source_plan_item_key: "2026-13-45", proposed_publish_at: at("2026-09-15") }),
    draftRow({ id: "null-key", source_plan_item_key: null, proposed_publish_at: at("2026-09-15") }),
    draftRow({ id: "no-publish-at", source_plan_item_key: "2026-09-15", proposed_publish_at: "" }),
  ];
  const db = createAdminClient(seedDb(drafts, {
    instagram_publish_queue: [
      { owner_user_id: OWNER, draft_id: "future-scheduled", status: "scheduled", instagram_media_id: null, failure_message: null },
      { owner_user_id: OWNER, draft_id: "past-published", status: "published", instagram_media_id: "ig-179", failure_message: null },
    ],
  }));
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  const ids = snapshot.items.map((item) => item.draftId);

  // The current horizon + legitimate progressed work.
  for (const date of HORIZON) assert.ok(ids.includes(`draft-${date}`), `current item ${date} missing`);
  assert.ok(ids.includes("future-scheduled"), "legitimate future scheduled work must stay visible");
  assert.equal(snapshot.items.find((item) => item.draftId === "future-scheduled").status, "scheduled");
  assert.ok(ids.includes("past-published"), "published history must stay visible");
  assert.equal(snapshot.items.find((item) => item.draftId === "past-published").status, "published");

  // Nothing stale ever appears as an active schedule entry.
  for (const hidden of ["stale-approval", "impossible-date", "null-key", "no-publish-at", "legacy-0", "legacy-1", "legacy-2"]) {
    assert.ok(!ids.includes(hidden), `${hidden} must not appear on the calendar`);
  }
  const dates = new Set(snapshot.items.map((item) => item.localDate));
  assert.ok(!dates.has("2026-09-08") && !dates.has("2026-09-10"), "the legacy Sep 8/Sep 10 rows must not create calendar entries");
  // Sep 5 appears only through the legitimately published item — the stale,
  // never-approved Sep 5 planner draft does not.
  assert.deepEqual(
    snapshot.items.filter((item) => item.localDate === "2026-09-05").map((item) => item.draftId),
    ["past-published"],
  );
});

// ---------------------------------------------------------------------------
// 5. Workflow validity, not created_at, decides visibility.
// ---------------------------------------------------------------------------

test("valid date-keyed current-horizon rows stay visible regardless of created_at", async () => {
  // The Sep 12 item was created on 2026-08-01 — long before the fix — and uses
  // a valid date slot inside the horizon: it must remain visible.
  const db = synrapayDb();
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });
  assert.ok(snapshot.items.some((item) => item.draftId === "draft-2026-09-12"));

  // And the rule itself never consults creation time — only slot validity,
  // the live horizon, and progressed scheduled/published state.
  const today = "2026-09-12";
  const visible = { slotDate: "2026-09-18", localDate: "2026-09-18", status: "planned" };
  const hidden = { slotDate: "2026-09-19", localDate: "2026-09-19", status: "planned" };
  assert.equal(readModel.isCurrentWorkflowItem(visible, { today }), true, "last horizon day is inside");
  assert.equal(readModel.isCurrentWorkflowItem(hidden, { today }), false, "the day after the horizon is outside (until scheduled/published)");
  assert.equal(readModel.isCurrentWorkflowItem({ ...hidden, status: "scheduled" }, { today }), true, "scheduled beyond the horizon stays");
  assert.equal(readModel.isCurrentWorkflowItem({ slotDate: "2026-09-08", localDate: "2026-09-08", status: "needs_approval" }, { today }), false, "past approval needs are not current");
  assert.equal(readModel.isCurrentWorkflowItem({ slotDate: "2026-09-12", localDate: "2026-09-12", status: "failed" }, { today }), true, "today's failure is current");
});

test("slot-key and publish-instant validation accept exactly the new date-based semantics", () => {
  assert.equal(readModel.isLocalSlotDateKey("2026-09-12"), true);
  assert.equal(readModel.isLocalSlotDateKey("2026-02-30"), false, "impossible calendar date");
  assert.equal(readModel.isLocalSlotDateKey("0"), false, "legacy ordinal");
  assert.equal(readModel.isLocalSlotDateKey("2"), false, "legacy ordinal");
  assert.equal(readModel.isLocalSlotDateKey("2026-13-45"), false, "shape-valid, impossible date");
  assert.equal(readModel.isLocalSlotDateKey(null), false);
  assert.equal(readModel.isLocalSlotDateKey(" 2026-09-12"), false);
  assert.equal(readModel.isValidPublishInstant(at("2026-09-12")), true);
  assert.equal(readModel.isValidPublishInstant(""), false);
  assert.equal(readModel.isValidPublishInstant("not-a-timestamp"), false);
  assert.equal(readModel.isValidPublishInstant(null), false);
});

// ---------------------------------------------------------------------------
// 6. Loading the snapshot deletes and mutates nothing.
// ---------------------------------------------------------------------------

test("loading the snapshot performs no write and preserves every legacy row", async () => {
  const drafts = synrapayDrafts();
  const before = JSON.stringify(drafts);
  const db = synrapayDb();
  db.tables.set("mara_drafts", drafts);
  await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });

  assert.deepEqual(db.writes, [], "the read model must never insert/update/delete");
  assert.equal(JSON.stringify(db.tables.get("mara_drafts")), before, "all 10 rows — legacy included — are untouched");
  assert.equal(db.tables.get("mara_drafts").length, 10, "no legacy row was deleted");
});

// ---------------------------------------------------------------------------
// Approvals follows the same active-horizon rule.
// ---------------------------------------------------------------------------

test("the Approvals feed hides stale plan cards and passes everything else through", async () => {
  const db = synrapayDb();
  const snapshot = await readModel.loadWorkflowSnapshot(db, OWNER, { now: NOW });

  // Rows exactly as getOperatingData selects them (new_value carries the args;
  // sanitized_arguments is not fetched there).
  const actionRows = [
    { id: "act-legacy-0", tool_name: "propose_calendar_item", status: "pending", new_value: { sourceDraftId: "legacy-0" } },
    { id: "act-today", tool_name: "propose_calendar_item", status: "pending", new_value: { sourceDraftId: "draft-2026-09-12" } },
    { id: "act-chat", tool_name: "propose_calendar_item", status: "pending", new_value: { title: "Chat proposal without a draft" } },
    { id: "act-other-plan", tool_name: "propose_calendar_item", status: "pending", new_value: { sourceDraftId: "draft-from-an-old-plan" } },
    { id: "act-reel", tool_name: "choose_reel_production", status: "pending", new_value: { productionStatus: "deciding" } },
  ];
  const filtered = readModel.filterApprovalActionsForCurrentWorkflow(actionRows, snapshot);

  assert.deepEqual(filtered.map((action) => action.id), ["act-today", "act-chat", "act-other-plan", "act-reel"]);
});
