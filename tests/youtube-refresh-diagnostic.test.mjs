import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

// Fake only the infrastructure clients. Exercise the real route, Google
// client, AES-GCM storage and existing getYouTubeServerCredentials function.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/utils/supabase/server") return { shortCircuit: true,
    url: 'data:text/javascript,export async function createClient(){return globalThis.__youtubeDiagnostic.userDb}' };
  if (specifier === "@/utils/supabase/admin") return { shortCircuit: true,
    url: 'data:text/javascript,export function createAdminClient(){globalThis.__youtubeDiagnostic.adminCalls++;return globalThis.__youtubeDiagnostic.adminDb}' };
  return next(specifier, context);
} });
const { REFRESH_DIAGNOSTIC: target, UPLOAD_SCOPE } = await import("../lib/youtube/refresh-diagnostic.ts");
const { encryptYouTubeToken, decryptYouTubeToken } = await import("../lib/youtube/crypto.ts");
const { POST } = await import("../app/api/integrations/youtube/refresh-diagnostic/route.ts");
const { DIAGNOSTIC_MARKER } = await import("../lib/youtube/refresh-diagnostic-server.ts");
const KEY = "synthetic-encryption-key-for-local-test-only";
const NOW = Date.parse("2026-10-27T20:00:00Z");
const ENDPOINT = "https://voom.today/api/integrations/youtube/refresh-diagnostic";
const fixture = () => ({ id: target.connection, owner_user_id: target.owner, channel_id: target.channel,
  channel_handle: target.handle, connected_at: new Date(target.connectedAt).toISOString(), status: "connected",
  scopes: [UPLOAD_SCOPE, "https://www.googleapis.com/auth/youtube.readonly"], access_token_expires_at: "2026-09-21T14:48:35Z" });
function request({ origin = target.origin, body = { confirm: target.confirmation }, method = "POST" } = {}) {
  return new Request(ENDPOINT, { method, headers: { origin, "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
}
async function run(fn) {
  const env = { VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: target.project,
    GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
    YOUTUBE_REDIRECT_URI: "https://voom-real.vercel.app/api/integrations/youtube/callback", YOUTUBE_TOKEN_ENCRYPTION_KEY: KEY };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  const oldFetch = globalThis.fetch, oldNow = Date.now;
  Object.assign(process.env, env); Date.now = () => NOW;
  const ctx = { row: fixture(), user: { id: target.owner, email: target.email }, marker: false,
    adminCalls: 0, network: 0, persisted: 0, statusWrites: 0, claimError: null, persistError: false,
    response: { access_token: "synthetic-new-access-token", expires_in: 3600, scope: UPLOAD_SCOPE }, httpStatus: 200,
    networkError: false, changeConnectionAfterResponse: false, authCalls: 0 };
  const refresh = encryptYouTubeToken("synthetic-original-refresh-token", KEY);
  ctx.secret = { channel_id: target.channel, connection_status: "connected", scopes: [...ctx.row.scopes],
    encrypted_refresh_token: refresh.encryptedToken, refresh_iv: refresh.iv, refresh_auth_tag: refresh.authTag,
    encrypted_access_token: null, access_token_expires_at: ctx.row.access_token_expires_at };
  ctx.userDb = { auth: { async getUser() { ctx.authCalls++; return { data: { user: ctx.user }, error: null }; } },
    from(table) {
      assert.equal(table, "youtube_connections"); const filters = {};
      return { select() { return this; }, eq(k, v) { filters[k] = v; return this; }, async maybeSingle() {
        return { data: ctx.user?.id === filters.owner_user_id && ctx.row.owner_user_id === filters.owner_user_id
          && ctx.row.id === filters.id ? structuredClone(ctx.row) : null, error: null };
      } };
    } };
  ctx.adminDb = {
    from(table) {
      assert.equal(table, "youtube_oauth_states"); return { async insert(row) {
        assert.equal(row.owner_user_id, target.owner); assert.equal(row.state_hash, DIAGNOSTIC_MARKER);
        assert.ok(row.consumed_at); assert.equal(Date.parse(row.expires_at), target.expiresAt);
        if (ctx.marker) return { error: { code: "23505" } };
        ctx.marker = true; return { error: ctx.claimError };
      } };
    },
    rpc(name, args) {
      assert.equal(args.p_owner_user_id, target.owner);
      if (name === "get_youtube_connection_secret") return { async maybeSingle() { return { data: ctx.secret, error: null }; } };
      // Like PostgREST, do not execute a mutation until the request is awaited.
      return { then(resolve, reject) { return Promise.resolve().then(() => {
        if (name === "update_youtube_access_token") {
          if (ctx.persistError) return { data: false, error: { message: "synthetic storage error" } };
          ctx.persisted++; ctx.row.access_token_expires_at = args.p_access_token_expires_at;
          ctx.saved = args;
          return { data: true, error: null };
        }
        assert.equal(name, "set_youtube_connection_status"); assert.equal(args.p_status, "revoked");
        ctx.statusWrites++; ctx.row.status = "revoked"; return { data: true, error: null };
      }).then(resolve, reject); } };
    },
  };
  globalThis.__youtubeDiagnostic = ctx;
  globalThis.fetch = async (url, init) => {
    ctx.network++;
    assert.equal(url, "https://oauth2.googleapis.com/token"); assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error"); assert.equal(init.body.get("grant_type"), "refresh_token");
    assert.equal(init.body.get("refresh_token"), "synthetic-original-refresh-token");
    assert.equal(init.body.get("scope"), null, "never request additional permissions");
    if (ctx.networkError) throw new Error("synthetic network failure containing synthetic-client-secret");
    if (ctx.changeConnectionAfterResponse) ctx.row.channel_id = "different-channel";
    return Response.json(ctx.response, { status: ctx.httpStatus });
  };
  try { await fn(ctx); }
  finally {
    for (const [k,v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    globalThis.fetch = oldFetch; Date.now = oldNow; delete globalThis.__youtubeDiagnostic;
  }
}

test("actual owner refreshes once through existing encrypted storage; response contains no secrets", () => run(async c => {
  const originalRefreshCiphertext = c.secret.encrypted_refresh_token;
  const response = await POST(request()); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.outcome, "refreshed"); assert.equal(body.uploadPermission, true);
  assert.equal(body.scopeEvidence, "refresh_response"); assert.equal(c.network, 1); assert.equal(c.persisted, 1);
  assert.equal(decryptYouTubeToken({ encryptedToken: c.saved.p_encrypted_access_token, iv: c.saved.p_access_iv,
    authTag: c.saved.p_access_auth_tag }, KEY), "synthetic-new-access-token");
  assert.equal(c.secret.encrypted_refresh_token, originalRefreshCiphertext);
  const serialized = JSON.stringify(body);
  for (const secret of [KEY, "synthetic-client-secret", "synthetic-original-refresh-token", "synthetic-new-access-token"]) assert.ok(!serialized.includes(secret));
  assert.equal(response.headers.get("cache-control"), "no-store, private");
}));
test("signed-out users cannot reach the privileged vault", () => run(async c => {
  c.user = null; assert.equal((await POST(request())).status, 401); assert.equal(c.adminCalls, 0); assert.equal(c.network, 0);
}));
test("another user, including a project administrator, cannot impersonate the owner", () => run(async c => {
  c.user = { id: "adb9478f-c363-4063-bbd8-5cf21aee3c94", email: target.email };
  assert.equal((await POST(request())).status, 403); assert.equal(c.adminCalls, 0);
}));
test("owner ID with the wrong verified email is refused", () => run(async c => {
  c.user.email = "someone-else@example.test"; assert.equal((await POST(request())).status, 403); assert.equal(c.adminCalls, 0);
}));
test("the actual owner's RLS lookup cannot cross to another owner's connection", () => run(async c => {
  c.row.owner_user_id = "11111111-1111-4111-8111-111111111111";
  assert.equal((await POST(request())).status, 409); assert.equal(c.adminCalls, 0);
}));
test("GET cannot refresh or consume the diagnostic", () => run(async c => {
  assert.equal((await POST(request({ method: "GET" }))).status, 405);
  assert.equal(c.authCalls, 0); assert.equal(c.marker, false); assert.equal(c.network, 0);
}));
test("cross-site/missing Origin and arbitrary account selectors are refused", () => run(async c => {
  for (const origin of ["https://evil.example", "null", ""]) assert.equal((await POST(request({ origin }))).status, 403);
  assert.equal((await POST(request({ body: { confirm: target.confirmation, owner: target.owner } }))).status, 400);
  assert.equal(c.network, 0); assert.equal(c.adminCalls, 0);
}));
test("Preview, wrong database and expired diagnostic cannot run", () => run(async c => {
  process.env.VERCEL_ENV = "preview"; assert.equal((await POST(request())).status, 404);
  process.env.VERCEL_ENV = "production"; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://staging.example";
  assert.equal((await POST(request())).status, 404); process.env.NEXT_PUBLIC_SUPABASE_URL = target.project;
  Date.now = () => target.expiresAt; assert.equal((await POST(request())).status, 404); assert.equal(c.authCalls, 0);
}));
test("changed channel or reconnected identity is refused before any request", () => run(async c => {
  c.row.channel_handle = "@different"; assert.equal((await POST(request())).status, 409);
  c.row = fixture(); c.row.connected_at = new Date(NOW).toISOString(); assert.equal((await POST(request())).status, 409);
  assert.equal(c.adminCalls, 0);
}));
test("missing configuration or upload scope makes zero refresh calls", () => run(async c => {
  delete process.env.GOOGLE_CLIENT_SECRET; assert.equal((await POST(request())).status, 503);
  process.env.GOOGLE_CLIENT_SECRET = "synthetic-client-secret"; c.row.scopes = [];
  assert.equal((await POST(request())).status, 409); assert.equal(c.network, 0);
}));
test("fresh credentials are not forcibly expired or refreshed", () => run(async c => {
  c.row.access_token_expires_at = new Date(NOW + 3600_000).toISOString();
  const body = await (await POST(request())).json(); assert.equal(body.outcome, "already_current"); assert.equal(c.adminCalls, 0);
}));
test("parallel clicks and workflow restarts never create a second Google request", () => run(async c => {
  const responses = await Promise.all([POST(request()), POST(request())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal(c.network, 1);
  c.row.access_token_expires_at = "2026-09-21T14:48:35Z";
  assert.equal((await POST(request())).status, 409); assert.equal(c.network, 1);
}));
test("uncertain claim does not authorize Google; its consumed marker prevents retry", () => run(async c => {
  c.claimError = { code: "57014" }; assert.equal((await POST(request())).status, 503);
  c.claimError = null; assert.equal((await POST(request())).status, 409); assert.equal(c.network, 0);
}));
test("invalid_grant reports reconnect and existing logic marks only this connection revoked", () => run(async c => {
  c.httpStatus = 400; c.response = { error: "invalid_grant", error_description: "synthetic sensitive detail" };
  const body = await (await POST(request())).json(); assert.equal(body.outcome, "reconnect_required"); assert.equal(body.reconnectionRequired, true);
  assert.equal(c.row.status, "revoked"); assert.equal(c.statusWrites, 1); assert.equal(c.persisted, 0); assert.equal(c.network, 1);
  assert.ok(!JSON.stringify(body).includes("sensitive detail"));
}));
test("invalid client is not falsely diagnosed as an expired refresh token", () => run(async c => {
  c.httpStatus = 401; c.response = { error: "invalid_client" };
  const body = await (await POST(request())).json(); assert.equal(body.reconnectionRequired, null); assert.equal(body.providerError, "invalid_client");
  assert.equal(c.row.status, "connected"); assert.equal(c.network, 1);
}));
test("network ambiguity cannot trigger a second submission", () => run(async c => {
  c.networkError = true; const body = await (await POST(request())).json(); assert.equal(body.outcome, "refresh_unconfirmed");
  assert.equal((await POST(request())).status, 409); assert.equal(c.network, 1);
}));
test("failed persistence is detected instead of claiming a successful stored refresh", () => run(async c => {
  c.persistError = true; const response = await POST(request()); assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, "storage_unconfirmed"); assert.equal(c.network, 1);
  assert.equal((await POST(request())).status, 409); assert.equal(c.network, 1);
}));
test("connection changes observed before persistence cannot overwrite replacement credentials", () => run(async c => {
  c.changeConnectionAfterResponse = true;
  assert.equal((await POST(request())).status, 503); assert.equal(c.persisted, 0); assert.equal(c.network, 1);
}));
test("omitted response scopes are not invented: the existing grant is identified explicitly", () => run(async c => {
  delete c.response.scope; const body = await (await POST(request())).json();
  assert.equal(body.outcome, "refreshed"); assert.equal(body.scopeEvidence, "existing_grant");
}));
test("an actual missing upload grant is not reported as ready", () => run(async c => {
  c.response.scope = "https://www.googleapis.com/auth/youtube.readonly";
  const body = await (await POST(request())).json(); assert.equal(body.outcome, "upload_permission_missing"); assert.equal(body.reconnectionRequired, true);
}));
test("server-only marker uses the existing real PostgreSQL unique index and cannot be reset by browser roles", async () => {
  const { db } = await createSupabaseLite();
  try {
    await db.query("insert into auth.users(id,email) values($1,$2)", [target.owner, target.email]);
    const insert = () => db.query("insert into public.youtube_oauth_states(state_hash,owner_user_id,consumed_at,expires_at) values($1,$2,now(),$3)",
      [DIAGNOSTIC_MARKER, target.owner, new Date(target.expiresAt).toISOString()]);
    const results = await Promise.allSettled([insert(), insert()]); assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    for (const role of ["anon", "authenticated"]) {
      for (const action of ["delete from public.youtube_oauth_states", "update public.youtube_oauth_states set consumed_at=null"]) {
        await assert.rejects(db.exec(`begin;set local role ${role};${action};rollback;`), /permission denied/i);
        await db.exec("rollback");
      }
    }
    assert.equal((await db.query("select count(*)::int n from public.youtube_oauth_states")).rows[0].n, 1);
  } finally { await db.close(); }
});
test("temporary route exposes no GET, cron, admin secret or publishing entry point", async () => {
  const source = await readFile(new URL("../app/api/integrations/youtube/refresh-diagnostic/route.ts", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/export async function (\w+)/g)].map(m => m[1]), ["POST"]);
  const server = await readFile(new URL("../lib/youtube/refresh-diagnostic-server.ts", import.meta.url), "utf8");
  assert.ok(!/runYouTubePublishing|runYouTubeReconciliation|CRON_SECRET|videos\/insert|upload\/youtube/.test(server));
});
