/**
 * Post Studio, slice 5b: MARA looks at an uploaded photo before suggesting its caption.
 *
 *   1. The vision prompt allows only what is visible, protects people, and
 *      names a product from the brand hint only when the photo clearly shows it.
 *   2. The brand hint is built from the Brand page (name, kind, offerings and
 *      the product photo descriptions), capped.
 *   3. The call sends a JPEG copy with the hint, the strict schema and one retry.
 *   4. The text model's payload carries the reading next to the brand context
 *      and never bytes; without a reading it is unchanged from before.
 *   5. The seen prompt turns the honesty rule around: nothing beyond the reading.
 *   6. The route: a video, vision off, and a failed look all take the unseen
 *      path (and spend nothing on vision); a photo with vision takes the seen
 *      path, with the hint going to vision and the reading plus the Brand Kit
 *      going to the text model.
 *   7. The editor shows what MARA saw and says a small copy is sent.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import { importApp } from "./helpers/rendered-surface.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const FAKE_AI = `
export class AiError extends Error { constructor(code, message) { super(message ?? code); this.name = "AiError"; this.code = code; } }
export function createAiProvider() { return globalThis.__VOOM_FAKE_AI__(); }
export function createAiVisionProvider() { return globalThis.__VOOM_FAKE_VISION__(); }
globalThis.__VOOM_FAKE_AI_ERROR__ = AiError;
`;
const FAKE_SERVER_DATA = `
export async function getPostDraft() { return globalThis.__VOOM_POST__; }
export async function loadPostBrandContext() { return globalThis.__VOOM_BRAND__; }
export async function loadPostPlanContext() { return null; }
export async function readPostAssetObject() { return globalThis.__VOOM_BYTES__ ?? null; }
`;
const FAKE_ADMIN = `
export function createAdminClient() {
  return { rpc: async (name, args) => { globalThis.__VOOM_BUCKETS__.push(args.p_bucket); return { data: globalThis.__VOOM_RATE_OK__ !== false, error: null }; } };
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/utils/supabase/server") {
      return { url: `data:text/javascript,${encodeURIComponent("export async function createClient() { return { auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-1', email: 'owner@example.com' } }, error: null }) } }; }")}`, shortCircuit: true };
    }
    if (specifier === "@/utils/supabase/admin") return { url: `data:text/javascript,${encodeURIComponent(FAKE_ADMIN)}`, shortCircuit: true };
    if (specifier === "@/lib/ai") return { url: `data:text/javascript,${encodeURIComponent(FAKE_AI)}`, shortCircuit: true };
    if (specifier === "@/lib/post/server-data") return { url: `data:text/javascript,${encodeURIComponent(FAKE_SERVER_DATA)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const vision = await importApp("lib/post/vision.ts");
const prompt = await importApp("lib/post/prompt.ts");
const context = await importApp("lib/brand/context.ts");
const rateLimit = await importApp("lib/rate-limit.ts");
const route = await importApp("app/api/posts/[id]/suggest/route.ts");
const AiError = globalThis.__VOOM_FAKE_AI_ERROR__;
const sharp = (await import("sharp")).default;

const DRAFT = "11111111-1111-4111-8111-111111111111";
const KIT = context.brandKitPromptContext({
  brief: "We are Lexi's, a sandwich brand.", offerings: ["Truffle Mushroom Melt Sandwich", "Katsu Chilli Paneer Sandwich"], avoidRules: ["Not salesy"], bannedWords: ["cheap"],
  facts: [], notes: "", voiceSamples: { liked: [], disliked: [] },
  visualStyle: { products: ["Chicken Sandwich", "Chicken Wings"], palette: ["#0E56C4"] },
});
const BRAND = {
  brandName: "Lexi's", brandDescription: "Gourmet sandwiches delivered.", industry: "Restaurant / Café", targetCustomer: "Local residents nearby",
  mainGoal: "More online sales", brandPersonality: "Playful,Bold", contentFrequency: "2–3 times a week", brandKit: KIT,
};
const SUGGESTION = { caption: "Melt o'clock.", cta: "Order now", hashtags: ["sando"], suggestedPublishAt: null, timingReason: "" };
const photo = (mime = "image/jpeg") => ({ kind: "instagram_post", visual: { displayName: "melt.jpg", mimeType: mime, byteSize: 1234 } });
const pngBytes = async () => new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 40 } } }).png().toBuffer());

/* ── 1. The vision prompt and schema ────────────────────────────────────── */

test("the vision prompt allows only what is visible, protects people, and names a product only when the photo clearly shows it", () => {
  const p = vision.POST_VISION_SYSTEM_PROMPT;
  assert.match(p, /Describe only what is visible\. Never guess prices, places, dates, awards/);
  assert.match(p, /Never identify or name a person, and never guess anyone's age, ethnicity, religion, health/);
  assert.match(p, /visible words copied exactly/);
  assert.match(p, /Name a product from that list ONLY when the photo clearly shows it/);
  assert.match(p, /Otherwise describe what you see in plain words and name nothing from the list/);
  assert.match(p, new RegExp(`under ${vision.POST_VISION_DESCRIPTION_MAX} characters`));

  assert.deepEqual(vision.postImageReadingSchema.parse({ description: `  ${"x".repeat(500)}  ` }), { description: "x".repeat(400) }, "over-long text is trimmed, never fatal");
  assert.equal(vision.postImageReadingSchema.safeParse({ description: "a", extra: 1 }).success, false);
  const schema = vision.postImageReadingJsonSchema;
  assert.equal(schema.strict, true);
  assert.deepEqual(schema.schema.required, ["description"]);
  assert.equal(schema.schema.properties.description.maxLength, 400);
});

/* ── 2. The brand hint ──────────────────────────────────────────────────── */

test("the brand hint comes from the Brand page: name, kind, offerings and the product photo descriptions, capped", () => {
  assert.deepEqual(vision.postVisionHint(BRAND), {
    brandName: "Lexi's", category: "Restaurant / Café",
    offerings: ["Truffle Mushroom Melt Sandwich", "Katsu Chilli Paneer Sandwich"], products: ["Chicken Sandwich", "Chicken Wings"],
  });
  const bare = vision.postVisionHint({ ...BRAND, brandKit: null });
  assert.deepEqual(bare, { brandName: "Lexi's", category: "Restaurant / Café", offerings: [], products: [] }, "no kit: name and kind only");
  const many = vision.postVisionHint({ ...BRAND, brandKit: { ...KIT, offerings: Array.from({ length: 30 }, (_, i) => `Item ${i}`) } });
  assert.equal(many.offerings.length, 20);
});

/* ── 3. The call ─────────────────────────────────────────────────────────── */

test("the call sends a JPEG copy with the hint, the strict schema and one retry, and returns the trimmed reading", async () => {
  const seen = [];
  const provider = { structured: async (request) => { seen.push(request); return request.parse({ description: " A toasted sandwich cut in half, cheese pulling, on a wooden board. " }); } };
  const description = await vision.describePostImage(provider, { jpeg: new Uint8Array([0xff, 0xd8, 0xff]), hint: vision.postVisionHint(BRAND) });
  assert.equal(description, "A toasted sandwich cut in half, cheese pulling, on a wooden board.");
  const [request] = seen;
  assert.equal(request.messages[0].content, vision.POST_VISION_SYSTEM_PROMPT);
  const [text, image] = request.messages[1].content;
  assert.deepEqual(JSON.parse(text.text).business, vision.postVisionHint(BRAND), "the brand hint travels with the photo");
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(request.temperature, 0.2);
  assert.equal(request.maxAttempts, 2);
  assert.equal(request.jsonSchema, vision.postImageReadingJsonSchema);
});

/* ── 4. The text model's payload ─────────────────────────────────────────── */

test("with a reading the payload says MARA saw the photo, carries the reading next to the brand context, and never bytes; without one it is unchanged", () => {
  const base = { displayName: "melt.jpg", mimeType: "image/jpeg", byteSize: 1234, assetKind: "image", brand: BRAND, plan: null, nowIso: "2026-10-28T09:00:00.000Z" };
  const seen = prompt.buildExistingContentPayload({ ...base, visual: { description: "A toasted sandwich on a wooden board." } });
  assert.equal(seen.maraHasSeenTheFile, true);
  assert.equal(seen.importedFile.whatMaraSaw, "A toasted sandwich on a wooden board.");
  assert.match(seen.note, /everything she saw.*state nothing about the image beyond that description/);
  assert.deepEqual(seen.brandKit, KIT, "the Brand Kit still reaches the text model next to the reading");
  assert.equal(seen.business.name, "Lexi's");
  assert.doesNotMatch(JSON.stringify(seen), /base64|dataUrl|data:image|Uint8Array/i, "no media bytes may reach the text model");

  const unseen = prompt.buildExistingContentPayload(base);
  assert.deepEqual(prompt.buildExistingContentPayload({ ...base, visual: null }), unseen, "null reading = no reading");
  assert.deepEqual(prompt.buildExistingContentPayload({ ...base, visual: { description: "   " } }), unseen, "a blank reading = no reading");
  assert.equal(unseen.maraHasSeenTheFile, false);
  assert.deepEqual(Object.keys(unseen.importedFile).sort(), ["mimeType", "name", "sizeBytes", "type"]);
  assert.match(unseen.note, /MARA cannot see this file/);
});

/* ── 5. The seen prompt ──────────────────────────────────────────────────── */

test("the seen prompt allows nothing beyond the reading and keeps every other rule; the unseen prompt and disclosure are untouched", () => {
  const seen = prompt.POST_SUGGESTION_SEEN_SYSTEM_PROMPT;
  assert.match(seen, /Everything you know about the photo is importedFile\.whatMaraSaw/);
  assert.match(seen, /Do NOT state anything about the image that is not in that description/);
  assert.match(seen, /where it does not, do not guess which product it is/);
  assert.match(seen, /Do not invent prices, discounts, offers/);
  assert.match(seen, /suggestedPublishAt must be a real future ISO-8601 timestamp/);
  assert.match(prompt.POST_SUGGESTION_SYSTEM_PROMPT, /You have NOT seen the photo or video/);
  assert.match(prompt.EXISTING_CONTENT_DISCLOSURE, /MARA has not seen this file/);
  assert.match(prompt.EXISTING_CONTENT_SEEN_DISCLOSURE, /looked at a small copy of this image once.*Check that what she saw matches/);
  assert.deepEqual(rateLimit.AI_RATE_LIMITS.post_vision, { limit: 40, windowSeconds: 3600 });
});

/* ── 6. The route ────────────────────────────────────────────────────────── */

async function suggest() {
  globalThis.__VOOM_BUCKETS__ = [];
  globalThis.__VOOM_RATE_OK__ = true;
  globalThis.__VOOM_BRAND__ = BRAND;
  const response = await route.POST(new Request("http://localhost/api/posts/x/suggest", { method: "POST" }), { params: Promise.resolve({ id: DRAFT }) });
  return { status: response.status, body: await response.json(), buckets: globalThis.__VOOM_BUCKETS__ };
}

test("a video, vision off, and a failed look all take the unseen path and spend nothing on vision", async () => {
  const textCalls = [];
  globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async (request) => { textCalls.push(request); return request.parse(SUGGESTION); } });
  globalThis.__VOOM_BYTES__ = await pngBytes();

  // A video is never looked at, even with vision configured.
  globalThis.__VOOM_FAKE_VISION__ = () => { throw new Error("must not be created for a video"); };
  globalThis.__VOOM_POST__ = photo("video/mp4");
  let result = await suggest();
  assert.equal(result.status, 200);
  assert.equal(result.body.inspectedVisual, false);
  assert.equal(result.body.disclosure, prompt.EXISTING_CONTENT_DISCLOSURE);
  assert.equal("visualDescription" in result.body, false);
  assert.deepEqual(result.buckets, ["post_suggest"]);

  // Vision not configured: a photo takes the unseen path and the vision bucket is not spent.
  globalThis.__VOOM_FAKE_VISION__ = () => { throw new AiError("not_configured"); };
  globalThis.__VOOM_POST__ = photo();
  result = await suggest();
  assert.equal(result.body.inspectedVisual, false);
  assert.deepEqual(result.buckets, ["post_suggest"]);
  assert.equal(JSON.parse(textCalls.at(-1).messages[1].content).maraHasSeenTheFile, false);
  assert.match(textCalls.at(-1).messages[0].content, /You have NOT seen the photo or video/);

  // The look fails: logged, and the suggestion is still written the unseen way.
  const quiet = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    globalThis.__VOOM_FAKE_VISION__ = () => ({ structured: async () => { throw new AiError("unavailable", "The AI provider returned HTTP 401."); } });
    result = await suggest();
  } finally {
    console.error = quiet;
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.inspectedVisual, false);
  assert.deepEqual(result.buckets, ["post_suggest", "post_vision"], "the look was attempted");
  assert.ok(logged.some(([line, detail]) => line === "[post-vision] failed" && detail.message === "The AI provider returned HTTP 401."));
});

test("a photo with vision: the hint goes to the vision model, the reading plus the Brand Kit go to the text model, and the response shows what MARA saw", async () => {
  const visionCalls = [];
  const textCalls = [];
  globalThis.__VOOM_FAKE_VISION__ = () => ({ structured: async (request) => { visionCalls.push(request); return request.parse({ description: "A Truffle Mushroom Melt Sandwich cut in half on a wooden board, warm light." }); } });
  globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async (request) => { textCalls.push(request); return request.parse(SUGGESTION); } });
  globalThis.__VOOM_BYTES__ = await pngBytes();
  globalThis.__VOOM_POST__ = photo("image/png");
  const result = await suggest();
  assert.equal(result.status, 200);
  assert.deepEqual(result.buckets, ["post_suggest", "post_vision"]);

  assert.equal(visionCalls.length, 1);
  const [text, image] = visionCalls[0].messages[1].content;
  assert.deepEqual(JSON.parse(text.text).business.offerings, ["Truffle Mushroom Melt Sandwich", "Katsu Chilli Paneer Sandwich"], "the brand's offerings reach the vision model");
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/, "a JPEG copy, whatever the upload was");

  assert.equal(textCalls.length, 1);
  const system = textCalls[0].messages[0].content;
  assert.match(system, /Everything you know about the photo is importedFile\.whatMaraSaw/, "the seen prompt");
  assert.match(system, /BRAND KIT\n- The payload may carry brandKit/, "with the Brand Kit rules");
  const payload = JSON.parse(textCalls[0].messages[1].content);
  assert.equal(payload.maraHasSeenTheFile, true);
  assert.equal(payload.importedFile.whatMaraSaw, "A Truffle Mushroom Melt Sandwich cut in half on a wooden board, warm light.");
  assert.deepEqual(payload.brandKit, KIT, "brand context and reading, side by side");

  assert.equal(result.body.inspectedVisual, true);
  assert.equal(result.body.disclosure, prompt.EXISTING_CONTENT_SEEN_DISCLOSURE);
  assert.equal(result.body.visualDescription, "A Truffle Mushroom Melt Sandwich cut in half on a wooden board, warm light.");
  assert.equal(result.body.suggestion.caption, "Melt o'clock.");
});

/* ── 6b. The owner's purpose (Gurnoor, 2026-10-28: a caption is not a description) ── */

test("the owner's purpose reaches the caption model first, and both prompts make it the caption's job", async () => {
  const base = { displayName: "melt.jpg", mimeType: "image/jpeg", byteSize: 1234, assetKind: "image", brand: BRAND, plan: null, nowIso: "2026-10-28T09:00:00.000Z" };
  const withPurpose = prompt.buildExistingContentPayload({ ...base, brief: "  Introducing our new sandwich to Gurgaon  " });
  assert.equal(Object.keys(withPurpose)[0], "postPurpose", "the purpose comes first in the payload");
  assert.equal(withPurpose.postPurpose, "Introducing our new sandwich to Gurgaon");
  assert.equal(prompt.buildExistingContentPayload(base).postPurpose, null, "no line: null, never a made-up purpose");
  assert.equal(prompt.buildExistingContentPayload({ ...base, brief: "x".repeat(900) }).postPurpose.length, 800);

  for (const [name, text] of [["unseen", prompt.POST_SUGGESTION_SYSTEM_PROMPT], ["seen", prompt.POST_SUGGESTION_SEEN_SYSTEM_PROMPT]]) {
    assert.match(text, /postPurpose is the owner's own line on why they are posting/, `${name}: the purpose is named`);
    assert.match(text, /When postPurpose is null, choose the purpose from the business's main goal and the marketing plan/, `${name}: a fallback purpose, not a description`);
    assert.match(text, /A caption is never a description of the (file|photo)\. Lead with why the reader should care/, `${name}: the rule`);
  }
  assert.match(prompt.POST_SUGGESTION_SEEN_SYSTEM_PROMPT, /When postPurpose and the photo clearly do not match.*invent nothing to bridge them.*say in timingReason/, "a clash is flagged, never bridged with an invention");

  // The route takes the line as typed (possibly unsaved) and falls back to the draft's saved one.
  const textCalls = [];
  globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async (request) => { textCalls.push(request); return request.parse(SUGGESTION); } });
  globalThis.__VOOM_FAKE_VISION__ = () => { throw new AiError("not_configured"); };
  globalThis.__VOOM_POST__ = { ...photo(), mediaBrief: "Saved line" };
  globalThis.__VOOM_BUCKETS__ = [];
  globalThis.__VOOM_RATE_OK__ = true;
  globalThis.__VOOM_BRAND__ = BRAND;
  await route.POST(new Request("http://localhost/api/posts/x/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: "Typed line" }) }), { params: Promise.resolve({ id: DRAFT }) });
  assert.equal(JSON.parse(textCalls.at(-1).messages[1].content).postPurpose, "Typed line");
  await route.POST(new Request("http://localhost/api/posts/x/suggest", { method: "POST" }), { params: Promise.resolve({ id: DRAFT }) });
  assert.equal(JSON.parse(textCalls.at(-1).messages[1].content).postPurpose, "Saved line");

  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /body: JSON\.stringify\(\{ brief: mediaBrief \}\)/, "the editor sends the line as typed");
  assert.match(editor, /label="What is this post for\?"/, "the box is relabelled for existing content");
  assert.match(editor, /Tell MARA what this post is for first; she writes a much better caption with it\./, "the nudge when the box is empty");
});

/* ── 7. The editor ───────────────────────────────────────────────────────── */

test("the editor shows what MARA saw next to the disclosure and says a small copy is sent when image reading is on", async () => {
  const source = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(source, /visualDescription\?: string/);
  assert.match(source, /MARA saw: \$\{body\.visualDescription\}/);
  assert.match(source, /When image reading is on, she first looks at a small copy of the photo, sent once to Voom&apos;s AI provider\./);
  assert.match(source, /Videos are never looked at\. The note after each suggestion says what MARA saw, if anything\./, "the standing line under the button no longer claims MARA never sees the file");
  assert.doesNotMatch(source, /MARA has not seen this file\./, "the fixed unseen wording would be untrue with vision on; the response's disclosure says which");
});
