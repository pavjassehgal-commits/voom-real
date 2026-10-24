/**
 * Brand Kit v2 slice 4: what MARA learns from the description.
 *
 *   1. The answer schema accepts only OUR lists (category, audience, goal,
 *      tone); anything else is refused, and the provider-side JSON Schema
 *      mirrors it exactly.
 *   2. The prompt forbids inventing anything and names every allowed value.
 *   3. The extraction call sends the capped description once, low temperature.
 *   4. The server action: logged out, too short, rate limited, not configured,
 *      provider down, success. Never throws; the description is never stored.
 *   5. The wizard: still ten screens (each answer is confirmed exactly once,
 *      on the screen that asks for it), a visible reading state, the read
 *      waits 12 s at most and falls back to the keyword guess.
 *   6. Finish records where answers came from and the unconfirmed facts;
 *      generation reads only confirmed facts.
 *   7. The Brand page shows "Needs confirmation"; in onboarding a fact is
 *      confirmed with one tap, on the live page through Edit.
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
export function createAiProvider() { return globalThis.__VOOM_FAKE_AI__(); }
globalThis.__VOOM_FAKE_AI_ERROR__ = AiError;
`;

// Registered AFTER the rendered-surface helper so these exact specifiers win.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/utils/supabase/server") {
      return { url: `data:text/javascript,${encodeURIComponent("export async function createClient() { return globalThis.__VOOM_FAKE_SUPABASE__; }")}`, shortCircuit: true };
    }
    if (specifier === "@/utils/supabase/admin") {
      return { url: `data:text/javascript,${encodeURIComponent("export function createAdminClient() { return { rpc: async () => ({ data: globalThis.__VOOM_RATE_LIMIT_OK__, error: null }) }; }")}`, shortCircuit: true };
    }
    if (specifier === "@/lib/ai") {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_AI)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const extract = await importApp("lib/brand/extract.ts");
const { extractBrandDescription } = await importApp("lib/brand/extract-actions.ts");
// The action checks `instanceof AiError` against the class in the (faked) "@/lib/ai" module.
const AiError = globalThis.__VOOM_FAKE_AI_ERROR__;
const data = await importApp("lib/voom/onboardingData.ts");
const wizard = await importApp("components/voom/onboarding/OnboardingWizard.tsx");
const versions = await importApp("lib/brand/versions.ts");
const context = await importApp("lib/brand/context.ts");
const sections = await importApp("lib/brand/sections.ts");
const rateLimit = await importApp("lib/rate-limit.ts");
const { BrandHub } = await importApp("components/voom/brand/BrandHub.tsx");

const LEARNED = {
  name: "Bean & Co.", category: "Restaurant / Café", offerings: ["Single-origin espresso", "Weekend brunch"],
  audience: ["Local residents nearby", "Professionals (30–50)"], goal: "More walk-in customers", personality: ["Friendly", "Calm"],
  brief: "We're a small café near the marina. We roast our own beans and most of our customers are regulars who work nearby.",
  facts: ["Roasting since 2014", "Near the marina"],
};

/* ── 1. Schema ───────────────────────────────────────────────────────────── */

test("the answer schema accepts our lists only and refuses anything outside them", () => {
  assert.deepEqual(extract.brandExtractionSchema.parse(LEARNED), LEARNED);
  const empty = { name: "", category: "", offerings: [], audience: [], goal: "", personality: [], brief: "", facts: [] };
  assert.deepEqual(extract.brandExtractionSchema.parse(empty), empty);
  assert.equal(extract.brandLearnedIsEmpty(empty), true);
  assert.equal(extract.brandLearnedIsEmpty(LEARNED), false);

  const refuse = (patch, why) => assert.equal(extract.brandExtractionSchema.safeParse({ ...LEARNED, ...patch }).success, false, why);
  refuse({ category: "Coffee shop" }, "a category outside the nine tiles");
  refuse({ audience: ["Coffee lovers"] }, "an audience chip we do not offer");
  refuse({ goal: "Be famous" }, "a goal outside the six");
  refuse({ personality: ["Sassy"] }, "a tone outside the eight");
  refuse({ personality: ["Friendly", "Calm", "Bold", "Modern"] }, "more than three tones");
  refuse({ brief: "x".repeat(601) }, "a brief over 600 characters");
  refuse({ extra: true }, "unknown keys");

  // Duplicates are folded, never refused.
  const dup = extract.brandExtractionSchema.parse({ ...LEARNED, facts: ["Roasting since 2014", " Roasting since 2014 "] });
  assert.deepEqual(dup.facts, ["Roasting since 2014"]);
});

test("the provider-side JSON Schema mirrors the zod schema: strict, every key required, enums from our lists", () => {
  const schema = extract.brandExtractionJsonSchema;
  assert.equal(schema.strict, true);
  assert.equal(schema.schema.additionalProperties, false);
  assert.deepEqual(schema.schema.required, ["name", "category", "offerings", "audience", "goal", "personality", "brief", "facts"]);
  assert.deepEqual(schema.schema.properties.category.enum, ["", ...data.Q_INDUSTRY.map(([, name]) => name)]);
  assert.deepEqual(schema.schema.properties.audience.items.enum, data.Q_CUSTOMER);
  assert.deepEqual(schema.schema.properties.goal.enum, ["", ...data.Q_GOAL.map(([, name]) => name)]);
  assert.deepEqual(schema.schema.properties.personality.items.enum, data.OB_TONE);
  assert.equal(schema.schema.properties.personality.maxItems, 3);
  assert.equal(schema.schema.properties.brief.maxLength, 600);
});

/* ── 2. Prompt ───────────────────────────────────────────────────────────── */

test("the prompt forbids inventing anything and names every allowed value", () => {
  const prompt = extract.BRAND_EXTRACTION_SYSTEM_PROMPT;
  assert.match(prompt, /Use ONLY what the description says\. Never invent/);
  assert.match(prompt, /No new claims/);
  assert.match(prompt, /need the owner's confirmation/);
  for (const [, name] of data.Q_INDUSTRY) assert.ok(prompt.includes(`"${name}"`), `category ${name} is named`);
  for (const chip of data.Q_CUSTOMER) assert.ok(prompt.includes(`"${chip}"`), `audience ${chip} is named`);
  for (const [, name] of data.Q_GOAL) assert.ok(prompt.includes(`"${name}"`), `goal ${name} is named`);
  for (const tone of data.OB_TONE) assert.ok(prompt.includes(`"${tone}"`), `tone ${tone} is named`);
  assert.match(prompt, /under 600 characters/);
});

/* ── 3. The call ─────────────────────────────────────────────────────────── */

test("the extraction call sends the capped description once, at low temperature, with the schema and the parse", async () => {
  const seen = [];
  const provider = { structured: async (request) => { seen.push(request); return request.parse(LEARNED); } };
  const long = "We roast our own beans. ".repeat(400);
  const result = await extract.extractBrandFromDescription(provider, long);
  assert.deepEqual(result, LEARNED);
  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[0].content, extract.BRAND_EXTRACTION_SYSTEM_PROMPT);
  const payload = JSON.parse(request.messages[1].content);
  assert.equal(payload.description.length, extract.BRAND_EXTRACTION_INPUT_MAX, "the description is capped before it is sent");
  assert.equal(request.temperature, 0.2);
  assert.equal(request.jsonSchema, extract.brandExtractionJsonSchema);
  await assert.rejects(() => provider.structured({ ...request, parse: (v) => extract.brandExtractionSchema.parse({ ...v, category: "Coffee shop" }) }), "an off-list answer fails the parse");
});

/* ── 4. The server action ────────────────────────────────────────────────── */

function login(loggedIn = true) {
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    auth: { getClaims: async () => (loggedIn ? { data: { claims: { sub: "owner-1", email: "owner@example.com" } }, error: null } : { data: null, error: { message: "no session" } }) },
    from() { throw new Error("the action must not touch any table"); },
  };
}
const DESC = "We roast our own beans near the marina and most of our customers are regulars.";

test("the action answers with a plain reason: logged out, too short, rate limited, not configured, provider down", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    login(false);
    assert.deepEqual(await extractBrandDescription(DESC), { ok: false, reason: "login" });

    login(true);
    globalThis.__VOOM_RATE_LIMIT_OK__ = true;
    assert.deepEqual(await extractBrandDescription("Four words only here"), { ok: false, reason: "too_short" });
    assert.deepEqual(await extractBrandDescription(42), { ok: false, reason: "too_short" });

    globalThis.__VOOM_RATE_LIMIT_OK__ = false;
    globalThis.__VOOM_FAKE_AI__ = () => { throw new Error("must not be called when rate limited"); };
    assert.deepEqual(await extractBrandDescription(DESC), { ok: false, reason: "rate_limited" });

    globalThis.__VOOM_RATE_LIMIT_OK__ = true;
    globalThis.__VOOM_FAKE_AI__ = () => { throw new AiError("not_configured"); };
    assert.deepEqual(await extractBrandDescription(DESC), { ok: false, reason: "not_configured" });

    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async () => { throw new AiError("unavailable"); } });
    assert.deepEqual(await extractBrandDescription(DESC), { ok: false, reason: "unavailable" });

    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async () => { throw new AiError("rate_limited"); } });
    assert.deepEqual(await extractBrandDescription(DESC), { ok: false, reason: "rate_limited" });

    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async (request) => request.parse({ ...LEARNED, category: "Coffee shop" }) });
    assert.deepEqual(await extractBrandDescription(DESC), { ok: false, reason: "unavailable" }, "an off-list answer is a failed read, never a coerced one");
  } finally {
    console.error = quiet;
  }
});

test("a successful read returns MARA's guesses and consumes the brand_extract bucket", async () => {
  login(true);
  globalThis.__VOOM_RATE_LIMIT_OK__ = true;
  globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async (request) => request.parse(LEARNED) });
  assert.deepEqual(await extractBrandDescription(`  ${DESC}  `), { ok: true, learned: LEARNED });
  assert.deepEqual(rateLimit.AI_RATE_LIMITS.brand_extract, { limit: 10, windowSeconds: 3600 });
  const source = await read("lib/brand/extract-actions.ts");
  assert.match(source, /consumeAiRateLimit\(user\.id, "brand_extract"\)/);
  assert.doesNotMatch(source, /\.from\(|insert\(|upsert\(/, "the action stores nothing");
});

/* ── 5. The wizard ───────────────────────────────────────────────────────── */

test("still ten screens: the read prefills the screen that asks, so each answer is confirmed exactly once", async () => {
  assert.deepEqual(data.OB_STEPS, ["Your name", "Your brand", "The basics", "Audience & goal", "Your voice", "What to avoid", "Pace", "Working style", "Brand Brief", "Your channels"]);
  assert.equal(wizard.LAST_STEP, 9);
  assert.deepEqual([...wizard.SKIPPABLE_STEPS], [4, 5, 6, 8, 9]);
  assert.equal(wizard.EXTRACTION_WAIT_MS, 12_000);

  const source = await read("components/voom/onboarding/OnboardingWizard.tsx");
  assert.doesNotMatch(source, /StepLearned|What MARA learned|Here&apos;s what I learned/, "no separate confirmation screen (Gurnoor, 2026-10-24: confirm once, where the question is)");
  assert.match(source, /Promise\.race<ExtractBrandResult>/, "the read is raced against the wait");
  assert.match(source, /setTimeout\(\(\) => resolve\(\{ ok: false, reason: "unavailable" \}\), EXTRACTION_WAIT_MS\)/);
  assert.match(source, /markLearnedFailed\(desc\);\s*if \(!onboard\.industry\) \{\s*const detected = detectIndustry\(desc\)/, "a failed read falls back to the keyword guess");
  assert.match(source, /onboard\.learnedFor === desc/, "the same text is never sent twice");
  assert.match(source, /MARA couldn&apos;t read your description just now/);
  assert.match(source, /reading \? "Reading…"/);
  assert.match(source, /MARA is reading your description…/, "a visible reading panel, not only the button label");
  assert.match(source, /disabled=\{reading\}/, "the text cannot change mid-read");
  assert.match(source, /I read your description and filled in what I could/, "the basics screen says what happened");
  for (const key of ["category", "audience", "goal", "personality"]) assert.match(source, new RegExp(`fromMara\\.includes\\("${key}"\\)`), `${key} is marked as MARA's guess where it is asked`);
  assert.match(source, /tap Confirm on each claim that&apos;s true|tap Confirm on each claim that's true/, "facts are confirmed on the Brand Brief screen");
});

test("the store prefills only empty fields from the read and drops MARA's claim when the owner edits", async () => {
  const store = await read("lib/voom/store.tsx");
  assert.match(store, /const free = \(Array\.isArray\(current\) \? current\.length === 0 : current === ""\) \|\| o\.fromMara\.includes\(key\)/, "the owner's own words always win");
  assert.match(store, /next\.factsUnconfirmed = learned\.facts\.filter/, "facts are never prefilled as confirmed");
  assert.match(store, /onboard: \{ \.\.\.withoutMaraClaim\(s\.onboard, key\), \[key\]: value \}/, "editing a field removes MARA's claim on it");
  assert.match(store, /fromDescription: o\.fromMara/);
  assert.match(store, /factsUnconfirmed: o\.factsUnconfirmed/);
});

/* ── 6. What finish records, and what generation reads ───────────────────── */

test("finish records where each answer came from and the unconfirmed facts; generation reads only confirmed facts", () => {
  const input = {
    displayName: "Alex", brandName: "Bean & Co.", brandDescription: DESC, industry: "Restaurant / Café",
    targetCustomer: ["Local residents nearby"], mainGoal: "More walk-in customers", brandPersonality: ["Friendly"],
    preferredChannels: ["Instagram"], monthlyAdBudget: "", contentFrequency: "2–3 times a week", automationLevel: "manual", publishingPermission: "",
    kit: { brief: LEARNED.brief, offerings: LEARNED.offerings, rules: [], words: [], notes: "", facts: ["Roasting since 2014"], fromDescription: ["category", "offerings", "brief"], factsUnconfirmed: ["Near the marina"] },
  };
  const answers = versions.brandKitAnswersFromOnboarding(input);
  assert.deepEqual(answers.provenance, { category: "description", offerings: "description", brief: "description" });
  assert.deepEqual(answers.facts_confirmed, ["Roasting since 2014"]);
  assert.deepEqual(answers.facts_unconfirmed, ["Near the marina"]);

  const typed = versions.brandKitAnswersFromOnboarding({ ...input, kit: { ...input.kit, fromDescription: [], factsUnconfirmed: [] } });
  assert.equal("provenance" in typed, false, "nothing from MARA, nothing recorded");
  assert.equal("facts_unconfirmed" in typed, false);

  const extras = context.brandKitExtrasFromRow({ answers, brief: LEARNED.brief });
  assert.deepEqual(extras.facts, ["Roasting since 2014"]);
  const prompt = JSON.stringify(context.brandKitPromptContext(extras));
  assert.doesNotMatch(prompt, /Near the marina/, "an unconfirmed fact never reaches a prompt");
  assert.doesNotMatch(prompt, /provenance|description"/, "provenance is bookkeeping, not prompt content");
});

/* ── 7. The Brand page ───────────────────────────────────────────────────── */

test("the Facts section owns both lists, keeps them disjoint, and shows what needs confirmation", async () => {
  const meta = sections.BRAND_SECTIONS.find((section) => section.id === "facts");
  assert.deepEqual(meta.ownsKeys, ["facts_confirmed", "facts_unconfirmed"]);

  const checked = sections.validateBrandSection("facts", { facts: ["Roasting since 2014", "Near the marina"], unconfirmed: ["Near the marina", "Award 2020"] });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.answers, { facts_confirmed: ["Roasting since 2014", "Near the marina"], facts_unconfirmed: ["Award 2020"] }, "a confirmed fact leaves the waiting list");
  assert.deepEqual(checked.business, {});
  const legacy = sections.validateBrandSection("facts", { facts: ["Roasting since 2014"] });
  assert.deepEqual(legacy.values, { facts: ["Roasting since 2014"], unconfirmed: [] }, "an older client without the list still saves");

  const values = sections.brandHubValues(null, { brief: "", answers: { facts_confirmed: ["Roasting since 2014"], facts_unconfirmed: ["Near the marina"] } });
  assert.deepEqual(values.facts, { facts: ["Roasting since 2014"], unconfirmed: ["Near the marina"] });

  const html = renderToStaticMarkup(h(BrandHub, { mode: "hub", initialValues: values, history: [], plan: "free", automation: "manual" }));
  assert.match(html, /Roasting since 2014/);
  assert.match(html, /Needs confirmation/);
  assert.match(html, /Near the marina/);
  assert.match(html, /never states them until you confirm them with Edit\./);
  assert.doesNotMatch(html, />Confirm</, "the live page confirms through Edit, one version per save");

  // Onboarding: one tap, through the same local-save path as the editor.
  const wizardHtml = renderToStaticMarkup(h(BrandHub, { mode: "onboarding", persist: "local", initialValues: values, history: [], plan: "free", automation: "manual" }));
  assert.match(wizardHtml, />Confirm</);
  const hub = await read("components/voom/brand/BrandHub.tsx");
  assert.match(hub, /const oneTapConfirm = persist === "local" && mode === "onboarding" && editing === null \? confirmFactLocal : undefined/);
  assert.match(hub, /onLocalSave\?\.\("facts", next\)/, "the tap reports the change exactly like a Save");
  assert.equal(sections.answerKeyLabel("facts_unconfirmed"), "Facts needing confirmation");
  assert.equal(sections.answerKeyLabel("provenance"), "Where answers came from");
});
