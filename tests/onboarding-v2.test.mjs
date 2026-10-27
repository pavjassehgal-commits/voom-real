/**
 * Onboarding, Brand Kit v2 slice 3 (docs/brand-kit-v2-design.md).
 *
 *   1. Ten screens, five required answers, per-screen Skip only where the
 *      answer has a safe default, and no global Skip.
 *   2. The automation screen offers the three REAL modes with the plan each
 *      needs, and the saved value is the one the plan allows (the wish is kept).
 *   3. The channel screen leads with Instagram and TikTok and shows LinkedIn
 *      as coming soon; the full channel list stays for Settings and the hub.
 *   4. Finish writes the businesses row (budget and permission left empty)
 *      and brand kit version 1 with the kit-only answers and the brief.
 *   5. Settings no longer duplicates the brand form.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import { importApp, react, renderToStaticMarkup } from "./helpers/rendered-surface.mjs";

const { createElement: h } = react;
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/utils/supabase/server") {
      return { url: `data:text/javascript,${encodeURIComponent("export async function createClient() { return globalThis.__VOOM_FAKE_SUPABASE__; }")}`, shortCircuit: true };
    }
    if (specifier === "@/utils/supabase/admin") {
      return { url: `data:text/javascript,${encodeURIComponent("export function createAdminClient() { throw new Error('supabase_admin_not_configured'); }")}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const data = await importApp("lib/voom/onboardingData.ts");
const wizard = await importApp("components/voom/onboarding/OnboardingWizard.tsx");
const versions = await importApp("lib/brand/versions.ts");
const { saveOnboarding } = await importApp("lib/voom/mutations.ts");
const { Providers } = await importApp("app/app/Providers.tsx");

/* ── 1. Screens and rules ────────────────────────────────────────────────── */

test("eleven screens, five required answers, Skip only where a default is safe, no global Skip", async () => {
  // Slice 5 added "Give MARA your brand" (logo and photos) as screen 2; tests/brand-assets.test.mjs covers it.
  assert.deepEqual(data.OB_STEPS, ["Your name", "Logo & photos", "Your brand", "The basics", "Audience & goal", "Your voice", "What to avoid", "Pace", "Working style", "Brand Brief", "Your channels"]);
  assert.equal(wizard.LAST_STEP, 10);
  assert.deepEqual([...wizard.SKIPPABLE_STEPS], [1, 5, 6, 7, 9, 10], "images, voice, avoid, pace, brief and channels can be skipped");

  const empty = { displayName: "", desc: "", industry: "", goal: "", auto: "" };
  const full = { displayName: "Alex", desc: "We roast our own beans near the marina.", industry: "Restaurant / Café", goal: "More walk-in customers", auto: "assisted" };
  const required = [0, 2, 3, 4, 8].map((step) => wizard.stepBlocker(step, empty));
  assert.deepEqual(required, [
    "Tell MARA what to call you",
    "Tell MARA a little more — a sentence or two",
    "Pick the kind of business",
    "Choose your main marketing goal",
    "Choose how much MARA should do",
  ]);
  for (const step of [1, 5, 6, 7, 9, 10]) assert.equal(wizard.stepBlocker(step, empty), null, `screen ${step + 1} never blocks`);
  for (let step = 0; step <= 10; step += 1) assert.equal(wizard.stepBlocker(step, full), null);
  assert.equal(wizard.stepBlocker(2, { ...full, desc: "Four words only here" }), "Tell MARA a little more — a sentence or two");

  const source = await read("components/voom/onboarding/OnboardingWizard.tsx");
  assert.doesNotMatch(source, /finish\(true\)/, "the global Skip (finish as skipped) is gone");
  assert.match(source, /Skip this step/);
  assert.match(source, /SKIPPABLE_STEPS\.includes\(st\) \? \(/, "Skip is shown per screen only");
  assert.doesNotMatch(source, /Q_BUDGET|Q_PERM|Q_AUTO\b|MaraUnderstands|monthly paid-advertising budget|ask permission before publishing/i, "budget and permission questions are gone");
  assert.doesNotMatch(source, /Q_CHANNELS/, "the wizard uses its own channel list");
  assert.equal(data.DEFAULT_FREQ, "2–3 times a week");
});

test("the automation screen offers the three real modes with the plan each needs", () => {
  assert.deepEqual(data.AUTOMATION_CHOICES.map((choice) => choice.value), ["manual", "assisted", "autopilot"]);
  assert.deepEqual(data.AUTOMATION_CHOICES.map((choice) => choice.plan), ["Free plan", "Pro plan", "Max plan"]);
  assert.equal("Q_AUTO" in data, false, "the old title-text cards are gone");
  assert.equal("Q_PERM" in data, false);
  assert.equal("Q_BUDGET" in data, false);
});

test("the saved mode is what the plan allows; the wish is kept for the upgrade prompt", async () => {
  const store = await read("lib/voom/store.tsx");
  assert.match(store, /const wanted = storedAutomationMode\(o\.auto\)/);
  assert.match(store, /canUseAutomationMode\(state\.plan, wanted\)/);
  assert.match(store, /state\.plan === "pro" \? "assisted" : "manual"/, "Pro falls back to Assisted, Free to Manual");
  assert.match(store, /automationLevel: skipped \? "" : allowed/);
  assert.match(store, /wanted !== allowed \? \{ wantedAutomation: wanted \}/);
  assert.match(store, /monthlyAdBudget: "",\s*contentFrequency/, "budget is no longer collected");
  assert.match(store, /publishingPermission: "",/, "permission is no longer collected");
  assert.match(store, /freq: DEFAULT_FREQ,/, "the pace default is preselected so Skip is safe");
});

/* ── 3. Channels ─────────────────────────────────────────────────────────── */

test("the channel screen leads with Instagram and TikTok and shows LinkedIn as coming soon", () => {
  assert.deepEqual(data.ONBOARDING_CHANNELS, [
    { label: "Instagram", available: true },
    { label: "TikTok", available: true },
    { label: "LinkedIn", available: false },
  ]);
  assert.deepEqual(data.Q_CHANNELS, ["Instagram", "TikTok", "YouTube", "Email"], "the full list stays for Settings and the Brand page");
});

/* ── 4. Finish writes businesses + brand kit version 1 ───────────────────── */

function onboardingInput(overrides = {}) {
  return {
    displayName: "Alex", brandName: "Bean & Co.", brandDescription: "We roast our own beans.", industry: "Restaurant / Café",
    targetCustomer: ["Local residents nearby"], mainGoal: "More walk-in customers", brandPersonality: ["Friendly"],
    preferredChannels: ["Instagram", "TikTok"], monthlyAdBudget: "", contentFrequency: "2–3 times a week", automationLevel: "manual", publishingPermission: "",
    website: "",
    kit: { brief: "A small family-run roaster.", offerings: ["Single-origin espresso"], rules: ["Not salesy"], words: ["cheap"], notes: "Always say roastery.", facts: ["Roasting since 2014"], wantedAutomation: "autopilot" },
    ...overrides,
  };
}

test("the kit answers from onboarding carry the new screens and omit the retired fields", () => {
  const answers = versions.brandKitAnswersFromOnboarding(onboardingInput());
  assert.deepEqual(answers, {
    name: "Bean & Co.", description: "We roast our own beans.", category: "Restaurant / Café",
    audience: ["Local residents nearby"], goal: "More walk-in customers", personality: ["Friendly"],
    channels: ["Instagram", "TikTok"], pace: "2–3 times a week", automation: "manual",
    offerings: ["Single-origin espresso"], avoid: { rules: ["Not salesy"], words: ["cheap"] }, notes: "Always say roastery.",
    facts_confirmed: ["Roasting since 2014"], wanted_automation: "autopilot",
  });
  assert.equal("budget" in answers, false);
  assert.equal("publishing_permission" in answers, false);
  const noKit = versions.brandKitAnswersFromOnboarding(onboardingInput({ kit: undefined }));
  assert.equal("avoid" in noKit, false, "a skipped (legacy) finish writes only the core keys");
});

test("Finish setup writes the businesses row and brand kit version 1 with the brief and rules", async () => {
  const calls = { upserts: [], kitInserts: [] };
  const chain = (result) => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => result }; return q; };
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    from(table) {
      if (table === "brand_kits") { const q = chain({ data: null, error: null }); q.insert = async (row) => { calls.kitInserts.push(row); return { error: null }; }; return q; }
      return { upsert: async (payload) => { calls.upserts.push({ table, payload }); return { error: null, data: { id: "row-1" } }; } };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: "owner-1", email: "owner@example.com" } }, error: null }) },
  };
  assert.deepEqual(await saveOnboarding(onboardingInput()), { ok: true });
  const business = calls.upserts.find((call) => call.table === "businesses").payload;
  assert.equal(business.automation_level, "manual", "a real mode value, never the card title");
  assert.equal(business.monthly_ad_budget, null);
  assert.equal(business.publishing_permission, null);
  assert.deepEqual(business.preferred_channels, ["Instagram", "TikTok"]);
  assert.equal(business.onboarding_completed, true);
  const kit = calls.kitInserts[0];
  assert.equal(kit.version, 1);
  assert.equal(kit.source, "onboarding");
  assert.equal(kit.brief, "A small family-run roaster.");
  assert.deepEqual(kit.answers.avoid, { rules: ["Not salesy"], words: ["cheap"] });
  assert.deepEqual(kit.answers.facts_confirmed, ["Roasting since 2014"]);
  assert.equal(kit.answers.wanted_automation, "autopilot");
});

/* ── Render ──────────────────────────────────────────────────────────────── */

test("a new account's wizard renders its first screen with progress and no global Skip", () => {
  const html = renderToStaticMarkup(
    h(Providers, { initialDisplayName: null, initialEmail: "new@example.com", initialBusiness: null }, h(wizard.OnboardingWizard)),
  );
  assert.match(html, /What should MARA call you\?/);
  assert.match(html, /Step 1 of 11/);
  assert.doesNotMatch(html, />Skip</, "no header Skip button");
  assert.doesNotMatch(html, /Skip this step/, "the name screen cannot be skipped");
  assert.match(html, /Continue/);
});

/* ── 5. Settings ─────────────────────────────────────────────────────────── */

test("Settings points at the Brand page instead of duplicating the brand form", async () => {
  const settings = await read("app/app/(shell)/settings/page.tsx");
  assert.match(settings, /Open Brand page/);
  assert.match(settings, /goTo\("brand"\)/);
  assert.match(settings, /goTo\("automations"\)/);
  assert.doesNotMatch(settings, /Brand profile<\/h2>|Voom automation<\/h2>|autonomyRows|toggleTone|Q_INDUSTRY|OB_TONE/);
  assert.match(settings, /brandDescription: brand\.desc/, "the save round-trips the stored brand values unchanged");
});
