/**
 * Theme hydration — regression tests (release blocker 3).
 *
 * The shipped store called `initialState()` during render and read
 * `localStorage` inside it:
 *
 *   server render        → theme "light" (no storage on the server),
 *   first client render  → theme "dark" for a returning dark-theme user,
 *
 * so the toggle's icon and accessible label (and the html element's data-theme)
 * differed while React hydrated.
 *
 * What is proven here:
 *   1. PURE — `initialTheme()` cannot read browser state, the persisted value
 *      is only read through `readStoredTheme` (tolerant of broken storage), and
 *      the pre-paint script carries the same key and default.
 *   2. RENDER — the real provider renders byte-identical markup whether or not
 *      browser storage exists and says "dark": server and first client render
 *      cannot disagree because nothing browser-read happens during render.
 *   3. BROWSER, no client JS — a returning dark-theme user still paints dark:
 *      the theme is applied by the pre-paint path alone (no light flash while
 *      React's bundle loads).
 *   4. BROWSER, real hydration — the app's own client code hydrates the real
 *      shell with `localStorage` already set to dark and React reports no
 *      mismatch; the toggle then reads "Switch to light mode" and shows the sun
 *      icon (label and icon still describe the CURRENT theme).
 *   5. BROWSER, interaction — toggling still persists to `localStorage` and
 *      flips the theme in both directions, and the label/icon follow.
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
const theme = await importApp("lib/voom/theme.ts");
const automationComponent = await importApp("components/voom/operating/AutomationMode.tsx");

const props = { plan: "max", automationLevel: "manual" };
const renderSurface = () => renderToStaticMarkup(h(layout.default, null, h(fixture.TodaySurface, props)));

const measured = async (scenarios) => {
  try {
    return await measureRenderedPages(scenarios);
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return null;
    throw error;
  }
};

// Records EVERY value <html data-theme> takes, from before the pre-paint script
// runs, so "no light flash" is a measurement rather than an assumption.
const themeHistoryProbe = `
  window.__themeHistory = [];
  new MutationObserver(() => window.__themeHistory.push(document.documentElement.getAttribute("data-theme")))
    .observe(document, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
`;
/** The distinct themes ever painted, in order (a re-write of the same value is not a repaint). */
const paintedThemes = (history) => [...new Set(history ?? [])];

const toggleState = `(() => {
  const toggle = document.querySelector('button[aria-label^="Switch to"]');
  return {
    history: window.__themeHistory ?? null,
    label: toggle?.getAttribute("aria-label") ?? null,
    hasSunGlyph: Boolean(toggle?.querySelector("circle")),
    theme: document.documentElement.getAttribute("data-theme"),
    background: getComputedStyle(document.body).backgroundColor,
    stored: (() => { try { return localStorage.getItem("voom-theme"); } catch (error) { return "unreadable"; } })(),
    hydrated: Boolean(window.__voomHydrated),
  };
})()`;

const clientBundle = () =>
  buildClientBundle(`
    import { hydrateRoot } from "react-dom/client";
    import { createElement } from "react";
    import { TodaySurface } from "./tests/helpers/shell-surface.tsx";
    hydrateRoot(document, createElement(TodaySurface, ${JSON.stringify(props)}));
    window.__voomHydrated = true;
  `);

/* ──────────────────────────────────────────────────────────────
   1. Pure behaviour
   ────────────────────────────────────────────────────────────── */

test("the initial theme is a constant that cannot read browser state", () => {
  const first = theme.initialTheme();
  // A poisoned global storage must not change it: the initial theme is decided
  // by the product default, not by whatever the browser happens to hold.
  const originalWindow = globalThis.window;
  try {
    globalThis.window = { localStorage: { getItem: () => "dark" } };
    assert.equal(theme.initialTheme(), first);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
  assert.equal(first, "light", "Voom 2.0 defaults to the warm light workspace");
  assert.equal(theme.DEFAULT_THEME, "light");
});

test("the persisted theme is read only after hydration, and defensively", () => {
  const store = (value) => ({ getItem: () => value });
  assert.equal(theme.readStoredTheme(store("dark")), "dark");
  assert.equal(theme.readStoredTheme(store("light")), "light");
  for (const junk of [null, undefined, "", "DARK", "system", "1"]) {
    assert.equal(theme.readStoredTheme(store(junk)), "light", `${JSON.stringify(junk)} is not a stored theme`);
  }
  // Private mode / blocked cookies must not break the shell.
  assert.equal(theme.readStoredTheme({ getItem: () => { throw new Error("blocked"); } }), "light");
  assert.equal(theme.readStoredTheme(null), "light");
  assert.equal(theme.readStoredTheme(undefined), "light");
});

test("the accessible toggle label and icon are preserved", () => {
  assert.equal(theme.themeToggleLabel("light"), "Switch to dark mode");
  assert.equal(theme.themeToggleLabel("dark"), "Switch to light mode");
  assert.equal(theme.themeToggleIcon("light"), "moon");
  assert.equal(theme.themeToggleIcon("dark"), "sun");
});

test("the pre-paint script writes the same key and default the store uses", async () => {
  assert.equal(theme.THEME_STORAGE_KEY, "voom-theme", "the persisted key is unchanged for existing users");
  assert.match(theme.THEME_INIT_SCRIPT, /localStorage\.getItem\("voom-theme"\)/);
  assert.match(theme.THEME_INIT_SCRIPT, /setAttribute\("data-theme"/);
  assert.match(theme.THEME_INIT_SCRIPT, /"light"/, "the script's default matches initialTheme()");
  // Inline and self-contained: no network request before the first paint.
  assert.doesNotMatch(theme.THEME_INIT_SCRIPT, /src=|import\(|fetch\(/);

  // The root layout ships that exact script inline, before any content.
  const rootLayout = await readRepoFile("app/layout.tsx");
  assert.match(rootLayout, /THEME_INIT_SCRIPT/, "the root layout must inject the pre-paint script");
  assert.match(rootLayout, /dangerouslySetInnerHTML=\{\{ __html: THEME_INIT_SCRIPT \}\}/, "the script must be inline, not a file");
});

/* ──────────────────────────────────────────────────────────────
   2. Render: storage cannot leak into the markup
   ────────────────────────────────────────────────────────────── */

test("the server render is byte-identical with and without persisted browser state", () => {
  const withoutBrowser = renderSurface();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  try {
    // A returning dark-theme user, as the browser sees them.
    globalThis.window = { localStorage: { getItem: () => "dark" }, matchMedia: () => ({ matches: true }) };
    globalThis.document = { documentElement: { dataset: {} } };
    assert.equal(renderSurface(), withoutBrowser, "a browser read during render would change this markup");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
  // The server markup carries no theme decision of its own — the pre-paint
  // script, not the markup, applies the persisted value.
  assert.doesNotMatch(withoutBrowser, /data-theme="dark"/);
});

/* ──────────────────────────────────────────────────────────────
   3 & 4. Browser: pre-paint, then real hydration
   ────────────────────────────────────────────────────────────── */

test("a returning dark-theme user paints dark before any client JavaScript runs", async (t) => {
  const [result] = (await measured([
    {
      name: "dark without client js",
      html: await documentFrom(renderSurface()),
      width: 1280,
      height: 900,
      onDocumentStart: themeHistoryProbe,
      beforeLoad: `localStorage.setItem("voom-theme", "dark");`,
      evaluate: toggleState,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  assert.equal(result.evaluate.theme, "dark", "the pre-paint script applies the persisted theme");
  assert.deepEqual(paintedThemes(result.evaluate.history), ["dark"], "dark is the only theme ever painted for this user (no light flash)");
  assert.equal(result.evaluate.hydrated, false, "no client bundle is loaded in this scenario");
  assert.equal(result.evaluate.background, "rgb(10, 14, 13)", "the dark workspace token is painted");
  // The markup on the wire still renders the light default (server and first
  // client render agree); only the attribute decides the paint.
  assert.match(result.evaluate.background, /rgb\(10, 14, 13\)/);
});

test("hydration with a persisted dark theme reports no mismatch and keeps the toggle truthful", async (t) => {
  const html = withClientBundle(await documentFrom(renderSurface()), clientBundle());
  const [result] = (await measured([
    {
      name: "dark hydrated",
      html,
      width: 1280,
      height: 900,
      onDocumentStart: themeHistoryProbe,
      beforeLoad: `localStorage.setItem("voom-theme", "dark");`,
      evaluate: toggleState,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  const problems = result.consoleMessages.filter((message) => message.level === "error" || message.level === "exception");
  assert.deepEqual(problems.map((message) => message.text.slice(0, 120)), [], "hydration must not mismatch or throw");
  assert.equal(result.evaluate.hydrated, true, "the real client bundle ran");
  assert.equal(result.evaluate.theme, "dark");
  assert.equal(result.evaluate.stored, "dark", "the persisted choice is preserved");
  assert.equal(result.evaluate.label, "Switch to light mode", "the label describes the CURRENT theme");
  assert.equal(result.evaluate.hasSunGlyph, true, "the icon matches the label (sun shows in dark mode)");
  assert.deepEqual(paintedThemes(result.evaluate.history), ["dark"], "hydration never repaints the page light (no flash)");
});

test("a fresh user (nothing persisted) hydrates light and stays light", async (t) => {
  const html = withClientBundle(await documentFrom(renderSurface()), clientBundle());
  const [result] = (await measured([
    {
      name: "light hydrated",
      html,
      width: 1280,
      height: 900,
      onDocumentStart: themeHistoryProbe,
      beforeLoad: `try { localStorage.removeItem("voom-theme"); } catch (error) {}`,
      evaluate: toggleState,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  assert.deepEqual(
    result.consoleMessages.filter((message) => message.level === "error" || message.level === "exception"),
    [],
    "hydration must not mismatch or throw",
  );
  assert.equal(result.evaluate.hydrated, true);
  assert.equal(result.evaluate.theme, "light");
  assert.deepEqual(paintedThemes(result.evaluate.history), ["light"], "the default is painted and never swapped");
  assert.equal(result.evaluate.stored, null, "no preference is written back for a fresh user");
  assert.equal(result.evaluate.label, "Switch to dark mode");
  assert.equal(result.evaluate.hasSunGlyph, false, "the moon icon shows in light mode");
  assert.equal(result.evaluate.background, "rgb(246, 245, 239)", "the warm light workspace is painted");
});

test("the theme toggle still persists and flips in both directions", async (t) => {
  const html = withClientBundle(await documentFrom(renderSurface()), clientBundle());
  const [result] = (await measured([
    {
      name: "toggle",
      html,
      width: 1280,
      height: 900,
      beforeLoad: `localStorage.setItem("voom-theme", "dark");`,
      evaluate: `(async () => {
        const read = () => {
          const toggle = document.querySelector('button[aria-label^="Switch to"]');
          return {
            label: toggle?.getAttribute("aria-label") ?? null,
            hasSunGlyph: Boolean(toggle?.querySelector("circle")),
            theme: document.documentElement.getAttribute("data-theme"),
            stored: localStorage.getItem("voom-theme"),
          };
        };
        const before = read();
        document.querySelector('button[aria-label^="Switch to"]').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const after = read();
        document.querySelector('button[aria-label^="Switch to"]').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const back = read();
        return { before, after, back };
      })()`,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  assert.equal(result.evaluate.before.theme, "dark");
  assert.equal(result.evaluate.after.theme, "light", "toggling away from dark applies light immediately");
  assert.equal(result.evaluate.after.stored, "light", "the new choice is persisted");
  assert.equal(result.evaluate.after.label, "Switch to dark mode", "the label follows the theme");
  assert.equal(result.evaluate.after.hasSunGlyph, false, "the icon follows the theme");
  assert.equal(result.evaluate.back.theme, "dark", "toggling back applies dark again");
  assert.equal(result.evaluate.back.stored, "dark");
  assert.equal(result.evaluate.back.label, "Switch to light mode");
  assert.equal(result.evaluate.back.hasSunGlyph, true);
});

/* ──────────────────────────────────────────────────────────────
   Adjacent hydration safety — the automation mode cards
   ────────────────────────────────────────────────────────────── */

test("the descriptive automation cards hydrate without a text mismatch", async (t) => {
  // The cards are server-rendered from the saved mode and hydrate on the
  // Automations screen; shared copy must render as single text nodes or React
  // reports a mismatch and regenerates the tree.
  // Pro: Manual + Assisted are available, Autopilot is not — so both the
  // "Requires Max" badge and the plan note render while one card is active.
  const modeProps = { describe: true, initial: "assisted", plan: "pro" };
  const scenario = h("div", null, h(automationComponent.AutomationMode, modeProps));
  const surfaceProps = { plan: "pro", automationLevel: "assisted", controlPlan: "pro" };
  const markup = renderToStaticMarkup(h(layout.default, null, h(fixture.TodaySurface, surfaceProps, scenario)));
  const bundle = buildClientBundle(`
    import { hydrateRoot } from "react-dom/client";
    import { createElement } from "react";
    import { TodaySurface } from "./tests/helpers/shell-surface.tsx";
    import { AutomationMode } from "./components/voom/operating/AutomationMode.tsx";
    const scenario = createElement("div", null, createElement(AutomationMode, ${JSON.stringify(modeProps)}));
    hydrateRoot(document, createElement(TodaySurface, ${JSON.stringify(surfaceProps)}, scenario));
    window.__voomHydrated = true;
  `);

  const [result] = (await measured([
    {
      name: "cards hydrated",
      html: withClientBundle(await documentFrom(markup), bundle),
      width: 1280,
      height: 1200,
      evaluate: `({
        hydrated: Boolean(window.__voomHydrated),
        paidMedia: document.body.innerText.includes("Paid media:"),
        requires: document.body.innerText.includes("Requires Max"),
        planNote: document.body.innerText.includes("Your pro plan does not support Autopilot mode."),
        activeCards: document.querySelectorAll('[data-active="true"]').length,
      })`,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  assert.deepEqual(
    result.consoleMessages.filter((message) => message.level === "error" || message.level === "exception").map((message) => message.text.slice(0, 140)),
    [],
    "the mode cards must hydrate cleanly",
  );
  assert.equal(result.evaluate.hydrated, true);
  assert.equal(result.evaluate.activeCards, 1, "exactly one card is active after hydration");
  assert.equal(result.evaluate.paidMedia, true, "the paid-media copy still renders");
  assert.equal(result.evaluate.requires, true, "the plan-requirement badge still renders");
  assert.equal(result.evaluate.planNote, true, "the plan note still renders");
});

/* ──────────────────────────────────────────────────────────────
   Dark-mode readability of the shared muted-text token
   ────────────────────────────────────────────────────────────── */

/** WCAG relative luminance / contrast, computed from the real token values. */
function contrast(foreground, background) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function themeTokens(css, selector) {
  const block = css.slice(css.indexOf(selector));
  const body = block.slice(block.indexOf("{"), block.indexOf("}"));
  const tokens = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) tokens[match[1]] = match[2];
  return tokens;
}

test("muted text stays readable in dark mode (and the light workspace is untouched)", async () => {
  const css = await readRepoFile("app/globals.css");
  const light = themeTokens(css, ":root {");
  const dark = themeTokens(css, ':root[data-theme="dark"] {');
  assert.equal(light["text-3"], "#9a9996", "the approved light muted token is unchanged");

  for (const surface of ["bg", "surface", "surface-2", "surface-3"]) {
    const ratio = contrast(dark["text-3"], dark[surface]);
    assert.ok(ratio >= 4.5, `dark --text-3 on --${surface} is ${ratio.toFixed(2)}:1 (needs >= 4.5:1)`);
  }
  // Body text keeps its stronger ratios, and muted text stays visibly muted.
  assert.ok(contrast(dark["text"], dark["surface"]) >= 7, "dark body text keeps AAA contrast on cards");
  assert.ok(contrast(dark["text-2"], dark["surface"]) >= 4.5, "dark secondary text keeps AA contrast");
  assert.ok(contrast(dark["text-3"], dark["surface"]) < contrast(dark["text-2"], dark["surface"]), "muted text stays quieter than secondary text");
});

/* ──────────────────────────────────────────────────────────────
   Wiring — nothing browser-only is read while rendering
   ────────────────────────────────────────────────────────────── */

test("the shell reads the theme through a hydration-safe external store", async () => {
  const store = await readRepoFile("lib/voom/store.tsx");
  // React uses the server snapshot while hydrating and the stored value after.
  assert.match(store, /useSyncExternalStore\(subscribeToTheme, themeSnapshot, initialTheme\)/);
  assert.doesNotMatch(store, /theme: initialTheme\(\)/, "the theme is not part of the render-time state that must match the server");
  assert.doesNotMatch(store, /localStorage\.getItem/, "the store renders without touching storage");
  // The document attribute always follows the AUTHORITATIVE stored theme, so
  // hydration can never downgrade a dark user to the light default.
  assert.match(store, /applyThemeToDocument\(readStoredTheme\(window\.localStorage\)\)/);
  assert.match(store, /persistTheme\(t\)/, "the toggle still persists through the shared helper");

  const theme = await readRepoFile("lib/voom/theme.ts");
  assert.match(theme, /localStorage\.setItem\(THEME_STORAGE_KEY, theme\)/, "the persisted key is unchanged");
  assert.match(theme, /export function themeSnapshot\(/);
  assert.match(theme, /export function subscribeToTheme\(/);
});
