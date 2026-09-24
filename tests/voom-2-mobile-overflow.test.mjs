/**
 * Voom 2.0 — narrow-viewport layout regression (release blocker 1).
 *
 * The reviewed Vercel preview of this PR rendered Today 509px wide inside a
 * ~354px viewport: the automation control and its "Current plan: …" line ran
 * off the right edge. Source-string assertions cannot see that, so this suite
 * measures the REAL surface:
 *
 *   - the real shell components (Sidebar, Topbar, AppShell, PageHead) and the
 *     real automation control are server-rendered from real account state;
 *   - the real `app/globals.css` is compiled by the project's own Tailwind
 *     plugin and served with the document;
 *   - the page is loaded in a real headless Chromium at real viewport widths,
 *     and `document.body.scrollWidth` is compared with `window.innerWidth`.
 *
 * The regression therefore fails on the shipped bug and passes on the fix, and
 * it also pins the desktop arrangement so the responsive fix cannot be traded
 * for a desktop redesign.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  RenderedSurfaceUnavailable,
  documentFrom,
  importApp,
  measureRenderedPages,
  react,
  renderToStaticMarkup,
} from "./helpers/rendered-surface.mjs";

const { createElement: h } = react;
const fixture = await importApp("tests/helpers/shell-surface.tsx");
const layout = await importApp("app/layout.tsx");

/** Today exactly as shipped for a Max account running Manual. */
const account = { plan: "max", automationLevel: "manual" };
const surface = renderToStaticMarkup(h(layout.default, null, h(fixture.TodaySurface, account)));
const documentHtml = await documentFrom(surface);

/** Widths a real phone in portrait, and a tablet, present. 354 is the reported case. */
const MOBILE_WIDTHS = [320, 354, 360, 390, 430, 768];

const measured = async (scenarios) => {
  try {
    return await measureRenderedPages(scenarios);
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return null;
    throw error;
  }
};

const describeOverflow = (result) =>
  `${result.name}: body scrollWidth ${result.bodyScrollWidth} > innerWidth ${result.innerWidth}; offenders: ` +
  result.overflowing.map((element) => `${element.tag}.${element.className} (right ${element.right}, "${element.text}")`).join(" | ");

test("the shell never scrolls horizontally at mobile or tablet widths", async (t) => {
  const results = await measured(MOBILE_WIDTHS.map((width) => ({ name: `${width}px`, html: documentHtml, width, height: 900 })));
  if (!results) return t.skip("no Chromium available for a rendered layout measurement");

  for (const result of results) {
    assert.ok(
      result.bodyScrollWidth <= result.innerWidth,
      `horizontal page overflow: ${describeOverflow(result)}`,
    );
    assert.ok(
      result.documentScrollWidth <= result.innerWidth,
      `document scrolls horizontally: ${describeOverflow(result)}`,
    );
    assert.equal(result.overflowingCount, 0, `elements render past the viewport: ${describeOverflow(result)}`);
  }
});

test("the automation control and its explanation fit inside a 354px viewport", async (t) => {
  const [result] = (await measured([
    {
      name: "354px control",
      html: documentHtml,
      width: 354,
      height: 900,
      evaluate: `(() => {
        const control = document.querySelector('[role="group"][aria-label="Automation mode"]');
        const explanation = [...document.querySelectorAll("p")].find((node) => node.textContent.startsWith("Current plan:"));
        const measured = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            text: element.textContent.trim().slice(0, 80),
          };
        };
        return { control: measured(control), explanation: measured(explanation) };
      })()`,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  assert.ok(result.evaluate.control, "the automation control is rendered in the page head");
  assert.ok(result.evaluate.explanation, "the automation explanation is rendered");

  const { control, explanation } = result.evaluate;
  // Fully inside the viewport...
  for (const [label, element] of [["control", control], ["explanation", explanation]]) {
    assert.ok(element.left >= 0, `${label} starts off the left edge (${element.left})`);
    assert.ok(element.right <= result.innerWidth, `${label} runs past the right edge (right ${element.right} > viewport ${result.innerWidth})`);
  }
  // ...and nothing inside them is clipped: the content is genuinely sized, not
  // hidden. Without this, `overflow-x: hidden` would "pass" while text is lost.
  for (const [label, element] of [["control", control], ["explanation", explanation]]) {
    assert.ok(
      element.scrollWidth <= element.clientWidth + 1,
      `${label} clips its own content (scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth})`,
    );
  }
  // The long label wraps instead of forcing a wide single line.
  assert.ok(explanation.width <= result.innerWidth, "the explanation must wrap within the viewport");
});

test("horizontal overflow is fixed by layout, not by hiding it", async (t) => {
  const [result] = (await measured([
    {
      name: "no clipping",
      html: documentHtml,
      width: 354,
      height: 900,
      evaluate: `(() => {
        const read = (element) => getComputedStyle(element).overflowX;
        return { html: read(document.documentElement), body: read(document.body), main: read(document.querySelector("main")) };
      })()`,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  for (const [element, value] of Object.entries(result.evaluate)) {
    assert.ok(
      value !== "hidden" && value !== "clip",
      `${element} hides horizontal overflow (overflow-x: ${value}) — content must fit instead`,
    );
  }
});

test("desktop still renders the page head on one row", async (t) => {
  const [result] = (await measured([
    {
      name: "1280px",
      html: documentHtml,
      width: 1280,
      height: 900,
      evaluate: `(() => {
        const title = document.querySelector("h1").getBoundingClientRect();
        const control = document.querySelector('[role="group"][aria-label="Automation mode"]').getBoundingClientRect();
        return {
          titleLeft: Math.round(title.left),
          titleRight: Math.round(title.right),
          titleTop: Math.round(title.top),
          controlLeft: Math.round(control.left),
          controlTop: Math.round(control.top),
          sidebarWidth: Math.round(document.querySelector("aside").getBoundingClientRect().width),
        };
      })()`,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered layout measurement");

  assert.equal(result.bodyScrollWidth <= result.innerWidth, true, "desktop must not overflow either");
  // Title on the left, actions on the same row to the right — the approved
  // desktop arrangement, unchanged by the responsive fix.
  assert.ok(result.evaluate.controlLeft > result.evaluate.titleRight, "desktop keeps the actions to the right of the title");
  assert.ok(Math.abs(result.evaluate.controlTop - result.evaluate.titleTop) < 40, "desktop keeps the actions on the title's row");
  assert.equal(result.evaluate.sidebarWidth, 268, "the approved sidebar proportion is unchanged");
});
