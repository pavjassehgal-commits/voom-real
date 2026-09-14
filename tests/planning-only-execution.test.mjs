/**
 * Planning-only execution mode for the ONE executable marketing workflow.
 *
 * Real modules under test (no string matching for behaviour):
 *   lib/voom/timezone.ts            — account-timezone date resolution
 *   lib/voom/cadence.ts             — cadence -> slot distribution
 *   lib/voom/workflow/rolling-plan  — the rolling plan engine + planning_only stage
 *   lib/mara/autopilot-safety.ts    — the ONE deterministic safety evaluator
 *
 * Everything external is mocked in memory: no OpenRouter call, no Magic Hour
 * call, no paid media generation, no Meta call, no Supabase. The fake store
 * mirrors the real service's persistence rules (slot-keyed upsert, calendar
 * mirror, publish queue) and counts every port invocation, so the planning
 * boundary — stopping before `ensureMedia` and `autoApproveAndSchedule` — is
 * asserted behaviourally, not by reading source text.
 *
 * The route-level guarantees (authenticated owner only, no arbitrary owner
 * IDs) are asserted against app/api/plan/route.ts source, following the
 * existing suite conventions: the route's auth cannot run in bare Node.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tz = await import("../lib/voom/timezone.ts");
const cadenceMod = await import("../lib/voom/cadence.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const safety = await import("../lib/mara/autopilot-safety.ts");

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// A deterministic Dubai date: 2026-09-12 09:00 local (= 05:00 UTC).
const NOW = new Date("2026-09-12T05:00:00.000Z");
const TZ = "Asia/Dubai";
const EXPECTED_DATES = [
  "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15",
  "2026-09-16", "2026-09-17", "2026-09-18",
];

// ---------------------------------------------------------------------------
// In-memory workflow store with per-port call counters.
// ---------------------------------------------------------------------------

function createStore() {
  return {
    plans: new Map(),
    drafts: new Map(),      // draftId -> item
    bySlot: new Map(),      // `${planId}:${slotDate}` -> draftId
    media: new Map(),       // draftId -> { status } (paid media-generation jobs)
    assets: new Set(),      // draftIds with stored bytes
    approvals: new Map(),   // draftId -> { status }
    calendar: new Map(),    // draftId -> calendarItemId
    queue: new Map(),       // draftId -> queue row
    seq: 0,
    savePlanCalls: 0,
    generationCalls: 0,
    ensureMediaCalls: 0,
    providerImageCalls: 0,
    providerVideoCalls: 0,
    requestApprovalCalls: 0,
    autoApproveCalls: 0,
    metaPublishCalls: 0,
  };
}

/** Ports mirroring lib/voom/workflow/service.ts against the fake store. */
function createPorts(store, options = {}) {
  const captionFor = options.captionFor ?? ((slot) => `A calm look at our ${slot.contentType} work today. Visit us this week.`);
  let planSeq = 0;

  return {
    async ensurePlan({ validFrom, validUntil }) {
      const existing = [...store.plans.values()][0];
      if (existing) {
        existing.validFrom = validFrom;
        existing.validUntil = validUntil;
        return existing.id;
      }
      const id = `plan-${++planSeq}`;
      store.plans.set(id, { id, validFrom, validUntil, plannedPosts: [] });
      return id;
    },

    async listItems(planId) {
      return [...store.drafts.values()].filter((item) => item.planId === planId);
    },

    async generateContent(slot) {
      // Mocked MARA copy: no provider call, no cost.
      store.generationCalls += 1;
      return {
        concept: `${slot.contentType} idea number ${slot.index}`,
        caption: captionFor(slot),
        cta: "Visit us this week",
        hashtags: slot.contentType === "story" ? [] : ["#dubai", "#local"],
        visualBrief: "Warm natural light, clean composition, no text.",
      };
    },

    async createDraft({ planId, slot, content }) {
      const key = `${planId}:${slot.date}`;
      if (store.bySlot.has(key)) return store.drafts.get(store.bySlot.get(key));
      const draftId = `draft-${++store.seq}`;
      const item = {
        draftId, planId, slotKey: slot.date, contentType: slot.contentType,
        concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft",
      };
      store.drafts.set(draftId, item);
      store.bySlot.set(key, draftId);
      return item;
    },

    async ensureMedia(item) {
      // Paid image/video generation behind one port, like the real service.
      store.ensureMediaCalls += 1;
      if (store.assets.has(item.draftId)) return { ok: true };
      if (item.contentType === "reel") store.providerVideoCalls += 1;
      else store.providerImageCalls += 1;
      store.media.set(item.draftId, { status: "completed" });
      store.assets.add(item.draftId);
      return { ok: true };
    },

    async requestApproval(item) {
      store.requestApprovalCalls += 1;
      if (item.status === "approved") return;
      if (store.approvals.has(item.draftId)) return;
      store.approvals.set(item.draftId, { status: "pending" });
    },

    async autoApproveAndSchedule(item) {
      store.autoApproveCalls += 1;
      const verdict = safety.evaluateAutopilotRecommendation(
        { title: item.concept, content: item.caption, publishAt: item.publishAt }, NOW,
      );
      if (!verdict.safe) return { approved: false, reason: verdict.blockers.join(",") };
      approveItem(store, item.draftId);
      store.approvals.delete(item.draftId);
      return { approved: true };
    },

    async savePlanItems(planId, items) {
      store.savePlanCalls += 1;
      store.plans.get(planId).plannedPosts = items.map((item) => ({ draftId: item.draftId, slotDate: item.slotKey }));
    },
  };
}

/** Approval advances the SAME item: calendar mirror, then publish queue. */
function approveItem(store, draftId) {
  const item = store.drafts.get(draftId);
  item.status = "approved";
  store.calendar.set(draftId, `cal-${draftId}`);
  if (!store.assets.has(draftId)) return;
  if (store.queue.has(draftId)) return;
  store.queue.set(draftId, { id: `q-${draftId}`, draftId, status: "scheduled", scheduledAt: item.publishAt });
}

/** Seeds one pre-existing slot item, as if a previous run created it. */
function seedExistingSlot(store) {
  store.plans.set("plan-1", { id: "plan-1", validFrom: "2026-09-12", validUntil: "2026-09-18", plannedPosts: [] });
  const item = {
    draftId: "draft-seeded", planId: "plan-1", slotKey: "2026-09-12", contentType: "post",
    concept: "Seeded existing post", caption: "An existing caption in the brand voice. Visit us this week.",
    publishAt: tz.localToUtcIso("2026-09-12", 18 * 60 + 30, TZ), status: "draft",
  };
  store.drafts.set(item.draftId, item);
  store.bySlot.set("plan-1:2026-09-12", item.draftId);
  return item;
}

const planningInput = {
  now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot",
  goal: "awareness", stage: "planning_only",
};

/** Nothing paid, approved, scheduled, queued or published may exist. */
function assertNothingBeyondPlanning(store, result) {
  assert.equal(store.ensureMediaCalls, 0, "ensureMedia must never be invoked");
  assert.equal(store.providerImageCalls, 0, "no image provider call");
  assert.equal(store.providerVideoCalls, 0, "no video provider call");
  assert.equal(store.media.size, 0, "no media-generation job");
  assert.equal(store.assets.size, 0, "no stored media bytes");
  assert.equal(result.mediaQueued, 0);
  assert.equal(store.requestApprovalCalls, 0, "no approval work");
  assert.equal(store.autoApproveCalls, 0, "no Autopilot approval evaluation");
  assert.equal(result.autoApproved, 0);
  assert.equal(result.awaitingApproval, 0);
  assert.equal(result.heldForReview, 0);
  assert.equal(store.approvals.size, 0);
  assert.equal(store.calendar.size, 0, "no calendar scheduling record");
  assert.equal(store.queue.size, 0, "no Instagram queue entry");
  assert.equal(store.metaPublishCalls, 0, "no publishing call");
  for (const item of store.drafts.values()) {
    assert.equal(item.status, "draft", "planning-only never changes approval state");
  }
}

// ===========================================================================
// 1–3. Rolling horizon, reuse, idempotency
// ===========================================================================

test("planning-only: daily + one existing slot produces seven total rolling slots", async () => {
  const store = createStore();
  seedExistingSlot(store);
  const result = await rolling.ensureRollingPlan(createPorts(store), planningInput);

  assert.equal(result.stage, "planning_only");
  assert.equal(result.slots, 7);
  assert.equal(result.created, 6, "only the genuinely missing drafts are created");
  assert.equal(result.reused, 1, "the existing slot is reused");
  assert.equal(store.drafts.size, 7);
  assert.deepEqual(
    [...store.drafts.values()].map((item) => item.slotKey).sort(),
    EXPECTED_DATES,
  );

  // MARA copy is generated only for the missing slots.
  assert.equal(store.generationCalls, 6);

  // The planning information Marketing Plan / Today render is persisted.
  assert.equal(store.savePlanCalls, 1);
  assert.equal(store.plans.get(result.planId).plannedPosts.length, 7);

  // The summary carries cadence, horizon, counts, local slot dates/times, types.
  assert.ok(result.plan, "a planning summary is returned");
  assert.equal(result.plan.cadence, "daily");
  assert.equal(result.plan.timeZone, TZ);
  assert.equal(result.plan.horizonDays, 7);
  assert.equal(result.plan.validFrom, "2026-09-12");
  assert.equal(result.plan.validUntil, "2026-09-18");
  assert.equal(result.plan.items.length, 7);
  assert.deepEqual(result.plan.items.map((item) => item.slot), EXPECTED_DATES);
  for (const item of result.plan.items) {
    assert.equal(item.localDate, item.slot);
    assert.match(item.localTime, /^\d{1,2}:\d{2}\s?(am|pm)$/i);
    assert.ok(["post", "reel", "story"].includes(item.contentType));
    assert.ok(item.draftId.length > 0);
    assert.ok(Date.parse(item.publishAt) > NOW.getTime(), "no slot may sit in the past");
  }
  assert.deepEqual(
    result.plan.items.map((item) => item.created),
    [false, true, true, true, true, true, true],
  );

  assertNothingBeyondPlanning(store, result);
});

test("planning-only reuses the existing item unchanged", async () => {
  const store = createStore();
  const seeded = seedExistingSlot(store);
  const result = await rolling.ensureRollingPlan(createPorts(store), planningInput);

  const kept = store.drafts.get("draft-seeded");
  assert.ok(kept, "the existing draft id survives the run");
  assert.equal(kept.concept, seeded.concept);
  assert.equal(kept.caption, seeded.caption);
  assert.equal(kept.publishAt, seeded.publishAt);
  const summary = result.plan.items.find((item) => item.slot === "2026-09-12");
  assert.equal(summary.draftId, "draft-seeded");
  assert.equal(summary.created, false);
});

test("planning-only: a second identical run creates nothing and pays for nothing", async () => {
  const store = createStore();
  seedExistingSlot(store);
  const ports = createPorts(store);
  await rolling.ensureRollingPlan(ports, planningInput);
  const generationsAfterFirst = store.generationCalls;

  const second = await rolling.ensureRollingPlan(ports, planningInput);
  assert.equal(second.stage, "planning_only");
  assert.equal(second.created, 0);
  assert.equal(second.reused, 7);
  assert.equal(store.drafts.size, 7, "no duplicate workflow items");
  assert.equal(store.plans.size, 1, "no duplicate plan");
  assert.equal(store.generationCalls, generationsAfterFirst, "no duplicate MARA copy");
  assertNothingBeyondPlanning(store, second);
});

// ===========================================================================
// 4–8. The planning boundary: no media, approval, queue or publishing
// ===========================================================================

test("planning-only never evaluates Autopilot approval, even for risky content", async () => {
  const store = createStore();
  const risky = (slot) => slot.index === 0
    ? "Get 30% off everything today — guaranteed best prices in Dubai!"
    : "A calm look at our work today. Visit us this week.";
  // Note: Autopilot mode, like the controlled account — planning-only must
  // still stop before approval.
  const result = await rolling.ensureRollingPlan(
    createPorts(store, { captionFor: risky }),
    { ...planningInput, cadence: "3x_week" },
  );
  assert.equal(result.created, 3, "risky content is still planned, never silently dropped");
  assertNothingBeyondPlanning(store, result);
});

test("planning-only respects the account cadence, timezone and rolling horizon", async () => {
  // 3x per week keeps its own distribution inside the same 7-day horizon.
  const store = createStore();
  const result = await rolling.ensureRollingPlan(createPorts(store), { ...planningInput, cadence: "3x_week" });
  assert.equal(result.slots, 3);
  assert.equal(result.plan.cadence, "3x_week");
  assert.equal(result.plan.horizonDays, 7);
  assert.deepEqual(
    result.plan.items.map((item) => item.slot),
    cadenceMod.slotDates("2026-09-12", "3x_week"),
  );

  // The horizon starts on the real current local date in the business timezone.
  assert.equal(result.plan.items[0].slot, tz.localDate(NOW, TZ));
  assert.equal(result.plan.timeZone, TZ);

  // A run one day later rolls forward: six days reused, one day created.
  const rolling_store = createStore();
  await rolling.ensureRollingPlan(createPorts(rolling_store), planningInput);
  const tomorrow = new Date(NOW.getTime() + 86400000);
  const next = await rolling.ensureRollingPlan(createPorts(rolling_store), { ...planningInput, now: tomorrow });
  assert.equal(next.reused, 6);
  assert.equal(next.created, 1);
  assert.equal(rolling_store.drafts.size, 8);
  assertNothingBeyondPlanning(rolling_store, next);
});

// ===========================================================================
// 9. Full workflow behaviour is unchanged when planning_only is absent
// ===========================================================================

test("without a stage the full workflow still generates, approves and queues", async () => {
  const store = createStore();
  const result = await rolling.ensureRollingPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness",
  });

  assert.equal(result.stage, "full");
  assert.equal(result.created, 7);
  assert.equal(result.mediaQueued, 7);
  assert.equal(store.ensureMediaCalls, 7);
  assert.equal(store.providerImageCalls + store.providerVideoCalls, 7);
  assert.equal(result.autoApproved, 7);
  assert.equal(store.autoApproveCalls, 7);
  assert.equal(store.approvals.size, 0);
  assert.equal(store.calendar.size, 7);
  assert.equal(store.queue.size, 7);
  for (const row of store.queue.values()) {
    assert.equal(row.status, "scheduled");
    assert.ok(Date.parse(row.scheduledAt) > NOW.getTime());
  }
  // The additive summary is present for full runs too, without changing counts.
  assert.ok(result.plan);
  assert.equal(result.plan.items.length, 7);

  // Explicit "full" and unknown stage values behave identically to absent.
  for (const stage of ["full", "bogus-stage"]) {
    const other = createStore();
    const rerun = await rolling.ensureRollingPlan(createPorts(other), {
      now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness", stage,
    });
    assert.equal(rerun.stage, "full", `stage ${JSON.stringify(stage)} must keep full behaviour`);
    assert.equal(rerun.mediaQueued, 7);
    assert.equal(rerun.autoApproved, 7);
    assert.equal(other.queue.size, 7);
  }
});

test("Manual mode still creates nothing automatically", async () => {
  for (const stage of [undefined, "planning_only"]) {
    const store = createStore();
    const result = await rolling.ensureRollingPlan(createPorts(store), {
      now: NOW, timeZone: TZ, cadence: "daily", mode: "manual", goal: "awareness", stage,
    });
    assert.equal(result.created, 0);
    assert.equal(result.plan, null);
    assert.equal(store.drafts.size, 0);
    assert.equal(store.providerImageCalls + store.providerVideoCalls, 0);
  }
});

// ===========================================================================
// 10. Route safety: authenticated owner only, no arbitrary owner IDs
// ===========================================================================

test("POST /api/plan authenticates, honours planning_only, and never takes an owner from the client", async () => {
  const [route, service, engine] = await Promise.all([
    read("app/api/plan/route.ts"),
    read("lib/voom/workflow/service.ts"),
    read("lib/voom/workflow/rolling-plan.ts"),
  ]);

  // The route authenticates the Voom owner normally and rejects anonymous calls.
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /status: 401/);

  // The run always operates on the authenticated owner — never on a
  // client-supplied identity.
  assert.match(route, /ownerId: user\.id/);
  assert.doesNotMatch(route, /body\.(ownerId|owner_id|owner|userId|user_id)/);
  assert.doesNotMatch(route, /ownerId\s*:\s*body/);
  assert.doesNotMatch(route, /searchParams|headers\.get\(["']x-/i);

  // Only the exact "planning_only" value narrows the run; the default is full.
  assert.match(route, /body\.stage === "planning_only"/);
  assert.match(route, /runOwnerWorkflow\(admin, \{ ownerId: user\.id, cadence, stage, trigger: "replenish" \}\)/);
  // The route never chooses a mode: the saved automation_level governs the run.
  assert.doesNotMatch(route, /\bmode\s*[:=]|automation_level/);

  // The route itself performs no writes and reaches for no provider, queue or
  // publishing system: every write flows through the workflow's own stages.
  assert.doesNotMatch(route, /\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
  assert.doesNotMatch(route, /from "@\/lib\/instagram|from "@\/lib\/media|generateImage|generateVideo|MagicHour|instagram_publish_queue|publishContainer/);

  // The service passes the stage through to the same owner-scoped rolling
  // planner, which still resolves the real cadence and business timezone.
  assert.match(service, /stage\?: WorkflowStage/);
  assert.match(service, /stage: input\.stage/);
  assert.match(service, /accountTimezone/);
  assert.match(service, /normalizeCadence/);
  assert.doesNotMatch(service, /body\.stage|request\.json/);

  // The engine stops planning-only runs before media and approval, while the
  // full path still runs the existing stages in the existing order.
  assert.match(engine, /if \(stage === "planning_only"\) continue;/);
  assert.match(engine, /ports\.ensureMedia\(item\)[\s\S]*ports\.autoApproveAndSchedule\(item\)/);
});
