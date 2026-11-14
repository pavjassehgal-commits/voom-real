/**
 * Brand Hub (Brand Kit v2, slice 2).
 *
 *   1. Sections own disjoint fields; validation cleans, caps and refuses.
 *   2. The page's values come from the newest kit, falling back to the
 *      `businesses` row for the core fields.
 *   3. The save action (REAL, fake database) updates only the `businesses`
 *      columns its section owns and appends a version that carries every
 *      other field forward; failures are plain messages.
 *   4. The hub renders with a kit, without one, and in onboarding mode.
 *   5. "Brand" is in the navigation with a path, a title and a page.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import { importApp, react, renderToStaticMarkup } from "./helpers/rendered-surface.mjs";

const { createElement: h } = react;
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Registered AFTER the rendered-surface helper so this exact specifier wins.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/utils/supabase/server") {
      return { url: `data:text/javascript,${encodeURIComponent("export async function createClient() { return globalThis.__VOOM_FAKE_SUPABASE__; }")}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const sections = await importApp("lib/brand/sections.ts");
const read_ = await importApp("lib/brand/read.ts");
const { saveBrandSection } = await importApp("lib/brand/actions.ts");
const { BrandHub } = await importApp("components/voom/brand/BrandHub.tsx");

/* ── 1. Sections ─────────────────────────────────────────────────────────── */

test("every brand-kit field belongs to exactly one section, and the core fields map to businesses columns", () => {
  const owned = sections.BRAND_SECTIONS.flatMap((section) => section.ownsKeys);
  assert.equal(new Set(owned).size, owned.length, "no field is owned twice");
  assert.deepEqual(sections.BRAND_SECTIONS.map((section) => section.id), ["basics", "brief", "offerings", "audience", "voice", "avoid", "facts", "assets", "operate"], "slice 5 added the images section before operations");
  const byId = Object.fromEntries(sections.BRAND_SECTIONS.map((section) => [section.id, section]));
  assert.deepEqual(byId.basics.businessColumns, ["brand_name", "brand_description", "industry"]);
  assert.deepEqual(byId.audience.businessColumns, ["target_customer", "main_goal"]);
  assert.deepEqual(byId.voice.businessColumns, ["brand_personality"]);
  assert.deepEqual(byId.operate.businessColumns, ["content_frequency", "preferred_channels", "automation_level"]);
  for (const kitOnly of ["brief", "offerings", "avoid", "facts", "assets"]) assert.deepEqual(byId[kitOnly].businessColumns, [], `${kitOnly} is kit-only`);
  assert.equal(byId.operate.hubOnly, true, "onboarding's last screen shows the brand, not operations");
  assert.equal(sections.AVOID_RULES.length, 6);
});

test("section validation cleans lists, caps lengths, and refuses unknown sections and bad shapes", () => {
  const audience = sections.validateBrandSection("audience", { audience: [" Families with children ", "Families with children", "", "Tourists & visitors"], goal: " More bookings & appointments " });
  assert.equal(audience.ok, true);
  assert.deepEqual(audience.answers, { audience: ["Families with children", "Tourists & visitors"], goal: "More bookings & appointments" });
  assert.deepEqual(audience.business, { target_customer: ["Families with children", "Tourists & visitors"], main_goal: "More bookings & appointments" });

  const voice = sections.validateBrandSection("voice", { personality: ["Professional", "Bold"], liked: ["Morning light, first pour."], disliked: [] });
  assert.deepEqual(voice.answers, { personality: ["Professional", "Bold"], voice_samples: { liked: ["Morning light, first pour."], disliked: [] } });
  assert.deepEqual(voice.business, { brand_personality: ["Professional", "Bold"] });

  const avoid = sections.validateBrandSection("avoid", { rules: ["Not salesy"], words: ["cheap", "CHEAP", "deal"], notes: "Family-run." });
  assert.deepEqual(avoid.answers, { avoid: { rules: ["Not salesy"], words: ["cheap", "CHEAP", "deal"] }, notes: "Family-run." });
  assert.deepEqual(avoid.business, {});

  const brief = sections.validateBrandSection("brief", { brief: "  A small roaster.  " });
  assert.equal(brief.brief, "A small roaster.");
  assert.deepEqual(brief.answers, {}, "the brief lives in its own column, not in answers");

  const operate = sections.validateBrandSection("operate", { pace: "Daily", channels: ["Instagram"] });
  assert.deepEqual(operate.answers, { pace: "Daily", channels: ["Instagram"] }, "automation is only written when given");
  assert.equal("automation_level" in operate.business, false);
  const withMode = sections.validateBrandSection("operate", { pace: "", channels: [], automation: "manual" });
  assert.equal(withMode.business.automation_level, "manual");
  assert.equal(withMode.business.content_frequency, null, "an empty pace clears the column");

  const big = sections.validateBrandSection("offerings", { offerings: Array.from({ length: 30 }, (_, i) => `item ${i}`) });
  assert.equal(big.answers.offerings.length, 20, "capped");

  assert.deepEqual(sections.validateBrandSection("gallery", {}), { ok: false, error: "That section does not exist." });
  assert.equal(sections.validateBrandSection("operate", { automation: "turbo" }).ok, false);
  assert.equal(sections.validateBrandSection("facts", { facts: "not a list" }).ok, false);
  assert.equal(sections.validateBrandSection("basics", { name: "x", extra: 1 }).ok, false, "unknown keys are refused");
});

/* ── 2. Values for the page ──────────────────────────────────────────────── */

const BUSINESS = {
  brand_name: "Bean & Co.", brand_description: "We roast our own beans.", industry: "Restaurant / Café",
  target_customer: ["Local residents nearby"], main_goal: "More walk-in customers", brand_personality: ["Friendly"],
  preferred_channels: ["Instagram"], content_frequency: "2–3 times a week", automation_level: "assisted",
};
const KIT = {
  version: 3,
  brief: "A small family-run roaster.",
  answers: {
    name: "Bean & Co.", category: "Restaurant / Café", audience: ["Families with children"], goal: "More bookings & appointments",
    offerings: ["Single-origin espresso"], avoid: { rules: ["Not salesy"], words: ["cheap"] }, facts_confirmed: ["Roasting since 2014"],
    notes: "Always mention we are family-run.", voice_samples: { liked: ["Morning light, first pour."], disliked: ["50% OFF!!!"] },
  },
};

test("the page's values come from the newest kit and fall back to businesses for the core fields", () => {
  const withKit = sections.brandHubValues(BUSINESS, KIT);
  assert.equal(withKit.brief.brief, KIT.brief);
  assert.deepEqual(withKit.audience, { audience: ["Families with children"], goal: "More bookings & appointments" }, "the kit wins where it has a value");
  assert.equal(withKit.basics.description, "We roast our own beans.", "a key the kit never saved falls back to businesses");
  assert.deepEqual(withKit.voice.personality, ["Friendly"]);
  assert.deepEqual(withKit.avoid, { rules: ["Not salesy"], words: ["cheap"], notes: "Always mention we are family-run." });
  assert.deepEqual(withKit.operate, { pace: "2–3 times a week", channels: ["Instagram"], automation: "assisted" });

  const noKit = sections.brandHubValues(BUSINESS, null);
  assert.deepEqual(noKit.basics, { name: "Bean & Co.", description: "We roast our own beans.", category: "Restaurant / Café" });
  assert.deepEqual(noKit.avoid, { rules: [], words: [], notes: "" });
  assert.equal(noKit.brief.brief, "");

  const nothing = sections.brandHubValues(null, null);
  assert.deepEqual(nothing.operate, { pace: "", channels: [] }, "an unknown automation value is left unset, never guessed");

  const view = read_.brandKitVersionView({ version: 2, answers: "garbage", brief: null, source: "brand_hub", change_summary: null, changed_keys: ["audience"], created_at: "2026-10-23T10:00:00.000Z" });
  assert.deepEqual(view, { version: 2, answers: {}, brief: "", assets: [], source: "brand_hub", changeSummary: "", changedKeys: ["audience"], createdAt: "2026-10-23T10:00:00.000Z" });
});

/* ── 3. The save action ──────────────────────────────────────────────────── */

function fakeDb({ newestRow = null, insertError = null, updateError = null, loggedIn = true } = {}) {
  const calls = { businessUpdates: [], kitInserts: [] };
  const chain = (result) => {
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => result };
    return q;
  };
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    from(table) {
      if (table === "brand_kits") {
        const q = chain({ data: newestRow, error: null });
        q.insert = async (row) => { calls.kitInserts.push(row); return { error: insertError }; };
        return q;
      }
      if (table === "businesses") {
        return { update: (payload) => { calls.businessUpdates.push(payload); const u = { eq: () => u, then: (resolve) => resolve({ error: updateError, data: null }) }; return u; } };
      }
      throw new Error(`unexpected table ${table}`);
    },
    auth: { getClaims: async () => (loggedIn ? { data: { claims: { sub: "owner-1", email: "owner@example.com" } }, error: null } : { data: null, error: { message: "no session" } }) },
  };
  return calls;
}

test("a save that changes nothing names no field: the history line matches what the row records (fix 2026-10-27)", async () => {
  const calls = fakeDb({ newestRow: { version: 3, answers: KIT.answers, brief: KIT.brief } });
  const result = await saveBrandSection("offerings", { offerings: ["Single-origin espresso"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedKeys, [], "the action no longer claims every field the section owns");
  assert.equal(result.changeSummary, "What we offer saved without changes");
  assert.deepEqual(calls.kitInserts[0].changed_keys, [], "the same set the row records");
});

test("saving a section updates only its businesses columns and appends a version that carries the rest forward", async () => {
  const calls = fakeDb({ newestRow: { version: 3, answers: KIT.answers, brief: KIT.brief } });
  const result = await saveBrandSection("audience", { audience: ["Tourists & visitors"], goal: "More online sales" });
  assert.equal(result.ok, true);
  assert.equal(result.version, 4);
  assert.deepEqual(result.changedKeys, ["audience", "goal"]);
  assert.deepEqual(calls.businessUpdates, [{ target_customer: ["Tourists & visitors"], main_goal: "More online sales" }], "only the owned columns");
  const row = calls.kitInserts[0];
  assert.equal(row.version, 4);
  assert.equal(row.source, "brand_hub");
  assert.equal(row.brief, KIT.brief, "the brief carries forward");
  assert.deepEqual(row.answers.avoid, KIT.answers.avoid, "the rules carry forward");
  assert.equal(row.answers.notes, KIT.answers.notes);
  assert.deepEqual(row.answers.audience, ["Tourists & visitors"]);
  assert.deepEqual(row.changed_keys, ["audience", "goal"]);
  assert.equal(row.change_summary, "Who we're for updated");
});

test("a kit-only section never touches businesses; the brief has its own column", async () => {
  const calls = fakeDb({ newestRow: { version: 1, answers: { name: "Bean & Co." }, brief: "Old brief." } });
  const result = await saveBrandSection("brief", { brief: "New brief." });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.businessUpdates, []);
  assert.equal(calls.kitInserts[0].brief, "New brief.");
  assert.deepEqual(calls.kitInserts[0].answers, { name: "Bean & Co." });
  assert.deepEqual(calls.kitInserts[0].changed_keys, ["brief"]);
});

test("the action fails plainly: logged out, invalid values, businesses error, kit insert error", async () => {
  fakeDb({ loggedIn: false });
  assert.deepEqual(await saveBrandSection("facts", { facts: ["x"] }), { ok: false, error: "Your session has expired. Please log in again." });

  const invalid = fakeDb();
  assert.equal((await saveBrandSection("facts", { facts: "nope" })).ok, false);
  assert.deepEqual(invalid.kitInserts, [], "nothing is written for invalid values");

  fakeDb({ updateError: { message: "boom" } });
  assert.deepEqual(await saveBrandSection("basics", { name: "Bean & Co.", description: "", category: "" }), { ok: false, error: "Voom couldn't save that. Please try again." });

  const original = console.error;
  console.error = () => {};
  try {
    fakeDb({ insertError: { message: "relation brand_kits does not exist" } });
    const result = await saveBrandSection("facts", { facts: ["Roasting since 2014"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /migration \(0075, brand kits\)/);
  } finally {
    console.error = original;
  }
});

/* ── 4. Rendering ────────────────────────────────────────────────────────── */

const HISTORY = [
  { version: 3, answers: KIT.answers, brief: KIT.brief, source: "brand_hub", changeSummary: "What we avoid updated", changedKeys: ["avoid"], createdAt: "2026-10-23T10:00:00.000Z" },
  { version: 2, answers: { name: "Bean & Co." }, brief: KIT.brief, source: "brand_hub", changeSummary: "Brand Brief updated", changedKeys: ["brief"], createdAt: "2026-10-22T10:00:00.000Z" },
  { version: 1, answers: { name: "Bean & Co." }, brief: "", source: "onboarding", changeSummary: "Onboarding completed", changedKeys: [], createdAt: "2026-10-21T10:00:00.000Z" },
];

test("the hub shows every section as plain text, the banner, and the history with what changed", () => {
  const html = renderToStaticMarkup(h(BrandHub, { mode: "hub", initialValues: sections.brandHubValues(BUSINESS, KIT), history: HISTORY, plan: "free", automation: "assisted" }));
  assert.match(html, /Edits apply from the next generation\./);
  for (const title of ["The basics", "Brand Brief", "What we offer", "Who we're for", "How we sound", "What we avoid", "Facts MARA may state", "What MARA may do", "History"]) {
    assert.ok(html.includes(title.replace(/'/g, "&#x27;")), `section "${title}" is shown`);
  }
  assert.match(html, /A small family-run roaster\./);
  assert.match(html, /Roasting since 2014/);
  assert.match(html, /Banned words: <b[^>]*>cheap<\/b>/);
  assert.match(html, /Morning light, first pour\./);
  assert.match(html, /50% OFF!!!/);
  assert.match(html, /Automation level · Assisted/);
  // History: one line per version, newest first, naming what changed.
  assert.match(html, /v3<\/span>.*What we avoid.*23 Oct 2026 · Brand page/s);
  assert.match(html, /v2<\/span>.*Brand Brief.*22 Oct 2026/s);
  assert.match(html, /v1<\/span>.*No field changed.*21 Oct 2026 · Onboarding/s);
  assert.equal((html.match(/data-brand-section=/g) ?? []).length, 9, "eight sections plus the images section (slice 5)");
  assert.doesNotMatch(html, /Looks right/);
});

test("without a kit the hub tells the truth about what is missing instead of inventing values", () => {
  const html = renderToStaticMarkup(h(BrandHub, { mode: "hub", initialValues: sections.brandHubValues(BUSINESS, null), history: [], plan: "free", automation: "manual" }));
  assert.match(html, /No brief yet\. Until you write one, MARA works from your description\./);
  assert.match(html, /No confirmed facts\. MARA states no years, awards or numbers/);
  assert.match(html, /No versions yet\./);
  assert.match(html, /We roast our own beans\./, "the businesses description still shows");
  assert.match(html, /Automation level · Manual/);
});

test("list fields keep what the user types: separators are never re-derived from the parsed list while typing", async () => {
  const source = await read("components/voom/brand/BrandHub.tsx");
  // Every typed list goes through ListText, which holds the raw text in its own state.
  assert.match(source, /function ListText\(/);
  assert.match(source, /const \[text, setText\] = useState\(items\.join\(/);
  assert.doesNotMatch(source, /value=\{d\.\w+\.join\(/, "no input derives its value from the parsed list");
  assert.doesNotMatch(source, /onChange=\{\(e\) => onChange\(\{[^}]*\.split\(/, "no input splits inside its own onChange");
  assert.equal((source.match(/<ListText /g) ?? []).length, 5, "offerings, liked, disliked, banned words and facts");
});

test("onboarding mode is the same component without History or operations, ending in Looks right", () => {
  const html = renderToStaticMarkup(h(BrandHub, { mode: "onboarding", initialValues: sections.brandHubValues(BUSINESS, KIT), history: HISTORY, plan: "free", automation: "assisted", onDone: () => {} }));
  assert.match(html, /Looks right/);
  assert.doesNotMatch(html, /Edits apply from the next generation/, "the hub banner is for the live page, not the wizard");
  // Without an onDone the wizard's own footer drives the step, so no second button.
  const inWizard = renderToStaticMarkup(h(BrandHub, { mode: "onboarding", persist: "local", initialValues: sections.brandHubValues(BUSINESS, KIT), history: [], plan: "free", automation: "assisted" }));
  assert.doesNotMatch(inWizard, /Looks right/);
  assert.doesNotMatch(html, />History</);
  assert.doesNotMatch(html, /What MARA may do/);
  assert.equal((html.match(/data-brand-section=/g) ?? []).length, 7);
});

/* ── 5. Navigation and page ──────────────────────────────────────────────── */

test("Brand is reachable from the Primary navigation with a path, a title and a server page", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  // Since the 2026-11-01 merge with main the shell is the redesign: Today uses its "house" icon and the first group is "Workspace".
  assert.match(nav, /\{ id: "today", n: "Today", i: "house" \},\s*\{ id: "brand", n: "Brand", i: "heart" \}/, "right after Today in the Workspace group");
  assert.match(nav, /brand: "Brand"/);
  const store = await read("lib/voom/store.tsx");
  assert.match(store, /brand: "\/app\/brand"/);
  const page = await read("app/app/(shell)/brand/page.tsx");
  assert.match(page, /getCurrentUser\(\), getBusinessRecord\(\)/);
  assert.match(page, /loadBrandKitHistory\(await createClient\(\), user\.id\)/, "reads through the user-scoped client, so RLS applies");
  assert.match(page, /brandHubValues\(business, current\)/);
  assert.match(page, /mode="hub"/);
});
