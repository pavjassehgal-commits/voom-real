import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const crypto = await import("../lib/instagram/crypto.ts");
const { InstagramTokenRefreshError, refreshInstagramLongLivedToken } = await import("../lib/instagram/token-refresh.ts");
const renewal = await import("../lib/instagram/token-renewal.ts");

const DAY = 86_400_000;
const KEY = { primary: "primary-instagram-key-000000000000000000", legacy: [] };
const OLD_TOKEN = "IGAA-synthetic-old-token";
const NEW_TOKEN = "IGAA-synthetic-renewed-token";

// ---------------------------------------------------------------------------
// Migration 0068 in a real PostgreSQL (PGlite) with every migration applied.
// ---------------------------------------------------------------------------

let db;
before(async () => { ({ db } = await createSupabaseLite()); });
after(() => db?.close());
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
let seq = 0;
const ownerId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

async function connect({ daysLeft = 13, connectedDaysAgo = 47, ciphertext = "cipher-old" } = {}) {
  const owner = ownerId();
  await q("insert into auth.users(id) values ($1)", [owner]);
  await q(`select public.save_instagram_connection($1::uuid, $2, 'synthetic_user', null, 'BUSINESS', null,
    array['instagram_business_basic','instagram_business_content_publish']::text[], $3::timestamptz, $4, 'iv-old', 'tag-old', 2::smallint)`,
  [owner, `ig-${seq}`, iso(daysLeft * DAY), ciphertext]);
  await q("update public.instagram_connections set connected_at = $2::timestamptz where owner_user_id = $1", [owner, iso(-connectedDaysAgo * DAY)]);
  return owner;
}
const claim = (limit = 50) => q("select * from public.claim_instagram_token_refreshes($1, '30 days', '10 minutes')", [limit]);
const claimFor = async (owner) => (await claim()).find((row) => row.owner_user_id === owner);
const state = async (owner) => (await q(`select c.status, c.token_expires_at, c.connected_at, s.encrypted_access_token, s.token_iv,
  s.key_version, s.token_refreshed_at, s.refresh_claim_id, s.refresh_failure_count, s.refresh_last_error, s.refresh_next_attempt_at
  from public.instagram_connections c join public.instagram_connection_secrets s on s.connection_id = c.id where c.owner_user_id = $1`, [owner]))[0];
const complete = (owner, row, { claimId = row.claim_id, connectedAt = row.connected_at, expiresAt = iso(60 * DAY), cipher = "cipher-new" } = {}) =>
  q(`select public.complete_instagram_token_refresh($1, $2, $3, $4, 'iv-new', 'tag-new', 2::smallint, $5::timestamptz) ok`,
    [owner, claimId, connectedAt, cipher, expiresAt]).then((rows) => rows[0].ok);
const fail = (owner, row, code, retryAt, status) =>
  q("select public.fail_instagram_token_refresh($1, $2, $3, $4, $5::timestamptz, $6) ok", [owner, row.claim_id, row.connected_at, code, retryAt, status]).then((rows) => rows[0].ok);

test("0068 claims only connected tokens that are due, at least a day old and not backing off", async () => {
  const due = await connect();
  const notDue = await connect({ daysLeft: 45 });
  const tooYoung = await connect({ daysLeft: 13, connectedDaysAgo: 0.1 });
  const lapsed = await connect({ daysLeft: -1 });
  const expired = await connect();
  await q("update public.instagram_connections set status = 'expired' where owner_user_id = $1", [expired]);
  const backingOff = await connect();
  await q("update public.instagram_connection_secrets set refresh_next_attempt_at = now() + interval '1 hour' where owner_user_id = $1", [backingOff]);

  const claimed = (await claim()).map((row) => row.owner_user_id);
  assert.ok(claimed.includes(due));
  for (const owner of [notDue, tooYoung, lapsed, expired, backingOff]) assert.ok(!claimed.includes(owner), owner);
  const row = (await state(due));
  assert.ok(row.refresh_claim_id, "claim recorded");
});

test("0068 never hands the same connection to two runs inside the lease, and re-offers an abandoned claim", async () => {
  const owner = await connect();
  const first = await claimFor(owner);
  assert.ok(first);
  assert.equal(await claimFor(owner), undefined, "an overlapping run gets nothing");
  await q("update public.instagram_connection_secrets set refresh_claimed_at = now() - interval '11 minutes' where owner_user_id = $1", [owner]);
  const again = await claimFor(owner);
  assert.ok(again);
  assert.notEqual(again.claim_id, first.claim_id);
  assert.equal(await complete(owner, first), false, "the abandoned claim can no longer write");
  assert.equal(await complete(owner, again), true);
});

test("0068 completion swaps token and expiry together and only for the current claim", async () => {
  const owner = await connect();
  const row = await claimFor(owner);
  assert.equal(await complete(owner, row, { claimId: "11111111-1111-4111-8111-111111111111" }), false);
  assert.equal((await state(owner)).encrypted_access_token, "cipher-old");

  const expiresAt = iso(60 * DAY);
  assert.equal(await complete(owner, row, { expiresAt }), true);
  const after = await state(owner);
  assert.equal(after.encrypted_access_token, "cipher-new");
  assert.equal(after.token_iv, "iv-new");
  assert.equal(new Date(after.token_expires_at).toISOString(), expiresAt);
  assert.equal(after.status, "connected");
  assert.equal(after.refresh_claim_id, null);
  assert.ok(after.token_refreshed_at);
  assert.equal(await claimFor(owner), undefined, "a renewed token is not due again");
});

test("0068 discards a renewal that raced a reconnect, keeping the reconnect's token", async () => {
  const owner = await connect();
  const row = await claimFor(owner);
  await q(`select public.save_instagram_connection($1::uuid, 'ig-reconnected', 'synthetic_user', null, 'BUSINESS', null,
    array['instagram_business_basic']::text[], now() + interval '60 days', 'cipher-reconnect', 'iv-r', 'tag-r', 2::smallint)`, [owner]);
  assert.equal(await complete(owner, row), false);
  assert.equal((await state(owner)).encrypted_access_token, "cipher-reconnect");
});

test("0068 rejects invalid renewal payloads without changing anything", async () => {
  const owner = await connect();
  const row = await claimFor(owner);
  await assert.rejects(complete(owner, row, { expiresAt: iso(-DAY) }), /instagram_refresh_expiry_invalid/);
  await assert.rejects(complete(owner, row, { expiresAt: iso(200 * DAY) }), /instagram_refresh_expiry_invalid/);
  await assert.rejects(complete(owner, row, { cipher: "" }), /instagram_secret_payload_invalid/);
  await assert.rejects(fail(owner, row, "not_a_code", iso(DAY), null), /refresh_last_error_check/);
  await assert.rejects(fail(owner, row, "unavailable", iso(DAY), "disconnected"), /instagram_refresh_status_invalid/);
  await assert.rejects(q("select * from public.claim_instagram_token_refreshes(500, '30 days', '10 minutes')"), /instagram_refresh_limit_invalid/);
  const unchanged = await state(owner);
  assert.equal(unchanged.encrypted_access_token, "cipher-old");
  assert.equal(unchanged.status, "connected");
});

test("0068 transient failure keeps the credential usable and backs off", async () => {
  const owner = await connect();
  const row = await claimFor(owner);
  assert.equal(await fail(owner, row, "unavailable", iso(6 * 3_600_000), null), true);
  const after = await state(owner);
  assert.equal(after.status, "connected");
  assert.equal(after.encrypted_access_token, "cipher-old");
  assert.equal(after.refresh_failure_count, 1);
  assert.equal(after.refresh_last_error, "unavailable");
  assert.equal(after.refresh_claim_id, null);
  assert.equal(await claimFor(owner), undefined, "not retried before the backoff");
});

test("0068 a rejected token marks the connection expired but keeps the stored ciphertext", async () => {
  const owner = await connect();
  const row = await claimFor(owner);
  assert.equal(await fail(owner, row, "token_invalid", null, "expired"), true);
  const after = await state(owner);
  assert.equal(after.status, "expired");
  assert.equal(after.encrypted_access_token, "cipher-old");
  assert.equal(after.refresh_next_attempt_at, null);
});

test("0068 marks only lapsed connected tokens expired", async () => {
  const lapsed = await connect({ daysLeft: -0.5 });
  const healthy = await connect({ daysLeft: 20 });
  const marked = (await q("select public.expire_lapsed_instagram_tokens() n"))[0].n;
  assert.ok(marked >= 1);
  assert.equal((await state(lapsed)).status, "expired");
  assert.equal((await state(healthy)).status, "connected");
});

test("0068 functions are service-role only and secrets stay unreadable to users", async () => {
  const fns = [
    "public.claim_instagram_token_refreshes(integer, interval, interval)",
    "public.complete_instagram_token_refresh(uuid, uuid, timestamptz, text, text, text, smallint, timestamptz)",
    "public.fail_instagram_token_refresh(uuid, uuid, timestamptz, text, timestamptz, text)",
    "public.expire_lapsed_instagram_tokens()",
  ];
  for (const fn of fns) {
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await q("select has_function_privilege($1, $2, 'execute') ok", [role, fn]))[0].ok, false, `${role} ${fn}`);
    }
    assert.equal((await q("select has_function_privilege('service_role', $1, 'execute') ok", [fn]))[0].ok, true, fn);
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal((await q("select has_table_privilege($1, 'public.instagram_connection_secrets', 'select') ok", [role]))[0].ok, false, role);
  }
});

test("0068 rollback removes only the renewal objects and keeps stored tokens", async () => {
  const local = await createSupabaseLite();
  const sql = async (s, args = []) => (await local.db.query(s, args)).rows;
  await sql("insert into auth.users(id) values ('99999999-9999-4999-8999-999999999999')");
  await sql(`select public.save_instagram_connection('99999999-9999-4999-8999-999999999999'::uuid, 'ig-r', 'synthetic_user', null, 'BUSINESS', null,
    array['instagram_business_basic']::text[], now() + interval '10 days', 'cipher-keep', 'iv', 'tag', 2::smallint)`);
  await local.db.exec(await read("supabase/rollbacks/0068_instagram_token_renewal.sql"));
  assert.equal((await sql("select count(*)::int n from pg_proc where proname in ('claim_instagram_token_refreshes','complete_instagram_token_refresh','fail_instagram_token_refresh','expire_lapsed_instagram_tokens')"))[0].n, 0);
  assert.equal((await sql("select count(*)::int n from information_schema.columns where table_name = 'instagram_connection_secrets' and column_name like 'refresh_%'"))[0].n, 0);
  assert.equal((await sql("select encrypted_access_token t from public.instagram_connection_secrets"))[0].t, "cipher-keep");
  await local.db.close();
});

// ---------------------------------------------------------------------------
// Renewal worker logic with a fake store and real encryption.
// ---------------------------------------------------------------------------

function fakeStore(claims) {
  const calls = { complete: [], fail: [], expireLapsed: 0 };
  return {
    calls,
    store: {
      async expireLapsed() { calls.expireLapsed += 1; return 2; },
      async claim(limit, days, lease) { calls.claimArgs = [limit, days, lease]; return claims; },
      async complete(claim, next, expiresAt) { calls.complete.push({ claim, next, expiresAt }); return calls.completeResult ?? true; },
      async fail(claim, code, retryAt, status) { calls.fail.push({ claim, code, retryAt, status }); return true; },
    },
  };
}
function claimRow(token = OLD_TOKEN) {
  const enc = crypto.encryptInstagramToken(token, KEY);
  return { ownerUserId: "owner-1", claimId: "claim-1", connectedAt: "2026-09-14T01:21:33.422327+00:00", tokenExpiresAt: "2026-11-13T01:21:32.782+00:00", encryptedToken: enc.encryptedToken, iv: enc.iv, authTag: enc.authTag };
}
const NOW = Date.parse("2026-10-31T00:00:00Z");

test("renewal success stores the re-encrypted token with Meta's new 60-day expiry", async () => {
  const { store, calls } = fakeStore([claimRow()]);
  const seen = [];
  const outcome = await renewal.renewInstagramTokens({ store, keyRing: KEY, now: () => NOW, refresh: async (token) => { seen.push(token); return { accessToken: NEW_TOKEN, expiresIn: 5_183_944 }; } });
  assert.deepEqual(seen, [OLD_TOKEN], "the decrypted stored token is what gets renewed");
  assert.deepEqual(calls.claimArgs, [renewal.RENEWAL_BATCH_LIMIT, 30, 10]);
  assert.equal(calls.complete.length, 1);
  const { next, expiresAt } = calls.complete[0];
  assert.equal(crypto.decryptInstagramToken(next, KEY), NEW_TOKEN);
  assert.equal(next.keyVersion, crypto.CURRENT_KEY_VERSION);
  assert.equal(expiresAt, new Date(NOW + 5_183_944_000).toISOString());
  assert.deepEqual(outcome, { lapsedMarkedExpired: 2, claimed: 1, renewed: 1, retrying: 0, reconnectRequired: 0, stale: 0, failed: 0, deferred: 0 });
  assert.ok(!JSON.stringify(outcome).includes("IGAA"), "no token in the result");
});

for (const [code, status, result] of [
  ["token_invalid", "expired", "reconnectRequired"],
  ["permission_missing", "revoked", "reconnectRequired"],
  ["rate_limited", null, "retrying"],
  ["unavailable", null, "retrying"],
  ["invalid_response", null, "retrying"],
]) {
  test(`renewal ${code} → ${status ?? "keep connected and retry"}`, async () => {
    const { store, calls } = fakeStore([claimRow()]);
    const outcome = await renewal.renewInstagramTokens({ store, keyRing: KEY, now: () => NOW, refresh: async () => { throw new InstagramTokenRefreshError(code); } });
    assert.equal(calls.complete.length, 0, "nothing stored");
    assert.equal(calls.fail.length, 1);
    assert.equal(calls.fail[0].code, code);
    assert.equal(calls.fail[0].status, status);
    if (status) assert.equal(calls.fail[0].retryAt, null);
    else assert.ok(Date.parse(calls.fail[0].retryAt) - NOW >= 6 * 3_600_000, "backs off at least 6 hours");
    assert.equal(outcome[result], 1);
  });
}

test("an unexpected refresh error never leaks its message and retries", async () => {
  const { store, calls } = fakeStore([claimRow()]);
  const outcome = await renewal.renewInstagramTokens({ store, keyRing: KEY, now: () => NOW, refresh: async (token) => { throw new Error(`boom ${token}`); } });
  assert.equal(calls.fail[0].code, "unavailable");
  assert.equal(calls.fail[0].status, null);
  assert.ok(!JSON.stringify({ outcome, calls: calls.fail.map(({ code, retryAt, status }) => ({ code, retryAt, status })) }).includes(OLD_TOKEN));
});

test("an undecryptable token is a key problem: Meta is not called and the owner is not told to reconnect", async () => {
  const other = { primary: "a-different-instagram-key-0000000000000000", legacy: [] };
  const { store, calls } = fakeStore([claimRow()]);
  let called = false;
  const outcome = await renewal.renewInstagramTokens({ store, keyRing: other, now: () => NOW, refresh: async () => { called = true; return { accessToken: NEW_TOKEN, expiresIn: 5_183_944 }; } });
  assert.equal(called, false);
  assert.equal(calls.fail[0].code, "decrypt_failed");
  assert.equal(calls.fail[0].status, null);
  assert.equal(outcome.retrying, 1);
});

test("a stale claim (reconnected meanwhile) is reported, and a store outage keeps the old credential", async () => {
  const stale = fakeStore([claimRow()]);
  stale.calls.completeResult = false;
  assert.equal((await renewal.renewInstagramTokens({ store: stale.store, keyRing: KEY, now: () => NOW, refresh: async () => ({ accessToken: NEW_TOKEN, expiresIn: 5_183_944 }) })).stale, 1);

  const down = fakeStore([claimRow()]);
  down.store.complete = async () => { throw new Error("db down"); };
  const outcome = await renewal.renewInstagramTokens({ store: down.store, keyRing: KEY, now: () => NOW, refresh: async () => ({ accessToken: NEW_TOKEN, expiresIn: 5_183_944 }) });
  assert.equal(outcome.failed, 1);
  assert.equal(down.calls.fail.length, 0, "no status change on a store outage");
});

test("the batch stops starting renewals once its time budget is spent", async () => {
  const { store } = fakeStore([claimRow(), claimRow(), claimRow()]);
  let t = NOW;
  const outcome = await renewal.renewInstagramTokens({ store, keyRing: KEY, now: () => t, refresh: async () => { t += renewal.RENEWAL_BUDGET_MS + 1; return { accessToken: NEW_TOKEN, expiresIn: 5_183_944 }; } });
  assert.equal(outcome.renewed, 1);
  assert.equal(outcome.deferred, 2);
});

// ---------------------------------------------------------------------------
// Meta request and error classification.
// ---------------------------------------------------------------------------

const respond = (status, body) => async (url) => { respond.last = String(url); return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); };

test("refreshInstagramLongLivedToken calls Meta's documented unversioned endpoint and returns only token + lifetime", async () => {
  assert.deepEqual(await refreshInstagramLongLivedToken(OLD_TOKEN, respond(200, { access_token: NEW_TOKEN, token_type: "bearer", expires_in: 5_183_944 })), { accessToken: NEW_TOKEN, expiresIn: 5_183_944 });
  const url = new URL(respond.last);
  assert.equal(url.origin + url.pathname, "https://graph.instagram.com/refresh_access_token");
  assert.equal(url.searchParams.get("grant_type"), "ig_refresh_token");
  assert.equal(url.searchParams.get("access_token"), OLD_TOKEN);
  assert.equal(url.searchParams.get("client_secret"), null, "the app secret is never sent");
});

for (const [status, body, code] of [
  [400, { error: { code: 190, type: "OAuthException", message: "Error validating access token" } }, "token_invalid"],
  [400, { error: { code: 10, message: "Application does not have permission" } }, "permission_missing"],
  [403, { error: { code: 200 } }, "permission_missing"],
  [400, { error: { code: 4 } }, "rate_limited"],
  [429, {}, "rate_limited"],
  [500, { error: { code: 2 } }, "unavailable"],
  [400, { error: { code: 100 } }, "invalid_response"],
  [200, { access_token: NEW_TOKEN, expires_in: 60 }, "invalid_response"],
  [200, { access_token: "", expires_in: 5_183_944 }, "invalid_response"],
  [200, { expires_in: 5_183_944 }, "invalid_response"],
]) {
  test(`refreshInstagramLongLivedToken classifies HTTP ${status} ${JSON.stringify(body).slice(0, 40)} as ${code}`, async () => {
    const error = await refreshInstagramLongLivedToken(OLD_TOKEN, respond(status, body)).then(() => null, (e) => e);
    assert.ok(error instanceof InstagramTokenRefreshError);
    assert.equal(error.code, code);
    assert.ok(!String(error.message).includes(OLD_TOKEN) && !String(error.stack).includes(OLD_TOKEN));
  });
}

test("a network failure is unavailable, never an exposed token", async () => {
  const error = await refreshInstagramLongLivedToken(OLD_TOKEN, async () => { throw new Error(`socket ${OLD_TOKEN}`); }).then(() => null, (e) => e);
  assert.equal(error.code, "unavailable");
  assert.ok(!String(error.message).includes(OLD_TOKEN));
});

// ---------------------------------------------------------------------------
// Worker route, schedule and secrecy guards.
// ---------------------------------------------------------------------------

const { handleInstagramTokenRenewalCron } = await import("../lib/instagram/token-renewal-cron.ts");
const SECRET = "synthetic-cron-secret-value";
const cronRequest = (header) => new Request("https://voom.today/api/cron/instagram-token-refresh", { headers: header ? { Authorization: header } : {} });
const COUNTS = { lapsedMarkedExpired: 0, claimed: 1, renewed: 1, retrying: 0, reconnectRequired: 0, stale: 0, failed: 0, deferred: 0 };

for (const environment of [undefined, "", "preview", "development", "Production"]) {
  test(`the HTTP renewal worker refuses VERCEL_ENV=${JSON.stringify(environment)} even with a valid CRON_SECRET`, async () => {
    let calls = 0;
    const response = await handleInstagramTokenRenewalCron(cronRequest(`Bearer ${SECRET}`), { environment, secret: SECRET, run: async () => { calls++; return COUNTS; } });
    assert.equal(response.status, 503);
    assert.equal(calls, 0, "no admin client, claim or Meta call");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Instagram token renewal is disabled outside Production." });
  });
}

test("in Production the worker still needs CRON_SECRET and the exact bearer", async () => {
  let calls = 0;
  const run = async () => { calls++; return COUNTS; };
  assert.equal((await handleInstagramTokenRenewalCron(cronRequest(`Bearer ${SECRET}`), { environment: "production", secret: undefined, run })).status, 503);
  for (const header of [undefined, "Bearer wrong", SECRET, `Basic ${SECRET}`, `Bearer ${SECRET}x`]) {
    assert.equal((await handleInstagramTokenRenewalCron(cronRequest(header), { environment: "production", secret: SECRET, run })).status, 401, String(header));
  }
  assert.equal(calls, 0);
});

test("in Production an authorized call runs once and returns counts only", async () => {
  let calls = 0;
  const response = await handleInstagramTokenRenewalCron(cronRequest(`Bearer ${SECRET}`), { environment: "production", secret: SECRET, run: async () => { calls++; return COUNTS; } });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), COUNTS);
});

test("in Production a missing Instagram config or a worker failure is a generic 503", async () => {
  const unconfigured = await handleInstagramTokenRenewalCron(cronRequest(`Bearer ${SECRET}`), { environment: "production", secret: SECRET, run: async () => null });
  assert.equal(unconfigured.status, 503);
  const failed = await handleInstagramTokenRenewalCron(cronRequest(`Bearer ${SECRET}`), { environment: "production", secret: SECRET, run: async () => { throw new Error(`db ${OLD_TOKEN}`); } });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes(OLD_TOKEN));
});

test("the route gates on VERCEL_ENV, builds the admin client only inside the authorized run, and stays off Vercel deployments for this branch", async () => {
  const [route, schedule, worker, vercel] = await Promise.all([
    read("app/api/cron/instagram-token-refresh/route.ts"),
    read("supabase/ops/schedule-workers.sql"),
    read("lib/instagram/token-renewal.ts"),
    read("vercel.json"),
  ]);
  assert.match(route, /environment: process\.env\.VERCEL_ENV,/);
  assert.match(route, /secret: process\.env\.CRON_SECRET,/);
  assert.ok(route.indexOf("run: async () =>") < route.indexOf("createAdminClient()"), "admin client only inside run");
  assert.equal((route.match(/createAdminClient\(\)/g) ?? []).length, 1);
  const {readWorkerSchedule,renderWorkerCommand}=await import('../supabase/ops/validate-worker-schedules.mjs');
  const scheduleConfig=readWorkerSchedule(schedule);
  const renewalJob=scheduleConfig.workers.find(worker=>worker.name==='voom-instagram-token-refresh-6h');
  assert.equal(renewalJob.schedule,'41 */6 * * *');
  assert.match(renderWorkerCommand(scheduleConfig,renewalJob),/net\.http_post/);
  assert.match(renderWorkerCommand(scheduleConfig,renewalJob),/vault\.decrypted_secrets/);
  assert.doesNotMatch(schedule,/voom_ops\.call_worker\s*\(/);
  const config = JSON.parse(vercel);
  assert.equal(config.git.deploymentEnabled["fix/instagram-token-renewal"], false, "no automatic Preview deployments that share the Production database");
  assert.ok(!(config.crons ?? []).some((cron) => cron.path.includes("instagram-token-refresh")), "scheduled by Supabase Cron, not Vercel");
  assert.doesNotMatch(worker, /console\.|logPublishTimeline/, "the worker never logs");
});

test("staging can exercise the renewal module directly without the HTTP gate", async () => {
  const { store, calls } = fakeStore([claimRow()]);
  const outcome = await renewal.renewInstagramTokens({ store, keyRing: KEY, now: () => NOW, refresh: async () => { throw new InstagramTokenRefreshError("token_invalid"); } });
  assert.equal(outcome.reconnectRequired, 1);
  assert.equal(calls.fail[0].status, "expired");
});
