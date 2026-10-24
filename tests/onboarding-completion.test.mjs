/**
 * Setup completion survives the save's own revalidation (browser-rendered).
 *
 * saveOnboarding() revalidates /app, so the save action's response re-renders
 * /app/onboarding with onboarding_completed = true. The page used to redirect
 * on that render, throwing the owner to Today before "Your workspace is ready"
 * could show. Now the page hands the flag to the wizard, which only bypasses
 * setup when the flag was already true at mount.
 *
 * This mounts the REAL wizard in Chromium, flips the flag exactly as the
 * revalidated render does, and checks the wizard stays put; then mounts a
 * fresh wizard for an onboarded account and checks it renders nothing (and
 * sends the owner on).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { documentFrom, measureRenderedPages, RenderedSurfaceUnavailable, withClientBundle } from "./helpers/rendered-surface.mjs";
import { buildClientBundle } from "./helpers/client-bundle.mjs";

const bundle = buildClientBundle(`
  import { createRoot } from "react-dom/client";
  import { createElement as h } from "react";
  import { Providers } from "./app/app/Providers.tsx";
  import { OnboardingWizard } from "./components/voom/onboarding/OnboardingWizard.tsx";
  import { businessRecord } from "./tests/helpers/shell-surface.tsx";

  const business = businessRecord({ onboarding_completed: false });
  const tree = (completedOnServer) => h(Providers, { initialDisplayName: "Sam", initialEmail: "sam@example.com", initialBusiness: business },
    h(OnboardingWizard, { completedOnServer }));
  const mount = (id, completedOnServer) => {
    const root = createRoot(document.getElementById(id));
    root.render(tree(completedOnServer));
    return root;
  };
  // A new owner mid-setup; then the save's revalidated render flips the flag.
  window.__newOwner = mount("new-owner", false);
  // An onboarded owner opening /app/onboarding directly.
  window.__onboarded = mount("onboarded", true);
  window.__flip = () => window.__newOwner.render(tree(true));
`);

const html = withClientBundle(await documentFrom('<div id="new-owner"></div><div id="onboarded"></div>'), bundle);

test("the completion flow is not torn down by the save's revalidated render; onboarded owners still bypass setup", async (t) => {
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
        return {
          before,
          after: document.getElementById("new-owner").innerText,
          onboarded: document.getElementById("onboarded").innerHTML,
        };
      })()`,
    }]);
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return t.skip("no Chromium available");
    throw error;
  }
  const [result] = results;
  assert.equal(result.evaluateError, null, result.evaluateError ?? "");
  const { before, after, onboarded } = result.evaluate;
  assert.match(before, /What should MARA call you\?/, "a new owner sees setup");
  assert.match(after, /What should MARA call you\?/, "the revalidated render (onboarding_completed now true) keeps the wizard mounted");
  assert.equal(onboarded, "", "an onboarded owner opening setup directly gets nothing to fill in — the wizard sends them on");
});
