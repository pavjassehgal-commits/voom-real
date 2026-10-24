/**
 * VOOM motion system: haptics guard rails, page transitions and reduced motion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { documentFrom, measureRenderedPages, RenderedSurfaceUnavailable, withClientBundle } from "./helpers/rendered-surface.mjs";
import { buildClientBundle } from "./helpers/client-bundle.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* ── Haptics: real module, fake browser ─────────────────────────────── */

function fakeBrowser({ vibrate = true, active = true, activation = true, stored = {}, reduced = false } = {}) {
  const calls = [];
  const storage = new Map(Object.entries(stored));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
      matchMedia: (q) => ({ matches: reduced && q.includes("reduce") }),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { ...(vibrate ? { vibrate: (p) => { calls.push(p); return true; } } : {}), ...(activation ? { userActivation: { isActive: active } } : {}) },
  });
  return calls;
}

const haptics = await import("../lib/voom/haptics.ts");

test("haptics fire the documented patterns only for a real, permitted user gesture", () => {
  let calls = fakeBrowser();
  haptics.haptic("light"); haptics.haptic("success"); haptics.haptic("warning"); haptics.haptic("error");
  assert.deepEqual(calls, [10, 20, [12, 60, 12], [16, 60, 16]]);

  calls = fakeBrowser({ active: false });
  haptics.haptic("success");
  assert.deepEqual(calls, [], "no user gesture (page load, passive notification, background event): never vibrates");

  calls = fakeBrowser({ activation: false });
  haptics.haptic("success");
  assert.deepEqual(calls, [], "missing activation metadata fails closed");

  calls = fakeBrowser();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { vibrate: (p) => { calls.push(p); return true; }, userActivation: {} } });
  haptics.haptic("success");
  assert.deepEqual(calls, [], "activation without a positive isActive fails closed");

  calls = fakeBrowser({ stored: { [haptics.HAPTICS_STORAGE_KEY]: "off" } });
  haptics.haptic("light");
  assert.deepEqual(calls, [], "the owner's Off setting wins");

  calls = fakeBrowser({ reduced: true });
  haptics.haptic("light");
  assert.deepEqual(calls, [], "system reduced motion disables haptics");

  calls = fakeBrowser({ stored: { [haptics.MOTION_STORAGE_KEY]: "reduce" } });
  haptics.haptic("light");
  assert.deepEqual(calls, [], "in-app reduced motion disables haptics");
});

test("haptics are a silent no-op where vibration is unsupported (e.g. iOS Safari)", () => {
  fakeBrowser({ vibrate: false });
  assert.equal(haptics.hapticsSupported(), false);
  assert.doesNotThrow(() => haptics.haptic("error"));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { vibrate: () => { throw new Error("blocked"); }, userActivation: { isActive: true } } });
  assert.doesNotThrow(() => haptics.haptic("light"), "a throwing implementation is swallowed");
});

test("haptics are only wired to direct interactions, never to toasts or background work", async () => {
  const [store, toastHost, runtime] = await Promise.all([read("lib/voom/store.tsx"), read("components/voom/ui/ToastHost.tsx"), read("components/voom/motion/MotionRuntime.tsx")]);
  assert.doesNotMatch(store + toastHost, /haptic\(/, "notifications never vibrate");
  assert.match(runtime, /addEventListener\("click"/, "the delegated light tap responds to clicks only");
});

/* ── Page transitions and reduced motion, in Chromium ───────────────── */

const bundle = buildClientBundle(`
  import { createRoot } from "react-dom/client";
  import { createElement as h } from "react";
  import { PageTransition } from "./components/voom/motion/PageTransition.tsx";
  const root = createRoot(document.getElementById("root"));
  const page = (label) => h(PageTransition, null, h("div", null, h("h1", null, label), h("p", null, "Body")));
  root.render(page("First page"));
  window.__navigate = (path, label) => { history.pushState(null, "", path); root.render(page(label)); };
`);

test("page content animates only after an in-app navigation; the first page is never hidden", async (t) => {
  const html = withClientBundle(await documentFrom('<div class="voom-shell"><div id="root"></div></div>'), bundle);
  let results;
  try {
    results = await measureRenderedPages([{
      name: "transition", width: 1280, height: 800, html,
      evaluate: `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(100);
        const wrapper = () => document.querySelector("#root > div");
        // Only animations inside the page content (the bare test page also has the legacy body backdrop).
        const mine = () => document.getAnimations().filter((a) => document.getElementById("root").contains(a.effect.target));
        const first = { cls: wrapper().className, opacity: getComputedStyle(wrapper()).opacity, anims: mine().length };
        window.__navigate("/app/calendar", "Second page");
        await wait(30);
        const second = { cls: wrapper().className, text: wrapper().innerText, anims: mine().map((a) => a.effect.getTiming().duration) };
        document.documentElement.setAttribute("data-motion", "reduce");
        window.__navigate("/app/settings", "Third page");
        await wait(30);
        const reduced = mine().map((a) => a.effect.getComputedTiming().duration);
        return { first, second, reduced };
      })()`,
    }]);
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return t.skip("no Chromium available");
    throw error;
  }
  const [r] = results;
  assert.equal(r.evaluateError, null, r.evaluateError ?? "");
  const { first, second, reduced } = r.evaluate;
  assert.doesNotMatch(first.cls, /voom-page-enter/, "the first (server-rendered) page has no entrance class");
  assert.equal(first.opacity, "1");
  assert.equal(first.anims, 0);
  assert.match(second.cls, /voom-page-enter/, "a client navigation plays the entrance");
  assert.match(second.text, /Second page/);
  assert.ok(second.anims.length > 0 && second.anims.every((d) => d <= 350), `entrance durations stay ≤350ms: ${second.anims}`);
  assert.ok(reduced.every((d) => d <= 1), `in-app reduced motion collapses animations: ${reduced}`);
});

test("motion CSS animates only compositor-friendly properties and honours prefers-reduced-motion", async () => {
  const css = await read("app/globals.css");
  const block = css.slice(css.indexOf("VOOM MOTION SYSTEM"));
  const keyframes = [...block.matchAll(/@keyframes voom-m-[\w-]+ \{([\s\S]*?)\}\s*\n/g)].map((m) => m[1]).join(" ");
  assert.doesNotMatch(keyframes, /\b(width|height|top|left|right|bottom|margin|padding)\s*:/, "no layout-triggering keyframes");
  assert.match(block, /--motion-press: 140ms;/);
  assert.match(block, /--motion-control: 200ms;/);
  assert.match(block, /--motion-enter: 300ms;/);
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(block, /html\[data-motion="reduce"\]/);
  assert.match(block, /html\[data-interacted\] :is\(\.voom-shell, \.voom-public\) :is\(button\[aria-pressed="true"\]/, "selection pops never replay on page load");
});

/* ── Codex's case: synthetic clicks must never vibrate; genuine ones may ── */

const hapticBundle = buildClientBundle(`
  import { createRoot } from "react-dom/client";
  import { createElement as h } from "react";
  import { MotionRuntime } from "./components/voom/motion/MotionRuntime.tsx";
  import { haptic } from "./lib/voom/haptics.ts";
  window.__clicks = 0;
  window.__haptic = haptic;
  createRoot(document.getElementById("root")).render(h("div", null,
    h(MotionRuntime),
    h("button", { id: "tap", type: "button", "data-haptic": "light", style: { width: 200, height: 60 }, onClick: () => { window.__clicks += 1; } }, "Tap"),
  ));
`);

// Record vibration requests; optionally simulate a browser without the API.
const spy = (supported = true) => supported
  ? `window.__vib = []; Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p) => { window.__vib.push(p); return true; } });`
  : `window.__vib = []; Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined });`;

async function hapticRun(t, scenarios) {
  const html = withClientBundle(await documentFrom('<div class="voom-shell"><div id="root"></div></div>'), hapticBundle);
  try {
    const results = await measureRenderedPages(scenarios.map((sc) => ({ width: 800, height: 600, html, ...sc })));
    for (const r of results) assert.equal(r.evaluateError, null, `${r.name}: ${r.evaluateError}`);
    return Object.fromEntries(results.map((r) => [r.name, r.evaluate]));
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) { t.skip("no Chromium available"); return null; }
    throw error;
  }
}

const read$ = `({ vib: window.__vib, clicks: window.__clicks })`;

test("synthetic and timer-generated clicks never vibrate; a genuine click does", async (t) => {
  const r = await hapticRun(t, [
    { name: "synthetic", onDocumentStart: spy(), evaluate: `(async () => {
        await new Promise((r) => setTimeout(r, 200));
        const b = document.getElementById("tap");
        b.click();
        b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(() => { b.click(); r(); }, 50));
        window.__haptic("success");
        return ${read$};
      })()` },
    { name: "genuine", onDocumentStart: spy(), trustedClicks: ["#tap"], evaluate: read$ },
    // Codex's case: a timer-generated click while a real gesture is still active.
    { name: "timerAfterGenuine", onDocumentStart: spy(), trustedClicks: ["#tap"], evaluate: `(async () => {
        const active = navigator.userActivation.isActive;
        await new Promise((r) => setTimeout(() => { document.getElementById("tap").click(); r(); }, 30));
        return { active, ...${read$} };
      })()` },
  ]);
  if (!r) return;
  assert.deepEqual(r.synthetic.vib, [], "Codex's case: untrusted clicks and calls without activation never vibrate");
  assert.equal(r.synthetic.clicks, 3, "the button itself still works for scripted clicks");
  assert.deepEqual(r.genuine.vib, [10], "a real click gives one light tap");
  assert.equal(r.genuine.clicks, 1);
  assert.equal(r.timerAfterGenuine.active, true, "the real gesture's activation is still active");
  assert.equal(r.timerAfterGenuine.clicks, 2);
  assert.deepEqual(r.timerAfterGenuine.vib, [10], "only the genuine click vibrates; the timer-generated click does not");
});

test("preferences, reduced motion, unsupported browsers and late results all stay silent", async (t) => {
  const r = await hapticRun(t, [
    { name: "off", onDocumentStart: spy(), beforeLoad: `localStorage.setItem("voom-haptics", "off")`, trustedClicks: ["#tap"], evaluate: read$ },
    { name: "reduced", onDocumentStart: spy(), beforeLoad: `localStorage.setItem("voom-motion", "reduce")`, trustedClicks: ["#tap"], evaluate: read$ },
    { name: "unsupported", onDocumentStart: spy(false), trustedClicks: ["#tap"], evaluate: read$ },
    // A save that resolves after the click's transient activation has expired (~5s in Chromium).
    { name: "late", onDocumentStart: spy(), trustedClicks: ["#tap"], evaluate: `(async () => {
        const during = navigator.userActivation.isActive;
        await new Promise((r) => setTimeout(r, 5600));
        window.__haptic("success");
        return { during, after: navigator.userActivation.isActive, ...${read$} };
      })()` },
  ]);
  if (!r) return;
  assert.deepEqual(r.off.vib, [], "the owner's Off setting wins");
  assert.equal(r.off.clicks, 1);
  assert.deepEqual(r.reduced.vib, [], "reduced motion disables haptics");
  assert.deepEqual(r.unsupported.vib, [], "no API: silent");
  assert.equal(r.unsupported.clicks, 1, "the control works without haptics");
  assert.equal(r.late.during, true);
  assert.equal(r.late.after, false, "activation has expired");
  assert.deepEqual(r.late.vib, [10], "only the click's own light tap — the late success result cannot vibrate");
});
