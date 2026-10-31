/**
 * Setup completion (browser-rendered).
 *
 * Merged 2026-11-01 (handover/merge-plan.md): the Brand Kit v2 wizard kept its own
 * flow, so this file now states what that wizard does today. A new owner sees the
 * first screen, and the wizard stays mounted when the save's revalidated render of
 * /app/onboarding hands it a changed server flag (it ignores `completedOnServer`:
 * Finish shows its own "setting things up" screen and then moves to Today itself).
 * An account that already finished setup is sent to /app by the PAGE, on the
 * server. main's wizard did that bypass client-side so its "Your workspace is
 * ready" summary could show; adopting that summary is Phase C, when the original
 * assertion (an onboarded owner's wizard renders nothing) returns.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { documentFrom, measureRenderedPages, RenderedSurfaceUnavailable, withClientBundle } from "./helpers/rendered-surface.mjs";
import { buildClientBundle } from "./helpers/client-bundle.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const bundle = buildClientBundle(`
  import { createRoot } from "react-dom/client";
  import { createElement as h } from "react";
  import { Providers } from "./app/app/Providers.tsx";
  import { OnboardingWizard } from "./components/voom/onboarding/OnboardingWizard.tsx";
  import { businessRecord } from "./tests/helpers/shell-surface.tsx";

  const business = businessRecord({ onboarding_completed: false });
  const tree = (completedOnServer) => h(Providers, { initialDisplayName: "Sam", initialEmail: "sam@example.com", initialBusiness: business },
    h(OnboardingWizard, { completedOnServer }));
  // A new owner mid-setup; then the save's revalidated render flips the flag.
  window.__newOwner = createRoot(document.getElementById("new-owner"));
  window.__newOwner.render(tree(false));
  window.__flip = () => window.__newOwner.render(tree(true));
`);

const html = withClientBundle(await documentFrom('<div id="new-owner"></div>'), bundle);

test("the completion flow is not torn down by the save's revalidated render", async (t) => {
  let results;
  try {
    results = await measureRenderedPages([{
      name: "onboarding-completion",
      width: 1280,
      height: 800,
      html,
      evaluate: `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await wait(300);
        const before = document.getElementById("new-owner").innerText;
        window.__flip();
        await wait(300);
        return { before, after: document.getElementById("new-owner").innerText };
      })()`,
    }]);
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return t.skip("no Chromium available");
    throw error;
  }
  const [result] = results;
  assert.equal(result.evaluateError, null, result.evaluateError ?? "");
  const { before, after } = result.evaluate;
  assert.match(before, /What should MARA call you\?/, "a new owner sees setup");
  assert.match(after, /What should MARA call you\?/, "the revalidated render (onboarding_completed now true) keeps the wizard mounted");
});

test("an onboarded owner opening setup directly is sent to the app by the server page", async () => {
  const page = await read("app/app/onboarding/page.tsx");
  assert.match(page, /if \(business\?\.onboarding_completed\) \{\s*redirect\("\/app"\);/, "the page, not the wizard, bypasses setup today");
  assert.match(page, /export const maxDuration = 60/, "the website read's server action keeps its longer limit");
});
