import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const { importApp } = await import("./helpers/rendered-surface.mjs");
const data = await importApp("lib/voom/onboardingData.ts");
const iconsSource = read("components/voom/onboarding/onboardingIcons.tsx");
const map = Object.fromEntries([...iconsSource.matchAll(/^\s*(?:"([^"]+)"|(\w+)): "([\w-]+)",$/gm)].map((m) => [m[1] ?? m[2], m[3]]));

/**
 * The designers' 3D icons in the Brand Kit v2 wizard (Phase C of
 * handover/merge-plan.md, 2026-11-02). Every answer our wizard offers has one:
 * budget and publishing permission are no longer asked, and the three
 * automation modes Manual / Assisted / Autopilot reuse main's matching artwork.
 */
test("every setup answer has one of the designers' extracted icons, and every file exists", () => {
  const labels = [
    ...data.Q_INDUSTRY.map(([, name]) => name),
    ...data.Q_CUSTOMER,
    ...data.Q_GOAL.map(([, name]) => name),
    ...data.OB_TONE,
    ...data.Q_FREQ,
    ...data.AUTOMATION_CHOICES.map((choice) => choice.title),
  ];
  const wizard = read("components/voom/onboarding/OnboardingWizard.tsx");
  const inspiration = [...wizard.slice(wizard.indexOf("const INSPIRATION = ["), wizard.indexOf("];", wizard.indexOf("const INSPIRATION = ["))).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(inspiration.length, 8);
  for (const label of [...labels, ...inspiration]) {
    assert.ok(map[label], `no icon mapped for "${label}"`);
    assert.ok(existsSync(new URL(`../public/redesign/onboarding-icons/${map[label]}.webp`, import.meta.url)), `missing file for "${label}"`);
  }
  for (const file of Object.values(map)) {
    assert.ok(existsSync(new URL(`../public/redesign/onboarding-icons/${file}.webp`, import.meta.url)), `missing file ${file}`);
  }
});

test("the setup wizard shows no emoji icons any more", () => {
  const wizard = read("components/voom/onboarding/OnboardingWizard.tsx");
  assert.doesNotMatch(wizard, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "emoji glyphs are replaced by the extracted icons");
  assert.match(wizard, /<OnboardingIcon label=\{name\} \/>/);
  assert.match(wizard, /<OnboardingIcon label=\{choice\.title\} \/>/, "the automation modes use the icons too");
});
