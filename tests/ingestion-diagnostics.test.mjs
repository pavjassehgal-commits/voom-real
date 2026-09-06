import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const ingestion = await import("../lib/media/ingestion-error.ts");

const requestId = "11111111-1111-4111-8111-111111111111";

// These are intentionally exercised at the response boundary: route handlers
// may inspect SDK failures internally, but this is the last line before data
// reaches the browser.
test("ownership, storage and DB failures have stable safe codes", async () => {
  const ownership = await ingestion.ingestionError("ownership_failure", "raw ownership detail", 404, requestId).json();
  const storage = await ingestion.ingestionError("storage_failure", "raw Supabase storage detail", 503, requestId).json();
  const database = await ingestion.ingestionError("db_failure", "raw Postgres constraint detail", 503, requestId).json();

  assert.equal(ownership.code, "ownership_failure");
  assert.equal(storage.code, "storage_failure");
  assert.equal(database.code, "db_failure");
  assert.match(storage.error, /^Voom couldn't store that file safely\./);
  assert.match(database.error, /^Voom couldn't save that asset to your content\./);
  assert.doesNotMatch(storage.error, /Supabase|storage detail/i);
  assert.doesNotMatch(database.error, /Postgres|constraint detail/i);
  assert.equal(storage.requestId, requestId);
});

test("the upload routes log every diagnostic stage and classify failures safely", async () => {
  const [post, reel, helper, client] = await Promise.all([
    read("app/api/posts/[id]/asset/route.ts"),
    read("app/api/reels/assets/[actionId]/route.ts"),
    read("lib/post/server-data.ts"),
    read("components/voom/modals/PostEditorModal.tsx"),
  ]);
  const sources = `${post}\n${reel}\n${helper}`;
  for (const stage of ["received", "detected", "draft_read", "storage_upload", "db_upsert", "stored"]) {
    assert.match(sources, new RegExp(`\\"${stage}\\"`), `${stage} should be logged`);
  }
  for (const code of ["ownership_failure", "storage_failure", "db_failure"]) {
    assert.match(sources, new RegExp(`\\"${code}\\"`), `${code} should be present`);
  }
  assert.match(sources, /requestId/);
  assert.match(client, /body\.code/);
  assert.match(client, /formatIngestionClientError/);
  assert.doesNotMatch(sources, /Response\.json\(\{\s*error:\s*[^"`]/);
  assert.doesNotMatch(sources, /SUPABASE_SECRET_KEY|service[_-]?role|JWT|Bearer\s/i);
});

test("all ingestion stages and failure categories remain allow-listed", () => {
  assert.equal(ingestion.isIngestionErrorCode("ownership_failure"), true);
  assert.equal(ingestion.isIngestionErrorCode("storage_failure"), true);
  assert.equal(ingestion.isIngestionErrorCode("db_failure"), true);
  assert.equal(ingestion.isIngestionErrorCode("postgres_constraint_name"), false);
  assert.equal(ingestion.statusForIngestionCode("storage_failure"), 503);
  assert.equal(ingestion.statusForIngestionCode("db_failure"), 503);
});
