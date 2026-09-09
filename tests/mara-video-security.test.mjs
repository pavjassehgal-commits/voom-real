/**
 * MARA video generation security:
 *
 *   - provider credentials are server-side only (env names, never bundled,
 *     never returned, never logged, never persisted on the job row),
 *   - the browser only ever sees the safe generation view,
 *   - storage is private and owner-scoped (owner-prefix guard on reads),
 *   - RLS/grants from 0008 stay in force: 0025 adds no client grants,
 *   - failures surface as safe, classified messages only.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const config = await import("../lib/media/video-config.ts");
const view = await import("../lib/mara/video-view.ts");

// ---------------------------------------------------------------------------
// .env.example: variable NAMES only, server-only
// ---------------------------------------------------------------------------

test(".env.example documents the video provider with names only, never values or NEXT_PUBLIC", async () => {
  const env = await read(".env.example");
  for (const name of ["VIDEO_PROVIDER", "VIDEO_API_KEY", "VIDEO_BASE_URL", "VIDEO_MODEL"]) {
    const line = env.split("\n").find((l) => l.startsWith(`${name}=`));
    assert.ok(line, `${name} must be documented`);
    assert.equal(line, `${name}=`, `${name} must carry no value in the example`);
    assert.doesNotMatch(env, new RegExp(`NEXT_PUBLIC_${name}`));
  }
});

// ---------------------------------------------------------------------------
// Configuration: secrets read server-side, fail closed
// ---------------------------------------------------------------------------

test("video config fails closed when no provider key is configured", () => {
  const bare = { ...process.env };
  for (const k of Object.keys(bare)) if (/^(VIDEO_|MEDIA_)/.test(k)) delete bare[k];
  assert.throws(() => config.getVideoConfig(bare), (e) => e.name === "MediaError" && e.code === "not_configured");
});

test("video config: explicit VIDEO_PROVIDER wins; gemini/openai fall back to the media key", () => {
  const env = (over) => ({ VIDEO_PROVIDER: undefined, VIDEO_API_KEY: undefined, ...process.env, ...over });
  const mh = config.getVideoConfig(env({ VIDEO_PROVIDER: "magic-hour", VIDEO_API_KEY: "sk-test" }));
  assert.equal(mh.provider, "magic-hour");
  assert.equal(mh.apiKey, "sk-test");
  assert.equal(mh.supportsImageToVideo, true);
  assert.match(mh.baseUrl, /^https:\/\//);

  const inherited = config.getVideoConfig(env({ MEDIA_PROVIDER: "gemini", MEDIA_API_KEY: "sk-media", MEDIA_IMAGE_MODEL: "img-model", MEDIA_VIDEO_MODEL: "vid-model" }));
  assert.equal(inherited.provider, "gemini");
  assert.equal(inherited.apiKey, "sk-media");
  assert.equal(inherited.supportsImageToVideo, false);

  assert.throws(() => config.getVideoConfig(env({ VIDEO_PROVIDER: "not-a-provider", VIDEO_API_KEY: "x" })), (e) => e.code === "not_configured");
});

// ---------------------------------------------------------------------------
// The client view: the ONLY shape that reaches the browser
// ---------------------------------------------------------------------------

test("the client view never carries provider ids, storage paths, prompts or owner ids", () => {
  const row = {
    id: "gen-1",
    owner_user_id: "owner-1",
    draft_id: "draft-1",
    media_type: "video",
    generation_mode: "generated_image_to_video",
    prompt: "a very specific provider prompt",
    aspect_ratio: "9:16",
    status: "failed",
    provider: "magic-hour",
    provider_job_id: "mh-123",
    storage_path: "owner-1/generated-base/secret-object.mp4",
    mime_type: "video/mp4",
    byte_size: 1234,
    duration_seconds: 8,
    estimated_cost_usd: 0.5,
    error_code: "rejected",
    idempotency_key: "video:post:draft-1:tok",
    source_asset_id: "asset-1",
    overlay: null,
    started_at: "2026-09-09T12:00:00Z",
    attempt_count: 1,
    created_at: "2026-09-09T12:00:00Z",
    updated_at: "2026-09-09T12:04:00Z",
    completed_at: null,
  };
  const safe = view.toClientGenerationView(row, "https://cdn.example/signed?token=short-lived");
  const json = JSON.stringify(safe);
  for (const secret of ["owner-1", "mh-123", "secret-object", "very specific provider prompt", "video:post:draft-1:tok", "asset-1", "magic-hour"]) {
    assert.doesNotMatch(json, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${secret} leaked into the client view`);
  }
  assert.equal(safe.phase, "failed");
  assert.match(safe.safeError, /couldn't finish/i);
  assert.equal(safe.previewUrl, "https://cdn.example/signed?token=short-lived");
});

// ---------------------------------------------------------------------------
// Server-side wiring: owner scoping and no credential leakage
// ---------------------------------------------------------------------------

test("every video job query is owner-scoped; reference images are owner-prefix-guarded", async () => {
  const ports = await read("lib/mara/video-ports.ts");
  // Every SELECT/UPDATE on the job table must be owner-scoped (the INSERT is
  // exempt: the row itself carries owner_user_id).
  const reads = (ports.match(/\.from\(MEDIA_GENERATIONS_TABLE\)\s*\n?\s*\.select\(/g) ?? []).length
    + (ports.match(/\.from\(MEDIA_GENERATIONS_TABLE\)\)\s*\.update\(/g) ?? []).length
    + (ports.match(/\.from\(MEDIA_GENERATIONS_TABLE\)\.update\(/g) ?? []).length;
  const ownerScopes = (ports.match(/\.eq\("owner_user_id", ownerId\)/g) ?? []).length;
  assert.ok(reads >= 6, "expected multiple owner-scoped job queries");
  assert.ok(ownerScopes >= reads, "every job read/update must carry the owner id");
  assert.match(ports, /storagePath\.startsWith\(`\$\{ownerId\}\/`\)/, "reference image reads are owner-prefix-guarded");
  assert.match(ports, /detectReelAsset\(bytes\)/, "reference bytes are re-sniffed, not trusted");
  assert.doesNotMatch(ports, /console\.log|console\.error/);
  assert.doesNotMatch(ports, /VIDEO_API_KEY/, "the ports receive the key through the config object, never from env");
});

test("provider keys are read from the environment only — never in client code, never persisted", async () => {
  const provider = await read("lib/media/video-provider.ts");
  const cfg = await read("lib/media/video-config.ts");
  assert.match(cfg, /env\.VIDEO_API_KEY\?\.trim\(\)/);
  assert.doesNotMatch(provider, /process\.env/, "providers receive the key through the config object");
  assert.doesNotMatch(provider, /console\.log|JSON\.stringify\(this\.config/);

  const components = await readdir(new URL("components/voom/", root), { recursive: true });
  for (const entry of components) {
    const name = String(entry);
    if (!name.endsWith(".tsx")) continue;
    const source = await read(`components/voom/${name}`);
    assert.doesNotMatch(source, /VIDEO_API_KEY|MEDIA_API_KEY|AI_API_KEY|SUPABASE_SECRET/, `credential name leaked into ${name}`);
  }
});

test("the video routes never echo raw provider errors and never expose env to the client", async () => {
  const generation = await read("app/api/posts/[id]/generation/route.ts");
  const produce = await read("app/api/reels/produce/[actionId]/route.ts");
  for (const route of [generation, produce]) {
    assert.doesNotMatch(route, /NEXT_PUBLIC_/);
    assert.doesNotMatch(route, /console\.log/);
    assert.doesNotMatch(route, /VIDEO_API_KEY|MEDIA_API_KEY|AI_API_KEY/);
    assert.doesNotMatch(route, /error_stack|stackTrace|e\.stack|reason\.message/);
  }
  assert.match(generation, /videoJobSafeError|toClientGenerationView/);
});

// ---------------------------------------------------------------------------
// Schema: 0025 adds job columns without weakening the 0008 security surface
// ---------------------------------------------------------------------------

test("0025 adds 'generating' + duplicate-job guard but grants nothing new to clients", async () => {
  const sql = await read("supabase/migrations/0025_mara_media_video_generation.sql");
  assert.match(sql, /check \(status in \('pending_confirmation','queued','generating','processing','completed','failed','cancelled'\)\)/);
  assert.match(sql, /create unique index if not exists mara_media_active_per_draft_uq[\s\S]+where draft_id is not null and status in \('queued','generating','processing'\)/);
  assert.match(sql, /create index if not exists mara_media_owner_draft_created_idx[\s\S]+owner_user_id, draft_id, created_at desc/);
  // No new client grants, no RLS changes, no drops — the 0008 surface stands.
  assert.doesNotMatch(sql, /grant /i);
  assert.doesNotMatch(sql, /policy|row level security/i);
  assert.doesNotMatch(sql, /\bdrop (table|column|index)\b/i);
  assert.doesNotMatch(sql, /instagram_publish_queue|graph\.facebook|graph\.instagram|publish_jobs/i, "video generation must not touch the publish pipeline");
});

test("the authenticated select grant (0008) excludes the new job internals", async () => {
  const sql = await read("supabase/migrations/0008_mara_media_generation.sql");
  const grant = sql.match(/grant select \(([\s\S]+?)\) on table public\.mara_media_generations to authenticated/)?.[1] ?? "";
  for (const column of ["generation_mode", "source_asset_id", "overlay", "started_at", "attempt_count", "provider", "provider_job_id", "storage_path", "error_code", "idempotency_key"]) {
    assert.doesNotMatch(grant, new RegExp(`\\b${column}\\b`), `${column} must not be readable by clients`);
  }
  assert.match(sql, /create policy "mara_media_select_own"[\s\S]+auth\.uid\(\)[\s\S]+owner_user_id/);
});
