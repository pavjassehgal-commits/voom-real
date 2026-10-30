/**
 * The REAL editor upload component and the REAL browser tus-js-client build,
 * in Chromium, against a loopback-only synthetic Storage/TUS + upload-API
 * server. No Supabase, Google or provider endpoint is contacted.
 *
 * Proves the editor's transport behaviour end to end: pause stops transfer
 * and resume continues the SAME object from the acknowledged offset; closing
 * the editor and reopening resumes only with the same original bytes; a
 * transient chunk loss recovers on its own; an expired upload grant pauses and
 * resumes with a fresh grant; cancel stops transfer and never attaches.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { documentFrom, measureRenderedPages, RenderedSurfaceUnavailable, withClientBundle } from "./helpers/rendered-surface.mjs";
import { buildClientBundle } from "./helpers/client-bundle.mjs";

const DRAFT = "33333333-3333-4333-8333-333333333333";
const SIZE = 20 * 1024 * 1024 + 7; // four 6 MiB TUS chunks: create + three PATCHes
const expected = (() => { const b = Buffer.alloc(SIZE); for (let i = 0; i < SIZE; i++) b[i] = i % 251; return b; })();
const EXPECTED_SHA = createHash("sha256").update(expected).digest("hex");

let server, origin, state;
function reset(options = {}) {
  state = {
    starts: 0, authorizes: 0, completes: 0, cancels: 0, creates: 0, heads: 0, patches: 0, rejectedSignatures: 0,
    session: null, stored: Buffer.alloc(0), attached: false, token: null,
    dropNextPatch: Boolean(options.dropNextPatch), expireFirstGrantAfterPatches: options.expireFirstGrantAfterPatches ?? null,
    patchDelay: options.patchDelay ?? 250, maxBytes: options.maxBytes ?? 52428800,
  };
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
const publicSession = (s) => s && ({ id: s.id, name: s.name, size: s.size, fingerprint: s.fingerprint, status: s.status, expiresAt: s.expiresAt });

async function body(req) { const parts = []; for await (const chunk of req) parts.push(chunk); return Buffer.concat(parts); }

before(async () => {
  reset();
  server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,HEAD,DELETE,OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "Location,Upload-Offset,Upload-Length,Tus-Resumable");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const url = new URL(req.url, origin);
    try {
      if (url.pathname === "/__state") return json(res, 200, { ...state, stored: state.stored.length, session: publicSession(state.session) });

      // Synthetic upload API with the real route's response shapes.
      if (url.pathname === `/api/posts/${DRAFT}/video-upload`) {
        if (req.method === "GET") return json(res, 200, { upload: state.session?.status === "pending" ? publicSession(state.session) : null, maxBytes: state.maxBytes });
        const input = JSON.parse((await body(req)).toString());
        if (input.action === "start") {
          if (state.session?.status === "pending" && state.session.key !== input.key) return json(res, 409, { code: "upload_already_pending", error: "This draft already has an upload. Resume or cancel it first." });
          if (!state.session || state.session.key !== input.key) {
            state.starts++;
            state.session = { id: "44444444-4444-4444-8444-44444444444" + state.starts, key: input.key, name: input.name, size: input.size, fingerprint: input.fingerprint, status: "pending", expiresAt: new Date(Date.now() + 864e5).toISOString() };
          }
          return json(res, 200, { upload: publicSession(state.session) });
        }
        if (input.uploadId !== state.session?.id) return json(res, 409, { code: "upload_unavailable", error: "Unavailable." });
        if (input.action === "authorize") {
          if (state.session.status !== "pending") return json(res, 409, { code: "upload_unavailable", error: "Unavailable." });
          state.authorizes++; state.token = `synthetic-grant-${state.authorizes}`;
          return json(res, 200, { upload: publicSession(state.session), authorization: { token: state.token, expiresAt: new Date(Date.now() + 72e5).toISOString(), endpoint: `${origin}/storage/v1/upload/resumable/sign`, bucket: "youtube-uploads", path: `owner/youtube-uploads/${state.session.id}.mp4` } });
        }
        if (input.action === "cancel") { state.cancels++; state.session.status = "cancelled"; return json(res, 200, { cancelled: true }); }
        if (input.action === "complete") {
          if (state.session.status !== "pending") return json(res, 409, { code: "upload_unavailable", error: "Unavailable." });
          if (state.stored.length !== state.session.size) return json(res, 409, { code: "upload_not_complete", error: "The file is not fully stored yet. Resume the same upload; do not start another." });
          state.completes++; state.attached = true; state.session.status = "attached";
          return json(res, 200, { draft: { id: DRAFT, channel: "youtube" }, message: "Video stored privately." });
        }
        return json(res, 400, { code: "invalid_request" });
      }

      // Synthetic Supabase TUS endpoint: one object, offsets, signature checks.
      if (url.pathname.startsWith("/storage/v1/upload/resumable")) {
        res.setHeader("Tus-Resumable", "1.0.0");
        const signature = req.headers["x-signature"];
        if (req.headers.apikey !== "sb_publishable_synthetic") { await body(req).catch(() => null); res.writeHead(401).end("apikey required"); return; }
        if (signature !== state.token) { state.rejectedSignatures++; await body(req).catch(() => null); res.writeHead(403).end("expired signature"); return; }
        if (req.method === "HEAD") { state.heads++; res.setHeader("Upload-Offset", String(state.stored.length)); res.setHeader("Upload-Length", String(SIZE)); res.writeHead(200).end(); return; }
        if (req.method === "POST") {
          state.creates++;
          assert.match(String(req.headers["upload-metadata"]), /bucketName/);
          assert.equal(req.headers["x-upsert"], undefined, "uploads never overwrite");
          state.stored = Buffer.alloc(0);
          const chunk = await body(req);
          state.stored = Buffer.concat([state.stored, chunk]);
          res.setHeader("Location", `${origin}/storage/v1/upload/resumable/object-${state.creates}`);
          res.setHeader("Upload-Offset", String(state.stored.length));
          res.writeHead(201).end(); return;
        }
        assert.equal(req.method, "PATCH");
        assert.equal(Number(req.headers["upload-offset"]), state.stored.length, "PATCH continues from the acknowledged offset");
        const declared = Number(req.headers["content-length"]);
        const chunk = await body(req);
        if (chunk.length !== declared) return; // aborted mid-request: nothing acknowledged
        await new Promise((resolve) => setTimeout(resolve, state.patchDelay));
        if (req.socket.destroyed) return;
        state.stored = Buffer.concat([state.stored, chunk]);
        state.patches++;
        if (state.dropNextPatch) { state.dropNextPatch = false; req.socket.destroy(); return; } // stored, but the response is lost
        if (state.expireFirstGrantAfterPatches !== null && state.patches >= state.expireFirstGrantAfterPatches && state.authorizes === 1) state.token = "expired";
        res.setHeader("Upload-Offset", String(state.stored.length));
        res.writeHead(204).end(); return;
      }
      res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error?.message ?? error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function page() {
  const bundle = buildClientBundle(`
    import { createRoot } from "react-dom/client";
    import { createElement as h } from "react";
    import { YouTubeVideoUpload } from "./components/voom/modals/YouTubeVideoUpload.tsx";
    window.process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_synthetic";
    const api = ${JSON.stringify(origin)}, real = window.fetch.bind(window);
    // The component calls same-origin /api routes; serve them from the synthetic API.
    window.fetch = (url, init) => real(typeof url === "string" && url.startsWith("/api/") ? api + url : url, init);
    window.__attached = []; window.__busy = [];
    const root = createRoot(document.getElementById("root"));
    window.__mount = (on) => root.render(on ? h(YouTubeVideoUpload, { key: Math.random(), draftId: ${JSON.stringify(DRAFT)}, disabled: false,
      onAttached: (draft) => window.__attached.push(draft), onBusy: (busy) => window.__busy.push(busy) }) : null);
    window.__mount(true);
  `);
  return bundle;
}

const PROBE = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const server = async () => (await fetch(${"`${window.__api}/__state`"})).json();
  const until = async (fn, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(50); } throw new Error("timed out: " + label); };
  const text = () => document.body.innerText.replace(/\\s+/g, " ");
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  const input = () => document.querySelector("input[type=file]");
  function file(changedMiddle = false) {
    const bytes = new Uint8Array(${SIZE}); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    if (changedMiddle) bytes[Math.floor(bytes.length / 2)] ^= 1;
    return new File([bytes], "Original.mp4", { type: "video/mp4" });
  }
  async function choose(f) {
    await until(() => input() && !input().disabled, "file input ready");
    const transfer = new DataTransfer(); transfer.items.add(f); input().files = transfer.files;
    input().dispatchEvent(new Event("change", { bubbles: true }));
  }
`;

async function run(t, options, script) {
  reset(options);
  const html = withClientBundle(await documentFrom('<div id="root"></div>'), page()).replace("<head>", `<head><script>window.__api=${JSON.stringify(origin)}</script>`);
  try {
    const [result] = await measureRenderedPages([{ name: "youtube-upload-editor", width: 390, height: 844, html, evaluate: `(async () => { ${PROBE} ${script} })()` }]);
    assert.equal(result.evaluateError, null, result.evaluateError ?? "");
    assert.equal(result.bodyScrollWidth <= result.innerWidth, true, "no horizontal overflow at 390px");
    const errors = result.consoleMessages.filter((m) => m.level === "error" && !/Failed to load resource/.test(m.text));
    assert.deepEqual(errors, [], "no runtime errors");
    return result.evaluate;
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) { t.skip("no Chromium available"); return null; }
    throw error;
  }
}
const storedBytesMatch = () => state.stored.length === SIZE && createHash("sha256").update(state.stored).digest("hex") === EXPECTED_SHA;

test("pause stops the transfer; resume continues the SAME object from the server offset and attaches once", async (t) => {
  const r = await run(t, {}, `
    await choose(file());
    await until(async () => (await server()).patches >= 1, "first chunk acknowledged");
    await until(() => button("Pause upload"), "pause offered");
    button("Pause upload").click();
    await until(() => /Upload paused/.test(text()), "paused message");
    const paused = await server(); await wait(900); const still = await server();
    const pausedUi = { resume: Boolean(button("Resume upload")), cancel: Boolean(button("Cancel upload")), progress: Boolean(document.querySelector("progress")) };
    button("Resume upload").click();
    await until(() => window.__attached.length === 1, "attached");
    return { paused: paused.stored, still: still.stored, pausedPatches: paused.patches, stillPatches: still.patches, pausedUi, message: text(), attached: window.__attached.length, busy: window.__busy };
  `);
  if (!r) return;
  assert.ok(r.paused > 0 && r.paused < SIZE, "paused part-way");
  assert.equal(r.still, r.paused, "no bytes are acknowledged while paused");
  assert.equal(r.stillPatches, r.pausedPatches);
  assert.deepEqual(r.pausedUi, { resume: true, cancel: true, progress: false });
  assert.equal(state.starts, 1, "one logical upload session");
  assert.equal(state.creates, 1, "one storage object: resume never re-creates");
  assert.ok(state.heads >= 1, "resume asked the server for its acknowledged offset");
  assert.ok(storedBytesMatch(), "stored bytes are exactly the original file");
  assert.equal(state.completes, 1);
  assert.equal(r.attached, 1);
  assert.match(r.message, /Video attached privately\. Review and approve separately; nothing was scheduled or published\./);
  assert.equal(r.busy.at(-1), false, "the editor is released after attachment");
});

test("closing the editor pauses; reopening resumes only with the same original bytes", async (t) => {
  const r = await run(t, {}, `
    await choose(file());
    await until(async () => (await server()).patches >= 1, "first chunk acknowledged");
    window.__mount(false);
    const closed = await server(); await wait(900); const afterClose = await server();
    window.__mount(true);
    await until(() => /An unfinished upload is available/.test(text()), "unfinished upload offered");
    await choose(file(true));
    await until(() => /Choose the same original file to resume/.test(text()), "changed file refused");
    const refused = await server();
    await choose(file());
    await until(() => window.__attached.length === 1, "attached after reopening");
    return { closed: closed.stored, afterClose: afterClose.stored, refusedStarts: refused.starts, refusedCreates: refused.creates, refusedStored: refused.stored };
  `);
  if (!r) return;
  assert.ok(r.closed > 0 && r.closed < SIZE);
  assert.equal(r.afterClose, r.closed, "closing the editor stops the transfer");
  assert.equal(r.refusedStarts, 1, "a changed file never starts a second session");
  assert.equal(r.refusedCreates, 1);
  assert.equal(r.refusedStored, r.closed, "a changed file never continues the stored object");
  assert.equal(state.starts, 1);
  assert.equal(state.creates, 1, "reopening resumed the stored object from its offset");
  assert.ok(storedBytesMatch());
  assert.equal(state.completes, 1);
});

test("failed-upload recovery: a lost chunk response retries automatically; an expired grant pauses and resumes with a fresh one", async (t) => {
  const r = await run(t, { dropNextPatch: true, expireFirstGrantAfterPatches: 2 }, `
    await choose(file());
    await until(() => /Upload interrupted/.test(text()), "interrupted by the expired grant");
    const interrupted = await server();
    button("Resume upload").click();
    await until(() => window.__attached.length === 1, "attached after re-authorisation");
    return { interrupted };
  `);
  if (!r) return;
  assert.ok(r.interrupted.stored > 0 && r.interrupted.stored < SIZE);
  assert.equal(state.dropNextPatch, false, "a chunk response really was lost mid-upload");
  assert.ok(r.interrupted.rejectedSignatures >= 1, "the expired grant was refused by storage");
  assert.equal(state.authorizes, 2, "resume requested a fresh, short-lived grant");
  assert.equal(state.creates, 1, "neither failure created another object");
  assert.equal(state.starts, 1);
  assert.ok(storedBytesMatch(), "the dropped response did not duplicate or corrupt bytes");
  assert.equal(state.completes, 1);
});

test("cancel stops the transfer, cancels only this session and never attaches", async (t) => {
  const r = await run(t, {}, `
    await choose(file());
    await until(async () => (await server()).patches >= 1, "first chunk acknowledged");
    button("Cancel upload").click();
    await until(() => /Upload cancelled/.test(text()), "cancel confirmed");
    const cancelled = await server(); await wait(900); const later = await server();
    return { cancelled: cancelled.stored, later: later.stored, message: text(), attached: window.__attached.length, buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()), inputEnabled: !input().disabled };
  `);
  if (!r) return;
  assert.equal(state.cancels, 1);
  assert.equal(r.later, r.cancelled, "no bytes are acknowledged after cancel");
  assert.equal(state.completes, 0, "a cancelled upload is never attached");
  assert.equal(r.attached, 0);
  assert.match(r.message, /Existing attached media was not removed/);
  assert.deepEqual(r.buttons, [], "no stale resume/cancel controls remain");
  assert.equal(r.inputEnabled, true, "a new upload can be chosen");
});

test("a file above the effective limit is refused in the editor before anything is hashed or uploaded", async (t) => {
  const r = await run(t, { maxBytes: 20 * 1024 * 1024 }, `
    await until(() => /MP4 up to 20 MB\./.test(text()), "effective limit shown");
    await choose(file());
    await until(() => /Choose one MP4 up to 20 MB/.test(text()), "oversized file refused");
    await wait(300);
    return { inputEnabled: !input().disabled, progress: Boolean(document.querySelector("progress")) };
  `);
  if (!r) return;
  assert.equal(state.starts, 0, "no upload session was requested");
  assert.equal(state.creates, 0, "no bytes were sent to Storage");
  assert.deepEqual(r, { inputEnabled: true, progress: false });
});
