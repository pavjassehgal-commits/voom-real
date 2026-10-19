/**
 * End-to-end acceptance test for the ONE executable marketing workflow.
 *
 * Real modules under test (no string matching):
 *   lib/voom/timezone.ts            — account-timezone date resolution
 *   lib/voom/cadence.ts             — cadence -> slot distribution
 *   lib/voom/workflow/rolling-plan  — the rolling plan engine
 *   lib/voom/workflow/state.ts      — the single status derivation
 *   lib/mara/autopilot-safety.ts    — the ONE deterministic safety evaluator
 *   lib/instagram/publish-flow.ts   — the EXISTING Instagram publish sequence
 *   lib/instagram/publishing.ts     — due-selection + duplicate protection
 *
 * Everything external is mocked in memory: no OpenRouter call, no paid media
 * generation, no Meta call, no Supabase. The fake store mirrors the real
 * service's persistence rules (slot-keyed upsert, calendar mirror, publish
 * queue) so the workflow's behaviour — not its wiring text — is asserted.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const tz = await import("../lib/voom/timezone.ts");
const cadenceMod = await import("../lib/voom/cadence.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");

function ensureInstagramPlan(ports, input) {
  return rolling.ensureRollingPlan(ports, { ...input, selectedChannels: input.selectedChannels ?? ["instagram"] });
}
const stateMod = await import("../lib/voom/workflow/state.ts");
const safety = await import("../lib/mara/autopilot-safety.ts");
const flow = await import("../lib/instagram/publish-flow.ts");
const pub = await import("../lib/instagram/publishing.ts");

// A deterministic Dubai date: 2026-09-12 09:00 local (= 05:00 UTC).
const NOW = new Date("2026-09-12T05:00:00.000Z");
const TZ = "Asia/Dubai";

// ---------------------------------------------------------------------------
// In-memory workflow store. One draft per slot is the ONLY copy of an item;
// the calendar and the publish queue are mirrors keyed by that draft id.
// ---------------------------------------------------------------------------

function createStore() {
  return {
    plans: new Map(),
    drafts: new Map(),      // draftId -> item
    bySlot: new Map(),      // `${planId}:${slotKey}` -> draftId
    media: new Map(),       // draftId -> { status }
    assets: new Set(),      // draftIds with stored bytes
    approvals: new Map(),   // draftId -> { status }
    calendar: new Map(),    // draftId -> calendarItemId
    queue: new Map(),       // draftId -> queue row
    seq: 0,
    generationCalls: 0,
    providerImageCalls: 0,
    metaPublishCalls: 0,
  };
}

/**
 * Ports that mirror lib/voom/workflow/service.ts against the fake store.
 * `mediaOutcome` lets a test simulate a provider failure.
 */
function createPorts(store, options = {}) {
  const mediaOutcome = options.mediaOutcome ?? (() => ({ ok: true }));
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
      // Mocked MARA: no provider call, no cost.
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
      const key = `${planId}:${slot.slotKey}`;
      // Idempotent on (plan, canonical slot identity) exactly like the real upsert.
      if (store.bySlot.has(key)) return store.drafts.get(store.bySlot.get(key));
      const draftId = `draft-${++store.seq}`;
      const item = {
        draftId, planId, slotKey: slot.slotKey, channel: slot.channel, format: slot.format, contentType: slot.contentType,
        concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft",
      };
      store.drafts.set(draftId, item);
      store.bySlot.set(key, draftId);
      return item;
    },

    async ensureMedia(item) {
      // Duplicate-charge protection: never generate twice for the same draft.
      if (store.assets.has(item.draftId)) return { ok: true, state: "exists" };
      const live = store.media.get(item.draftId);
      if (live && (live.status === "queued" || live.status === "processing")) return { ok: true, state: "exists" };
      store.providerImageCalls += 1;
      const outcome = mediaOutcome(item);
      if (!outcome.ok) {
        store.media.set(item.draftId, { status: "failed" });
        return { ok: false, code: outcome.code ?? "provider_failed" };
      }
      store.media.set(item.draftId, { status: "completed" });
      store.assets.add(item.draftId);
      return { ok: true, state: "completed" };
    },

    async requestApproval(item) {
      if (item.status === "approved") return;
      if (store.approvals.has(item.draftId)) return;
      store.approvals.set(item.draftId, { status: "pending" });
    },

    async autoApproveAndSchedule(item) {
      const verdict = safety.evaluateAutopilotRecommendation(
        { title: item.concept, content: item.caption, publishAt: item.publishAt }, NOW,
      );
      if (!verdict.safe) return { approved: false, reason: verdict.blockers.join(",") };
      approveItem(store, item.draftId);
      // A safely auto-approved item must not stay sitting in Approvals.
      store.approvals.delete(item.draftId);
      return { approved: true };
    },

    async savePlanItems(planId, items) {
      store.plans.get(planId).plannedPosts = items.map((item) => ({ draftId: item.draftId, slotDate: item.slotKey }));
    },
  };
}

/** Approval advances the SAME item: calendar mirror, then publish queue. */
function approveItem(store, draftId) {
  const item = store.drafts.get(draftId);
  item.status = "approved";
  store.calendar.set(draftId, `cal-${draftId}`);
  // Only content Voom actually owns bytes for may be enqueued.
  if (!store.assets.has(draftId)) return;
  if (store.queue.has(draftId)) {
    const row = store.queue.get(draftId);
    if (row.status !== "published" && row.status !== "publishing") row.scheduledAt = item.publishAt;
    return;
  }
  store.queue.set(draftId, {
    id: `q-${draftId}`, draftId, status: "scheduled", scheduledAt: item.publishAt,
    attempts: 0, containerId: null, instagramMediaId: null, claimedAt: null,
    mediaKind: item.contentType === "reel" ? "reel" : item.contentType === "story" ? "story" : "image",
    caption: item.caption,
  });
}

/** The one status derivation every screen uses. */
function viewFor(store, draftId) {
  const item = store.drafts.get(draftId);
  const queueRow = store.queue.get(draftId);
  return stateMod.deriveWorkflowStatus({
    draftStatus: item.status,
    hasMedia: store.assets.has(draftId),
    mediaStatus: store.media.get(draftId)?.status ?? null,
    publishStatus: queueRow?.status ?? null,
    awaitingApproval: store.approvals.has(draftId),
  });
}

function calendarView(store) {
  return [...store.drafts.values()].map((item) => ({
    draftId: item.draftId,
    calendarItemId: store.calendar.get(item.draftId) ?? null,
    localDate: tz.isoToLocalDate(item.publishAt, TZ),
    localTime: tz.formatLocalTime(item.publishAt, TZ),
    platform: "Instagram",
    type: stateMod.contentTypeLabel(item.contentType),
    status: viewFor(store, item.draftId),
  }));
}

// ---------------------------------------------------------------------------
// Mocked Instagram publishing. Meta is never called for real.
// ---------------------------------------------------------------------------

function createPublishPorts(store, overrides = {}) {
  return {
    async loadDraft(_owner, draftId) {
      const item = store.drafts.get(draftId);
      return item ? { status: item.status, content: item.caption } : null;
    },
    async loadConnection() { return { status: "connected", scopes: [pub.INSTAGRAM_PUBLISH_PERMISSION], tokenExpiresAt: null }; },
    async loadCredentials() { return { igUserId: "ig-1", accessToken: "token" }; },
    async loadAsset(_owner, draftId) {
      return store.assets.has(draftId) ? { storagePath: `p/${draftId}.jpg`, mimeType: "image/jpeg", status: "uploaded" } : null;
    },
    async signMediaUrl(path) { return `https://signed.invalid/${path}`; },
    async createContainer() { return "container-1"; },
    async containerStatus() { return "FINISHED"; },
    async publishContainer() { store.metaPublishCalls += 1; return "ig-media-9001"; },
    async findPublishedMediaId() { return null; },
    async persistContainerId(item, containerId) { store.queue.get(item.draftId).containerId = containerId; },
    async markPublished(item, mediaId, containerId) {
      const row = store.queue.get(item.draftId);
      row.status = "published";
      row.instagramMediaId = mediaId;
      row.containerId = containerId;
      row.publishedAt = new Date().toISOString();
    },
    async markFailed(item, input) {
      const row = store.queue.get(item.draftId);
      row.status = input.status;
      row.failureCode = input.code;
      row.failureMessage = input.message;
      row.attempts += 1;
    },
    async sleep() {},
    now: () => NOW.getTime(),
    ...overrides,
  };
}

/** Claims only genuinely due items, exactly like the SQL claim predicate. */
function claimDue(store, now) {
  return [...store.queue.values()].filter((row) => pub.isDueForPublishing({
    status: row.status, scheduledAt: row.scheduledAt,
    draftStatus: store.drafts.get(row.draftId).status,
    attempts: row.attempts, instagramMediaId: row.instagramMediaId, claimedAt: row.claimedAt,
  }, now));
}

function toFlowItem(row) {
  return {
    id: row.id, ownerUserId: "owner-1", draftId: row.draftId, mediaKind: row.mediaKind,
    caption: row.caption, attempts: row.attempts, containerId: row.containerId,
    instagramMediaId: row.instagramMediaId,
  };
}

// ===========================================================================
// Autopilot · daily · awareness · fixed Dubai date
// ===========================================================================

test("Autopilot + daily cadence produces a 7-day executable plan starting today", async () => {
  const store = createStore();
  const result = await ensureInstagramPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness",
  });

  // 1) A 7-day plan with the correct number of daily items.
  assert.equal(result.slots, 7);
  assert.equal(result.created, 7);
  assert.equal(store.drafts.size, 7);

  const dates = [...store.drafts.values()].map((item) => tz.isoToLocalDate(item.publishAt, TZ));
  assert.deepEqual(dates, [
    "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
  ]);
  // The plan begins on the REAL current local date, never a stale one.
  assert.equal(dates[0], tz.localDate(NOW, TZ));

  // 2) MARA content exists for every item.
  assert.equal(store.generationCalls, 7);
  for (const item of store.drafts.values()) {
    assert.ok(item.concept.length > 0);
    assert.ok(item.caption.length > 0);
  }

  // 3) A media-generation job was created for each item, exactly once.
  assert.equal(result.mediaQueued, 7);
  assert.equal(store.providerImageCalls, 7);

  // 4) Safe content was auto-approved; nothing safe is left in Approvals.
  assert.equal(result.autoApproved, 7);
  assert.equal(store.approvals.size, 0);

  // 5) Items are scheduled with valid FUTURE times.
  assert.equal(store.queue.size, 7);
  for (const row of store.queue.values()) {
    assert.equal(row.status, "scheduled");
    assert.ok(Date.parse(row.scheduledAt) > NOW.getTime(), "no item may be scheduled in the past");
  }

  // 6) The same items appear on the Content Calendar with real local times.
  const calendar = calendarView(store);
  assert.equal(calendar.length, 7);
  for (const entry of calendar) {
    assert.ok(entry.calendarItemId, "every scheduled item has a real calendar row");
    assert.match(entry.localTime, /^\d{1,2}:\d{2}\s?(am|pm)$/i);
    assert.equal(entry.status, "scheduled");
    assert.ok(["Instagram Post", "Reel", "Instagram Story"].includes(entry.type));
  }
  // Calendar entries are the SAME workflow items — no duplicated copies.
  assert.deepEqual(
    calendar.map((entry) => entry.draftId).sort(),
    [...store.drafts.keys()].sort(),
  );

  // 7) Today shows today's scheduled item.
  const today = calendar.filter((entry) => entry.localDate === tz.localDate(NOW, TZ));
  assert.equal(today.length, 1);

  // 8) Only the due item is enqueued for Instagram publishing.
  const atDue = new Date(store.queue.get(today[0].draftId).scheduledAt).getTime() + 60_000;
  const due = claimDue(store, atDue);
  assert.equal(due.length, 1);
  assert.equal(due[0].draftId, today[0].draftId);

  // 9) After mocked provider success it is Published, exactly once.
  const ports = createPublishPorts(store);
  const outcome = await flow.runPublishFlow(toFlowItem(due[0]), ports);
  assert.equal(outcome.outcome, "published", JSON.stringify(outcome));
  assert.equal(store.metaPublishCalls, 1);
  assert.equal(viewFor(store, due[0].draftId), "published");

  // 10) Re-running the worker never publishes the same item twice.
  assert.equal(claimDue(store, atDue).length, 0);
  const rerun = await flow.runPublishFlow(toFlowItem(store.queue.get(due[0].draftId)), ports);
  assert.equal(rerun.outcome, "published");
  assert.equal(store.metaPublishCalls, 1, "a rerun must not call Meta again");
});

test("a second automation run on the same day reuses every item and creates nothing", async () => {
  const store = createStore();
  const input = { now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness" };
  await ensureInstagramPlan(createPorts(store), input);
  const generationsAfterFirst = store.generationCalls;
  const imagesAfterFirst = store.providerImageCalls;

  const second = await ensureInstagramPlan(createPorts(store), input);
  assert.equal(second.created, 0);
  assert.equal(second.reused, 7);
  assert.equal(store.drafts.size, 7, "no duplicate plan items");
  assert.equal(store.generationCalls, generationsAfterFirst, "no duplicate MARA generations");
  assert.equal(store.providerImageCalls, imagesAfterFirst, "no duplicate paid media generations");
});

test("the horizon rolls forward: a run one day later tops the plan back up", async () => {
  const store = createStore();
  const base = { timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness" };
  await ensureInstagramPlan(createPorts(store), { ...base, now: NOW });
  const tomorrow = new Date(NOW.getTime() + 86400000);
  const next = await ensureInstagramPlan(createPorts(store), { ...base, now: tomorrow });
  // Six existing days are reused; only the newly-visible day is created.
  assert.equal(next.reused, 6);
  assert.equal(next.created, 1);
  assert.equal(store.drafts.size, 8);
});

// ===========================================================================
// Cadence
// ===========================================================================

test("each cadence produces its own number and distribution of items", async () => {
  const expected = { daily: 7, "5x_week": 5, "3x_week": 3, weekly: 1 };
  for (const [cadence, count] of Object.entries(expected)) {
    const store = createStore();
    const result = await ensureInstagramPlan(createPorts(store), {
      now: NOW, timeZone: TZ, cadence, mode: "autopilot", goal: "awareness",
    });
    assert.equal(result.created, count, `${cadence} must create ${count} items`);
    const dates = [...store.drafts.values()].map((item) => tz.isoToLocalDate(item.publishAt, TZ));
    assert.equal(new Set(dates).size, count, `${cadence} must spread items across distinct days`);
    assert.equal(dates[0], "2026-09-12", `${cadence} must start today`);
    // Deterministic: the same inputs always produce the same distribution.
    assert.deepEqual(dates, cadenceMod.slotDates("2026-09-12", cadence));
  }
});

test("Manual mode creates nothing automatically", async () => {
  const store = createStore();
  const result = await ensureInstagramPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "daily", mode: "manual", goal: "awareness",
  });
  assert.equal(result.created, 0);
  assert.equal(store.drafts.size, 0);
  assert.equal(store.providerImageCalls, 0);
});

// ===========================================================================
// Assisted mode
// ===========================================================================

/**
 * The owner's explicit "Create with MARA" click on a planned card (Plans +
 * Credits v1: the ONLY way media is produced outside Autopilot). Mirrors what
 * the paid path leaves behind: a completed generation and stored bytes on the
 * SAME draft — no new item, no approval, no schedule.
 */
function produceMediaExplicitly(store, draftId) {
  store.providerImageCalls += 1;
  store.media.set(draftId, { status: "completed" });
  store.assets.add(draftId);
}

test("Assisted prepares content and waits; the owner's media + approval advance the SAME item (v1)", async () => {
  const store = createStore();
  const result = await ensureInstagramPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "3x_week", mode: "assisted", goal: "awareness",
  });
  assert.equal(result.created, 3);
  assert.equal(result.stage, "planning_only", "Assisted never reaches the paid stage on its own");
  assert.equal(result.autoApproved, 0);
  assert.equal(result.awaitingApproval, 0, "approval is asked for once media exists, not at planning");

  // Content exists; NO media was generated, nothing is scheduled or queued.
  assert.equal(store.generationCalls, 3);
  assert.equal(store.providerImageCalls, 0, "no paid generation without an explicit action");
  assert.equal(store.assets.size, 0);
  assert.equal(store.queue.size, 0);
  for (const draftId of store.drafts.keys()) assert.equal(viewFor(store, draftId), "planned");

  // The owner produces the visual on ONE planned card: the same item is now
  // ready for review, and only that one.
  const [first, ...others] = [...store.drafts.keys()];
  produceMediaExplicitly(store, first);
  assert.equal(store.providerImageCalls, 1, "exactly one paid generation, for the one click");
  assert.equal(viewFor(store, first), "ready_for_review");
  for (const id of others) assert.equal(viewFor(store, id), "planned");
  assert.equal(store.drafts.size, 3, "producing media must not create another item");

  // Approving advances the SAME draft — no second copy is created anywhere.
  approveItem(store, first);
  assert.equal(viewFor(store, first), "scheduled");
  assert.equal(store.drafts.size, 3, "approval must not create another item");
  assert.equal(store.calendar.get(first), `cal-${first}`);
  assert.equal(store.queue.get(first).status, "scheduled");
  // The other two genuinely still need the owner's action.
  assert.equal([...store.drafts.keys()].filter((id) => viewFor(store, id) === "planned").length, 2);
});

test("editing the caption and time before approval updates the same workflow item", async () => {
  const store = createStore();
  await ensureInstagramPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "weekly", mode: "assisted", goal: "awareness",
  });
  const [draftId] = [...store.drafts.keys()];
  const edited = tz.localToUtcIso("2026-09-14", 19 * 60, TZ);
  const item = store.drafts.get(draftId);
  item.caption = "An edited caption in the brand voice.";
  item.publishAt = edited;

  // Only content Voom owns bytes for may be enqueued: the owner produces the
  // visual first (v1), then approves — still the one item.
  produceMediaExplicitly(store, draftId);
  approveItem(store, draftId);
  assert.equal(store.drafts.size, 1);
  assert.equal(store.queue.get(draftId).scheduledAt, edited);
  assert.equal(store.queue.get(draftId).caption, "An edited caption in the brand voice.");
  assert.equal(tz.isoToLocalDate(edited, TZ), "2026-09-14");
});

// ===========================================================================
// Safety
// ===========================================================================

test("Autopilot never bypasses the safety evaluator: risky content stays in Approvals", async () => {
  const store = createStore();
  const risky = (slot) => slot.index === 0
    ? "Get 30% off everything today — guaranteed best prices in Dubai!"
    : "A calm look at our work today. Visit us this week.";
  const result = await ensureInstagramPlan(createPorts(store, { captionFor: risky }), {
    now: NOW, timeZone: TZ, cadence: "3x_week", mode: "autopilot", goal: "awareness",
  });
  assert.equal(result.heldForReview, 1);
  assert.equal(result.autoApproved, 2);
  const risked = [...store.drafts.values()].find((item) => item.caption.includes("30%"));
  assert.equal(viewFor(store, risked.draftId), "needs_approval");
  assert.ok(!store.queue.has(risked.draftId), "risky content is never scheduled for publishing");
});

// ===========================================================================
// Failures
// ===========================================================================

test("a media failure does not kill the workflow and is visible with a failed stage", async () => {
  const store = createStore();
  const result = await ensureInstagramPlan(
    createPorts(store, { mediaOutcome: (item) => item.slotKey === "2026-09-13|instagram_reel" ? { ok: false, code: "provider_down" } : { ok: true } }),
    { now: NOW, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness" },
  );
  // The rest of the horizon still completes.
  assert.equal(result.created, 7);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].stage, "media");

  const failed = [...store.drafts.values()].find((item) => item.slotKey === "2026-09-13|instagram_reel");
  assert.equal(viewFor(store, failed.draftId), "failed");
  assert.ok(!store.queue.has(failed.draftId), "an item with no media is never enqueued to Instagram");
  assert.equal(store.queue.size, 6);
});

test("a retry after a media failure does not double-charge, and a publish failure is retryable without duplicates", async () => {
  const store = createStore();
  let fail = true;
  const ports = createPorts(store, { mediaOutcome: () => (fail ? { ok: false, code: "provider_down" } : { ok: true }) });
  await ensureInstagramPlan(ports, { now: NOW, timeZone: TZ, cadence: "weekly", mode: "autopilot", goal: "awareness" });
  assert.equal(store.providerImageCalls, 1);

  // Retry: the media succeeds this time, and exactly one more paid call is made.
  fail = false;
  await ensureInstagramPlan(ports, { now: NOW, timeZone: TZ, cadence: "weekly", mode: "autopilot", goal: "awareness" });
  assert.equal(store.providerImageCalls, 2);
  const [draftId] = [...store.drafts.keys()];
  assert.equal(store.assets.has(draftId), true);

  // A third run must not pay again now that Voom owns the bytes.
  await ensureInstagramPlan(ports, { now: NOW, timeZone: TZ, cadence: "weekly", mode: "autopilot", goal: "awareness" });
  assert.equal(store.providerImageCalls, 2);

  // A transient Meta failure is retryable and still publishes exactly once.
  const row = store.queue.get(draftId);
  row.status = "scheduled";
  let attempt = 0;
  const publishPorts = createPublishPorts(store, {
    async publishContainer() {
      attempt += 1;
      if (attempt === 1) throw new Error("meta_timeout");
      store.metaPublishCalls += 1;
      return "ig-media-7";
    },
  });
  const first = await flow.runPublishFlow(toFlowItem(row), publishPorts);
  assert.equal(first.outcome, "retrying");
  assert.equal(store.metaPublishCalls, 0);
  const second = await flow.runPublishFlow(toFlowItem(store.queue.get(draftId)), publishPorts);
  assert.equal(second.outcome, "published");
  assert.equal(store.metaPublishCalls, 1);
  // The same container is reused, so Instagram never receives two posts.
  assert.equal(store.queue.get(draftId).containerId, "container-1");
});

// ===========================================================================
// Timezone / date boundaries
// ===========================================================================

test("stale historical dates can never appear in the plan", async () => {
  // 23:30 Dubai: today's usual evening slot has already passed.
  const lateNight = new Date("2026-09-12T19:30:00.000Z");
  const store = createStore();
  await ensureInstagramPlan(createPorts(store), {
    now: lateNight, timeZone: TZ, cadence: "daily", mode: "autopilot", goal: "awareness",
  });
  const today = tz.localDate(lateNight, TZ);
  for (const item of store.drafts.values()) {
    assert.ok(Date.parse(item.publishAt) > lateNight.getTime(), `${item.publishAt} must be in the future`);
    assert.ok(tz.isoToLocalDate(item.publishAt, TZ) >= today, "no item may sit on a past local date");
  }
});

test("the UTC/Dubai day boundary resolves to the real local date on both sides", () => {
  assert.equal(tz.localDate(new Date("2026-09-12T19:59:59Z"), TZ), "2026-09-12");
  assert.equal(tz.localDate(new Date("2026-09-12T20:00:00Z"), TZ), "2026-09-13");
  // A 6:30 PM Dubai slot is 14:30 UTC — the offset is resolved, not hardcoded.
  assert.equal(tz.localToUtcIso("2026-09-12", 18 * 60 + 30, TZ), "2026-09-12T14:30:00.000Z");
  // A timezone-less or unknown account still resolves to Asia/Dubai.
  assert.equal(tz.accountTimezone(undefined), "Asia/Dubai");
  assert.equal(tz.accountTimezone("Mars/Olympus"), "Asia/Dubai");
});

test("every workflow status is derived from real facts, with Published never regressing", () => {
  const base = { draftStatus: "draft", hasMedia: false, mediaStatus: null, publishStatus: null, awaitingApproval: false };
  assert.equal(stateMod.deriveWorkflowStatus(base), "planned");
  assert.equal(stateMod.deriveWorkflowStatus({ ...base, mediaStatus: "processing" }), "generating");
  assert.equal(stateMod.deriveWorkflowStatus({ ...base, awaitingApproval: true }), "needs_approval");
  assert.equal(stateMod.deriveWorkflowStatus({ ...base, draftStatus: "approved", hasMedia: true, publishStatus: "scheduled" }), "scheduled");
  assert.equal(stateMod.deriveWorkflowStatus({ ...base, draftStatus: "approved", publishStatus: "publishing" }), "publishing");
  assert.equal(stateMod.deriveWorkflowStatus({ ...base, draftStatus: "approved", publishStatus: "published" }), "published");
  assert.equal(stateMod.deriveWorkflowStatus({ ...base, mediaStatus: "failed" }), "failed");
  assert.equal(stateMod.deriveWorkflowStatus({ ...base, publishStatus: "failed" }), "failed");
  // Only "needs approval" belongs in Approvals.
  assert.equal(stateMod.requiresApproval("needs_approval"), true);
  assert.equal(stateMod.requiresApproval("scheduled"), false);
  assert.equal(stateMod.requiresApproval("published"), false);
});
