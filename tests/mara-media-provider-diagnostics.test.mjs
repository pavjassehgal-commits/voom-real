/**
 * Bounded Gemini/image-provider rejection diagnostics.
 *
 * These tests exercise the parser with synthetic Response objects. They never
 * call a live provider, never set MEDIA_API_KEY, and never generate media.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const diagnostic = await import("../lib/media/diagnostic.ts");

function errorResponse(status, body, contentType) {
  const headers = {};
  if (contentType) headers["content-type"] = contentType;
  return new Response(body, { status, headers });
}

test("Google nested JSON error body is parsed into bounded diagnostic fields", async () => {
  const body = {
    error: {
      code: 400,
      message: "Request contains an invalid argument.",
      status: "INVALID_ARGUMENT",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "FAILED_PRECONDITION",
          domain: "googleapis.com",
        },
      ],
    },
  };
  const result = await diagnostic.parseProviderDiagnostic(
    errorResponse(400, JSON.stringify(body), "application/json; charset=utf-8"),
  );
  assert.equal(result.http_status, 400);
  assert.equal(result.content_type, "application/json; charset=utf-8");
  assert.equal(result.provider_code, "400");
  assert.equal(result.provider_status, "INVALID_ARGUMENT");
  assert.equal(result.provider_message, "Request contains an invalid argument.");
  assert.equal(result.provider_details?.reason, "FAILED_PRECONDITION");
  assert.equal(result.provider_details?.domain, "googleapis.com");
  assert.equal(result.body_excerpt, null, "complete parsed fields do not need a raw excerpt");
});

test("JSON with an unexpected shape still stores a sanitized excerpt", async () => {
  const raw = JSON.stringify({ unexpected: true, nested: { hello: "world" }, list: [1, 2, 3] });
  const result = await diagnostic.parseProviderDiagnostic(errorResponse(400, raw, "application/json"));
  assert.equal(result.http_status, 400);
  assert.equal(result.content_type, "application/json");
  assert.equal(result.provider_code, null);
  assert.equal(result.provider_status, null);
  assert.equal(result.provider_message, null);
  assert.equal(result.provider_details, null);
  assert.match(result.body_excerpt ?? "", /unexpected/);
  assert.match(result.body_excerpt ?? "", /hello/);
  assert.ok((result.body_excerpt ?? "").length <= diagnostic.DIAGNOSTIC_EXCERPT_MAX);
});

test("plain-text 400 body stores a short sanitized excerpt", async () => {
  const result = await diagnostic.parseProviderDiagnostic(
    errorResponse(400, "INVALID_ARGUMENT: model is not supported for image generation", "text/plain"),
  );
  assert.equal(result.http_status, 400);
  assert.equal(result.content_type, "text/plain");
  assert.equal(result.provider_code, null);
  assert.equal(result.provider_status, null);
  assert.equal(result.provider_message, null);
  assert.equal(result.body_excerpt, "INVALID_ARGUMENT: model is not supported for image generation");
});

test("HTML 400 body stores a tag-stripped sanitized excerpt", async () => {
  const html = "<html><head><title>400 Bad Request</title></head><body><h1>Bad Request</h1><p>Your client has issued a malformed or illegal request.</p></body></html>";
  const result = await diagnostic.parseProviderDiagnostic(errorResponse(400, html, "text/html; charset=UTF-8"));
  assert.equal(result.http_status, 400);
  assert.equal(result.content_type, "text/html; charset=UTF-8");
  assert.equal(result.provider_code, null);
  assert.match(result.body_excerpt ?? "", /Bad Request/);
  assert.match(result.body_excerpt ?? "", /malformed or illegal request/);
  assert.doesNotMatch(result.body_excerpt ?? "", /<html|<h1|<\/p>/i);
});

test("secret and token patterns are redacted from stored diagnostics", async () => {
  const raw = [
    "Authorization: Bearer supersecret-token-value",
    "api_key=AIzaSyFakeLiveKeyValue999",
    "cookie: session=abc123",
    "signed url https://storage.googleapis.com/bucket/obj?X-Goog-Signature=deadbeef",
    "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.signature",
  ].join(" ");
  const result = await diagnostic.parseProviderDiagnostic(errorResponse(400, raw, "text/plain"));
  const excerpt = result.body_excerpt ?? "";
  assert.match(excerpt, /\[redacted\]/);
  assert.doesNotMatch(excerpt, /supersecret-token-value/);
  assert.doesNotMatch(excerpt, /AIzaSyFakeLiveKeyValue999/);
  assert.doesNotMatch(excerpt, /session=abc123/);
  assert.doesNotMatch(excerpt, /https:\/\/storage\.googleapis\.com/);
  assert.doesNotMatch(excerpt, /X-Goog-Signature=deadbeef/);
  assert.doesNotMatch(excerpt, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.doesNotMatch(excerpt, /MEDIA_API_KEY|x-goog-api-key/i);
});

test("stored diagnostic strings are tightly truncated", async () => {
  const long = `error ${"x".repeat(5_000)}`;
  const result = await diagnostic.parseProviderDiagnostic(errorResponse(400, long, "text/plain"));
  assert.ok(result.body_excerpt);
  assert.equal(result.body_excerpt.length, diagnostic.DIAGNOSTIC_EXCERPT_MAX);
  assert.ok(result.body_excerpt.startsWith("error xxx"));
  assert.ok(long.length > diagnostic.DIAGNOSTIC_READ_MAX);
});

test("client SELECT surfaces exclude provider diagnostics", async () => {
  const [data, grantSql, diagSql, generate, mediaRoute, types] = await Promise.all([
    read("lib/media/data.ts"),
    read("supabase/migrations/0008_mara_media_generation.sql"),
    read("supabase/migrations/0027_mara_media_provider_diagnostics.sql"),
    read("app/api/posts/[id]/generate/route.ts"),
    read("app/api/mara/media/[id]/route.ts"),
    read("lib/media/types.ts"),
  ]);

  assert.match(data, /export const MEDIA_SELECT = "/);
  assert.doesNotMatch(data, /MEDIA_SELECT = "[^"]*provider_diagnostic/);
  assert.doesNotMatch(data, /provider_diagnostic/);
  assert.doesNotMatch(types, /provider_diagnostic/);
  assert.doesNotMatch(data, /body_excerpt|provider_message|content_type/);

  const grant = grantSql.match(/grant select \(([\s\S]+?)\) on table public\.mara_media_generations to authenticated/)?.[1] ?? "";
  assert.doesNotMatch(grant, /provider_diagnostic/);
  assert.doesNotMatch(grant, /provider_job_id|storage_path|error_code/);
  assert.doesNotMatch(diagSql, /grant /i);
  assert.match(diagSql, /service-role only/);

  assert.match(generate, /MARA saved the copy, but the visual could not be generated\. No visual was attached\./);
  assert.match(
    generate,
    /return Response\.json\(\{\s*post: await getPostDraft\(admin, user\.id, id\),\s*error: "MARA saved the copy, but the visual could not be generated\. No visual was attached\.",\s*\}, \{ status: 503 \}\)/,
  );
  assert.doesNotMatch(generate, /body_excerpt|provider_message|provider_code/);
  assert.match(mediaRoute, /error: friendlyMediaError\(code\)/);
  assert.doesNotMatch(mediaRoute, /error: friendlyMediaError\(code\),[^}]*provider_diagnostic/);

  const files = await readdir(new URL("components/voom/", root), { recursive: true });
  for (const entry of files) {
    const name = String(entry);
    if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
    const source = await read(`components/voom/${name}`);
    assert.doesNotMatch(source, /\bprovider_diagnostic\b|\bbody_excerpt\b|\bprovider_message\b/, `client file ${name} must not read diagnostics`);
  }
});

test("error classification and Gemini image request contract are unchanged", async () => {
  const provider = await read("lib/media/provider.ts");
  assert.match(provider, /response\.status === 429 \? "rate_limited" : response\.status >= 500 \? "unavailable" : "rejected"/);
  assert.match(provider, /parseProviderDiagnostic\(response\)/);
  assert.doesNotMatch(provider, /for \(let .*retry|attempt < |retryAfter|setTimeout/);
  assert.match(provider, /\$\{this\.config\.baseUrl\}\/interactions/);
  assert.match(provider, /response_format: \{ type: "image", mime_type: "image\/png", aspect_ratio: input\.aspectRatio \}/);
  assert.match(provider, /model: this\.config\.imageModel, input: \[\{ type: "text", text: input\.prompt \}\]/);
  assert.doesNotMatch(provider, /console\.log|console\.error/);
});
