/**
 * Final UI finishing pass: truthful unavailable states, readable errors, a
 * loading skeleton shaped like the real page, and compact mobile stat tiles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { importApp, react, renderToStaticMarkup } from "./helpers/rendered-surface.mjs";

const { createElement: h } = react;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Content that couldn't load shows unknown counts (—), never a false 0", async () => {
  const { ContentLibrary } = await importApp("components/voom/content/ContentLibrary.tsx");
  const { Providers } = await importApp("app/app/Providers.tsx");
  const render = (unavailable) => renderToStaticMarkup(h(Providers, { initialDisplayName: "Sam", initialEmail: "sam@example.com", initialBusiness: null },
    h(ContentLibrary, { initialTab: "all", items: [], limited: false, unavailable, performance: null })));
  const failed = render(true);
  assert.match(failed, /Content couldn’t load/);
  assert.equal((failed.match(/>—</g) ?? []).length >= 4, true, "all four stat cards show —");
  assert.doesNotMatch(failed, /leading-none[^"]*">0</, "no stat card claims 0");
  const empty = render(false);
  assert.match(empty, /leading-none[^"]*">0</, "a genuinely empty library still shows real zeros");
});

test("Settings names the stored automation mode, not its raw database value", async () => {
  const page = await read("app/app/(shell)/settings/page.tsx");
  assert.match(page, /value=\{automationMode \? AUTOMATION_MODE_LABELS\[automationMode\] : "Not set yet"\}/);
  assert.doesNotMatch(page, /value=\{brand\.auto \|\|/);
});

test("email sender errors use the light-safe red tokens, not dark-theme reds", async () => {
  const card = await read("components/voom/modals/EmailIdentityCard.tsx");
  assert.doesNotMatch(card, /red-950|text-red-300|red-900\//);
  assert.equal((card.match(/bg-\[var\(--red-soft\)\]/g) ?? []).length, 2);
});

test("the route skeleton uses the real card frame and PageHeader rhythm, with no content", async () => {
  const skeleton = await importApp("components/voom/workspace/WorkspaceSkeleton.tsx");
  const html = renderToStaticMarkup(h(skeleton.default));
  assert.match(html, /role="status"/);
  assert.match(html, /class="voom-card min-w-0 p-5"/);
  assert.match(html, /mb-6 flex flex-col gap-2/);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), /\d/, "no invented numbers");
});

test("four-card stat rows sit two per row on phones", async () => {
  for (const path of ["components/voom/content/ContentLibrary.tsx", "components/voom/mara/MaraOverview.tsx", "app/app/(shell)/automations/page.tsx", "components/voom/operating/PlanWorkspace.tsx"]) {
    assert.match(await read(path), /mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4/, path);
  }
  const ui = await read("components/voom/redesign/ui.tsx");
  assert.match(ui, /voom-card flex min-w-0 flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5/, "stacked tile on phones, side-by-side from sm");
});
