/**
 * Automations page: mode presentation + paid-media cost clarity.
 *
 * The production bug this suite locks down: SynraPay had `automation_level =
 * "manual"` stored, the segmented control correctly highlighted Manual, but the
 * Assisted descriptive card was hard-coded `active` and labelled "Default" — so
 * the page told the user Assisted was running when Manual was saved.
 *
 * What is proven here, and how:
 *
 *   1. BEHAVIOURALLY — the real presentation module (lib/voom/automation.ts) is
 *      executed for every saved mode: exactly one descriptive card is active and
 *      it is always the card matching the saved mode, including the raw DB value
 *      "manual" that regressed. "Recommended" is asserted to be independent of
 *      the active state, so it can never read as "current".
 *   2. BEHAVIOURALLY — the copy's paid-MARA-media claims are checked against the
 *      REAL rolling-plan engine (lib/voom/workflow/rolling-plan.ts) driven
 *      through in-memory counting ports, so "Manual generates nothing on a
 *      schedule" / "Assisted can generate paid media automatically" /
 *      "Autopilot auto-approves safe work" are facts about the shipped engine,
 *      not wording. No provider call, no paid generation, no Supabase, no
 *      publishing anywhere in this file.
 *   3. The React files are asserted on source, following the existing suites:
 *      bare Node cannot render .tsx. Those assertions cover exactly the wiring
 *      that matters — the cards are driven by the same saved-mode state as the
 *      segmented control, and no mode is hard-coded as active anywhere.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const automation = await import("../lib/voom/automation.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const MODES = ["manual", "assisted", "autopilot"];
const CARDS = (mode) => automation.automationModeCards(mode);
const activeCards = (mode) => CARDS(mode).filter((card) => card.active);
const activeValue = (mode) => automation.activeAutomationModeCard(mode).value;

// ---------------------------------------------------------------------------
// 1. The active descriptive card follows the SAVED mode
// ---------------------------------------------------------------------------

test("1. exactly one descriptive card is active and it is the saved mode's card", () => {
  for (const mode of MODES) {
    const cards = CARDS(mode);
    assert.equal(cards.length, 3, "all three modes are described");
    assert.deepEqual(cards.map((card) => card.value), MODES, "display order is Manual, Assisted, Autopilot");
    assert.equal(activeCards(mode).length, 1, `${mode}: exactly one card is visually active`);
    assert.equal(activeValue(mode), mode, `${mode}: the active card is the ${mode} card`);
    for (const card of cards) {
      assert.equal(card.active, card.value === mode, `${mode}: ${card.value} card active flag follows the saved mode`);
    }
  }
});

test("1b. the SynraPay regression: a stored 'manual' highlights Manual, never Assisted", () => {
  // The raw DB value goes through the same normalizer the page uses.
  const saved = automation.normalizeAutomationMode("manual");
  assert.equal(saved, "manual");
  const cards = CARDS(saved);
  const manual = cards.find((card) => card.value === "manual");
  const assisted = cards.find((card) => card.value === "assisted");
  assert.equal(manual.active, true, "the Manual card is the active one");
  assert.equal(manual.label, "Manual");
  assert.equal(assisted.active, false, "Assisted must not look active while Manual is saved");
  assert.equal(activeValue(saved), "manual");
  // And the same holds for every raw value the businesses row can carry.
  for (const raw of ["autopilot", "assisted", "manual"]) {
    assert.equal(activeValue(automation.normalizeAutomationMode(raw)), raw);
  }
});

test("1c. an unset or legacy automation_level falls back to Assisted and nothing else", () => {
  // Onboarding stores free-text answers, so the normalizer's fallback is real.
  for (const raw of [null, undefined, "", "MARA drafts, I approve", "nonsense"]) {
    const saved = automation.normalizeAutomationMode(raw);
    assert.equal(saved, automation.RECOMMENDED_AUTOMATION_MODE);
    assert.equal(activeCards(saved).length, 1);
    assert.equal(activeValue(saved), "assisted");
  }
});

test("1d. no mode is hard-wired active: each mode's card is active for that mode only", () => {
  for (const mode of MODES) {
    const activeFor = MODES.filter((candidate) => CARDS(candidate).find((card) => card.value === mode).active);
    assert.deepEqual(activeFor, [mode], `${mode} is active only when ${mode} is saved`);
  }
});

test("1e. 'Recommended' describes the default choice, never the current state", () => {
  for (const mode of MODES) {
    const recommended = CARDS(mode).filter((card) => card.recommended);
    assert.equal(recommended.length, 1, "one recommended mode");
    assert.equal(recommended[0].value, "assisted");
    assert.equal(recommended[0].active, mode === "assisted", "recommended is independent of the saved mode");
  }
  // With Manual or Autopilot saved, the recommended card is visibly NOT active,
  // so "Recommended" cannot be read as "this is what is running".
  for (const mode of ["manual", "autopilot"]) {
    const assisted = CARDS(mode).find((card) => card.value === "assisted");
    assert.equal(assisted.recommended, true);
    assert.equal(assisted.active, false);
  }
});

// ---------------------------------------------------------------------------
// 2. Each mode explains what it does about paid MARA media generation
// ---------------------------------------------------------------------------

test("2. every mode states plainly whether paid MARA media generation is automatic", () => {
  const copy = automation.AUTOMATION_MODE_COPY;
  for (const mode of MODES) {
    assert.match(copy[mode].label, new RegExp(mode, "i"));
    assert.ok(copy[mode].summary.trim().length > 20, `${mode}: summary explains the mode`);
    assert.match(copy[mode].media, /paid MARA media generation/i, `${mode}: the paid-media statement names the thing`);
  }

  // Manual: no scheduled workflow generation; the user explicitly requests it.
  assert.match(copy.manual.summary, /nothing runs on a schedule/i);
  assert.match(copy.manual.summary, /only when you ask/i);
  assert.match(copy.manual.media, /no scheduled generation/i);
  assert.match(copy.manual.media, /only from an explicit request/i);
  assert.doesNotMatch(copy.manual.media, /automatically/i, "Manual never claims automatic generation");

  // Assisted: plans/drafts are prepared, and paid media generation MAY be
  // automatic — stated explicitly, with the approval boundary kept truthful.
  assert.match(copy.assisted.summary, /drafts each slot/i);
  assert.match(copy.assisted.summary, /waits for your approval/i);
  assert.match(copy.assisted.media, /can happen automatically/i);
  assert.match(copy.assisted.media, /before you approve/i);
  assert.match(copy.assisted.media, /approval is still required before scheduling or publishing/i);

  // Autopilot: automatic paid generation, safe internal work approved and
  // scheduled, workflow continues, risky work stops.
  assert.match(copy.autopilot.summary, /approves and schedules safe internal work/i);
  assert.match(copy.autopilot.summary, /continues the workflow/i);
  assert.match(copy.autopilot.summary, /risky stops in Approvals/i);
  assert.match(copy.autopilot.media, /happens automatically/i);
  assert.match(copy.autopilot.media, /publishing to Instagram still requires your connected account's publishing permission/i);
});

test("2b. the Autopilot credits warning is exact and lives on the Autopilot card only", () => {
  assert.equal(
    automation.AUTOPILOT_CREDITS_WARNING,
    "Autopilot may use connected AI provider credits to generate media automatically.",
  );
  assert.equal(automation.AUTOMATION_MODE_COPY.autopilot.warning, automation.AUTOPILOT_CREDITS_WARNING);
  for (const mode of MODES) {
    const card = CARDS(mode).find((candidate) => candidate.value === "autopilot");
    assert.equal(card.warning, automation.AUTOPILOT_CREDITS_WARNING, "the warning travels with the Autopilot card");
    for (const other of CARDS(mode).filter((candidate) => candidate.value !== "autopilot")) {
      assert.equal(other.warning, undefined, `${other.value} carries no credits warning`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The copy is truthful about the REAL engine (in-memory ports, no spending)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-12T05:00:00.000Z"); // 09:00 Dubai
const TZ = "Asia/Dubai";

/** Counting ports: every stage the real service would perform is recorded. */
function createCountingPorts() {
  const calls = {
    ensurePlan: 0, generateContent: 0, createDraft: 0, ensureMedia: 0,
    requestApproval: 0, autoApproveAndSchedule: 0, savePlanItems: 0,
  };
  const drafts = new Map();
  let seq = 0;
  const ports = {
    async ensurePlan() { calls.ensurePlan += 1; return "plan-1"; },
    async listItems() { return [...drafts.values()]; },
    async generateContent(slot) {
      calls.generateContent += 1;
      return {
        concept: `Concept for ${slot.date}`, caption: "A calm look at our work today. Visit us this week.",
        cta: "Visit us this week", hashtags: ["#local"], visualBrief: "Warm natural light.",
      };
    },
    async createDraft({ slot, content }) {
      calls.createDraft += 1;
      const item = {
        draftId: `draft-${++seq}`, slotKey: slot.date, contentType: slot.contentType,
        concept: content.concept, caption: content.caption, publishAt: slot.publishAt, status: "draft",
      };
      drafts.set(item.draftId, item);
      return item;
    },
    // The paid stage: a real run would start an image/video generation here.
    async ensureMedia() { calls.ensureMedia += 1; return { ok: true }; },
    async requestApproval() { calls.requestApproval += 1; },
    async autoApproveAndSchedule() { calls.autoApproveAndSchedule += 1; return { approved: true }; },
    async savePlanItems() { calls.savePlanItems += 1; },
  };
  return { ports, calls };
}

async function runMode(mode) {
  const { ports, calls } = createCountingPorts();
  const result = await rolling.ensureRollingPlan(ports, {
    now: NOW, timeZone: TZ, cadence: "3x_week", mode, goal: "awareness",
  });
  return { calls, result };
}

test("3. Manual: a scheduled run creates nothing and reaches no paid stage", async () => {
  const { calls, result } = await runMode("manual");
  assert.equal(result.plan, null);
  assert.equal(calls.ensurePlan, 0);
  assert.equal(calls.generateContent, 0);
  assert.equal(calls.createDraft, 0);
  assert.equal(calls.ensureMedia, 0, "no paid media generation on a scheduled Manual run");
  assert.equal(calls.requestApproval, 0);
  assert.equal(calls.autoApproveAndSchedule, 0);
  // The Manual card's claims are exactly these facts.
  const copy = automation.AUTOMATION_MODE_COPY.manual;
  assert.match(copy.summary, /nothing runs on a schedule/i);
  assert.match(copy.media, /no scheduled generation/i);
});

test("3b. Assisted: paid media generation runs automatically, then stops for approval", async () => {
  const { calls, result } = await runMode("assisted");
  assert.equal(result.stage, "full");
  assert.ok(calls.createDraft > 0, "Assisted drafts the horizon");
  assert.ok(calls.ensureMedia > 0, "paid media generation happens without an approval");
  assert.equal(calls.autoApproveAndSchedule, 0, "Assisted never auto-approves");
  assert.ok(calls.requestApproval > 0, "every item stops for the owner's approval");
  assert.equal(result.autoApproved, 0);
  assert.ok(result.awaitingApproval > 0);
  const copy = automation.AUTOMATION_MODE_COPY.assisted;
  assert.match(copy.media, /can happen automatically/i);
  assert.match(copy.media, /approval is still required before scheduling or publishing/i);
});

test("3c. Autopilot: automatic paid generation plus auto-approval and scheduling", async () => {
  const { calls } = await runMode("autopilot");
  assert.ok(calls.ensureMedia > 0, "paid media generation happens automatically");
  assert.ok(calls.autoApproveAndSchedule > 0, "safe internal work is approved and scheduled");
  const copy = automation.AUTOMATION_MODE_COPY.autopilot;
  assert.match(copy.media, /happens automatically/i);
  assert.match(copy.summary, /approves and schedules safe internal work/i);
});

test("3d. the presentation module cannot change behaviour: no I/O, no scheduling", async () => {
  const source = await read("lib/voom/automation.ts");
  assert.doesNotMatch(source, /import\s+"server-only"/);
  assert.doesNotMatch(source, /\bfetch\(|createClient|createAdminClient|supabase|cron|revalidate/i,
    "mode presentation stays presentational");
  // The normalizer and the stored-value contract are unchanged.
  assert.match(source, /value === "manual" \|\| value === "autopilot" \? value : "assisted"/);
});

// ---------------------------------------------------------------------------
// 4. Wiring: the cards follow the control's saved-mode state (source, .tsx)
// ---------------------------------------------------------------------------

test("4. the control renders the cards from the saved-mode state it also highlights", async () => {
  const source = await read("components/voom/operating/AutomationMode.tsx");
  // One state value drives both the segmented control and the cards.
  assert.match(source, /const \[mode, setMode\] = useState\(initial\)/);
  assert.match(source, /variant=\{mode === value \? "primary" : "plain"\}/);
  assert.match(source, /automationModeCards\(mode\)/, "cards are derived from the saved mode, not a literal");
  assert.match(source, /aria-pressed=\{mode === value\}/);
  assert.match(source, /role="group"/);
  // The state only moves after a successful save, so the active card never
  // claims a mode that failed to persist.
  assert.match(source, /if \(response\.ok\) setMode\(next\); else setError/);
  // The active card is marked active in DOM terms as well as visually.
  assert.match(source, /data-active=\{card\.active \? "true" : "false"\}/);
  assert.match(source, /aria-current=\{card\.active \? "true" : undefined\}/);
  // The current-state badge renders only from the saved mode; "Recommended" is
  // a separate badge and the word "Default" is never rendered as a state.
  assert.match(source, /card\.active && <span/);
  assert.match(source, />Active<\/span>/);
  assert.match(source, /card\.recommended && <span/);
  assert.match(source, />Recommended<\/span>/);
  assert.doesNotMatch(source, /\bDefault\b/, "no 'Default' badge claiming to be the current state");
  assert.match(source, /card\.warning/);
  // No hard-coded mode: neither a literal active card nor a literal "assisted".
  assert.doesNotMatch(source, /"assisted"|'assisted'/, "no mode is hard-coded in the control");
  assert.doesNotMatch(source, /active\s*=\s*(true|\{true\})/, "no card is hard-coded active");
  assert.doesNotMatch(source, /·\s*Default/, "Default is never rendered as the current state");
  // The one endpoint this control talks to is the mode save: no behaviour change.
  assert.match(source, /"\/api\/automation-mode"/);
  assert.doesNotMatch(source, /\/api\/(plan|cron|publish|instagram|campaigns)/, "the control starts no workflow");
});

test("4b. the Automations page passes the saved mode and keeps the safety copy", async () => {
  const page = await read("app/app/(shell)/automations/page.tsx");
  assert.match(page, /<AutomationMode describe initial=\{normalizeAutomationMode\(data\.business\.automation_level\)\} \/>/);
  // The old hard-coded card is gone.
  assert.doesNotMatch(page, /<Mode\b/, "the static Mode card helper is removed");
  assert.doesNotMatch(page, /title="Assisted"[\s\S]*?active/, "Assisted is not pinned active");
  assert.doesNotMatch(page, /·\s*Default/, "'Default' is no longer rendered as the current state");
  assert.doesNotMatch(page, /\bactive\b\s*\/?>/, "no card is marked active in the page source");
  // Nothing mode-dependent is left in the server render, so the page cannot
  // disagree with the client's saved mode after a change.
  assert.doesNotMatch(page, /Assisted is the default/);
  assert.match(page, /Your saved mode is highlighted below/);
  assert.match(page, /No mode can publish externally, send a campaign, delete content, or spend advertising money/);
});

test("4c. Today keeps the compact control without the descriptive cards", async () => {
  const today = await read("app/app/(shell)/today/page.tsx");
  assert.match(today, /<AutomationMode compact initial=\{normalizeAutomationMode\(data\.business\.automation_level\)\} \/>/);
  assert.doesNotMatch(today, /describe/, "the header control stays compact");
});
