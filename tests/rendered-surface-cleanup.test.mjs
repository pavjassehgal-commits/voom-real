/**
 * Regression: the rendered-surface harness must not leak temporary Chromium
 * profiles, page folders or browser processes.
 *
 * Before the fix every measurement left a `voom-chrome-profile-*` (20–150 MB)
 * and a `voom-rendered-page-*` folder behind; a full suite run added ~2 GB.
 * These tests check normal completion, a scenario that throws, a browser that
 * fails to launch, an abandoned (hung) run that hits a timeout, and that
 * folders belonging to other processes are never touched.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RenderedSurfaceUnavailable,
  TEMP_PREFIXES,
  findBrowser,
  measureRenderedPages,
  renderedSurfaceResources,
} from "./helpers/rendered-surface.mjs";

const PAGE = "<!doctype html><html><body><p>cleanup</p></body></html>";

/** Temp folders created by the given process (by its pid-scoped prefix). */
function leftovers(pid = process.pid) {
  const prefixes = Object.values(TEMP_PREFIXES).map((prefix) => `${prefix}${pid}-`);
  return readdirSync(tmpdir()).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
}

/** Chromium processes still running with one of this process's profiles. */
function liveChromium(pid = process.pid) {
  const result = spawnSync("pgrep", ["-f", `${TEMP_PREFIXES.profile}${pid}-`], { encoding: "utf8" });
  return result.stdout.trim().split("\n").filter(Boolean);
}

const browserAvailable = (() => {
  try {
    return Boolean(findBrowser());
  } catch {
    return false;
  }
})();

function assertClean(label) {
  assert.deepEqual(leftovers(), [], `${label}: no temp folders left behind`);
  assert.deepEqual(renderedSurfaceResources(), { browsers: 0, tempDirs: [] }, `${label}: nothing still owned`);
  assert.deepEqual(liveChromium(), [], `${label}: no browser process left running`);
}

test("normal completion: the browser exits and its profile and page folder are removed", { skip: !browserAvailable && "no Chromium available" }, async () => {
  const [result] = await measureRenderedPages([{ html: PAGE, evaluate: "document.querySelector('p').textContent" }]);
  assert.equal(result.evaluate, "cleanup", "the harness still measures normally");
  assertClean("success");
  // Repeated runs do not accumulate.
  await measureRenderedPages([{ html: PAGE }, { html: PAGE }]);
  await measureRenderedPages([{ html: PAGE }]);
  assertClean("repeated runs");
});

test("a scenario that throws still cleans up everything", { skip: !browserAvailable && "no Chromium available" }, async () => {
  const impossible = path.join(tmpdir(), "voom-cleanup-test-no-such-dir", "nested", "shot.png");
  await assert.rejects(() => measureRenderedPages([{ html: PAGE, screenshot: impossible }]), /ENOENT/);
  assertClean("thrown scenario");
});

test("a browser that fails to launch leaves no profile, page folder or process", async () => {
  const previous = process.env.VOOM_CHROMIUM_PATH;
  process.env.VOOM_CHROMIUM_PATH = "/usr/bin/false";
  try {
    await assert.rejects(() => measureRenderedPages([{ html: PAGE }]), RenderedSurfaceUnavailable);
  } finally {
    if (previous === undefined) delete process.env.VOOM_CHROMIUM_PATH;
    else process.env.VOOM_CHROMIUM_PATH = previous;
  }
  assertClean("failed launch");
});

test("folders of other processes are never touched", { skip: !browserAvailable && "no Chromium available" }, async () => {
  // Created by this test (as a stand-in for another run's folders) and removed by it.
  const foreign = [
    path.join(tmpdir(), `${TEMP_PREFIXES.profile}999999-foreign-cleanup-test`),
    path.join(tmpdir(), `${TEMP_PREFIXES.pages}999999-foreign-cleanup-test`),
  ];
  for (const directory of foreign) mkdirSync(directory, { recursive: true });
  try {
    await measureRenderedPages([{ html: PAGE }]);
    for (const directory of foreign) assert.ok(existsSync(directory), `${path.basename(directory)} is left alone`);
  } finally {
    for (const directory of foreign) rmSync(directory, { recursive: true, force: true });
  }
});

test("an abandoned run (a hung scenario hitting a timeout) is cleaned up when its process exits", { skip: !browserAvailable && "no Chromium available", timeout: 90_000 }, async () => {
  const helper = new URL("./helpers/rendered-surface.mjs", import.meta.url).href;
  // The child starts a measurement that never finishes, waits until the
  // browser is up, then exits the way a test runner does after a timeout.
  const script = `
    const h = await import(${JSON.stringify(helper)});
    h.measureRenderedPages([{ html: "<p>hang</p>", evaluate: "new Promise(() => {})" }]).catch(() => {});
    const started = Date.now();
    const timer = setInterval(() => {
      const owned = h.renderedSurfaceResources();
      if (owned.browsers > 0 && owned.tempDirs.length >= 2) { process.stdout.write("launched\\n"); setTimeout(() => process.exit(0), 500); clearInterval(timer); }
      if (Date.now() - started > 45000) process.exit(2);
    }, 100);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, `child launched a browser before being abandoned (${stdout.trim()})`);
  assert.match(stdout, /launched/);
  // Give the killed browser a moment to finish exiting.
  for (let attempt = 0; attempt < 30 && liveChromium(child.pid).length; attempt++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(liveChromium(child.pid), [], "the abandoned run's browser was killed");
  assert.deepEqual(leftovers(child.pid), [], "the abandoned run's profile and page folder were removed");
});
