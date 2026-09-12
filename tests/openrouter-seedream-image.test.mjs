/**
 * Regression: OpenRouter Seedream 4.5 is Voom's production image provider.
 *
 * Proves the shipping OpenRouter adapter (source extracted + evaluated, same
 * pattern as gemini-image-jpeg-output.test.mjs):
 *   - POSTs to /api/v1/images (never /images/generations, never Gemini)
 *   - model bytedance-seed/seedream-4.5 (or MEDIA_IMAGE_MODEL override)
 *   - n=1, resolution "2K" (Seedream 4.5 rejects "1K"/1024x1024: its minimum
 *     is 3,686,400 output pixels and 1024x1024 is only 1,048,576)
 *   - aspect_ratio 1:1 / 4:5 / 9:16 pass through directly
 *   - decodes data[0].b64_json
 *   - respects data[0].media_type when present
 *   - never hardcodes storage MIME/extension (byte inspection does)
 *   - maps 429/5xx to retryable codes; auth/invalid fail fast
 *   - never silently retries paid generations
 *   - Gemini + OpenAI adapters remain intact
 *   - Magic Hour / video configuration is untouched
 *
 * No real network, no real API key. The provider module is never imported —
 * only read as text — so no paid generation can run in this suite.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const mediaConfig = await import("../lib/media/config.ts");
const insp = await import("../lib/media/media-inspect.ts");
const videoConfig = await import("../lib/media/video-config.ts");
const { MediaError } = await import("../lib/media/types.ts");

const providerSource = await read("lib/media/provider.ts");
const configSource = await read("lib/media/config.ts");
const envExample = await read(".env.example");
const generateRoute = await read("app/api/posts/[id]/generate/route.ts");

const geminiSource = providerSource.slice(
  providerSource.indexOf("class GeminiMediaProvider"),
  providerSource.indexOf("class OpenAiMediaProvider"),
);
const openAiSource = providerSource.slice(
  providerSource.indexOf("class OpenAiMediaProvider"),
  providerSource.indexOf("class OpenRouterMediaProvider"),
);
const openRouterSource = providerSource.slice(providerSource.indexOf("class OpenRouterMediaProvider"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const U16BE = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const U32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

function jpeg(width, height) {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), U16BE(16), Buffer.from("JFIF\0", "binary"), Buffer.from([1, 1, 0, 0x48, 0, 0x48, 0, 0, 0]),
    Buffer.from([0xff, 0xc0]), U16BE(17), Buffer.from([8]), U16BE(height), U16BE(width), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    Buffer.from([0xff, 0xd9]),
  ]));
}

function png(width, height) {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    U32(13), Buffer.from("IHDR", "ascii"), U32(width), U32(height), Buffer.from([8, 2, 0, 0, 0]), Buffer.alloc(16),
  ]));
}

/** decodeMedia()'s transport: what the provider hands downstream is this exact round-trip. */
const viaProviderBase64 = (bytes) => new Uint8Array(Buffer.from(Buffer.from(bytes).toString("base64"), "base64"));

function bareEnv(over = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(MEDIA_|OPENROUTER_|VIDEO_)/.test(k)) delete env[k];
  }
  return { ...env, ...over };
}

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

test("OpenRouter media config uses OPENROUTER_API_KEY and Seedream 4.5 defaults", () => {
  const cfg = mediaConfig.getMediaConfig(bareEnv({
    MEDIA_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "or-test-key",
  }));
  assert.equal(cfg.provider, "openrouter");
  assert.equal(cfg.apiKey, "or-test-key");
  assert.equal(cfg.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(cfg.imageModel, "bytedance-seed/seedream-4.5");

  const overridden = mediaConfig.getMediaConfig(bareEnv({
    MEDIA_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "or-test-key",
    MEDIA_IMAGE_MODEL: "bytedance-seed/seedream-4.5",
    MEDIA_BASE_URL: "https://openrouter.ai/api/v1/",
  }));
  assert.equal(overridden.imageModel, "bytedance-seed/seedream-4.5");
  assert.equal(overridden.baseUrl, "https://openrouter.ai/api/v1", "trailing slash is stripped");

  assert.throws(
    () => mediaConfig.getMediaConfig(bareEnv({ MEDIA_PROVIDER: "openrouter" })),
    (e) => e instanceof MediaError && e.code === "not_configured",
  );
  // OpenRouter must not require MEDIA_API_KEY or MEDIA_VIDEO_MODEL.
  assert.doesNotThrow(() => mediaConfig.getMediaConfig(bareEnv({
    MEDIA_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "or-test-key",
  })));
});

test("Gemini and OpenAI media config paths remain intact", () => {
  const gemini = mediaConfig.getMediaConfig(bareEnv({
    MEDIA_PROVIDER: "gemini",
    MEDIA_API_KEY: "sk-media",
    MEDIA_IMAGE_MODEL: "gemini-image",
    MEDIA_VIDEO_MODEL: "veo",
  }));
  assert.equal(gemini.provider, "gemini");
  assert.equal(gemini.apiKey, "sk-media");
  assert.match(gemini.baseUrl, /generativelanguage\.googleapis\.com/);

  const openai = mediaConfig.getMediaConfig(bareEnv({
    MEDIA_PROVIDER: "openai",
    MEDIA_API_KEY: "sk-openai",
    MEDIA_IMAGE_MODEL: "dall-e-3",
    MEDIA_VIDEO_MODEL: "sora",
  }));
  assert.equal(openai.provider, "openai");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
});

test(".env.example documents OPENROUTER_API_KEY and MEDIA_IMAGE_MODEL as server-only", () => {
  assert.match(envExample, /^OPENROUTER_API_KEY=$/m);
  assert.match(envExample, /^MEDIA_PROVIDER=$/m);
  assert.match(envExample, /^MEDIA_IMAGE_MODEL=$/m);
  assert.doesNotMatch(envExample, /NEXT_PUBLIC_OPENROUTER_API_KEY|NEXT_PUBLIC_MEDIA_/);
  assert.match(configSource, /OPENROUTER_API_KEY/);
  assert.match(configSource, /bytedance-seed\/seedream-4\.5/);
});

// ---------------------------------------------------------------------------
// 2. Request shape (extracted from shipping OpenRouter adapter source)
// ---------------------------------------------------------------------------

test("OpenRouter image request uses /api/v1/images with Seedream 4.5, n=1, resolution 2K", () => {
  // Endpoint: POST {baseUrl}/images  →  https://openrouter.ai/api/v1/images
  assert.match(openRouterSource, /jsonRequest\(`\$\{this\.config\.baseUrl\}\/images`/);
  assert.match(openRouterSource, /method:\s*"POST"/);
  assert.match(openRouterSource, /Authorization: `Bearer \$\{this\.config\.apiKey\}`/);
  assert.match(openRouterSource, /"Content-Type": "application\/json"/);
  assert.doesNotMatch(openRouterSource, /images\/generations/);
  assert.doesNotMatch(openRouterSource, /\/interactions/);

  // Default base URL + model from config.
  assert.match(configSource, /openrouter:\s*"https:\/\/openrouter\.ai\/api\/v1"/);
  assert.match(configSource, /DEFAULT_OPENROUTER_IMAGE_MODEL = "bytedance-seed\/seedream-4\.5"/);

  // Request body fields evaluated from the shipping source (this.config.imageModel
  // is substituted so the expression runs without a class instance).
  const bodyMatch = openRouterSource.match(
    /body: JSON\.stringify\(\s*(\{[\s\S]*?model: this\.config\.imageModel[\s\S]*?\})\s*\)/,
  );
  assert.ok(bodyMatch, "OpenRouter request body is still in the shipping source");
  const bodyExpr = bodyMatch[1].replace(/this\.config\.imageModel/g, JSON.stringify("bytedance-seed/seedream-4.5"));
  const buildBody = (input) => new Function("input", `return (${bodyExpr});`)(input);

  for (const aspectRatio of ["1:1", "4:5", "9:16"]) {
    const body = buildBody({ prompt: `format ${aspectRatio}`, aspectRatio });
    assert.equal(body.model, "bytedance-seed/seedream-4.5");
    assert.equal(body.n, 1);
    assert.equal(body.resolution, "2K", "Seedream 4.5 minimum is 3,686,400 pixels; 2K is required");
    assert.equal(body.aspect_ratio, aspectRatio, `${aspectRatio} must pass through unchanged`);
    assert.equal(body.prompt, `format ${aspectRatio}`);
    assert.equal(body.size, undefined, "size shorthand is not used; resolution + aspect_ratio are");
    // Regression: the "1K" tier and hardcoded 1024-pixel square sizes must
    // never be sent (1,048,576 pixels is below the Seedream 4.5 floor → 400).
    assert.notEqual(body.resolution, "1K");
    assert.equal(body.size, undefined);
    assert.equal(body.width, undefined, "pixel width is not hardcoded; resolution + aspect_ratio are used");
    assert.equal(body.height, undefined, "pixel height is not hardcoded; resolution + aspect_ratio are used");
    assert.doesNotMatch(JSON.stringify(body), /1K|1024x1024/);
  }

  assert.match(openRouterSource, /resolution:\s*"2K"/);
  assert.doesNotMatch(openRouterSource, /resolution:\s*"1K"/);
  assert.doesNotMatch(openRouterSource, /1024x1024/);
  assert.match(openRouterSource, /n:\s*1/);
  assert.match(openRouterSource, /aspect_ratio:\s*input\.aspectRatio/);
  assert.match(openRouterSource, /model:\s*this\.config\.imageModel/);
});

test("createMediaProvider routes openrouter to the OpenRouter adapter", () => {
  assert.match(providerSource, /if \(config\.provider === "openrouter"\) return new OpenRouterMediaProvider\(config\);/);
  assert.match(providerSource, /if \(config\.provider === "gemini"\) return new GeminiMediaProvider\(config\);/);
  assert.match(providerSource, /return new OpenAiMediaProvider\(config\);/);
  assert.match(providerSource, /class OpenRouterMediaProvider implements MediaProvider/);
});

// ---------------------------------------------------------------------------
// 3. Response parsing: b64_json + media_type + byte inspection
// ---------------------------------------------------------------------------

test("data[0].b64_json is decoded; media_type is respected; MIME/extension come from byte inspection", () => {
  // findOpenRouterOutputImage — extract and run the shipping parser with TS syntax stripped.
  const start = providerSource.indexOf("function findOpenRouterOutputImage");
  const end = providerSource.indexOf("\nfunction stringAt", start);
  assert.ok(start >= 0 && end > start, "findOpenRouterOutputImage is in the shipping provider");
  let fnSrc = providerSource.slice(start, end);
  // Strip TypeScript annotations so new Function can evaluate the body.
  fnSrc = fnSrc
    .replace(/: Record<string, unknown>/g, "")
    .replace(/ as Record<string, unknown>/g, "")
    .replace(/ as GeneratedMedia\["mimeType"\]/g, "")
    .replace(/: GeneratedMedia\["mimeType"\]/g, "")
    .replace(/: string/g, "")
    .replace(/: unknown/g, "");
  const findOpenRouterOutputImage = new Function("MediaError", `${fnSrc}; return findOpenRouterOutputImage;`)(MediaError);

  // decodeMedia transport (same base64 round-trip the provider uses)
  const decodeMedia = (data, mimeType) => {
    try { return { kind: "complete", bytes: new Uint8Array(Buffer.from(data, "base64")), mimeType }; }
    catch { throw new MediaError("malformed_response"); }
  };

  // JPEG declared + JPEG bytes
  {
    const bytes = jpeg(1080, 1350);
    const b64 = Buffer.from(bytes).toString("base64");
    const image = findOpenRouterOutputImage({ data: [{ b64_json: b64, media_type: "image/jpeg" }] });
    assert.equal(image.mimeType, "image/jpeg");
    const result = decodeMedia(image.data, image.mimeType);
    assert.deepEqual(Array.from(result.bytes), Array.from(bytes));
    const inspected = insp.inspectImageBytes(result.bytes);
    assert.deepEqual(inspected, { mimeType: "image/jpeg", width: 1080, height: 1350 });
    // Storage extension is derived from sniffed mime, never from a hardcoded OpenRouter format.
    const extension = inspected.mimeType === "image/png" ? "png" : inspected.mimeType === "image/webp" ? "webp" : "jpg";
    assert.equal(extension, "jpg");
    assert.equal(insp.aspectMatches(inspected.width, inspected.height, "4:5"), true);
  }

  // PNG declared + PNG bytes (provider may return PNG; Voom must not force JPEG)
  {
    const bytes = png(1080, 1920);
    const b64 = Buffer.from(bytes).toString("base64");
    const image = findOpenRouterOutputImage({ data: [{ b64_json: b64, media_type: "image/png" }] });
    assert.equal(image.mimeType, "image/png");
    const result = decodeMedia(image.data, image.mimeType);
    const inspected = insp.inspectImageBytes(result.bytes);
    assert.deepEqual(inspected, { mimeType: "image/png", width: 1080, height: 1920 });
    const extension = inspected.mimeType === "image/png" ? "png" : inspected.mimeType === "image/webp" ? "webp" : "jpg";
    assert.equal(extension, "png", "extension comes from bytes, not a hardcoded OpenRouter format");
    assert.equal(insp.aspectMatches(inspected.width, inspected.height, "9:16"), true);
  }

  // Missing media_type still decodes; downstream byte sniff is authoritative
  {
    const bytes = jpeg(1024, 1024);
    const b64 = Buffer.from(bytes).toString("base64");
    const image = findOpenRouterOutputImage({ data: [{ b64_json: b64 }] });
    assert.ok(image.data);
    const result = decodeMedia(image.data, image.mimeType);
    const inspected = insp.inspectImageBytes(result.bytes);
    assert.equal(inspected?.mimeType, "image/jpeg", "byte inspection, not the provider declaration, decides the real type");
    assert.equal(insp.aspectMatches(inspected.width, inspected.height, "1:1"), true);
  }

  // Malformed responses fail closed
  for (const body of [{}, { data: [] }, { data: [{}] }, { data: [{ b64_json: null }] }]) {
    assert.throws(() => findOpenRouterOutputImage(body), (e) => e instanceof MediaError && e.code === "malformed_response");
  }

  // Generate route still re-sniffs before storage (provider declaration never wins).
  assert.match(generateRoute, /result\.mimeType = inspected\.mimeType;/);
  assert.match(generateRoute, /inspectImageBytes\(result\.bytes\)/);
  assert.match(generateRoute, /const extension = result\.mimeType === "image\/png" \? "png" : result\.mimeType === "image\/webp" \? "webp" : "jpg"/);

  // Provider source names b64_json and media_type explicitly.
  assert.match(openRouterSource, /b64_json/);
  assert.match(openRouterSource, /media_type/);
  assert.match(providerSource, /function findOpenRouterOutputImage/);
});

test("generated OpenRouter bytes pass Voom's byte-level checks for every Post and Story format", () => {
  const sizes = { "1:1": [1024, 1024], "4:5": [1080, 1350], "9:16": [1080, 1920] };
  for (const [format, [width, height]] of Object.entries(sizes)) {
    const bytes = viaProviderBase64(jpeg(width, height));
    const inspected = insp.inspectImageBytes(bytes);
    assert.deepEqual(inspected, { mimeType: "image/jpeg", width, height });
    assert.equal(insp.aspectMatches(inspected.width, inspected.height, format), true, `the ${format} draft accepts its own frame`);
  }
});

// ---------------------------------------------------------------------------
// 4. Errors: retryable vs fail-fast, no silent paid retries
// ---------------------------------------------------------------------------

test("OpenRouter error classification preserves diagnostics; 429/5xx retryable; no silent retries", () => {
  // Shared jsonRequest classification used by every provider including OpenRouter.
  assert.match(providerSource, /response\.status === 429 \? "rate_limited" : response\.status >= 500 \? "unavailable" : "rejected"/);
  assert.match(providerSource, /parseProviderDiagnostic\(response\)/);
  assert.doesNotMatch(providerSource, /for \(let .*retry|attempt < |retryAfter|setTimeout/);

  // OpenRouter adapter itself never retries and never logs the key.
  assert.doesNotMatch(openRouterSource, /for\s*\(.*retry|attempt\s*<|retryAfter|setTimeout|while\s*\(/);
  assert.doesNotMatch(openRouterSource, /console\.log|console\.error|console\.warn/);
  assert.doesNotMatch(openRouterSource, /JSON\.stringify\(\s*this\.config/);
  assert.match(openRouterSource, /Authorization: `Bearer \$\{this\.config\.apiKey\}`/);

  // Image-only: video methods fail closed without network.
  assert.match(openRouterSource, /async generateVideo[\s\S]*throw new MediaError\("unsupported_input"\)/);
  assert.match(openRouterSource, /async pollVideo[\s\S]*throw new MediaError\("unsupported_input"\)/);
});

// ---------------------------------------------------------------------------
// 5. Gemini / OpenAI remain intact; Magic Hour / video untouched
// ---------------------------------------------------------------------------

test("existing Gemini and OpenAI provider implementations remain intact", () => {
  assert.match(geminiSource, /class GeminiMediaProvider/);
  assert.match(geminiSource, /\$\{this\.config\.baseUrl\}\/interactions/);
  assert.match(geminiSource, /mime_type: "image\/jpeg"/);
  assert.match(geminiSource, /"x-goog-api-key": this\.config\.apiKey/);

  assert.match(openAiSource, /class OpenAiMediaProvider/);
  assert.match(openAiSource, /\$\{this\.config\.baseUrl\}\/images\/generations/);
  assert.match(openAiSource, /response_format: "b64_json"/);
  assert.match(openAiSource, /return decodeMedia\(data, "image\/png"\)/);

  assert.doesNotMatch(openAiSource, /class OpenRouterMediaProvider/);
  assert.doesNotMatch(geminiSource, /openrouter|seedream/i);
});

test("video / Magic Hour configuration is independent of OpenRouter image provider", () => {
  const mh = videoConfig.getVideoConfig(bareEnv({
    VIDEO_PROVIDER: "magic-hour",
    VIDEO_API_KEY: "mh-test",
    MEDIA_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "or-test",
  }));
  assert.equal(mh.provider, "magic-hour");
  assert.equal(mh.apiKey, "mh-test");
  assert.equal(mh.supportsImageToVideo, true);

  // OpenRouter alone does not become a video provider.
  assert.throws(
    () => videoConfig.getVideoConfig(bareEnv({
      MEDIA_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "or-test",
    })),
    (e) => e instanceof MediaError && e.code === "not_configured",
  );

  // gemini media inheritance still works when not on OpenRouter.
  const inherited = videoConfig.getVideoConfig(bareEnv({
    MEDIA_PROVIDER: "gemini",
    MEDIA_API_KEY: "sk-media",
    MEDIA_IMAGE_MODEL: "img",
    MEDIA_VIDEO_MODEL: "vid",
  }));
  assert.equal(inherited.provider, "gemini");
  assert.equal(inherited.apiKey, "sk-media");
});
