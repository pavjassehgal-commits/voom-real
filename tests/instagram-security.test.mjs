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
  const serviceGrants = await read("supabase/migrations/0005_instagram_service_role_grants.sql");
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
  assert.match(serviceGrants, /grant select on table public\.instagram_connections to service_role/);
  assert.match(serviceGrants, /grant select, insert, update on table public\.instagram_oauth_states to service_role/);
  assert.match(serviceGrants, /revoke all on table public\.instagram_connection_secrets from service_role/);
  assert.doesNotMatch(serviceGrants, /grant[^;]+instagram_connection_secrets[^;]+service_role/i);
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

test("Instagram reads do not expose a publishing operation", async () => {
  const client = await read("lib/instagram/client.ts");
  assert.doesNotMatch(client, /media_publish/);
  const tools = await read("lib/mara/tools.ts");
  assert.match(tools, /publishingAvailable: false/);
});

test("long-lived token exchange uses Meta's unversioned access-token endpoint", async () => {
  const client = await read("lib/instagram/client.ts");
  assert.match(client, /new URL\("https:\/\/graph\.instagram\.com\/access_token"\)/);
  assert.doesNotMatch(client, /graph\.instagram\.com\/\$\{this\.config\.graphVersion\}\/access_token/);
  assert.match(client, /graph\.instagram\.com\/\$\{this\.config\.graphVersion\}\/me/);
  assert.match(client, /url\.searchParams\.set\("fields", "id,username"\)/);
});

test("Business Login authorization URL uses Meta's documented force_reauth parameter", async () => {
  const client = await read("lib/instagram/client.ts");
  assert.match(client, /url\.searchParams\.set\("force_reauth", "true"\)/);
  assert.doesNotMatch(client, /force_authentication/);
});

test("Instagram publishing and insights schema is owner-scoped and server-written", async () => {
  const migration = await read("supabase/migrations/0006_instagram_content_and_insights.sql");
  assert.match(migration, /begin;[\s\S]*commit;/);
  for (const table of ["instagram_media_assets", "instagram_insight_snapshots", "instagram_publish_jobs"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`${table}_select_own`));
  }
  assert.match(migration, /grant select on table[\s\S]+to authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete)[^;]+to authenticated/i);
  assert.match(migration, /unique \(owner_user_id, idempotency_key\)/);
  assert.match(migration, /values \('instagram-media', 'instagram-media', false/);
});

test("Instagram tokens can only be retrieved through a service-role function", async () => {
  const migration = await read("supabase/migrations/0007_instagram_server_token_access.sql");
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /revoke all on function public\.get_instagram_connection_secret\(uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_instagram_connection_secret\(uuid\) to service_role/);
});
