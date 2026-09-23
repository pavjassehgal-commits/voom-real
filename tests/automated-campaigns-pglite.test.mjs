/**
 * Automated Campaigns v1 — real-database regression coverage (PGlite).
 *
 * Applies the repository's actual migrations (0001..0034) to an embedded
 * PostgreSQL and exercises the REAL create_automated_campaign RPC — the same
 * function Production calls — covering the confirmed production incident:
 *
 *   - the exact 2-day announce build with a saved audience and absent
 *     optional offer/notes, in Manual, Assisted and Autopilot mode;
 *   - the safety invariants: no email send, no Instagram publish queue,
 *     no paid media generation;
 *   - idempotent repeated builds;
 *   - cross-owner audience rejection (database composite FK);
 *   - historical email/SMS rows staying valid;
 *   - malformed automated rows still being rejected;
 *   - migration 0034 repairing a database still on the broken 0033
 *     AND-joined constraint, safely and idempotently.
 *
 * PGlite reports full PostgreSQL error objects, so SQLSTATE assertions use
 * error.code exactly like the Supabase/PostgREST client does.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseLite, migrationSql } from "./helpers/pglite-supabase.mjs";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const AUD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const KEY_REPAIR = "33333333-3333-4333-8333-333333333333";
const KEY_MANUAL = "44444444-4444-4444-8444-444444444444";
const KEY_ASSISTED = "55555555-5555-4555-8555-555555555555";
const KEY_AUTOPILOT = "66666666-6666-4666-8666-666666666666";
const KEY_CROSS_OWNER = "77777777-7777-4777-8777-777777777777";

// Exact 2-day announce window in Dubai (UTC+4), kept future-relative so the
// database's real schedule guard remains meaningful as the calendar advances.
const DAY_MS = 24 * 60 * 60_000;
function dubaiDateAfter(days) {
  return new Date(Date.now() + days * DAY_MS + 4 * 60 * 60_000).toISOString().slice(0, 10);
}
const START_DATE = dubaiDateAfter(2);
const END_DATE = dubaiDateAfter(3);
const START_UTC = new Date(`${START_DATE}T00:00:00+04:00`).toISOString();
const END_UTC = new Date(`${END_DATE}T23:59:00+04:00`).toISOString();
const EMAIL_AT = new Date(`${START_DATE}T09:00:00+04:00`).toISOString();
const STORY_AT = new Date(`${START_DATE}T10:30:00+04:00`).toISOString();
const POST_AT = new Date(`${START_DATE}T19:00:00+04:00`).toISOString();

const SUMMARY =
  "MARA created a 2-day announcement campaign with 2 Instagram actions (1 Instagram post, 1 Story) and 1 email. " +
  "The sequence leads with the announcement across Instagram and email, then reinforces it with reminders.";

let db;
let appliedFiles;
let manualContainerId;

async function getDb() {
  if (!db) {
    ({ db, applied: appliedFiles } = await createSupabaseLite());
    // Workspace fixtures: two owners, each with a business and one saved audience.
    await db.exec(`
      insert into auth.users (id, email) values
        ('${OWNER_A}', 'owner.a@example.com'),
        ('${OWNER_B}', 'owner.b@example.com');
      insert into public.businesses (owner_user_id, brand_name, industry, automation_level) values
        ('${OWNER_A}', 'Voom Test Studio', 'Fashion', 'autopilot'),
        ('${OWNER_B}', 'Other Studio', 'Fashion', 'manual');
      insert into public.audiences (id, owner_id, name, type) values
        ('${AUD_A}', '${OWNER_A}', 'VIP customers', 'manual'),
        ('${AUD_B}', '${OWNER_B}', 'Other workspace audience', 'manual');
    `);
  }
  return db;
}

async function one(sql, params = []) {
  const d = await getDb();
  const { rows } = await d.query(sql, params);
  return rows[0];
}

/** All rows of a query. */
async function all(sql, params = []) {
  const d = await getDb();
  const { rows } = await d.query(sql, params);
  return rows;
}

/**
 * The exact 2-day announce campaign the planner produces for this window:
 * 1 email + 1 Instagram story + 1 Instagram post, earliest first. `status`
 * is the mode-gated status the build layer persists (proposed / needs_approval
 * / approved) — the RPC accepts exactly those three review states.
 */
function announcePayload({ key, status, audienceId = null }) {
  return {
    campaign: {
      idempotencyKey: key,
      name: "Studio news",
      goal: "announce",
      startAt: START_UTC,
      endAt: END_UTC,
      offerDetails: "",
      audience: "Dubai boutique shoppers",
      audienceId,
      notes: "",
      summary: SUMMARY,
    },
    actions: [
      {
        slot: 0,
        channel: "email",
        stage: "awareness",
        title: "your business: the news you asked for",
        purpose: "Introduces the campaign and earns attention. Email 1 of 1 in the announcement sequence.",
        scheduledFor: EMAIL_AT,
        status,
        subject: "your business: the news you asked for",
        previewText: "Here is what is happening.",
        body:
          "Hi,\n\nHere at your business, we have been working on something made for Dubai boutique shoppers.\n\n" +
          "Take a look whenever you are ready — no pressure, just a simple, clear next step.\n\n" +
          "CTA: Take a look\n\nWarmly,\nThe your business team",
        cta: "Take a look",
        audienceId,
        safetyBlockers: [],
        idempotencyKey: `action-${key.slice(0, 8)}-slot0`,
      },
      {
        slot: 1,
        channel: "instagram_story",
        stage: "awareness",
        title: "your business Story: campaign moment",
        purpose: "Introduces the campaign and earns attention. Instagram story 1 of 1.",
        scheduledFor: STORY_AT,
        status,
        concept: 'Story frame text: "Something new from your business". Keep it full-screen, one line of text.',
        caption: "Something new from your business",
        safetyBlockers: [],
        idempotencyKey: `action-${key.slice(0, 8)}-slot1`,
      },
      {
        slot: 2,
        channel: "instagram_post",
        stage: "awareness",
        title: "your business campaign announcement",
        purpose: "Introduces the campaign and earns attention. Instagram post 1 of 1.",
        scheduledFor: POST_AT,
        status,
        concept: "your business campaign announcement",
        caption: "Say hello to the latest from your business.\n\nTap through and take a look.\n\n#smallbusiness",
        safetyBlockers: [],
        idempotencyKey: `action-${key.slice(0, 8)}-slot2`,
      },
    ],
  };
}

/** Calls the real build RPC; returns the container row or rethrows. */
async function callBuild(ownerId, payload) {
  const d = await getDb();
  const { rows } = await d.query(
    "select * from public.create_automated_campaign($1, $2)",
    [ownerId, JSON.stringify(payload)],
  );
  assert.equal(rows.length, 1, "the RPC returns the container row");
  return rows[0];
}

/** Asserts the RPC fails with the given SQLSTATE and constraint. */
async function expectBuildFailure(ownerId, payload, code, constraint) {
  let threw = null;
  try {
    await callBuild(ownerId, payload);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "the build must fail");
  assert.equal(threw.code, code, `expected SQLSTATE ${code}`);
  assert.match(String(threw.message), new RegExp(`violates (check|foreign key) constraint "${constraint}"`));
}

/** Row counts across every table the build may write, for change detection. */
async function snapshotCounts() {
  return all(`
    select 'voom_campaigns' as t, count(*)::int as n from public.voom_campaigns
    union all select 'voom_campaign_actions', count(*)::int from public.voom_campaign_actions
    union all select 'mara_drafts', count(*)::int from public.mara_drafts
    union all select 'mara_conversations', count(*)::int from public.mara_conversations
    union all select 'content_calendar_items', count(*)::int from public.content_calendar_items
    union all select 'campaign_recipients', count(*)::int from public.campaign_recipients
    union all select 'campaign_sends', count(*)::int from public.campaign_sends
    union all select 'campaign_delivery_events', count(*)::int from public.campaign_delivery_events
    union all select 'instagram_publish_queue', count(*)::int from public.instagram_publish_queue
    union all select 'mara_media_generations', count(*)::int from public.mara_media_generations
    union all select 'post_draft_assets', count(*)::int from public.post_draft_assets
    order by t
  `);
}

// ─── Fresh install + hotfix migration ─────────────────────────────────────

test("fresh install: 0033 (fixed) + 0034 leave exactly one OR-joined row-shape constraint", async () => {
  const d = await getDb();
  assert.ok(appliedFiles.includes("0033_automated_campaigns.sql"));
  assert.ok(appliedFiles.includes("0034_automated_campaign_shape_check_fix.sql"), "0034 was applied on the fresh install");

  const constraintSql = `
    select count(*)::int as n, min(pg_get_constraintdef(oid)) as def
    from pg_constraint
    where conrelid = 'public.voom_campaigns'::regclass
      and conname = 'voom_campaigns_automated_shape_check'
  `;
  const before = await one(constraintSql);
  assert.equal(before.n, 1, "exactly one row-shape constraint exists");
  // The two allowed row shapes are joined with OR: container OR automated email child.
  assert.match(before.def, /OR \(\(parent_campaign_id IS NOT NULL\) AND \(is_automated(?: = true)?\) AND \(kind = 'email'(?:::text)?\)\)/);

  // 0034 is idempotent on a fresh install: re-applying it keeps one identical
  // constraint and touches no rows.
  assert.equal((await one("select count(*)::int n from public.voom_campaigns")).n, 0);
  await d.exec(migrationSql("0034_automated_campaign_shape_check_fix.sql"));
  const after = await one(constraintSql);
  assert.equal(after.n, 1, "re-applying 0034 does not duplicate the constraint");
  assert.equal(after.def, before.def, "re-applying 0034 keeps the same OR logic");
  assert.equal((await one("select count(*)::int n from public.voom_campaigns")).n, 0, "0034 touches no rows");
});

test("0034 repairs a production-like database still on the broken 0033 constraint", async () => {
  const d = await getDb();

  // Simulate Production after the buggy 0033: the AND-joined constraint, and
  // no automated rows (every build rolled back, so none could exist).
  await d.exec(`
    alter table public.voom_campaigns
      drop constraint voom_campaigns_automated_shape_check;
    alter table public.voom_campaigns
      add constraint voom_campaigns_automated_shape_check
      check (
        (parent_campaign_id is null and (
          is_automated = false
          or (kind = 'multi' and goal is not null and start_at is not null and end_at is not null and end_at >= start_at)
        ))
        and (parent_campaign_id is null or (is_automated = true and kind = 'email'))
      );
  `);

  // The confirmed production failure: any build containing an email dies with
  // 23514 and the whole RPC rolls back.
  await expectBuildFailure(
    OWNER_A,
    announcePayload({ key: KEY_REPAIR, status: "proposed", audienceId: AUD_A }),
    "23514",
    "voom_campaigns_automated_shape_check",
  );
  assert.equal(
    (await one("select count(*)::int n from public.voom_campaigns where build_idempotency_key = $1", [KEY_REPAIR])).n,
    0,
    "the failed build rolled back completely (no partial container)",
  );

  // The hotfix: 0034 swaps only the bad constraint.
  await d.exec(migrationSql("0034_automated_campaign_shape_check_fix.sql"));

  // The same 2-day announce build now succeeds.
  const payload = announcePayload({ key: KEY_REPAIR, status: "proposed", audienceId: AUD_A });
  const container = await callBuild(OWNER_A, payload);
  assert.ok(container.id);
  assert.equal(container.kind, "multi");

  // 0034 is idempotent: re-applying it changes nothing, rows included.
  const before = await snapshotCounts();
  await d.exec(migrationSql("0034_automated_campaign_shape_check_fix.sql"));
  assert.deepEqual(await snapshotCounts(), before, "re-applying 0034 touches no rows");

  // And the repaired build replays idempotently.
  const replay = await callBuild(OWNER_A, payload);
  assert.equal(replay.id, container.id, "replaying the same key returns the same container");
});

// ─── The exact 2-day announce build, all three automation modes ───────────

test("Manual build of the exact 2-day announce campaign succeeds (saved audience, no offer, no notes)", async () => {
  // The saved audience exists in this workspace.
  const audience = await one("select id, owner_id, name from public.audiences where id = $1", [AUD_A]);
  assert.ok(audience, "the saved audience exists");
  assert.equal(audience.owner_id, OWNER_A);

  const container = await callBuild(
    OWNER_A,
    announcePayload({ key: KEY_MANUAL, status: "proposed", audienceId: AUD_A }),
  );
  manualContainerId = container.id;

  // Container: a multi-channel automated announce campaign over exactly 2 days.
  assert.equal(container.kind, "multi");
  assert.equal(container.is_automated, true);
  assert.equal(container.goal, "announce");
  assert.equal(container.parent_campaign_id, null);
  assert.equal(container.status, "draft");
  assert.equal(container.start_at.toISOString(), START_UTC, "start is midnight Dubai on the requested future date");
  assert.equal(container.end_at.toISOString(), END_UTC, "end is 23:59 Dubai on the second campaign date");
  // Optional offer/notes were absent → NULL columns, not empty strings.
  assert.equal(container.offer_details, null, "no offerDetails → NULL");
  assert.equal(container.campaign_notes, null, "no notes → NULL");
  assert.equal(container.generated_summary, SUMMARY);
  assert.equal(container.build_idempotency_key, KEY_MANUAL);

  // Exactly one email child, linked to the container and the saved audience.
  const children = await all(
    "select * from public.voom_campaigns where parent_campaign_id = $1 order by created_at",
    [container.id],
  );
  assert.equal(children.length, 1, "one email child for the 2-day announce plan");
  const child = children[0];
  assert.equal(child.kind, "email");
  assert.equal(child.is_automated, true);
  assert.equal(child.audience_id, AUD_A, "the email targets the saved owned audience");
  assert.equal(child.status, "draft", "Manual mode never auto-approves");
  assert.equal(child.approved_at, null);
  assert.ok(child.subject.length > 0);
  assert.match(child.content, /CTA: Take a look/);

  // The ordered action timeline: email → story → post, all proposals.
  const actions = await all(
    "select * from public.voom_campaign_actions where campaign_id = $1 order by slot",
    [container.id],
  );
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((a) => a.slot), [0, 1, 2]);
  assert.deepEqual(actions.map((a) => a.status), ["proposed", "proposed", "proposed"]);
  assert.equal(actions[0].channel, "email");
  assert.equal(actions[0].email_campaign_id, child.id);
  assert.equal(actions[0].draft_id, null);
  for (const a of actions.slice(1)) {
    assert.ok(a.draft_id, "Instagram actions carry a draft, never an email link");
    assert.equal(a.email_campaign_id, null);
    assert.deepEqual(a.safety_blockers, []);
  }
  assert.deepEqual(
    new Set(actions.slice(1).map((a) => a.channel)),
    new Set(["instagram_story", "instagram_post"]),
  );

  // The Instagram drafts exist as plain drafts in the campaign conversation.
  const draftIds = actions.slice(1).map((a) => a.draft_id);
  const drafts = await all(
    `select d.kind, d.status, c.title from public.mara_drafts d
     join public.mara_conversations c on c.id = d.conversation_id
     where d.owner_user_id = $1 and d.id in (${draftIds.map((x) => `'${x}'`).join(",")})`,
    [OWNER_A],
  );
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every((x) => x.status === "draft"), "drafts are never auto-approved or scheduled");
  assert.ok(drafts.every((x) => x.title === "Automated Campaigns"), "drafts live in the audit conversation");
  assert.deepEqual(
    new Set(drafts.map((x) => x.kind)),
    new Set(["story", "instagram_post"]),
  );
});

test("Assisted build succeeds: every action waits for approval, nothing is auto-approved", async () => {
  const container = await callBuild(
    OWNER_A,
    announcePayload({ key: KEY_ASSISTED, status: "needs_approval", audienceId: AUD_A }),
  );
  const actions = await all(
    "select * from public.voom_campaign_actions where campaign_id = $1 order by slot",
    [container.id],
  );
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((a) => a.status), ["needs_approval", "needs_approval", "needs_approval"]);

  const child = await one("select * from public.voom_campaigns where parent_campaign_id = $1", [container.id]);
  assert.equal(child.status, "draft", "Assisted mode keeps the email child in draft");
  assert.equal(child.approved_at, null);

  // No approved calendar mirrors in Assisted mode.
  const draftIds = actions.filter((a) => a.draft_id).map((a) => `'${a.draft_id}'`).join(",");
  const mirrors = await all(
    `select count(*)::int as n from public.content_calendar_items
     where owner_user_id = $1 and source_draft_id in (${draftIds})`,
    [OWNER_A],
  );
  assert.equal(mirrors[0].n, 0, "Assisted mode creates no approved calendar mirrors");
});

test("Autopilot build succeeds: safe actions are approved, mirrors are approved (never scheduled)", async () => {
  const container = await callBuild(
    OWNER_A,
    announcePayload({ key: KEY_AUTOPILOT, status: "approved", audienceId: AUD_A }),
  );
  const actions = await all(
    "select * from public.voom_campaign_actions where campaign_id = $1 order by slot",
    [container.id],
  );
  assert.deepEqual(actions.map((a) => a.status), ["approved", "approved", "approved"]);

  // The email child is approved (approval state only — still nothing is sent).
  const child = await one("select * from public.voom_campaigns where parent_campaign_id = $1", [container.id]);
  assert.equal(child.status, "approved");
  assert.ok(child.approved_at, "approval records the decision time");

  // The Instagram drafts are mirrored to the calendar as 'approved' (never
  // 'scheduled'): without a visual, the publish queue has nothing to run.
  const drafts = await all(
    `select id, kind, status from public.mara_drafts
     where owner_user_id = $1 and id in (${actions.filter((a) => a.draft_id).map((a) => `'${a.draft_id}'`).join(",")})`,
    [OWNER_A],
  );
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every((x) => x.status === "approved"), "autopilot-safe drafts are approved");
  const draftIds = drafts.map((x) => `'${x.id}'`).join(",");
  const mirrors = await all(
    `select * from public.content_calendar_items
     where owner_user_id = $1 and source_draft_id in (${draftIds})`,
    [OWNER_A],
  );
  assert.equal(mirrors.length, 2);
  assert.ok(mirrors.every((m) => m.status === "approved"), "calendar mirrors are approved, never scheduled");
  assert.deepEqual(new Set(mirrors.map((m) => m.channel)), new Set(["Story", "Instagram"]));
});

// ─── Safety invariants: the build never sends, publishes or spends ────────

test("the build never sends email: no recipients, sends or delivery events for any child", async () => {
  const children = await all(
    "select id from public.voom_campaigns where owner_user_id = $1 and parent_campaign_id is not null",
    [OWNER_A],
  );
  assert.ok(children.length >= 3, "the builds above produced email children");
  for (const table of ["campaign_recipients", "campaign_sends", "campaign_delivery_events"]) {
    const { rows } = await (await getDb()).query(`select count(*)::int n from public.${table} where owner_user_id = $1`, [OWNER_A]);
    assert.equal(rows[0].n, 0, `${table} has no rows: the build never enters the send lifecycle`);
  }
});

test("the build never queues Instagram publishing", async () => {
  const { rows } = await (await getDb()).query("select count(*)::int n from public.instagram_publish_queue where owner_user_id = $1", [OWNER_A]);
  assert.equal(rows[0].n, 0, "no publish-queue rows exist for the campaign drafts");
});

test("the build never generates paid media", async () => {
  for (const table of ["mara_media_generations", "post_draft_assets"]) {
    const { rows } = await (await getDb()).query(`select count(*)::int n from public.${table} where owner_user_id = $1`, [OWNER_A]);
    assert.equal(rows[0].n, 0, `${table} has no rows: no paid media, no generated visuals`);
  }
});

// ─── Idempotency, ownership and historical data ───────────────────────────

test("a repeated build with the same idempotency key replays and never duplicates", async () => {
  const before = await snapshotCounts();
  const again = await callBuild(
    OWNER_A,
    announcePayload({ key: KEY_MANUAL, status: "proposed", audienceId: AUD_A }),
  );
  assert.equal(again.id, manualContainerId, "the same key returns the same container");
  assert.deepEqual(await snapshotCounts(), before, "the replay changed no rows");
  const { rows } = await (await getDb()).query(
    "select count(*)::int n from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2 and parent_campaign_id is null",
    [OWNER_A, KEY_MANUAL],
  );
  assert.equal(rows[0].n, 1, "one container per build key");
});

test("a cross-owner audience is rejected by the database composite FK", async () => {
  // The composite FK is the enforcement point: (audience_id, owner_user_id)
  // may only reference an audience owned by the campaign's own owner.
  const fk = await one(
    "select conname from pg_constraint where conrelid = 'public.voom_campaigns'::regclass and conname = 'voom_campaigns_audience_fk'",
  );
  assert.ok(fk, "the composite audience FK exists");

  await expectBuildFailure(
    OWNER_A,
    announcePayload({ key: KEY_CROSS_OWNER, status: "proposed", audienceId: AUD_B }),
    "23503",
    "voom_campaigns_audience_fk",
  );
  assert.equal(
    (await one("select count(*)::int n from public.voom_campaigns where build_idempotency_key = $1", [KEY_CROSS_OWNER])).n,
    0,
    "no partial container or child survives the rejection",
  );
});

test("historical email and SMS campaigns remain valid under the corrected constraint", async () => {
  // Both historical top-level shapes insert cleanly under the corrected check.
  await (await getDb()).exec(`
    insert into public.voom_campaigns (owner_user_id, kind, name, subject, content, proposed_send_at, status)
    values ('${OWNER_A}', 'email', 'Legacy email campaign', 'Legacy subject', 'Legacy body', '2026-01-15T06:00:00+04:00', 'draft');
    insert into public.voom_campaigns (owner_user_id, kind, name, subject, content, proposed_send_at, status)
    values ('${OWNER_A}', 'sms', 'Legacy SMS campaign', 'Legacy SMS', 'Legacy SMS body', '2026-01-16T06:00:00+04:00', 'draft');
  `);
  const emailRow = await one(
    "select * from public.voom_campaigns where owner_user_id = $1 and name = 'Legacy email campaign'",
    [OWNER_A],
  );
  const smsRow = await one(
    "select * from public.voom_campaigns where owner_user_id = $1 and name = 'Legacy SMS campaign'",
    [OWNER_A],
  );
  assert.ok(emailRow, "historical email rows are accepted");
  assert.ok(smsRow, "historical SMS rows are accepted");
  assert.equal(emailRow.is_automated, false);
  assert.equal(emailRow.parent_campaign_id, null);
  assert.equal(smsRow.is_automated, false);
  assert.equal(smsRow.parent_campaign_id, null);
  // And they stay readable alongside automated containers.
  const { rows } = await (await getDb()).query(
    "select count(*)::int n from public.voom_campaigns where owner_user_id = $1 and parent_campaign_id is null",
    [OWNER_A],
  );
  assert.ok(rows[0].n >= 5, "legacy rows coexist with automated containers");
});

test("malformed automated rows are still rejected by the corrected constraint", async () => {
  const parent = manualContainerId;

  const expectShapeViolation = async (sql, label) => {
    let threw = null;
    try {
      await (await getDb()).exec(sql);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, label);
    assert.equal(threw.code, "23514", `${label}: SQLSTATE`);
    assert.match(String(threw.message), /new row(?: for relation "[^"]+")? violates check constraint "voom_campaigns_automated_shape_check"/, label);
  };

  // (a) A child action campaign must be flagged automated.
  await expectShapeViolation(
    `insert into public.voom_campaigns (owner_user_id, kind, name, content, is_automated, parent_campaign_id)
     values ('${OWNER_A}', 'email', 'child not flagged', 'x', false, '${parent}')`,
    "non-automated child rejected",
  );
  // (b) Automated children are email-only — never SMS.
  await expectShapeViolation(
    `insert into public.voom_campaigns (owner_user_id, kind, name, content, is_automated, parent_campaign_id)
     values ('${OWNER_A}', 'sms', 'automated SMS child', 'x', true, '${parent}')`,
    "automated SMS child rejected",
  );
  // (c) A top-level row flagged automated must be a multi container.
  await expectShapeViolation(
    `insert into public.voom_campaigns (owner_user_id, kind, name, content, is_automated, parent_campaign_id)
     values ('${OWNER_A}', 'email', 'top-level flagged email', 'x', true, null)`,
    "top-level automated email rejected",
  );
  // (d) An automated container must carry its date range.
  await expectShapeViolation(
    `insert into public.voom_campaigns
       (owner_user_id, kind, name, content, is_automated, parent_campaign_id, goal, start_at, end_at)
     values ('${OWNER_A}', 'multi', 'container without dates', 'x', true, null, 'announce', null, null)`,
    "container without dates rejected",
  );
});
