/**
 * MARA Phase 2C — emergency resume and Assisted approval reliability.
 *
 * The SQL tests run the REAL migration 0059 (pause_all_automation,
 * resume_all_automation, the claim guard and the browser-write guard) on an
 * embedded PostgreSQL (PGlite) with every repository migration applied.
 * The TypeScript tests drive the resume service, the entitlement boundary
 * and the Assisted confirm compare-and-swap with deterministic fakes and a
 * real PGlite draft row (its updated_at trigger is what the CAS relies on).
 *
 * PGlite is a single connection, so "concurrent" pause/resume is covered by
 * (a) the shared owner-row lock both functions take before any write, and
 * (b) interleaved replays whose results must stay consistent. True
 * multi-connection contention needs a real Postgres (release blocker note).
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const safety = await import("../lib/voom/automation-safety.ts");

const OWNER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_B = "bbbbbbbb-0000-4000-8000-000000000002";
const FUTURE = "2030-01-01T10:00:00.000Z";
let seq = 0;
const key = (label) => `test-key-${label}-${String(++seq).padStart(6, "0")}`;

async function freshDb() {
  const { db } = await createSupabaseLite();
  return db;
}

async function seedOwner(db, owner, { plan = "max", mode = "autopilot" } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [owner, `${owner.slice(0, 4)}@example.test`]);
  await db.query("insert into public.businesses (owner_user_id, plan, automation_level) values ($1, $2, $3)", [owner, plan, mode]);
  const conv = await db.query("insert into public.mara_conversations (owner_user_id) values ($1) returning id", [owner]);
  return conv.rows[0].id;
}

async function draft(db, owner, conv, { origin = "autopilot", status = "approved", content = "Caption", kind = "instagram_post" } = {}) {
  const r = await db.query(
    `insert into public.mara_drafts (owner_user_id, conversation_id, kind, channel, title, content, status, approval_origin, proposed_publish_at)
     values ($1,$2,$3,'instagram','Post',$4,$5,$6,$7) returning id`,
    [owner, conv, kind, content, status, origin, FUTURE],
  );
  return r.rows[0].id;
}

async function igJob(db, owner, draftId, { status = "scheduled", containerId = null, mediaId = null } = {}) {
  const published = status === "published";
  const r = await db.query(
    `insert into public.instagram_publish_queue (owner_user_id, draft_id, media_kind, scheduled_at, idempotency_key, status, container_id, instagram_media_id, published_at)
     values ($1,$2,'image',$3,$4,$5,$6,$7,$8) returning id`,
    [owner, draftId, FUTURE, key("ig"), status, containerId, mediaId, published ? new Date().toISOString() : null],
  );
  return r.rows[0].id;
}

async function ttJob(db, owner, draftId, { status = "scheduled" } = {}) {
  const r = await db.query(
    `insert into public.tiktok_publish_queue (owner_user_id, draft_id, title, scheduled_at, idempotency_key, status)
     values ($1,$2,'Clip',$3,$4,$5) returning id`,
    [owner, draftId, FUTURE, key("tt"), status],
  );
  return r.rows[0].id;
}

async function ytJob(db, owner, draftId) {
  const r = await db.query(
    `insert into public.youtube_publish_queue (owner_user_id, draft_id, youtube_format, title, scheduled_at, idempotency_key)
     values ($1,$2,'short','Short',$3,$4) returning id`,
    [owner, draftId, FUTURE, key("yt")],
  );
  return r.rows[0].id;
}

async function flow(db, owner, status = "active") {
  const r = await db.query(
    `insert into public.voom_email_flows (owner_user_id, flow_type, trigger_type, name, status, activated_at)
     values ($1,'welcome','newly_eligible_contact','Welcome',$2,now()) returning id`,
    [owner, status],
  );
  return r.rows[0].id;
}

const pause = async (db, owner, k = key("pause")) => (await db.query("select public.pause_all_automation($1,$2) as r", [owner, k])).rows[0].r;
const resume = async (db, owner, k = key("resume")) => (await db.query("select public.resume_all_automation($1,$2) as r", [owner, k])).rows[0].r;
const status = async (db, table, id) => (await db.query(`select status from public.${table} where id = $1`, [id])).rows[0].status;
const pausedAt = async (db, owner) => (await db.query("select automation_paused_at from public.businesses where owner_user_id = $1", [owner])).rows[0].automation_paused_at;
const claimIg = async (db, id) => (await db.query("update public.instagram_publish_queue set status = 'publishing', claimed_at = now() where id = $1 and status = 'scheduled' returning id", [id])).rows.length;

test("pause stops only fresh Autopilot jobs; resume lifts the pause without restoring cancelled jobs or paused flows", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const auto = await draft(db, OWNER_A, conv, { origin: "autopilot" });
  const manual = await draft(db, OWNER_A, conv, { origin: "user" });
  const ttAuto = await draft(db, OWNER_A, conv, { origin: "autopilot", kind: "tiktok_video" });
  const ytAuto = await draft(db, OWNER_A, conv, { origin: "autopilot", kind: "youtube_short" });
  const pending = await igJob(db, OWNER_A, auto);
  const claimed = await igJob(db, OWNER_A, await draft(db, OWNER_A, conv, { origin: "autopilot" }), { status: "publishing", containerId: "c-1" });
  const published = await igJob(db, OWNER_A, await draft(db, OWNER_A, conv, { origin: "autopilot" }), { status: "published", containerId: "c-2", mediaId: "m-2" });
  const manualJob = await igJob(db, OWNER_A, manual);
  const tiktok = await ttJob(db, OWNER_A, ttAuto);
  const youtube = await ytJob(db, OWNER_A, ytAuto);
  const welcome = await flow(db, OWNER_A, "active");

  const paused = await pause(db, OWNER_A);
  assert.equal(paused.alreadyPaused, false);
  assert.deepEqual(paused.socialJobsStopped, { instagram: 1, youtube: 1, tiktok: 1 });
  assert.equal(paused.lifecycleFlowsPaused, 1);
  assert.equal(await status(db, "instagram_publish_queue", pending), "cancelled");
  assert.equal(await status(db, "instagram_publish_queue", claimed), "publishing", "claimed/in-flight work is left to reconciliation");
  assert.equal(await status(db, "instagram_publish_queue", published), "published");
  assert.equal(await status(db, "instagram_publish_queue", manualJob), "scheduled", "manual approvals are preserved");
  assert.equal(await status(db, "tiktok_publish_queue", tiktok), "cancelled");
  assert.equal(await status(db, "youtube_publish_queue", youtube), "cancelled");
  assert.equal(await status(db, "voom_email_flows", welcome), "paused");
  assert.ok(await pausedAt(db, OWNER_A));

  const resumed = await resume(db, OWNER_A);
  assert.equal(resumed.wasPaused, true);
  assert.ok(resumed.pausedSince);
  assert.deepEqual(resumed.notRestored, { cancelledAutopilotJobs: 3, pausedLifecycleFlows: 1 });
  assert.equal(await pausedAt(db, OWNER_A), null);
  for (const [table, id] of [["instagram_publish_queue", pending], ["tiktok_publish_queue", tiktok], ["youtube_publish_queue", youtube]]) {
    assert.equal(await status(db, table, id), "cancelled", `${table}: resume never re-queues a cancelled job`);
  }
  assert.equal(await status(db, "voom_email_flows", welcome), "paused", "resume never re-activates a lifecycle flow");
  assert.equal(await status(db, "instagram_publish_queue", manualJob), "scheduled");
  assert.equal(await status(db, "instagram_publish_queue", published), "published");

  const events = (await db.query("select action, result from public.automation_pause_events where owner_user_id = $1 order by created_at, action", [OWNER_A])).rows;
  assert.deepEqual(events.map((e) => e.action).sort(), ["pause", "resume"], "both actions are recorded in the audit table");
});

test("claim guard: while paused a fresh Autopilot job cannot be claimed; a user-approved one can; after resume Autopilot claims again", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  await pause(db, OWNER_A);
  // Rows that appear after the pause (e.g. a racing sync) are not cancelled by it.
  const autoRow = await igJob(db, OWNER_A, await draft(db, OWNER_A, conv, { origin: "autopilot" }));
  const userRow = await igJob(db, OWNER_A, await draft(db, OWNER_A, conv, { origin: "user" }));
  assert.equal(await claimIg(db, autoRow), 0, "paused Autopilot work is invisible to the worker claim");
  assert.equal(await status(db, "instagram_publish_queue", autoRow), "scheduled");
  assert.equal(await claimIg(db, userRow), 1, "explicit user approvals still publish during a pause");
  await resume(db, OWNER_A);
  assert.equal(await claimIg(db, autoRow), 1, "after an explicit resume the not-cancelled Autopilot row is claimable again");
});

test("pause → resume → pause: each transition is real, audited and stops new Autopilot work again", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  await pause(db, OWNER_A);
  await resume(db, OWNER_A);
  const afterResume = await igJob(db, OWNER_A, await draft(db, OWNER_A, conv, { origin: "autopilot" }));
  const again = await pause(db, OWNER_A);
  assert.equal(again.alreadyPaused, false, "the second pause is a new pause, not a replay");
  assert.equal(again.socialJobsStopped.instagram, 1);
  assert.equal(await status(db, "instagram_publish_queue", afterResume), "cancelled");
  assert.ok(await pausedAt(db, OWNER_A));
  const actions = (await db.query("select action from public.automation_pause_events where owner_user_id = $1", [OWNER_A])).rows.map((r) => r.action);
  assert.deepEqual(actions.sort(), ["pause", "pause", "resume"]);
});

test("repeated resume: the same key replays the first result; a new key while active is a truthful no-op", async () => {
  const db = await freshDb();
  await seedOwner(db, OWNER_A);
  await pause(db, OWNER_A);
  const k = key("resume-replay");
  const first = await resume(db, OWNER_A, k);
  const replay = await resume(db, OWNER_A, k);
  assert.deepEqual(replay, first);
  const second = await resume(db, OWNER_A);
  assert.equal(second.wasPaused, false, "resuming an active account reports that nothing was paused");
  assert.equal(await pausedAt(db, OWNER_A), null);
  const count = (await db.query("select count(*)::int as n from public.automation_pause_events where owner_user_id = $1 and action = 'resume'", [OWNER_A])).rows[0].n;
  assert.equal(count, 2, "a replayed key records nothing new");
});

test("interleaved pause/resume replays stay consistent; a key can never be reused across actions", async () => {
  const db = await freshDb();
  await seedOwner(db, OWNER_A);
  const pk = key("p");
  const rk = key("r");
  const p1 = await pause(db, OWNER_A, pk);
  const r1 = await resume(db, OWNER_A, rk);
  // Late, duplicated deliveries of both requests (the race a double-click or
  // retry produces) must replay their own results and must not flip state.
  assert.deepEqual(await pause(db, OWNER_A, pk), p1);
  assert.deepEqual(await resume(db, OWNER_A, rk), r1);
  assert.equal(await pausedAt(db, OWNER_A), null, "a replayed pause after a resume does not silently re-pause");
  await assert.rejects(() => resume(db, OWNER_A, pk), /automation_idempotency_key_reused/);
  await assert.rejects(() => pause(db, OWNER_A, rk), /automation_idempotency_key_reused/);
  const sql = await read("supabase/migrations/0059_automation_emergency_pause.sql");
  const lockCount = (sql.match(/where owner_user_id = p_owner_user_id for update;/g) ?? []).length;
  assert.equal(lockCount, 2, "pause and resume both serialize on the same owner row lock before writing");
});

test("cross-owner isolation: pausing or resuming one owner never touches another", async () => {
  const db = await freshDb();
  const convA = await seedOwner(db, OWNER_A);
  const convB = await seedOwner(db, OWNER_B);
  const jobB = await igJob(db, OWNER_B, await draft(db, OWNER_B, convB, { origin: "autopilot" }));
  const flowB = await flow(db, OWNER_B, "active");
  await igJob(db, OWNER_A, await draft(db, OWNER_A, convA, { origin: "autopilot" }));
  const sharedKey = key("shared");
  await pause(db, OWNER_A, sharedKey);
  assert.equal(await status(db, "instagram_publish_queue", jobB), "scheduled");
  assert.equal(await status(db, "voom_email_flows", flowB), "active");
  assert.equal(await pausedAt(db, OWNER_B), null);
  // The same idempotency key under another owner is a different request.
  const pausedB = await pause(db, OWNER_B, sharedKey);
  assert.equal(pausedB.socialJobsStopped.instagram, 1);
  await resume(db, OWNER_A);
  assert.ok(await pausedAt(db, OWNER_B), "resuming A leaves B paused");
  await assert.rejects(() => resume(db, "cccccccc-0000-4000-8000-000000000003"), /automation_owner_not_found/);
});

test("browser roles cannot clear or set the pause, cannot call resume, but can still change mode while paused", async () => {
  const db = await freshDb();
  await seedOwner(db, OWNER_A, { plan: "max", mode: "autopilot" });
  await pause(db, OWNER_A);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER_A}', false);`);
  try {
    await assert.rejects(() => db.query("update public.businesses set automation_paused_at = null where owner_user_id = $1", [OWNER_A]), /automation_pause_server_only/);
    await assert.rejects(() => db.query("select public.resume_all_automation($1,$2)", [OWNER_A, key("browser")]), /permission denied/);
    await assert.rejects(() => db.query("select public.pause_all_automation($1,$2)", [OWNER_A, key("browser")]), /permission denied/);
    // A mode change while paused is allowed and does NOT lift the pause.
    await db.query("update public.businesses set automation_level = 'assisted' where owner_user_id = $1", [OWNER_A]);
  } finally {
    await db.exec("reset role;");
  }
  const row = (await db.query("select automation_level, automation_paused_at from public.businesses where owner_user_id = $1", [OWNER_A])).rows[0];
  assert.equal(row.automation_level, "assisted");
  assert.ok(row.automation_paused_at, "still paused after a mode change");
  const resumed = await resume(db, OWNER_A);
  assert.equal(resumed.automationMode, "assisted", "resume reports the mode chosen while paused");
});

function fakeAdmin({ rpcResult, business } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) { calls.push([name, args]); return { data: rpcResult ?? null, error: rpcResult ? null : { message: "x" } }; },
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        async maybeSingle() { calls.push(["from", table]); return { data: business ?? null, error: null }; },
      };
      return chain;
    },
  };
}

test("subscription downgrade while paused: resume reports the mode is no longer included and autonomous work stays blocked", async () => {
  const admin = fakeAdmin({ rpcResult: { wasPaused: true, pausedSince: "2026-10-18T00:00:00Z", automationMode: "autopilot", plan: "pro", notRestored: { cancelledAutopilotJobs: 2, pausedLifecycleFlows: 1 } } });
  const result = await safety.resumeAllAutomation(admin, OWNER_A, key("ts"));
  assert.equal(result.modeAllowedByPlan, false);
  assert.deepEqual(result.notRestored, { cancelledAutopilotJobs: 2, pausedLifecycleFlows: 1 });
  assert.deepEqual(admin.calls[0], ["resume_all_automation", { p_owner_user_id: OWNER_A, p_idempotency_key: admin.calls[0][1].p_idempotency_key }]);

  const blocked = fakeAdmin({ business: { automation_level: "autopilot", automation_paused_at: null, plan: "pro" } });
  await assert.rejects(() => safety.assertAutonomousWorkAllowed(blocked, OWNER_A), /automation_subscription_restricted/);
  const stillPaused = fakeAdmin({ business: { automation_level: "autopilot", automation_paused_at: "2026-10-18T00:00:00Z", plan: "max" } });
  await assert.rejects(() => safety.assertAutonomousWorkAllowed(stillPaused, OWNER_A), /automation_paused/);
  const allowed = fakeAdmin({ business: { automation_level: "autopilot", automation_paused_at: null, plan: "max" } });
  await safety.assertAutonomousWorkAllowed(allowed, OWNER_A);
  await assert.rejects(() => safety.resumeAllAutomation(fakeAdmin({}), OWNER_A, key("ts")), /automation_resume_failed/);
});

test("resume endpoint: authenticated, explicit confirm, owner from the session, and only reachable from that route", async () => {
  const route = await read("app/api/automation/resume/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /status: 401/);
  assert.match(route, /confirm: z\.literal\(true\)/, "nothing resumes without an explicit confirm flag");
  assert.match(route, /\.strict\(\)/);
  assert.match(route, /resumeAllAutomation\(createAdminClient\(\), user\.id, parsed\.data\.idempotencyKey\)/);
  // MARA never resumes itself: the only caller of the resume service is the owner route.
  const { execSync } = await import("node:child_process");
  const callers = execSync("grep -rl 'resumeAllAutomation\\|resume_all_automation' app lib || true", { cwd: new URL("../", import.meta.url) }).toString().trim().split("\n").sort();
  assert.deepEqual(callers, ["app/api/automation/resume/route.ts", "lib/voom/automation-safety.ts"]);
});

// Assisted confirm vs. concurrent edit/media swap: tests/approval-integrity.test.mjs

test("the confirm route re-opens a stale card on the current draft instead of failing it silently", async () => {
  const route = await read("app/api/mara/actions/[id]/route.ts");
  assert.match(route, /err\.message === APPROVAL_STALE/);
  assert.match(route, /reopenStaleDraftApproval\(admin, user\.id, id, staleDraftId\)/);
  assert.match(route, /status: 409/);
  const tools = await read("lib/mara/tools.ts");
  assert.match(tools, /approveDraftFromConfirmedSnapshot\(c\.db, c\.ownerId, a\.sourceDraftId as string, a, draft,/);
  assert.doesNotMatch(tools, /content: draft\?\.content \?\? a\.content/, "the live draft is no longer approved blindly");
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /export async function reopenStaleDraftApproval[\s\S]*eq\("status", "executing"\)[\s\S]*refreshPendingDraftApproval\(admin, ownerId, view\)/);
});
