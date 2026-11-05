// VOOM's real 0069 transport/erasure/recovery code + embedded Postgres with every
// migration, against the real Worker on real local D1. Only Resend is replaced.
import "../../../tests/helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { ORIGIN, startRegister, tokens } from "./harness.mjs";

const { createSupabaseLite } = await import("../../../tests/helpers/pglite-supabase.mjs");
const { nativeVideoDb } = await import("../../../tests/helpers/native-video-db.mjs");
const delivery = await import("../../../lib/youtube/deletion-delivery.ts");
const register = await import("../../../lib/youtube/deletion-register.ts");
const privacy = await import("../../../lib/youtube/privacy.ts");
const data = await import("../../../lib/youtube/data.ts");
const { YOUTUBE_SCOPES } = await import("../../../lib/youtube/scopes.ts");

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const DA = "33333333-3333-4333-8333-333333333333", DB = "44444444-4444-4444-8444-444444444444";
const KEY = "synthetic-register-integration-key-32-characters";
const secrets = tokens();
const env = (extra = {}) => ({ YOUTUBE_DELETION_DELIVERY_APPROVED: "true", YOUTUBE_DELETION_JOURNAL_URL: `${ORIGIN}/v1/events`,
  YOUTUBE_DELETION_JOURNAL_TOKEN: secrets.JOURNAL_TOKEN, YOUTUBE_DELETION_ALERT_URL: `${ORIGIN}/v1/alerts`,
  YOUTUBE_DELETION_ALERT_TOKEN: secrets.ALERT_TOKEN, YOUTUBE_DELETION_REPLAY_TOKEN: secrets.REPLAY_TOKEN, ...extra });

let reg, db;
const realFetch = globalThis.fetch;
const routing = { register: null, down: false, resend: [] };
before(async () => {
  reg = await startRegister({}, secrets);
  routing.register = reg;
  ({ db } = await createSupabaseLite());
  globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === new URL(ORIGIN).hostname) {
      if (routing.down) throw new TypeError("fetch failed");
      return routing.register.fetchRegister(String(url), init);
    }
    if (host === "api.resend.com") { routing.resend.push({ key: init.headers["Idempotency-Key"], body: JSON.parse(init.body) }); return Response.json({ id: "x" }); }
    throw new Error(`External network forbidden: ${host}`);
  };
});
after(async () => { globalThis.fetch = realFetch; await db?.close(); await reg?.dispose(); });

const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const count = async (table, owner = A) => (await q(`select count(*)::int n from ${table} where owner_user_id=$1`, [owner]))[0].n;
function bridge() { // identical to tests/youtube-data-retention.test.mjs
  const admin = nativeVideoDb(db);
  admin.rpc = (name, args = {}) => {
    const entries = Object.entries(args);
    const call = `public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")})`;
    const setof = ["get_youtube_connection_secret", "claim_youtube_revocation_tasks", "claim_youtube_deletion_events"].includes(name);
    const promise = (async () => {
      await db.exec("savepoint privacy_rpc");
      try { const result = await q(setof ? `select * from ${call}` : `select ${call} value`, entries.map(([, v]) => v));
        await db.exec("release savepoint privacy_rpc");
        return { data: JSON.parse(JSON.stringify(setof ? result : result[0]?.value)), error: null };
      } catch (e) { await db.exec("rollback to savepoint privacy_rpc; release savepoint privacy_rpc"); return { data: null, error: { message: e.message } }; }
    })();
    promise.maybeSingle = async () => { const r = await promise; return { ...r, data: r.data?.[0] ?? null }; };
    return promise;
  };
  return admin;
}
async function fixture(t, extraEnv = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env(extraEnv));
  await db.exec("begin");
  t.after(async () => { await db.exec("rollback"); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); routing.down = false; });
  await q("insert into auth.users(id) values($1),($2)", [A, B]);
  for (const [owner, draft] of [[A, DA], [B, DB]]) {
    const [c] = await q("insert into mara_conversations(owner_user_id) values($1) returning id", [owner]);
    await q("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content,content_meta) values($1,$2,$3,'youtube_video','youtube','youtube','video','Original','Caption','{\"privacy\":\"private\",\"madeForKids\":false}')", [draft, owner, c.id]);
  }
  const admin = bridge();
  for (const owner of [A, B]) await data.saveYouTubeConnection(admin, { ownerId: owner, channelId: `channel-${owner}`, channelTitle: "t", channelHandle: null, thumbnailUrl: null,
    grantedScopes: [...YOUTUBE_SCOPES], refreshToken: "synthetic-refresh", accessToken: "synthetic-access", accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), encryptionKey: KEY });
  await q("update mara_drafts set status='approved' where id=$1", [DA]);
  await q(`insert into youtube_publish_queue(owner_user_id,draft_id,youtube_format,title,privacy_status,made_for_kids,scheduled_at,status,idempotency_key,youtube_video_id,provider_upload_status,published_at,attempts)
    values($1,$2,'video','Original','private',false,now(),'published',$3,'vidA','processed',now(),1)`, [A, DA, `test-${DA}`]);
  return admin;
}
const reader = () => register.deletionRegisterReader(env(), routing.register.fetchRegister);

test("contract: VOOM's real 0069 transport is accepted by the Worker (intent, completion, alert, retention)", async () => {
  const transport = delivery.createDeletionTransport(env(), routing.register.fetchRegister);
  const event = { id: crypto.randomUUID(), owner_user_id: A, scope: "erase", requested_at: "2026-11-01T10:28:53.836757+00:00", cutoff_at: null,
    journal_receipt: null, failure_code: null, failed_at: null, alerted_at: null, claim: "c", applied_at: null, completion_receipt: null };
  const receipt = await transport.journal(event);
  assert.match(receipt, /^vdr_[0-9a-f]{40}$/);
  assert.equal(await transport.journal(event), receipt, "a lost response retried with the same id gets the same receipt");
  assert.match(await transport.complete({ ...event, applied_at: "2026-11-01T10:29:00.000000+00:00" }), /^vdr_/);
  await transport.alert(event, "erasure_failed");
  const retention = { ...event, id: crypto.randomUUID(), scope: "retention", cutoff_at: "2026-10-04T10:28:53.836757+00:00" };
  assert.match(await transport.journal(retention), /^vdr_/);
  for (const respond of [() => new Response("<html>error code: 1027</html>", { status: 429 }), () => new Response("{}", { status: 503 }),
    () => Response.json({ eventId: event.id, payloadSha256: "0".repeat(64), durable: true, receiptId: "forged" })]) {
    const t2 = delivery.createDeletionTransport(env(), async () => respond());
    await assert.rejects(t2.journal(event), /capture_failed/, "Free-plan 1027, outages and unverifiable receipts are never accepted");
  }
});

test("register outage: erasure stays blocked and pending, then completes on retry with the SAME event", async (t) => {
  const admin = await fixture(t);
  routing.down = true;
  await assert.rejects(privacy.eraseYouTubeData(admin, A), /youtube_deletion_capture_pending/);
  const [control] = await q("select blocked, deletion_event_id from youtube_privacy_controls where owner_user_id=$1", [A]);
  assert.equal(control.blocked, true);
  assert.equal(await count("youtube_connections"), 1, "nothing erased without an independent record");
  routing.down = false;
  await q("update youtube_deletion_events set retry_at=now() where owner_user_id=$1", [A]);
  assert.equal((await privacy.eraseYouTubeData(admin, A)).erased, true);
  const events = await q("select id, journal_receipt, completion_receipt from youtube_deletion_events where owner_user_id=$1", [A]);
  assert.equal(events.length, 1); assert.equal(events[0].id, control.deletion_event_id);
  assert.ok(events[0].journal_receipt && events[0].completion_receipt);
  assert.equal(await count("youtube_connections"), 0); assert.equal(await count("youtube_connections", B), 1);
});

test("main database restore: replay from the register re-erases before YouTube resumes; replay is idempotent", async (t) => {
  const admin = await fixture(t);
  const fresh = await startRegister({}, secrets);
  routing.register = fresh;
  t.after(async () => { routing.register = reg; await fresh.dispose(); });
  const restorePoint = new Date(Date.now() - 1000);
  await db.exec("savepoint backup");
  assert.equal((await privacy.eraseYouTubeData(admin, A)).erased, true);
  assert.equal(await count("youtube_connections"), 0);
  await db.exec("rollback to savepoint backup"); // the Production restore
  assert.equal(await count("youtube_connections"), 1, "the restore resurrected A's YouTube data");
  assert.equal(await count("youtube_deletion_events"), 0, "and lost the local deletion evidence");
  const report = await register.replayDeletionRegisterAfterRestore(admin, reader(), { restorePoint, erase: privacy.eraseYouTubeData });
  assert.deepEqual({ intents: report.intents, replayed: report.replayed, failed: report.failed }, { intents: 1, replayed: 1, failed: [] });
  for (const table of ["youtube_connections", "youtube_connection_secrets", "youtube_publish_queue"]) assert.equal(await count(table), 0, table);
  assert.equal(await count("youtube_erased_publications"), 1, "the no-repeat marker is restored too");
  assert.equal(await count("youtube_connections", B), 1, "other owners untouched");
  const again = await register.replayDeletionRegisterAfterRestore(admin, reader(), { restorePoint, erase: privacy.eraseYouTubeData });
  assert.equal(again.replayed, 0); assert.ok(again.alreadyApplied >= 1);
});

test("register data loss: reconciliation re-sends missing records with the same ids and reports tampering", async (t) => {
  const admin = await fixture(t);
  await privacy.eraseYouTubeData(admin, A);
  const fresh = await startRegister({}, secrets); // e.g. after a D1 Time Travel restore to an older point
  routing.register = fresh;
  t.after(async () => { routing.register = reg; await fresh.dispose(); });
  const transport = delivery.createDeletionTransport(env(), fresh.fetchRegister);
  const r1 = await register.reconcileDeletionRegister(admin, register.deletionRegisterReader(env(), fresh.fetchRegister), transport);
  assert.deepEqual({ ...r1, conflicts: r1.conflicts.length, failures: r1.failures.length }, { checked: 1, intentsResent: 1, completionsResent: 1, conflicts: 0, failures: 0 });
  const r2 = await register.reconcileDeletionRegister(admin, register.deletionRegisterReader(env(), fresh.fetchRegister), transport);
  assert.equal(r2.intentsResent + r2.completionsResent, 0, "a second pass finds nothing missing");
  const forged = await startRegister({}, secrets);
  t.after(() => forged.dispose());
  const [ev] = await q("select id from youtube_deletion_events where owner_user_id=$1", [A]);
  await forged.db.prepare(`insert into register_records (record_id, kind, request_id, owner_id, scope, received_at, deadline_at, payload_sha256, receipt_id, stored_at)
    values (?1, 'intent', ?1, ?2, 'erase', '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z', 'forged', 'vdr_forged', '2026-01-01T00:00:00.000Z')`).bind(ev.id, A).run();
  const r3 = await register.reconcileDeletionRegister(admin, register.deletionRegisterReader(env(), forged.fetchRegister), delivery.createDeletionTransport(env(), forged.fetchRegister));
  assert.deepEqual(r3.conflicts, [ev.id], "a mismatching register record is reported, never overwritten");
});

test("cross-heartbeat + independent fallback alert: inert when disabled, escalates a stale watchdog or unreachable register", async () => {
  routing.resend.length = 0;
  let calls = 0;
  assert.equal(await register.checkDeletionRegister({}, async () => { calls++; return new Response(); }), null);
  assert.equal(await register.sendFallbackDeletionAlert("register_unreachable", {}, async () => { calls++; return new Response(); }), false);
  assert.equal(calls, 0, "disabled delivery makes no network call");
  const fresh = await startRegister({}, secrets);
  try {
    assert.equal(await register.checkDeletionRegister(env(), fresh.fetchRegister), "register_watchdog_stale", "the watchdog has never run");
    await fresh.scheduled(Date.now());
    assert.equal(await register.checkDeletionRegister(env(), fresh.fetchRegister), null);
    assert.ok((await fresh.db.prepare("select last_seen_at from register_heartbeats where source='voom'").first()).last_seen_at, "VOOM's heartbeat is recorded");
    assert.equal(await register.checkDeletionRegister(env(), fresh.fetchRegister, Date.now() + 3 * 3600_000), "register_watchdog_stale");
  } finally { await fresh.dispose(); }
  assert.equal(await register.checkDeletionRegister(env(), async () => { throw new TypeError("fetch failed"); }), "register_unreachable");
  const mailEnv = env({ YOUTUBE_DELETION_FALLBACK_ALERT_TO: "operator@example.com", EMAIL_PROVIDER_API_KEY: "re_synthetic", EMAIL_FROM_ADDRESS: "alerts@example.com", EMAIL_FROM_NAME: "VOOM" });
  const sent = [];
  const capture = async (url, init) => { sent.push({ url: String(url), key: init.headers["Idempotency-Key"], body: init.body }); return Response.json({ id: "x" }); };
  assert.equal(await register.sendFallbackDeletionAlert("register_unreachable", mailEnv, capture, Date.parse("2026-11-01T10:05:00Z")), true);
  assert.equal(await register.sendFallbackDeletionAlert("register_unreachable", mailEnv, capture, Date.parse("2026-11-01T10:55:00Z")), true);
  assert.equal(sent[0].key, sent[1].key, "one alert per code per hour (provider idempotency)");
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.doesNotMatch(sent[0].body, new RegExp(A), "no owner identifiers in the fallback email");
});

test("maintenance wires the cross-check: a stale register watchdog raises attention and sends the fallback alert", async (t) => {
  const admin = await fixture(t, { YOUTUBE_DELETION_FALLBACK_ALERT_TO: "operator@example.com", EMAIL_PROVIDER_API_KEY: "re_synthetic", EMAIL_FROM_ADDRESS: "alerts@example.com" });
  const fresh = await startRegister({}, secrets);
  routing.register = fresh;
  t.after(async () => { routing.register = reg; await fresh.dispose(); });
  routing.resend.length = 0;
  const result = await privacy.runYouTubePrivacyMaintenance({ db: admin, config: null });
  assert.equal(result.operatorAttention, true);
  assert.equal(routing.resend.length, 1);
  assert.match(routing.resend[0].body.subject, /register_watchdog_stale/);
});
