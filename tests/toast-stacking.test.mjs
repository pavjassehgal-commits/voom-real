/**
 * Notification stacking, in Chromium against the real setup wizard.
 *
 * Codex's case: at 320×640, with Name empty, pressing Continue 12 times used to
 * stack 12 identical error toasts until they covered Skip and took its clicks.
 * Now identical messages coalesce (×N), at most three show, the rest wait, and
 * no distinct message is dropped or expires unseen.
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
  import { useVoomActions } from "./lib/voom/store.tsx";
  import { businessRecord } from "./tests/helpers/shell-surface.tsx";

  function Expose() { window.__voom = useVoomActions(); return null; }
  const business = businessRecord({ onboarding_completed: false });
  createRoot(document.getElementById("root")).render(
    h(Providers, { initialDisplayName: "", initialEmail: "sam@example.com", initialBusiness: business },
      h(Expose), h(OnboardingWizard, { completedOnServer: false })),
  );
`);

const html = withClientBundle(await documentFrom('<div id="root"></div>'), bundle);

const PROBE = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const toasts = () => [...document.querySelectorAll(".voom-toast")];
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith(label));
  const covered = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit === el || el.contains(hit));
  };
  const overlaps = (el) => {
    const r = el.getBoundingClientRect();
    return toasts().some((t) => { const q = t.getBoundingClientRect(); return !(q.right <= r.left || q.left >= r.right || q.bottom <= r.top || q.top >= r.bottom); });
  };
`;

async function run(t, width, height, evaluate) {
  try {
    const [result] = await measureRenderedPages([{ name: `stack@${width}`, width, height, html, evaluate: `(async () => { ${PROBE} ${evaluate} })()` }]);
    assert.equal(result.evaluateError, null, result.evaluateError ?? "");
    assert.equal(result.bodyScrollWidth <= result.innerWidth, true, "no horizontal overflow");
    return result.evaluate;
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) { t.skip("no Chromium available"); return null; }
    throw error;
  }
}

test("Codex's case: 12 empty-Name Continues at 320×640 give ONE error toast (×12), and Skip/Back/Continue stay usable", async (t) => {
  const r = await run(t, 320, 640, `
    await wait(200);
    for (let i = 0; i < 12; i++) { button("Continue").click(); await wait(40); }
    await wait(120);
    return {
      count: toasts().length,
      text: toasts().map((el) => el.innerText.replace(/\\s+/g, " ").trim()),
      badge: document.querySelector(".voom-toast__count")?.textContent ?? null,
      role: toasts()[0]?.getAttribute("role"),
      blocked: ["Skip", "Back", "Continue"].filter((label) => covered(button(label)) || overlaps(button(label))),
      stillOnStep1: /What should MARA call you\\?/.test(document.body.innerText),
    };
  `);
  if (!r) return;
  assert.equal(r.count, 1, `one toast, not ${r.count}: ${JSON.stringify(r.text)}`);
  assert.match(r.text[0], /Tell MARA what to call you/);
  assert.equal(r.badge, "×12", "the repeat is visible as a count");
  assert.equal(r.role, "alert", "errors stay announced");
  assert.deepEqual(r.blocked, [], "no essential button is covered or overlapped");
  assert.equal(r.stillOnStep1, true, "validation unchanged: an empty name never advances");
});

test("distinct notifications: three show, the rest wait, and none is lost", async (t) => {
  const r = await run(t, 1366, 600, `
    await wait(200);
    const messages = ["Couldn't save that.", "Brand profile saved", "Access expires in 5 days.", "Website wasn't saved.", "Credits are low."];
    const kinds = ["err", "ok", "warn", "info", "warn"];
    messages.forEach((m, i) => window.__voom.toast(m, kinds[i]));
    await wait(80);
    const first = { shown: toasts().map((el) => el.innerText.split("\\n")[0].replace(/^\\w+: /, "")), more: document.querySelector(".voom-toast-more")?.textContent ?? null };
    // Dismissing one promotes the next waiting message instead of dropping it.
    document.querySelector(".voom-toast [aria-label^=Dismiss]").click();
    await wait(80);
    const afterDismiss = { shown: toasts().map((el) => el.innerText.replace(/^\\w+: /, "").trim()), more: document.querySelector(".voom-toast-more")?.textContent ?? null };
    // Expiry only starts once visible: after the first batch expires, the last one is still shown.
    await wait(3150);
    const afterExpiry = toasts().map((el) => el.innerText.replace(/^\\w+: /, "").trim());
    await wait(3150);
    return { first, afterDismiss, afterExpiry, finally: toasts().length, blocked: ["Skip", "Back", "Continue"].filter((label) => covered(button(label))) };
  `);
  if (!r) return;
  assert.equal(r.first.shown.length, 3, JSON.stringify(r.first));
  assert.equal(r.first.more, "2 more notifications");
  assert.equal(r.afterDismiss.shown.length, 3);
  assert.equal(r.afterDismiss.more, "1 more notification");
  assert.ok(r.afterDismiss.shown.some((s) => s.includes("Website wasn't saved.")), "the 4th message was promoted");
  assert.ok(r.afterExpiry.some((s) => s.includes("Credits are low.")), "the 5th message is shown after earlier ones expire — never lost");
  assert.equal(r.finally, 0, "everything expires in the end");
  assert.deepEqual(r.blocked, []);
});
