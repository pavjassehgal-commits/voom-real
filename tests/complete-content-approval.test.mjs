/**
 * MARA Phase 2E — complete-content approval and asynchronous media arrival.
 *
 * An approval covers the COMPLETE post, media included (migration 0059, no
 * first-visual exception). Autopilot therefore never approves a post whose
 * media is still generating: it parks the draft as awaiting media, and when
 * the media arrives (lib/voom/workflow/media-arrival.ts) re-checks mode,
 * pause, entitlement and the deterministic safety checks on the FINAL
 * content, then approves exactly that content version. Assisted confirms are
 * refused until the media exists.
 *
 * The media-arrival tests run against the REAL migrations on PGlite (content
 * versions, the asset trigger, the marker in content_meta); only the final
 * approve/audit/card side effects are injected so the storage-backed
 * calendar sync is not needed.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";
import { ensureRollingPlan } from "../lib/voom/workflow/rolling-plan.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const arrival = await import("../lib/voom/workflow/media-arrival.ts");
const approvalMod = await import("../lib/mara/draft-approval.ts");
const { APPROVAL_CONTENT_CHANGED } = await import("../lib/post/server-data.ts");

const OWNER = "aaaaaaaa-0000-4000-8000-0000000000e1";
const NOW = new Date();
const PUBLISH_AT = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
let seq = 0;

// ---------------------------------------------------------------------------
// Rolling plan: Autopilot parks incomplete posts without a card (no loop)
// ---------------------------------------------------------------------------

function harness(mode, autoApproveResult) {
  const drafts = new Map();
  const calls = { media: 0, autoApprove: 0, approval: 0 };
  const ports = {
    async ensurePlan() { return "plan-1"; },
    async listItems() { return [...drafts.values()]; },
    async generateContent(slot) {
      return { concept: `Idea ${slot.date}`, caption: "A useful draft.", cta: "Learn more", hashtags: [], visualBrief: "A safe visual" };
    },
    async createDraft({ slot, content }) {
      const item = { draftId: `draft-${slot.slotKey}`, slotKey: slot.slotKey, channel: slot.channel, format: slot.format, contentType: slot.contentType, concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft" };
      drafts.set(item.draftId, item);
      return item;
    },
    async ensureMedia() { calls.media += 1; return { ok: true }; },
    async requestApproval() { calls.approval += 1; },
    async autoApproveAndSchedule() { calls.autoApprove += 1; return autoApproveResult; },
    async savePlanItems() {},
  };
  const input = { now: new Date("2026-10-18T08:00:00.000Z"), timeZone: "Asia/Dubai", cadence: "weekly", mode, goal: "Grow awareness", selectedChannels: ["instagram"] };
  return { calls, ports, input };
}

test("Autopilot awaiting media: no card, no auto-approval, and re-runs do not loop", async () => {
  const h = harness("autopilot", { approved: false, reason: "autopilot_awaiting_media" });
  const first = await ensureRollingPlan(h.ports, h.input);
  assert.ok(h.calls.autoApprove > 0);
  assert.equal(first.autoApproved, 0);
  assert.equal(h.calls.approval, 0, "an incomplete Autopilot post is not pushed to Approvals");
  const approvalsAfterFirst = h.calls.approval;
  await ensureRollingPlan(h.ports, h.input);
  assert.equal(h.calls.approval, approvalsAfterFirst, "a re-run keeps waiting instead of opening cards");
});

test("mode matrix: Manual never generates media or approves; Assisted only asks; Autopilot only approves complete posts", async () => {
  const manual = harness("manual", { approved: true });
  await ensureRollingPlan(manual.ports, manual.input);
  assert.deepEqual(manual.calls, { media: 0, autoApprove: 0, approval: 0 }, "Manual starts no automatic MARA work");

  const assisted = harness("assisted", { approved: true });
  await ensureRollingPlan(assisted.ports, assisted.input);
  assert.equal(assisted.calls.autoApprove, 0, "Assisted never auto-approves");
  assert.equal(assisted.calls.media, 0, "Assisted generates no paid media automatically");
  assert.ok(assisted.calls.approval > 0);

  const unsafe = harness("autopilot", { approved: false, reason: "unsupported_claim" });
  await ensureRollingPlan(unsafe.ports, unsafe.input);
  assert.ok(unsafe.calls.approval > 0, "an unsafe Autopilot item is held for the owner");

  const service = await read("lib/voom/workflow/service.ts");
  assert.match(service, /if \(!\(await draftHasVisual\(admin, context\.ownerId, item\.draftId\)\)\) \{\s*await markAutopilotAwaitingMedia/);
  assert.ok(service.indexOf("draftHasVisual(admin, context.ownerId, item.draftId)") < service.indexOf("const safety = evaluateAutopilotRecommendation({"),
    "completeness is checked before the safety evaluation and the approval");
});

// ---------------------------------------------------------------------------
// Media arrival on the real schema
// ---------------------------------------------------------------------------

/** A Supabase-shaped client over PGlite: select/update with eq/neq filters. */
function liteAdmin(db) {
  const encode = (value) => (value && typeof value === "object" ? JSON.stringify(value) : value);
  return {
    from(table) {
      const where = [];
      const params = [];
      let mode = "select";
      let columns = "*";
      let sets = [];
      const add = (sqlOp) => (column, value) => { params.push(encode(value)); where.push(`"${column}" ${sqlOp} $${params.length}`); return chain; };
      const run = async () => {
        const clause = where.length ? ` where ${where.join(" and ")}` : "";
        if (mode === "update") {
          const r = await db.query(`update public.${table} set ${sets.join(", ")}${clause} returning ${columns}`, params);
          return { data: r.rows, error: null };
        }
        const r = await db.query(`select ${columns} from public.${table}${clause}`, params);
        return { data: r.rows, error: null };
      };
      const chain = {
        select(cols = "*") { columns = cols === "*" ? "*" : cols.split(",").map((c) => `"${c.trim()}"`).join(","); return chain; },
        update(values) {
          mode = "update";
          sets = Object.entries(values).map(([column, value]) => { params.push(encode(value)); return `"${column}" = $${params.length}`; });
          return chain;
        },
        eq: add("="),
        neq: add("<>"),
        async maybeSingle() { const r = await run(); return { data: r.data[0] ?? null, error: null }; },
        then(onFulfilled, onRejected) { return run().then(onFulfilled, onRejected); },
      };
      return chain;
    },
  };
}

async function setup({ plan = "max", mode = "autopilot", paused = false, caption = "Fresh bread every morning.", marker = true, kind = "reel" } = {}) {
  const { db } = await createSupabaseLite();
  await db.query("insert into auth.users (id) values ($1)", [OWNER]);
  await db.query("insert into public.businesses (owner_user_id, plan, automation_level, timezone) values ($1,$2,$3,'Asia/Dubai')", [OWNER, plan, mode]);
  if (paused) await db.query("update public.businesses set automation_paused_at = now() where owner_user_id = $1", [OWNER]);
  const conv = (await db.query("insert into public.mara_conversations (owner_user_id) values ($1) returning id", [OWNER])).rows[0].id;
  const id = (await db.query(
    `insert into public.mara_drafts (owner_user_id, conversation_id, kind, channel, title, content, status, proposed_publish_at, content_meta)
     values ($1,$2,$3,'instagram','Morning bake',$4,'draft',$5,$6::jsonb) returning id`,
    [OWNER, conv, kind, caption, PUBLISH_AT, JSON.stringify(marker ? { autopilotAwaitingMedia: { since: NOW.toISOString() } } : {})],
  )).rows[0].id;
  return { db, admin: liteAdmin(db), id };
}

async function attachVideo(db, id) {
  await db.query(
    "insert into public.post_draft_assets (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size) values ($1,$2,$3,'video.mp4','video/mp4',2048)",
    [OWNER, id, `${OWNER}/post-assets/arrival-${++seq}-${id}.mp4`],
  );
}

function recordingDeps(db, { beforeApprove } = {}) {
  const calls = { approve: [], audit: 0, card: 0 };
  return {
    calls,
    deps: {
      async approve(_admin, ownerId, draftId, version) {
        calls.approve.push(version);
        if (beforeApprove) await beforeApprove();
        // The same compare-and-swap approvePostDraft performs.
        const r = await db.query(
          "update public.mara_drafts set status = 'approved', approval_origin = 'autopilot' where id = $1 and owner_user_id = $2 and content_version = $3 and status <> 'rejected' returning id",
          [draftId, ownerId, version],
        );
        if (!r.rows.length) throw new Error(APPROVAL_CONTENT_CHANGED);
      },
      async recordAudit() { calls.audit += 1; },
      async openApprovalCard() { calls.card += 1; },
    },
  };
}

const draftRow = async (db, id) => (await db.query(
  "select status, approval_origin, content_version::int as v, approved_content_version::int as av, content_meta from public.mara_drafts where id = $1", [id],
)).rows[0];

test("late media: nothing happens until it exists; then Autopilot approves exactly the final version — once", async () => {
  const { db, admin, id } = await setup();
  const r = recordingDeps(db);
  assert.equal(await arrival.completeAutopilotAfterMediaArrival(admin, OWNER, id, NOW, r.deps), "no_media");
  assert.equal((await draftRow(db, id)).status, "draft");
  assert.ok((await draftRow(db, id)).content_meta.autopilotAwaitingMedia, "still waiting");

  await attachVideo(db, id);
  const versionWithMedia = (await draftRow(db, id)).v;
  assert.equal(await arrival.completeAutopilotAfterMediaArrival(admin, OWNER, id, NOW, r.deps), "approved");
  const after = await draftRow(db, id);
  assert.equal(after.status, "approved");
  assert.equal(after.av, versionWithMedia, "the approval covers the version WITH the media");
  assert.equal(after.approval_origin, "autopilot");
  assert.equal(after.content_meta.autopilotAwaitingMedia, undefined, "marker cleared");
  assert.deepEqual(r.calls.approve, [versionWithMedia]);
  assert.equal(r.calls.audit, 1);

  // A second delivery of the same media event is a no-op: no loop, no duplicate approval.
  assert.equal(await arrival.completeAutopilotAfterMediaArrival(admin, OWNER, id, NOW, r.deps), "not_awaiting");
  assert.equal(r.calls.approve.length, 1);
  assert.equal((await draftRow(db, id)).status, "approved", "clearing the marker never moves the version");
});

test("late media while paused, after a switch to Assisted or after a downgrade: nothing is approved", async () => {
  for (const [label, options] of [
    ["paused", { paused: true }],
    ["switched to assisted", { mode: "assisted" }],
    ["downgraded to pro", { plan: "pro" }],
  ]) {
    const { db, admin, id } = await setup(options);
    await attachVideo(db, id);
    const r = recordingDeps(db);
    assert.equal(await arrival.completeAutopilotAfterMediaArrival(admin, OWNER, id, NOW, r.deps), "autonomy_blocked", label);
    assert.equal((await draftRow(db, id)).status, "draft", label);
    assert.equal(r.calls.approve.length, 0, label);
  }
});

test("late media with unsafe final content is held for the owner, never auto-approved", async () => {
  const { db, admin, id } = await setup({ caption: "The best bread in town, guaranteed." });
  await attachVideo(db, id);
  const r = recordingDeps(db);
  assert.equal(await arrival.completeAutopilotAfterMediaArrival(admin, OWNER, id, NOW, r.deps), "held_for_review");
  assert.equal(r.calls.card, 1, "an approval card for the complete post is opened");
  assert.equal(r.calls.approve.length, 0);
  assert.equal((await draftRow(db, id)).status, "draft");
});

test("an edit landing while Autopilot evaluates the arrived media approves nothing", async () => {
  const { db, admin, id } = await setup();
  await attachVideo(db, id);
  const r = recordingDeps(db, { beforeApprove: () => db.query("update public.mara_drafts set content = 'Edited mid-evaluation' where id = $1", [id]) });
  assert.equal(await arrival.completeAutopilotAfterMediaArrival(admin, OWNER, id, NOW, r.deps), "content_changed");
  const after = await draftRow(db, id);
  assert.equal(after.status, "draft");
  assert.ok(after.content_meta.autopilotAwaitingMedia, "kept, so the next arrival/run re-evaluates the edited content");
});

test("a user's own draft (no Autopilot marker) and a rejected draft are never auto-approved when media arrives", async () => {
  const own = await setup({ marker: false });
  await attachVideo(own.db, own.id);
  const r1 = recordingDeps(own.db);
  assert.equal(await arrival.completeAutopilotAfterMediaArrival(own.admin, OWNER, own.id, NOW, r1.deps), "not_awaiting");
  assert.equal(r1.calls.approve.length, 0);

  const rejected = await setup();
  await rejected.db.query("update public.mara_drafts set status = 'rejected' where id = $1", [rejected.id]);
  await attachVideo(rejected.db, rejected.id);
  const r2 = recordingDeps(rejected.db);
  assert.equal(await arrival.completeAutopilotAfterMediaArrival(rejected.admin, OWNER, rejected.id, NOW, r2.deps), "not_awaiting");
  assert.equal((await draftRow(rejected.db, rejected.id)).status, "rejected");
  assert.equal((await draftRow(rejected.db, rejected.id)).content_meta.autopilotAwaitingMedia, undefined);
});

test("the awaiting-media marker is not publishable content: writing it never revokes an approval", async () => {
  const { db, id } = await setup({ marker: false });
  await attachVideo(db, id);
  await db.query("update public.mara_drafts set status = 'approved' where id = $1", [id]);
  const before = await draftRow(db, id);
  await db.query("update public.mara_drafts set content_meta = content_meta || '{\"autopilotAwaitingMedia\":{\"since\":\"x\"}}'::jsonb where id = $1", [id]);
  const after = await draftRow(db, id);
  assert.equal(after.status, "approved");
  assert.equal(after.v, before.v);
});

// ---------------------------------------------------------------------------
// Assisted: complete-content confirmation, wiring
// ---------------------------------------------------------------------------

test("Assisted and MARA approvals require the media; every async media path re-evaluates; cards follow media arrival", async () => {
  assert.equal(approvalMod.approvalRequiresMedia("instagram_post"), true);
  assert.equal(approvalMod.approvalRequiresMedia("reel"), true);
  assert.equal(approvalMod.approvalRequiresMedia("story"), true);
  assert.equal(approvalMod.approvalRequiresMedia("tiktok_video"), false, "TikTok's own consent fingerprint binds its video");
  const tools = await read("lib/mara/tools.ts");
  assert.equal((tools.match(/if \(!asset\) throw new Error\(APPROVAL_INCOMPLETE\);/g) ?? []).length, 2, "propose_calendar_item and approve_draft both require the media");
  assert.match(tools, /\.eq\("content_version", target\.content_version\)/, "approve_draft is bound to the checked version");
  const route = await read("app/api/mara/actions/[id]/route.ts");
  assert.match(route, /image or video isn't ready yet/);
  for (const path of ["lib/mara/video-poller.ts", "lib/mara/video-service.ts", "lib/voom/workflow/media.ts"]) {
    assert.match(await read(path), /completeAutopilotAfterMediaArrival\(/, `${path} re-evaluates Autopilot on media arrival`);
  }
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /await cancelPublishItem\(admin, ownerId, draftId\)\.catch\(\(\) => false\);\s*\/\/ Media can arrive[\s\S]*?await refreshPendingDraftApproval\(admin, ownerId, view\)/);
  const sql = await read("supabase/migrations/0059_automation_emergency_pause.sql");
  assert.doesNotMatch(sql, /first_media_attach/, "no first-visual approval exception remains");
});
