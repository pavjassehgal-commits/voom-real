import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const { importApp } = await import("./helpers/rendered-surface.mjs");
const data = await importApp("lib/voom/onboardingData.ts");
const iconsSource = read("components/voom/onboarding/onboardingIcons.tsx");
const map = Object.fromEntries([...iconsSource.matchAll(/^\s*(?:"([^"]+)"|(\w+)): "([\w-]+)",$/gm)].map((m) => [m[1] ?? m[2], m[3]]));

/**
 * Merged 2026-11-01 (handover/merge-plan.md, Phase C): the Brand Kit v2 wizard kept its
 * own 11 screens; the designers' icons are wired into it in Phase C. Until then this
 * file checks that the icon set covers every answer OUR wizard offers (budget and
 * publishing permission are no longer asked; the three automation modes Manual /
 * Assisted / Autopilot still need icons), and the wizard check below is a todo.
 */
test("every setup answer has one of the designers' extracted icons, and every file exists", () => {
  const labels = [
    ...data.Q_INDUSTRY.map(([, name]) => name),
    ...data.Q_CUSTOMER,
    ...data.Q_GOAL.map(([, name]) => name),
    ...data.OB_TONE,
    ...data.Q_FREQ,
  ];
  for (const label of labels) {
    assert.ok(map[label], `no icon mapped for "${label}"`);
    assert.ok(existsSync(new URL(`../public/redesign/onboarding-icons/${map[label]}.webp`, import.meta.url)), `missing file for "${label}"`);
  }
  for (const file of Object.values(map)) {
    assert.ok(existsSync(new URL(`../public/redesign/onboarding-icons/${file}.webp`, import.meta.url)), `missing file ${file}`);
  }
});

test("the setup wizard shows no emoji icons any more", { todo: "Phase C of handover/merge-plan.md: the Brand Kit v2 wizard adopts the extracted icons" }, () => {
  const wizard = read("components/voom/onboarding/OnboardingWizard.tsx");
  assert.doesNotMatch(wizard, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "emoji glyphs are replaced by the extracted icons");
  assert.match(wizard, /<OnboardingIcon label=\{name\} \/>/);
});
