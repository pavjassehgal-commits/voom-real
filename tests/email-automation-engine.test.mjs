/**
 * Email Automation v2 — engine, creation pipeline and Coordinator wiring.
 *
 * This file exercises the TypeScript layers that sit on top of the database:
 * `createEmailFlow` / `proposeEmailFlow` (skeleton → MARA → validated flow),
 * `runEmailFlowsForOwner` (enrollment, the pre-send consent re-check, the claim
 * guard, the bounded retry) and the Coordinator's marketing state.
 *
 * What is faked here, and why that is honest:
 *   - `admin` is an in-memory PostgREST-shaped client. The RPC *semantics*
 *     (idempotency, double-send proof, suppression, revisions, RLS) are proven
 *     against real PostgreSQL in tests/email-automation-flows-pglite.test.mjs;
 *     this file proves the engine's CONTROL FLOW around those calls.
 *   - the Resend client is injected through the documented `send` seam, so no
 *     provider is reachable;
 *   - the AI provider is injected through the documented `deps.ai` seam.
 *
 * Hard assertions at the end: zero network calls, zero media-generation or
 * credit-reservation calls from any flow path.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const { createEmailFlow, proposeEmailFlow, coordinatorProposalKey } = await import("../lib/email-flows/create.ts");
const engine = await import("../lib/email-flows/engine.ts");
const { buildMarketingState } = await import("../lib/coordinator/state.ts");
const { evaluateMarketingNeeds } = await import("../lib/coordinator/engine.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const BIZ = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FLOW_ID = "ffff0000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "eeee0000-0000-4000-8000-000000000001";
const CONTACT_ID = "cccc0000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-20T08:00:00.000Z"); // 12:00 in Dubai, inside the window

// ─── Network + provider tripwires ──────────────────────────────────────────

const realFetch = globalThis.fetch;
let fetchCalls = 0;
const mediaCalls = [];

/**
 * The engine fails closed unless Resend is configured, so the send env is set
 * with placeholder values. Nothing can reach the provider: the client used by
 * the send adapter is injected below, and `fetch` throws if anything calls it.
 */
const RESEND_ENV = {
  EMAIL_PROVIDER_API_KEY: "re_test_placeholder_not_a_real_key",
  EMAIL_FROM_ADDRESS: "hello@synrapay.example",
  EMAIL_FROM_NAME: "SynraPay",
  EMAIL_WEBHOOK_SECRET: "whsec_test_placeholder",
};
const savedEnv = {};

test.before(() => {
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    throw new Error(`unexpected network call: ${String(args[0])}`);
  };
  for (const [name, value] of Object.entries(RESEND_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

test.after(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Runs the engine with the Resend env removed, to prove it fails closed. */
async function withSendEnvRemoved(runnable) {
  const stash = {};
  for (const name of Object.keys(RESEND_ENV)) {
    stash[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return await runnable();
  } finally {
    for (const [name, value] of Object.entries(stash)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ─── In-memory PostgREST-shaped admin client ───────────────────────────────

function createAdmin(tables, rpcImpl) {
  const store = structuredClone(tables);
  const rpcCalls = [];

  function match(row, filters) {
    return filters.every((filter) => {
      const value = row[filter.column];
      switch (filter.op) {
        case "eq": return String(value) === String(filter.value);
        case "neq": return String(value) !== String(filter.value);
        case "in": return filter.value.map(String).includes(String(value));
        case "lte": return String(value) <= String(filter.value);
        case "lt": return String(value) < String(filter.value);
        case "gte": return String(value) >= String(filter.value);
        case "gt": return String(value) > String(filter.value);
        case "notNull": return value !== null && value !== undefined;
        default: throw new Error(`unsupported filter ${filter.op}`);
      }
    });
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orderBy = null;
      this.rowLimit = null;
    }
    select() { return this; }
    eq(column, value) { this.filters.push({ op: "eq", column, value }); return this; }
    neq(column, value) { this.filters.push({ op: "neq", column, value }); return this; }
    in(column, value) { this.filters.push({ op: "in", column, value }); return this; }
    lte(column, value) { this.filters.push({ op: "lte", column, value }); return this; }
    lt(column, value) { this.filters.push({ op: "lt", column, value }); return this; }
    gte(column, value) { this.filters.push({ op: "gte", column, value }); return this; }
    gt(column, value) { this.filters.push({ op: "gt", column, value }); return this; }
    not(column, op) { if (op === "is") this.filters.push({ op: "notNull", column }); return this; }
    order(column, options = {}) { this.orderBy = { column, ascending: options.ascending !== false }; return this; }
    limit(n) { this.rowLimit = n; return this; }
    rows() {
      let rows = (store[this.table] ?? []).filter((row) => match(row, this.filters));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        rows = [...rows].sort((a, b) => {
          const left = a[column] ?? "";
          const right = b[column] ?? "";
          return ascending ? String(left).localeCompare(String(right)) : String(right).localeCompare(String(left));
        });
      }
      if (this.rowLimit !== null) rows = rows.slice(0, this.rowLimit);
      return rows;
    }
    async maybeSingle() { return { data: this.rows()[0] ?? null, error: null }; }
    async single() { return this.maybeSingle(); }
    then(onFulfilled, onRejected) {
      return Promise.resolve({ data: this.rows(), error: null, count: this.rows().length }).then(onFulfilled, onRejected);
    }
  }

  return {
    store,
    rpcCalls,
    from(table) { return new Query(table); },
    rpc(name, args = {}) {
      rpcCalls.push({ name, args });
      if (/media|credit|seedream|seedance|openrouter|reserve/i.test(name)) mediaCalls.push(name);
      const pending = Promise.resolve(rpcImpl(name, args, store));
      // The real client returns a builder: awaitable, and also .single().
      return {
        then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
        single: async () => pending.then((result) => ({ data: result.data ?? null, error: result.error ?? (result.data ? null : { message: "no rows" }) })),
        maybeSingle: async () => pending,
      };
    },
  };
}

function activeWelcomeFlow(overrides = {}) {
  return {
    id: FLOW_ID,
    owner_user_id: OWNER,
    flow_type: "welcome",
    trigger_type: "newly_eligible_contact",
    trigger_config: {},
    name: "Welcome to SynraPay",
    audience_id: null,
    status: "active",
    current_revision: 1,
    reentry_policy: "once_per_contact",
    created_by: "user",
    activated_by: "user",
    activated_at: "2026-09-01T09:00:00Z",
    created_at: "2026-09-01T09:00:00Z",
    ...overrides,
  };
}

function dueRun(overrides = {}) {
  return {
    id: "run-1",
    owner_user_id: OWNER,
    flow_id: FLOW_ID,
    enrollment_id: ENROLLMENT_ID,
    revision: 1,
    position: 0,
    status: "scheduled",
    scheduled_for: "2026-09-20T07:00:00.000Z", // already due at NOW
    attempts: 0,
    idempotency_key: "seed-key",
    updated_at: "2026-09-20T07:00:00.000Z",
    ...overrides,
  };
}

function baseTables(overrides = {}) {
  return {
    businesses: [{ id: BIZ, owner_user_id: OWNER, brand_name: "SynraPay", industry: "Fintech", automation_level: "assisted", timezone: "Asia/Dubai", plan: "pro", content_frequency: "3x_week", brand_description: "Payments for small merchants.", target_customer: ["Small merchants"], main_goal: "Adopt the dashboard", brand_personality: ["plain-spoken"], allow_automatic_paid_media: false }],
    contacts: [{ id: CONTACT_ID, owner_id: OWNER, email: "ada@example.com", email_status: "subscribed", first_name: "Ada", created_at: "2026-09-01T09:00:00Z" }],
    voom_email_flows: [activeWelcomeFlow()],
    voom_email_flow_steps: [
      { id: "step-0", owner_user_id: OWNER, flow_id: FLOW_ID, revision: 1, position: 0, wait_minutes: 0, subject: "Welcome to SynraPay", preview_text: "What to expect.", body: "Hi {firstName},\n\nThanks for subscribing.", cta: "Reply", cta_url: null, content_source: "deterministic" },
      { id: "step-1", owner_user_id: OWNER, flow_id: FLOW_ID, revision: 1, position: 1, wait_minutes: 2880, subject: "What SynraPay does", preview_text: "One plain explanation.", body: "Hi {firstName},\n\nThe dashboard shows every settlement.", cta: "Open it", cta_url: null, content_source: "deterministic" },
    ],
    voom_email_flow_enrollments: [{ id: ENROLLMENT_ID, owner_user_id: OWNER, flow_id: FLOW_ID, contact_id: CONTACT_ID, revision: 1, status: "active", current_position: 0, next_eligible_at: "2026-09-20T07:00:00.000Z" }],
    voom_email_flow_step_runs: [dueRun()],
    voom_email_suppressions: [],
    voom_email_flow_delivery_events: [],
    campaign_sends: [],
    campaign_recipients: [],
    voom_campaigns: [],
    voom_coordinator_runs: [],
    audiences: [],
    ...overrides,
  };
}

/** The engine's send seam: a recorded, offline Resend client. */
function createProvider({ ok = true, status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      config: { fromName: "SynraPay", fromAddress: "hello@synrapay.example" },
      async post(path, body, init) {
        calls.push({ path, body, headers: init?.headers ?? {} });
        return {
          ok,
          status,
          async text() { return ok ? JSON.stringify({ id: `msg_${calls.length}`, last_event: "accepted" }) : JSON.stringify({ message: "The provider refused the send." }); },
        };
      },
    },
  };
}

/** RPC behaviour mirroring the 0040 contracts already proven against PostgreSQL. */
function createRpc({ claimKeyMatches = true, advanceOutcome = "advanced" } = {}) {
  return async function rpcImpl(name, args, store) {
    switch (name) {
      case "enroll_email_flow_contact": {
        const existing = store.voom_email_flow_enrollments.find(
          (row) => row.flow_id === args.p_flow_id && row.contact_id === args.p_contact_id,
        );
        if (existing) return { data: { outcome: "already_enrolled", enrollmentId: existing.id }, error: null };
        store.voom_email_flow_enrollments.push({ id: `enroll-${store.voom_email_flow_enrollments.length + 1}`, owner_user_id: OWNER, flow_id: args.p_flow_id, contact_id: args.p_contact_id, revision: 1, status: "active", current_position: 0 });
        return { data: { outcome: "enrolled", enrollmentId: "enroll-new" }, error: null };
      }
      case "claim_email_flow_step_run": {
        const run = store.voom_email_flow_step_runs.find((row) => row.id === args.p_run_id);
        if (!run) return { data: null, error: { message: "step_run_not_found" } };
        const flow = store.voom_email_flows.find((row) => row.id === run.flow_id);
        if (flow.status !== "active") return { data: null, error: { message: "flow_not_active" } };
        run.attempts += 1;
        run.status = "sending";
        run.idempotency_key = claimKeyMatches ? args.p_attempt_key : "another-worker-owns-this";
        run.content_snapshot = { subject: "Welcome to SynraPay", body: "Hi {firstName},\n\nThanks for subscribing.", revision: 1 };
        return { data: { ...run }, error: null };
      }
      case "record_email_flow_step_provider_result": {
        const run = store.voom_email_flow_step_runs.find((row) => row.id === args.p_run_id);
        if (run) {
          run.status = args.p_outcome === "accepted" ? "accepted" : "failed";
          run.provider_message_id = args.p_provider_message_id ?? null;
          run.last_error_code = args.p_error_code ?? null;
        }
        return { data: { ...(run ?? {}) }, error: null };
      }
      case "advance_email_flow_enrollment": {
        const enrollment = store.voom_email_flow_enrollments.find((row) => row.id === args.p_enrollment_id);
        if (enrollment) enrollment.current_position = args.p_completed_position + 1;
        return { data: { outcome: advanceOutcome, position: args.p_completed_position + 1 }, error: null };
      }
      case "stop_email_flow_enrollment": {
        const enrollment = store.voom_email_flow_enrollments.find((row) => row.id === args.p_enrollment_id);
        if (enrollment) {
          enrollment.status = "stopped";
          enrollment.stop_reason = args.p_reason;
        }
        return { data: enrollment ?? null, error: null };
      }
      case "reschedule_email_flow_step_run": {
        const run = store.voom_email_flow_step_runs.find((row) => row.id === args.p_run_id);
        if (run) {
          run.status = "scheduled";
          run.scheduled_for = args.p_new_scheduled_for;
        }
        return { data: run ?? null, error: null };
      }
      case "create_email_flow": {
        const existing = store.voom_email_flows.find((row) => row.idempotency_key === args.p_payload?.idempotencyKey);
        if (existing) return { data: existing, error: null };
        if (args.p_payload?.createdBy === "coordinator"
          && store.voom_email_flows.some((row) => row.flow_type === args.p_payload.flowType && row.status !== "archived")) {
          return { data: null, error: { message: "flow_type_already_exists" } };
        }
        const flow = {
          id: `flow-${store.voom_email_flows.length + 1}`,
          owner_user_id: args.p_owner_user_id,
          flow_type: args.p_payload.flowType,
          status: "draft",
          created_by: args.p_payload.createdBy,
          activated_by: null,
          current_revision: 1,
          generation_source: args.p_payload.generationSource,
          idempotency_key: args.p_payload.idempotencyKey,
          steps: args.p_payload.steps,
        };
        store.voom_email_flows.push(flow);
        return { data: flow, error: null };
      }
      default:
        return { data: null, error: null };
    }
  };
}

// ─── 1. The creation pipeline ──────────────────────────────────────────────

function fakeAi(response) {
  return {
    calls: 0,
    /**
     * Mirrors the real provider contract: the caller supplies `parse`, and an
     * unusable response surfaces as a thrown error, exactly as a zod failure
     * does in production.
     */
    async structured(options) {
      this.calls += 1;
      if (response instanceof Error) throw response;
      if (typeof options?.parse === "function") return options.parse(response);
      return response;
    },
  };
}

const VALID_INTELLIGENCE = {
  strategy: {
    objective: "Get new subscribers onto the dashboard.",
    approach: "Greet, explain, then ask one question.",
    audienceAngle: "Small merchants reconciling payouts.",
    tone: "Plain and direct.",
  },
  steps: [
    { position: 0, title: "Welcome", purpose: "Say hello", subject: "Welcome to SynraPay", previewText: "What to expect.", body: "Hi {firstName},\n\nThanks for subscribing to SynraPay. Here is what happens next.", cta: "Reply and say hello", ctaUrl: null, waitMinutes: 0 },
    { position: 1, title: "Value", purpose: "Explain", subject: "What SynraPay does", previewText: "One plain explanation.", body: "Hi {firstName},\n\nThe dashboard shows every settlement and the date it lands.", cta: "Open the dashboard", ctaUrl: null, waitMinutes: 2880 },
    { position: 2, title: "Next step", purpose: "Ask", subject: "One thing worth doing", previewText: "A single next step.", body: "Hi {firstName},\n\nTell us what you are trying to get done and we will point you at it.", cta: "Tell us what you need", ctaUrl: null, waitMinutes: 4320 },
  ],
  note: null,
};

test("1a. MARA writes the sequence inside the deterministic skeleton", async () => {
  const admin = createAdmin({ ...baseTables(), voom_email_flows: [] }, createRpc());
  const ai = fakeAi(VALID_INTELLIGENCE);
  const result = await createEmailFlow(admin, { ownerId: OWNER, flowType: "welcome", deps: { ai } });

  assert.equal(result.generationSource, "mara");
  assert.equal(result.stepCount, 3, "the skeleton's step count is authoritative");
  assert.equal(ai.calls, 1);

  const create = admin.rpcCalls.find((call) => call.name === "create_email_flow");
  assert.equal(create.args.p_payload.createdBy, "user");
  assert.equal(create.args.p_payload.steps.every((step) => /unsubscribe/i.test(step.body)), true, "every stored body carries the opt-out");
  assert.equal(create.args.p_payload.strategy.source, "mara");
});

test("1b. a MARA failure still produces a usable flow", async () => {
  const admin = createAdmin({ ...baseTables(), voom_email_flows: [] }, createRpc());
  const ai = fakeAi(Object.assign(new Error("rate_limited"), { code: "rate_limited" }));
  const result = await createEmailFlow(admin, { ownerId: OWNER, flowType: "welcome", deps: { ai } });

  assert.equal(result.generationSource, "deterministic", "flow creation never depends on the provider");
  assert.equal(result.stepCount, 3);
  assert.equal(admin.rpcCalls.filter((call) => call.name === "create_email_flow").length, 1, "one flow, written once");
});

test("1c. MARA output that breaks the schema falls back per flow, not with a crash", async () => {
  const admin = createAdmin({ ...baseTables(), voom_email_flows: [] }, createRpc());
  const ai = fakeAi({ strategy: { objective: "only half a response" } });
  const result = await createEmailFlow(admin, { ownerId: OWNER, flowType: "re_engagement", deps: { ai } });

  assert.equal(result.generationSource, "deterministic");
  assert.equal(result.stepCount, 2, "the Re-engagement default sequence");
});

// ─── 2. The Coordinator may prepare, never activate ────────────────────────

test("2a. Manual mode: the Coordinator creates nothing at all", async () => {
  const admin = createAdmin({ ...baseTables(), voom_email_flows: [] }, createRpc());
  const outcome = await proposeEmailFlow(admin, { ownerId: OWNER, flowType: "welcome", mode: "manual", deps: { ai: fakeAi(VALID_INTELLIGENCE) } });

  assert.equal(outcome.outcome, "not_permitted");
  assert.equal(outcome.reason, "automation_mode_manual");
  assert.equal(admin.rpcCalls.filter((call) => call.name === "create_email_flow").length, 0, "not even a draft is written");
});

test("2b. Assisted and Autopilot may propose a draft, and nothing more", async () => {
  for (const mode of ["assisted", "autopilot"]) {
    const admin = createAdmin({ ...baseTables(), voom_email_flows: [] }, createRpc());
    const outcome = await proposeEmailFlow(admin, { ownerId: OWNER, flowType: "welcome", mode, deps: { ai: fakeAi(VALID_INTELLIGENCE) } });

    assert.equal(outcome.outcome, "proposed", mode);
    assert.equal(outcome.result.flow.status, "draft", `${mode}: a proposal is never live`);
    assert.equal(outcome.result.flow.created_by, "coordinator");
    assert.equal(outcome.result.flow.activated_by, null, `${mode}: nobody activated it`);
  }
});

test("2c. a repeated Coordinator tick cannot create a second flow", async () => {
  const admin = createAdmin({ ...baseTables(), voom_email_flows: [] }, createRpc());
  const key = coordinatorProposalKey(OWNER, "welcome");
  const first = await proposeEmailFlow(admin, { ownerId: OWNER, flowType: "welcome", mode: "assisted", deps: { ai: fakeAi(VALID_INTELLIGENCE) } });
  const second = await proposeEmailFlow(admin, { ownerId: OWNER, flowType: "welcome", mode: "assisted", deps: { ai: fakeAi(VALID_INTELLIGENCE) } });

  assert.equal(first.outcome, "proposed");
  assert.equal(second.outcome, "proposed", "the stored flow comes back from the same key");
  assert.equal(admin.store.voom_email_flows.length, 1, "one flow, not one per cron tick");
  assert.ok(key.length >= 16, "the proposal key is durable and owner-scoped");
});

// ─── 3. Consent is re-checked immediately before every send ────────────────

async function runEngine(tables, { provider = createProvider(), claimKeyMatches = true } = {}) {
  const admin = createAdmin(tables, createRpc({ claimKeyMatches }));
  const summary = await engine.runEmailFlowsForOwner(admin, OWNER, {
    now: NOW,
    send: { client: provider.client },
    maxEnrollmentsPerTick: 5,
  });
  return { admin, summary, provider };
}

test("3a. a consented contact gets exactly one send, keyed for provider idempotency", async () => {
  const { admin, summary, provider } = await runEngine(baseTables());

  assert.equal(provider.calls.length, 1, "one email, to one contact");
  assert.equal(provider.calls[0].path, "emails");
  assert.deepEqual(provider.calls[0].body.to, ["ada@example.com"]);
  assert.match(provider.calls[0].body.text, /^Hi Ada,/, "the token is replaced with the real first name");
  assert.ok(provider.calls[0].headers["Idempotency-Key"], "the provider-side idempotency header is always sent");

  const record = admin.rpcCalls.find((call) => call.name === "record_email_flow_step_provider_result");
  assert.equal(record.args.p_outcome, "accepted");
  assert.equal(record.args.p_provider_message_id, "msg_1");

  const advance = admin.rpcCalls.find((call) => call.name === "advance_email_flow_enrollment");
  assert.ok(advance, "the enrollment moves on to the next step");
  assert.equal(advance.args.p_completed_position, 0);
  assert.ok(Date.parse(advance.args.p_next_scheduled_for) > NOW.getTime(), "the next step is scheduled in the future");
  assert.equal(summary.sent, 1);
  assert.equal(summary.advanced, 1);
});

test("3b. an unsubscribe between enrollment and the send blocks it and stops the flow", async () => {
  const tables = baseTables();
  tables.contacts[0].email_status = "unsubscribed";
  const { admin, summary, provider } = await runEngine(tables);

  assert.equal(provider.calls.length, 0, "nothing is sent to an unsubscribed contact");
  assert.equal(admin.rpcCalls.some((call) => call.name === "claim_email_flow_step_run"), false, "not even claimed");
  const stop = admin.rpcCalls.find((call) => call.name === "stop_email_flow_enrollment");
  assert.ok(stop, "the enrollment is stopped, not left running");
  assert.equal(stop.args.p_reason, "consent_not_subscribed");
  assert.equal(admin.store.voom_email_flow_enrollments[0].status, "stopped");
  assert.equal(summary.sent, 0);
  assert.equal(summary.stopped, 1);
});

test("3c. a suppressed address blocks the send too", async () => {
  const tables = baseTables({ voom_email_suppressions: [{ owner_id: OWNER, email: "ada@example.com", reason: "bounced" }] });
  const { admin, summary, provider } = await runEngine(tables);

  assert.equal(provider.calls.length, 0);
  const stop = admin.rpcCalls.find((call) => call.name === "stop_email_flow_enrollment");
  assert.equal(stop.args.p_reason, "suppressed");
  assert.equal(summary.stopped, 1);
});

test("3d. a removed contact stops the enrollment without sending", async () => {
  const tables = baseTables({ contacts: [] });
  const { admin, provider } = await runEngine(tables);

  assert.equal(provider.calls.length, 0);
  const stop = admin.rpcCalls.find((call) => call.name === "stop_email_flow_enrollment");
  assert.equal(stop.args.p_reason, "contact_removed");
});

test("3e. consent status 'unknown' is not consent", async () => {
  const tables = baseTables();
  tables.contacts[0].email_status = "unknown";
  const { provider } = await runEngine(tables);
  assert.equal(provider.calls.length, 0);
});

test("3f. without a configured provider nothing is claimed or sent", async () => {
  const { admin, summary, provider } = await withSendEnvRemoved(() => runEngine(baseTables()));

  assert.equal(summary.providerConfigured, false);
  assert.equal(provider.calls.length, 0);
  assert.equal(admin.rpcCalls.some((call) => call.name === "claim_email_flow_step_run"), false, "not even claimed");
  const stop = admin.rpcCalls.find((call) => call.name === "stop_email_flow_enrollment");
  assert.equal(stop.args.p_reason, "email_provider_not_configured");
});

// ─── 4. Sending is owned by exactly one worker ─────────────────────────────

test("4a. a run another worker already claimed is never sent again", async () => {
  const { admin, summary, provider } = await runEngine(baseTables(), { claimKeyMatches: false });

  assert.equal(provider.calls.length, 0, "no provider call when the claim key does not come back");
  assert.equal(admin.rpcCalls.some((call) => call.name === "record_email_flow_step_provider_result"), false);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.sent, 0);
});

test("4b. a provider failure is recorded and retried a bounded number of times", async () => {
  const provider = createProvider({ ok: false, status: 500 });
  const { admin, summary } = await runEngine(baseTables(), { provider });

  assert.equal(provider.calls.length, 1);
  const record = admin.rpcCalls.find((call) => call.name === "record_email_flow_step_provider_result");
  assert.equal(record.args.p_outcome, "failed");
  assert.equal(record.args.p_error_code, "HTTP_500");

  const retry = admin.rpcCalls.find((call) => call.name === "reschedule_email_flow_step_run");
  assert.ok(retry, "the same run row is put back in the queue");
  assert.equal(retry.args.p_run_id, "run-1");
  assert.ok(Date.parse(retry.args.p_new_scheduled_for) > NOW.getTime(), "the retry is in the future, in business hours");
  assert.equal(summary.retried, 1);
  assert.equal(summary.failed, 1);
});

test("4c. the last allowed attempt is not retried — the budget ends", async () => {
  const tables = baseTables({ voom_email_flow_step_runs: [dueRun({ attempts: 2 })] });
  const provider = createProvider({ ok: false, status: 500 });
  const { admin, summary } = await runEngine(tables, { provider });

  assert.equal(summary.retried, 0, "no further retry once the budget is spent");
  assert.equal(admin.rpcCalls.some((call) => call.name === "reschedule_email_flow_step_run"), false);
});

// ─── 5. Mode gates on execution ────────────────────────────────────────────

test("5a. a paused flow does not execute", async () => {
  const tables = baseTables({ voom_email_flows: [activeWelcomeFlow({ status: "paused" })] });
  const { summary, provider } = await runEngine(tables);
  assert.equal(summary.flowsEvaluated, 0);
  assert.equal(provider.calls.length, 0);
});

test("5b. a flow nobody activated does not execute, even if its row says active", async () => {
  // This is the Autopilot fail-closed case: without an owner activation there
  // is no execution, whatever the status column says.
  const tables = baseTables({ voom_email_flows: [activeWelcomeFlow({ activated_by: null, activated_at: null })] });
  const { summary, provider } = await runEngine(tables);
  assert.equal(summary.flowsEvaluated, 0);
  assert.equal(provider.calls.length, 0);
});

test("5c. an owner-activated flow executes in every automation mode", async () => {
  // Mode is a property of the business, not of the flow: once the owner has
  // activated it, the scheduled steps run without per-recipient approval.
  for (const mode of ["manual", "assisted", "autopilot"]) {
    const tables = baseTables();
    tables.businesses[0].automation_level = mode;
    const { provider } = await runEngine(tables);
    assert.equal(provider.calls.length, 1, `${mode}: the owner's own flow still runs`);
  }
});

// ─── 6. Coordinator awareness ──────────────────────────────────────────────

function coordinatorAdmin({ flows = [], runs = [], contactsCount = 0 }) {
  return createAdmin({
    ...baseTables(),
    voom_email_flows: flows,
    voom_email_flow_step_runs: runs,
    voom_email_flow_enrollments: [],
    contacts: Array.from({ length: contactsCount }, (_, index) => ({
      id: `contact-${index}`, owner_id: OWNER, email: `contact${index}@example.com`, email_status: "subscribed", first_name: null, created_at: "2026-09-01T09:00:00Z",
    })),
  }, createRpc());
}

test("6a. the Coordinator sees live flows and the work they have scheduled", async () => {
  const admin = coordinatorAdmin({
    flows: [activeWelcomeFlow({ name: "Welcome to SynraPay" })],
    runs: [
      dueRun({ status: "scheduled", scheduled_for: "2026-09-21T09:00:00.000Z" }),
      dueRun({ id: "run-2", status: "delivered", delivered_at: "2026-09-19T09:00:00.000Z", scheduled_for: "2026-09-19T09:00:00.000Z" }),
    ],
  });
  const state = await buildMarketingState(admin, OWNER, BIZ, NOW);

  assert.equal(state.emailState.flows.length, 1);
  assert.equal(state.emailState.flows[0].flowType, "welcome");
  assert.equal(state.emailState.welcomeCovered, true);
  assert.equal(state.emailState.scheduledLifecycleEmailCount, 1);
  assert.equal(state.emailState.lastSentAt, "2026-09-19T09:00:00.000Z", "a lifecycle delivery counts as real email activity");
  assert.deepEqual(state.emailState.flowOpportunities, [], "an existing Welcome flow is never re-proposed");
});

test("6b. an unapproved MARA proposal is surfaced as needing attention", async () => {
  const admin = coordinatorAdmin({
    flows: [activeWelcomeFlow({ status: "draft", created_by: "coordinator", activated_by: null, activated_at: null })],
    contactsCount: 12,
  });
  const state = await buildMarketingState(admin, OWNER, BIZ, NOW);
  const evaluation = evaluateMarketingNeeds(state);

  const need = evaluation.needs.find((item) => item.type === "email_flow_needs_attention");
  assert.ok(need, "the approval need exists");
  assert.match(need.title, /approval/i);
  assert.match(state.emailState.flows[0].attentionReason, /needs your approval/i);

  // A Welcome flow already exists, so it is never re-proposed. The other flow
  // type is a genuinely different need and is still offered.
  assert.deepEqual(state.emailState.flowOpportunities.map((item) => item.flowType), ["re_engagement"]);
});

test("6c. opportunities are only offered when nothing covers them yet", async () => {
  const none = await buildMarketingState(coordinatorAdmin({ contactsCount: 12 }), OWNER, BIZ, NOW);
  assert.deepEqual(none.emailState.flowOpportunities.map((item) => item.flowType), ["welcome", "re_engagement"]);

  const welcomeOnly = await buildMarketingState(
    coordinatorAdmin({ flows: [activeWelcomeFlow()], contactsCount: 12 }), OWNER, BIZ, NOW,
  );
  assert.deepEqual(welcomeOnly.emailState.flowOpportunities.map((item) => item.flowType), ["re_engagement"]);

  const both = await buildMarketingState(
    coordinatorAdmin({
      flows: [activeWelcomeFlow(), activeWelcomeFlow({ id: "flow-2", flow_type: "re_engagement", trigger_type: "inactive_contact" })],
      contactsCount: 12,
    }), OWNER, BIZ, NOW,
  );
  assert.deepEqual(both.emailState.flowOpportunities, []);

  const tooFew = await buildMarketingState(coordinatorAdmin({ contactsCount: 2 }), OWNER, BIZ, NOW);
  assert.deepEqual(tooFew.emailState.flowOpportunities.map((item) => item.flowType), ["welcome"],
    "re-engagement needs enough contacts to be worth a sequence");
});

test("6d. a scheduled lifecycle email stops the 'you haven't emailed' claim", async () => {
  const admin = coordinatorAdmin({
    flows: [activeWelcomeFlow()],
    runs: [dueRun({ status: "scheduled", scheduled_for: "2026-09-21T09:00:00.000Z" })],
    contactsCount: 20,
  });
  const state = await buildMarketingState(admin, OWNER, BIZ, NOW);
  assert.equal(state.emailState.scheduledLifecycleEmailCount, 1);
  assert.equal(state.emailState.opportunityAvailable, false, "lifecycle work counts as scheduled email work");
});

// ─── 7. External safety ────────────────────────────────────────────────────

test("7. no flow path reached the network, a media provider or a credit", () => {
  assert.equal(fetchCalls, 0, "no HTTP request was made anywhere in this file");
  assert.deepEqual(mediaCalls, [], "no media-generation or credit RPC was called");
});
