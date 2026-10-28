import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

// Only session/cookie infrastructure and Google's network are mocked. These
// are the actual routes, client, state checks, encryption and migration RPC.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "next/headers") return { shortCircuit: true,
    url: "data:text/javascript,export async function cookies(){return globalThis.__youtubeReconnect.cookies}" };
  if (specifier === "next/server") return { shortCircuit: true,
    url: new URL("../node_modules/next/server.js", import.meta.url).href };
  if (specifier === "@/lib/voom/server-data") return { shortCircuit: true,
    url: "data:text/javascript,export async function getCurrentUser(){return globalThis.__youtubeReconnect.user}" };
  if (specifier === "@/utils/supabase/admin") return { shortCircuit: true,
    url: "data:text/javascript,export function createAdminClient(){globalThis.__youtubeReconnect.adminCalls++;return globalThis.__youtubeReconnect.admin}" };
  return next(specifier, context);
} });
const { POST } = await import("../app/api/integrations/youtube/connect/route.ts");
const { GET } = await import("../app/api/integrations/youtube/callback/route.ts");
const { saveYouTubeConnection } = await import("../lib/youtube/data.ts");
const { decryptYouTubeToken } = await import("../lib/youtube/crypto.ts");
const { YOUTUBE_SCOPES } = await import("../lib/youtube/scopes.ts");
const ORIGIN = "https://voom.today";
const PATH = "/api/integrations/youtube/callback";
const COOKIE = "voom_youtube_oauth_state";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const KEY = "synthetic-youtube-reconnection-encryption-key";
let database;
async function localDb() {
  if (!database) database = createSupabaseLite().then(({ db }) => db);
  return database;
}

function adapter(db) {
  return {
    from(table) {
      assert.equal(table, "youtube_oauth_states");
      const filters = [];
      let patch;
      return {
        async insert(value) {
          await db.query("insert into public.youtube_oauth_states (state_hash,owner_user_id,expires_at) values ($1,$2,$3)",
            [value.state_hash, value.owner_user_id, value.expires_at]);
          return { error: null };
        },
        update(value) { patch = value; return this; },
        eq(k, v) { filters.push([k, "=", v]); return this; },
        is(k, v) { assert.equal(v, null); filters.push([k, "is null"]); return this; },
        gt(k, v) { filters.push([k, ">", v]); return this; },
        select() { return this; },
        async maybeSingle() {
          const values = [patch.consumed_at];
          const where = filters.map(([k, op, v]) => {
            assert.ok(["state_hash", "owner_user_id", "consumed_at", "expires_at"].includes(k));
            if (op === "is null") return `${k} is null`;
            values.push(v); return `${k} ${op} $${values.length}`;
          }).join(" and ");
          const result = await db.query(`update public.youtube_oauth_states set consumed_at=$1 where ${where} returning state_hash`, values);
          return { data: result.rows[0] ?? null, error: null };
        },
      };
    },
    async rpc(name, args) {
      assert.equal(name, "save_youtube_connection", "reconnection must not disconnect, revoke or queue work");
      const types = {
        p_owner_user_id: "uuid", p_channel_id: "text", p_channel_title: "text", p_channel_handle: "text",
        p_thumbnail_url: "text", p_scopes: "text[]", p_encrypted_refresh_token: "text", p_refresh_iv: "text",
        p_refresh_auth_tag: "text", p_refresh_key_version: "smallint", p_encrypted_access_token: "text",
        p_access_iv: "text", p_access_auth_tag: "text", p_access_key_version: "smallint", p_access_token_expires_at: "timestamptz",
      };
      const entries = Object.entries(args);
      const params = entries.map(([k], i) => { assert.ok(types[k]); return `${k} => $${i + 1}::${types[k]}`; });
      // Emulate PostgREST's per-RPC transaction inside the rollback-only fixture.
      await db.exec("savepoint rpc_call");
      try {
        const result = await db.query(`select public.${name}(${params.join(",")}) as id`, entries.map(([, v]) => v));
        await db.exec("release savepoint rpc_call");
        return { data: result.rows[0].id, error: null };
      } catch (error) {
        await db.exec("rollback to savepoint rpc_call; release savepoint rpc_call");
        return { data: null, error: { code: error.code } };
      }
    },
  };
}

async function fixture(fn) {
  const db = await localDb();
  const env = { NODE_ENV: "production", GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret",
    YOUTUBE_REDIRECT_URI: ORIGIN + PATH, YOUTUBE_TOKEN_ENCRYPTION_KEY: KEY };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, env);
  const jar = new Map();
  const c = { db, user: { id: OWNER }, admin: adapter(db), adminCalls: 0, requests: [], writes: [],
    current: null, tokenStatus: 200, channelStatus: 200, channel: "UC_original_channel",
    tokens: { access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", expires_in: 3600, scope: YOUTUBE_SCOPES.join(" ") },
    cookies: {
      get(name) {
        const url = new URL(c.current.url);
        const cookie = [...jar.values()].find(x => x.name === name && x.origin === url.origin
          && (url.pathname === x.path || url.pathname.startsWith(x.path + "/")));
        return cookie ? { value: cookie.value } : undefined;
      },
      set(name, value, options) {
        const origin = new URL(c.current.url).origin;
        const entry = { name, value, origin, ...options };
        const key = `${origin}|${options.path}|${name}`;
        c.writes.push(entry);
        if (options.maxAge === 0) jar.delete(key); else jar.set(key, entry);
      },
    },
    async invoke(request, handler) { c.current = request; return handler(request); },
    async start(origin = ORIGIN) {
      const response = await c.invoke(new Request(origin + "/api/integrations/youtube/connect", { method: "POST", headers: { origin } }), POST);
      const body = await response.json();
      return { response, body, url: body.authorizationUrl ? new URL(body.authorizationUrl) : null };
    },
    async finish(state, options = {}) {
      const url = new URL(options.origin ?? ORIGIN); url.pathname = PATH;
      url.searchParams.set("state", state); url.searchParams.set("code", "synthetic-code");
      if (options.cancelled) { url.searchParams.delete("code"); url.searchParams.set("error", "access_denied"); }
      return c.invoke(new Request(url), GET);
    },
    putState(state, origin = ORIGIN) {
      jar.set(`${origin}|${PATH}|${COOKIE}`, { name: COOKIE, value: state, path: PATH, origin });
    },
    async snapshot() {
      return (await db.query("select (select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from public.youtube_connections c) as connections,(select coalesce(jsonb_agg(to_jsonb(s) order by connection_id),'[]') from public.youtube_connection_secrets s) as secrets")).rows[0];
    },
  };
  globalThis.__youtubeReconnect = c;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    c.requests.push({ url, method: init?.method, body: init?.body });
    if (url.href === "https://oauth2.googleapis.com/token") {
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("grant_type"), "authorization_code");
      assert.equal(init.body.get("redirect_uri"), process.env.YOUTUBE_REDIRECT_URI);
      return Response.json(c.tokens, { status: c.tokenStatus });
    }
    assert.equal(url.origin + url.pathname, "https://www.googleapis.com/youtube/v3/channels", "no uploads, workers or token revocation allowed");
    assert.equal(url.searchParams.get("mine"), "true");
    return Response.json({ items: [{ id: c.channel, snippet: { title: "Test channel", customUrl: "@synthetic-test" } }] }, { status: c.channelStatus });
  };
  await db.exec("begin");
  try {
    await db.query("insert into auth.users(id,email) values ($1,'owner@example.test'),($2,'other@example.test')", [OWNER, OTHER]);
    await seed(c.admin, OWNER, "UC_original_channel");
    await db.query("update public.youtube_connections set status='revoked' where owner_user_id=$1", [OWNER]);
    c.before = await c.snapshot();
    await fn(c);
    assert.equal((await db.query("select count(*)::int n from public.youtube_publish_queue")).rows[0].n, 0);
  } finally {
    await db.exec("rollback");
    globalThis.fetch = oldFetch;
    delete globalThis.__youtubeReconnect;
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function seed(admin, ownerId, channelId) {
  return saveYouTubeConnection(admin, { ownerId, channelId, channelTitle: "Existing channel", channelHandle: "@old-test",
    thumbnailUrl: null, grantedScopes: [...YOUTUBE_SCOPES], refreshToken: "synthetic-old-refresh", accessToken: "synthetic-old-access",
    accessTokenExpiresAt: "2026-09-21T14:48:35Z", encryptionKey: KEY });
}
const errorCode = response => new URL(response.headers.get("location")).searchParams.get("youtube_error");

test("legacy Production callback host mismatch fails before state, cookies or Google; old connection survives", () => fixture(async c => {
  process.env.YOUTUBE_REDIRECT_URI = "https://voom-real.vercel.app" + PATH;
  const { response, body } = await c.start();
  assert.equal(response.status, 503); assert.match(body.error, /callback/);
  assert.equal(c.adminCalls, 0); assert.equal(c.writes.length, 0); assert.equal(c.requests.length, 0);
  assert.equal((await c.db.query("select count(*)::int n from public.youtube_oauth_states")).rows[0].n, 0);
  assert.deepEqual(await c.snapshot(), c.before);
}));

test("callback requires the exact same-origin callback path, not query strings, fragments or URL credentials", () => fixture(async c => {
  for (const uri of [ORIGIN + "/wrong", ORIGIN + PATH + "?next=x", ORIGIN + PATH + "#x", "https://user@voom.today" + PATH]) {
    process.env.YOUTUBE_REDIRECT_URI = uri;
    assert.equal((await c.start()).response.status, 503);
  }
  assert.equal(c.requests.length, 0); assert.equal(c.adminCalls, 0);
}));

test("corrected callback retains host-only secure state, offline consent and identical code-exchange redirect", () => fixture(async c => {
  const { response, url } = await c.start();
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(url.searchParams.get("redirect_uri"), ORIGIN + PATH);
  assert.equal(url.searchParams.get("access_type"), "offline"); assert.equal(url.searchParams.get("prompt"), "consent");
  assert.deepEqual(url.searchParams.get("scope").split(" "), [...YOUTUBE_SCOPES]);
  const cookie = c.writes.at(-1);
  assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, "lax");
  assert.equal(cookie.path, PATH); assert.equal(cookie.maxAge, 600); assert.equal(cookie.domain, undefined);
  assert.deepEqual(await c.snapshot(), c.before, "starting reconnect must not remove old metadata or tokens");
  c.current = new Request("https://voom-real.vercel.app" + PATH);
  assert.equal(c.cookies.get(COOKIE), undefined, "the old callback cannot receive voom.today's state cookie");
  const result = await c.finish(url.searchParams.get("state"));
  assert.equal(new URL(result.headers.get("location")).href, ORIGIN + "/app/youtube?youtube=connected");
  assert.equal(c.requests.length, 2);
  const after = await c.snapshot();
  assert.equal(after.connections.length, 1); assert.equal(after.connections[0].id, c.before.connections[0].id);
  assert.equal(after.connections[0].status, "connected");
  const secret = after.secrets[0];
  assert.equal(decryptYouTubeToken({ encryptedToken: secret.encrypted_refresh_token, iv: secret.refresh_iv, authTag: secret.refresh_auth_tag }, KEY), "synthetic-new-refresh");
  const clear = c.writes.at(-1);
  assert.equal(clear.path, cookie.path); assert.equal(clear.maxAge, 0); assert.equal(clear.domain, undefined);
  c.current = new Request(ORIGIN + PATH); assert.equal(c.cookies.get(COOKIE), undefined);
  assert.doesNotMatch(result.headers.get("location"), /synthetic-(code|new-access|new-refresh)/);
}));

test("staging uses its own registered callback without being forced to Production", () => fixture(async c => {
  const staging = "https://isolated-staging.example.test";
  process.env.YOUTUBE_REDIRECT_URI = staging + PATH;
  const { url } = await c.start(staging);
  assert.equal(url.searchParams.get("redirect_uri"), staging + PATH);
  assert.equal(errorCode(await c.finish(url.searchParams.get("state"), { origin: staging })), null);
}));

test("signed-out and cross-origin connect requests cannot create state or alter the connection", () => fixture(async c => {
  const response = await c.invoke(new Request(ORIGIN + "/api/integrations/youtube/connect", { method: "POST", headers: { origin: "https://attacker.test" } }), POST);
  assert.equal(response.status, 403);
  c.user = null; assert.equal((await c.start()).response.status, 401);
  assert.equal(c.adminCalls, 0); assert.deepEqual(await c.snapshot(), c.before);
}));

test("signed-out callback cannot exchange a code or replace stored credentials", () => fixture(async c => {
  const { url } = await c.start(); c.user = null;
  assert.equal((await c.finish(url.searchParams.get("state"))).headers.get("location"), ORIGIN + "/login");
  assert.equal(c.requests.length, 0); assert.deepEqual(await c.snapshot(), c.before);
}));

test("wrong-owner, expired, mismatched and missing cookies fail closed before any provider call", () => fixture(async c => {
  for (const failure of ["owner", "expired", "mismatched", "missing"]) {
    const { url } = await c.start(); const state = url.searchParams.get("state");
    if (failure === "owner") c.user = { id: OTHER };
    if (failure === "expired") await c.db.exec("update public.youtube_oauth_states set expires_at=now()-interval '1 second'");
    if (failure === "mismatched") c.putState("x".repeat(43));
    const result = await c.finish(state, failure === "missing" ? { origin: "https://voom-real.vercel.app" } : {});
    assert.equal(errorCode(result), "invalid_state"); c.user = { id: OWNER };
  }
  assert.equal(c.requests.length, 0); assert.deepEqual(await c.snapshot(), c.before);
}));

test("a configuration change during OAuth fails without consuming state or replacing the old connection", () => fixture(async c => {
  const { url } = await c.start(); process.env.YOUTUBE_REDIRECT_URI = "https://voom-real.vercel.app" + PATH;
  assert.equal(errorCode(await c.finish(url.searchParams.get("state"))), "configuration_mismatch");
  assert.equal((await c.db.query("select count(*)::int n from public.youtube_oauth_states where consumed_at is not null")).rows[0].n, 0);
  assert.equal(c.requests.length, 0); assert.deepEqual(await c.snapshot(), c.before);
}));

test("denied consent, missing offline access, partial or missing upload consent preserve old credentials", () => fixture(async c => {
  for (const failure of ["denied", "offline", "scope", "missing_scope"]) {
    const { url } = await c.start();
    c.tokens.refresh_token = failure === "offline" ? undefined : "synthetic-new-refresh";
    c.tokens.scope = failure === "scope" ? YOUTUBE_SCOPES[1] : failure === "missing_scope" ? undefined : YOUTUBE_SCOPES.join(" ");
    const result = await c.finish(url.searchParams.get("state"), { cancelled: failure === "denied" });
    assert.ok(errorCode(result)); assert.deepEqual(await c.snapshot(), c.before);
  }
  assert.ok(c.requests.every(r => r.url.origin === "https://oauth2.googleapis.com"));
}));

test("token rejection and failed channel identification never erase the old connection", () => fixture(async c => {
  c.tokenStatus = 400; c.tokens = { error: "invalid_grant" };
  let start = await c.start(); assert.ok(errorCode(await c.finish(start.url.searchParams.get("state"))));
  assert.deepEqual(await c.snapshot(), c.before);
  c.tokenStatus = 200; c.tokens = { access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", scope: YOUTUBE_SCOPES.join(" ") };
  c.channelStatus = 403; start = await c.start(); assert.ok(errorCode(await c.finish(start.url.searchParams.get("state"))));
  assert.deepEqual(await c.snapshot(), c.before);
}));

test("replayed callback cannot exchange again; repeated successful reconnects reuse the original connection UUID", () => fixture(async c => {
  const { url } = await c.start(); const state = url.searchParams.get("state");
  assert.equal(errorCode(await c.finish(state)), null);
  const first = await c.snapshot(); c.putState(state);
  assert.equal(errorCode(await c.finish(state)), "invalid_state"); assert.equal(c.requests.length, 2);
  assert.deepEqual(await c.snapshot(), first);
  const next = await c.start(); assert.equal(errorCode(await c.finish(next.url.searchParams.get("state"))), null);
  const after = await c.snapshot(); assert.equal(after.connections.length, 1); assert.equal(after.secrets.length, 1);
  assert.equal(after.connections[0].id, c.before.connections[0].id);
}));

test("a channel already connected to another owner cannot be stolen or duplicated", () => fixture(async c => {
  await seed(c.admin, OTHER, "UC_someone_elses_channel");
  const before = await c.snapshot(); c.channel = "UC_someone_elses_channel";
  const { url } = await c.start(); assert.equal(errorCode(await c.finish(url.searchParams.get("state"))), "save_failed");
  assert.deepEqual(await c.snapshot(), before);
}));

test("failed encrypted-secret replacement rolls back metadata too, retaining the original authorization", () => fixture(async c => {
  await c.db.exec("create function public.test_reconnect_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic persistence failure'; end $$; create trigger test_reconnect_failure before update on public.youtube_connection_secrets for each row execute function public.test_reconnect_failure()");
  const { url } = await c.start(); assert.equal(errorCode(await c.finish(url.searchParams.get("state"))), "save_failed");
  assert.deepEqual(await c.snapshot(), c.before);
}));

test.after(async () => { if (database) await (await database).close(); });
