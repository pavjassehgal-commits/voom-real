/**
 * Focused Marketing Plan lifecycle coverage. All persistence is in memory;
 * there are no provider, database, publishing or paid-media calls.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const lifecycle = await import("../lib/voom/workflow/marketing-plan.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const routeSource = await readFile(new URL("../app/api/plan/route.ts", import.meta.url), "utf8");
const workspaceSource = await readFile(new URL("../components/voom/operating/PlanWorkspace.tsx", import.meta.url), "utf8");
const lifecycleSource = await readFile(new URL("../lib/voom/workflow/marketing-plan.ts", import.meta.url), "utf8");

const TODAY = "2026-09-23";
const NOW = new Date("2026-09-23T05:00:00.000Z");
const TZ = "Asia/Dubai";

function snapshot(items = [], overrides = {}) {
  return {
    timeZone: TZ,
    today: TODAY,
    cadence: "daily",
    cadenceLabel: "Daily",
    mode: "manual",
    selectedChannels: ["instagram", "tiktok", "youtube"],
    planId: "plan-1",
    planGoal: "Grow awareness",
    planValidFrom: TODAY,
    planValidUntil: "2026-09-29",
    planDraftIds: items.map((item) => item.draftId),
    items,
    ...overrides,
  };
}

function view(draftId, date, status = "planned") {
  return { draftId, slotDate: date, localDate: date, status };
}

function run(overrides = {}) {
  return {
    planId: "plan-1",
    mode: "manual",
    trigger: "replenish",
    stage: "planning_only",
    blockedReason: null,
    plan: {
      cadence: "daily",
      timeZone: TZ,
      horizonDays: 7,
      validFrom: TODAY,
      validUntil: "2026-09-29",
      items: [],
    },
    slots: 0,
    created: 0,
    reused: 0,
    mediaQueued: 0,
    awaitingApproval: 0,
    autoApproved: 0,
    heldForReview: 0,
    failures: [],
    ...overrides,
  };
}

test("complete horizon returns authoritative already-up-to-date with zero additions", () => {
  const result = lifecycle.planReplenishOutcome(run({ slots: 7, reused: 7 }), snapshot());
  assert.deepEqual(result, {
    state: "already_up_to_date",
    added: 0,
    horizonStart: TODAY,
    horizonEnd: "2026-09-29",
    addedChannelFormats: [],
  });
});

test("new recommendations return exact added count and native server labels", () => {
  const items = [
    { slot: TODAY, slotKey: `${TODAY}|instagram_reel`, localDate: TODAY, localTime: "18:30", publishAt: "2026-09-23T14:30:00Z", channel: "instagram", format: "reel", contentType: "reel", draftId: "d1", created: true },
    { slot: "2026-09-24", slotKey: "2026-09-24|tiktok_video", localDate: "2026-09-24", localTime: "19:15", publishAt: "2026-09-24T15:15:00Z", channel: "tiktok", format: "video", contentType: "video", draftId: "d2", created: true },
    { slot: "2026-09-25", slotKey: "2026-09-25|youtube_short", localDate: "2026-09-25", localTime: "19:00", publishAt: "2026-09-25T15:00:00Z", channel: "youtube", format: "short", contentType: "short", draftId: "d3", created: true },
  ];
  const result = lifecycle.planReplenishOutcome(run({ slots: 3, created: 3, plan: { ...run().plan, items } }), snapshot());
  assert.equal(result.state, "added");
  assert.equal(result.added, 3);
  assert.deepEqual(result.addedChannelFormats, ["Instagram Reel", "TikTok Video", "YouTube Short"]);
});

test("content persistence failure cannot be reported as success", () => {
  const item = { slot: TODAY, slotKey: `${TODAY}|instagram_post`, localDate: TODAY, localTime: "18:30", publishAt: "2026-09-23T14:30:00Z", channel: "instagram", format: "post", contentType: "post", draftId: "d1", created: true };
  const result = lifecycle.planReplenishOutcome(run({
    slots: 2,
    created: 1,
    plan: { ...run().plan, items: [item] },
    failures: [{ slot: "2026-09-24", stage: "content", code: "insert_failed" }],
  }), snapshot());
  assert.equal(result.state, "failed");
  assert.equal(result.added, 0);
  assert.deepEqual(result.addedChannelFormats, []);
});

test("no selected social channel returns the actionable state and never an Instagram result", () => {
  const result = lifecycle.planReplenishOutcome(run({
    blockedReason: "no_supported_social_channels_selected",
    plan: null,
  }), snapshot([], { selectedChannels: [] }));
  assert.equal(result.state, "no_supported_social_channels_selected");
  assert.equal(result.added, 0);
  assert.deepEqual(result.addedChannelFormats, []);
});

test("Marketing Plan hides expired cards without mutating historical workflow rows", () => {
  const original = snapshot([
    view("expired-published", "2026-09-22", "published"),
    view("today", "2026-09-23"),
    view("last-day", "2026-09-29"),
    view("future-scheduled", "2026-10-01", "scheduled"),
  ]);
  const projected = lifecycle.marketingPlanSnapshot(original);
  assert.deepEqual(projected.items.map((item) => item.draftId), ["today", "last-day"]);
  assert.equal(original.items.length, 4, "the historical read model is not mutated");
  assert.deepEqual(projected.planDraftIds, original.planDraftIds, "historical plan membership remains available to other consumers");
});

function memoryPlanner() {
  const drafts = new Map();
  let sequence = 0;
  return {
    drafts,
    ports: {
      async ensurePlan() { return "plan-1"; },
      async listItems() { return [...drafts.values()]; },
      async generateContent(slot) { return { concept: slot.slotKey, caption: "Caption", cta: null, hashtags: [], visualBrief: "Visual" }; },
      async createDraft({ planId, slot, content }) {
        const existing = drafts.get(slot.slotKey);
        if (existing) return existing;
        const item = { draftId: `draft-${++sequence}`, planId, slotKey: slot.slotKey, channel: slot.channel, format: slot.format, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" };
        drafts.set(slot.slotKey, item);
        return item;
      },
      async ensureMedia() { throw new Error("planning_only_must_not_generate_media"); },
      async requestApproval() { throw new Error("planning_only_must_not_request_approval"); },
      async autoApproveAndSchedule() { throw new Error("planning_only_must_not_schedule"); },
      async savePlanItems() {},
    },
  };
}

test("repeat replenishment stays idempotent and an advancing horizon adds only the newly uncovered date", async () => {
  const memory = memoryPlanner();
  const input = { now: NOW, timeZone: TZ, cadence: "daily", mode: "manual", goal: "Awareness", trigger: "replenish", selectedChannels: ["instagram", "tiktok", "youtube"] };
  const first = await rolling.ensureRollingPlan(memory.ports, input);
  const repeated = await rolling.ensureRollingPlan(memory.ports, input);
  const tomorrow = await rolling.ensureRollingPlan(memory.ports, { ...input, now: new Date(NOW.getTime() + 86_400_000) });
  assert.equal(first.created, 7);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.reused, 7);
  assert.equal(memory.drafts.size, 8);
  assert.equal(tomorrow.created, 1);
  assert.equal(tomorrow.reused, 6);
  assert.equal(lifecycle.planReplenishOutcome(repeated, snapshot()).state, "already_up_to_date");
  assert.equal(lifecycle.planReplenishOutcome(tomorrow, snapshot([], { today: "2026-09-24", planValidUntil: "2026-09-30" })).state, "added");
});

test("API and UI wire the authoritative lifecycle contract and exact user guidance", () => {
  for (const state of ["added", "already_up_to_date", "no_supported_social_channels_selected", "failed"]) {
    assert.match(lifecycleSource, new RegExp(state));
  }
  assert.match(routeSource, /planReplenishOutcome/);
  assert.match(workspaceSource, /Your marketing plan is already up to date/);
  assert.match(workspaceSource, /You have complete marketing coverage/);
  assert.match(workspaceSource, /Your plan is ready ✓/);
  assert.match(workspaceSource, /Choose your marketing channels/);
  assert.match(workspaceSource, /We couldn't replenish your plan/);
  assert.match(workspaceSource, /Your existing plan hasn't been changed\. Try again\./);
});
