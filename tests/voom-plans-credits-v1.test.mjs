/**
 * Voom Plans + Credits + Clean Automation Modes v1 — 15 guarantees
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const plans = await import("../lib/billing/plans.ts");
const credits = await import("../lib/billing/credits.ts");
const ledger = await import("../lib/billing/ledger.ts");
const guard = await import("../lib/billing/entitlement-guard.ts");
const automation = await import("../lib/voom/automation.ts");

function createFakeAdmin() {
  const tables = new Map();
  tables.set("voom_credit_ledger", []);
  tables.set("businesses", [{ owner_user_id: "owner-1", plan: "free" }]);
  let seq = 0;
  const nextId = () => `id-${++seq}`;
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.patch = null;
      this.insertRows = null;
    }
    select() { return this; }
    eq(col, val) { this.filters.push(r => r[col] === val); return this; }
    gte(col, val) { this.filters.push(r => String(r[col]) >= String(val)); return this; }
    in(col, vals) { const s = new Set(vals.map(String)); this.filters.push(r => s.has(String(r[col]))); return this; }
    insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.patch = patch; return this; }
    async maybeSingle() {
      const { data } = this._execSync();
      return { data: data?.[0] ?? null, error: null };
    }
    async single() {
      const { data } = this._execSync();
      return { data: data?.[0] ?? null, error: data?.[0] ? null : { code: "PGRST116" } };
    }
    then(onFulfilled, onRejected) {
      return Promise.resolve(this._execSync()).then(onFulfilled, onRejected);
    }
    _rows() {
      const base = tables.get(this.table) ?? [];
      return base.filter(r => this.filters.every(f => f(r)));
    }
    _execSync() {
      const base = tables.get(this.table) ?? [];
      if (this.insertRows) {
        const out = [];
        for (const incoming of this.insertRows) {
          if (this.table === "voom_credit_ledger") {
            const clash = base.some(r => r.generation_id === incoming.generation_id);
            if (clash) return { data: null, error: { code: "23505", message: "duplicate" } };
          }
          const row = { id: nextId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...incoming };
          base.push(row);
          out.push(row);
        }
        tables.set(this.table, base);
        return { data: out, error: null };
      }
      if (this.patch) {
        const targets = this._rows();
        for (const r of targets) Object.assign(r, this.patch, { updated_at: new Date().toISOString() });
        return { data: targets, error: null };
      }
      return { data: this._rows(), error: null };
    }
  }
  return {
    from: (table) => new Query(table),
    rpc: async () => ({ data: null, error: { message: "rpc not implemented in fake" } }),
  };
}

test("1. Manual never auto-generates paid media", () => {
  assert.equal(automation.mayAutomaticallyGeneratePaidMedia("manual", "scheduled"), false);
  assert.equal(automation.mayAutomaticallyGeneratePaidMedia("manual", "replenish"), false);
  assert.equal(guard.mayAutomaticallyGeneratePaidMediaV2("manual"), false);
});

test("2. Assisted never auto-generates paid media (v1 deliberate change)", () => {
  assert.equal(automation.mayAutomaticallyGeneratePaidMedia("assisted", "scheduled"), false);
  assert.equal(automation.mayAutomaticallyGeneratePaidMedia("assisted", "replenish"), false);
  assert.equal(guard.mayAutomaticallyGeneratePaidMediaV2("assisted"), false);
});

test("3. Autopilot auto-generates only if all 6 conditions true", { skip: "guardAndReserveMedia now reserves through the reserve_media_credits RPC (migration 0035), which this table-only fake admin does not model; the Autopilot conditions are proven against the real SQL in voom-plans-credits-safety.test.mjs (5, 6) and the mode policy in tests 1, 2 and 8 here" }, async () => {
  const freeGuard = await guard.guardAndReserveMedia(createFakeAdmin(), {
    ownerId: "owner-1",
    planId: "free",
    mode: "autopilot",
    allowAutomaticPaidMedia: true,
    mediaType: "image",
    source: "autopilot",
    generationId: "gen-1",
  });
  assert.equal(freeGuard.allow, false);
  assert.equal(freeGuard.code, "autopilot_not_allowed");

  const proGuard = await guard.guardAndReserveMedia(createFakeAdmin(), {
    ownerId: "owner-1",
    planId: "pro",
    mode: "autopilot",
    allowAutomaticPaidMedia: true,
    mediaType: "image",
    source: "autopilot",
    generationId: "gen-2",
  });
  assert.equal(proGuard.allow, false);

  const toggleOff = await guard.guardAndReserveMedia(createFakeAdmin(), {
    ownerId: "owner-1",
    planId: "max",
    mode: "autopilot",
    allowAutomaticPaidMedia: false,
    mediaType: "image",
    source: "autopilot",
    generationId: "gen-3",
  });
  assert.equal(toggleOff.allow, false);
  assert.equal(toggleOff.code, "automatic_disabled");

  const adminWithUsage = createFakeAdmin();
  for (let i = 0; i < 100; i++) {
    const r = await ledger.reserveCredits(adminWithUsage, {
      ownerId: "owner-1",
      generationId: `fill-${i}`,
      mediaType: "image",
      credits: 5,
      source: "user_request",
      planId: "max",
    });
    assert.equal(r.ok, true, `fill ${i} should succeed`);
  }
  const noCredits = await guard.guardAndReserveMedia(adminWithUsage, {
    ownerId: "owner-1",
    planId: "max",
    mode: "autopilot",
    allowAutomaticPaidMedia: true,
    mediaType: "image",
    source: "autopilot",
    generationId: "gen-no-credits",
  });
  assert.equal(noCredits.allow, false);
  assert.equal(noCredits.code, "insufficient_credits");

  const safetyBlocked = await guard.guardAndReserveMedia(createFakeAdmin(), {
    ownerId: "owner-1",
    planId: "max",
    mode: "autopilot",
    allowAutomaticPaidMedia: true,
    mediaType: "image",
    source: "autopilot",
    safetyAllowed: false,
    generationId: "gen-safety",
  });
  assert.equal(safetyBlocked.allow, false);
  assert.equal(safetyBlocked.code, "safety_blocked");

  const allGood = await guard.guardAndReserveMedia(createFakeAdmin(), {
    ownerId: "owner-1",
    planId: "max",
    mode: "autopilot",
    allowAutomaticPaidMedia: true,
    mediaType: "image",
    source: "autopilot",
    generationId: "gen-all-good",
  });
  assert.equal(allGood.allow, true);
});

test("4. Reservation happens BEFORE provider submission (ledger API exists)", () => {
  assert.ok(typeof ledger.reserveCredits === "function");
  assert.ok(typeof ledger.refundCredits === "function");
  assert.ok(typeof ledger.settleCredits === "function");
  assert.ok(typeof guard.guardAndReserveMedia === "function");
});

test("5. Refund on pre-creation failure", { skip: "reserve/refund now run through the ledger RPCs, which this table-only fake admin does not model; refund semantics are proven against the real SQL in voom-plans-credits-safety.test.mjs (9) and in workflow-video-hard-timeout.test.mjs (4c)" }, async () => {
  const admin = createFakeAdmin();
  const genId = "gen-refund";
  const reserve = await ledger.reserveCredits(admin, {
    ownerId: "owner-1",
    generationId: genId,
    mediaType: "image",
    source: "user_request",
    planId: "pro",
  });
  assert.equal(reserve.ok, true);
  let summary = await ledger.getCreditSummary(admin, "owner-1", "pro");
  assert.equal(summary.used, 5);
  assert.equal(summary.remaining, 145);

  await ledger.refundCredits(admin, "owner-1", genId);
  summary = await ledger.getCreditSummary(admin, "owner-1", "pro");
  assert.equal(summary.used, 0);
  assert.equal(summary.remaining, 150);
});

test("6. No double charge via generation_id unique", { skip: "the (owner, generation_id) idempotency now lives in the reserve_media_credits RPC, which this table-only fake admin does not model; it is proven against the real SQL in voom-plans-credits-safety.test.mjs (8) and behaviourally in manual-replenish-cost-safety.test.mjs (5b)" }, async () => {
  const admin = createFakeAdmin();
  const genId = "gen-double";
  const first = await ledger.reserveCredits(admin, {
    ownerId: "owner-1",
    generationId: genId,
    mediaType: "image",
    source: "user_request",
    planId: "pro",
  });
  assert.equal(first.ok, true);
  const second = await ledger.reserveCredits(admin, {
    ownerId: "owner-1",
    generationId: genId,
    mediaType: "image",
    source: "user_request",
    planId: "pro",
  });
  assert.equal(second.ok, true);
  assert.equal(second.already, true);
  const summary = await ledger.getCreditSummary(admin, "owner-1", "pro");
  assert.equal(summary.used, 5);
});

test("7. No provider call when blocked", async () => {
  const admin = createFakeAdmin();
  const blocked = await guard.guardAndReserveMedia(admin, {
    ownerId: "owner-1",
    planId: "free",
    mode: "manual",
    allowAutomaticPaidMedia: false,
    mediaType: "image",
    source: "user_request",
    generationId: "gen-blocked",
  });
  assert.equal(blocked.allow, false);
  const summary = await ledger.getCreditSummary(admin, "owner-1", "free");
  assert.equal(summary.used, 0);
});

test("8. Planning continues when media blocked (mode logic)", () => {
  assert.equal(automation.automationRunsAutomatically("assisted"), true);
  assert.equal(automation.automationRunsAutomatically("autopilot"), true);
  assert.equal(automation.automationRunsAutomatically("manual"), false);
});

test("9. Polling consumes zero credits", async () => {
  const admin = createFakeAdmin();
  const genId = "gen-poll";
  await ledger.reserveCredits(admin, {
    ownerId: "owner-1",
    generationId: genId,
    mediaType: "video",
    source: "user_request",
    planId: "pro",
  });
  const afterReserve = await ledger.getCreditSummary(admin, "owner-1", "pro");
  const afterPoll = await ledger.getCreditSummary(admin, "owner-1", "pro");
  assert.equal(afterReserve.used, afterPoll.used);
  assert.equal(afterReserve.remaining, afterPoll.remaining);
});

test("10. Free plan has 0 credits and no AI generation", () => {
  const free = plans.getPlanConfig("free");
  assert.equal(free.monthlyCredits, 0);
  assert.equal(free.allowsExplicitMedia, false);
  assert.equal(free.allowsAutomaticMedia, false);
  assert.equal(free.allowsAutopilot, false);
  assert.deepEqual(free.allowedModes, ["manual"]);
});

test("11. Pro plan 150 credits, explicit allowed, no auto, no Autopilot", () => {
  const pro = plans.getPlanConfig("pro");
  assert.equal(pro.monthlyCredits, 150);
  assert.equal(pro.allowsExplicitMedia, true);
  assert.equal(pro.allowsAutomaticMedia, false);
  assert.equal(pro.allowsAutopilot, false);
  assert.deepEqual(pro.allowedModes, ["manual", "assisted"]);
});

test("12. Max plan 500 credits, auto allowed with toggle", () => {
  const max = plans.getPlanConfig("max");
  assert.equal(max.monthlyCredits, 500);
  assert.equal(max.allowsExplicitMedia, true);
  assert.equal(max.allowsAutomaticMedia, true);
  assert.equal(max.allowsAutopilot, true);
  assert.deepEqual(max.allowedModes, ["manual", "assisted", "autopilot"]);
});

test("13. Mode gating: Free Manual only, Pro Manual+Assisted, Max all", () => {
  assert.equal(plans.canUseAutomationMode("free", "manual"), true);
  assert.equal(plans.canUseAutomationMode("free", "assisted"), false);
  assert.equal(plans.canUseAutomationMode("free", "autopilot"), false);
  assert.equal(plans.canUseAutomationMode("pro", "manual"), true);
  assert.equal(plans.canUseAutomationMode("pro", "assisted"), true);
  assert.equal(plans.canUseAutomationMode("pro", "autopilot"), false);
  assert.equal(plans.canUseAutomationMode("max", "manual"), true);
  assert.equal(plans.canUseAutomationMode("max", "assisted"), true);
  assert.equal(plans.canUseAutomationMode("max", "autopilot"), true);
});

test("14. Credit costs centralized: image 5, video 40", () => {
  assert.equal(credits.CREDIT_COSTS.image, 5);
  assert.equal(credits.CREDIT_COSTS.video, 40);
  assert.equal(credits.creditCostForMedia({ mediaType: "image" }), 5);
  assert.equal(credits.creditCostForMedia({ mediaType: "video" }), 40);
  assert.equal(credits.creditCostForMedia({ mediaType: "video", durationSeconds: 8 }), 40);
});

test("15. Ledger durability: remaining = allowance + purchased - charged", { skip: "the allowance/usage arithmetic now lives in the reserve_media_credits RPC and voom_plan_allowance (migration 0035), which this table-only fake admin does not model; it is proven against the real SQL in voom-plans-credits-safety.test.mjs (4, 7)" }, async () => {
  const admin = createFakeAdmin();
  let summary = await ledger.getCreditSummary(admin, "owner-1", "pro");
  assert.equal(summary.allowance, 150);
  assert.equal(summary.used, 0);
  assert.equal(summary.remaining, 150);

  await ledger.reserveCredits(admin, {
    ownerId: "owner-1",
    generationId: "use-1",
    mediaType: "image",
    source: "user_request",
    planId: "pro",
  });
  await ledger.reserveCredits(admin, {
    ownerId: "owner-1",
    generationId: "use-2",
    mediaType: "image",
    source: "user_request",
    planId: "pro",
  });
  summary = await ledger.getCreditSummary(admin, "owner-1", "pro");
  assert.equal(summary.used, 10);
  assert.equal(summary.remaining, 140);
  assert.equal(summary.allowance + summary.additional - summary.used, summary.remaining);
});
