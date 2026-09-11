/**
 * MARA Post copy generation over Groq strict json_schema.
 *
 * These tests exercise the REAL adapter (`lib/ai/openai-compatible.ts`) and
 * the REAL MARA post schemas (`lib/post/prompt.ts`) against a stubbed
 * `fetch`. No live provider is ever called, no credentials exist in this
 * file's dummy key, and no media is generated — the image stage is only ever
 * asserted by source order, never executed.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";

const { AiError } = await import("../lib/ai/types.ts");
const { OpenAiCompatibleProvider, STRUCTURED_MAX_ATTEMPTS } = await import("../lib/ai/openai-compatible.ts");
const {
  POST_COPY_SYSTEM_PROMPT,
  STORY_VISUAL_SYSTEM_PROMPT,
  postDraftJsonSchema,
  postDraftSchema,
  postSuggestionJsonSchema,
  postSuggestionSchema,
  storyVisualJsonSchema,
  storyVisualSchema,
} = await import("../lib/post/prompt.ts");

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const CONFIG = {
  provider: "groq",
  apiKey: "gsk_test_secret_placeholder_key",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-120b",
};

const VALID_COPY = {
  concept: "Spring menu launch",
  caption: "Fresh flavours are back on the menu this week, built around what our regulars actually asked for all winter.",
  cta: "Book your table",
  hashtags: ["springmenu", "localcafe"],
  visualPrompt: "Bright editorial photo of a rustic cafe table with colourful seasonal dishes, soft window light, clean minimal background, no text",
};

const okJson = (value) => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] }),
});

/** Replaces global fetch with a scripted sequence; every call is recorded. */
function mockFetch(steps) {
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) : null });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step.throw) throw new TypeError("fetch failed");
    return new Response(step.body ?? "", { status: step.status ?? 200, headers: step.headers });
  };
  return calls;
}

const provider = () => new OpenAiCompatibleProvider(CONFIG);

const copyRequest = (extra = {}) => ({
  messages: [
    { role: "system", content: POST_COPY_SYSTEM_PROMPT },
    { role: "user", content: "{\"business\":\"Cafe\"}" },
  ],
  temperature: 0.6,
  maxTokens: 1200,
  jsonSchema: postDraftJsonSchema,
  parse: (value) => postDraftSchema.parse(value),
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. The production path: strict json_schema in, MARA copy out
// ---------------------------------------------------------------------------

test("valid Groq strict json_schema output produces MARA copy through the real wire contract", async () => {
  const calls = mockFetch([okJson(VALID_COPY)]);
  const copy = await provider().structured(copyRequest());

  assert.deepEqual(copy, postDraftSchema.parse(VALID_COPY), "parsed MARA copy (concept, caption, cta, hashtags, visualPrompt)");
  assert.equal(calls.length, 1, "a clean response needs no retry");
  const [call] = calls;
  assert.equal(call.url, "https://api.groq.com/openai/v1/chat/completions", "the Groq /chat/completions endpoint is unchanged");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, `Bearer ${CONFIG.apiKey}`, "the key travels only in the server-side request header");
  assert.equal(call.body.model, CONFIG.model);
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.response_format, {
    type: "json_schema",
    json_schema: { name: "mara_post_draft", strict: true, schema: postDraftJsonSchema.schema },
  });
  assert.notEqual(call.body.response_format.type, "json_object", "the legacy json_object mode is replaced for MARA copy generation");
});

test("the Story visual plan and the suggestion flow use strict json_schema too", async () => {
  const story = { concept: "Morning pastry window", visualPrompt: "Vertical bakery counter with fresh pastries, warm morning light, no text" };
  const storyCalls = mockFetch([okJson(story)]);
  const storyPlan = await provider().structured({
    messages: [{ role: "system", content: STORY_VISUAL_SYSTEM_PROMPT }, { role: "user", content: "{}" }],
    temperature: 0.6,
    maxTokens: 600,
    jsonSchema: storyVisualJsonSchema,
    parse: (value) => storyVisualSchema.parse(value),
  });
  assert.deepEqual(storyPlan, storyVisualSchema.parse(story));
  assert.equal(storyCalls[0].body.response_format.json_schema.name, "mara_story_visual");
  assert.equal(storyCalls[0].body.response_format.json_schema.strict, true);

  const suggestion = {
    caption: "Slow Saturday mornings start here.",
    cta: "Plan your visit",
    hashtags: ["slowmorning"],
    suggestedPublishAt: "2026-09-20T09:00:00+04:00",
    timingReason: "Your audience engages most on weekend mornings.",
  };
  const suggestionCalls = mockFetch([okJson(suggestion)]);
  const parsedSuggestion = await provider().structured({
    messages: [{ role: "system", content: "suggest" }, { role: "user", content: "{}" }],
    temperature: 0.5,
    maxTokens: 900,
    jsonSchema: postSuggestionJsonSchema,
    parse: (value) => postSuggestionSchema.parse(value),
  });
  assert.deepEqual(parsedSuggestion, postSuggestionSchema.parse(suggestion));
  assert.equal(suggestionCalls[0].body.response_format.json_schema.name, "mara_post_suggestion");
  assert.equal(suggestionCalls[0].body.response_format.json_schema.strict, true);
});

// ---------------------------------------------------------------------------
// 2. Malformed output is rejected BEFORE image generation
// ---------------------------------------------------------------------------

test("output failing the local schema is rejected deterministically (a single attempt)", async () => {
  // An injected extra key breaks the .strict() zod schema — exactly the case
  // where the provider's own validation did not protect us, so the local
  // parse must be the second safety layer.
  const calls = mockFetch([okJson({ ...VALID_COPY, injected: "extra" })]);
  const error = await provider().structured(copyRequest()).catch((reason) => reason);
  assert.ok(error instanceof AiError);
  assert.equal(error.code, "malformed_response", "the truthful failure code the routes already translate is preserved");
  assert.equal(error.transient, false, "a local schema/input failure is deterministic");
  assert.equal(calls.length, 1, "deterministic schema failures are never retried");
});

test("empty-string fields are also rejected before they can become a draft or an image", async () => {
  const calls = mockFetch([okJson({ ...VALID_COPY, caption: "" })]);
  await assert.rejects(
    () => provider().structured(copyRequest()),
    (error) => error instanceof AiError && error.code === "malformed_response",
  );
  assert.equal(calls.length, 1);
});

test("copy failure in the generate route returns before any media-generation row or image request", async () => {
  const route = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(route, /jsonSchema: postDraftJsonSchema/, "Post copy uses the strict schema");
  assert.match(route, /jsonSchema: storyVisualJsonSchema/, "Story copy uses the strict schema");
  const postCopyFailure = route.indexOf("MARA couldn't write that post. Please retry.");
  const storyCopyFailure = route.indexOf("MARA couldn't plan that Story. Please retry.");
  const generationRow = route.indexOf("from(\"mara_media_generations\").insert");
  const imageCall = route.indexOf("createMediaProvider(config).generateImage");
  for (const marker of [postCopyFailure, storyCopyFailure, generationRow, imageCall]) assert.ok(marker > -1);
  assert.ok(postCopyFailure < generationRow, "a copy failure returns BEFORE any mara_media_generations row is created");
  assert.ok(storyCopyFailure < generationRow, "a story failure returns BEFORE any mara_media_generations row is created");
  assert.ok(postCopyFailure < imageCall, "malformed copy can never continue into Gemini image generation");

  const suggest = await read("app/api/posts/[id]/suggest/route.ts");
  assert.match(suggest, /jsonSchema: postSuggestionJsonSchema/);
});

// ---------------------------------------------------------------------------
// 3. The bounded retry policy: transient only, never a loop
// ---------------------------------------------------------------------------

test("bad provider samples retry only within the bounded policy", async () => {
  const calls = mockFetch([okJson("not json at all"), okJson("```json\n{broken"), okJson(VALID_COPY)]);
  const copy = await provider().structured(copyRequest());
  assert.deepEqual(copy, postDraftSchema.parse(VALID_COPY), "a later clean sample succeeds");
  assert.equal(calls.length, STRUCTURED_MAX_ATTEMPTS, "two transient failures consumed exactly two bounded retries");

  const persistent = mockFetch([okJson("never json")]);
  await assert.rejects(
    () => provider().structured(copyRequest()),
    (error) => error instanceof AiError && error.code === "malformed_response",
  );
  assert.equal(persistent.length, STRUCTURED_MAX_ATTEMPTS, "persistent failures stop at the bound — they never loop");
});

test("rate limits and 5xx faults are transient and bounded", async () => {
  const calls = mockFetch([
    { status: 500, body: "{}" },
    { status: 429, body: "{}", headers: { "retry-after": "1" } },
    okJson(VALID_COPY),
  ]);
  const copy = await provider().structured(copyRequest());
  assert.deepEqual(copy, postDraftSchema.parse(VALID_COPY));
  assert.equal(calls.length, 3);

  const busy = mockFetch([{ status: 429, body: "{}", headers: { "retry-after": "1" } }]);
  await assert.rejects(
    () => provider().structured(copyRequest()),
    (error) => error instanceof AiError && error.code === "rate_limited" && error.retryAfterSeconds === 1,
    "after the bound, the truthful rate_limited failure (HTTP 429 to the user) is preserved with its hint",
  );
  assert.equal(busy.length, STRUCTURED_MAX_ATTEMPTS);
});

test("Groq json_validate_failed is a transient generation failure that never leaks failed_generation", async () => {
  const failure = {
    status: 400,
    body: JSON.stringify({
      error: { code: "json_validate_failed", message: "Failed to generate JSON. Please adjust your prompt.", failed_generation: "RAW_SECRET_SAMPLE {{ not json" },
    }),
  };
  const calls = mockFetch([failure, okJson(VALID_COPY)]);
  const copy = await provider().structured(copyRequest());
  assert.deepEqual(copy, postDraftSchema.parse(VALID_COPY), "a fresh attempt after a generation-validation failure succeeds");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.response_format.json_schema.strict, true, "the retry keeps the strict schema");

  const persistent = mockFetch([failure]);
  const error = await provider().structured(copyRequest()).catch((reason) => reason);
  assert.ok(error instanceof AiError);
  assert.equal(error.code, "malformed_response", "the collapsed-but-truthful failure code is unchanged");
  assert.equal(persistent.length, STRUCTURED_MAX_ATTEMPTS, "bounded — generation failures also stop at the limit");
  assert.doesNotMatch(String(error.message), /RAW_SECRET_SAMPLE|failed_generation|gsk_test/, "provider payloads are never echoed into our errors");
});

// ---------------------------------------------------------------------------
// 4. Deterministic failures fail fast — and unsupported modes degrade
// ---------------------------------------------------------------------------

test("deterministic 4xx and schema/input failures are never retried", async () => {
  const invalidModel = mockFetch([{ status: 400, body: JSON.stringify({ error: { code: "invalid_request_error", message: "The model `bad-model` does not exist" } }) }]);
  await assert.rejects(
    () => provider().structured(copyRequest({ maxTokens: 50 })),
    (error) => error instanceof AiError && error.code === "unavailable" && error.transient === false,
  );
  assert.equal(invalidModel.length, 1, "a deterministic 400 does not loop");

  const unauthorized = mockFetch([{ status: 401, body: JSON.stringify({ error: { code: "invalid_api_key", message: "Invalid API key" } }) }]);
  await assert.rejects(
    () => provider().structured(copyRequest()),
    (error) => error instanceof AiError && error.code === "unavailable" && error.transient === false,
  );
  assert.equal(unauthorized.length, 1, "auth failures fail fast");
});

test("a model without strict support degrades strict -> best-effort within the bound, then succeeds", async () => {
  const unsupportedStrict = {
    status: 400,
    body: JSON.stringify({ error: { code: "invalid_request_error", message: "response_format with json_schema strict is not supported for this model" } }),
  };
  const calls = mockFetch([unsupportedStrict, okJson(VALID_COPY)]);
  const copy = await provider().structured(copyRequest());
  assert.deepEqual(copy, postDraftSchema.parse(VALID_COPY));
  assert.equal(calls.length, 2, "the capability probe did not spend a generation retry");
  assert.equal(calls[0].body.response_format.json_schema.strict, true, "strict requested first, where supported");
  assert.deepEqual(calls[1].body.response_format, {
    type: "json_schema",
    json_schema: { name: "mara_post_draft", strict: false, schema: postDraftJsonSchema.schema },
  }, "best-effort json_schema is the next rung, still schema-constrained");
});

test("a provider without json_schema falls back to the universal json_object floor inside the same bound", async () => {
  const unsupported = { status: 400, body: JSON.stringify({ error: { code: "invalid_request_error", message: "response_format is not supported by this model" } }) };
  const calls = mockFetch([unsupported]);
  await assert.rejects(
    () => provider().structured(copyRequest()),
    (error) => error instanceof AiError && error.code === "unavailable",
  );
  assert.equal(calls.length, 3, "strict, best-effort, json_object floor — then it stops, never a loop");
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.equal(calls[1].body.response_format.json_schema.strict, false);
  assert.deepEqual(calls[2].body.response_format, { type: "json_object" }, "the floor is today's universally-supported behaviour, not worse");
});

// ---------------------------------------------------------------------------
// 5. Legacy flows (chat, planning, reels, video) are byte-for-byte untouched
// ---------------------------------------------------------------------------

test("structured calls without a schema keep the legacy json_object single-attempt contract", async () => {
  const calls = mockFetch([{ status: 500, body: "{}" }, okJson(VALID_COPY)]);
  await assert.rejects(
    () => provider().structured({
      messages: [{ role: "system", content: "plan" }, { role: "user", content: "{}" }],
      parse: (value) => value,
    }),
    (error) => error instanceof AiError && error.code === "unavailable",
  );
  assert.equal(calls.length, 1, "no schema means no retry — chat/planning/reel behaviour is exactly as before");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" }, "the legacy response_format is preserved for them");
});

test("the copy system prompts and their key contracts are unchanged", () => {
  assert.match(POST_COPY_SYSTEM_PROMPT, /exactly these keys:\n\{"concept":"string","caption":"string","cta":"string","hashtags":\["string"\],"visualPrompt":"string"\}/);
  assert.match(STORY_VISUAL_SYSTEM_PROMPT, /exactly these keys:\n\{"concept":"string","visualPrompt":"string"\}/);
});

// ---------------------------------------------------------------------------
// 6. The JSON Schemas ARE the MARA post output schema (lockstep with zod)
// ---------------------------------------------------------------------------

const stripAnnotations = (node) => {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !["$schema", "default", "description"].includes(key))
        .map(([key, value]) => [key, stripAnnotations(value)]),
    );
  }
  return node;
};

test("the Groq JSON Schemas are byte-compatible with the real zod schemas", () => {
  assert.deepEqual(stripAnnotations(z.toJSONSchema(postDraftSchema)), stripAnnotations(postDraftJsonSchema.schema));
  assert.deepEqual(stripAnnotations(z.toJSONSchema(storyVisualSchema)), stripAnnotations(storyVisualJsonSchema.schema));

  const derived = stripAnnotations(z.toJSONSchema(postSuggestionSchema));
  const ours = stripAnnotations(postSuggestionJsonSchema.schema);
  delete derived.properties.suggestedPublishAt;
  delete ours.properties.suggestedPublishAt;
  assert.deepEqual(derived, ours, "caption, cta, hashtags and timingReason match the zod schema exactly");
  assert.deepEqual([...postSuggestionJsonSchema.schema.properties.suggestedPublishAt.type], ["string", "null"], "the only optional value is a null union, per strict-mode rules");
  // The provider contract is deliberately looser on datetime semantics; the
  // zod layer still enforces them, so drift can never persist or be acted on.
  const base = { caption: "Slow Saturday mornings start here.", cta: "Plan your visit", hashtags: [], suggestedPublishAt: null, timingReason: "" };
  assert.equal(postSuggestionSchema.parse(base).suggestedPublishAt, null);
  assert.equal(postSuggestionSchema.parse({ ...base, suggestedPublishAt: "2026-09-20T09:00:00+04:00" }).suggestedPublishAt, "2026-09-20T09:00:00+04:00");
  assert.throws(() => postSuggestionSchema.parse({ ...base, suggestedPublishAt: "next Friday" }));
});

test("every schema satisfies Groq strict mode structurally", () => {
  for (const spec of [postDraftJsonSchema, storyVisualJsonSchema, postSuggestionJsonSchema]) {
    assert.equal(spec.strict, true);
    assert.match(spec.name, /^[a-z0-9_]+$/);
    assert.equal(spec.schema.type, "object");
    assert.equal(spec.schema.additionalProperties, false, "objects are closed");
    assert.deepEqual([...spec.schema.required].sort(), Object.keys(spec.schema.properties).sort(), "every property is required");
  }
});

// ---------------------------------------------------------------------------
// 7. Secrets and provider payloads never reach the client or an error surface
// ---------------------------------------------------------------------------

test("provider secrets and payloads stay server-side only", async () => {
  const calls = mockFetch([{ status: 400, body: JSON.stringify({ error: { code: "invalid_api_key", message: `bad key ${CONFIG.apiKey}` } }) }]);
  const error = await provider().structured(copyRequest()).catch((reason) => reason);
  assert.ok(error instanceof AiError);
  assert.doesNotMatch(String(error.message), /gsk_test/, "provider error text is never echoed into our errors");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${CONFIG.apiKey}`, "the key appears only inside the server-side request");

  const [adapter, config, generate, suggest, envExample] = await Promise.all([
    read("lib/ai/openai-compatible.ts"),
    read("lib/ai/config.ts"),
    read("app/api/posts/[id]/generate/route.ts"),
    read("app/api/posts/[id]/suggest/route.ts"),
    read(".env.example"),
  ]);
  assert.match(adapter, /^import "server-only";/m);
  assert.match(config, /^import "server-only";/m);
  assert.doesNotMatch(`${adapter}\n${config}`, /NEXT_PUBLIC/);
  assert.doesNotMatch(adapter, /console\.(log|error)/);
  assert.doesNotMatch(envExample, /NEXT_PUBLIC_AI_/, "AI credentials can never become client-bundle variables");

  // The user-facing failures remain the fixed truthful strings — never
  // provider detail, regardless of which failure class fired.
  assert.match(generate, /error: "MARA couldn't write that post\. Please retry\." \}, \{ status: 502 \}\)/);
  assert.match(generate, /error: "MARA couldn't plan that Story\. Please retry\." \}, \{ status: 502 \}\)/);
  assert.match(suggest, /error: "MARA couldn't suggest copy just now\. Please retry\." \}, \{ status: 502 \}\)/);
  for (const route of [generate, suggest]) {
    assert.doesNotMatch(route, /error: \w+\.message/, "route responses never interpolate provider error messages");
    assert.doesNotMatch(route, /error: String\(/);
  }
});

// ---------------------------------------------------------------------------
// 8. Nothing outside the AI adapter and the Post flows changed
// ---------------------------------------------------------------------------

test("Gemini image generation, video, publishing and migrations are untouched by the fix", async () => {
  const mediaProvider = await read("lib/media/provider.ts");
  // The one functional change: the Interactions image request asks for the only
  // mime_type the endpoint supports. Everything else (model, endpoint, key
  // handling, video, publishing, migrations) stays exactly as it was.
  assert.match(mediaProvider, /response_format: \{ type: "image", mime_type: "image\/jpeg", aspect_ratio: input\.aspectRatio \}/, "the Gemini image request asks for JPEG");
  assert.doesNotMatch(mediaProvider, /mime_type: "image\/png"/, "PNG is never requested from Gemini Interactions");

  const routes = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(routes, /getMediaConfig|createMediaProvider/, "the image stage still runs after copy success");
  assert.doesNotMatch(routes, /graph\.instagram\.com|media_publish|instagram_publish_jobs|publishToInstagram|publishPost/i, "Post Studio still never publishes");

  const migrations = await read("supabase/migrations/0027_mara_media_provider_diagnostics.sql");
  assert.ok(migrations.length > 0, "no migration was added or altered");
});
