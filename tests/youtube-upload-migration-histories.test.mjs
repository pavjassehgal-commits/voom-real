/**
 * Migration 0066 against the schema histories it must apply to, in embedded
 * PostgreSQL. Main is covered by the other suites; here:
 *
 *  - Production-compatible drift: the generic media size check has a
 *    different name and a smaller (4 MiB) limit than main's 20 MiB.
 *  - Staging: the TikTok sandbox's 0060 (50 MB check renamed
 *    post_draft_assets_byte_size_limit plus a 20 MB non-TikTok trigger),
 *    applied from a verbatim copy whose hash matches what staging recorded.
 *
 * 0066 must keep each history's own limits for every other upload, allow only
 * native YouTube paths up to 256 MiB, stop on anything unexpected, and roll
 * back to exactly what was there without touching existing rows.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSupabaseLite, migrationSql } from "./helpers/pglite-supabase.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MIB = 1024 * 1024;
const STAGING_0060 = new URL("./fixtures/staging-0060_tiktok_video_upload_50mb.sql", import.meta.url);
const ROLLBACK = new URL("../supabase/rollbacks/0066_youtube_resumable_uploads.sql", import.meta.url);

async function history(prepare) {
  const local = await createSupabaseLite({ stopBefore: "0066" });
  const sql = async (s, args = []) => (await local.db.query(s, args)).rows;
  await sql("insert into auth.users(id) values($1),($2)", [A, B]);
  const [conversation] = await sql("insert into mara_conversations(owner_user_id) values($1) returning id", [A]);
  const draft = async (kind, owner = A) => {
    const social = kind === "youtube_video" ? ["youtube", "youtube", "video"] : kind === "youtube_short" ? ["youtube", "youtube", "short"] : kind === "tiktok_video" ? ["tiktok", "tiktok", "video"] : ["Instagram", null, null];
    const conv = owner === A ? conversation.id : (await sql("insert into mara_conversations(owner_user_id) values($1) returning id", [owner]))[0].id;
    const [row] = await sql("insert into mara_drafts(owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content) values($1,$2,$3,$4,$5,$6,'T','C') returning id", [owner, conv, kind, ...social]);
    return row.id;
  };
  // Attempt one asset row (autocommit: a refused insert leaves no trace).
  const asset = async ({ kind, path, mime = "video/mp4", bytes, owner = A }) => {
    const id = await draft(kind, owner);
    const storagePath = path === "youtube" ? `${owner}/youtube-uploads/${randomUUID()}.mp4` : path === "foreign-youtube" ? `${B}/youtube-uploads/${randomUUID()}.mp4` : `${owner}/post-assets/${randomUUID().slice(0, 16)}-${id}.mp4`;
    try {
      await sql("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'x',$4,$5,'uploaded_existing','uploaded')", [owner, id, storagePath, mime, bytes]);
      return "accepted";
    } catch (error) {
      return error.message.includes("too_large") ? "rejected:trigger" : "rejected:check";
    }
  };
  const sizeChecks = async () => sql("select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.post_draft_assets'::regclass and contype='c' and pg_get_constraintdef(oid) ~ 'byte_size' order by conname");
  const triggerSource = async () => (await sql("select prosrc from pg_proc where oid = to_regprocedure('public.enforce_post_draft_asset_size()')"))[0]?.prosrc ?? null;
  const assets = async () => sql("select to_jsonb(a) - 'updated_at' row from post_draft_assets a order by storage_path");
  const ctx = { local, sql, draft, asset, sizeChecks, triggerSource, assets };
  await prepare?.(ctx);
  return ctx;
}

test("the staging 0060 fixture is byte-identical to the migration recorded on staging", async () => {
  const hash = createHash("sha256").update(await readFile(STAGING_0060)).digest("hex");
  assert.equal(hash, "37b41b73d3715b951de4ddcffbc2e815da9399f25a749cc0f37d9ea102c392ae");
});

test("Production-compatible drift: other media keep their 4 MiB limit and the check keeps its name; YouTube native paths reach 256 MiB", async () => {
  const c = await history(async ({ sql, draft }) => {
    // Production's drifted shape: a differently named, smaller generic check.
    const [{ conname }] = await sql("select conname from pg_constraint where conrelid='public.post_draft_assets'::regclass and contype='c' and pg_get_constraintdef(oid) ~ 'byte_size'");
    await sql(`alter table post_draft_assets drop constraint ${conname}`);
    await sql("alter table post_draft_assets add constraint post_draft_assets_size_prod check (byte_size between 1 and 4194304)");
    const ig = await draft("instagram_post");
    await sql("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'existing.png','image/png',3000000,'uploaded_asset','uploaded')", [A, ig, `${A}/post-assets/existing.png`]);
  });
  try {
    const before = await c.assets(), checksBefore = await c.sizeChecks();
    await c.local.db.exec(migrationSql("0066_youtube_resumable_uploads.sql"));
    const checks = await c.sizeChecks();
    assert.deepEqual(checks.map((r) => r.conname), ["post_draft_assets_size_prod"], "one size check, same name");
    assert.match(checks[0].def, /byte_size <= 4194304\)\) OR/, "generic limit stays 4 MiB");
    assert.equal(await c.triggerSource(), null, "no TikTok trigger is created where 0060 never ran");
    assert.deepEqual(await c.assets(), before, "existing rows untouched");

    assert.equal(await c.asset({ kind: "instagram_post", path: "legacy", mime: "image/png", bytes: 5 * MIB }), "rejected:check", "Instagram stays at 4 MiB");
    assert.equal(await c.asset({ kind: "youtube_video", path: "legacy", bytes: 5 * MIB }), "rejected:check", "legacy YouTube path stays at 4 MiB");
    assert.equal(await c.asset({ kind: "youtube_video", path: "youtube", bytes: 256 * MIB }), "accepted", "native YouTube path at exactly 256 MiB");
    assert.equal(await c.asset({ kind: "youtube_video", path: "youtube", bytes: 256 * MIB + 1 }), "rejected:check", "256 MiB + 1 byte");
    assert.equal(await c.asset({ kind: "youtube_video", path: "youtube", mime: "video/quicktime", bytes: 5 * MIB }), "rejected:check", "only MP4");

    // Rollback refuses while a native upload exists, then restores exactly.
    const [yt] = await c.sql("select storage_path from post_draft_assets where storage_path ~ 'youtube-uploads'");
    assert.ok(yt);
    const rollback = await readFile(ROLLBACK, "utf8");
    await assert.rejects(c.local.db.exec(rollback), /youtube_upload_rollback_data_present/);
    await c.local.db.exec("rollback");
    await c.sql("delete from post_draft_assets where storage_path ~ 'youtube-uploads'");
    await c.local.db.exec(rollback);
    assert.deepEqual(await c.sizeChecks(), checksBefore, "original name and 4 MiB definition restored");
    assert.deepEqual(await c.assets(), before, "existing rows intact after rollback");
  } finally { await c.local.db.close(); }
});

test("Staging (0060): TikTok keeps 50 MB, other platforms keep 20 MB, YouTube native paths reach 256 MiB only on the owner's YouTube drafts", async () => {
  let original;
  const c = await history(async ({ local, sql, draft, triggerSource }) => {
    await local.db.exec(await readFile(STAGING_0060, "utf8"));
    original = await triggerSource();
    const tt = await draft("tiktok_video"), ig = await draft("instagram_post");
    await sql("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'tiktok.mp4','video/mp4',31457280,'uploaded_asset','uploaded'),($1,$4,$5,'post.png','image/png',10485760,'uploaded_asset','uploaded')", [A, tt, `${A}/post-assets/tiktok.mp4`, ig, `${A}/post-assets/post.png`]);
  });
  try {
    const before = await c.assets(), checksBefore = await c.sizeChecks();
    assert.deepEqual(checksBefore.map((r) => r.conname), ["post_draft_assets_byte_size_limit"]);
    await c.local.db.exec(migrationSql("0066_youtube_resumable_uploads.sql"));
    const checks = await c.sizeChecks();
    assert.deepEqual(checks.map((r) => r.conname), ["post_draft_assets_byte_size_limit"], "0060's name kept, so 0060's own rollback still finds it");
    assert.match(checks[0].def, /byte_size <= 52428800\)\) OR/, "generic limit stays 50 MB");
    assert.deepEqual(await c.assets(), before, "existing rows untouched");

    // TikTok: unchanged.
    assert.equal(await c.asset({ kind: "tiktok_video", path: "legacy", bytes: 40 * MIB }), "accepted", "TikTok MP4 up to 50 MB");
    assert.equal(await c.asset({ kind: "tiktok_video", path: "legacy", bytes: 51 * MIB }), "rejected:check", "TikTok above 50 MB");
    assert.equal(await c.asset({ kind: "tiktok_video", path: "legacy", mime: "image/png", bytes: 30 * MIB }), "rejected:trigger", "TikTok non-MP4 above 20 MB");
    // Other platforms: still 20 MB.
    assert.equal(await c.asset({ kind: "instagram_post", path: "legacy", bytes: 30 * MIB }), "rejected:trigger", "Instagram above 20 MB");
    assert.equal(await c.asset({ kind: "instagram_post", path: "legacy", mime: "image/png", bytes: 19 * MIB }), "accepted", "Instagram within 20 MB");
    assert.equal(await c.asset({ kind: "youtube_video", path: "legacy", bytes: 30 * MIB }), "rejected:trigger", "legacy YouTube path above 20 MB");
    // Native YouTube paths: only on the owner's own YouTube drafts.
    assert.equal(await c.asset({ kind: "youtube_video", path: "youtube", bytes: 256 * MIB }), "accepted", "YouTube video at 256 MiB");
    assert.equal(await c.asset({ kind: "youtube_short", path: "youtube", bytes: 100 * MIB }), "accepted", "YouTube Short");
    assert.match(await c.asset({ kind: "youtube_video", path: "youtube", bytes: 256 * MIB + 1 }), /^rejected:/, "256 MiB + 1 byte");
    assert.equal(await c.asset({ kind: "tiktok_video", path: "youtube", bytes: 60 * MIB }), "rejected:trigger", "a YouTube path cannot lift TikTok above 50 MB");
    assert.equal(await c.asset({ kind: "instagram_post", path: "youtube", bytes: 30 * MIB }), "rejected:trigger", "a YouTube path cannot lift Instagram");
    assert.equal(await c.asset({ kind: "youtube_video", path: "foreign-youtube", bytes: 30 * MIB }), "rejected:trigger", "another owner's path is refused");

    // Rollback restores 0060's exact trigger body and check.
    await c.sql("delete from post_draft_assets where storage_path ~ 'youtube-uploads'");
    await c.local.db.exec(await readFile(ROLLBACK, "utf8"));
    assert.equal(await c.triggerSource(), original, "0060 trigger body restored byte-for-byte");
    assert.deepEqual(await c.sizeChecks(), checksBefore, "0060's 50 MB check restored under its name");
    assert.equal(await c.asset({ kind: "tiktok_video", path: "legacy", bytes: 40 * MIB }), "accepted", "TikTok still 50 MB after rollback");
    assert.equal(await c.asset({ kind: "instagram_post", path: "legacy", bytes: 30 * MIB }), "rejected:trigger");
    const remaining = (await c.assets()).filter((r) => before.some((b) => b.row.storage_path === r.row.storage_path));
    assert.deepEqual(remaining, before, "pre-existing rows intact after rollback");
  } finally { await c.local.db.close(); }
});

test("0066 stops, changing nothing, when the size check or the staging trigger is not the reviewed shape", async () => {
  // A size check that also constrains something else is never dropped.
  const combined = await history(async ({ sql }) => {
    const [{ conname }] = await sql("select conname from pg_constraint where conrelid='public.post_draft_assets'::regclass and contype='c' and pg_get_constraintdef(oid) ~ 'byte_size'");
    await sql(`alter table post_draft_assets drop constraint ${conname}`);
    await sql("alter table post_draft_assets add constraint size_and_mime check (byte_size between 1 and 20971520 and mime_type <> 'image/gif')");
  });
  try {
    await assert.rejects(combined.local.db.exec(migrationSql("0066_youtube_resumable_uploads.sql")), /youtube_upload_unexpected_size_check: size_and_mime/);
    await combined.local.db.exec("rollback");
    assert.deepEqual((await combined.sizeChecks()).map((r) => r.conname), ["size_and_mime"]);
    assert.equal((await combined.sql("select to_regclass('public.youtube_upload_sessions') t"))[0].t, null, "nothing was applied");
  } finally { await combined.local.db.close(); }

  // A locally altered TikTok trigger is never overwritten.
  const altered = await history(async ({ local, sql }) => {
    await local.db.exec(await readFile(STAGING_0060, "utf8"));
    await sql("create or replace function public.enforce_post_draft_asset_size() returns trigger language plpgsql set search_path='' as $$begin return new; end;$$");
  });
  try {
    await assert.rejects(altered.local.db.exec(migrationSql("0066_youtube_resumable_uploads.sql")), /youtube_upload_unexpected_size_trigger/);
    await altered.local.db.exec("rollback");
    assert.equal(await altered.triggerSource(), "begin return new; end;");
    assert.equal((await altered.sql("select count(*)::int n from storage.buckets where id='youtube-uploads'"))[0].n, 0, "nothing was applied");
  } finally { await altered.local.db.close(); }
});
