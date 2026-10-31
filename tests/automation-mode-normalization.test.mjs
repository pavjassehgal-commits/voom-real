/**
 * Automation mode normalization: onboarding answers, unset values, explicit
 * confirmation and scheduled-planning eligibility.
 *
 * Production stores onboarding answers verbatim ("MARA drafts, I approve") or
 * nothing at all for some accounts. The scheduled coordinator only acts on the
 * exact canonical values, so those accounts silently missed planning while the
 * UI described them as Assisted. These tests pin the shared reading of a stored
 * value, the canonical save paths, and that nothing ever becomes Autopilot or
 * starts scheduled planning without the owner's explicit, plan-checked choice.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const automation = await import("../lib/voom/automation.ts");
const onboarding = await import("../lib/voom/onboardingData.ts");
const safety = await import("../lib/voom/automation-safety.ts");
const coordinator = await import("../lib/coordinator/service.ts");
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const LEGACY = {
  "I decide everything": "manual",
  "MARA drafts, I approve": "assisted",
  "MARA drafts and schedules": "assisted",
  "MARA runs it end-to-end": "assisted",
};

test("every stored value has exactly one reading: saved, legacy (needs confirmation) or unset (Manual)", () => {
  for (const mode of ["manual", "assisted", "autopilot"]) {
    assert.deepEqual(automation.automationModeState(mode), { kind: "saved", mode });
    assert.equal(automation.automationModeConfirmed(mode), true);
  }
  for (const [label, mode] of Object.entries(LEGACY)) {
    const state = automation.automationModeState(label);
    assert.equal(state.kind, "legacy", label);
    assert.equal(state.mode, mode, label);
    assert.equal(automation.automationModeConfirmed(label), false, `${label} still needs confirmation`);
    // Spacing/case variations of a stored answer read the same way.
    assert.equal(automation.automationModeState(`  ${label.toUpperCase()} `).mode, mode);
  }
  for (const raw of [null, undefined, "", "  ", "nonsense", "Autopilot", "AUTOPILOT", "auto"]) {
    assert.deepEqual(automation.automationModeState(raw), { kind: "unset", mode: "manual" }, JSON.stringify(raw));
    assert.equal(automation.normalizeAutomationMode(raw), "manual");
  }
});

test("Autopilot is never inferred: only the exact stored value 'autopilot' runs as Autopilot", () => {
  const candidates = [...Object.keys(LEGACY), null, undefined, "", "Autopilot", "auto pilot", "MARA runs it end-to-end"];
  for (const raw of candidates) assert.notEqual(automation.normalizeAutomationMode(raw), "autopilot", JSON.stringify(raw));
  assert.equal(automation.normalizeAutomationMode("autopilot"), "autopilot");
});

test("scheduled planning is enabled only for a confirmed Assisted or Autopilot value", () => {
  assert.equal(automation.scheduledPlanningEnabled("assisted"), true);
  assert.equal(automation.scheduledPlanningEnabled("autopilot"), true);
  for (const raw of ["manual", ...Object.keys(LEGACY), null, "", "nonsense"]) {
    assert.equal(automation.scheduledPlanningEnabled(raw), false, JSON.stringify(raw));
  }
});

test("onboarding saves a canonical mode for every answer it offers — Manual or Assisted, never Autopilot", () => {
  const offered = onboarding.Q_AUTO.map(([, label]) => label);
  assert.deepEqual(offered, Object.keys(LEGACY), "the four onboarding answers");
  for (const label of offered) {
    const saved = automation.onboardingAutomationMode(label);
    assert.equal(saved, LEGACY[label], label);
    assert.equal(automation.automationModeState(saved).kind, "saved", `${label} is saved canonically`);
  }
  assert.equal(automation.onboardingAutomationMode("manual"), "manual");
  assert.equal(automation.onboardingAutomationMode("assisted"), "assisted");
  assert.equal(automation.onboardingAutomationMode("autopilot"), "assisted", "a client cannot reach Autopilot through onboarding");
  for (const raw of ["", null, undefined, "nonsense"]) assert.equal(automation.onboardingAutomationMode(raw), null);
  // The hints describe exactly what the saved mode does.
  const hints = Object.fromEntries(onboarding.Q_AUTO.map(([, label, hint]) => [label, hint]));
  assert.match(hints["I decide everything"], /^Manual/);
  assert.match(hints["MARA drafts, I approve"], /^Assisted/);
  assert.match(hints["MARA drafts and schedules"], /Starts in Assisted/);
  assert.match(hints["MARA runs it end-to-end"], /Starts in Assisted — turn on Autopilot in Automations/);
  for (const hint of Object.values(hints)) assert.doesNotMatch(hint, /publishes|rules I set/, "no hint promises automatic publishing");
});

test("save paths: onboarding writes the canonical value; Settings never writes the mode", async () => {
  const source = await read("lib/voom/mutations.ts");
  const onboardingFn = source.slice(source.indexOf("export async function saveOnboarding"), source.indexOf("export async function saveBrandSettings"));
  const settingsFn = source.slice(source.indexOf("export async function saveBrandSettings"), source.indexOf("export async function saveMediaSpendSettings"));
  assert.match(onboardingFn, /const requestedMode = onboardingAutomationMode\(input\.automationLevel\);/);
  assert.match(onboardingFn, /canUseAutomationMode\(normalizePlan\(/, "onboarding saves only a mode the plan includes");
  assert.match(onboardingFn, /requestedMode && !planError/, "an unreadable plan saves no mode");
  assert.match(onboardingFn, /\.\.\.\(onboardingMode \? \{ automation_level: onboardingMode \} : \{\}\)/);
  assert.doesNotMatch(onboardingFn, /automation_level: input\.automationLevel/, "the raw answer is never stored");
  assert.doesNotMatch(settingsFn, /automation_level/, "Settings cannot overwrite or escalate the mode");
  // The only writer of a chosen mode checks the plan entitlement first.
  const route = await read("app/api/automation-mode/route.ts");
  assert.match(route, /z\.enum\(\["manual", "assisted", "autopilot"\]\)/);
  assert.ok(route.indexOf("canUseAutomationMode(plan, parsed.data.mode)") < route.indexOf('update({ automation_level: parsed.data.mode })'));
});

test("display is consistent: sidebar, Settings and the confirmation copy read the same state", () => {
  assert.equal(automation.automationModeStatusLine("assisted"), "Assisted — MARA drafts, you approve.");
  assert.equal(automation.automationModeStatusLine("MARA drafts, I approve"), "Assisted — confirm it in Automations to start scheduled planning.");
  assert.equal(automation.automationModeStatusLine("I decide everything"), "Manual — confirm it in Automations to start scheduled planning.");
  assert.equal(automation.automationModeStatusLine(null), "Automation mode not set.");
  assert.equal(automation.automationModeDisplayLabel("autopilot"), "Autopilot");
  assert.equal(automation.automationModeDisplayLabel("MARA runs it end-to-end"), "Assisted · not confirmed");
  assert.equal(automation.automationModeDisplayLabel(""), "Not set yet");
});

test("the confirmation control saves the shown mode through the plan-checked endpoint", async () => {
  const control = await read("components/voom/operating/AutomationMode.tsx");
  assert.match(control, /if \(\(next === mode && confirmed\) \|\| busy\) return;/, "an unconfirmed mode can be re-saved to confirm it");
  assert.match(control, /onClick=\{\(\) => void choose\(mode\)\}/, "Confirm saves the shown mode");
  assert.match(control, /disabled=\{busy \|\| !isModeAllowed\(mode\)\}/, "a mode the plan excludes cannot be confirmed");
  assert.match(control, /"\/api\/automation-mode"/);
  const page = await read("app/app/(shell)/automations/page.tsx");
  assert.match(page, /confirmed=\{automationModeConfirmed\(data\.business\.automation_level\)\}/);
  assert.match(page, /automationModeStatusLine\(data\.business\.automation_level\)/);
});

function businessesAdmin(rows) {
  return {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push((row) => row[column] === value); return query; },
        is(column, value) { filters.push((row) => (row[column] ?? null) === value); return query; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
        maybeSingle: async () => ({ data: null, error: { message: "not used" } }),
        then(resolve, reject) {
          if (table !== "businesses") return Promise.reject(new Error(`unexpected table ${table}`)).then(resolve, reject);
          return Promise.resolve({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("coordinator eligibility: unconfirmed answers and unset values are skipped until the owner confirms", async () => {
  const rows = [
    { id: "b1", owner_user_id: "o1", automation_level: "assisted", automation_paused_at: null, onboarding_completed: true },
    { id: "b2", owner_user_id: "o2", automation_level: "autopilot", automation_paused_at: null, onboarding_completed: true },
    { id: "b3", owner_user_id: "o3", automation_level: "manual", automation_paused_at: null, onboarding_completed: true },
    { id: "b4", owner_user_id: "o4", automation_level: "MARA drafts, I approve", automation_paused_at: null, onboarding_completed: true },
    { id: "b5", owner_user_id: "o5", automation_level: "MARA runs it end-to-end", automation_paused_at: null, onboarding_completed: true },
    { id: "b6", owner_user_id: "o6", automation_level: null, automation_paused_at: null, onboarding_completed: true },
    { id: "b7", owner_user_id: "o7", automation_level: "assisted", automation_paused_at: "2026-10-31T00:00:00Z", onboarding_completed: true },
  ];
  const before = await coordinator.runFleetCoordinator(businessesAdmin(rows), new Date("2026-10-31T03:00:00Z"));
  assert.equal(before.evaluated, 2, "only the confirmed Assisted and Autopilot accounts are planned");
  // Each eligible row agrees with the shared helper.
  assert.deepEqual(rows.filter((row) => !row.automation_paused_at && automation.scheduledPlanningEnabled(row.automation_level)).map((row) => row.id), ["b1", "b2"]);

  // The owner of b4 confirms Assisted (the endpoint stores the canonical value).
  rows[3].automation_level = "assisted";
  const after = await coordinator.runFleetCoordinator(businessesAdmin(rows), new Date("2026-10-31T03:00:00Z"));
  assert.equal(after.evaluated, 3, "a confirmed answer joins scheduled planning; the others still do not");
});

function safetyAdmin(business) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: business, error: null }) }) }) }) };
}

test("authorization boundaries: a legacy or unset value can never pass an Autopilot or Assisted gate it did not choose", async () => {
  const max = (level) => safetyAdmin({ automation_level: level, automation_paused_at: null, plan: "max" });
  await assert.rejects(safety.assertAutonomousWorkAllowed(max("MARA runs it end-to-end"), "o", "autopilot"), /automation_mode_unconfirmed/);
  await assert.rejects(safety.assertAutonomousWorkAllowed(max(null), "o", "assisted"), /automation_mode_unconfirmed/);
  await assert.rejects(safety.assertAutonomousWorkAllowed(max("I decide everything"), "o", "assisted"), /automation_mode_unconfirmed/);
  // P2 (PR #103 review): an unconfirmed answer never passes the final check,
  // even when it describes exactly the requested mode.
  for (const label of Object.keys(LEGACY)) {
    for (const required of ["manual", "assisted", "autopilot"]) {
      await assert.rejects(safety.assertAutonomousWorkAllowed(max(label), "o", required), /automation_mode_unconfirmed/, `${label} as ${required}`);
    }
  }
  for (const raw of [null, "", "nonsense"]) {
    await assert.rejects(safety.assertAutonomousWorkAllowed(max(raw), "o", "manual"), /automation_mode_unconfirmed/);
  }
  await safety.assertAutonomousWorkAllowed(max("autopilot"), "o", "autopilot");
  await safety.assertAutonomousWorkAllowed(max("assisted"), "o", "assisted");
  // Entitlement and pause still apply to confirmed values.
  await assert.rejects(safety.assertAutonomousWorkAllowed(safetyAdmin({ automation_level: "autopilot", automation_paused_at: null, plan: "pro" }), "o", "autopilot"), /automation_subscription_restricted/);
  await assert.rejects(safety.assertAutonomousWorkAllowed(safetyAdmin({ automation_level: "assisted", automation_paused_at: "2026-10-31T00:00:00Z", plan: "pro" }), "o", "assisted"), /automation_paused/);
});

test("the Marketing Plan read model and MARA's context use the same reading, never the raw answer", async () => {
  const readModel = await read("lib/voom/workflow/read.ts");
  assert.match(readModel, /const mode = effectiveAutomationMode\(business\?\.automation_level, planId\);/, "the plan shows the mode it can actually run with");
  assert.doesNotMatch(readModel, /: "assisted";/, "no private copy of the old unknown-means-Assisted rule");
  const { buildMaraSystemPrompt } = await import("../lib/mara/prompt.ts");
  const business = {
    brand_name: "Demo", brand_description: "", industry: "", target_customer: [], main_goal: "", brand_personality: [],
    preferred_channels: [], content_frequency: "", monthly_ad_budget: "", publishing_permission: "", automation_level: "MARA runs it end-to-end",
  };
  const prompt = buildMaraSystemPrompt(null, business);
  assert.doesNotMatch(prompt, /MARA runs it end-to-end/, "MARA is never told an unconfirmed answer as if it were its mode");
  assert.match(prompt, /Assisted · not confirmed/);
});

test("confirming through PATCH /api/automation-mode is owner-scoped, plan-checked and changes nothing else", async () => {
  const route = await read("app/api/automation-mode/route.ts");
  assert.match(route, /const user = await getCurrentUser\(\);\s*if \(!user\) return Response\.json\(\{ error: "Please log in again\." \}, \{ status: 401 \}\);/, "signed-in owner only");
  assert.match(route, /\.eq\("owner_user_id", user\.id\)\.maybeSingle\(\)/, "reads only the caller's own business");
  assert.match(route, /\.update\(\{ automation_level: parsed\.data\.mode \}\)\.eq\("owner_user_id", user\.id\)/, "writes only the caller's own business");
  assert.match(route, /if \(!canUseAutomationMode\(plan, parsed\.data\.mode\)\) \{\s*return Response\.json\(\{ error: "Your current plan doesn't include that automation mode\." \}, \{ status: 403 \}\);/);
  assert.match(route, /createClient\(\) from|from "@\/utils\/supabase\/server"/, "uses the caller's session, so RLS and migration 0071 also apply");
  // A mode change never lifts a pause, never enables automatic paid media and never grants publish consent.
  assert.doesNotMatch(route, /automation_paused_at|allow_automatic_paid_media|publishing_permission/);
});

test("this branch never auto-deploys a Production-connected Preview", async () => {
  const config = JSON.parse(await read("vercel.json"));
  assert.equal(config.git.deploymentEnabled["fix/automation-mode-normalization"], false);
});


test("Free/Pro/Max: the mode automation may run with is confirmed AND plan-capped; forged values never act above the plan", () => {
  const expected = {
    free: { manual: "manual", assisted: "manual", autopilot: "manual" },
    pro: { manual: "manual", assisted: "assisted", autopilot: "assisted" },
    max: { manual: "manual", assisted: "assisted", autopilot: "autopilot" },
  };
  for (const [plan, byMode] of Object.entries(expected)) {
    for (const [stored, effective] of Object.entries(byMode)) {
      assert.equal(safety.effectiveAutomationMode(stored, plan), effective, `${plan}/${stored}`);
    }
    for (const raw of [...Object.keys(LEGACY), null, "", "Autopilot", "auto"]) {
      assert.equal(safety.effectiveAutomationMode(raw, plan), "manual", `${plan}: ${JSON.stringify(raw)} acts as Manual until confirmed`);
    }
  }
  assert.equal(safety.effectiveAutomationMode("autopilot", null), "manual", "an unknown plan is Free");
  for (const raw of [...Object.keys(LEGACY), null, "nonsense"]) assert.equal(automation.confirmedAutomationMode(raw), "manual");
});

test("every MARA automation entry point decides from the confirmed/effective mode, not the raw stored value", async () => {
  const [state, coordinatorService, workflow, readModel, campaigns, flows] = await Promise.all([
    read("lib/coordinator/state.ts"), read("lib/coordinator/service.ts"), read("lib/voom/workflow/service.ts"),
    read("lib/voom/workflow/read.ts"), read("lib/campaign/server.ts"), read("lib/email-flows/create.ts"),
  ]);
  assert.match(state, /const mode = effectiveAutomationMode\(/);
  assert.match(workflow, /const mode = effectiveAutomationMode\(business\.automation_level, planId\);/);
  assert.match(readModel, /const mode = effectiveAutomationMode\(business\?\.automation_level, planId\);/);
  assert.equal((campaigns.match(/confirmedAutomationMode\(input\.mode/g) ?? []).length, 3);
  assert.equal((flows.match(/confirmedAutomationMode\(input\.mode/g) ?? []).length, 2);
  for (const source of [state, workflow, readModel, campaigns, flows]) assert.doesNotMatch(source, /normalizeAutomationMode\(/, "display normalizer is not used to decide automation");
  // The coordinator re-checks pause, confirmation and entitlement immediately before acting.
  assert.match(coordinatorService, /await assertAutonomousWorkAllowed\(admin as AdminClient, ownerId, state\.mode\);/);
  assert.match(coordinatorService, /!authorizationBlock &&\s*evaluation\.gaps\.length > 0/);
  assert.match(coordinatorService, /!authorizationBlock &&\s*evaluation\.state\.emailState\.flowOpportunities\.length > 0/);
});
