/**
 * Brand Kit v2 slice 5: logo, product photos and past posts, with vision.
 *
 *   1. Paths: every file sits in the owner's own folder; anything else is refused.
 *   2. The reference list is validated and capped (1 logo, 10 products, 5 posts).
 *   3. List edits: MARA's reading never overwrites what the owner typed.
 *   4. Colours are computed by code from the logo's pixels (fixture images).
 *   5. Vision: config, schema, prompt rules, one small JPEG per call.
 *   6. Upload / remove / describe routes: auth, real bytes, size, ownership,
 *      rate limits, saved images protected, nothing stored by describe.
 *   7. Versions carry images forward unless a save owns them.
 *   8. Onboarding Finish saves only own images, and fills the email brand only where empty.
 *   9. Brand page save: foreign paths refused, removed files deleted.
 *  10. Prompts: a visual style only when there is one; paths never leak.
 *  11. Screens: the onboarding images screen, the disclaimer, the Brand page gallery.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import { importApp, react, renderToStaticMarkup } from "./helpers/rendered-surface.mjs";

const { createElement: h } = react;
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const FAKE_AI = `
export class AiError extends Error { constructor(code, message) { super(message ?? code); this.name = "AiError"; this.code = code; } }
export function createAiProvider() { throw new AiError("not_configured"); }
export function createAiVisionProvider() { return globalThis.__VOOM_FAKE_VISION__(); }
export function isAiVisionConfigured() { return Boolean(globalThis.__VOOM_VISION_ON__); }
globalThis.__VOOM_FAKE_AI_ERROR__ = AiError;
`;

// Registered AFTER the rendered-surface helper so these exact specifiers win.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/utils/supabase/server") {
      return { url: `data:text/javascript,${encodeURIComponent("export async function createClient() { return globalThis.__VOOM_FAKE_SUPABASE__; }")}`, shortCircuit: true };
    }
    if (specifier === "@/utils/supabase/admin") {
      return { url: `data:text/javascript,${encodeURIComponent("export function createAdminClient() { if (!globalThis.__VOOM_FAKE_ADMIN__) throw new Error('supabase_admin_not_configured'); return globalThis.__VOOM_FAKE_ADMIN__; }")}`, shortCircuit: true };
    }
    if (specifier === "@/lib/ai") {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_AI)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const sharp = (await import("sharp")).default;
const assets = await importApp("lib/brand/assets.ts");
const image = await importApp("lib/brand/image.ts");
const vision = await importApp("lib/brand/vision.ts");
const aiConfig = await importApp("lib/ai/config.ts");
const versions = await importApp("lib/brand/versions.ts");
const context = await importApp("lib/brand/context.ts");
const sections = await importApp("lib/brand/sections.ts");
const emailSync = await importApp("lib/brand/email-sync.ts");
const storage = await importApp("lib/brand/asset-storage.ts");
const uploadRoute = await importApp("app/api/brand/assets/route.ts");
const describeRoute = await importApp("app/api/brand/assets/describe/route.ts");
const { saveOnboarding } = await importApp("lib/voom/mutations.ts");
const { saveBrandSection } = await importApp("lib/brand/actions.ts");
const { BrandHub } = await importApp("components/voom/brand/BrandHub.tsx");
const { BrandAssetsEditor, PAST_POST_DISCLAIMER, VISION_PRIVACY_NOTE } = await importApp("components/voom/brand/BrandAssetsEditor.tsx");
const rateLimit = await importApp("lib/rate-limit.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const asset = (kind, n, extra = {}) => ({
  id: uuid(n), kind, path: `${OWNER}/${kind}/${uuid(n)}.png`, mimeType: "image/png", byteSize: 1234,
  description: "", chips: [], look: "", describedBy: "", ...extra,
});

/* ── Fixtures ────────────────────────────────────────────────────────────── */

/** 80x80: a 10 px border (white or transparent), red on the left three quarters, blue on the right. */
async function logoPng({ border = "white" } = {}) {
  const w = 80;
  const hgt = 80;
  const buf = Buffer.alloc(w * hgt * 4);
  for (let y = 0; y < hgt; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const edge = x < 10 || y < 10 || x >= 70 || y >= 70;
      const [r, g, b, a] = edge ? (border === "white" ? [255, 255, 255, 255] : [0, 0, 0, 0]) : x < 55 ? [200, 30, 40, 255] : [20, 60, 200, 255];
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  return new Uint8Array(await sharp(buf, { raw: { width: w, height: hgt, channels: 4 } }).png().toBuffer());
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/* ── Fakes ───────────────────────────────────────────────────────────────── */

function login(sub = OWNER) {
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    auth: { getClaims: async () => (sub ? { data: { claims: { sub, email: "owner@example.com" } }, error: null } : { data: null, error: { message: "no session" } }) },
    from() { throw new Error("unexpected user-scoped table read"); },
  };
}

function fakeAdmin({ rateOk = true, newestAssets = [], emailBrand = null } = {}) {
  const calls = { uploads: [], removes: [], rpcs: [], downloads: [] };
  const objects = new Map();
  const rpcResult = (name, args) => {
    calls.rpcs.push({ name, args });
    if (name === "consume_rate_limit") return { data: rateOk, error: null };
    if (name === "create_email_asset") return { data: { id: "email-asset-1", public_path: args.p_payload.publicPath }, error: null };
    if (name === "upsert_email_brand") return { data: {}, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  };
  const admin = {
    rpc(name, args) {
      const result = rpcResult(name, args);
      return { single: async () => result, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
    },
    storage: {
      from(bucket) {
        return {
          upload: async (path, bytes, options) => { objects.set(`${bucket}/${path}`, bytes); calls.uploads.push({ bucket, path, contentType: options?.contentType }); return { data: { path }, error: null }; },
          download: async (path) => { calls.downloads.push({ bucket, path }); const b = objects.get(`${bucket}/${path}`); return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "not found" } }; },
          remove: async (paths) => { calls.removes.push({ bucket, paths }); for (const p of paths) objects.delete(`${bucket}/${p}`); return { data: [], error: null }; },
          list: async (prefix) => ({ data: [...objects.keys()].filter((key) => key.startsWith(`${bucket}/${prefix}/`)).map((key) => ({ name: key.slice(`${bucket}/${prefix}/`.length) })), error: null }),
          createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}?token=t`, error: null })), error: null }),
        };
      },
    },
    from(table) {
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => {
          if (table === "brand_kits") return { data: { assets: newestAssets }, error: null };
          if (table === "voom_email_brands") return { data: emailBrand, error: null };
          if (table === "businesses") return { data: { brand_name: "Bean & Co." }, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  };
  globalThis.__VOOM_FAKE_ADMIN__ = admin;
  return { admin, calls, objects };
}

function uploadRequest(kind, bytes, name = "logo.png") {
  const form = new FormData();
  if (kind) form.set("kind", kind);
  if (bytes) form.set("file", new File([bytes], name, { type: "image/png" }));
  return new Request("http://localhost/api/brand/assets", { method: "POST", body: form });
}
const jsonRequest = (url, method, body) => new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const quietly = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

/* ── 1. Paths ────────────────────────────────────────────────────────────── */

test("every file path sits in the owner's own folder; anything else is refused", () => {
  const path = assets.brandAssetPath(OWNER, "logo", uuid(1), "png");
  assert.equal(path, `${OWNER}/logo/${uuid(1)}.png`);
  assert.equal(assets.isOwnBrandAssetPath(OWNER, path), true);
  assert.equal(assets.isOwnBrandAssetPath(OWNER, path, "logo"), true);
  assert.equal(assets.isOwnBrandAssetPath(OWNER, path, "product"), false, "the kind must match");
  assert.equal(assets.isOwnBrandAssetPath(OTHER, path), false, "another owner's folder");
  for (const bad of [`${OWNER}/../${OTHER}/logo/${uuid(1)}.png`, `${OWNER}/logo/${uuid(1)}.gif`, `${OWNER}/videos/${uuid(1)}.png`, `/${OWNER}/logo/${uuid(1)}.png`, 42, null]) {
    assert.equal(assets.isOwnBrandAssetPath(OWNER, bad), false, `refused: ${String(bad)}`);
  }
  assert.equal(assets.BRAND_KIT_BUCKET, "brand-kit", "the private bucket from migration 0059");
});

/* ── 2. The reference list ───────────────────────────────────────────────── */

test("the image list is validated and capped: 1 logo, 10 products, 5 past posts; chips only on posts, only from the list", () => {
  const raw = [
    asset("logo", 1), asset("logo", 2),
    ...Array.from({ length: 12 }, (_, i) => asset("product", 10 + i, { chips: ["Bright"], look: "should go" })),
    ...Array.from({ length: 6 }, (_, i) => asset("past_post", 30 + i, { chips: ["Bright", "Sassy", "Bright"], look: "Warm light" })),
    asset("product", 10),
  ];
  const clean = assets.cleanBrandAssets(raw);
  assert.equal(clean.filter((a) => a.kind === "logo").length, 1);
  assert.equal(clean.filter((a) => a.kind === "product").length, 10);
  assert.equal(clean.filter((a) => a.kind === "past_post").length, 5);
  assert.deepEqual(clean.find((a) => a.kind === "product").chips, [], "products carry no chips");
  assert.equal(clean.find((a) => a.kind === "product").look, "");
  assert.deepEqual(clean.find((a) => a.kind === "past_post").chips, ["Bright"], "unknown and repeated chips dropped");
  assert.equal(new Set(clean.map((a) => a.path)).size, clean.length, "no path twice");

  assert.equal(assets.cleanBrandAssets([{ ...asset("logo", 1), path: "elsewhere/x.png" }]), null, "one malformed entry refuses the list");
  assert.equal(assets.cleanBrandAssets("nope"), null);
  assert.deepEqual(assets.cleanBrandAssets([{ ...asset("logo", 1), description: "x".repeat(300) }])[0].description.length, 120);

  assert.deepEqual(assets.cleanBrandColours({ primary: "#c81e28", secondary: "nope", source: "logo" }), { primary: "#C81E28", secondary: null, source: "logo" });
  assert.equal(assets.cleanBrandColours({ primary: "red" }), null);
  assert.equal(assets.describeBrandAssets(clean), "logo, 10 product photos, 5 past posts");
  assert.equal(assets.describeBrandAssets([]), "nothing");
});

/* ── 3. List edits ───────────────────────────────────────────────────────── */

test("MARA's reading never overwrites what the owner typed; the owner's edit always wins", () => {
  let list = assets.withAddedAsset([], asset("past_post", 1));
  assert.equal(assets.withAddedAsset([asset("logo", 1)], asset("logo", 2)).length, 1, "a second logo is not added");
  list = assets.withAssetText(list, list[0].path, { description: "Iced latte", chips: ["Bright", "Sassy"], look: "Warm light" }, "mara");
  assert.equal(list[0].describedBy, "mara");
  assert.deepEqual(list[0].chips, ["Bright"]);
  list = assets.withAssetText(list, list[0].path, { description: "Our iced latte" }, "owner");
  assert.equal(list[0].describedBy, "owner");
  const late = assets.withAssetText(list, list[0].path, { description: "Something else" }, "mara");
  assert.equal(late[0].description, "Our iced latte", "a late reading leaves the owner's words alone");
  assert.equal(assets.withAssetText(list, list[0].path, { description: "", chips: [], look: "" }, "owner")[0].describedBy, "", "empty text belongs to nobody");
  assert.equal(assets.withoutAsset(list, list[0].path).length, 0);

  const computed = { primary: "#C81E28", secondary: "#143CC8" };
  assert.deepEqual(assets.coloursAfterLogo(null, computed), { ...computed, source: "logo" });
  const picked = { primary: "#000000", secondary: null, source: "owner" };
  assert.equal(assets.coloursAfterLogo(picked, computed), picked, "colours the owner picked are never replaced");
});

/* ── 4. Colours by code ──────────────────────────────────────────────────── */

test("the two brand colours are computed from the logo's pixels, ignoring white and transparent backgrounds", async () => {
  for (const border of ["white", "transparent"]) {
    const colours = await image.computeLogoColours(await logoPng({ border }));
    const [r1, g1, b1] = rgb(colours.primary);
    const [r2, , b2] = rgb(colours.secondary);
    assert.ok(r1 > 150 && g1 < 90 && b1 < 90, `primary is the red (${border} border): ${colours.primary}`);
    assert.ok(b2 > 150 && r2 < 90, `secondary is the blue (${border} border): ${colours.secondary}`);
  }
  const white = new Uint8Array(await sharp({ create: { width: 40, height: 40, channels: 3, background: "#ffffff" } }).png().toBuffer());
  assert.deepEqual(await image.computeLogoColours(white), { primary: null, secondary: null }, "an all-white image has no colours");
  const black = new Uint8Array(await sharp({ create: { width: 40, height: 40, channels: 3, background: "#000000" } }).png().toBuffer());
  assert.deepEqual(await image.computeLogoColours(black), { primary: "#000000", secondary: null }, "black logos keep black");
});

test("the copy sent to the vision model is a small JPEG, never the original", async () => {
  const big = new Uint8Array(await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 10, g: 120, b: 60, alpha: 0.5 } } }).png().toBuffer());
  const small = await image.downscaleForVision(big);
  const meta = await sharp(Buffer.from(small)).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(Math.max(meta.width, meta.height), image.VISION_MAX_EDGE);
  assert.ok(small.byteLength < big.byteLength);
});

/* ── 5. Vision ───────────────────────────────────────────────────────────── */

test("image reading is a separate, optional model: off until AI_VISION_MODEL is set, keys never borrowed across providers", () => {
  assert.equal(aiConfig.isAiVisionConfigured({ AI_PROVIDER: "groq", AI_API_KEY: "k", AI_MODEL: "m" }), false, "off by default");
  const groq = aiConfig.getAiVisionConfig({ AI_PROVIDER: "groq", AI_API_KEY: "groq-key", AI_VISION_MODEL: "meta-llama/llama-4-scout-17b-16e-instruct" });
  assert.deepEqual([groq.provider, groq.apiKey, groq.baseUrl], ["groq", "groq-key", "https://api.groq.com/openai/v1"], "same provider reuses the text key");
  const openrouter = aiConfig.getAiVisionConfig({ AI_PROVIDER: "groq", AI_API_KEY: "groq-key", AI_VISION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-key", AI_VISION_MODEL: "google/gemini-2.5-flash" });
  assert.deepEqual([openrouter.provider, openrouter.apiKey, openrouter.baseUrl], ["openrouter", "or-key", "https://openrouter.ai/api/v1"]);
  assert.equal(openrouter.requestTimeoutMs, aiConfig.DEFAULT_AI_VISION_TIMEOUT_MS);
  assert.equal(aiConfig.isAiVisionConfigured({ AI_PROVIDER: "groq", AI_API_KEY: "groq-key", AI_VISION_PROVIDER: "openai", AI_VISION_MODEL: "gpt-4o-mini" }), false, "the Groq key is never sent to another provider");
});

test("the reading prompt allows only what is visible, never identifies people, and limits chips to our list", async () => {
  const prompt = vision.BRAND_VISION_SYSTEM_PROMPT;
  assert.match(prompt, /Describe only what is visible/);
  assert.match(prompt, /Never identify or name a person/);
  assert.match(prompt, /age, ethnicity, religion, health/);
  for (const chip of assets.PAST_POST_CHIPS) assert.ok(prompt.includes(`"${chip}"`));
  const schema = vision.brandImageReadingJsonSchema;
  assert.equal(schema.strict, true);
  assert.deepEqual(schema.schema.required, ["description", "chips", "look"]);
  assert.deepEqual(schema.schema.properties.chips.items.enum, [...assets.PAST_POST_CHIPS]);

  const seen = [];
  const provider = { structured: async (request) => { seen.push(request); return request.parse({ description: "  Iced latte in a tall glass  ", chips: ["Bright", "Sassy", "Warm tones"], look: "Warm light" }); } };
  const post = await vision.describeBrandImage(provider, { kind: "past_post", jpeg: new Uint8Array([0xff, 0xd8, 0xff, 1, 2]) });
  assert.deepEqual(post, { description: "Iced latte in a tall glass", chips: ["Bright", "Warm tones"], look: "Warm light" }, "an off-list chip is dropped, not fatal");
  const [request] = seen;
  assert.equal(request.messages[1].content[1].type, "image_url");
  assert.match(request.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(JSON.parse(request.messages[1].content[0].text), { kind: "past_post" });
  assert.equal(request.maxAttempts, 2);
  assert.equal(request.jsonSchema, vision.brandImageReadingJsonSchema);
  const product = await vision.describeBrandImage(provider, { kind: "product", jpeg: new Uint8Array([0xff, 0xd8, 0xff]) });
  assert.deepEqual(product, { description: "Iced latte in a tall glass", chips: [], look: "" }, "products carry no chips or look");
});

/* ── 6. Routes ───────────────────────────────────────────────────────────── */

test("upload: logged in, real image bytes, 10 MB, a known kind; stored unchanged in the owner's folder with a preview link", async () => {
  const logo = await logoPng();
  login(null);
  fakeAdmin();
  assert.equal((await uploadRoute.POST(uploadRequest("logo", logo))).status, 401);

  login();
  let { calls } = fakeAdmin();
  assert.equal((await uploadRoute.POST(uploadRequest("banner", logo))).status, 400, "unknown kind");
  assert.equal((await uploadRoute.POST(uploadRequest("logo", new TextEncoder().encode("<svg>not an image</svg>")))).status, 400, "bytes are checked, not the name");
  const tooBig = new Uint8Array(assets.BRAND_ASSET_LIMITS.maxBytes + 1);
  assert.equal((await uploadRoute.POST(uploadRequest("product", tooBig))).status, 413);
  assert.equal(calls.uploads.length, 0, "nothing stored for refused files");

  ({ calls } = fakeAdmin());
  const response = await uploadRoute.POST(uploadRequest("logo", logo));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(assets.isOwnBrandAssetPath(OWNER, body.asset.path, "logo"));
  assert.equal(body.asset.mimeType, "image/png");
  assert.equal(body.asset.byteSize, logo.byteLength);
  assert.deepEqual([calls.uploads[0].bucket, calls.uploads[0].path, calls.uploads[0].contentType], ["brand-kit", body.asset.path, "image/png"]);
  assert.match(body.previewUrl, /^https:\/\/signed\.example\//);
  assert.ok(rgb(body.colours.primary)[0] > 150, "a logo comes back with its computed colours");
  assert.ok(calls.rpcs.some((call) => call.name === "consume_rate_limit" && call.args.p_bucket === "brand_asset_upload"));

  const product = await (await uploadRoute.POST(uploadRequest("product", logo))).json();
  assert.equal(product.colours, null, "only a logo gets colours");

  fakeAdmin({ rateOk: false });
  assert.equal((await uploadRoute.POST(uploadRequest("logo", logo))).status, 429);
  assert.deepEqual(rateLimit.AI_RATE_LIMITS.brand_asset_upload, { limit: 60, windowSeconds: 3600 });
  assert.deepEqual(rateLimit.AI_RATE_LIMITS.brand_vision, { limit: 40, windowSeconds: 3600 });
});

test("remove: only the owner's own unsaved uploads; images in the saved kit are protected", async () => {
  login();
  const saved = asset("logo", 1);
  let { calls } = fakeAdmin({ newestAssets: [saved] });
  assert.equal((await uploadRoute.DELETE(jsonRequest("/api/brand/assets", "DELETE", { path: `${OTHER}/logo/${uuid(9)}.png` }))).status, 404);
  assert.equal((await uploadRoute.DELETE(jsonRequest("/api/brand/assets", "DELETE", { path: saved.path }))).status, 409);
  assert.equal(calls.removes.length, 0);
  const unsaved = asset("product", 2);
  assert.equal((await uploadRoute.DELETE(jsonRequest("/api/brand/assets", "DELETE", { path: unsaved.path }))).status, 200);
  assert.deepEqual(calls.removes, [{ bucket: "brand-kit", paths: [unsaved.path] }]);
});

test("describe: off without a vision model (no limit spent), own files only, one small JPEG, nothing stored", async () => {
  const logo = await logoPng();
  login();
  let { calls, objects } = fakeAdmin();
  const path = `${OWNER}/past_post/${uuid(5)}.png`;
  objects.set(`brand-kit/${path}`, logo);

  globalThis.__VOOM_FAKE_VISION__ = () => { throw new globalThis.__VOOM_FAKE_AI_ERROR__("not_configured"); };
  let body = await (await describeRoute.POST(jsonRequest("/api/brand/assets/describe", "POST", { path, kind: "past_post" }))).json();
  assert.deepEqual(body, { ok: false, reason: "not_configured" });
  assert.equal(calls.rpcs.length, 0, "an account without image reading spends no limit");

  assert.equal((await describeRoute.POST(jsonRequest("/api/brand/assets/describe", "POST", { path: `${OTHER}/past_post/${uuid(5)}.png`, kind: "past_post" }))).status, 404);
  assert.equal((await describeRoute.POST(jsonRequest("/api/brand/assets/describe", "POST", { path, kind: "logo" }))).status, 404, "the kind must match the folder");

  const sent = [];
  globalThis.__VOOM_FAKE_VISION__ = () => ({ structured: async (request) => { sent.push(request); return request.parse({ description: "Pour-over on the counter", chips: ["Warm tones"], look: "Soft light" }); } });
  body = await (await describeRoute.POST(jsonRequest("/api/brand/assets/describe", "POST", { path, kind: "past_post" }))).json();
  assert.deepEqual(body, { ok: true, reading: { description: "Pour-over on the counter", chips: ["Warm tones"], look: "Soft light" } });
  assert.ok(calls.rpcs.some((call) => call.args.p_bucket === "brand_vision"));
  const sentJpeg = Buffer.from(sent[0].messages[1].content[1].image_url.url.split(",")[1], "base64");
  assert.equal((await sharp(sentJpeg).metadata()).format, "jpeg", "a re-encoded copy, not the PNG original");
  assert.equal(calls.uploads.length, 0, "describing stores nothing");

  globalThis.__VOOM_FAKE_VISION__ = () => ({ structured: async () => { throw new globalThis.__VOOM_FAKE_AI_ERROR__("unavailable"); } });
  body = await quietly(async () => (await describeRoute.POST(jsonRequest("/api/brand/assets/describe", "POST", { path, kind: "past_post" }))).json());
  assert.deepEqual(body, { ok: false, reason: "unavailable" }, "a failed reading leaves the line for the owner");
});

/* ── 7. Versions ─────────────────────────────────────────────────────────── */

function fakeUserDb(newestRow = null) {
  const calls = { kitInserts: [], upserts: [], businessUpdates: [] };
  const chain = () => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: newestRow, error: null }) }; return q; };
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    auth: { getClaims: async () => ({ data: { claims: { sub: OWNER, email: "owner@example.com" } }, error: null }) },
    from(table) {
      if (table === "brand_kits") { const q = chain(); q.insert = async (row) => { calls.kitInserts.push(row); return { error: null }; }; return q; }
      if (table === "businesses") {
        return {
          upsert: async (payload) => { calls.upserts.push({ table, payload }); return { error: null }; },
          update: (payload) => { calls.businessUpdates.push(payload); const u = { eq: () => u, then: (resolve) => resolve({ error: null }) }; return u; },
        };
      }
      return { upsert: async (payload) => { calls.upserts.push({ table, payload }); return { error: null }; } };
    },
  };
  return calls;
}

test("versions carry the images forward unless a save owns them; replacing them is recorded", async () => {
  const kept = [asset("logo", 1)];
  let calls = fakeUserDb({ version: 2, answers: { name: "Bean & Co." }, brief: "B.", assets: kept });
  await versions.appendBrandKitVersion(globalThis.__VOOM_FAKE_SUPABASE__, OWNER, { source: "brand_hub", answers: { name: "Bean & Co." } });
  assert.deepEqual(calls.kitInserts[0].assets, kept, "a save that does not own the images keeps them");
  assert.equal(calls.kitInserts[0].changed_keys.includes("assets"), false);

  calls = fakeUserDb({ version: 2, answers: {}, brief: null, assets: kept });
  await versions.appendBrandKitVersion(globalThis.__VOOM_FAKE_SUPABASE__, OWNER, { source: "brand_hub", answers: {}, assets: [] });
  assert.deepEqual(calls.kitInserts[0].assets, [], "owning them replaces the whole list");
  assert.deepEqual(calls.kitInserts[0].changed_keys, ["assets"]);
});

/* ── 8. Onboarding Finish ────────────────────────────────────────────────── */

function onboardingInput(kit) {
  return {
    displayName: "Alex", brandName: "Bean & Co.", brandDescription: "We roast our own beans.", industry: "Restaurant / Café",
    targetCustomer: [], mainGoal: "More walk-in customers", brandPersonality: [], preferredChannels: ["Instagram"],
    monthlyAdBudget: "", contentFrequency: "2–3 times a week", automationLevel: "manual", publishingPermission: "", website: "",
    kit: { brief: "", offerings: [], rules: [], words: [], notes: "", facts: [], ...kit },
  };
}

test("Finish saves only the owner's own images, and fills the email brand only where it is empty", async () => {
  const logo = { ...asset("logo", 1), description: "Bean logo", describedBy: "mara" };
  const foreign = { ...asset("product", 2), path: `${OTHER}/product/${uuid(2)}.png` };
  const colours = { primary: "#C81E28", secondary: "#143CC8", source: "logo" };
  let calls = fakeUserDb(null);
  let admin = fakeAdmin({ emailBrand: null });
  admin.objects.set(`brand-kit/${logo.path}`, await logoPng());
  assert.deepEqual(await saveOnboarding(onboardingInput({ assets: [logo, foreign], colours })), { ok: true });
  const kit = calls.kitInserts[0];
  assert.deepEqual(kit.assets, [logo], "another owner's path is dropped");
  assert.deepEqual(kit.answers.colours, colours);
  const upsert = admin.calls.rpcs.find((call) => call.name === "upsert_email_brand");
  assert.deepEqual(upsert.args.p_payload, { logoAssetId: "email-asset-1", primaryColor: "#C81E28", secondaryColor: "#143CC8" });
  assert.ok(admin.calls.uploads.some((u) => u.bucket === "voom-email-assets"), "the logo is copied to the public email bucket");

  // Email identity already set by the owner: nothing is replaced.
  calls = fakeUserDb(null);
  admin = fakeAdmin({ emailBrand: { logo_asset_id: "mine", primary_color: "#111111", secondary_color: null } });
  admin.objects.set(`brand-kit/${logo.path}`, await logoPng());
  await saveOnboarding(onboardingInput({ assets: [logo], colours }));
  assert.deepEqual(admin.calls.rpcs.find((call) => call.name === "upsert_email_brand").args.p_payload, { secondaryColor: "#143CC8" }, "only the empty field is filled");
  assert.equal(admin.calls.rpcs.some((call) => call.name === "create_email_asset"), false, "no second email logo");

  // No uploads: the kit carries earlier images over and email is not touched.
  calls = fakeUserDb({ version: 1, answers: {}, brief: null, assets: [logo] });
  admin = fakeAdmin();
  await saveOnboarding(onboardingInput({}));
  assert.deepEqual(calls.kitInserts[0].assets, [logo]);
  assert.equal(admin.calls.rpcs.some((call) => call.name === "upsert_email_brand"), false);
});

/* ── 8b. Leftover files and colours without a logo (fixes 2026-10-28) ───── */

test("the sweep deletes only the owner's files that the kit does not reference", async () => {
  const keep = asset("logo", 1);
  const orphanProduct = asset("product", 2);
  const orphanPost = asset("past_post", 3);
  const { admin, calls, objects } = fakeAdmin();
  for (const a of [keep, orphanProduct, orphanPost]) objects.set(`brand-kit/${a.path}`, new Uint8Array([1]));
  objects.set(`brand-kit/${OTHER}/logo/${uuid(4)}.png`, new Uint8Array([1]));
  objects.set(`brand-kit/${OWNER}/logo/notes.txt`, new Uint8Array([1]));
  await storage.removeUnreferencedBrandAssets(admin, OWNER, [keep.path]);
  assert.deepEqual(calls.removes, [{ bucket: "brand-kit", paths: [orphanProduct.path, orphanPost.path] }], "the kept file, another owner's folder and a file that is not an image path are left alone");
  assert.ok(objects.has(`brand-kit/${keep.path}`));
  assert.ok(objects.has(`brand-kit/${OTHER}/logo/${uuid(4)}.png`));

  // Nothing to delete: no remove call at all.
  const quiet = fakeAdmin();
  quiet.objects.set(`brand-kit/${keep.path}`, new Uint8Array([1]));
  await storage.removeUnreferencedBrandAssets(quiet.admin, OWNER, [keep.path]);
  assert.deepEqual(quiet.calls.removes, []);
});

test("Finish deletes the images a restarted onboarding replaced and any abandoned upload; a run with no uploads keeps everything", async () => {
  const oldLogo = asset("logo", 1);
  const newLogo = asset("logo", 5);
  const abandoned = asset("product", 6);
  let calls = fakeUserDb({ version: 1, answers: { colours: { primary: "#111111", secondary: null, source: "logo" } }, brief: null, assets: [oldLogo] });
  let admin = fakeAdmin();
  for (const a of [oldLogo, newLogo, abandoned]) admin.objects.set(`brand-kit/${a.path}`, await logoPng());
  assert.deepEqual(await saveOnboarding(onboardingInput({ assets: [newLogo] })), { ok: true });
  assert.deepEqual(calls.kitInserts[0].assets, [newLogo]);
  assert.equal(calls.kitInserts[0].answers.colours, null, "a replaced logo with no computed colours clears the old logo's colours");
  const swept = admin.calls.removes.flatMap((call) => call.paths).sort();
  assert.deepEqual(swept, [oldLogo.path, abandoned.path].sort(), "the replaced logo and the abandoned upload are deleted");
  assert.ok(admin.objects.has(`brand-kit/${newLogo.path}`), "the new logo stays");

  // No uploads: the old images carry forward and nothing is deleted.
  calls = fakeUserDb({ version: 1, answers: {}, brief: null, assets: [oldLogo] });
  admin = fakeAdmin();
  admin.objects.set(`brand-kit/${oldLogo.path}`, await logoPng());
  await saveOnboarding(onboardingInput({}));
  assert.deepEqual(calls.kitInserts[0].assets, [oldLogo]);
  assert.deepEqual(admin.calls.removes, []);
  assert.equal("colours" in calls.kitInserts[0].answers, false, "no uploads: colours carry forward too");

  const source = await read("lib/voom/mutations.ts");
  assert.match(source, /if \(appended\) await sweepOnboardingBrandAssets/, "the sweep runs only once the version is really saved");
});

test("removing the logo drops the colours computed from it and keeps colours the owner picked", async () => {
  assert.equal(assets.coloursAfterLogoRemoved({ primary: "#111111", secondary: "#222222", source: "logo" }), null);
  const picked = { primary: "#111111", secondary: null, source: "owner" };
  assert.deepEqual(assets.coloursAfterLogoRemoved(picked), picked);
  assert.equal(assets.coloursAfterLogoRemoved(null), null);

  const store = await read("lib/voom/store.tsx");
  assert.match(store, /const wasLogo = o\.assets\.some\(\(asset\) => asset\.path === path && asset\.kind === "logo"\);\s*return \{ \.\.\.s, onboard: \{ \.\.\.o, assets: withoutAsset\(o\.assets, path\), colours: wasLogo \? coloursAfterLogoRemoved\(o\.colours\) : o\.colours \} \};/, "onboarding");
  const hub = await read("components/voom/brand/BrandHub.tsx");
  assert.match(hub, /colours: wasLogo \? coloursAfterLogoRemoved\(prev\.colours\) : prev\.colours/, "Brand page");

  // The version rule: a run that replaces the images owns the colours too.
  const base = onboardingInput({});
  const withLogo = versions.brandKitAnswersFromOnboarding({ ...base, kit: { ...base.kit, assets: [asset("logo", 1)], colours: { primary: "#111111", secondary: null, source: "logo" } } });
  assert.deepEqual(withLogo.colours, { primary: "#111111", secondary: null, source: "logo" });
  const productsOnly = versions.brandKitAnswersFromOnboarding({ ...base, kit: { ...base.kit, assets: [asset("product", 2)] } });
  assert.equal(productsOnly.colours, null, "images replaced, no logo: the old computed colours clear");
  const nothing = versions.brandKitAnswersFromOnboarding(base);
  assert.equal("colours" in nothing, false, "no uploads: carried forward");
});

test("the email fill is best-effort: a failure never fails the save", async () => {
  const { admin } = fakeAdmin();
  admin.from = () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { message: "no table" } }) }; return q; };
  const outcome = await quietly(() => emailSync.syncBrandToEmail(admin, OWNER, { assets: [asset("logo", 1)], colours: null, brandName: "Bean" }));
  assert.equal(outcome, "failed");
  assert.equal(await emailSync.syncBrandToEmail(admin, OWNER, { assets: [], colours: null, brandName: "Bean" }), "skipped");
});

/* ── 9. Brand page save ──────────────────────────────────────────────────── */

test("the Brand page images save refuses foreign paths, deletes removed files and records the new list", async () => {
  const logo = asset("logo", 1);
  const product = { ...asset("product", 2), description: "Iced latte" };
  fakeUserDb({ version: 3, answers: { name: "Bean & Co." }, brief: "B.", assets: [logo, product] });
  fakeAdmin();
  const foreign = await saveBrandSection("assets", { assets: [{ ...logo, path: `${OTHER}/logo/${uuid(1)}.png` }], colours: null });
  assert.deepEqual(foreign, { ok: false, error: "One of those images is not in your brand kit. Remove it and try again." });

  const calls = fakeUserDb({ version: 3, answers: { name: "Bean & Co." }, brief: "B.", assets: [logo, product] });
  const admin = fakeAdmin({ emailBrand: { logo_asset_id: "set", primary_color: "#000000", secondary_color: "#FFFFFF" } });
  const abandoned = asset("past_post", 7);
  for (const a of [logo, product, abandoned]) admin.objects.set(`brand-kit/${a.path}`, new Uint8Array([1]));
  const result = await saveBrandSection("assets", { assets: [product], colours: { primary: "#C81E28", secondary: null, source: "owner" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedKeys, ["colours", "assets"], "the keys that really changed, in the order the row records them (2026-10-27)");
  assert.deepEqual(calls.kitInserts[0].assets, [product]);
  assert.deepEqual(calls.kitInserts[0].answers.colours, { primary: "#C81E28", secondary: null, source: "owner" });
  assert.equal(calls.kitInserts[0].brief, "B.", "the brief carries forward");
  assert.deepEqual(calls.businessUpdates, [], "images never touch businesses");
  assert.deepEqual(admin.calls.removes, [{ bucket: "brand-kit", paths: [logo.path] }, { bucket: "brand-kit", paths: [abandoned.path] }], "the removed logo file is deleted, then the sweep takes an abandoned upload (2026-10-28)");
  assert.ok(admin.objects.has(`brand-kit/${product.path}`), "the kept image stays");
  assert.equal(admin.calls.rpcs.some((call) => call.name === "upsert_email_brand"), false, "email identity already complete: untouched");

  assert.deepEqual(sections.validateBrandSection("assets", { assets: [{ path: "x" }] }), { ok: false, error: "Some of those values are not valid. Shorten or remove them and try again." });
});

/* ── 10. Prompts ─────────────────────────────────────────────────────────── */

test("prompts gain a visual style only when the kit has images or colours, and never a path", () => {
  const row = {
    version: 4, brief: "", answers: { colours: { primary: "#C81E28", secondary: "#143CC8", source: "logo" } },
    assets: [
      { ...asset("logo", 1), description: "Bean above the words Bean & Co." },
      { ...asset("product", 2), description: "Iced latte in a tall glass" },
      { ...asset("past_post", 3), description: "Pour-over", chips: ["Warm tones", "Product close-up"], look: "Soft morning light" },
      { ...asset("past_post", 4), chips: ["Warm tones"] },
    ],
  };
  const kit = context.brandKitExtrasFromRow(row);
  assert.deepEqual(kit.visualStyle, {
    palette: ["#C81E28", "#143CC8"],
    logo: "Bean above the words Bean & Co.",
    products: ["Iced latte in a tall glass"],
    pastPosts: { styleTags: ["Warm tones", "Product close-up"], looks: ["Soft morning light"], subjects: ["Pour-over"] },
  });
  assert.equal(context.brandKitHasContent(kit), true, "images alone are enough for the brand kit block");
  const payload = context.brandKitPromptContext(kit);
  assert.doesNotMatch(JSON.stringify(payload), /brand-kit|\.png|11111111/, "no path, bucket or owner id in a prompt");
  const prompt = context.withBrandKitRules("BASE", payload);
  assert.ok(prompt.includes(context.BRAND_KIT_VISUAL_RULE));

  const textOnly = context.brandKitPromptContext(context.brandKitExtrasFromRow({ version: 1, brief: "A roaster.", answers: {} }));
  assert.equal("visualStyle" in textOnly, false, "a kit without images keeps exactly the old payload");
  assert.equal(context.withBrandKitRules("BASE", textOnly).includes("visualStyle"), false, "and the old rules");
  assert.equal(context.brandKitExtrasFromRow({ version: 1, brief: "", answers: {} }).visualStyle, null);
});

/* ── 11. Screens ─────────────────────────────────────────────────────────── */

test("the images editor shows the past-post disclaimer, and the privacy note only when MARA reads images", () => {
  const props = { assets: [asset("past_post", 1, { description: "Pour-over", chips: ["Bright"], describedBy: "mara" })], colours: null, previews: {}, onAdd() {}, onText() {}, onRemove() {}, onColours() {} };
  const on = renderToStaticMarkup(h(BrandAssetsEditor, { ...props, visionEnabled: true }));
  assert.ok(on.includes(PAST_POST_DISCLAIMER.replace(/'/g, "&#x27;")), "the disclaimer is shown with the past posts");
  assert.ok(on.includes(VISION_PRIVACY_NOTE.replace(/'/g, "&#x27;")));
  assert.match(on, /MARA&#x27;s guess/);
  assert.match(on, /Upload your logo/);
  const off = renderToStaticMarkup(h(BrandAssetsEditor, { ...props, visionEnabled: false }));
  assert.doesNotMatch(off, /sends a small copy/);
  assert.match(off, /Type a line for each image/);
  assert.equal(PAST_POST_DISCLAIMER, "MARA uses these to keep your current look and voice. Only share work you'd be happy to see more of. Anything you upload here shapes the images and captions she creates, so leave out posts that don't represent your brand.");
});

test("onboarding has the images screen second, with the website; the Brand page shows the gallery, onboarding's brief screen does not", async () => {
  const wizard = await read("components/voom/onboarding/OnboardingWizard.tsx");
  assert.match(wizard, /\{st === 1 && <StepAssets visionEnabled=\{visionEnabled\} \/>\}/);
  assert.match(wizard, /Give MARA your brand/);
  const basics = wizard.slice(wizard.indexOf("function StepBasics"), wizard.indexOf("function StepAudienceGoal"));
  assert.doesNotMatch(basics, /onboard\.site/, "the website moved to the images screen");
  assert.match(wizard, /Used in your marketing emails as the website link/);
  const page = await read("app/app/onboarding/page.tsx");
  assert.match(page, /visionEnabled=\{isAiVisionConfigured\(\)\}/);
  const brandPage = await read("app/app/(shell)/brand/page.tsx");
  assert.match(brandPage, /signBrandAssetUrls\(createAdminClient\(\), user\.id/);

  const values = sections.brandHubValues(null, {
    brief: "", answers: { colours: { primary: "#C81E28", secondary: null, source: "logo" } },
    assets: [{ ...asset("logo", 1), description: "Bean logo" }, { ...asset("past_post", 2), chips: ["Bright"], look: "Soft light" }],
  });
  const urls = { [asset("logo", 1).path]: "https://signed.example/logo?token=t" };
  const hub = renderToStaticMarkup(h(BrandHub, { mode: "hub", initialValues: values, history: [], plan: "free", automation: "manual", assetUrls: urls }));
  assert.match(hub, /Logo, products and past posts/);
  assert.match(hub, /Computed from your logo/);
  assert.match(hub, /#C81E28/);
  assert.match(hub, /Bean logo/);
  assert.match(hub, /background-image:url\(&quot;https:\/\/signed\.example\/logo\?token=t&quot;\)/);
  assert.match(hub, /Soft light/);
  const onboarding = renderToStaticMarkup(h(BrandHub, { mode: "onboarding", persist: "local", initialValues: values, history: [], plan: "free", automation: "manual" }));
  assert.doesNotMatch(onboarding, /Logo, products and past posts/, "images are confirmed once, on their own screen");
});
