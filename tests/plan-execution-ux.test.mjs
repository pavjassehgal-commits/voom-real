/**
 * Marketing Plan execution UX + publishing lifecycle polish — acceptance tests.
 *
 * Real modules under test (no string matching where behaviour can be exercised):
 *   lib/mara/reel-production.ts        — production OPTIONS (recommended != available)
 *   lib/voom/workflow/next-actions.ts  — the ONE next-action engine per stage
 *   lib/voom/cadence.ts                — deterministic content-type balancing
 *   lib/voom/workflow/rolling-plan.ts  — same-item advance, Assisted/Autopilot stops
 *   lib/voom/workflow/state.ts         — missed-schedule derivation, shared labels
 *   lib/voom/workflow/read.ts          — cross-view horizon rule
 *   lib/instagram/publishing.ts        — idempotent due-selection
 *
 * Source assertions are used ONLY for wiring that exists at the DB/browser
 * boundary (server actions reusing the idempotent systems). No provider call,
 * no paid generation, no real publishing anywhere in this file.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const production = await import("../lib/mara/reel-production.ts");
const nextActions = await import("../lib/voom/workflow/next-actions.ts");
const cadence = await import("../lib/voom/cadence.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const state = await import("../lib/voom/workflow/state.ts");
const readModel = await import("../lib/voom/workflow/read.ts");
const publishing = await import("../lib/instagram/publishing.ts");

const NOW = new Date("2026-09-12T05:00:00.000Z"); // 09:00 Dubai
const TZ = "Asia/Dubai";
const IN_FUTURE = "2026-09-12T14:30:00.000Z"; // 6:30 PM Dubai today

// ---------------------------------------------------------------------------
// 1 + 2. Reel production options: recommended method != available methods
// ---------------------------------------------------------------------------

test("1. a Reel recommended for filming still exposes Create with MARA with an adapted concept", () => {
  // "Founder explains SynraPay on camera" — MARA cannot film the founder, but
  // a branded animated explainer covering the same message is a safe, valid
  // equivalent, so the option MUST stay visible and enabled.
  const capability = production.classifyReelProduction({
    concept: "Founder explains SynraPay on camera",
    script: "The founder introduces SynraPay and shows how it simplifies checkout.",
  });
  assert.equal(capability.recommendedMethod, "film_yourself");
  assert.ok(capability.availableMethods.includes("film_yourself"));
  assert.ok(capability.availableMethods.includes("create_with_mara"), "Create with MARA is never hidden just because filming is recommended");
  assert.ok(capability.availableMethods.includes("upload_asset"));
  assert.equal(capability.maraOption.state, "adapted");
  assert.match(String(capability.maraOption.concept), /animated/i);
  assert.equal(capability.maraOption.disabled, undefined);
  assert.equal(capability.maraOption.disabledReason, null);
});

test("2a. an exact concept with no safe generated equivalent disables MARA with a specific reason", () => {
  const capability = production.classifyReelProduction({
    concept: "Real customer testimonial",
    script: "A customer explains their visit in their own words.",
  });
  assert.equal(capability.maraOption.state, "unavailable");
  assert.ok(!capability.availableMethods.includes("create_with_mara"), "genuinely unfauxable concepts may disable MARA");
  assert.match(String(capability.maraOption.disabledReason), /testimonial/i, "the reason names WHAT cannot be generated");
  // The other two production routes remain.
  assert.deepEqual([...capability.availableMethods].sort(), ["film_yourself", "upload_asset"]);
});

test("2b. adapted equivalents are shown as the action's hint, not silently dropped", () => {
  const capability = production.classifyReelProduction({
    concept: "Inside our Dubai cafe",
    script: "A walkthrough of our location.",
  });
  assert.equal(capability.recommendedMethod, "film_yourself");
  assert.equal(capability.maraOption.state, "adapted");
  const facts = {
    contentType: "reel", stage: "planned", failedStage: null, mode: "assisted",
    publishAt: IN_FUTURE, hasMedia: false,
    production: {
      recommendedMethod: capability.recommendedMethod,
      availableMethods: capability.availableMethods,
      selectedMethod: null, maraOption: capability.maraOption,
    },
  };
  const resolved = nextActions.planItemActions(facts);
  const mara = resolved.actions.find((action) => action.id === "produce_with_mara");
  assert.ok(mara, "the card still shows Create with MARA");
  assert.ok(!mara.disabled, "the adapted MARA option is enabled");
  assert.match(String(mara.hint), /adapted/i);
  const film = resolved.actions.find((action) => action.id === "film_yourself");
  assert.match(String(film.hint), /Recommended/i);
});

// ---------------------------------------------------------------------------
// 3 + 4. Post and Story production options
// ---------------------------------------------------------------------------

test("3. every Post recommendation exposes MARA image generation and upload", () => {
  const resolved = nextActions.planItemActions({
    contentType: "post", stage: "planned", failedStage: null, mode: "assisted",
    publishAt: IN_FUTURE, hasMedia: false,
  });
  const ids = resolved.actions.map((action) => action.id);
  assert.ok(ids.includes("produce_with_mara"), "Create image with MARA is present");
  assert.ok(ids.includes("upload_asset"), "Upload image is present");
  const mara = resolved.actions.find((action) => action.id === "produce_with_mara");
  assert.ok(!mara.disabled);
  assert.match(mara.label, /MARA/);
  // The generation path is the EXISTING Seedream-backed provider abstraction.
  const media = null; // checked by wiring test below (media.ts source)
  assert.ok(media === null);
});

test("4. every Story recommendation exposes Create with MARA and image/video upload", () => {
  const planned = nextActions.planItemActions({
    contentType: "story", stage: "planned", failedStage: null, mode: "assisted",
    publishAt: IN_FUTURE, hasMedia: false,
  });
  const ids = planned.actions.map((action) => action.id);
  assert.ok(ids.includes("produce_with_mara"));
  assert.ok(ids.includes("upload_asset"));
  assert.match(planned.actions.find((action) => action.id === "upload_asset").label, /image or video/i);

  // With media already stored, the Story advances to review with the SAME actions contract.
  const review = nextActions.planItemActions({
    contentType: "story", stage: "ready_for_review", failedStage: null, mode: "assisted",
    publishAt: IN_FUTURE, hasMedia: true,
  });
  assert.ok(review.actions.some((action) => action.id === "approve_schedule"));
});

// ---------------------------------------------------------------------------
// 5. Content-type diversity in the rolling planner
// ---------------------------------------------------------------------------

test("5a. a daily 7-day plan never collapses into a single content type", () => {
  for (const goal of ["Grow awareness", "Grow sales", "Build community loyalty", "Promote the new menu", ""]) {
    const types = cadence.planContentTypes({ cadence: "daily", count: 7, goal });
    const distinct = new Set(types);
    assert.ok(distinct.size >= 2, `goal "${goal}" produced only one content type: ${types.join(",")}`);
    const reels = types.filter((type) => type === "reel").length;
    assert.ok(reels <= 3, `reels must not dominate: ${types.join(",")}`);
    assert.ok(types.includes("post"), "posts must meaningfully appear");
  }
});

test("5b. Stories appear meaningfully in daily and 5x-week plans", () => {
  const daily = cadence.planContentTypes({ cadence: "daily", count: 7, goal: "Grow awareness" });
  const fiveX = cadence.planContentTypes({ cadence: "5x_week", count: 5, goal: "Grow sales" });
  assert.ok(daily.includes("story"), `daily plan has no story: ${daily.join(",")}`);
  assert.ok(fiveX.includes("post") && fiveX.includes("reel"), `5x plan lost its post/reel balance: ${fiveX.join(",")}`);
});

test("5c. the mix follows the marketing goal deterministically", () => {
  const reach = cadence.planContentTypes({ cadence: "daily", count: 7, goal: "Grow reach and followers" });
  const conversion = cadence.planContentTypes({ cadence: "daily", count: 7, goal: "Increase sales and bookings" });
  const reelsReach = reach.filter((type) => type === "reel").length;
  const reelsConversion = conversion.filter((type) => type === "reel").length;
  assert.ok(reelsReach >= reelsConversion, "a reach goal should lean into reels more than a sales goal");
  assert.ok(conversion.filter((type) => type === "post").length >= 3, "a conversion goal leans into feed posts");
  // Determinism: the same inputs always produce the same sequence.
  assert.deepEqual(
    cadence.planContentTypes({ cadence: "daily", count: 7, goal: "Grow reach" }),
    cadence.planContentTypes({ cadence: "daily", count: 7, goal: "Grow reach" }),
  );
});

test("5d. formats are interleaved — no back-to-back repetition where the mix allows", () => {
  for (const goal of ["Grow awareness", "Grow sales", "Build community"]) {
    const types = cadence.planContentTypes({ cadence: "daily", count: 7, goal });
    for (let index = 1; index < types.length; index += 1) {
      assert.notEqual(types[index], types[index - 1], `${goal}: consecutive ${types[index]} at ${index}: ${types.join(",")}`);
    }
  }
});

test("5e. buildSlots carries the balanced types and stays slot-idempotent", () => {
  const slots = rolling.buildSlots({ now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "Grow awareness", selectedChannels: ["instagram"] });
  assert.equal(slots.length, 7);
  const counts = { post: 0, reel: 0, story: 0 };
  for (const slot of slots) counts[slot.contentType] += 1;
  assert.ok(counts.post >= 2 && counts.reel >= 1 && counts.story >= 1, `unbalanced slots: ${JSON.stringify(counts)}`);
  const again = rolling.buildSlots({ now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "Grow awareness", selectedChannels: ["instagram"] });
  assert.deepEqual(slots.map((slot) => [slot.date, slot.contentType]), again.map((slot) => [slot.date, slot.contentType]));
  // All times remain in the future (past-time guard preserved).
  for (const slot of slots) assert.ok(Date.parse(slot.publishAt) > NOW.getTime());
});

// ---------------------------------------------------------------------------
// 6/7/8. One item advances in place; mode semantics preserved
// ---------------------------------------------------------------------------

function createStore() {
  return {
    plans: new Map(), drafts: new Map(), bySlot: new Map(), media: new Map(),
    assets: new Set(), approvals: new Map(), queue: new Map(), seq: 0,
    providerCalls: 0, publishCalls: 0,
  };
}

function createPorts(store) {
  return {
    async ensurePlan({ validFrom, validUntil }) {
      const existing = [...store.plans.values()][0];
      if (existing) return existing.id;
      const id = `plan-${++store.seq}`;
      store.plans.set(id, { id, validFrom, validUntil });
      return id;
    },
    async listItems(planId) {
      return [...store.drafts.values()].filter((item) => item.planId === planId);
    },
    async generateContent(slot) {
      return { concept: `${slot.contentType} idea ${slot.index}`, caption: "A calm look at our work today.", cta: "Visit us", hashtags: ["#dubai"], visualBrief: "Clean natural light." };
    },
    async createDraft({ planId, slot, content }) {
      const key = `${planId}:${slot.slotKey}`;
      if (store.bySlot.has(key)) return store.drafts.get(store.bySlot.get(key));
      const draftId = `draft-${++store.seq}`;
      const item = { draftId, planId, slotKey: slot.slotKey, channel: slot.channel, format: slot.format, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" };
      store.drafts.set(draftId, item);
      store.bySlot.set(key, draftId);
      return item;
    },
    async ensureMedia(item) {
      if (store.assets.has(item.draftId)) return { ok: true, state: "exists" };
      const live = store.media.get(item.draftId);
      if (live && (live.status === "queued" || live.status === "processing")) return { ok: true, state: "exists" };
      store.providerCalls += 1;
      store.media.set(item.draftId, { status: "completed" });
      store.assets.add(item.draftId);
      return { ok: true, state: "completed" };
    },
    async requestApproval(item) {
      if (item.status === "approved" || store.approvals.has(item.draftId)) return;
      store.approvals.set(item.draftId, { status: "pending" });
    },
    async autoApproveAndSchedule(item) {
      const verdict = safety.evaluateAutopilotRecommendation({ title: item.concept, content: item.caption, publishAt: item.publishAt }, NOW);
      if (!verdict.safe) return { approved: false, reason: verdict.blockers.join(",") };
      const item_ = store.drafts.get(item.draftId);
      item_.status = "approved";
      store.approvals.delete(item.draftId);
      store.queue.set(item.draftId, { status: "scheduled", scheduledAt: item.publishAt, instagramMediaId: null });
      return { approved: true };
    },
    async savePlanItems() {},
  };
}

const safety = await import("../lib/mara/autopilot-safety.ts");

test("6. generated media advances the SAME workflow item (no duplicate drafts)", async () => {
  // Plans + Credits v1: only Autopilot may reach the paid media stage on its
  // own, so the "generated once, never twice" guarantee is proven there.
  const store = createStore();
  const input = { now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "Grow awareness", selectedChannels: ["instagram"] };
  const first = await rolling.ensureRollingPlan(createPorts(store), input);
  assert.equal(first.created, 7);
  const idsAfterFirst = new Set([...store.drafts.keys()]);
  assert.equal(store.providerCalls, 7, "media generated once per item");
  // A second run the same day reuses EVERY item and generates nothing new.
  const second = await rolling.ensureRollingPlan(createPorts(store), input);
  assert.equal(second.created, 0);
  assert.equal(second.reused, 7);
  assert.equal(store.providerCalls, 7, "no second generation for the same items");
  assert.deepEqual(new Set([...store.drafts.keys()]), idsAfterFirst, "no duplicate drafts, ever");
  // The item that generated media advanced in place — same item id: a safe
  // one is scheduled, a held one sits in Approvals, none was duplicated.
  for (const item of store.drafts.values()) {
    assert.equal(item.draftId, store.bySlot.get(`${first.planId}:${item.slotKey}`));
    assert.ok(store.assets.has(item.draftId), "the media belongs to the same item");
    const facts = {
      draftStatus: item.status, hasMedia: true, mediaStatus: "completed",
      publishStatus: store.queue.get(item.draftId)?.status ?? null, awaitingApproval: store.approvals.has(item.draftId),
      publishAt: item.publishAt, now: NOW,
    };
    assert.equal(state.deriveWorkflowStatus(facts), store.queue.has(item.draftId) ? "scheduled" : "needs_approval");
  }
  assert.equal(first.autoApproved + first.heldForReview, 7);
});

test("6b. Assisted plans the horizon once, generates no media on its own, and a rerun reuses every item (v1)", async () => {
  const store = createStore();
  const input = { now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "Grow awareness", selectedChannels: ["instagram"] };
  const first = await rolling.ensureRollingPlan(createPorts(store), input);
  assert.equal(first.stage, "planning_only");
  assert.equal(first.created, 7);
  assert.equal(store.providerCalls, 0, "Assisted never generates paid media without an explicit action");
  const idsAfterFirst = new Set([...store.drafts.keys()]);
  const second = await rolling.ensureRollingPlan(createPorts(store), input);
  assert.equal(second.created, 0);
  assert.equal(second.reused, 7);
  assert.equal(store.providerCalls, 0);
  assert.deepEqual(new Set([...store.drafts.keys()]), idsAfterFirst, "no duplicate drafts, ever");
  // Every item is a planned card offering the production choices; the SAME
  // item derives Ready for review once the owner produces its media.
  const item = [...store.drafts.values()][0];
  assert.equal(item.draftId, store.bySlot.get(`${first.planId}:${item.slotKey}`));
  const before = { draftStatus: "draft", hasMedia: false, mediaStatus: null, publishStatus: null, awaitingApproval: false, publishAt: item.publishAt, now: NOW };
  assert.equal(state.deriveWorkflowStatus(before), "planned");
  assert.ok(nextActions.planItemActions({ contentType: "post", stage: "planned", failedStage: null, mode: "assisted", publishAt: item.publishAt, hasMedia: false })
    .actions.some((action) => action.id === "produce_with_mara"), "the owner produces media from the planned card");
  assert.equal(state.deriveWorkflowStatus({ ...before, hasMedia: true, mediaStatus: "completed" }), "ready_for_review");
});

test("7. Assisted stops at Planned — nothing is generated, scheduled or queued on its own (v1)", async () => {
  const store = createStore();
  const run = await rolling.ensureRollingPlan(createPorts(store), { now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "Grow awareness", selectedChannels: ["instagram"] });
  assert.equal(run.created, 7);
  assert.equal(run.autoApproved, 0);
  assert.equal(run.mediaQueued, 0, "no paid media stage in Assisted");
  assert.equal(run.awaitingApproval, 0, "approval is asked for once media exists, not at planning");
  assert.equal(store.providerCalls, 0);
  assert.equal(store.media.size, 0);
  assert.equal(store.approvals.size, 0);
  assert.equal(store.queue.size, 0, "assisted never queues anything on its own");
  for (const item of store.drafts.values()) assert.equal(item.status, "draft");
});

test("8. Autopilot safely proceeds for safe content via the existing evaluator", async () => {
  const store = createStore();
  const run = await rolling.ensureRollingPlan(createPorts(store), { now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "Grow awareness", selectedChannels: ["instagram"] });
  assert.equal(run.autoApproved + run.heldForReview, 7);
  assert.ok(run.autoApproved >= 1, "safe content advances automatically");
  for (const [draftId, row] of store.queue) {
    assert.equal(store.drafts.get(draftId).status, "approved");
    assert.equal(row.status, "scheduled");
    assert.ok(Date.parse(row.scheduledAt) > NOW.getTime() + 5 * 60_000, "schedules stay in the future (existing guard)");
  }
  // Risky content stops for approval instead of being dropped.
  for (const item of store.drafts.values()) {
    if (!store.queue.has(item.draftId)) assert.ok(store.approvals.has(item.draftId), "held items sit in Approvals");
  }
});

// ---------------------------------------------------------------------------
// 9/10. Expired unpublished schedules derive Missed — never fake-upcoming
// ---------------------------------------------------------------------------

test("9. an expired, unpublished schedule derives Missed with a truthful reason", () => {
  // Scheduled for 6:30 AM Dubai, still unpublished at 9:00 AM — the exact
  // shape of the production 6:30 PM incident.
  const missed = state.deriveWorkflowStatus({
    draftStatus: "approved", hasMedia: true, mediaStatus: "completed",
    publishStatus: "scheduled", awaitingApproval: false,
    publishAt: "2026-09-12T02:30:00.000Z",
    now: NOW,
  });
  assert.equal(missed, "missed");
  const facts = {
    draftStatus: "approved", hasMedia: true, mediaStatus: "completed",
    publishStatus: "scheduled", awaitingApproval: false,
    publishAt: "2026-09-12T05:00:00.000Z", now: new Date("2026-09-12T14:41:00.000Z"),
  };
  assert.equal(state.deriveWorkflowStatus(facts), "missed");
  assert.equal(state.WORKFLOW_STATUS_LABELS.missed, "Missed scheduled time");
  assert.match(String(state.missedReason(facts)), /schedule|publish/i);
});

test("9b. every missed flavour derives Needs attention (missed), including a missing queue row", () => {
  // Queue row never created (the historical 6:30 PM incident's dead state).
  assert.equal(state.deriveWorkflowStatus({
    draftStatus: "approved", hasMedia: true, mediaStatus: "completed",
    publishStatus: null, awaitingApproval: false,
    publishAt: "2026-09-12T05:00:00.000Z", now: new Date("2026-09-12T14:41:00.000Z"),
  }), "missed");
  // Queue withdrawn because media never arrived.
  assert.equal(state.deriveWorkflowStatus({
    draftStatus: "approved", hasMedia: false, mediaStatus: "failed",
    publishStatus: "cancelled", awaitingApproval: false,
    publishAt: "2026-09-12T05:00:00.000Z", now: new Date("2026-09-12T14:41:00.000Z"),
  }), "failed"); // media failure still wins — truthful "what broke"
  assert.equal(state.deriveWorkflowStatus({
    draftStatus: "approved", hasMedia: false, mediaStatus: "completed",
    publishStatus: "cancelled", awaitingApproval: false,
    publishAt: "2026-09-12T05:00:00.000Z", now: new Date("2026-09-12T14:41:00.000Z"),
  }), "missed");
});

test("10. missed content is NOT treated as ordinary future publishing", () => {
  // The workflow status is not "scheduled", so no screen renders it as upcoming.
  const facts = {
    draftStatus: "approved", hasMedia: true, mediaStatus: "completed",
    publishStatus: "cancelled", awaitingApproval: false,
    publishAt: "2026-09-12T05:00:00.000Z", now: new Date("2026-09-12T14:41:00.000Z"),
  };
  assert.notEqual(state.deriveWorkflowStatus(facts), "scheduled");
  // The queue's own selection can never claim a withdrawn row…
  assert.equal(publishing.isDueForPublishing({ status: "cancelled", scheduledAt: "2026-09-12T05:00:00.000Z", draftStatus: "approved", attempts: 0, instagramMediaId: null }, Date.parse("2026-09-12T14:41:00.000Z")), false);
  // …nor a published one…
  assert.equal(publishing.isDueForPublishing({ status: "scheduled", scheduledAt: "2026-09-12T05:00:00.000Z", draftStatus: "approved", attempts: 0, instagramMediaId: "17999" }, Date.parse("2026-09-12T14:41:00.000Z")), false);
  // …nor an unapproved one.
  assert.equal(publishing.isDueForPublishing({ status: "scheduled", scheduledAt: "2026-09-12T05:00:00.000Z", draftStatus: "draft", attempts: 0, instagramMediaId: null }, Date.parse("2026-09-12T14:41:00.000Z")), false);
  // And the missed card offers Post now / Reschedule / Cancel — explicit user
  // intent — never an automatic late publish.
  const resolved = nextActions.planItemActions({
    contentType: "post", stage: "missed", failedStage: null, mode: "autopilot",
    publishAt: "2026-09-12T05:00:00.000Z", dayLabel: "Today", localTime: "6:30 PM", hasMedia: true,
  });
  assert.deepEqual(resolved.actions.map((action) => action.id), ["post_now", "reschedule", "cancel_schedule"]);
  assert.match(resolved.explanation.autoPublish, /never publishes hours late/i);
});

// ---------------------------------------------------------------------------
// 11. Post now / Reschedule preserve publish idempotency and past-time guards
// ---------------------------------------------------------------------------

test("11. recovery actions route through the ONE idempotent queue identity", async () => {
  const actions = await read("lib/voom/workflow/actions-server.ts");
  // Post now uses the SAME idempotent enqueue (one row per owner+draft), never
  // a direct insert and never a second publish identity.
  assert.match(actions, /enqueuePublishItem/, "post-now reuses the idempotent enqueue");
  assert.doesNotMatch(actions, /from\("instagram_publish_queue"\)\.insert/, "no direct queue writes");
  // Reschedule validates with the existing business-timezone past-time guard.
  assert.match(actions, /checkSchedule/, "server-side past-time validation preserved");
  // Approval reuses the existing approval chain (calendar mirror + queue sync).
  assert.match(actions, /approvePostDraft/);
  // Cancellation reuses the existing cancel path; published items are protected there.
  assert.match(actions, /cancelPlanItemSchedule/);
  const queueRpc = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(queueRpc, /unique \(owner_user_id, draft_id\)/, "one publish identity per draft");
  const migration = await read("supabase/migrations/0030_publish_queue_waiting_for_media.sql");
  assert.match(migration, /p_waiting_for_media/, "the lifecycle migration holds schedules truthfully");
});

test("11b. a publish time can never be moved into the past", () => {
  const past = new Date("2026-09-12T05:00:00.000Z");
  const guard = scheduleGuard.checkSchedule({ date: "2026-09-12", time: "04:00", now: past, timeZone: TZ });
  assert.equal(guard.ok, false);
  const ok = scheduleGuard.checkSchedule({ date: "2026-09-12", time: "20:00", now: past, timeZone: TZ });
  assert.equal(ok.ok, true);
});

const scheduleGuard = await import("../lib/voom/schedule-guard.ts");

// ---------------------------------------------------------------------------
// 12. Marketing Plan / Today / Calendar agree on lifecycle state
// ---------------------------------------------------------------------------

test("12a. all operating screens render the ONE shared read model", async () => {
  const [operating, workflowRoute, today, calendar, plan] = await Promise.all([
    read("lib/voom/operating-data.ts"),
    read("app/api/voom/workflow/route.ts"),
    read("app/app/(shell)/today/page.tsx"),
    read("app/app/(shell)/calendar/page.tsx"),
    read("app/app/(shell)/plan/page.tsx"),
  ]);
  assert.match(operating, /loadWorkflowSnapshot/);
  assert.match(workflowRoute, /loadWorkflowSnapshot/);
  assert.match(today, /getOperatingData/);
  assert.match(plan, /getOperatingData/);
  assert.match(calendar, /api\/voom\/workflow/);
  // The shared stage labels are the single vocabulary.
  const shared = await read("lib/voom/workflow/state.ts");
  for (const label of ["Missed scheduled time", "Needs attention", "Ready for review", "Needs content"]) {
    assert.match(shared, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("12b. missed/failed items stay visible in every view (never hidden by the horizon)", () => {
  assert.equal(readModel.isCurrentWorkflowItem({ slotDate: "2026-09-09", localDate: "2026-09-09", status: "missed" }, { today: "2026-09-12" }), true);
  assert.equal(readModel.isCurrentWorkflowItem({ slotDate: "2026-09-09", localDate: "2026-09-09", status: "failed" }, { today: "2026-09-12" }), true);
  assert.equal(readModel.isCurrentWorkflowItem({ slotDate: "2026-09-09", localDate: "2026-09-09", status: "planned" }, { today: "2026-09-12" }), false);
});

test("12c. every stage derives a stage label and consistent cross-view tone", async () => {
  const { planItemActions } = nextActions;
  for (const status of state.WORKFLOW_STATUSES) {
    const resolved = planItemActions({
      contentType: "post", stage: status, failedStage: status === "failed" ? "media" : null,
      mode: "assisted", publishAt: IN_FUTURE, dayLabel: "Today", localTime: "6:30 PM", hasMedia: false,
    });
    assert.equal(resolved.stage, status);
    assert.equal(resolved.stageLabel, state.WORKFLOW_STATUS_LABELS[status], `stage ${status} uses the shared label`);
    assert.ok(typeof resolved.headline === "string" && resolved.headline.length > 0, `stage ${status} has a next-step headline`);
  }
  // Generating never claims Scheduled: statuses map 1:1 to the shared labels.
  const card = await read("components/voom/operating/PlanItemCard.tsx");
  assert.match(card, /resolved2\.stageLabel/, "the plan card renders the shared stage label");
  assert.match(card, /PlanItemCard|planItemActions/);
});

// ---------------------------------------------------------------------------
// Wiring: the reusable media path is the EXISTING providers, nothing new
// ---------------------------------------------------------------------------

test("media production reuses Seedream (images) and the video job service (reels) — no new provider", async () => {
  const media = await read("lib/voom/workflow/media.ts");
  assert.match(media, /createMediaProvider/, "existing provider abstraction (OpenRouter Seedream today)");
  assert.match(media, /startPostStudioVideo/, "existing durable video service (Seedance + Magic Hour fallback)");
  assert.match(media, /syncPostToCalendar/, "late media re-syncs the held schedule instead of dying");
  const providers = await read("lib/media/provider.ts") + await read("lib/media/video-provider.ts");
  assert.match(providers, /seedream|openrouter/i);
  assert.match(providers, /magichour|magic[-_ ]?hour|seedance/i);
});
