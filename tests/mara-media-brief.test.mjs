import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const sqlStatements = (sql) => sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const core = await import("../lib/post/core.ts");

// ---------------------------------------------------------------------------
// Migration 0026: persisted brief for Post/Reel/Story media generation
// ---------------------------------------------------------------------------

test("migration 0026 adds media_brief to mara_drafts with 800-char limit", async () => {
  const files = await readdir(new URL("supabase/migrations/", root));
  assert.ok(files.includes("0026_mara_media_brief.sql"), "0026 must be checked in");
  assert.deepEqual(files.filter((name) => /^0026_/.test(name)), ["0026_mara_media_brief.sql"], "the only 0026 is MARA media brief");

  const sql = await read("supabase/migrations/0026_mara_media_brief.sql");
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.match(sql, /alter table public\.mara_drafts/i);
  assert.match(sql, /add column if not exists media_brief/i);
  assert.match(sql, /char_length\(media_brief\) <= 800/i);
  // No other table touched, no RLS/policy/grant/drop
  const statements = sqlStatements(sql);
  assert.doesNotMatch(statements, /alter table public\.(post_draft_assets|mara_media_generations|contacts|audiences)/i);
  assert.doesNotMatch(statements, /\bdrop (table|policy|trigger)\b/i);
  assert.doesNotMatch(statements, /\bgrant\b/i);
  assert.doesNotMatch(statements, /row level security/i);
});

test("0026 is additive and nothing beyond 0026 exists", async () => {
  const files = await readdir(new URL("supabase/migrations/", root));
  assert.deepEqual(files.filter((name) => /^0022_/.test(name)), ["0022_instagram_auto_publishing.sql"]);
  assert.deepEqual(files.filter((name) => /^0023_/.test(name)), ["0023_instagram_token_key_rotation.sql"]);
  assert.deepEqual(files.filter((name) => /^0024_/.test(name)), ["0024_instagram_story_publishing.sql"]);
  assert.deepEqual(files.filter((name) => /^0025_/.test(name)), ["0025_mara_media_video_generation.sql"]);
  const numbered = files.filter((name) => /^\d{4}_/.test(name));
  assert.ok(numbered.every((name) => Number(name.slice(0, 4)) <= 26), "no migration beyond 0026 may exist");
});

// ---------------------------------------------------------------------------
// Server data: DRAFT_COLUMNS, PostView, normalizeMediaBrief, persistence
// ---------------------------------------------------------------------------

test("server-data selects media_brief and exposes it on PostView", async () => {
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /DRAFT_COLUMNS = ".*media_brief"/, "DRAFT_COLUMNS must include media_brief");
  assert.match(data, /mediaBrief: string;/, "PostView must include mediaBrief");
  assert.match(data, /export function normalizeMediaBrief/);
  // toPostView reads it
  assert.match(data, /mediaBriefRaw = typeof draft\.media_brief === "string"/);
  assert.match(data, /mediaBrief: mediaBriefRaw\.slice\(0, 800\)/);
});

test("normalizeMediaBrief trims, slices to 800, and returns null for empty", async () => {
  const { normalizeMediaBrief } = await import("../lib/post/server-data.ts");
  assert.equal(normalizeMediaBrief(""), null);
  assert.equal(normalizeMediaBrief("   "), null);
  assert.equal(normalizeMediaBrief(null), null);
  assert.equal(normalizeMediaBrief(undefined), null);
  assert.equal(normalizeMediaBrief("  Summer swimwear  "), "Summer swimwear");
  const long = "a".repeat(1000);
  const normalized = normalizeMediaBrief(long);
  assert.ok(normalized);
  assert.equal(normalized.length, 800);
});

test("savePostDraft persists mediaBrief on the draft", async () => {
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /mediaBrief\?: string \| null/);
  assert.match(data, /if \(input\.mediaBrief !== undefined\)/);
  assert.match(data, /patch\.media_brief = normalized/);
  assert.match(data, /normalizeMediaBrief\(input\.mediaBrief\)/);
});

// ---------------------------------------------------------------------------
// API routes persist brief and reuse persisted brief
// ---------------------------------------------------------------------------

test("PATCH /api/posts/[id] accepts brief/mediaBrief and saves it", async () => {
  const route = await read("app/api/posts/[id]/route.ts");
  assert.match(route, /normalizeMediaBrief/);
  assert.match(route, /brief.*mediaBrief|mediaBrief.*brief/);
  assert.match(route, /mediaBrief/);
  assert.match(route, /savePostDraft.*mediaBrief/);
});

test("POST /api/posts/[id]/generate persists brief and reuses persisted brief", async () => {
  const route = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(route, /What should MARA create\?/);
  assert.match(route, /briefInput/);
  assert.match(route, /effectiveBrief/);
  assert.match(route, /media_brief/);
  assert.match(route, /normalizeMediaBrief/);
  assert.match(route, /post\.mediaBrief/);
  // Must still enforce format truthfulness
  assert.match(route, /const format = post\.kind === "story" \? "9:16" : post\.format;/);
});

test("POST /api/posts/[id]/generation regenerate uses persisted brief", async () => {
  const route = await read("app/api/posts/[id]/generation/route.ts");
  assert.match(route, /What should MARA create\?/);
  assert.match(route, /mediaBrief/);
  assert.match(route, /effectiveBrief = post\.mediaBrief/);
  assert.match(route, /normalizeMediaBrief/);
  assert.match(route, /media_brief/);
});

// ---------------------------------------------------------------------------
// UI: PostEditorModal shows persisted brief field
// ---------------------------------------------------------------------------

test("PostEditorModal shows What should MARA create field and persists it", async () => {
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /What should MARA create\?/);
  assert.match(editor, /mediaBrief/);
  assert.match(editor, /setMediaBrief/);
  assert.match(editor, /maxLength=\{800\}/);
  assert.match(editor, /brief: mediaBrief/);
  assert.match(editor, /brief.*mediaBrief|mediaBrief.*brief/);
  // saveBody includes brief
  assert.match(editor, /brief: mediaBrief/);
  // startVideoJob includes brief
  assert.match(editor, /media: "video", brief: mediaBrief/);
  // applyPost loads it
  assert.match(editor, /setMediaBrief\(view\.mediaBrief/);
});

test("brief field is stored safely and never leaks secrets", async () => {
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.doesNotMatch(editor, /storage_path/);
  assert.doesNotMatch(editor, /MEDIA_API_KEY|AI_API_KEY|SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(editor, /createAdminClient|server-only/);

  const generate = await read("app/api/posts/[id]/generate/route.ts");
  assert.doesNotMatch(generate, /NEXT_PUBLIC_[A-Z_]*SECRET/);
  assert.doesNotMatch(generate, /instagram\.com|graph\.instagram/);
});

// ---------------------------------------------------------------------------
// Draft round-trip: brief survives reload
// ---------------------------------------------------------------------------

test("media_brief survives create -> save -> reload", () => {
  const draftRow = ({ media_brief = null, channel = "Instagram · 1:1" }) => ({
    id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
    kind: "instagram_post",
    channel,
    title: "Summer swimwear",
    content: "Summer is here.",
    proposed_publish_at: null,
    status: "draft",
    media_brief,
  });

  // Empty stays empty
  const empty = draftRow({ media_brief: null });
  assert.equal(empty.media_brief, null);

  // Brief persists
  const withBrief = draftRow({ media_brief: "Summer swimwear flat lay on sand, bright and family-friendly" });
  assert.equal(withBrief.media_brief, "Summer swimwear flat lay on sand, bright and family-friendly");

  // Format still works alongside brief
  assert.equal(core.decodeDraftFormat(withBrief.channel), "1:1");
  assert.equal(core.encodeDraftChannel("instagram_post", "4:5"), "Instagram · 4:5");
});

test("brief is limited to 800 chars in server helper and migration", async () => {
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /slice\(0, 800\)/);
  const migration = await read("supabase/migrations/0026_mara_media_brief.sql");
  assert.match(migration, /800/);
  const generate = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(generate, /slice\(0, 800\)/);
});
