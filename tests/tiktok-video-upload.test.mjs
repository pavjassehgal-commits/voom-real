/**
 * TikTok direct video uploads (up to 50 MB): request rules, path isolation,
 * the session → resumable upload → finalize lifecycle, cleanup safety, the
 * browser controller (progress, retry, resume, cancel, expiry, duplicates),
 * and the 0060 database limits against the real migrations in PGlite.
 * No network, no Supabase, no TikTok.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const rules = await import("../lib/tiktok/video-upload.ts");
const session = await import("../lib/tiktok/upload-session.ts");
const client = await import("../lib/tiktok/upload-client.ts");

const MB = 1024 * 1024;
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const OTHER_DRAFT = "33333333-3333-4333-8333-333333333333";
const UPLOAD_ID = "44444444-4444-4444-8444-444444444444";
const PATH = `${OWNER}/tiktok-uploads/${DRAFT}/${UPLOAD_ID}.mp4`;
const NOW = Date.parse("2026-10-17T10:00:00.000Z");

function mp4Header() {
  // ftyp box: size 20, "ftyp", major brand "isom", minor 0, compatible "isom".
  return new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d]);
}

/* ── Declared request rules ─────────────────────────────────────────── */

test("5 MB, 20 MB, 49 MB and exactly 50 MB MP4s are accepted; anything over 50 MB, empty or non-MP4 is refused", () => {
  for (const size of [5 * MB, 20 * MB, 49 * MB, 50 * MB]) {
    assert.equal(rules.validateTikTokUploadRequest({ fileName: "launch.mp4", fileSize: size, contentType: "video/mp4" }).ok, true, `${size}`);
  }
  assert.equal(rules.TIKTOK_VIDEO_MAX_BYTES, 52_428_800);
  assert.deepEqual(rules.validateTikTokUploadRequest({ fileName: "big.mp4", fileSize: 50 * MB + 1 }), { ok: false, code: "too_large" });
  assert.deepEqual(rules.validateTikTokUploadRequest({ fileName: "big.mp4", fileSize: 300 * MB }), { ok: false, code: "too_large" });
  assert.deepEqual(rules.validateTikTokUploadRequest({ fileName: "empty.mp4", fileSize: 0 }), { ok: false, code: "empty" });
  assert.deepEqual(rules.validateTikTokUploadRequest({ fileName: "clip.mov", fileSize: MB }), { ok: false, code: "not_mp4" });
  assert.deepEqual(rules.validateTikTokUploadRequest({ fileName: "clip.mp4", fileSize: MB, contentType: "video/quicktime" }), { ok: false, code: "not_mp4" });
  assert.deepEqual(rules.validateTikTokUploadRequest({ fileName: "clip.mp4", fileSize: 1.5 }), { ok: false, code: "invalid" });
});

test("upload paths are confined to the owner's own draft folder; tampering is refused", () => {
  assert.equal(rules.tiktokUploadPath(OWNER, DRAFT, UPLOAD_ID), PATH);
  assert.equal(rules.isTikTokUploadPathFor(PATH, OWNER, DRAFT), true);
  for (const bad of [
    `${OTHER_OWNER}/tiktok-uploads/${DRAFT}/${UPLOAD_ID}.mp4`,
    `${OWNER}/tiktok-uploads/${OTHER_DRAFT}/${UPLOAD_ID}.mp4`,
    `${OWNER}/post-assets/${UPLOAD_ID}.mp4`,
    `${OWNER}/tiktok-uploads/${DRAFT}/../${UPLOAD_ID}.mp4`,
    `${OWNER}/tiktok-uploads/${DRAFT}/${UPLOAD_ID}.mov`,
    `${OWNER}/tiktok-uploads/${DRAFT}/${UPLOAD_ID}.mp4/extra`,
    `/${PATH}`,
    "not-a-path",
    42,
  ]) {
    assert.equal(rules.isTikTokUploadPathFor(bad, OWNER, DRAFT), false, String(bad));
  }
  assert.throws(() => rules.tiktokUploadPath("../etc", DRAFT, UPLOAD_ID));
});

test("the MP4 signature is read from the stored bytes, never trusted from the browser", () => {
  assert.equal(rules.isMp4Header(mp4Header()), true);
  assert.equal(rules.isMp4Header(new TextEncoder().encode("this is not a video at all")), false);
  assert.equal(rules.isMp4Header(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), false, "a JPEG renamed .mp4");
  assert.equal(rules.isMp4Header(null), false);
});

/* ── Session / finalize / cleanup with fake ports ───────────────────── */

function fakePorts(overrides = {}) {
  const calls = [];
  const objects = new Map(Object.entries(overrides.objects ?? {}));
  let asset = overrides.assetPath ?? null;
  const draft = overrides.draft === null ? null : { kind: "tiktok_video", status: "draft", queueStatus: null, hasConsent: false, ...overrides.draft };
  return {
    calls,
    objects,
    get asset() { return asset; },
    async loadDraft(ownerId, draftId) { calls.push("loadDraft"); return ownerId === OWNER && draftId === DRAFT ? draft : null; },
    async hasBusiness(ownerId) { return overrides.business === false ? false : ownerId === OWNER; },
    async createSignedUpload(path) { calls.push(["sign", path]); return { token: "signed-token-for-one-path" }; },
    async statObject(path) { calls.push(["stat", path]); const o = objects.get(path); return o ? { size: o.size } : null; },
    async readHeader(path) { calls.push(["header", path]); return objects.get(path)?.header ?? null; },
    async inspectDuration(path) { calls.push(["duration", path]); return objects.get(path)?.duration ?? null; },
    async currentAssetPath() { return asset; },
    async withdrawApproval() { calls.push("withdraw"); },
    async linkAsset(input) {
      calls.push(["link", input.path, input.size]);
      if (overrides.linkFails) throw new Error("asset_link_failed");
      asset = input.path;
    },
    async removeReplaced(_owner, path) { calls.push(["removeReplaced", path]); objects.delete(path); },
    async removeObject(path) { calls.push(["remove", path]); objects.delete(path); },
    async listUploads(folder) {
      return [...objects.entries()].filter(([p]) => p.startsWith(`${folder}/`)).map(([p, o]) => ({ path: p, createdAt: o.createdAt ?? new Date(NOW).toISOString() }));
    },
    newUploadId: () => UPLOAD_ID,
    now: () => NOW,
  };
}
const good = (size) => ({ size, header: mp4Header(), duration: 14.2 });
const names = (ports) => ports.calls.map((c) => (Array.isArray(c) ? c[0] : c));

test("a session is issued only for the owner's own TikTok Video draft, with a 2-hour token for one private path", async () => {
  const ports = fakePorts();
  const started = await session.startTikTokUpload(ports, { ownerId: OWNER, draftId: DRAFT, fileName: "launch.mp4", fileSize: 49 * MB, contentType: "video/mp4" });
  assert.equal(started.ok, true);
  assert.equal(started.path, PATH);
  assert.equal(started.maxBytes, 50 * MB);
  assert.equal(started.chunkSize, 6 * MB);
  assert.equal(started.expiresAt, new Date(NOW + 2 * 3600_000).toISOString());
  assert.deepEqual(ports.calls.find((c) => c[0] === "sign"), ["sign", PATH]);

  const refusals = [
    [{ ownerId: OTHER_OWNER }, "not_found", "another business's user"],
    [{ draft: null }, "not_found", "missing draft"],
    [{ draft: { kind: "youtube_short" } }, "not_tiktok", "not a TikTok draft"],
    [{ business: false }, "no_business", "no business"],
    [{ draft: { queueStatus: "provider_processing" } }, "provider_owned", "already with TikTok"],
    [{ fileSize: 50 * MB + 1 }, "too_large", "over 50 MB"],
  ];
  for (const [change, code, label] of refusals) {
    const p = fakePorts({ draft: change.draft, business: change.business });
    const result = await session.startTikTokUpload(p, {
      ownerId: change.ownerId ?? OWNER, draftId: DRAFT, fileName: "launch.mp4", fileSize: change.fileSize ?? 5 * MB,
    });
    assert.deepEqual(result, { ok: false, code }, label);
    assert.equal(p.calls.some((c) => c[0] === "sign"), false, `${label}: no upload permission issued`);
  }
});

test("finalize links 5, 20 and 49 MB uploads after verifying the stored size, signature and duration", async () => {
  for (const size of [5 * MB, 20 * MB, 49 * MB]) {
    const ports = fakePorts({ objects: { [PATH]: good(size) } });
    const result = await session.finalizeTikTokUpload(ports, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "launch.mp4" });
    assert.deepEqual(result, { ok: true, path: PATH, size, alreadyLinked: false });
    assert.deepEqual(names(ports).filter((n) => ["stat", "header", "duration", "link"].includes(n)), ["stat", "header", "duration", "link"]);
    assert.equal(ports.asset, PATH);
  }
});

test("finalize rejects and deletes uploads that are too large, not MP4, or unreadable; a missing upload is reported, not linked", async () => {
  const cases = [
    [good(50 * MB + 1), "too_large"],
    [good(0), "empty"],
    [{ size: 5 * MB, header: new TextEncoder().encode("plain text pretending to be mp4"), duration: 10 }, "invalid_video"],
    [{ size: 5 * MB, header: mp4Header(), duration: null }, "unreadable_duration"],
  ];
  for (const [object, code] of cases) {
    const ports = fakePorts({ objects: { [PATH]: object } });
    const result = await session.finalizeTikTokUpload(ports, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "x.mp4" });
    assert.deepEqual(result, { ok: false, code });
    assert.equal(ports.objects.has(PATH), false, `${code}: the rejected object is deleted`);
    assert.equal(names(ports).includes("link"), false);
  }
  const missing = fakePorts();
  assert.deepEqual(await session.finalizeTikTokUpload(missing, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "x.mp4" }), { ok: false, code: "upload_incomplete" });
  assert.equal(names(missing).includes("remove"), false);
});

test("finalize refuses another business's path or draft before reading any storage object", async () => {
  for (const [ownerId, draftId, path] of [
    [OWNER, DRAFT, `${OTHER_OWNER}/tiktok-uploads/${DRAFT}/${UPLOAD_ID}.mp4`],
    [OWNER, DRAFT, `${OWNER}/tiktok-uploads/${OTHER_DRAFT}/${UPLOAD_ID}.mp4`],
    [OTHER_OWNER, DRAFT, PATH],
  ]) {
    const ports = fakePorts({ objects: { [path]: good(5 * MB) } });
    const result = await session.finalizeTikTokUpload(ports, { ownerId, draftId, path, displayName: "x.mp4" });
    assert.deepEqual(result, { ok: false, code: "invalid_path" });
    assert.equal(ports.calls.some((c) => c[0] === "stat" || c[0] === "header" || c[0] === "link"), false);
    assert.equal(ports.objects.has(path), true, "nothing belonging to anyone else is deleted");
  }
  const ports = fakePorts({ objects: { [PATH]: good(5 * MB) }, draft: null });
  assert.deepEqual(await session.finalizeTikTokUpload(ports, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "x" }), { ok: false, code: "not_found" });
});

test("duplicate finalization is a no-op success: no second link, no second consent withdrawal", async () => {
  const ports = fakePorts({ objects: { [PATH]: good(20 * MB) }, draft: { status: "approved", hasConsent: true } });
  const first = await session.finalizeTikTokUpload(ports, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "a.mp4" });
  const second = await session.finalizeTikTokUpload(ports, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "a.mp4" });
  assert.equal(first.alreadyLinked, false);
  assert.deepEqual(second, { ok: true, path: PATH, size: 20 * MB, alreadyLinked: true });
  assert.equal(names(ports).filter((n) => n === "link").length, 1);
  assert.equal(names(ports).filter((n) => n === "withdraw").length, 1);
});

test("replacing a video withdraws TikTok consent first, then links the new video, then deletes the old one", async () => {
  const OLD = `${OWNER}/tiktok-uploads/${DRAFT}/55555555-5555-4555-8555-555555555555.mp4`;
  const ports = fakePorts({ objects: { [PATH]: good(30 * MB), [OLD]: good(10 * MB) }, assetPath: OLD, draft: { status: "approved", hasConsent: true } });
  const result = await session.finalizeTikTokUpload(ports, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "new.mp4" });
  assert.equal(result.ok, true);
  assert.deepEqual(names(ports).filter((n) => ["withdraw", "link", "removeReplaced"].includes(n)), ["withdraw", "link", "removeReplaced"]);
  assert.equal(ports.objects.has(OLD), false);

  const plain = fakePorts({ objects: { [PATH]: good(MB) } });
  await session.finalizeTikTokUpload(plain, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "a.mp4" });
  assert.equal(names(plain).includes("withdraw"), false, "an unapproved draft without consent is left alone");

  const failing = fakePorts({ objects: { [PATH]: good(MB), [OLD]: good(MB) }, assetPath: OLD, linkFails: true });
  assert.deepEqual(await session.finalizeTikTokUpload(failing, { ownerId: OWNER, draftId: DRAFT, path: PATH, displayName: "a" }), { ok: false, code: "storage_failure" });
  assert.equal(failing.objects.has(PATH), false, "the unlinked new object is removed");
  assert.equal(failing.objects.has(OLD), true, "the current video stays");
});

test("cleanup removes only stale, unlinked uploads in the owner's own draft folder", async () => {
  const stale = new Date(NOW - 27 * 3600_000).toISOString();
  const young = new Date(NOW - 2 * 3600_000).toISOString();
  const STALE = `${OWNER}/tiktok-uploads/${DRAFT}/66666666-6666-4666-8666-666666666666.mp4`;
  const ACTIVE = `${OWNER}/tiktok-uploads/${DRAFT}/77777777-7777-4777-8777-777777777777.mp4`;
  const LINKED = `${OWNER}/tiktok-uploads/${DRAFT}/88888888-8888-4888-8888-888888888888.mp4`;
  const ports = fakePorts({
    objects: {
      [STALE]: { ...good(MB), createdAt: stale },
      [ACTIVE]: { ...good(MB), createdAt: young },
      [LINKED]: { ...good(MB), createdAt: stale },
    },
    assetPath: LINKED,
  });
  const result = await session.cleanupTikTokUploads(ports, { ownerId: OWNER, draftId: DRAFT });
  assert.deepEqual(result.removed, [STALE]);
  assert.equal(ports.objects.has(ACTIVE), true, "an upload inside the 26-hour window may still be in progress");
  assert.equal(ports.objects.has(LINKED), true, "the draft's linked video is never removed");
});

/* ── Browser controller with a fake TUS client ──────────────────────── */

function harness({ finalizeStatus = [200] } = {}) {
  const requests = [];
  const uploads = [];
  let done = null;
  const finalizeQueue = [...finalizeStatus];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/upload-session")) {
      return { ok: true, status: 200, json: async () => ({ upload: { endpoint: "https://example.storage.supabase.co/storage/v1/upload/resumable", bucket: "mara-media", path: PATH, token: `token-${requests.length}`, chunkSize: 6 * MB } }) };
    }
    const status = finalizeQueue.shift() ?? 200;
    return { ok: status === 200, status, json: async () => (status === 200 ? { draft: { id: DRAFT }, message: "stored" } : { error: "Server busy" }) };
  };
  const createTus = (_file, options) => {
    const upload = { options, starts: 0, aborted: null, start() { this.starts += 1; }, async abort(terminate) { this.aborted = terminate; } };
    uploads.push(upload);
    return upload;
  };
  const controller = client.createTikTokUploadController({
    draftId: DRAFT, file: { name: "launch.mp4", size: 49 * MB, type: "video/mp4" }, publishableKey: "publishable-key",
    fetch, createTus, onChange: () => {}, onDone: (r) => { done = r; },
  });
  return { controller, requests, uploads, get done() { return done; } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("uploads go straight to Supabase in 6 MB TUS chunks with a path-scoped token, report progress, then finalize once", async () => {
  const h = harness();
  await h.controller.start();
  assert.equal(h.uploads.length, 1);
  const { options } = h.uploads[0];
  assert.equal(options.endpoint, "https://example.storage.supabase.co/storage/v1/upload/resumable");
  assert.equal(options.chunkSize, 6 * MB);
  assert.deepEqual(options.headers, { apikey: "publishable-key", "x-signature": "token-1", "x-upsert": "false" });
  assert.deepEqual(options.metadata, { bucketName: "mara-media", objectName: PATH, contentType: "video/mp4", cacheControl: "3600" });
  options.onProgress(18 * MB, 49 * MB);
  assert.deepEqual([h.controller.snapshot().phase, h.controller.snapshot().sentBytes], ["uploading", 18 * MB]);
  options.onSuccess();
  await flush();
  assert.equal(h.controller.snapshot().phase, "done");
  assert.deepEqual(h.requests.map((r) => r.url.split("/").pop()), ["upload-session", "finalize"]);
  assert.deepEqual(h.requests[1].body, { path: PATH, fileName: "launch.mp4" });
  assert.ok(h.done);
});

test("an interrupted upload can be retried and resumes the same transfer without a new session", async () => {
  const h = harness();
  await h.controller.start();
  h.uploads[0].options.onProgress(30 * MB, 49 * MB);
  h.uploads[0].options.onError(Object.assign(new Error("network"), { originalResponse: null }));
  assert.deepEqual([h.controller.snapshot().phase, h.controller.snapshot().canRetry], ["failed", true]);
  await h.controller.retry();
  assert.equal(h.uploads.length, 1, "the same TUS upload resumes from Supabase's recorded offset");
  assert.equal(h.uploads[0].starts, 2);
  assert.equal(h.requests.filter((r) => r.url.endsWith("/upload-session")).length, 1);
  h.uploads[0].options.onSuccess();
  await flush();
  assert.equal(h.controller.snapshot().phase, "done");
});

test("an expired or refused session gets exactly one fresh session; a second refusal stops", async () => {
  const h = harness();
  await h.controller.start();
  const expired = (status) => Object.assign(new Error("expired"), { originalResponse: { getStatus: () => status } });
  h.uploads[0].options.onError(expired(403));
  await flush();
  assert.equal(h.uploads.length, 2, "restarted with a new session");
  assert.equal(h.uploads[1].options.headers["x-signature"], "token-2");
  h.uploads[1].options.onError(expired(403));
  await flush();
  assert.equal(h.uploads.length, 2);
  assert.equal(h.controller.snapshot().phase, "failed");
});

test("cancel terminates the TUS upload and never finalizes; duplicate start clicks are ignored", async () => {
  const h = harness();
  await Promise.all([h.controller.start(), h.controller.start()]);
  assert.equal(h.requests.filter((r) => r.url.endsWith("/upload-session")).length, 1, "a double click does not start two uploads");
  await h.controller.cancel();
  assert.equal(h.uploads[0].aborted, true, "the partial upload is discarded at Supabase");
  h.uploads[0].options.onSuccess();
  await flush();
  assert.equal(h.requests.some((r) => r.url.endsWith("/finalize")), false);
  assert.equal(h.controller.snapshot().phase, "cancelled");
});

test("a finalize server error keeps the upload and retry finalizes again; an oversized file never starts", async () => {
  const h = harness({ finalizeStatus: [503, 200] });
  await h.controller.start();
  h.uploads[0].options.onSuccess();
  await flush();
  assert.deepEqual([h.controller.snapshot().phase, h.controller.snapshot().canRetry], ["failed", true]);
  await h.controller.retry();
  await flush();
  assert.equal(h.controller.snapshot().phase, "done");
  assert.equal(h.requests.filter((r) => r.url.endsWith("/finalize")).length, 2);

  const big = client.createTikTokUploadController({
    draftId: DRAFT, file: { name: "big.mp4", size: 51 * MB, type: "video/mp4" }, publishableKey: "k",
    fetch: async () => { throw new Error("must not be called"); }, createTus: () => { throw new Error("must not be called"); },
    onChange: () => {}, onDone: () => {},
  });
  await big.start();
  assert.equal(big.snapshot().phase, "failed");
  assert.match(big.snapshot().error, /50 MB/);
});

/* ── Routes and editor: no video bytes through Vercel, no secrets ───── */

test("video bytes never pass through a Vercel Function and no service credential reaches the browser", async () => {
  const sessionRoute = await read("app/api/social-drafts/[id]/asset/upload-session/route.ts");
  const finalizeRoute = await read("app/api/social-drafts/[id]/asset/finalize/route.ts");
  for (const route of [sessionRoute, finalizeRoute]) {
    assert.doesNotMatch(route, /formData\(|arrayBuffer\(|\.upload\(/, "no file body is read or re-uploaded");
    assert.match(route, /getCurrentUser\(\)/);
    assert.match(route, /status: 401/);
    assert.doesNotMatch(route, /open\.tiktokapis\.com|initDirectPost|publish\/video/i, "no TikTok call");
  }
  assert.match(sessionRoute, /\.strict\(\)/);
  assert.doesNotMatch(sessionRoute, /SUPABASE_SECRET_KEY|service_role/, "only the path-scoped token is returned");
  await assert.rejects(read("app/api/social-drafts/[id]/asset/route.ts"), "the old pass-through upload route is removed");

  const editor = await read("components/voom/modals/SocialEditorModal.tsx");
  const uploadClient = await read("lib/tiktok/upload-client.ts");
  assert.match(editor, /createTikTokUploadController/);
  assert.match(editor, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(editor + uploadClient, /SUPABASE_SECRET_KEY|createAdminClient|service_role/);
  assert.doesNotMatch(editor, /new FormData/);
  assert.match(editor, /role="progressbar"/);
  assert.match(editor, />Cancel</);
  assert.match(editor, />Retry</);
  assert.match(editor, /up to 50 MB/);
  assert.match(editor, /disabled=\{busy \|\| uploading \|\| !draft\.asset\}/, "posting stays gated on an attached video");
  const sheet = await read("components/voom/modals/TikTokPostSheet.tsx");
  assert.match(sheet, /isTikTokVideoPreviewReady\(previewState, duration\)/, "the playable-preview gate is unchanged");
});

/* ── 0060 against the real migrations ───────────────────────────────── */

let lite = null;
async function liteDb() {
  if (lite) return lite;
  const { db } = await createSupabaseLite();
  await db.query("insert into auth.users (id, email) values ($1, 'a@voom.test'), ($2, 'b@voom.test')", [OWNER, OTHER_OWNER]);
  lite = db;
  return db;
}
async function makeDraft(db, ownerId, kind, channel) {
  const conv = (await db.query("insert into public.mara_conversations (owner_user_id, title) values ($1, 'Studio') returning id", [ownerId])).rows[0].id;
  return (await db.query(
    `insert into public.mara_drafts (conversation_id, owner_user_id, kind, channel, title, content, social_channel, social_format, content_meta, status)
     values ($1, $2, $3, $4, 'Draft', 'Caption', $5, $6, '{}'::jsonb, 'draft') returning id`,
    [conv, ownerId, kind, channel.label, channel.social, channel.format],
  )).rows[0].id;
}
async function insertAsset(db, ownerId, draftId, size, mime = "video/mp4") {
  await db.query(
    `insert into public.post_draft_assets (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size, origin, status)
     values ($1, $2, $3, 'video.mp4', $4, $5, 'uploaded_existing', 'uploaded')`,
    [ownerId, draftId, `${ownerId}/tiktok-uploads/${draftId}/${crypto.randomUUID()}.mp4`, mime, size],
  );
}

test("0060: TikTok MP4s may be up to 50 MB; everything else keeps the 20 MB limit; rollback refuses while large files exist", async () => {
  const db = await liteDb();
  const tiktok = { label: "TikTok · 9:16", social: "tiktok", format: "video" };
  const youtube = { label: "YouTube Short · 9:16", social: "youtube", format: "short" };
  const t1 = await makeDraft(db, OWNER, "tiktok_video", tiktok);
  await insertAsset(db, OWNER, t1, 49 * MB);
  const t2 = await makeDraft(db, OWNER, "tiktok_video", tiktok);
  await insertAsset(db, OWNER, t2, 50 * MB);
  const t3 = await makeDraft(db, OWNER, "tiktok_video", tiktok);
  await assert.rejects(insertAsset(db, OWNER, t3, 50 * MB + 1), /post_draft_assets_byte_size_limit/);
  await assert.rejects(insertAsset(db, OWNER, t3, 25 * MB, "video/quicktime"), /post_draft_asset_too_large/);
  const y1 = await makeDraft(db, OWNER, "youtube_short", youtube);
  await assert.rejects(insertAsset(db, OWNER, y1, 25 * MB), /post_draft_asset_too_large/, "other media keep 20 MB");
  await insertAsset(db, OWNER, y1, 20 * MB);
  const foreign = await makeDraft(db, OTHER_OWNER, "tiktok_video", tiktok);
  await assert.rejects(insertAsset(db, OWNER, foreign, 25 * MB), "a row cannot borrow another owner's TikTok draft");
  await assert.rejects(db.query("update public.post_draft_assets set byte_size = $1 where draft_id = $2", [21 * MB, y1]), /post_draft_asset_too_large/);

  const rollback = await read("supabase/proposed/0060_tiktok_video_upload_50mb.rollback.sql");
  await assert.rejects(db.exec(rollback), /rollback_blocked/);
  await db.exec("rollback").catch(() => undefined);
});
