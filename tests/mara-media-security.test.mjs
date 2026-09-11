import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("MARA media credentials remain server-only", async () => {
  const env = await read(".env.example");
  for (const name of ["MEDIA_PROVIDER", "MEDIA_API_KEY", "MEDIA_BASE_URL", "MEDIA_IMAGE_MODEL", "MEDIA_VIDEO_MODEL", "OPENROUTER_API_KEY"]) {
    assert.match(env, new RegExp(`^${name}=`, "m"));
    assert.doesNotMatch(env, new RegExp(`NEXT_PUBLIC_${name}`));
  }
  const client = await read("app/app/(shell)/mara/page.tsx");
  assert.doesNotMatch(client, /MEDIA_API_KEY|provider_job_id|storage_path/);
});

test("MARA media table and private bucket are owner-scoped and server-written", async () => {
  const sql = await read("supabase/migrations/0008_mara_media_generation.sql");
  assert.match(sql, /begin;[\s\S]*commit;/);
  assert.match(sql, /alter table public\.mara_media_generations enable row level security/);
  assert.match(sql, /create policy "mara_media_select_own"[\s\S]+auth\.uid\(\)[\s\S]+owner_user_id/);
  assert.match(sql, /revoke all on table public\.mara_media_generations from public, anon, authenticated/);
  assert.match(sql, /grant select \([\s\S]+\) on table public\.mara_media_generations to authenticated/);
  assert.doesNotMatch(sql.match(/grant select \([\s\S]+?\) on table public\.mara_media_generations to authenticated/)?.[0] ?? "", /provider_job_id|storage_path/);
  assert.match(sql, /values \([\s\S]*'mara-media'[\s\S]*false/);
  assert.match(sql, /unique \(owner_user_id, idempotency_key\)/);
});

test("media generation is authenticated, owner-checked, bounded and never publishes", async () => {
  const route = await read("app/api/mara/media/[id]/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /eq\("owner_user_id", user\.id\)/);
  assert.match(route, /MARA is generating media too quickly/);
  assert.match(route, /MEDIA_MONTHLY_SPEND_LIMIT_USD/);
  assert.doesNotMatch(route, /media_publish|instagram\.com|graph\.instagram/);
});
