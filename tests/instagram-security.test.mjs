import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Instagram credentials and token encryption key remain server-only", async () => {
  const example = await read(".env.example");
  for (const name of ["META_APP_ID", "META_APP_SECRET", "META_GRAPH_VERSION", "META_INSTAGRAM_REDIRECT_URI", "INSTAGRAM_TOKEN_ENCRYPTION_KEY"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"));
    assert.doesNotMatch(example, new RegExp(`NEXT_PUBLIC_${name}`));
  }
  const config = await read("lib/instagram/config.ts");
  assert.match(config, /import "server-only"/);
});

test("Instagram token and OAuth-state tables are service-role-only", async () => {
  const migration = await read("supabase/migrations/0004_instagram_integration.sql");
  assert.match(migration, /begin;[\s\S]*commit;/);
  for (const table of ["instagram_connections", "instagram_connection_secrets", "instagram_oauth_states"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /grant select on table public\.instagram_connections to authenticated/);
  assert.doesNotMatch(migration, /grant[^;]+instagram_connection_secrets[^;]+authenticated/i);
  assert.doesNotMatch(migration, /grant[^;]+instagram_oauth_states[^;]+authenticated/i);
  assert.match(migration, /No client policies are intentionally created/);
  assert.match(migration, /revoke all on function public\.save_instagram_connection[\s\S]+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.save_instagram_connection[\s\S]+to service_role/);
  assert.match(migration, /grant execute on function public\.disconnect_instagram_connection[\s\S]+to service_role/);
});

test("OAuth state is short-lived, one-time, hashed, and bound to an HTTP-only cookie", async () => {
  const data = await read("lib/instagram/data.ts");
  const connect = await read("app/api/integrations/instagram/connect/route.ts");
  const callback = await read("app/api/integrations/instagram/callback/route.ts");
  assert.match(data, /10 \* 60 \* 1000/);
  assert.match(data, /createHash\("sha256"\)/);
  assert.match(data, /timingSafeEqual/);
  assert.match(data, /\.is\("consumed_at", null\)\.gt\("expires_at", now\)/);
  assert.match(connect, /httpOnly: true/);
  assert.match(connect, /sameSite: "lax"/);
  assert.match(callback, /cookieStore\.delete\(STATE_COOKIE\)/);
});

test("tokens are encrypted before service-role storage and never returned by status", async () => {
  const crypto = await read("lib/instagram/crypto.ts");
  const data = await read("lib/instagram/data.ts");
  const status = await read("app/api/integrations/instagram/status/route.ts");
  assert.match(crypto, /aes-256-gcm/);
  assert.match(crypto, /getAuthTag/);
  assert.match(data, /encryptInstagramToken/);
  assert.match(data, /\.rpc\("save_instagram_connection"/);
  assert.match(data, /\.rpc\("disconnect_instagram_connection"/);
  assert.doesNotMatch(status, /access_token|encrypted_access_token|token_auth_tag/);
});

test("the credential-free phase contains no Instagram publishing endpoint", async () => {
  const client = await read("lib/instagram/client.ts");
  assert.doesNotMatch(client, /media_publish|\/media["'`]/);
  const tools = await read("lib/mara/tools.ts");
  assert.match(tools, /publishingAvailable: false/);
});
