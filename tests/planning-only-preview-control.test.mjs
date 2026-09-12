/**
 * The temporary "Preview 7-Day Plan (No Media)" control on the Marketing Plan.
 *
 * What is proven here, and how:
 *
 *   1. BEHAVIOURALLY — the real client helper (lib/voom/planning-only-preview.ts)
 *      is executed against a recording fake fetch, so the request the button
 *      sends is asserted exactly: one POST to /api/plan with the complete body
 *      {"stage":"planning_only"} and nothing else.
 *   2. BEHAVIOURALLY — the summary the panel renders is produced from a REAL
 *      planning-only run of the real rolling-plan engine (lib/voom/workflow/
 *      rolling-plan.ts) driven through the same helper, so created / reused /
 *      horizon totals / cadence / timezone / slot dates, times and content
 *      types are the real engine's, not fixtures.
 *   3. The control cannot reach the full workflow: the preview action never
 *      sends the full handler's payload, and the run it renders provably stops
 *      before media generation, approval, calendar scheduling, the Instagram
 *      queue and publishing.
 *
 * The React files themselves are asserted on source, following the existing
 * suites: bare Node cannot render .tsx. No network, no Supabase, no provider,
 * nothing paid for, nothing published.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const preview = await import("../lib/voom/planning-only-preview.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const tz = await import("../lib/voom/timezone.ts");

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// A deterministic Dubai date: 2026-09-12 09:00 local (= 05:00 UTC).
const NOW = new Date("2026-09-12T05:00:00.000Z");
const TZ = "Asia/Dubai";
const EXPECTED_DATES = [
  "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15",
  "2026-09-16", "2026-09-17", "2026-09-18",
];

// ---------------------------------------------------------------------------
// 1. The exact request the button sends
// ---------------------------------------------------------------------------

/** A recording fetch: mirrors the browser API the helper calls. */
function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return { calls, fetchImpl };
}

const planningRun = (overrides = {}) => ({
  stage: "planning_only",
  planId: "plan-1",
  created: 6,
  reused: 1,
  slots: 7,
  mediaQueued: 0,
  awaitingApproval: 0,
  autoApproved: 0,
  heldForReview: 0,
  plan: {
    cadence: "daily",
    timeZone: TZ,
    horizonDays: 7,
    validFrom: "2026-09-12",
    validUntil: "2026-09-18",
    items: EXPECTED_DATES.map((slot, index) => ({
      slot,
      publishAt: tz.localToUtcIso(slot, 18 * 60 + 30, TZ),
      localDate: slot,
      localTime: tz.formatLocalTime(tz.localToUtcIso(slot, 18 * 60 + 30, TZ), TZ),
      contentType: "post",
      draftId: `draft-${index}`,
      created: index !== 0,
    })),
  },
  ...overrides,
});

test("the preview button sends exactly POST /api/plan with {\"stage\":\"planning_only\"}", async () => {
  const run = planningRun();
  const { calls, fetchImpl } = recordingFetch(async () => ({ ok: true, json: async () => ({ run }) }));

  const result = await preview.requestPlanningOnlyPreview(fetchImpl);

  assert.equal(result, run, "the returned planning summary is what the UI renders");
  assert.equal(calls.length, 1, "exactly one request, no follow-up call");
  assert.equal(calls[0].url, "/api/plan");
  assert.equal(calls[0].init.method, "POST");

  // The body is the whole contract: exact bytes, exactly one key.
  assert.equal(calls[0].init.body, '{"stage":"planning_only"}');
  assert.deepEqual(JSON.parse(calls[0].init.body), { stage: "planning_only" });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), ["stage"]);
  assert.equal(preview.PLANNING_ONLY_BODY, '{"stage":"planning_only"}');
  assert.equal(preview.PLANNING_ONLY_ENDPOINT, "/api/plan");

  // Nothing else travels with it: no owner identity, no cadence, no stage
  // override, no credentials, no custom headers.
  assert.doesNotMatch(calls[0].init.body, /owner|user|userId|cadence|full|media|approve|publish|calendar/i);
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(Object.keys(calls[0].init).sort(), ["body", "headers", "method"]);
});

test("the preview control never sends the full workflow action's payload", async () => {
  // The normal replenish/cadence handler posts { cadence }. The preview must
  // never produce that, and must never fire a second request of any kind.
  const { calls, fetchImpl } = recordingFetch(async () => ({
    ok: true, json: async () => ({ run: planningRun() }),
  }));

  await preview.requestPlanningOnlyPreview(fetchImpl);
  await preview.requestPlanningOnlyPreview(fetchImpl);

  assert.equal(calls.length, 2, "one request per click, and nothing else");
  for (const call of calls) {
    assert.equal(call.url, "/api/plan");
    assert.equal(call.init.body, '{"stage":"planning_only"}');
    assert.notEqual(JSON.parse(call.init.body).cadence, "daily");
    assert.equal(JSON.parse(call.init.body).cadence, undefined, "no cadence: the full handler's key");
    assert.equal(JSON.parse(call.init.body).stage, "planning_only");
  }
  // No request reached any other endpoint (no media, approval, calendar,
  // queue or publish route is ever called by this control).
  assert.deepEqual([...new Set(calls.map((call) => call.url))], ["/api/plan"]);
});

test("a failed or non-planning-only response raises instead of rendering a full run", async () => {
  const errorCase = recordingFetch(async () => ({
    ok: false, json: async () => ({ error: "Voom is already building your content." }),
  }));
  await assert.rejects(
    () => preview.requestPlanningOnlyPreview(errorCase.fetchImpl),
    /already building/,
  );
  assert.equal(errorCase.calls.length, 1, "no retry against another endpoint");

  // A full run can never be shown in the preview panel.
  const fullCase = recordingFetch(async () => ({
    ok: true, json: async () => ({ run: planningRun({ stage: "full", mediaQueued: 7, autoApproved: 7 }) }),
  }));
  await assert.rejects(
    () => preview.requestPlanningOnlyPreview(fullCase.fetchImpl),
    /full workflow run/,
  );
  assert.equal(fullCase.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 2. The summary the panel renders comes from a real planning-only run
// ---------------------------------------------------------------------------

/** In-memory ports for the real engine, counting every stage it reaches. */
function createPorts(store) {
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
      store.plans.set(id, { id, validFrom, validUntil });
      return id;
    },
    async listItems() {
      return [...store.drafts.values()];
    },
    async generateContent(slot) {
      store.copy += 1;
      return {
        concept: `${slot.contentType} idea ${slot.index}`,
        caption: "A calm look at our work today. Visit us this week.",
        cta: "Visit us this week",
        hashtags: ["#dubai"],
        visualBrief: "Warm natural light, clean composition, no text.",
      };
    },
    async createDraft({ slot, content }) {
      if (store.bySlot.has(slot.date)) return store.drafts.get(store.bySlot.get(slot.date));
      const draftId = `draft-${++store.seq}`;
      const item = {
        draftId,
        slotKey: slot.date,
        contentType: slot.contentType,
        concept: content.concept,
        caption: content.caption,
        publishAt: slot.publishAt,
        status: "draft",
      };
      store.drafts.set(draftId, item);
      store.bySlot.set(slot.date, draftId);
      return item;
    },
    async ensureMedia() {
      store.media += 1;
      return { ok: true };
    },
    async requestApproval() {
      store.approvals += 1;
    },
    async autoApproveAndSchedule() {
      store.autoApproved += 1;
      store.calendar += 1;
      store.queue += 1;
      return { approved: true };
    },
    async savePlanItems() {
      store.saved += 1;
    },
  };
}

function createStore() {
  return {
    plans: new Map(), drafts: new Map(), bySlot: new Map(), seq: 0,
    copy: 0, media: 0, approvals: 0, autoApproved: 0, calendar: 0, queue: 0, saved: 0,
  };
}

test("the panel can display a real planning-only run: counts, cadence, timezone and every slot", async () => {
  const store = createStore();

  // One slot already exists, so the run reuses it and creates the other six.
  const seeded = {
    draftId: "draft-seeded", slotKey: "2026-09-12", contentType: "post",
    concept: "Seeded post", caption: "An existing caption. Visit us this week.",
    publishAt: tz.localToUtcIso("2026-09-12", 18 * 60 + 30, TZ), status: "draft",
  };
  store.drafts.set(seeded.draftId, seeded);
  store.bySlot.set(seeded.slotKey, seeded.draftId);

  const run = await rolling.ensureRollingPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "awareness", stage: "planning_only",
  });
  assert.equal(run.stage, "planning_only");

  // The real engine output goes through the real client helper, exactly as it
  // would after a click.
  const { fetchImpl } = recordingFetch(async () => ({ ok: true, json: async () => ({ run }) }));
  const summary = preview.planningPreviewSummary(await preview.requestPlanningOnlyPreview(fetchImpl));

  // Everything the task requires on screen.
  assert.equal(summary.created, 6, "created count");
  assert.equal(summary.reused, 1, "reused count");
  assert.equal(summary.totalItems, 7, "total horizon items");
  assert.equal(summary.cadenceLabel, "Daily", "cadence");
  assert.equal(summary.timeZone, TZ, "timezone");
  assert.equal(summary.horizonDays, 7);
  assert.equal(summary.validFrom, "2026-09-12");
  assert.equal(summary.validUntil, "2026-09-18");
  assert.deepEqual(summary.slots.map((slot) => slot.localDate), EXPECTED_DATES, "slot dates");
  for (const slot of summary.slots) {
    assert.match(slot.localTime, /^\d{1,2}:\d{2}\s?(am|pm)$/i, "slot times");
    assert.ok(
      ["Instagram Post", "Reel", "Instagram Story"].includes(slot.contentTypeLabel),
      "content types",
    );
  }
  assert.deepEqual(
    summary.slots.map((slot) => slot.created),
    [false, true, true, true, true, true, true],
    "the reused slot is marked reused",
  );

  // And the run it displays provably stopped before everything downstream.
  assert.equal(summary.mediaQueued, 0, "no paid media generation");
  assert.equal(summary.autoApproved, 0, "no approval");
  assert.equal(summary.awaitingApproval, 0, "no approval queue");
  assert.equal(summary.heldForReview, 0);
  assert.equal(store.media, 0, "ensureMedia never invoked");
  assert.equal(store.approvals, 0, "no approval record");
  assert.equal(store.autoApproved, 0, "no Autopilot evaluation");
  assert.equal(store.calendar, 0, "no Calendar scheduling");
  assert.equal(store.queue, 0, "no Instagram queue entry");
  for (const item of store.drafts.values()) {
    assert.equal(item.status, "draft", "no publishing state change");
  }
});

test("an empty planning run still renders safely", () => {
  const summary = preview.planningPreviewSummary({
    stage: "planning_only", planId: null, created: 0, reused: 0, slots: 0,
    mediaQueued: 0, awaitingApproval: 0, autoApproved: 0, heldForReview: 0, plan: null,
  });
  assert.equal(summary.totalItems, 0);
  assert.deepEqual(summary.slots, []);
  assert.equal(summary.validFrom, null);
});

// ---------------------------------------------------------------------------
// 3. Where the control lives, and what it must never touch
// ---------------------------------------------------------------------------

test("the Marketing Plan button is the preview action only, never the full replenish handler", async () => {
  const [workspace, control, helper, shellLayout, planPage] = await Promise.all([
    read("components/voom/operating/PlanWorkspace.tsx"),
    read("components/voom/operating/PlanningOnlyPreview.tsx"),
    read("lib/voom/planning-only-preview.ts"),
    read("app/app/(shell)/layout.tsx"),
    read("app/app/(shell)/plan/page.tsx"),
  ]);

  // It lives in the authenticated Marketing Plan UI, behind the app shell that
  // redirects anyone without a real owner session.
  assert.match(planPage, /PlanWorkspace/);
  assert.match(workspace, /PlanningOnlyPreviewCard/);
  assert.match(shellLayout, /getBusinessRecord\(\)/);
  assert.match(shellLayout, /redirect\("\/app\/onboarding"\)/);

  // The label is the one that was asked for, and it is rendered.
  assert.match(control, /PLANNING_ONLY_PREVIEW_LABEL = "Preview 7-Day Plan \(No Media\)"/);
  assert.match(control, /\{busy \? "Previewing…" : PLANNING_ONLY_PREVIEW_LABEL\}/);

  // The button's handler is the preview action — it can never call `build`,
  // the existing full replenish/cadence handler in PlanWorkspace. The request
  // goes through the in-flight gate, and a gate-rejected click sends nothing.
  assert.match(control, /onClick=\{\(\) => void previewPlan\(\)\}/);
  const handler = control.slice(control.indexOf("async function previewPlan()"));
  const body = handler.slice(0, handler.indexOf("\n  }\n"));
  assert.match(body, /beginPlanningOnlyPreview\(\)/);
  assert.match(body, /if \(!request\) return;/);
  assert.doesNotMatch(body, /\bbuild\(/);
  assert.doesNotMatch(body, /cadence/);
  assert.doesNotMatch(control, /\bbuild\(/);
  assert.doesNotMatch(control, /CADENCE|normalizeCadence/);
  // One click cannot fire twice: the gated entry is the only request path in
  // the control, the button is a plain (non-submit) button, and it renders
  // disabled for the whole in-flight window.
  assert.doesNotMatch(control, /requestPlanningOnlyPreview/);
  assert.match(control, /type="button"/);
  assert.match(control, /disabled=\{busy\}/);

  // Nothing in the temporary control reaches media, approval, calendar,
  // queueing or publishing — and no owner identity is ever sent.
  for (const src of [control, helper]) {
    assert.doesNotMatch(src, /ownerId|owner_user_id|userId|user_id|getCurrentUser/);
    assert.doesNotMatch(src, /mara_media_generations|ensureMedia|generateImage|generateVideo|MagicHour/);
    assert.doesNotMatch(src, /requestApproval|approvePostDraft|mara_pending_actions|autoApproveAndSchedule/);
    assert.doesNotMatch(src, /content_calendar_items|syncPostToCalendar|instagram_publish_queue|publishContainer|publishToInstagram/);
    assert.doesNotMatch(src, /supabase\/migrations|\.insert\(|\.update\(|\.upsert\(/);
    assert.doesNotMatch(src, /"stage":\s*"(full|publishing|scheduled)"/);
  }

  // The helper only ever performs the one planning-only request.
  assert.match(helper, /body: PLANNING_ONLY_BODY/);
  assert.match(helper, /PLANNING_ONLY_BODY = JSON\.stringify\(\{ stage: "planning_only" \}\)/);
  assert.doesNotMatch(helper, /stage:\s*"(full|scheduled|publishing)"/);
});

// ---------------------------------------------------------------------------
// 4. One click can never issue a second planning request (regression: two
//    POST /api/plan planning-only runs 40s apart from one click).
// ---------------------------------------------------------------------------

/** A fetch that records the call and holds the first one open until resolved. */
function deferredFetch() {
  const calls = [];
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return pending;
  };
  return { calls, fetchImpl, resolve: settle };
}

test("one click cannot start a second planning request while the first is in flight", async () => {
  const first = deferredFetch();

  const started = preview.beginPlanningOnlyPreview(first.fetchImpl);
  assert.ok(started, "the first click starts exactly one request");
  assert.equal(first.calls.length, 1, "one POST is on the wire");
  assert.equal(first.calls[0].url, "/api/plan");
  assert.equal(first.calls[0].init.method, "POST");
  assert.equal(first.calls[0].init.body, '{"stage":"planning_only"}');
  assert.equal(preview.planningOnlyPreviewInFlight(), true);

  // Every duplicate path — a second click before React commits `busy`, a
  // double-tap, or a click from a remounted card — is refused by the gate and
  // sends nothing while the first request is still running.
  assert.equal(preview.beginPlanningOnlyPreview(first.fetchImpl), null, "in-flight clicks send nothing");
  assert.equal(first.calls.length, 1, "still exactly one POST while in flight");

  first.resolve({ ok: true, json: async () => ({ run: planningRun() }) });
  assert.equal((await started).created, planningRun().created);
  assert.equal(preview.planningOnlyPreviewInFlight(), false, "the gate reopens once the run settles");

  // And the next click afterwards starts a fresh single request again.
  const later = recordingFetch(async () => ({ ok: true, json: async () => ({ run: planningRun() }) }));
  await preview.beginPlanningOnlyPreview(later.fetchImpl);
  assert.equal(later.calls.length, 1);
});

test("a failed preview clears the gate so the next click can retry cleanly", async () => {
  const failing = recordingFetch(async () => ({ ok: false, json: async () => ({ error: "Voom is already building your content." }) }));
  const attempt = preview.beginPlanningOnlyPreview(failing.fetchImpl);
  assert.equal(preview.beginPlanningOnlyPreview(failing.fetchImpl), null, "still guarded while the failure is in flight");
  assert.equal(failing.calls.length, 1, "no retry storm");
  await assert.rejects(() => attempt, /already building/);
  assert.equal(preview.planningOnlyPreviewInFlight(), false, "a rejection also reopens the gate");

  const retry = recordingFetch(async () => ({ ok: true, json: async () => ({ run: planningRun() }) }));
  await preview.beginPlanningOnlyPreview(retry.fetchImpl);
  assert.equal(retry.calls.length, 1, "the next click works again");
});

test("the preview button is a plain, disabled-while-busy button rendered by a real <button>", async () => {
  const [control, primitives] = await Promise.all([
    read("components/voom/operating/PlanningOnlyPreview.tsx"),
    read("components/voom/ui/primitives.tsx"),
  ]);
  // The control renders disabled for the whole in-flight window…
  assert.match(control, /disabled=\{busy\}/);
  assert.match(control, /setBusy\(true\)/);
  assert.match(control, /finally\s*\{\s*setBusy\(false\);/);
  // …and can never act as an implicit form submit.
  assert.match(control, /<Btn type="button"/);
  // Btn passes `disabled` straight onto a native <button>, which the browser
  // refuses to click while disabled.
  assert.match(primitives, /<button\s*\n?\s*className=/);
  assert.match(primitives, /\{\.\.\.props\}/);
  assert.match(primitives, /disabled:pointer-events-none/);
});

test("backend planning-only idempotency is unchanged: a second run reuses every slot", async () => {
  // Two consecutive planning-only runs of the REAL engine against one store:
  // the second reuses all 7 slots and creates nothing, and the run still stops
  // before media, approval, calendar, queue and publishing.
  const store = createStore();
  const first = await rolling.ensureRollingPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "g", stage: "planning_only",
  });
  assert.equal(first.stage, "planning_only");
  assert.equal(first.created, 7);
  assert.equal(first.reused, 0);
  assert.equal(store.drafts.size, 7);

  const second = await rolling.ensureRollingPlan(createPorts(store), {
    now: NOW, timeZone: TZ, cadence: "daily", mode: "assisted", goal: "g", stage: "planning_only",
  });
  assert.equal(second.stage, "planning_only");
  assert.equal(second.created, 0);
  assert.equal(second.reused, 7, "the duplicate click's run reuses every existing slot");
  assert.equal(store.drafts.size, 7, "still exactly 7 drafts — no duplicates");
  assert.equal(store.media, 0, "no media jobs");
  assert.equal(store.approvals, 0, "no approval records");
  assert.equal(store.autoApproved, 0);
  assert.equal(store.calendar, 0);
  assert.equal(store.queue, 0);

  // The route still scopes the run to the authenticated owner, still maps only
  // the explicit planning-only stage, and the service still upserts
  // idempotently on (owner, plan, slot date).
  const [route, service] = await Promise.all([read("app/api/plan/route.ts"), read("lib/voom/workflow/service.ts")]);
  assert.match(route, /body\.stage === "planning_only"/);
  assert.match(route, /runOwnerWorkflow\(admin, \{ ownerId: user\.id, cadence, mode, stage \}\)/);
  assert.match(service, /onConflict: "owner_user_id,source_plan_id,source_plan_item_key"/);
  assert.match(service, /ignoreDuplicates: true/);
});
