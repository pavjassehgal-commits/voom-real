/**
 * MARA Phase 2D — approval integrity.
 *
 * Runs the REAL migration 0059 (content versions, the approval-integrity
 * trigger, the media trigger, job withdrawal, the owner reschedule function
 * and the versioned approval-card editor) on an embedded PostgreSQL (PGlite)
 * with every repository migration applied, plus the Assisted confirm
 * compare-and-swap and the Instagram publish-flow re-checks.
 *
 * The invariant under test: a draft is `approved` only while its approval
 * covers the CURRENT content version. Any publishable change — caption,
 * title, format, media brief, platform metadata, the attached image/video,
 * the schedule — revokes it in the database, whatever code path made it.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const approval = await import("../lib/mara/draft-approval.ts");
const flow = await import("../lib/instagram/publish-flow.ts");

const OWNER_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OWNER_B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const FUTURE = "2030-01-01T10:00:00.000Z";
const LATER = "2030-01-02T10:00:00.000Z";
let seq = 0;
const uniq = (label) => `${label}-integrity-${String(++seq).padStart(8, "0")}`;

async function freshDb() {
  const { db } = await createSupabaseLite();
  return db;
}

async function seedOwner(db, owner) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [owner, `${owner.slice(0, 4)}@example.test`]);
  await db.query("insert into public.businesses (owner_user_id, plan, automation_level) values ($1, 'max', 'assisted')", [owner]);
  return (await db.query("insert into public.mara_conversations (owner_user_id) values ($1) returning id", [owner])).rows[0].id;
}

async function draft(db, owner, conv, { status = "approved", kind = "instagram_post", content = "Caption v1", meta = {} } = {}) {
  const social = kind === "tiktok_video" ? ["tiktok", "video"] : kind === "youtube_short" ? ["youtube", "short"] : [null, null];
  return (await db.query(
    `insert into public.mara_drafts (owner_user_id, conversation_id, kind, channel, title, content, status, proposed_publish_at, social_channel, social_format, content_meta)
     values ($1,$2,$3,'instagram','Launch',$4,$5,$6,$7,$8,$9::jsonb) returning id`,
    [owner, conv, kind, content, status, FUTURE, social[0], social[1], JSON.stringify(meta)],
  )).rows[0].id;
}

async function attach(db, owner, draftId, { mime = "image/png", name = uniq("asset") } = {}) {
  await db.query(
    `insert into public.post_draft_assets (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size)
     values ($1,$2,$3,'visual.png',$4,1024)`,
    [owner, draftId, `${owner}/post-assets/${name}-${draftId}.bin`, mime],
  );
}

/** An approved post whose approval covers its media (attached first, then approved). */
async function approvedWithMedia(db, owner, conv, options = {}) {
  const id = await draft(db, owner, conv, { ...options, status: "draft" });
  await attach(db, owner, id, options.mime ? { mime: options.mime } : {});
  await db.query("update public.mara_drafts set status = 'approved' where id = $1", [id]);
  return id;
}

const replace = (db, owner, draftId, name = uniq("swap")) => db.query(
  "update public.post_draft_assets set storage_path = $3 where owner_user_id = $1 and draft_id = $2",
  [owner, draftId, `${owner}/post-assets/${name}-${draftId}.bin`],
);

async function igJob(db, owner, draftId, { status = "scheduled", containerId = null, mediaId = null } = {}) {
  return (await db.query(
    `insert into public.instagram_publish_queue (owner_user_id, draft_id, media_kind, scheduled_at, idempotency_key, status, container_id, instagram_media_id, published_at)
     values ($1,$2,'image',$3,$4,$5,$6,$7,$8) returning id`,
    [owner, draftId, FUTURE, uniq("ig"), status, containerId, mediaId, status === "published" ? new Date().toISOString() : null],
  )).rows[0].id;
}

async function calendarMirror(db, owner, draftId) {
  await db.query(
    "insert into public.content_calendar_items (owner_user_id, title, channel, publish_at, source_draft_id, status) values ($1,'Launch','Instagram',$2,$3,'approved')",
    [owner, FUTURE, draftId],
  );
}

const state = async (db, id) => (await db.query(
  "select status, content_version::int as v, approved_content_version::int as av, approval_origin from public.mara_drafts where id = $1", [id],
)).rows[0];
const qstatus = async (db, table, id) => (await db.query(`select status from public.${table} where id = $1`, [id])).rows[0].status;
const mirrors = async (db, draftId) => (await db.query("select count(*)::int as n from public.content_calendar_items where source_draft_id = $1", [draftId])).rows[0].n;

test("an approval covers exactly one content version; status-only writes never move it", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const inserted = await draft(db, OWNER_A, conv, { status: "approved" });
  assert.deepEqual(await state(db, inserted), { status: "approved", v: 1, av: 1, approval_origin: "user" });
  const id = await draft(db, OWNER_A, conv, { status: "draft" });
  assert.equal((await state(db, id)).av, null);
  await db.query("update public.mara_drafts set status = 'approved' where id = $1", [id]);
  assert.deepEqual(await state(db, id), { status: "approved", v: 1, av: 1, approval_origin: "user" });
  // Versions and approvals cannot be forged by a writer.
  await db.query("update public.mara_drafts set content_version = 999, approved_content_version = 999 where id = $1", [id]);
  const forged = await state(db, id);
  assert.equal(forged.v, 2, "a version only ever advances by one");
  assert.equal(forged.status, "draft", "an explicit version move is a content change and revokes the approval");
  assert.equal(forged.av, null);
});

test("editing approved content (caption, title, format, media brief) revokes the approval and withdraws unclaimed jobs and the calendar mirror", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  for (const [label, sql] of [
    ["caption", "update public.mara_drafts set content = 'Caption v2' where id = $1"],
    ["title", "update public.mara_drafts set title = 'New title' where id = $1"],
    ["format", "update public.mara_drafts set channel = 'instagram:4x5' where id = $1"],
    ["media brief", "update public.mara_drafts set media_brief = 'A different visual' where id = $1"],
  ]) {
    const id = await approvedWithMedia(db, OWNER_A, conv);
    const job = await igJob(db, OWNER_A, id);
    await calendarMirror(db, OWNER_A, id);
    const before = await state(db, id);
    await db.query(sql, [id]);
    const after = await state(db, id);
    assert.equal(after.status, "draft", `${label}: approval revoked`);
    assert.equal(after.av, null);
    assert.equal(after.v, before.v + 1);
    assert.equal(await qstatus(db, "instagram_publish_queue", job), "cancelled", `${label}: unclaimed job withdrawn`);
    assert.equal(await mirrors(db, id), 0, `${label}: calendar no longer shows it as scheduled`);
  }
});

test("complete-content approval: the FIRST visual arriving after an approval, a replacement and a removal all revoke it", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  // Approved while still waiting for its media (e.g. a card confirmed early, a campaign approval).
  const waiting = await draft(db, OWNER_A, conv);
  const waitingJob = await igJob(db, OWNER_A, waiting, { status: "waiting_for_media" });
  await attach(db, OWNER_A, waiting);
  const s1 = await state(db, waiting);
  assert.equal(s1.status, "draft", "media the approver never saw is new content: the approval does not extend to it");
  assert.equal(await qstatus(db, "instagram_publish_queue", waitingJob), "cancelled", "nothing publishes on the old approval");

  const replaced = await approvedWithMedia(db, OWNER_A, conv);
  assert.equal((await state(db, replaced)).status, "approved");
  await replace(db, OWNER_A, replaced);
  assert.equal((await state(db, replaced)).status, "draft", "a replaced image is new content");

  const removed = await approvedWithMedia(db, OWNER_A, conv);
  await db.query("delete from public.post_draft_assets where draft_id = $1", [removed]);
  assert.equal((await state(db, removed)).status, "draft", "removing the approved visual revokes");

  // Re-saving the identical file (same path, same bytes) is not a change.
  const same = await approvedWithMedia(db, OWNER_A, conv);
  const before = await state(db, same);
  await db.query("update public.post_draft_assets set display_name = 'renamed.png' where draft_id = $1", [same]);
  assert.deepEqual(await state(db, same), before);
});

test("replacing an approved video revokes the approval for Reels and TikTok, and withdraws the TikTok job", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const reel = await approvedWithMedia(db, OWNER_A, conv, { kind: "reel", mime: "video/mp4" });
  assert.equal((await state(db, reel)).status, "approved");
  await replace(db, OWNER_A, reel);
  assert.equal((await state(db, reel)).status, "draft");

  const clip = await approvedWithMedia(db, OWNER_A, conv, { kind: "tiktok_video", meta: { tiktokPrivacy: "SELF_ONLY" }, mime: "video/mp4" });
  const job = (await db.query(
    "insert into public.tiktok_publish_queue (owner_user_id, draft_id, title, scheduled_at, idempotency_key) values ($1,$2,'Clip',$3,$4) returning id",
    [OWNER_A, clip, FUTURE, uniq("tt")],
  )).rows[0].id;
  await replace(db, OWNER_A, clip);
  assert.equal((await state(db, clip)).status, "draft");
  assert.equal(await qstatus(db, "tiktok_publish_queue", job), "cancelled");
});

test("schedule changes: any writer revokes, except the owner's own reschedule through the dedicated function", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const byPlan = await draft(db, OWNER_A, conv);
  const planJob = await igJob(db, OWNER_A, byPlan);
  await db.query("update public.mara_drafts set proposed_publish_at = $2 where id = $1", [byPlan, LATER]);
  assert.equal((await state(db, byPlan)).status, "draft", "a MARA/plan reschedule needs new authorization");
  assert.equal(await qstatus(db, "instagram_publish_queue", planJob), "cancelled");

  const byOwner = await draft(db, OWNER_A, conv);
  const ownerJob = await igJob(db, OWNER_A, byOwner);
  await db.query("select public.reschedule_approved_draft($1,$2,$3)", [OWNER_A, byOwner, LATER]);
  const kept = await state(db, byOwner);
  assert.equal(kept.status, "approved", "the owner's explicit reschedule keeps their approval");
  assert.equal(kept.av, kept.v);
  assert.equal(await qstatus(db, "instagram_publish_queue", ownerJob), "scheduled");

  // The authorization is transaction-local: it does not leak to the next write.
  await db.query("update public.mara_drafts set proposed_publish_at = $2 where id = $1", [byOwner, FUTURE]);
  assert.equal((await state(db, byOwner)).status, "draft");

  // The function cannot smuggle a content change, nor reach another owner's draft.
  const conv2 = await seedOwner(db, OWNER_B);
  const other = await draft(db, OWNER_B, conv2);
  await assert.rejects(() => db.query("select public.reschedule_approved_draft($1,$2,$3)", [OWNER_A, other, LATER]), /draft_not_found/);
  assert.equal((await state(db, other)).status, "approved");
});

test("platform metadata edits (YouTube privacy/audience/description, TikTok privacy) revoke; planning notes and the TikTok consent record do not", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const base = { privacy: "private", madeForKids: false, description: "About", concept: "Idea", script: ["one"] };
  for (const [label, patch, revokes] of [
    ["privacy", { privacy: "public" }, true],
    ["made for kids", { madeForKids: true }, true],
    ["description", { description: "Changed" }, true],
    ["tiktok privacy", { tiktokPrivacy: "PUBLIC_TO_EVERYONE" }, true],
    ["concept", { concept: "Other idea" }, false],
    ["script", { script: ["two"] }, false],
    ["tiktok consent", { tiktokPost: { version: 1 } }, false],
  ]) {
    const id = await draft(db, OWNER_A, conv, { kind: "youtube_short", meta: base });
    const job = (await db.query(
      "insert into public.youtube_publish_queue (owner_user_id, draft_id, youtube_format, title, scheduled_at, idempotency_key) values ($1,$2,'short','Short',$3,$4) returning id",
      [OWNER_A, id, FUTURE, uniq("yt")],
    )).rows[0].id;
    await db.query("update public.mara_drafts set content_meta = content_meta || $2::jsonb where id = $1", [id, JSON.stringify(patch)]);
    assert.equal((await state(db, id)).status, revokes ? "draft" : "approved", label);
    assert.equal(await qstatus(db, "youtube_publish_queue", job), revokes ? "cancelled" : "scheduled", label);
  }
});

test("claimed, provider-owned and published jobs are never touched by a revocation (the documented boundary)", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const ids = [];
  for (const job of [
    { status: "publishing", containerId: "c-claimed" },
    { status: "failed", containerId: "c-ambiguous" },
    { status: "published", containerId: "c-done", mediaId: "m-done" },
  ]) {
    const id = await draft(db, OWNER_A, conv);
    ids.push([id, await igJob(db, OWNER_A, id, job), job.status]);
  }
  for (const [id] of ids) await db.query("update public.mara_drafts set content = 'Edited' where id = $1", [id]);
  for (const [, job, status] of ids) assert.equal(await qstatus(db, "instagram_publish_queue", job), status);
});

test("duplicate prevention: revoke → re-approve re-arms the SAME queue row with a fresh container, never a second one", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const id = await draft(db, OWNER_A, conv);
  await attach(db, OWNER_A, id);
  await db.query("select public.upsert_instagram_publish_queue_item($1,$2,null,'image','Caption v1',$3,false)", [OWNER_A, id, FUTURE]);
  // A worker built a container from v1, then the owner edited and re-approved v2.
  await db.query("update public.instagram_publish_queue set status = 'failed', failure_code = 'not_approved', container_id = 'c-v1' where draft_id = $1", [id]);
  await db.query("update public.mara_drafts set content = 'Caption v2' where id = $1", [id]);
  await db.query("update public.mara_drafts set status = 'approved' where id = $1", [id]);
  await db.query("select public.upsert_instagram_publish_queue_item($1,$2,null,'image','Caption v2',$3,false)", [OWNER_A, id, FUTURE]);
  const rows = (await db.query("select status, caption, container_id from public.instagram_publish_queue where draft_id = $1", [id])).rows;
  assert.equal(rows.length, 1, "one publish identity per draft, forever");
  assert.deepEqual(rows[0], { status: "scheduled", caption: "Caption v2", container_id: null }, "the v1 container can never be published for v2");
  const repair = await read("lib/instagram/publish-queue.ts");
  assert.match(repair, /\.is\("container_id", null\)\s*\n\s*\.limit\(limit\)/, "the not_approved repair never revives a row holding an old container");
});

test("browsers cannot write drafts or call the reschedule function; the approval-card editor stamps the version it shows", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const id = await draft(db, OWNER_A, conv, { status: "draft" });
  const action = (await db.query(
    `insert into public.mara_pending_actions (owner_user_id, conversation_id, tool_name, summary, idempotency_key, sanitized_arguments, new_value, status)
     values ($1,$2,'propose_calendar_item','Approve',$3,$4::jsonb,'{}'::jsonb,'pending') returning id`,
    [OWNER_A, conv, uniq("card"), JSON.stringify({ sourceDraftId: id, content: "Caption v1", publishAt: FUTURE, contentVersion: 1 })],
  )).rows[0].id;
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER_A}', false);`);
  try {
    await assert.rejects(() => db.query("update public.mara_drafts set status = 'approved' where id = $1", [id]), /permission denied/);
    await assert.rejects(() => db.query("select public.reschedule_approved_draft($1,$2,$3)", [OWNER_A, id, LATER]), /permission denied/);
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await db.query("select public.edit_mara_calendar_approval($1, $2, $3)", [action, "Caption edited on the card", soon]);
  } finally {
    await db.exec("reset role;");
  }
  const card = (await db.query("select sanitized_arguments, new_value from public.mara_pending_actions where id = $1", [action])).rows[0];
  const { v } = await state(db, id);
  assert.equal(v, 2);
  assert.equal(card.sanitized_arguments.contentVersion, 2);
  assert.equal(card.new_value.contentVersion, 2);
});

// ---------------------------------------------------------------------------
// Assisted confirm: approve exactly the confirmed version
// ---------------------------------------------------------------------------

/** A minimal Supabase-shaped client over PGlite for mara_drafts updates. */
function draftsClient(db, hooks = {}) {
  return {
    from(table) {
      assert.equal(table, "mara_drafts");
      return {
        update(values) {
          const where = [];
          const params = [];
          const sets = Object.entries(values).map(([column, value]) => { params.push(value); return `"${column}" = $${params.length}`; });
          const chain = {
            eq(column, value) { params.push(value); where.push(`"${column}" = $${params.length}`); return chain; },
            neq(column, value) { params.push(value); where.push(`"${column}" <> $${params.length}`); return chain; },
            select() {
              return {
                async maybeSingle() {
                  if (hooks.beforeApprove) await hooks.beforeApprove();
                  const r = await db.query(`update public.mara_drafts set ${sets.join(", ")} where ${where.join(" and ")} returning id`, params);
                  return { data: r.rows[0] ?? null, error: null };
                },
              };
            },
            then(onFulfilled, onRejected) {
              return db.query(`update public.mara_drafts set ${sets.join(", ")} where ${where.join(" and ")}`, params)
                .then(() => ({ error: null })).then(onFulfilled, onRejected);
            },
          };
          return chain;
        },
      };
    },
  };
}

const row = async (db, id) => (await db.query("select content_version, status from public.mara_drafts where id = $1", [id])).rows[0];
const isStale = (err) => err.message === approval.APPROVAL_STALE;

test("assisted confirm approves exactly the confirmed version with user provenance", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const id = await draft(db, OWNER_A, conv, { status: "draft" });
  await attach(db, OWNER_A, id);
  const current = await row(db, id);
  let mirrored = 0;
  await approval.approveDraftFromConfirmedSnapshot(draftsClient(db), OWNER_A, id, { contentVersion: Number(current.content_version) }, current, async () => { mirrored++; });
  const after = await state(db, id);
  assert.equal(after.status, "approved");
  assert.equal(after.av, after.v);
  assert.equal(after.approval_origin, "user");
  assert.equal(mirrored, 1);
});

test("concurrent approval and edit/media swap: whatever lands during processing makes the confirmation stale — nothing is approved", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  for (const [label, change] of [
    ["caption edit", (id) => db.query("update public.mara_drafts set content = 'Edited' where id = $1", [id])],
    ["image replaced", (id) => replace(db, OWNER_A, id)],
    ["schedule moved", (id) => db.query("update public.mara_drafts set proposed_publish_at = $2 where id = $1", [id, LATER])],
    ["metadata changed", (id) => db.query("update public.mara_drafts set content_meta = '{\"privacy\":\"public\"}'::jsonb where id = $1", [id])],
  ]) {
    const id = await draft(db, OWNER_A, conv, { status: "draft" });
    await attach(db, OWNER_A, id);
    const shown = await row(db, id);
    let mirrored = 0;
    // The change commits after the confirmation read the draft, before its write.
    const racing = draftsClient(db, { beforeApprove: () => change(id) });
    await assert.rejects(() => approval.approveDraftFromConfirmedSnapshot(racing, OWNER_A, id, { contentVersion: Number(shown.content_version) }, shown, async () => { mirrored++; }), isStale, label);
    assert.equal((await state(db, id)).status, "draft", `${label}: nothing approved`);
    assert.equal(mirrored, 0, `${label}: no calendar/queue mirror`);
  }
});

test("replacing a video while its approval is processing is a conflict that requires renewed approval", async () => {
  const db = await freshDb();
  const conv = await seedOwner(db, OWNER_A);
  const id = await draft(db, OWNER_A, conv, { status: "draft", kind: "reel" });
  await attach(db, OWNER_A, id, { mime: "video/mp4" });
  const shown = await row(db, id);
  await replace(db, OWNER_A, id);
  const now = await row(db, id);
  await assert.rejects(() => approval.approveDraftFromConfirmedSnapshot(draftsClient(db), OWNER_A, id, { contentVersion: Number(shown.content_version) }, now, async () => {}), isStale);
  // Renewed approval of the NEW version succeeds.
  await approval.approveDraftFromConfirmedSnapshot(draftsClient(db), OWNER_A, id, { contentVersion: Number(now.content_version) }, now, async () => {});
  assert.equal((await state(db, id)).status, "approved");
});

test("legacy cards without a version, rejected drafts and other owners' drafts are never approved by a confirmation", async () => {
  const db = await freshDb();
  const convA = await seedOwner(db, OWNER_A);
  const convB = await seedOwner(db, OWNER_B);
  const legacy = await draft(db, OWNER_A, convA, { status: "draft" });
  await assert.rejects(() => approval.approveDraftFromConfirmedSnapshot(draftsClient(db), OWNER_A, legacy, { content: "Caption v1", publishAt: FUTURE }, { content_version: 1, status: "draft" }, async () => {}), isStale);

  const rejected = await draft(db, OWNER_A, convA, { status: "rejected" });
  await assert.rejects(() => approval.approveDraftFromConfirmedSnapshot(draftsClient(db), OWNER_A, rejected, { contentVersion: 1 }, { content_version: 1, status: "rejected" }, async () => {}), isStale);
  assert.equal((await state(db, rejected)).status, "rejected");

  const foreign = await draft(db, OWNER_B, convB, { status: "draft" });
  await assert.rejects(() => approval.approveDraftFromConfirmedSnapshot(draftsClient(db), OWNER_A, foreign, { contentVersion: 1 }, { content_version: 1, status: "draft" }, async () => {}), isStale);
  assert.equal((await state(db, foreign)).status, "draft");

  const failedMirror = await draft(db, OWNER_A, convA, { status: "draft" });
  await assert.rejects(() => approval.approveDraftFromConfirmedSnapshot(draftsClient(db), OWNER_A, failedMirror, { contentVersion: 1 }, { content_version: 1, status: "draft" }, async () => { throw new Error("calendar_create_failed"); }), /calendar_create_failed/);
  assert.equal((await state(db, failedMirror)).status, "draft", "a failed calendar mirror rolls our approval back");
});

// ---------------------------------------------------------------------------
// Instagram worker: the last points an approval change can still stop a post
// ---------------------------------------------------------------------------

function instagramPorts({ currentAt = () => true } = {}) {
  const calls = [];
  let checks = 0;
  return {
    calls,
    async loadDraft() { calls.push("loadDraft"); return { status: "approved", content: "Caption v1", contentVersion: 3 }; },
    async loadConnection() { return { status: "connected", scopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: null }; },
    async loadCredentials() { return { igUserId: "ig-1", accessToken: "token" }; },
    async loadAsset() { calls.push("loadAsset"); return { storagePath: "a/b.png", mimeType: "image/png", status: "uploaded" }; },
    async signMediaUrl() { return "https://signed.example/b.png"; },
    async approvalStillCurrent(_owner, _draft, version) { checks += 1; calls.push(`check:${version}`); return currentAt(checks); },
    async createContainer() { calls.push("createContainer"); return "c-1"; },
    async containerStatus() { return "FINISHED"; },
    async publishContainer() { calls.push("publishContainer"); return "m-1"; },
    async findPublishedMediaId() { return null; },
    async persistContainerId() {},
    async markPublished() { calls.push("markPublished"); },
    async markFailed(_item, input) { calls.push(`failed:${input.code}`); },
    async sleep() {},
  };
}
const IG_ITEM = { id: "q-1", ownerUserId: OWNER_A, draftId: "d-1", mediaKind: "image", caption: "Caption v1", attempts: 1, containerId: null, instagramMediaId: null };

test("Instagram worker: approval is re-checked at the claimed version right before the container and right before media_publish", async () => {
  const ok = instagramPorts();
  assert.equal((await flow.runPublishFlow({ ...IG_ITEM }, ok)).outcome, "published");
  assert.deepEqual(ok.calls.filter((c) => c.startsWith("check") || c === "createContainer" || c === "publishContainer"),
    ["check:3", "createContainer", "check:3", "publishContainer"]);

  const swappedBeforeContainer = instagramPorts({ currentAt: () => false });
  const r1 = await flow.runPublishFlow({ ...IG_ITEM }, swappedBeforeContainer);
  assert.notEqual(r1.outcome, "published");
  assert.ok(!swappedBeforeContainer.calls.includes("createContainer"), "an image swapped after the first check never reaches Meta");
  assert.ok(swappedBeforeContainer.calls.includes("failed:not_approved"));

  const editedBeforePublish = instagramPorts({ currentAt: (n) => n === 1 });
  const r2 = await flow.runPublishFlow({ ...IG_ITEM }, editedBeforePublish);
  assert.notEqual(r2.outcome, "published");
  assert.ok(editedBeforePublish.calls.includes("createContainer"));
  assert.ok(!editedBeforePublish.calls.includes("publishContainer"), "a withdrawal before media_publish stops the post");

  const unreadable = instagramPorts();
  unreadable.approvalStillCurrent = async () => { throw new Error("db"); };
  const r3 = await flow.runPublishFlow({ ...IG_ITEM }, unreadable);
  assert.ok(unreadable.calls.some((c) => c.startsWith("failed:")) && !unreadable.calls.includes("failed:not_approved"), "an unreadable draft is retried, never branded not approved");
  assert.notEqual(r3.outcome, "published");
});

test("source guards: every editing path routes through the database invariant", async () => {
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /admin\.rpc\("reschedule_approved_draft"/);
  assert.match(data, /expectedContentVersion/);
  assert.match(data, /contentVersion: view\.contentVersion/);
  const social = await read("lib/social/server-drafts.ts");
  assert.match(social, /if \(wasApproved && status === "approved" && !explicitAuthorization && publishableChanged\) status = "draft";/);
  assert.match(social, /\.eq\("content_version", written\.content_version\)\.eq\("status", "draft"\)/);
  const workflow = await read("lib/voom/workflow/service.ts");
  assert.match(workflow, /select\("title,content,proposed_publish_at,content_version"\)/);
  assert.match(workflow, /approveWorkflowItem\(admin, context\.ownerId, item\.draftId, "autopilot", item\.contentVersion\)/);
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /async approvalStillCurrent\(/);
  const route = await read("app/api/posts/[id]/route.ts");
  assert.match(route, /status: 409/);
});

test("existing data: applying 0059 keeps today's approved posts approved and their queued jobs untouched; rollback removes every trigger", async () => {
  const lite = await createSupabaseLite({ stopBefore: "0059_automation_emergency_pause.sql" });
  const db = lite.db;
  await db.query("insert into auth.users (id) values ($1)", [OWNER_A]);
  await db.query("insert into public.businesses (owner_user_id, plan, automation_level) values ($1,'max','autopilot')", [OWNER_A]);
  const conv = (await db.query("insert into public.mara_conversations (owner_user_id) values ($1) returning id", [OWNER_A])).rows[0].id;
  const approvedId = (await db.query(
    "insert into public.mara_drafts (owner_user_id, conversation_id, kind, channel, title, content, status, proposed_publish_at) values ($1,$2,'instagram_post','instagram','Old','Old caption','approved',$3) returning id",
    [OWNER_A, conv, FUTURE],
  )).rows[0].id;
  await db.query(
    "insert into public.post_draft_assets (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size) values ($1,$2,$3,'a.png','image/png',10)",
    [OWNER_A, approvedId, `${OWNER_A}/post-assets/legacy-${approvedId}.png`],
  );
  const job = await igJob(db, OWNER_A, approvedId);
  await lite.applyPending();
  const s = await state(db, approvedId);
  assert.deepEqual({ status: s.status, v: s.v, av: s.av }, { status: "approved", v: 1, av: 1 }, "existing approvals cover existing content");
  assert.equal(await qstatus(db, "instagram_publish_queue", job), "scheduled");

  await db.exec(await read("supabase/proposed/0059_automation_emergency_pause.rollback.sql"));
  const left = (await db.query("select count(*)::int as n from pg_trigger where tgname in ('mara_drafts_approval_integrity','mara_drafts_withdraw_unapproved_jobs','post_draft_assets_bump_draft_version','ensure_business_automation_pause_protected','instagram_paused_automation_claim_guard')")).rows[0].n;
  assert.equal(left, 0);
  await db.query("update public.mara_drafts set content = 'After rollback' where id = $1", [approvedId]);
  assert.equal((await db.query("select status from public.mara_drafts where id = $1", [approvedId])).rows[0].status, "approved", "rolled back: pre-0059 behaviour");
});
