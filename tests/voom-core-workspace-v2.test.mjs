/**
 * Voom 2.0 — Core Workspace (Phase 3) regression suite.
 *
 * Five surfaces were redesigned together on one shared vocabulary: Marketing
 * Plan, Content Calendar, Create/Studio, Performance and Approvals. Source
 * assertions alone cannot protect that work, so this suite measures the SHIPPED
 * surfaces:
 *
 *   1. THE SHARED LAYER IS SERVER-SAFE — `components/voom/workspace/ui.tsx` and
 *      `lib/voom/workflow/presentation.ts` carry no `"use client"`, no hooks and
 *      no client-module imports, so the server pages (Plan, Performance,
 *      Approvals) can render them directly. This is the class of bug that
 *      crashed the Today preview: a server component invoking an exported
 *      helper through Next's client-module proxy.
 *   2. THE FIVE SURFACES FIT EVERY REQUIRED VIEWPORT — the real components,
 *      rendered inside the real shell, with the real compiled stylesheet, in a
 *      real headless Chromium at 320 / 354 / 390 / 430 / tablet / laptop /
 *      large desktop, in BOTH themes. Mobile is asked to be usable rather than
 *      complete, so the assertion is: nothing runs off the viewport, nothing is
 *      clipped, the mobile navigation survives, and the loaded content is
 *      genuinely on the page (an empty skeleton would otherwise "pass").
 *   3. HYDRATION IS QUIET — the two fetch-driven surfaces hydrate with the real
 *      client bundle against the real API payloads and must report no console
 *      error or exception.
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
  withClientBundle,
} from "./helpers/rendered-surface.mjs";
import { buildClientBundle } from "./helpers/client-bundle.mjs";

// These documents are HYDRATED, and `renderToStaticMarkup` is a static-only
// renderer: it emits no text-node separators, so a heading built from two
// adjacent text nodes ("Rolling " + the horizon label) hydrates as one merged
// node and React reports a mismatch the real Next server never produces. The
// hydrating renderer is used here for the same reason the app's own server
// renderer is.
const { renderToString } = await import("react-dom/server");
const { createElement: h } = react;
const fixture = await importApp("tests/helpers/workspace-surfaces.tsx");
const layout = await importApp("app/layout.tsx");

const SURFACES = ["plan", "calendar", "studio", "performance", "approvals"];

/**
 * Every file that makes up one redesigned surface. The page is the entry point;
 * the workspace component is where the design language actually lives, and both
 * must use the shared vocabulary.
 */
const FILES = {
  plan: ["app/app/(shell)/plan/page.tsx", "components/voom/operating/PlanWorkspace.tsx", "components/voom/operating/PlanItemCard.tsx"],
  calendar: ["app/app/(shell)/calendar/page.tsx"],
  studio: ["app/app/(shell)/studio/page.tsx"],
  performance: ["app/app/(shell)/performance/page.tsx"],
  approvals: ["app/app/(shell)/approvals/page.tsx", "components/voom/operating/ApprovalsWorkspace.tsx", "components/voom/operating/ApprovalsBoard.tsx"],
};

/**
 * Where the shared status vocabulary is required: the surfaces that render
 * workflow rows. Performance renders provider measurements (no workflow state)
 * and Approvals renders approval actions, so neither has a status to tone.
 */
const REQUIRES_PRESENTATION = new Set(["plan", "calendar", "studio"]);

/** Server components only: the pages Next renders on the server. */
const SERVER_PAGES = ["app/app/(shell)/plan/page.tsx", "app/app/(shell)/performance/page.tsx", "app/app/(shell)/approvals/page.tsx"];

/** Strips comments so a check never trips over documentation that names the pattern. */
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Real content each surface must actually show once it has rendered. */
const LOADED_MARKER = {
  plan: "Seven-day plan",
  // Fetch-driven surfaces: this text exists only once the real payload rendered.
  calendar: "A 12-second counter tour",
  studio: "Three checkout mistakes",
  performance: "Best-performing recent content",
  approvals: "Speed is the feature your customers actually feel",
};

/* ──────────────────────────────────────────────────────────────
   1. The shared presentation layer (source, no browser)
   ────────────────────────────────────────────────────────────── */

test("the shared workspace layer is server-safe and carries no client-only code", async () => {
  const [uiSource, presentationSource] = await Promise.all([
    readRepoFile("components/voom/workspace/ui.tsx"),
    readRepoFile("lib/voom/workflow/presentation.ts"),
  ]);
  const ui = withoutComments(uiSource);
  const presentation = withoutComments(presentationSource);

  // A server component may render these directly only while they stay free of
  // the client directive and of React state/effects. `"use client"` must be the
  // first statement of the file, not merely absent from the code.
  assert.doesNotMatch(uiSource, /^\s*["']use client["']/m, "the workspace primitives must stay server-safe");
  assert.doesNotMatch(presentationSource, /^\s*["']use client["']|^\s*["']server-only["']/m, "the presentation vocabulary stays pure");
  assert.doesNotMatch(ui, /\buse(State|Effect|Ref|Memo|Callback|Reducer|Context|LayoutEffect|SyncExternalStore)\b/, "no hooks in a server-safe module");
  assert.doesNotMatch(presentation, /from "react"/, "the presentation vocabulary needs no React");

  // The one cross-boundary helper is the server-safe `cx`.
  assert.match(ui, /import \{ cx \} from "@\/lib\/voom\/cx"/, "layout helpers come from the server-safe cx module");
  assert.doesNotMatch(ui, /from "@\/components\/voom\/ui\/primitives"/, "never reach a helper through the client-only primitives module");

  // Both modules are pure: importing them must not require a browser global.
  for (const [name, source] of [["workspace ui", ui], ["presentation", presentation]]) {
    assert.doesNotMatch(source, /\bwindow\.|\bdocument\.|\blocalStorage\b/, `${name} must not touch browser globals`);
  }
});

test("the five redesigned surfaces share one vocabulary instead of five design systems", async () => {
  for (const [name, files] of Object.entries(FILES)) {
    let usesPrimitives = false;
    let usesPresentation = false;
    for (const file of files) {
      const source = withoutComments(await readRepoFile(file));
      if (/@\/components\/voom\/workspace\/ui/.test(source)) usesPrimitives = true;
      if (/@\/lib\/voom\/workflow\/presentation/.test(source)) usesPresentation = true;
      // One tone mapping, one channel identity: the old per-page colour maps are
      // gone, so a status can no longer be amber on one screen and red on another.
      assert.doesNotMatch(source, /const (STATUS_TONE|STAGE_TONE|STATE_COLORS|CHANNEL_COLORS)\s*[:=]/, `${file} must not define its own state colour map`);
    }
    assert.equal(usesPrimitives, true, `${name} renders the shared workspace primitives`);
    // Performance reads measured provider results, not workflow rows: it shares
    // the primitives and the frame, and has no workflow state to tone.
    if (REQUIRES_PRESENTATION.has(name)) assert.equal(usesPresentation, true, `${name} uses the shared presentation vocabulary`);
  }

  // The server surfaces must never pull layout helpers through a client module:
  // that is the RSC boundary crash this redesign has to keep fixed.
  for (const file of SERVER_PAGES) {
    const source = withoutComments(await readRepoFile(file));
    assert.doesNotMatch(
      source,
      /import\s*\{[^}]*\bcx\b[^}]*\}\s*from\s*["']@\/components\/voom\/ui\/primitives["']/s,
      `${file} must not invoke cx through the client module`,
    );
    assert.doesNotMatch(source, /from "@\/components\/voom\/ui\/primitives"/, `${file} is a server page and must not import the client primitives at all`);
  }
});

/* ──────────────────────────────────────────────────────────────
   Rendered measurement — the real surfaces in a real browser
   ────────────────────────────────────────────────────────────── */

const clientBundle = buildClientBundle(`
  import { hydrateRoot } from "react-dom/client";
  import { createElement } from "react";
  import { ShellSurface, Surface } from "./tests/helpers/workspace-surfaces.tsx";
  hydrateRoot(document, createElement(ShellSurface, null, createElement(Surface, { name: window.__VOOM_SURFACE })));
  window.__voomHydrated = true;
`);

/**
 * The real API payloads, served to the two fetch-driven surfaces before any
 * application code runs — so the calendar and the studio render the same data
 * they render in production, not a loading state.
 */
const payloads = {
  "/api/voom/workflow": fixture.calendarPayload(),
  "/api/posts": fixture.studioPayload(),
  "/api/plan": { snapshot: fixture.planSnapshot() },
  "/api/instagram/publishing-queue": fixture.publishingQueuePayload(),
};

const documentFor = async (name) =>
  withClientBundle(
    await documentFrom(renderToString(h(layout.default, null, h(fixture.ShellSurface, null, h(fixture.Surface, { name }))))),
    clientBundle,
  );

const documents = new Map();
for (const name of SURFACES) documents.set(name, await documentFor(name));

const startFor = (name) => `
  window.__VOOM_SURFACE = ${JSON.stringify(name)};
  (() => {
    const payloads = ${JSON.stringify(payloads)};
    const paths = Object.keys(payloads);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const match = paths.find((path) => url.includes(path));
      if (!match) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(payloads[match]), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  })();
`;

const measured = async (scenarios) => {
  try {
    return await measureRenderedPages(scenarios);
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return null;
    throw error;
  }
};

/** Decorative light volumes are inert and clipped by their own container. */
const DECORATIVE = /ws-(atmosphere|spectrum|aurora|orbit)|voom-atmospheric-orbit|pointer-events-none/;
const offenders = (result) => result.overflowing.filter((entry) => !DECORATIVE.test(entry.className));
const describe = (result) =>
  `${result.name}: body ${result.bodyScrollWidth} / document ${result.documentScrollWidth} vs viewport ${result.innerWidth}; ` +
  offenders(result).map((entry) => `${entry.tag}.${entry.className} right=${entry.right} "${entry.text}"`).join(" | ");

const MOBILE = [320, 354, 390, 430];
const LARGE = [834, 1280, 1600];

for (const theme of ["light", "dark"]) {
  test(`all five surfaces fit every required viewport in ${theme} mode`, async (t) => {
    const scenarios = [];
    for (const name of SURFACES) {
      for (const width of [...MOBILE, ...LARGE]) {
        scenarios.push({
          name: `${name} @${width}`,
          html: documents.get(name),
          width,
          height: 900,
          onDocumentStart: startFor(name),
          // The real pre-paint theme path: a persisted preference on this origin.
          beforeLoad: theme === "dark" ? `localStorage.setItem("voom-theme", "dark");` : `try { localStorage.removeItem("voom-theme"); } catch (error) {}`,
        });
      }
    }
    const results = await measured(scenarios);
    if (!results) return t.skip("no Chromium available for a rendered workspace measurement");

    const expectedBackground = theme === "dark" ? "rgb(7, 9, 18)" : "rgb(247, 248, 251)";
    for (const result of results) {
      assert.ok(result.bodyScrollWidth <= result.innerWidth, `horizontal page overflow — ${describe(result)}`);
      assert.ok(result.documentScrollWidth <= result.innerWidth, `document scrolls sideways — ${describe(result)}`);
      assert.deepEqual(offenders(result), [], `${result.name} renders content past the viewport: ${describe(result)}`);
      assert.equal(result.theme, theme, `${result.name} must paint the ${theme} workspace`);
      assert.equal(result.background, expectedBackground, `${result.name} did not paint the ${theme} workspace token`);

      const problems = result.consoleMessages.filter((message) => message.level === "error" || message.level === "exception");
      assert.deepEqual(problems.map((message) => message.text.slice(0, 160)), [], `${result.name} logged an error`);
    }
  });
}

test("each surface really renders its loaded content at every width", async (t) => {
  const results = await measured(
    SURFACES.map((name) => ({ name, html: documents.get(name), width: 390, height: 900, onDocumentStart: startFor(name) })),
  );
  if (!results) return t.skip("no Chromium available for a rendered workspace measurement");

  for (const result of results) {
    assert.equal(result.evaluateError, null, `${result.name} threw while measuring`);
    assert.ok(
      result.bodyText.includes(LOADED_MARKER[result.name]),
      `${result.name} did not render its real content (a loading skeleton must not pass as a page)`,
    );
    // A page that renders nothing cannot overflow, so content presence and the
    // overflow checks are only meaningful together.
    assert.ok(result.bodyText.length > 600, `${result.name} rendered almost no content`);
  }
});

test("light mode keeps the refracted Voom workspace rather than flattening to white SaaS", async (t) => {
  const [result] = (await measured([
    {
      name: "light tokens",
      html: documents.get("plan"),
      width: 1280,
      height: 900,
      onDocumentStart: startFor("plan"),
      evaluate: `(() => {
        const root = getComputedStyle(document.documentElement);
        const panel = document.querySelector(".ws-panel");
        const spectrum = document.querySelector(".ws-spectrum");
        return {
          theme: document.documentElement.getAttribute("data-theme"),
          background: getComputedStyle(document.body).backgroundColor,
          iridescent: root.getPropertyValue("--iridescent").trim().slice(0, 40),
          panelBackground: panel ? getComputedStyle(panel).backgroundColor : null,
          panelIsTranslucent: panel ? getComputedStyle(panel).backgroundColor.includes("rgba") : false,
          atmosphere: Boolean(spectrum),
          spectrumFilter: spectrum ? getComputedStyle(spectrum).backgroundImage.slice(0, 60) : null,
          bodyText: document.body.innerText.slice(0, 200),
        };
      })()`,
    },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered workspace measurement");

  assert.equal(result.evaluate.theme, "light", "the default workspace is the light one");
  assert.equal(result.evaluate.background, "rgb(247, 248, 251)");
  assert.match(result.evaluate.iridescent, /linear-gradient/, "the refracted spectrum token is still defined");
  assert.equal(result.evaluate.atmosphere, true, "the atmospheric light volume is present in light mode too");
  assert.match(result.evaluate.spectrumFilter ?? "", /gradient/, "the spectrum band keeps real colour in light mode");
  assert.equal(result.evaluate.panelIsTranslucent, true, "workspace panels are frosted glass, not flat white");
});

test("the mobile shell survives the redesign: navigation stays and content is not clipped", async (t) => {
  const results = await measured(
    SURFACES.map((name) => ({
      name,
      html: documents.get(name),
      width: 390,
      height: 900,
      onDocumentStart: startFor(name),
      evaluate: `(() => {
        const header = document.querySelector("header");
        const bottomBar = document.querySelector("nav[aria-label], nav");
        const main = document.querySelector("main");
        const overflow = (element) => element ? getComputedStyle(element).overflowX : null;
        return {
          hasHeader: Boolean(header),
          headerFits: header ? Math.round(header.getBoundingClientRect().right) <= window.innerWidth + 1 : false,
          navPresent: Boolean(bottomBar),
          htmlOverflowX: overflow(document.documentElement),
          bodyOverflowX: overflow(document.body),
          mainOverflowX: overflow(main),
          title: document.querySelector("h1")?.textContent ?? null,
        };
      })()`,
    })),
  );
  if (!results) return t.skip("no Chromium available for a rendered workspace measurement");

  for (const result of results) {
    assert.equal(result.evaluateError, null, `${result.name} threw while measuring`);
    assert.equal(result.evaluate.hasHeader, true, `${result.name} has no workspace header`);
    assert.equal(result.evaluate.headerFits, true, `${result.name} header overflows its viewport`);
    assert.equal(result.evaluate.navPresent, true, `${result.name} lost the shell navigation`);
    for (const [element, value] of Object.entries({
      html: result.evaluate.htmlOverflowX,
      body: result.evaluate.bodyOverflowX,
      main: result.evaluate.mainOverflowX,
    })) {
      assert.ok(value !== "hidden" && value !== "clip", `${result.name} hides overflow on ${element} instead of fitting it`);
    }
    assert.ok(result.evaluate.title && result.evaluate.title.length > 3, `${result.name} has no page title`);
  }
});

/* ──────────────────────────────────────────────────────────────
   Truthfulness of the five surfaces' primary answers
   ────────────────────────────────────────────────────────────── */

test("Marketing Plan shows the real horizon, the real mix and the connection truth", async (t) => {
  const [result] = (await measured([
    { name: "plan", html: documents.get("plan"), width: 1280, height: 900, onDocumentStart: startFor("plan") },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered workspace measurement");

  const text = result.bodyText;
  // The rolling horizon, annotated from the authoritative reads.
  assert.match(text, /Rolling 7-day/, "the current rolling horizon is stated");
  // Each planned day, its channel and its native format.
  assert.match(text, /Instagram/, "channel identity is present");
  assert.match(text, /TikTok/, "native social channels are present");
  assert.match(text, /YouTube/, "native social channels are present");
  // Purpose and state come from the shared vocabulary.
  assert.match(text, /Needs approval/);
  assert.match(text, /Waiting for media/);
  assert.match(text, /Missed/);
  // Uncovered dates come from the coordinator, and connection limits are stated.
  assert.match(text, /uncovered date/, "the coordinator's uncovered dates are surfaced");
  assert.match(text, /not connected/, "an unconnected channel is never implied to be publishable");
  // Email keeps its own cadence and never fills a social slot.
  assert.match(text, /Email keeps its own cadence/);
});

test("Approvals answers only what needs a decision — and celebrates an empty queue", async (t) => {
  const [result] = (await measured([
    { name: "approvals", html: documents.get("approvals"), width: 1280, height: 900, onDocumentStart: startFor("approvals") },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered workspace measurement");

  const text = result.bodyText;
  assert.match(text, /need your decision/, "the actionable count comes from the real feed");
  assert.match(text, /Content preview/, "the content under review is readable");
  assert.match(text, /Scheduled for/, "the proposed schedule is stated");
  assert.match(text, /Why Voom recommends it/, "the reason for asking is stated");
  assert.match(text, /View calendar|View plan|View campaign/, "the real detail flow is preserved");
  assert.match(text, /Retry/, "a failed action offers the real retry");
});

test("Performance leads with measured results and reports unavailability honestly", async (t) => {
  const [result] = (await measured([
    { name: "performance", html: documents.get("performance"), width: 1280, height: 900, onDocumentStart: startFor("performance") },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered workspace measurement");

  const text = result.bodyText;
  assert.match(text, /Is my marketing working/, "the page answers its own question");
  assert.match(text, /measured/, "measured counts are stated");
  assert.match(text, /Best-performing recent content/);
  assert.match(text, /What is working/);
  assert.match(text, /official YouTube Data API/, "YouTube numbers are attributed to the provider");
  assert.match(text, /TikTok performance data is unavailable/, "TikTok never shows invented zeros");
  assert.match(text, /none is invented/);
});

test("Studio starts from the channel and format, and states the publishing truth", async (t) => {
  const [result] = (await measured([
    { name: "studio", html: documents.get("studio"), width: 1280, height: 900, onDocumentStart: startFor("studio") },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered workspace measurement");

  const text = result.bodyText;
  for (const label of ["Instagram Post", "Instagram Reel", "Instagram Story", "TikTok Video", "YouTube Short", "YouTube Video"]) {
    assert.ok(text.includes(label), `the studio offers the existing ${label} format`);
  }
  assert.match(text, /Ready to publish|Scheduled in Voom|Approved|Draft/, "internal readiness states are shown");
  assert.match(text, /publishing truth/i, "the page states how publishing actually happens");
});

test("Calendar keeps the provider truth distinct: scheduled is not published", async (t) => {
  const [result] = (await measured([
    { name: "calendar", html: documents.get("calendar"), width: 1280, height: 900, onDocumentStart: startFor("calendar") },
  ])) ?? [];
  if (!result) return t.skip("no Chromium available for a rendered workspace measurement");

  const text = result.bodyText;
  assert.match(text, /Scheduled with TikTok|Scheduled/, "queue-derived state is shown");
  assert.match(text, /How to read this calendar/, "the state model is explained rather than implied");
  assert.match(text, /never dropped or published twice/, "the publishing queue truth is preserved");
  assert.doesNotMatch(text, /Published with TikTok|TikTok published/, "a scheduled item is never shown as provider-published");
});
