/**
 * Sidebar automation state — truth tests (release blocker 2).
 *
 * The shipped sidebar derived its operational line from the BILLING TIER:
 * Free → "Manual — you publish.", Pro → "Assisted — MARA drafts for review.",
 * Max → "Automated — MARA is running." That is factually wrong: a Max customer
 * may be running Manual, a Free customer may have Autopilot stored from an
 * earlier plan, and a brand-new account has no mode stored at all.
 *
 * The authoritative value is the one Voom already stores and enforces —
 * `businesses.automation_level`, read through `normalizeAutomationMode` /
 * `storedAutomationMode` by the workflow engine, the coordinator, the API and
 * the mode control. These tests prove the sidebar now reports THAT value:
 *
 *   - pure-function tests for the mapping (no plan is ever consulted);
 *   - rendered tests: the real shell is server-rendered from real account
 *     state and the sidebar text is read out of a real browser, so a rename or
 *     a re-derivation cannot pass silently;
 *   - one end-to-end test drives the real mode control, confirms the sidebar
 *     follows the SERVER-confirmed mode, and shows there is no second source.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  RenderedSurfaceUnavailable,
  documentFrom,
  importApp,
  measureRenderedPages,
  react,
  readRepoFile,
  renderToStaticMarkup,
  withClientBundle,
} from "./helpers/rendered-surface.mjs";
import { buildClientBundle } from "./helpers/client-bundle.mjs";

const { createElement: h } = react;
const fixture = await importApp("tests/helpers/shell-surface.tsx");
const layout = await importApp("app/layout.tsx");
const automation = await importApp("lib/voom/automation.ts");

const render = (props) => documentFrom(renderToStaticMarkup(h(layout.default, null, h(fixture.TodaySurface, props))));

const statusPattern = /Manual — MARA acts only when you ask\.|Assisted — MARA drafts, you approve\.|Autopilot — MARA runs within your limits\.|Automation mode not set\./;

const measured = async (scenarios) => {
  try {
    return await measureRenderedPages(scenarios);
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return null;
    throw error;
  }
};

/* ──────────────────────────────────────────────────────────────
   The mapping itself — saved mode in, honest copy out
   ────────────────────────────────────────────────────────────── */

test("the sidebar status line is a pure function of the SAVED mode", () => {
  assert.equal(automation.automationModeStatusLine("manual"), "Manual — MARA acts only when you ask.");
  assert.equal(automation.automationModeStatusLine("assisted"), "Assisted — MARA drafts, you approve.");
  assert.equal(automation.automationModeStatusLine("autopilot"), "Autopilot — MARA runs within your limits.");
});

test("nothing stored means nothing claimed", () => {
  // `automation_level` is nullable: an account that has never chosen a mode is
  // told exactly that. It is never reported as Manual, Assisted or running.
  for (const value of [null, undefined, "", "unknown", "AUTO", 0]) {
    assert.equal(automation.storedAutomationMode(value), null, `${JSON.stringify(value)} is not a stored mode`);
    assert.equal(automation.automationModeStatusLine(value), "Automation mode not set.");
  }
});

test("the stored mode is read verbatim and the no-mode wording names no mode", () => {
  for (const mode of ["manual", "assisted", "autopilot"]) {
    assert.equal(automation.storedAutomationMode(mode), mode);
  }
  // Legacy/unknown values are not invented into a mode claim.
  assert.equal(automation.storedAutomationMode("automatic"), null);
  assert.doesNotMatch(automation.AUTOMATION_MODE_UNKNOWN_STATUS, /Manual|Assisted|Autopilot|running/i);
  // No operational line claims MARA is "running" outside Autopilot, and even
  // Autopilot is scoped to the account's limits.
  for (const mode of ["manual", "assisted"]) {
    assert.doesNotMatch(automation.AUTOMATION_MODE_STATUS_LINES[mode], /running/i);
  }
});

/* ──────────────────────────────────────────────────────────────
   Rendered truth matrix — tier and mode are independent
   ────────────────────────────────────────────────────────────── */

const MATRIX = [
  { name: "Max + Manual", plan: "max", mode: "manual", expected: "Manual — MARA acts only when you ask.", planLabel: "Max workspace", forbidden: /Automated|MARA is running|Assisted —|Autopilot —/ },
  { name: "Max + Assisted", plan: "max", mode: "assisted", expected: "Assisted — MARA drafts, you approve.", planLabel: "Max workspace", forbidden: /MARA is running|Autopilot —|Manual —/ },
  { name: "Max + Autopilot", plan: "max", mode: "autopilot", expected: "Autopilot — MARA runs within your limits.", planLabel: "Max workspace", forbidden: /MARA is running\.|“Manual|Manual —|Assisted —/ },
  { name: "Pro + Manual", plan: "pro", mode: "manual", expected: "Manual — MARA acts only when you ask.", planLabel: "Pro workspace", forbidden: /Automated|MARA is running|Assisted —/ },
  { name: "Pro + Assisted", plan: "pro", mode: "assisted", expected: "Assisted — MARA drafts, you approve.", planLabel: "Pro workspace", forbidden: /MARA is running|Autopilot —/ },
  { name: "Free + Manual", plan: "free", mode: "manual", expected: "Manual — MARA acts only when you ask.", planLabel: "Free workspace", forbidden: /Automated|MARA is running|Assisted —/ },
  { name: "Max + nothing stored", plan: "max", mode: null, expected: "Automation mode not set.", planLabel: "Max workspace", forbidden: /Manual —|Assisted —|Autopilot —|MARA is running|Automated/ },
  { name: "Free + Autopilot stored", plan: "free", mode: "autopilot", expected: "Autopilot — MARA runs within your limits.", planLabel: "Free workspace", forbidden: /Manual —|Assisted —|MARA is running\./ },
];

test("sidebar operational copy per plan and saved mode (rendered)", async (t) => {
  const documents = await Promise.all(
    MATRIX.map(async (row) => render({ plan: row.plan, automationLevel: row.mode })),
  );
  const results = await measured(
    MATRIX.map((row, index) => ({
      name: row.name,
      html: documents[index],
      width: 1280,
      height: 900,
      evaluate: `(() => {
        const aside = document.querySelector('aside');
        return {
          sidebarText: aside.innerText,
          sidebarHtml: aside.innerHTML,
        };
      })()`,
    })),
  );
  if (!results) return t.skip("no Chromium available for a rendered layout measurement");

  for (const [index, row] of MATRIX.entries()) {
    const result = results[index];
    const asideText = result.evaluate.sidebarText;
    const matched = asideText.match(statusPattern)?.[0] ?? null;
    assert.equal(matched, row.expected, `${row.name}: sidebar must say "${row.expected}", rendered "${matched}"`);
    assert.doesNotMatch(asideText, row.forbidden, `${row.name}: sidebar must not claim another automation state`);
    // Billing plan remains its own, separate display.
    assert.match(asideText, new RegExp(row.planLabel.replace(" ", "\\s")), `${row.name}: the plan label is preserved`);
    // The tier-derived copy of the shipped bug is gone everywhere.
    assert.doesNotMatch(asideText, /Automated — MARA is running\./, `${row.name}: tier-derived automation copy is removed`);
    assert.doesNotMatch(result.evaluate.sidebarHtml, /Automated — MARA is running\./);
  }

  // A Max account running Manual must never look like it is running
  // automatically, and an account with nothing stored must not be inferred as
  // any tier's mode.
  const maxManual = MATRIX.findIndex((row) => row.name === "Max + Manual");
  assert.doesNotMatch(results[maxManual].evaluate.sidebarText, /running|Automated/i);
  const maxUnset = MATRIX.findIndex((row) => row.name === "Max + nothing stored");
  assert.match(results[maxUnset].evaluate.sidebarText, /Automation mode not set\./);
  assert.doesNotMatch(results[maxUnset].evaluate.sidebarText, /MARA is running|Automated|Assisted —/);
  // Free + Manual and Max + Manual agree: same mode, same operational line.
  const freeManual = MATRIX.findIndex((row) => row.name === "Free + Manual");
  assert.equal(
    results[freeManual].evaluate.sidebarText.match(statusPattern)[0],
    results[maxManual].evaluate.sidebarText.match(statusPattern)[0],
  );
});

/* ──────────────────────────────────────────────────────────────
   One authoritative value — the control and the sidebar agree
   ────────────────────────────────────────────────────────────── */

test("a saved mode change updates the sidebar from the server-confirmed value (hydrated)", async (t) => {
  const props = { plan: "max", automationLevel: "manual", controlPlan: "max" };
  const bundle = buildClientBundle(`
    import { hydrateRoot } from "react-dom/client";
    import { createElement } from "react";
    import { TodaySurface } from "./tests/helpers/shell-surface.tsx";
    hydrateRoot(document, createElement(TodaySurface, ${JSON.stringify(props)}));
    window.__voomHydrated = true;
  `);
  const html = withClientBundle(
    await documentFrom(renderToStaticMarkup(h(layout.default, null, h(fixture.TodaySurface, props)))),
    bundle,
  );

  const [result] = (await measured([
    {
      name: "mode change",
      html,
      width: 1280,
      height: 900,
      beforeLoad: `try { localStorage.removeItem("voom-theme"); } catch (error) {}`,
      // The mode save endpoint is stubbed: this test is about which value the
      // UI treats as authoritative, not about the database.
      onDocumentStart: `
        window.__savedModes = [];
        window.fetch = async function (url, init) {
          if (String(url).indexOf("/api/automation-mode") === 0) {
            const mode = JSON.parse(init.body).mode;
            window.__savedModes.push(mode);
            return { ok: true, status: 200, json: async () => ({ mode, previousMode: "manual" }) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        };
      `,
      evaluate: `(async () => {
        const readSidebar = () => document.querySelector("aside").innerText.match(/Manual — MARA acts only when you ask\\.|Assisted — MARA drafts, you approve\\.|Autopilot — MARA runs within your limits\\.|Automation mode not set\\./)?.[0] ?? null;
        const before = readSidebar();
        const assisted = [...document.querySelectorAll("button")].find((button) => button.textContent.trim().startsWith("Assisted"));
        assisted.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          before,
          after: readSidebar(),
          pressed: assisted.getAttribute("aria-pressed"),
          savedModes: window.__savedModes,
        };
      })()`,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  assert.deepEqual(result.consoleMessages.filter((message) => message.level === "error" || message.level === "exception"), []);
  assert.equal(result.evaluate.before, "Manual — MARA acts only when you ask.");
  assert.deepEqual(result.evaluate.savedModes, ["assisted"], "the control saves through the one existing endpoint");
  assert.equal(result.evaluate.pressed, "true", "the control highlights the saved mode");
  assert.equal(
    result.evaluate.after,
    "Assisted — MARA drafts, you approve.",
    "the sidebar must follow the saved mode instead of keeping its own copy",
  );
});

/* ──────────────────────────────────────────────────────────────
   Wiring — one derivation, no tier mapping
   ────────────────────────────────────────────────────────────── */

test("the sidebar derives its operational copy from saved state only", async () => {
  const source = await readRepoFile("components/voom/shell/Sidebar.tsx");
  // The status line comes from the shared automation module...
  assert.match(source, /automationModeStatusLine\(automationMode\)/, "the sidebar must use the shared automation copy");
  assert.match(source, /const \{ sideOpen, plan, automationMode, displayName, email \} = useVoomState\(\)/, "the saved mode comes from the store");
  // ...and the tier is only ever used for the plan label.
  assert.doesNotMatch(source, /plan === "max"[\s\S]{0,120}(Automated|MARA is running|Assisted —|Manual —)/, "no tier → automation copy mapping");
  assert.doesNotMatch(source, /MARA is running/);
  // A single status line element, driven by one value.
  assert.equal(source.match(/automationModeStatusLine\(/g).length, 1, "one derivation of the sidebar status line");

  const storeSource = await readRepoFile("lib/voom/store.tsx");
  assert.match(storeSource, /automationMode: storedAutomationMode\(init\.business\?\.automation_level\)/, "the shell state is seeded from the stored column");
  assert.doesNotMatch(storeSource, /automationMode:\s*normalizeAutomationMode\(init\.business\?\.plan\)/, "the mode is never derived from the plan");
});
