/**
 * Brand Kit v2 slice 6: MARA writes three sample captions in the brand's voice.
 *
 *   1. The snapshot MARA is told is built from the sections the screens hold,
 *      capped, and sorting a caption never changes the key that asks for a
 *      new set.
 *   2. The answer schema takes exactly three short captions; the provider-side
 *      JSON Schema mirrors it.
 *   3. The prompt forbids inventing, limits facts to the confirmed list, bans
 *      the banned words and never copies a sorted sample.
 *   4. Captions using a banned word (any casing) or copying a sorted sample
 *      never reach the screen.
 *   5. The call sends the snapshot once with the schema; the server action
 *      answers with a plain reason, stores nothing, and spends the
 *      `brand_voice` bucket only when it calls the model.
 *   6. Sorting: "Sounds like us" / "Not us" move a caption between the lists,
 *      a second tap removes it, and each list stops at five.
 *   7. The wizard: the write is raced against 8 s, a failure leaves the chips
 *      alone and points to the Brand page, the sorted captions reach Finish,
 *      and the kit stores them where generation already reads them.
 *   8. The Brand page editor offers "Write 3 new samples" and the cards.
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

const voice = await importApp("lib/brand/voice.ts");
const { writeBrandVoiceSamples } = await importApp("lib/brand/voice-actions.ts");
const AiError = globalThis.__VOOM_FAKE_AI_ERROR__;
const samplesUi = await importApp("components/voom/brand/VoiceSamples.tsx");
const wizard = await importApp("components/voom/onboarding/OnboardingWizard.tsx");
const versions = await importApp("lib/brand/versions.ts");
const context = await importApp("lib/brand/context.ts");
const rateLimit = await importApp("lib/rate-limit.ts");

const SECTIONS = {
  basics: { name: "Bean & Co.", description: "We roast our own beans near the marina.", category: "Restaurant / Café" },
  brief: { brief: "We're a small café near the marina. We roast our own beans." },
  offerings: { offerings: ["Single-origin espresso", "Weekend brunch"] },
  audience: { audience: ["Local residents nearby"], goal: "More walk-in customers" },
  voice: { personality: ["Friendly", "Calm"], liked: ["Morning light, first pour."], disliked: ["50% OFF!!! Buy now!"] },
  avoid: { rules: ["Not salesy"], words: ["cheap", "Discount"], notes: "" },
  facts: { facts: ["Roasting since 2014"], unconfirmed: ["Near the marina"] },
};
const THREE = ["Saturday brunch is back. Come for the eggs, stay for the second coffee.", "The first pour of the day is for whoever gets here before us.", "We roast on Tuesdays. The whole street knows."];

/* ── 1. The snapshot ─────────────────────────────────────────────────────── */

test("the snapshot comes from the sections the screens hold, is capped, and sorting never changes its key", () => {
  const snapshot = voice.voiceSnapshotFromSections(SECTIONS);
  assert.deepEqual(snapshot, {
    name: "Bean & Co.", category: "Restaurant / Café", description: "We roast our own beans near the marina.",
    offerings: ["Single-origin espresso", "Weekend brunch"], audience: ["Local residents nearby"], goal: "More walk-in customers",
    personality: ["Friendly", "Calm"], brief: "We're a small café near the marina. We roast our own beans.",
    rules: ["Not salesy"], words: ["cheap", "Discount"], facts: ["Roasting since 2014"],
    liked: ["Morning light, first pour."], disliked: ["50% OFF!!! Buy now!"],
  });
  assert.equal("unconfirmed" in snapshot, false, "unconfirmed facts never reach MARA");
  assert.deepEqual(voice.brandVoiceSnapshotSchema.parse(snapshot), snapshot);

  const capped = voice.brandVoiceSnapshotSchema.parse({ ...snapshot, liked: ["a", "b", "c", "d", "e", "f", "g"], words: [" cheap ", "cheap", ""] });
  assert.deepEqual(capped.liked, ["a", "b", "c", "d", "e"], "five per list, like the editor and the reader");
  assert.deepEqual(capped.words, ["cheap"]);
  assert.equal(voice.brandVoiceSnapshotSchema.safeParse({ ...snapshot, extra: true }).success, false, "unknown keys are refused");
  assert.deepEqual(voice.brandVoiceSnapshotSchema.parse({}), { name: "", category: "", description: "", offerings: [], audience: [], goal: "", personality: [], brief: "", rules: [], words: [], facts: [], liked: [], disliked: [] }, "every field has an empty default");

  const sorted = { ...snapshot, liked: [...snapshot.liked, THREE[0]], disliked: [] };
  assert.equal(voice.voiceSnapshotKey(sorted), voice.voiceSnapshotKey(snapshot), "sorting a caption does not ask for a new set");
  assert.notEqual(voice.voiceSnapshotKey({ ...snapshot, personality: ["Bold"] }), voice.voiceSnapshotKey(snapshot), "a changed answer does");
});

/* ── 2. The answer schema ────────────────────────────────────────────────── */

test("the answer is exactly three short captions; the provider-side JSON Schema mirrors it", () => {
  assert.deepEqual(voice.brandVoiceSamplesSchema.parse({ samples: THREE }), { samples: THREE });
  const refuse = (value, why) => assert.equal(voice.brandVoiceSamplesSchema.safeParse(value).success, false, why);
  refuse({ samples: [] }, "none");
  refuse({ samples: THREE.slice(0, 2) }, "two");
  refuse({ samples: [...THREE, "a fourth"] }, "four");
  refuse({ samples: ["", THREE[1], THREE[2]] }, "a blank caption");
  refuse({ samples: ["x".repeat(300), THREE[1], THREE[2]] }, "a caption far over the limit");
  refuse({ samples: THREE, extra: 1 }, "unknown keys");

  const schema = voice.brandVoiceSamplesJsonSchema;
  assert.equal(schema.strict, true);
  assert.equal(schema.schema.additionalProperties, false);
  assert.deepEqual(schema.schema.required, ["samples"]);
  assert.equal(schema.schema.properties.samples.minItems, 3);
  assert.equal(schema.schema.properties.samples.maxItems, 3);
  assert.equal(schema.schema.properties.samples.items.maxLength, voice.VOICE_SAMPLE_MAX);
  assert.equal(voice.VOICE_SAMPLE_MAX, 220);
  assert.equal(voice.VOICE_SAMPLES_PER_LIST, 5);
});

/* ── 3. The prompt ───────────────────────────────────────────────────────── */

test("the prompt forbids inventing, limits facts to the confirmed list, bans the banned words and never copies a sample", () => {
  const prompt = voice.BRAND_VOICE_SYSTEM_PROMPT;
  assert.match(prompt, /Use ONLY what the payload says\. Never invent/);
  assert.match(prompt, /The only specific facts you may state are in "facts"; state none when it is empty/);
  assert.match(prompt, /Never use a word from "avoid\.words", in any casing/);
  assert.match(prompt, /Follow every rule in "avoid\.rules"/);
  assert.match(prompt, /never copy one/);
  assert.match(prompt, /notUs.*write nothing like them/);
  assert.match(prompt, /No hashtags/);
  assert.match(prompt, /Three different angles/);
  assert.match(prompt, new RegExp(`under ${voice.VOICE_SAMPLE_MAX} characters`));
});

/* ── 4. What may reach the screen ────────────────────────────────────────── */

test("captions with a banned word (any casing) or copying a sorted sample are dropped; duplicates and blanks too", () => {
  const snapshot = voice.voiceSnapshotFromSections(SECTIONS);
  const kept = voice.keepUsableSamples([
    "Our beans are not CHEAP, and that is the point.",
    "A small discount for regulars this week.",
    "  morning light, first pour.  ",
    THREE[0],
    THREE[0],
    "",
    THREE[2],
  ], snapshot);
  assert.deepEqual(kept, [THREE[0], THREE[2]]);
  assert.deepEqual(voice.keepUsableSamples(THREE, { words: [], liked: [], disliked: [] }), THREE, "nothing banned, nothing dropped");
});

/* ── 5. The call and the action ──────────────────────────────────────────── */

test("the call sends the snapshot once with the schema, at a varied temperature, and filters the answer", async () => {
  const seen = [];
  const provider = { structured: async (request) => { seen.push(request); return request.parse({ samples: ["Cheap beans today", THREE[1], THREE[2]] }); } };
  const snapshot = voice.voiceSnapshotFromSections(SECTIONS);
  const result = await voice.writeVoiceSamples(provider, snapshot);
  assert.deepEqual(result, [THREE[1], THREE[2]], "the banned-word caption never comes back");
  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.equal(request.messages[0].content, voice.BRAND_VOICE_SYSTEM_PROMPT);
  const payload = JSON.parse(request.messages[1].content);
  assert.deepEqual(payload.business, { name: "Bean & Co.", category: "Restaurant / Café", description: snapshot.description, offerings: snapshot.offerings, audience: snapshot.audience, goal: snapshot.goal });
  assert.deepEqual(payload.avoid, { rules: ["Not salesy"], words: ["cheap", "Discount"] });
  assert.deepEqual(payload.facts, ["Roasting since 2014"]);
  assert.deepEqual(payload.samples, { soundsLikeUs: ["Morning light, first pour."], notUs: ["50% OFF!!! Buy now!"] });
  assert.doesNotMatch(request.messages[1].content, /Near the marina/, "an unconfirmed fact is never sent");
  assert.equal(request.temperature, 0.8);
  assert.equal(request.maxAttempts, 2);
  assert.equal(request.jsonSchema, voice.brandVoiceSamplesJsonSchema);
});

function login(loggedIn = true) {
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    auth: { getClaims: async () => (loggedIn ? { data: { claims: { sub: "owner-1", email: "owner@example.com" } }, error: null } : { data: null, error: { message: "no session" } }) },
    from() { throw new Error("the action must not touch any table"); },
  };
}

test("the action answers with a plain reason, spends the bucket only when it calls, and stores nothing", async () => {
  const snapshot = voice.voiceSnapshotFromSections(SECTIONS);
  const quiet = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    login(false);
    assert.deepEqual(await writeBrandVoiceSamples(snapshot), { ok: false, reason: "login" });

    login(true);
    globalThis.__VOOM_RATE_LIMIT_OK__ = true;
    assert.deepEqual(await writeBrandVoiceSamples({ ...snapshot, extra: 1 }), { ok: false, reason: "invalid" });
    assert.deepEqual(await writeBrandVoiceSamples("nope"), { ok: false, reason: "invalid" });

    globalThis.__VOOM_FAKE_AI__ = () => { throw new AiError("not_configured"); };
    assert.deepEqual(await writeBrandVoiceSamples(snapshot), { ok: false, reason: "not_configured" });

    globalThis.__VOOM_RATE_LIMIT_OK__ = false;
    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async () => { throw new Error("must not be called when rate limited"); } });
    assert.deepEqual(await writeBrandVoiceSamples(snapshot), { ok: false, reason: "rate_limited" });

    globalThis.__VOOM_RATE_LIMIT_OK__ = true;
    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async () => { throw new AiError("unavailable", "The AI provider returned HTTP 401."); } });
    assert.deepEqual(await writeBrandVoiceSamples(snapshot), { ok: false, reason: "unavailable" });
    assert.ok(logged.some(([line, detail]) => line === "[brand-voice] failed" && detail.message === "The AI provider returned HTTP 401."), "the log says why, not only the code");

    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async () => { throw new AiError("rate_limited"); } });
    assert.deepEqual(await writeBrandVoiceSamples(snapshot), { ok: false, reason: "rate_limited" });

    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async (request) => request.parse({ samples: ["cheap one", "Cheap two", "CHEAP three"] }) });
    assert.deepEqual(await writeBrandVoiceSamples(snapshot), { ok: false, reason: "unavailable" }, "every caption dropped is a failed write, never an empty success");

    globalThis.__VOOM_FAKE_AI__ = () => ({ structured: async (request) => request.parse({ samples: THREE }) });
    assert.deepEqual(await writeBrandVoiceSamples(snapshot), { ok: true, samples: THREE });
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(rateLimit.AI_RATE_LIMITS.brand_voice, { limit: 20, windowSeconds: 3600 });
  const source = await read("lib/brand/voice-actions.ts");
  assert.match(source, /consumeAiRateLimit\(user\.id, "brand_voice"\)/);
  assert.doesNotMatch(source, /\.from\(|insert\(|upsert\(/, "the action stores nothing");
  const vision = await read("app/api/brand/assets/describe/route.ts");
  assert.match(vision, /console\.error\("\[brand-vision\] failed", \{ code, kind: input\.kind, message:/, "the vision log says why too (found diagnosing a bad key, 2026-10-27)");
});

/* ── 6. Sorting ──────────────────────────────────────────────────────────── */

test("a tap moves a caption between the lists, a second tap removes it, and each list stops at five", () => {
  const { sortSample } = samplesUi;
  const empty = { liked: [], disliked: [] };
  const liked = sortSample(empty, THREE[0], "liked");
  assert.deepEqual(liked, { liked: [THREE[0]], disliked: [] });
  assert.deepEqual(sortSample(liked, THREE[0], "disliked"), { liked: [], disliked: [THREE[0]] }, "switching sides");
  assert.deepEqual(sortSample(liked, THREE[0], "liked"), { liked: [], disliked: [] }, "the same tap again removes it");
  const full = { liked: ["a", "b", "c", "d", "e"], disliked: [] };
  assert.equal(sortSample(full, THREE[1], "liked"), null, "a full list refuses");
  assert.deepEqual(sortSample(full, THREE[1], "disliked"), { liked: full.liked, disliked: [THREE[1]] }, "the other list still takes it");
  assert.equal(samplesUi.VOICE_WAIT_MS, 8_000);
  assert.match(samplesUi.voiceSamplesMessage("not_configured"), /text model isn't set up/);
  assert.match(samplesUi.voiceSamplesMessage("rate_limited"), /a lot this hour/);
  assert.match(samplesUi.voiceSamplesMessage("unavailable"), /couldn't write samples just now/);

  const html = renderToStaticMarkup(h(samplesUi.VoiceSampleCards, { samples: THREE, liked: [THREE[0]], disliked: [THREE[2]], onSort: () => {} }));
  assert.equal((html.match(/Sounds like us/g) ?? []).length, 3);
  assert.equal((html.match(/Not us/g) ?? []).length, 3);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2, "one liked, one disliked");
  assert.match(html, /line-through/, "a rejected caption reads as rejected");
});

/* ── 7. The wizard and what Finish stores ────────────────────────────────── */

test("the wizard writes once per set of answers, waits 8 s at most, and a failure points to the Brand page", async () => {
  const source = await read("components/voom/onboarding/OnboardingWizard.tsx");
  const ui = await read("components/voom/brand/VoiceSamples.tsx");
  assert.match(ui, /Promise\.race<VoiceSamplesResult>/, "the write is raced against the wait");
  assert.match(ui, /setTimeout\(\(\) => resolve\(\{ ok: false, reason: "unavailable" \}\), VOICE_WAIT_MS\)/);
  assert.match(source, /onboard\.samplesFor === key/, "the same answers never ask twice");
  assert.match(source, /if \(!current\) void write\(\);/, "the write starts when the screen opens");
  assert.match(source, /I&apos;ll show you samples on your Brand page\./, "the design's fallback line");
  assert.match(source, /Try 3 more/);
  assert.match(source, /Three captions MARA wrote from what she knows so far/);
  assert.match(source, /Nothing is used unless you say so/);
  assert.match(source, /voice: \{ personality: onboard\.tone, liked: onboard\.liked, disliked: onboard\.disliked \}/, "the Brand Brief screen shows the sorted captions");
  assert.equal(wizard.LAST_STEP, 10, "still eleven screens: the captions live on the voice screen");
  assert.deepEqual([...wizard.SKIPPABLE_STEPS], [1, 5, 6, 7, 9, 10], "the voice screen can still be skipped");

  const store = await read("lib/voom/store.tsx");
  assert.match(store, /voiceSamples: \{ liked: o\.liked, disliked: o\.disliked \}/, "Finish sends the sorted captions");
  assert.match(store, /liked: \[\],\s*disliked: \[\],\s*samples: \[\],\s*samplesFor: "",\s*samplesNote: ""/, "a fresh onboarding starts empty");
});

test("the kit stores the sorted captions as voice samples, capped, and generation reads them", () => {
  const base = {
    displayName: "Alex", brandName: "Bean & Co.", brandDescription: "We roast our own beans.", industry: "Restaurant / Café",
    targetCustomer: [], mainGoal: "More walk-in customers", brandPersonality: ["Friendly"], preferredChannels: [], monthlyAdBudget: "",
    contentFrequency: "2–3 times a week", automationLevel: "manual", publishingPermission: "",
    kit: { brief: "", offerings: [], rules: [], words: [], notes: "", facts: [] },
  };
  assert.equal("voice_samples" in versions.brandKitAnswersFromOnboarding(base), false, "nothing sorted, nothing written (an earlier version's samples carry forward)");

  const answers = versions.brandKitAnswersFromOnboarding({ ...base, kit: { ...base.kit, voiceSamples: { liked: [THREE[0], " ", THREE[0], "a", "b", "c", "d", "e"], disliked: [THREE[2]] } } });
  assert.deepEqual(answers.voice_samples, { liked: [THREE[0], "a", "b", "c", "d"], disliked: [THREE[2]] }, "trimmed, deduped, five at most");

  const extras = context.brandKitExtrasFromRow({ answers, brief: "" });
  assert.deepEqual(extras.voiceSamples, { liked: [THREE[0], "a", "b", "c", "d"], disliked: [THREE[2]] });
  const prompt = context.brandKitPromptContext(extras);
  assert.deepEqual(prompt.voiceSamples, { soundsLikeUs: [THREE[0], "a", "b", "c", "d"], notUs: [THREE[2]] }, "the same block generation read before slice 6");
});

/* ── 8. The Brand page ───────────────────────────────────────────────────── */

test("the How we sound editor offers MARA's samples and a tap lands in the draft's lists", async () => {
  const hub = await read("components/voom/brand/BrandHub.tsx");
  assert.match(hub, /Write 3 new samples/);
  assert.match(hub, /<VoiceSamplesWriter values=\{values\} draft=\{d\} disabled=\{disabled\} onChange=\{onChange\} \/>/, "inside the voice editor only");
  assert.match(hub, /requestVoiceSamples\(voiceSnapshotFromSections\(\{ \.\.\.values, voice: draft \}\)\)/, "MARA writes from the saved sections plus this draft");
  assert.match(hub, /onChange\(\{ \.\.\.draft, \.\.\.next \}\)/, "a tap changes the draft, so Save records it like a typed sample");
  assert.match(hub, /if \(join\(items\) !== emitted\) \{\s*setEmitted\(join\(items\)\);\s*setText\(join\(items\)\);/, "the typed boxes follow a tapped caption");
  assert.match(hub, /Remove one below first/);
});
