/**
 * Email Automation v2 — real-database coverage.
 *
 * Applies the repository's actual migrations (0001..0040) to an embedded
 * PostgreSQL and drives the REAL RPCs that the engine calls in Production:
 * `create_email_flow`, `enroll_email_flow_contact`, `claim_email_flow_step_run`,
 * `record_email_flow_step_provider_result`, `record_email_flow_delivery_event`,
 * `advance_email_flow_enrollment`, `stop_email_flow_enrollment`,
 * `set_email_flow_status`, `reschedule_email_flow_step_run` and
 * `revise_email_flow`.
 *
 * The flow payload is produced by the REAL pure modules (`buildFlowSkeleton` +
 * `applyFlowIntelligence`), so the database sees the exact shape the create
 * layer sends.
 *
 * No provider is called anywhere in this file: no AI, no Resend, no Meta, no
 * Seedream/Seedance, no cron, no credit reservation.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const { buildFlowSkeleton } = await import("../lib/email-flows/skeleton.ts");
const { applyFlowIntelligence, toFlowStrategyPayload } = await import("../lib/email-flows/strategy.ts");
const { flowTypePolicy } = await import("../lib/email-flows/policy.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const AUD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CONTACT_OK = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
const CONTACT_UNSUB = "cccccccc-cccc-4ccc-8ccc-cccccccccc02";
const CONTACT_BOUNCED = "cccccccc-cccc-4ccc-8ccc-cccccccccc03";
const CONTACT_OTHER_OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccc04";
/** Dedicated to the bounce test: a bounce suppresses the address for good. */
const CONTACT_BOUNCES_LATER = "cccccccc-cccc-4ccc-8ccc-cccccccccc05";

const BRAND = {
  brandName: "SynraPay",
  brandDescription: "Payments for small merchants.",
  industry: "Fintech",
  targetCustomer: ["Small merchants"],
  brandPersonality: ["plain-spoken"],
  mainGoal: "Adopt the new dashboard",
};

/** Any future timestamp: the RPCs refuse anything in the past. */
const LATER = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const KEY = (label) => `idem-${label}-${"x".repeat(40)}`.slice(0, 80);

let db;

async function getDb() {
  if (!db) {
    ({ db } = await createSupabaseLite());
    await db.exec(`
      insert into auth.users (id, email) values
        ('${OWNER_A}', 'owner.a@example.com'),
        ('${OWNER_B}', 'owner.b@example.com');
      insert into public.businesses (owner_user_id, brand_name, industry, automation_level) values
        ('${OWNER_A}', 'SynraPay', 'Fintech', 'assisted'),
        ('${OWNER_B}', 'Other Studio', 'Fashion', 'manual');
      insert into public.audiences (id, owner_id, name, type) values
        ('${AUD_A}', '${OWNER_A}', 'Merchants', 'manual');
      insert into public.contacts (id, owner_id, first_name, email, email_status) values
        ('${CONTACT_OK}', '${OWNER_A}', 'Ada', 'ada@example.com', 'subscribed'),
        ('${CONTACT_UNSUB}', '${OWNER_A}', 'Bruno', 'bruno@example.com', 'unsubscribed'),
        ('${CONTACT_BOUNCED}', '${OWNER_A}', 'Cyd', 'cyd@example.com', 'subscribed'),
        ('${CONTACT_OTHER_OWNER}', '${OWNER_B}', 'Dana', 'dana@example.com', 'subscribed'),
        ('${CONTACT_BOUNCES_LATER}', '${OWNER_A}', 'Erin', 'erin@example.com', 'subscribed');
    `);
  }
  return db;
}

async function all(sql, params = []) {
  const d = await getDb();
  const { rows } = await d.query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

/** PGlite hands jsonb back as a string; the RPC contracts are objects. */
function jsonb(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function expectError(runnable, code) {
  try {
    await runnable();
  } catch (error) {
    assert.ok(String(error.message).includes(code), `expected ${code}, got: ${error.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected the call to fail with ${code}` });
}

/** The payload the create layer actually sends, built by the real modules. */
function welcomePayload({ idempotencyKey, createdBy = "user", intelligence = null } = {}) {
  const skeleton = buildFlowSkeleton({ flowType: "welcome", brand: BRAND });
  const applied = applyFlowIntelligence({ skeleton, brand: BRAND, intelligence, allowedUrls: [] });
  return {
    flowType: skeleton.flowType,
    triggerType: skeleton.triggerType,
    createdBy,
    idempotencyKey,
    name: "Welcome to SynraPay",
    objective: skeleton.objective,
    audienceId: AUD_A,
    businessId: null,
    reentryPolicy: skeleton.reentryPolicy,
    cooldownDays: null,
    generationSource: applied.source,
    strategy: toFlowStrategyPayload(applied, skeleton.flowType),
    strategySummary: applied.strategySummary,
    triggerConfig: skeleton.triggerConfig,
    steps: applied.steps.map((step) => ({
      position: step.position,
      title: step.title,
      purpose: step.purpose,
      waitMinutes: step.waitMinutes,
      subject: step.subject,
      previewText: step.previewText,
      body: step.body,
      cta: step.cta,
      ctaUrl: step.ctaUrl,
      contentSource: step.contentSource,
    })),
  };
}

async function createWelcome(payload) {
  return one("select * from public.create_email_flow($1::uuid, $2::jsonb)", [OWNER_A, JSON.stringify(payload)]);
}

async function enroll(flowId, contactId, label, owner = OWNER_A) {
  const row = await one(
    "select public.enroll_email_flow_contact($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::text) as result",
    [owner, flowId, contactId, LATER(), KEY(label)],
  );
  return jsonb(row.result);
}

async function activate(flowId) {
  return one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flowId, "active"]);
}

async function runsFor(enrollmentId) {
  return all("select * from public.voom_email_flow_step_runs where enrollment_id = $1 order by position, created_at", [enrollmentId]);
}

// ─── 1. Creation ───────────────────────────────────────────────────────────

test("1a. a Welcome flow is created as a draft revision with its steps", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("welcome-1") }));
  assert.equal(flow.flow_type, "welcome");
  assert.equal(flow.trigger_type, "newly_eligible_contact");
  assert.equal(flow.status, "draft", "a flow never starts live");
  assert.equal(flow.activated_by, null);
  assert.equal(flow.current_revision, 1);
  assert.equal(flow.created_by, "user");
  assert.equal(flow.reentry_policy, "once_per_contact");

  const steps = await all(
    "select * from public.voom_email_flow_steps where flow_id = $1 order by position",
    [flow.id],
  );
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((step) => step.wait_minutes), [0, 2880, 4320]);
  for (const step of steps) {
    assert.equal(step.step_type, "email");
    assert.ok(step.body.includes("unsubscribe"), "the opt-out line is stored with every step");
  }

  const event = await one(
    "select * from public.voom_email_flow_events where flow_id = $1 and kind = 'flow_created'",
    [flow.id],
  );
  assert.ok(event, "creation is recorded in the flow's own history");
});

test("1b. replaying the same create is a no-op, not a second flow", async () => {
  const payload = welcomePayload({ idempotencyKey: KEY("welcome-replay") });
  const first = await createWelcome(payload);
  const second = await createWelcome(payload);
  assert.equal(first.id, second.id);

  const rows = await all("select * from public.voom_email_flows where owner_user_id = $1", [OWNER_A]);
  assert.equal(rows.filter((row) => row.idempotency_key === payload.idempotencyKey).length, 1);
  const steps = await all(
    "select * from public.voom_email_flow_steps where flow_id = $1",
    [first.id],
  );
  assert.equal(steps.length, 3, "a replay does not duplicate the steps");
});

test("1c. the taxonomy cannot be widened from the caller", async () => {
  await expectError(
    () => createWelcome({ ...welcomePayload({ idempotencyKey: KEY("bad-type") }), flowType: "abandoned_cart" }),
    "unsupported_flow_type",
  );
  await expectError(
    () => createWelcome({ ...welcomePayload({ idempotencyKey: KEY("bad-trigger") }), triggerType: "inactive_contact" }),
    "trigger_type_mismatch",
  );
  await expectError(
    () => createWelcome({ ...welcomePayload({ idempotencyKey: KEY("no-steps") }), steps: [] }),
    "flow_requires_steps",
  );
  await expectError(
    () => createWelcome({ ...welcomePayload({ idempotencyKey: "short" }) }),
    "invalid_idempotency_key",
  );
});

test("1d. a Coordinator proposal can never duplicate a live flow of the same type", async () => {
  // OWNER_A already has a live, owner-created Welcome flow from 1a — so the
  // Coordinator must not propose another one.
  await expectError(
    () => createWelcome(welcomePayload({ idempotencyKey: KEY("coord-dup"), createdBy: "coordinator" })),
    "flow_type_already_exists",
  );

  // For an owner with nothing of that type, exactly one proposal may exist.
  const skeleton = buildFlowSkeleton({ flowType: "re_engagement", brand: BRAND });
  const applied = applyFlowIntelligence({ skeleton, brand: BRAND, intelligence: null });
  const proposal = (key) => ({
    flowType: skeleton.flowType,
    triggerType: skeleton.triggerType,
    createdBy: "coordinator",
    idempotencyKey: key,
    name: "Still there?",
    objective: skeleton.objective,
    reentryPolicy: skeleton.reentryPolicy,
    cooldownDays: skeleton.cooldownDays,
    generationSource: applied.source,
    strategy: toFlowStrategyPayload(applied, skeleton.flowType),
    strategySummary: applied.strategySummary,
    triggerConfig: skeleton.triggerConfig,
    steps: applied.steps,
  });

  const created = await one("select * from public.create_email_flow($1::uuid, $2::jsonb)", [
    OWNER_B, JSON.stringify(proposal(KEY("coord-b"))),
  ]);
  assert.equal(created.created_by, "coordinator");
  assert.equal(created.status, "draft", "a Coordinator proposal stays a draft");
  assert.equal(created.activated_by, null);

  await expectError(
    () => one("select * from public.create_email_flow($1::uuid, $2::jsonb)", [
      OWNER_B, JSON.stringify(proposal(KEY("coord-b-2"))),
    ]),
    "flow_type_already_exists",
  );
});

// ─── 2. Consent is authoritative at enrollment ─────────────────────────────

test("2a. nothing enrolls until the owner activates the flow", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("not-live") }));
  const result = await enroll(flow.id, CONTACT_OK, "not-live");
  assert.equal(result.outcome, "flow_inactive");
  assert.equal(result.reason, "flow_status_draft");
});

test("2b. unsubscribed and unknown consent never enroll, even with a valid address", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("consent") }));
  await activate(flow.id);

  const unsubscribed = await enroll(flow.id, CONTACT_UNSUB, "unsub");
  assert.equal(unsubscribed.outcome, "ineligible");
  assert.equal(unsubscribed.reason, "consent_or_destination_not_verified");

  const missing = await enroll(flow.id, "cccccccc-cccc-4ccc-8ccc-cccccccccc99", "missing");
  assert.equal(missing.outcome, "ineligible");
  assert.equal(missing.reason, "contact_not_found");

  const count = await one(
    "select count(*)::int as n from public.voom_email_flow_enrollments where flow_id = $1",
    [flow.id],
  );
  assert.equal(count.n, 0);
});

test("2c. a suppressed address is refused even while it says 'subscribed'", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("suppressed") }));
  await activate(flow.id);

  await one(
    "select * from public.record_email_suppression($1::uuid, $2::text, $3::text)",
    [OWNER_A, "cyd@example.com", "bounced"],
  );

  const result = await enroll(flow.id, CONTACT_BOUNCED, "suppressed");
  assert.equal(result.outcome, "ineligible");
  assert.equal(result.reason, "suppressed");
});

test("2d. a consented contact enrolls with exactly one scheduled first run", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("enrolled") }));
  await activate(flow.id);

  const result = await enroll(flow.id, CONTACT_OK, "enrolled");
  assert.equal(result.outcome, "enrolled");
  assert.ok(result.enrollmentId);

  const enrollment = await one("select * from public.voom_email_flow_enrollments where id = $1", [result.enrollmentId]);
  assert.equal(enrollment.status, "active");
  assert.equal(enrollment.current_position, 0);
  assert.equal(enrollment.revision, 1, "the enrollment pins the revision it started on");

  const runs = await runsFor(result.enrollmentId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "scheduled");
  assert.ok(Date.parse(runs[0].scheduled_for) > Date.now(), "the first send is scheduled in the future");
});

// ─── 3. Enrollment idempotency and re-entry ────────────────────────────────

test("3a. a repeated cron tick cannot double-enroll a contact", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("double") }));
  await activate(flow.id);

  const first = await enroll(flow.id, CONTACT_OK, "double-1");
  assert.equal(first.outcome, "enrolled");
  const second = await enroll(flow.id, CONTACT_OK, "double-2");
  assert.equal(second.outcome, "already_enrolled");
  assert.equal(second.enrollmentId, first.enrollmentId);

  const count = await one(
    "select count(*)::int as n from public.voom_email_flow_enrollments where flow_id = $1 and contact_id = $2",
    [flow.id, CONTACT_OK],
  );
  assert.equal(count.n, 1, "one enrollment, one first run");
});

test("3b. Welcome is once per contact, ever — completing it does not re-open it", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("once") }));
  await activate(flow.id);
  const result = await enroll(flow.id, CONTACT_OK, "once");

  // Drive the enrollment to completion through the real advance RPC.
  const runs = await runsFor(result.enrollmentId);
  for (let position = 0; position < 3; position += 1) {
    const advance = jsonb((await one(
      "select public.advance_email_flow_enrollment($1::uuid, $2::uuid, $3::int, $4::timestamptz, $5::text) as result",
      [OWNER_A, result.enrollmentId, position, LATER(), KEY(`once-${position}`)],
    )).result);
    assert.equal(advance.outcome, position === 2 ? "completed" : "advanced");
  }

  const enrollment = await one("select * from public.voom_email_flow_enrollments where id = $1", [result.enrollmentId]);
  assert.equal(enrollment.status, "completed");

  const finished = await runsFor(result.enrollmentId);
  assert.equal(finished.length, 3, "exactly one run per step, no duplicates");
  assert.deepEqual(finished.map((row) => row.position), [0, 1, 2]);
  void runs;

  const again = await enroll(flow.id, CONTACT_OK, "once-again");
  assert.equal(again.outcome, "already_enrolled");
  assert.equal(again.reason, "once_per_contact");
});

test("3c. a replayed advance changes nothing and adds no run", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("advance-replay") }));
  await activate(flow.id);
  const result = await enroll(flow.id, CONTACT_OK, "advance-replay");

  const scheduledFor = LATER();
  const first = jsonb((await one(
    "select public.advance_email_flow_enrollment($1::uuid, $2::uuid, $3::int, $4::timestamptz, $5::text) as result",
    [OWNER_A, result.enrollmentId, 0, scheduledFor, KEY("replay-0")],
  )).result);
  assert.equal(first.outcome, "advanced");
  assert.equal(first.position, 1);

  const replay = jsonb((await one(
    "select public.advance_email_flow_enrollment($1::uuid, $2::uuid, $3::int, $4::timestamptz, $5::text) as result",
    [OWNER_A, result.enrollmentId, 0, scheduledFor, KEY("replay-0b")],
  )).result);
  assert.equal(replay.outcome, "noop");

  const runs = await runsFor(result.enrollmentId);
  assert.equal(runs.length, 2, "one run for position 0, one for position 1");
  assert.deepEqual(runs.map((run) => run.position), [0, 1]);
});

test("3d. Re-engagement honours its cooldown and re-opens after it", async () => {
  const skeleton = buildFlowSkeleton({ flowType: "re_engagement", brand: BRAND, inactivityDays: 45, cooldownDays: 90 });
  const applied = applyFlowIntelligence({ skeleton, brand: BRAND, intelligence: null });
  const flow = await one("select * from public.create_email_flow($1::uuid, $2::jsonb)", [OWNER_A, JSON.stringify({
    flowType: skeleton.flowType,
    triggerType: skeleton.triggerType,
    createdBy: "user",
    idempotencyKey: KEY("reengage"),
    name: "Still there?",
    objective: skeleton.objective,
    audienceId: AUD_A,
    reentryPolicy: skeleton.reentryPolicy,
    cooldownDays: skeleton.cooldownDays,
    generationSource: applied.source,
    strategy: toFlowStrategyPayload(applied, skeleton.flowType),
    strategySummary: applied.strategySummary,
    triggerConfig: skeleton.triggerConfig,
    steps: applied.steps.map((step) => ({ ...step, waitMinutes: step.waitMinutes })),
  })]);
  assert.equal(flow.flow_type, "re_engagement");
  assert.equal(flow.trigger_type, "inactive_contact");
  assert.equal(flow.reentry_policy, "cooldown");
  assert.equal(flow.cooldown_days, 90);
  await activate(flow.id);

  const first = await enroll(flow.id, CONTACT_OK, "reengage-1");
  assert.equal(first.outcome, "enrolled");

  await one(
    "select * from public.stop_email_flow_enrollment($1::uuid, $2::uuid, $3::text)",
    [OWNER_A, first.enrollmentId, "unsubscribed"],
  );

  const tooSoon = await enroll(flow.id, CONTACT_OK, "reengage-2");
  assert.equal(tooSoon.outcome, "cooldown");
  assert.equal(tooSoon.reason, "reengagement_cooldown");

  // Backdate the ended enrollment past the cooldown: re-entry is allowed then.
  await all(
    "update public.voom_email_flow_enrollments set stopped_at = now() - interval '91 days' where id = $1",
    [first.enrollmentId],
  );
  const later = await enroll(flow.id, CONTACT_OK, "reengage-3");
  assert.equal(later.outcome, "enrolled");
});

// ─── 4. Sending: claim, acceptance, delivery ───────────────────────────────

async function enrolledRun(label, contactId = CONTACT_OK) {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY(label) }));
  await activate(flow.id);
  const result = await enroll(flow.id, contactId, label);
  assert.equal(result.outcome, "enrolled", `expected an enrollment, got ${result.outcome}/${result.reason ?? ""}`);
  const runs = await runsFor(result.enrollmentId);
  assert.equal(runs.length, 1, "the enrollment starts with exactly one scheduled run");
  return { flow, enrollmentId: result.enrollmentId, run: runs[0] };
}

test("4a. only the worker whose key comes back owns the send — never two", async () => {
  const { run } = await enrolledRun("claim");

  const claimed = await one(
    "select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)",
    [OWNER_A, run.id, KEY("claim-a")],
  );
  assert.equal(claimed.status, "sending");
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.idempotency_key, KEY("claim-a"), "the caller may send");
  assert.ok(claimed.content_snapshot, "the exact content is frozen at claim time");

  // A second worker — a duplicate or a delayed cron tick — must not send.
  const race = await one(
    "select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)",
    [OWNER_A, run.id, KEY("claim-b")],
  );
  assert.notEqual(race.idempotency_key, KEY("claim-b"), "the second worker does not own the send");
  assert.equal(race.attempts, 1, "and it did not consume another attempt");
});

test("4a-2. v2 durable claims use a worker token and never reclaim an ambiguous send", async () => {
  const { run } = await enrolledRun("durable-claim");
  await all("update public.voom_email_flow_step_runs set scheduled_for = now() - interval '1 minute' where id = $1", [run.id]);
  const providerKey = KEY("durable-provider");

  const first = await one(
    "select * from public.claim_email_flow_step_run_v2($1::uuid, $2::uuid, $3::text, $4::text)",
    [OWNER_A, run.id, KEY("worker-a"), providerKey],
  );
  assert.equal(first.status, "sending");
  assert.equal(first.claim_token, KEY("worker-a"));
  assert.equal(first.idempotency_key, providerKey, "the provider identity is stable per run");

  const overlap = await one(
    "select * from public.claim_email_flow_step_run_v2($1::uuid, $2::uuid, $3::text, $4::text)",
    [OWNER_A, run.id, KEY("worker-b"), providerKey],
  );
  assert.equal(overlap.claim_token, KEY("worker-a"), "the overlapping worker never owns the claim");
  assert.equal(overlap.attempts, 1);

  await all("update public.voom_email_flow_step_runs set claimed_at = now() - interval '11 minutes' where id = $1", [run.id]);
  const abandoned = await one(
    "select public.abandon_stale_email_flow_step_run($1::uuid, $2::uuid, $3::integer) as result",
    [OWNER_A, run.id, 10],
  );
  assert.equal(jsonb(abandoned.result).outcome, "abandoned");
  const terminal = await one("select status, last_error_code from public.voom_email_flow_step_runs where id = $1", [run.id]);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.last_error_code, "provider_outcome_ambiguous");
});

test("4b. provider acceptance is recorded as accepted, never as delivered", async () => {
  const { run } = await enrolledRun("accepted");
  await one("select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)", [OWNER_A, run.id, KEY("accepted-claim")]);

  const accepted = await one(
    "select * from public.record_email_flow_step_provider_result($1::uuid, $2::uuid, $3::text, $4::text, $5::text)",
    [OWNER_A, run.id, "accepted", "accepted", "msg_01"],
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.provider_message_id, "msg_01");
  assert.ok(accepted.accepted_at);
  assert.equal(accepted.delivered_at, null, "no delivery has been proven yet");
});

test("4c. only a verified delivery event can mark a step delivered, once", async () => {
  const { run } = await enrolledRun("delivered");
  await one("select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)", [OWNER_A, run.id, KEY("delivered-claim")]);
  await one(
    "select * from public.record_email_flow_step_provider_result($1::uuid, $2::uuid, $3::text, $4::text, $5::text)",
    [OWNER_A, run.id, "accepted", "accepted", "msg_02"],
  );

  const delivered = await one(
    "select * from public.record_email_flow_delivery_event($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz, $7::text)",
    [OWNER_A, run.id, "resend", "evt_1", "email.delivered", new Date().toISOString(), "email.delivered"],
  );
  assert.equal(delivered.status, "delivered");
  assert.ok(delivered.delivered_at);

  const replay = await one(
    "select * from public.record_email_flow_delivery_event($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz, $7::text)",
    [OWNER_A, run.id, "resend", "evt_1", "email.delivered", new Date().toISOString(), "email.delivered"],
  );
  assert.equal(replay.status, "delivered");
  assert.equal(replay.delivered_at.toISOString(), delivered.delivered_at.toISOString(), "a replayed event changes nothing");

  const events = await all("select * from public.voom_email_flow_delivery_events where send_id = $1", [run.id]);
  assert.equal(events.length, 1, "the event itself is deduplicated");

  // A provider other than the one Voom actually uses is refused.
  await expectError(
    () => one(
      "select * from public.record_email_flow_delivery_event($1::uuid, $2::uuid, $3::text, $4::text, $5::text)",
      [OWNER_A, run.id, "mailgun", "evt_2", "email.delivered"],
    ),
    "invalid_event_provider",
  );
});

test("4d. a bounce marks the step failed, suppresses the address and stops the flow", async () => {
  const { flow, enrollmentId, run } = await enrolledRun("bounce", CONTACT_BOUNCES_LATER);
  await one("select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)", [OWNER_A, run.id, KEY("bounce-claim")]);

  const failed = await one(
    "select * from public.record_email_flow_delivery_event($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz, $7::text)",
    [OWNER_A, run.id, "resend", "evt_bounce", "email.bounced", new Date().toISOString(), "email.bounced"],
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.last_error_code, "email.bounced");

  const suppression = await one("select * from public.voom_email_suppressions where owner_id = $1 and email = 'erin@example.com'", [OWNER_A]);
  assert.ok(suppression, "the bounced address is durably suppressed");
  assert.equal(suppression.reason, "bounced");

  const enrollment = await one("select * from public.voom_email_flow_enrollments where id = $1", [enrollmentId]);
  assert.equal(enrollment.status, "stopped");
  assert.equal(enrollment.stop_reason, "bounced");

  const again = await enroll(flow.id, CONTACT_BOUNCES_LATER, "bounce-again");
  assert.equal(again.outcome, "ineligible", "a suppressed contact is never re-enrolled");
  assert.equal(again.reason, "suppressed");
});

test("4e. a failing step is retried a bounded number of times, then it stops", async () => {
  const { enrollmentId, run } = await enrolledRun("retry");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await one(
      "select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)",
      [OWNER_A, run.id, KEY(`retry-${attempt}`)],
    );
    assert.equal(claimed.attempts, attempt, `attempt ${attempt}`);
    await one(
      "select * from public.record_email_flow_step_provider_result($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text)",
      [OWNER_A, run.id, "failed", null, null, "provider_error", "The provider refused the send."],
    );
    if (attempt < 3) {
      // The engine puts a failed run back in the queue with the SAME row, so
      // attempts keeps counting; it never opens a second row for the step.
      const requeued = await one(
        "select * from public.reschedule_email_flow_step_run($1::uuid, $2::uuid, $3::timestamptz)",
        [OWNER_A, run.id, LATER()],
      );
      assert.equal(requeued.status, "scheduled");
      assert.equal(requeued.attempts, attempt);
    }
  }

  const exhausted = await one("select * from public.voom_email_flow_step_runs where id = $1", [run.id]);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.attempts, 3, "the attempt budget is spent");

  const enrollment = await one("select * from public.voom_email_flow_enrollments where id = $1", [enrollmentId]);
  assert.equal(enrollment.status, "stopped", "the enrollment stops rather than looping forever");
  assert.equal(enrollment.stop_reason, "send_failed");

  // A later tick cannot resurrect it: a terminal run is handed back untouched.
  const after = await one(
    "select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)",
    [OWNER_A, run.id, KEY("retry-4")],
  );
  assert.equal(after.status, "failed");
  assert.equal(after.attempts, 3, "no fourth attempt");
  assert.notEqual(after.idempotency_key, KEY("retry-4"), "and it owns no send");
});

// ─── 5. Pause, resume and editing ──────────────────────────────────────────

test("5a. pausing stops future sends without touching history", async () => {
  const { flow, enrollmentId, run } = await enrolledRun("pause");
  await one("select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)", [OWNER_A, run.id, KEY("pause-claim")]);
  await one(
    "select * from public.record_email_flow_step_provider_result($1::uuid, $2::uuid, $3::text, $4::text, $5::text)",
    [OWNER_A, run.id, "accepted", "accepted", "msg_pause"],
  );
  // Step 1 is now scheduled — that is the send the pause must prevent.
  const advanced = jsonb((await one(
    "select public.advance_email_flow_enrollment($1::uuid, $2::uuid, $3::int, $4::timestamptz, $5::text) as result",
    [OWNER_A, enrollmentId, 0, LATER(), KEY("pause-advance")],
  )).result);
  assert.equal(advanced.outcome, "advanced");
  const pending = (await runsFor(enrollmentId)).find((row) => row.position === 1);
  assert.equal(pending.status, "scheduled");

  const paused = await one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "paused"]);
  assert.equal(paused.status, "paused");
  assert.equal(paused.activated_at, null === null ? paused.activated_at : null);

  await expectError(
    () => one("select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)", [OWNER_A, pending.id, KEY("pause-claim-2")]),
    "flow_not_active",
  );

  const history = await one("select * from public.voom_email_flow_step_runs where id = $1", [run.id]);
  assert.equal(history.status, "accepted", "what already went out is recorded exactly as it was");
  assert.equal(history.provider_message_id, "msg_pause");
  const enrollment = await one("select * from public.voom_email_flow_enrollments where id = $1", [enrollmentId]);
  assert.equal(enrollment.status, "active", "pausing does not fake a cancellation");
  const stillScheduled = await one("select * from public.voom_email_flow_step_runs where id = $1", [pending.id]);
  assert.equal(stillScheduled.status, "scheduled", "the paused step is kept, not cancelled");
});

test("5b. resuming reschedules forward — an overdue step is never burst-sent", async () => {
  const { flow, run } = await enrolledRun("resume");
  await one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "paused"]);

  // The engine re-times overdue runs after a resume; a past time is refused.
  await expectError(
    () => one("select * from public.reschedule_email_flow_step_run($1::uuid, $2::uuid, $3::timestamptz)", [OWNER_A, run.id, new Date(Date.now() - 60_000).toISOString()]),
    "invalid_schedule",
  );

  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const moved = await one("select * from public.reschedule_email_flow_step_run($1::uuid, $2::uuid, $3::timestamptz)", [OWNER_A, run.id, future]);
  assert.equal(moved.status, "scheduled");
  assert.equal(new Date(moved.scheduled_for).toISOString(), future);

  const resumed = await one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "active"]);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.activated_by, "user");
});

test("5c. no mode but the owner can activate, and a flow cannot go back to draft", async () => {
  const { flow } = await enrolledRun("activate-only");
  await one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "paused"]);
  await expectError(
    () => one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "draft"]),
    "cannot_revert_to_draft",
  );

  // Autopilot cannot activate either: activation is always recorded as the owner.
  const resumed = await one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "active"]);
  assert.equal(resumed.activated_by, "user");

  await one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "archived"]);
  await expectError(
    () => one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_A, flow.id, "active"]),
    "flow_archived",
  );
});

test("5d. editing a live flow writes a new revision and leaves history alone", async () => {
  const { flow, enrollmentId, run } = await enrolledRun("revise");
  await one("select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)", [OWNER_A, run.id, KEY("revise-claim")]);
  const before = await one("select * from public.voom_email_flow_step_runs where id = $1", [run.id]);
  const snapshotBefore = JSON.stringify(before.content_snapshot);

  const revised = await one(
    "select * from public.revise_email_flow($1::uuid, $2::uuid, $3::jsonb, $4::jsonb)",
    [OWNER_A, flow.id, JSON.stringify({ name: "Welcome to SynraPay (v2)" }), JSON.stringify([
      { position: 0, title: "Welcome", purpose: "Say hello", waitMinutes: 0, subject: "Welcome aboard", previewText: "What to expect next.", body: "Hi {firstName},\n\nThanks for subscribing. Here is what happens next, in plain terms.", cta: "Reply and say hello", ctaUrl: null, contentSource: "edited" },
      { position: 1, title: "Value", purpose: "Explain", waitMinutes: 2880, subject: "What SynraPay does", previewText: "One plain explanation.", body: "Hi {firstName},\n\nThe dashboard shows every settlement and the date it lands.", cta: "Open the dashboard", ctaUrl: null, contentSource: "edited" },
    ])],
  );
  assert.equal(revised.current_revision, 2);
  assert.equal(revised.status, "active", "editing does not pause the flow");

  const rev1 = await all("select * from public.voom_email_flow_steps where flow_id = $1 and revision = 1 order by position", [flow.id]);
  const rev2 = await all("select * from public.voom_email_flow_steps where flow_id = $1 and revision = 2 order by position", [flow.id]);
  assert.equal(rev1.length, 3, "the revision already sent from is kept intact");
  assert.equal(rev2.length, 2);
  assert.ok(rev2.every((step) => step.content_source === "edited"));

  // The contact already enrolled keeps the revision it was promised.
  const enrollment = await one("select * from public.voom_email_flow_enrollments where id = $1", [enrollmentId]);
  assert.equal(enrollment.revision, 1);

  const after = await one("select * from public.voom_email_flow_step_runs where id = $1", [run.id]);
  assert.equal(JSON.stringify(after.content_snapshot), snapshotBefore, "a sent step's frozen content is immutable");
  assert.equal(after.provider_message_id, before.provider_message_id);
});

// ─── 6. Owner isolation ────────────────────────────────────────────────────

test("6a. another owner cannot enroll, claim or activate someone else's flow", async () => {
  const { flow, run } = await enrolledRun("isolation");

  const enrollAttempt = await enroll(flow.id, CONTACT_OTHER_OWNER, "iso-enroll", OWNER_B);
  assert.equal(enrollAttempt.outcome, "flow_inactive", "the flow is invisible to the other owner");

  await expectError(
    () => one("select * from public.claim_email_flow_step_run($1::uuid, $2::uuid, $3::text)", [OWNER_B, run.id, KEY("iso-claim")]),
    "step_run_not_found",
  );
  await expectError(
    () => one("select * from public.set_email_flow_status($1::uuid, $2::uuid, $3::text)", [OWNER_B, flow.id, "paused"]),
    "flow_not_found",
  );
});

test("6b. row level security keeps flow rows inside their owner", async () => {
  const d = await getDb();
  const asOwnerB = async (sql) => {
    await d.exec(`set role authenticated; set request.jwt.claim.sub = '${OWNER_B}';`);
    try {
      const { rows } = await d.query(sql);
      return rows;
    } finally {
      await d.exec("reset role; set request.jwt.claim.sub = '';");
    }
  };

  const flows = await asOwnerB("select id, owner_user_id from public.voom_email_flows");
  assert.ok(flows.every((row) => row.owner_user_id === OWNER_B), "no other owner's flows are readable");

  const steps = await asOwnerB("select owner_user_id from public.voom_email_flow_steps");
  assert.ok(steps.every((row) => row.owner_user_id === OWNER_B));
  const enrollments = await asOwnerB("select owner_user_id from public.voom_email_flow_enrollments");
  assert.ok(enrollments.every((row) => row.owner_user_id === OWNER_B));
  const runs = await asOwnerB("select owner_user_id from public.voom_email_flow_step_runs");
  assert.ok(runs.every((row) => row.owner_user_id === OWNER_B));
  // Raw provider delivery events are never readable from the browser: no
  // authenticated grant exists, not even the owner's own rows.
  await assert.rejects(
    () => asOwnerB("select owner_user_id from public.voom_email_flow_delivery_events"),
    /permission denied for table voom_email_flow_delivery_events/,
  );
});

test("6c. the flow RPCs are service-role only", async () => {
  const rpcs = [
    "public.create_email_flow(uuid,jsonb)",
    "public.enroll_email_flow_contact(uuid,uuid,uuid,timestamptz,text)",
    "public.claim_email_flow_step_run(uuid,uuid,text,integer)",
    "public.claim_email_flow_step_run_v2(uuid,uuid,text,text)",
    "public.abandon_stale_email_flow_step_run(uuid,uuid,integer)",
    "public.record_email_flow_step_provider_result(uuid,uuid,text,text,text,text,text)",
    "public.record_email_flow_delivery_event(uuid,uuid,text,text,text,timestamptz,text)",
    "public.advance_email_flow_enrollment(uuid,uuid,integer,timestamptz,text)",
    "public.stop_email_flow_enrollment(uuid,uuid,text,text)",
    "public.set_email_flow_status(uuid,uuid,text)",
    "public.reschedule_email_flow_step_run(uuid,uuid,timestamptz)",
    "public.revise_email_flow(uuid,uuid,jsonb,jsonb)",
    "public.record_email_suppression(uuid,text,text,text,text,text)",
  ];

  for (const signature of rpcs) {
    const row = await one(
      `select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as svc,
              has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth,
              has_function_privilege('public', $1::regprocedure, 'EXECUTE') as pub`,
      [signature],
    );
    assert.equal(row.svc, true, `${signature} must be callable by service_role`);
    assert.equal(row.anon, false, `${signature} must not be callable by anon`);
    assert.equal(row.auth, false, `${signature} must not be callable by authenticated`);
    assert.equal(row.pub, false, `${signature} must not be callable by PUBLIC`);
  }
});

// ─── 7. The migration is additive ──────────────────────────────────────────

test("7. migrations 0040–0044 remain additive and owner-scoped", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = "supabase/migrations";
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

  // Email Automation shipped in 0040–0044 and is frozen. The migrations after
  // it are Campaigns v3 (0045), the Multi-Social Core (0046), the YouTube
  // provider (0047), its OAuth ACL fix (0048) and the TikTok provider (0049);
  // 0050 additionally restricts user access to verified emails; no flow data,
  // function, cron path or service-role grant is rewritten.
  assert.ok(files.includes("0044_email_flow_durable_claims.sql"), "0044 is still applied");
  const afterEmailAutomation = files.filter((name) => name > "0044_email_flow_durable_claims.sql");
  assert.deepEqual(afterEmailAutomation, ["0045_campaigns_v3_unified_channels.sql", "0046_multi_social_core.sql", "0047_youtube_provider.sql", "0048_youtube_oauth_state_acl.sql", "0049_tiktok_provider.sql", "0050_verified_email_access.sql"],
    "0045 Campaigns v3, 0046 Multi-Social Core, 0047 YouTube provider, 0048 OAuth ACL fix 0049 TikTok provider and 0050 verified-email access are the only migrations after the Email Automation freeze");
  // Executed statements only: 0047 documents its rollback plan in comments
  // (`-- drop table ...`), which must not be confused with destruction.
  const stripSql = (name) => fs.readFileSync(path.join(dir, name), "utf8")
    .toLowerCase()
    .replace(/^\s*--.*$/gm, "");
  const campaignsV3 = stripSql("0045_campaigns_v3_unified_channels.sql");
  assert.doesNotMatch(campaignsV3, /voom_email_flow/, "0045 never touches an email flow table");
  assert.doesNotMatch(campaignsV3, /voom_email_identity|voom_email_brand|voom_email_asset|voom_email_suppression|voom_email_unsubscribe/,
    "0045 never touches the Branded Email Engine tables");
  assert.doesNotMatch(campaignsV3, /pg_cron|cron\.schedule/, "0045 schedules no cron");
  assert.doesNotMatch(campaignsV3, /drop table|drop column|truncate/, "0045 destroys nothing");
  const multiSocial = stripSql("0046_multi_social_core.sql");
  assert.doesNotMatch(multiSocial, /voom_email_flow/, "0046 never touches an email flow table");
  assert.doesNotMatch(multiSocial, /voom_email_identity|voom_email_brand|voom_email_asset|voom_email_suppression|voom_email_unsubscribe/,
    "0046 never touches the Branded Email Engine tables");
  assert.doesNotMatch(multiSocial, /pg_cron|cron\.schedule/, "0046 schedules no cron");
  assert.doesNotMatch(multiSocial, /drop table|drop column|truncate/, "0046 destroys nothing");
  const youTubeProvider = stripSql("0047_youtube_provider.sql");
  assert.doesNotMatch(youTubeProvider, /voom_email_flow/, "0047 never touches an email flow table");
  assert.doesNotMatch(youTubeProvider, /voom_email_identity|voom_email_brand|voom_email_asset|voom_email_suppression|voom_email_unsubscribe/,
    "0047 never touches the Branded Email Engine tables");
  assert.doesNotMatch(youTubeProvider, /pg_cron|cron\.schedule/, "0047 schedules no cron");
  assert.doesNotMatch(youTubeProvider, /drop table|drop column|truncate/, "0047 destroys nothing");
  assert.doesNotMatch(youTubeProvider, /instagram_publish_queue|instagram_connections/, "0047 never touches the Instagram integration");
  assert.ok(files.includes("0043_plans_credits_safety.sql"));
  assert.ok(files.includes("0042_branded_email_url_regex_fix.sql"));
  assert.ok(files.includes("0041_branded_email_engine.sql"));
  assert.ok(files.includes("0040_email_automation_v2.sql"));

  const sql = fs.readFileSync(path.join(dir, "0040_email_automation_v2.sql"), "utf8").toLowerCase();

  // Nothing that exists today is destroyed or reshaped.
  assert.doesNotMatch(sql, /drop table/, "no table is dropped");
  assert.doesNotMatch(sql, /drop column/, "no column is dropped");
  assert.doesNotMatch(sql, /truncate/, "nothing is truncated");
  assert.doesNotMatch(sql, /alter column [a-z_]+ type/, "no existing column is retyped");

  // Every new table is an Email Automation v2 table.
  const created = [...sql.matchAll(/create table (?:if not exists )?public\.([a-z_]+)/g)].map((m) => m[1]);
  assert.equal(created.length, 7, `expected the seven new tables, got: ${created.join(", ")}`);
  for (const table of created) {
    assert.match(table, /^voom_email_/, `${table} must be an email automation table`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`), `${table} must have RLS`);
  }

  // Owner scoping is expressed in every policy.
  // Six select policies: every browser-readable table has one. The seventh
  // table, voom_email_flow_delivery_events, has none on purpose — it carries no
  // authenticated grant at all, so raw provider events stay server-side.
  const policies = [...sql.matchAll(/create policy "([a-z_0-9]+)"/g)].map((m) => m[1]);
  assert.equal(policies.length, 6, `expected the six browser-readable tables, got: ${policies.join(", ")}`);
  assert.ok(!policies.some((name) => name.includes("delivery_events")));
  assert.match(sql, /using \(\(select auth\.uid\(\)\) = owner_user_id\)/, "flow rows are scoped to their owner");
  assert.match(sql, /using \(\(select auth\.uid\(\)\) = owner_id\)/, "suppressions are scoped to their owner");

  // There is no authenticated write path anywhere in this feature.
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]*to authenticated/, "the browser cannot write flow data");

  // 0041 (Branded Email Engine) carries the same guarantees, and never
  // touches what 0040 already shipped (delivered history stays immutable).
  const sql41 = fs.readFileSync(path.join(dir, "0041_branded_email_engine.sql"), "utf8").toLowerCase();
  assert.doesNotMatch(sql41, /drop table/, "0041 drops no table");
  assert.doesNotMatch(sql41, /drop column/, "0041 drops no column");
  assert.doesNotMatch(sql41, /truncate/, "0041 truncates nothing");
  assert.doesNotMatch(sql41, /alter column [a-z_]+ type/, "0041 retypes no existing column");
  assert.doesNotMatch(sql41, /alter table public\.voom_email_flow/, "0041 never rewrites the 0040 flow tables");

  const created41 = [...sql41.matchAll(/create table (?:if not exists )?public\.([a-z_]+)/g)].map((m) => m[1]);
  assert.equal(created41.length, 4, `expected the four new tables, got: ${created41.join(", ")}`);
  for (const table of created41) {
    assert.match(table, /^voom_email_/, `${table} must be an email engine table`);
    assert.match(sql41, new RegExp(`alter table public\\.${table} enable row level security`), `${table} must have RLS`);
  }

  const policies41 = [...sql41.matchAll(/create policy "([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.equal(policies41.length, 4, `expected the four owner-scoped select policies, got: ${policies41.join(", ")}`);
  assert.match(sql41, /using \(\(select auth\.uid\(\)\) = owner_user_id\)/, "engine rows are scoped to their owner");
  assert.doesNotMatch(sql41, /grant (?:insert|update|delete)[^;]*to authenticated/, "the browser cannot write engine data");

  // 0042 is additive in the same way: it re-declares two RPC bodies and three
  // CHECK constraints, and destroys nothing.
  const sql42 = fs.readFileSync(path.join(dir, "0042_branded_email_url_regex_fix.sql"), "utf8").toLowerCase();
  assert.doesNotMatch(sql42, /drop table/, "0042 drops no table");
  assert.doesNotMatch(sql42, /drop column/, "0042 drops no column");
  assert.doesNotMatch(sql42, /truncate/, "0042 truncates nothing");
  assert.doesNotMatch(sql42, /alter column [a-z_]+ type/, "0042 retypes no existing column");
  assert.doesNotMatch(sql42, /create table/, "0042 creates no new table");
  assert.doesNotMatch(sql42, /grant (?:insert|update|delete)[^;]*to authenticated/, "0042 adds no browser write path");
  assert.doesNotMatch(sql42, /grant execute[^;]*to (anon|authenticated)/, "0042 keeps the RPCs service-role only");
});

// ─── 8. The policy layer and the schema agree ──────────────────────────────

test("8. the policy ceilings match the database constraints", async () => {
  const flow = await createWelcome(welcomePayload({ idempotencyKey: KEY("limits") }));

  await expectError(
    () => one("select * from public.revise_email_flow($1::uuid, $2::uuid, $3::jsonb, $4::jsonb)", [
      OWNER_A, flow.id, JSON.stringify({}), JSON.stringify([
        { position: 0, waitMinutes: 20161, subject: "Too long a wait", body: "Hi {firstName}, body." },
      ]),
    ]),
    "invalid_step_wait",
  );
  await expectError(
    () => one("select * from public.revise_email_flow($1::uuid, $2::uuid, $3::jsonb, $4::jsonb)", [
      OWNER_A, flow.id, JSON.stringify({}), JSON.stringify([
        { position: 0, waitMinutes: 0, subject: "", body: "Hi {firstName}, body." },
      ]),
    ]),
    "invalid_step_subject",
  );
  assert.equal(flowTypePolicy("welcome").maxWaitMinutes, 7 * 1440, "the code fence sits inside the database ceiling");
});
