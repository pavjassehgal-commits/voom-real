/**
 * Rendered-surface harness — REAL markup, REAL CSS, REAL engine.
 *
 * The shell suites historically asserted on source text because bare Node
 * cannot execute `.tsx`. That is not good enough for layout: a horizontal
 * overflow regression is invisible to string matching (the classes can all be
 * present and the page still be 509px wide inside a 354px viewport).
 *
 * This helper makes the actual surface renderable in a test:
 *
 *   1. MODULE RUNTIME — registers Node module hooks that resolve the `@/`
 *      alias + extensionless imports, transpile `.ts/.tsx` with the project's
 *      own TypeScript, and map `server-only` plus the Next.js *runtime*
 *      specifiers (`next/navigation`, `next/cache`, `next/headers`,
 *      `next/link`) onto inert test doubles. The components, providers and
 *      copy under test are the real ones — only the Next runtime is doubled,
 *      because it only exists inside a Next server/request.
 *   2. STYLES — compiles `app/globals.css` with the project's own
 *      `@tailwindcss/postcss` plugin, so the measurement uses the real design
 *      system output rather than a hand-written approximation.
 *   3. ENGINE — serves the document over loopback HTTP and measures it in a
 *      real headless Chromium over the DevTools Protocol (Node's built-in
 *      WebSocket; no test dependency, no browser download in package.json).
 *      The browser is taken from `VOOM_CHROMIUM_PATH` / `CHROME_PATH` /
 *      `CHROMIUM_PATH`, a system install, a cached copy, or — last resort —
 *      provisioned from the npm registry into the OS temp directory. When no
 *      browser can be obtained the harness raises RenderedSurfaceUnavailable
 *      and the test skips with the reason instead of pretending to pass.
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

export class RenderedSurfaceUnavailable extends Error {}

/* ──────────────────────────────────────────────────────────────
   1. Module runtime
   ────────────────────────────────────────────────────────────── */
const MODULE_DOUBLES = {
  "server-only": "data:text/javascript,export{}",
  "next/navigation": `data:text/javascript,${encodeURIComponent(`
    export const usePathname = () => "/app/today";
    export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} });
    export const useSearchParams = () => new URLSearchParams();
    export function redirect() {}
    export function notFound() { throw new Error("notFound"); }
  `)}`,
  "next/cache": `data:text/javascript,${encodeURIComponent(`
    export function revalidatePath() {}
    export function revalidateTag() {}
    export function unstable_cache(fn) { return fn; }
    export function unstable_noStore() {}
  `)}`,
  "next/headers": `data:text/javascript,${encodeURIComponent(`
    export async function cookies() { return { get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }; }
    export async function headers() { return new Headers(); }
    export async function draftMode() { return { isEnabled: false, enable() {}, disable() {} }; }
  `)}`,
  "next/link": pathToFileURL(path.join(ROOT, "tests/helpers/next-link.tsx")).href,
  "next/image": "data:text/javascript,export default function Image(){return null}",
  "next/font/google": `data:text/javascript,${encodeURIComponent(`
    const font = (options) => ({ variable: options?.variable ?? "--font-stub", className: options?.variable ?? "font-stub", style: { fontFamily: "system-ui" } });
    export const Bricolage_Grotesque = font;
    export const Public_Sans = font;
    export const IBM_Plex_Mono = font;
    export default font;
  `)}`,
};

const RESOLUTION_SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", "/index.tsx", "/index.ts", "/index.js"];

function resolveCandidate(base) {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

let runtimeRegistered = false;

if (!runtimeRegistered) {
  runtimeRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const doubled = MODULE_DOUBLES[specifier];
      if (doubled) return { url: doubled, shortCircuit: true };
      let base = null;
      if (specifier.startsWith("@/")) base = path.join(ROOT, specifier.slice(2));
      else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
        base = path.join(path.dirname(fileURLToPath(context.parentURL)), specifier);
      } else if (specifier.startsWith("file:")) base = fileURLToPath(specifier.split("?")[0]);
      if (base) {
        const resolved = resolveCandidate(base);
        if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      // Stylesheets are compiled separately by appCss().
      if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export{}", shortCircuit: true };
      if (url.startsWith("file:") && /\.(tsx|ts)$/.test(url)) {
        const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          fileName: fileURLToPath(url),
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            esModuleInterop: true,
            skipLibCheck: true,
          },
        });
        return { format: "module", source: outputText, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

/**
 * Imports a repository module (the REAL component, provider or library).
 * `path` is relative to the repository root, e.g. `components/voom/shell/AppShell.tsx`.
 */
export function importApp(relativePath) {
  return import(pathToFileURL(path.join(ROOT, relativePath)).href);
}

export const react = await import("react");
export const { renderToStaticMarkup } = await import("react-dom/server");

/* ──────────────────────────────────────────────────────────────
   2. Styles — the project's own Tailwind output
   ────────────────────────────────────────────────────────────── */
let cssCache = null;

export async function appCss() {
  if (cssCache) return cssCache;
  const postcss = (await import("postcss")).default;
  const tailwind = (await import("@tailwindcss/postcss")).default;
  const stylesheet = path.join(ROOT, "app/globals.css");
  const result = await postcss([tailwind()]).process(readFileSync(stylesheet, "utf8"), { from: stylesheet });
  cssCache = result.css;
  return cssCache;
}

/* ──────────────────────────────────────────────────────────────
   3. Browser — real headless Chromium over CDP
   ────────────────────────────────────────────────────────────── */
const BROWSER_CACHE = path.join(tmpdir(), "voom-rendered-browser");

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function systemBrowser() {
  return firstExecutable([
    process.env.VOOM_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    process.env.GOOGLE_CHROME_BIN,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]);
}

function cachedBrowser() {
  const executable = firstExecutable([
    path.join(BROWSER_CACHE, "chrome-linux", "chrome"),
    path.join(BROWSER_CACHE, "chromium"),
    path.join(tmpdir(), "chromium"),
  ]);
  if (!executable) return null;
  const libs = path.join(BROWSER_CACHE, "lib");
  return { executable, env: existsSync(libs) ? { LD_LIBRARY_PATH: libs } : {} };
}

/**
 * Last resort: the `@sparticuz/chromium` npm package ships a Chromium build
 * inside the tarball, so a sandbox that can reach the npm registry (but no
 * browser-download host) can still run these tests. Nothing is written inside
 * the repository, and nothing is added to package.json.
 */
function provisionBrowser() {
  if (process.env.VOOM_SKIP_BROWSER_PROVISION === "1") return null;
  mkdirSync(BROWSER_CACHE, { recursive: true });
  const install = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "@sparticuz/chromium"],
    { cwd: BROWSER_CACHE, encoding: "utf8", timeout: 300_000 },
  );
  if (install.status !== 0) return null;
  const packageRoot = path.join(BROWSER_CACHE, "node_modules", "@sparticuz", "chromium");
  if (!existsSync(packageRoot)) return null;
  const chromiumModule = spawnSync(
    process.execPath,
    ["-e", "import('@sparticuz/chromium').then((m) => m.default.executablePath()).then((p) => process.stdout.write(p))"],
    { cwd: BROWSER_CACHE, encoding: "utf8", timeout: 120_000 },
  );
  const executable = chromiumModule.stdout?.trim();
  if (!executable || !existsSync(executable)) return null;
  // The shared libraries Chromium needs on a minimal Linux image ship in the
  // same package as a brotli-compressed tarball.
  const libArchive = path.join(packageRoot, "bin", "al2023.tar.br");
  const libDir = path.join(BROWSER_CACHE, "lib");
  if (existsSync(libArchive) && !existsSync(libDir)) {
    mkdirSync(libDir, { recursive: true });
    spawnSync(process.execPath, [
      "-e",
      `const fs=require("fs"),z=require("zlib");fs.writeFileSync(${JSON.stringify(path.join(BROWSER_CACHE, "libs.tar"))}, z.brotliDecompressSync(fs.readFileSync(${JSON.stringify(libArchive)})));`,
    ], { timeout: 120_000 });
    spawnSync("tar", ["-xf", path.join(BROWSER_CACHE, "libs.tar"), "-C", BROWSER_CACHE], { timeout: 120_000 });
  }
  return cachedBrowser();
}

export function findBrowser() {
  const system = systemBrowser();
  if (system) return { executable: system, env: {} };
  const cached = cachedBrowser();
  if (cached) return cached;
  return provisionBrowser();
}

function launchBrowser(browser) {
  const profile = path.join(tmpdir(), `voom-chrome-profile-${process.pid}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    browser.executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--force-device-scale-factor=1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { env: { ...process.env, ...browser.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+/);
      if (match) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve({ child, wsUrl: match[0] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => reject(new RenderedSurfaceUnavailable(`browser exited early (${code}): ${output.slice(-400)}`)));
    setTimeout(() => reject(new RenderedSurfaceUnavailable(`browser did not start within 30s: ${output.slice(-400)}`)), 30_000).unref?.();
  });
}

/** Minimal DevTools Protocol client over Node's built-in WebSocket. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const client = {
      id: 0,
      pending: new Map(),
      listeners: new Map(),
      send(method, params = {}, sessionId) {
        const id = ++client.id;
        return new Promise((res, rej) => {
          client.pending.set(id, { res, rej });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(sessionId, handler) {
        const key = sessionId ?? "browser";
        client.listeners.set(key, [...(client.listeners.get(key) ?? []), handler]);
      },
    };
    socket.addEventListener("open", () => resolve(client));
    socket.addEventListener("error", () => reject(new RenderedSurfaceUnavailable("could not connect to the browser DevTools socket")));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = client.pending.get(message.id);
        if (!pending) return;
        client.pending.delete(message.id);
        if (message.error) pending.rej(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? "")})`));
        else pending.res(message.result);
        return;
      }
      for (const handler of client.listeners.get(message.sessionId ?? "browser") ?? []) handler(message);
    });
  });
}

let serverSequence = 0;

/** Serves every scenario document (plus a blank page for state seeding). */
function serveDocuments(documents) {
  const directory = path.join(tmpdir(), `voom-rendered-page-${process.pid}-${++serverSequence}`);
  mkdirSync(directory, { recursive: true });
  documents.forEach((html, index) => writeFileSync(path.join(directory, `page-${index}.html`), html));
  writeFileSync(path.join(directory, "blank.html"), "<!doctype html><html><body></body></html>");
  const server = createServer((request, response) => {
    const name = (request.url ?? "/").replace(/^\//, "").split("?")[0];
    const file = existsSync(path.join(directory, name)) ? name : "blank.html";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(readFileSync(path.join(directory, file)));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * Renders `html` (produced by renderToStaticMarkup of the real components) in a
 * real browser at a real viewport width and returns the measurement.
 *
 * Returns { innerWidth, bodyScrollWidth, documentScrollWidth, overflowing, evaluate }.
 * `evaluate` is an optional expression string evaluated in the page (its value
 * is returned); `beforeLoad` runs on the origin before the document loads, so
 * persisted state (localStorage) can be seeded the way a returning user has it.
 */
/**
 * Renders one or more documents in a REAL browser and returns their
 * measurements. Scenarios share a single browser process (and each gets its own
 * browser context, so persisted state never leaks between them).
 *
 * Scenario fields:
 *   html        the document to load
 *   width       viewport width in CSS pixels (default 354 — the reported case)
 *   height      viewport height in CSS pixels (default 900)
 *   evaluate    expression evaluated in the page after load; its value is returned
 *   beforeLoad  expression run on the origin BEFORE the document loads
 *               (used to seed persisted state, e.g. localStorage)
 *   screenshot  path to write a PNG of the loaded page to
 *
 * Each result is
 *   { name, innerWidth, bodyScrollWidth, documentScrollWidth, overflowing,
 *     overflowingCount, theme, themeAttribute, background, textColor, bodyText,
 *     consoleMessages, evaluate }
 * where `overflowing` lists every rendered element whose right edge sits outside
 * the viewport — i.e. the elements a user would have to scroll sideways to see.
 */
export async function measureRenderedPages(scenarios) {
  const browser = findBrowser();
  if (!browser) {
    throw new RenderedSurfaceUnavailable(
      "no Chromium available (set VOOM_CHROMIUM_PATH, or allow the harness to provision one from npm)",
    );
  }
  const { server, origin } = await serveDocuments(scenarios.map((scenario) => scenario.html));
  let launched = null;
  try {
    launched = await launchBrowser(browser);
    const client = await connect(launched.wsUrl);
    const results = [];
    for (const [index, scenario] of scenarios.entries()) {
      const { width = 354, height = 900 } = scenario;
      const { browserContextId } = await client.send("Target.createBrowserContext", { disposeOnDetach: true });
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
      const consoleMessages = [];
      try {
        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        client.on(sessionId, (message) => {
          if (message.method === "Runtime.consoleAPICalled") {
            consoleMessages.push({
              level: message.params.type,
              text: (message.params.args ?? []).map((argument) => argument.value ?? argument.description ?? argument.type).join(" "),
            });
          }
          if (message.method === "Runtime.exceptionThrown") {
            consoleMessages.push({
              level: "exception",
              text: message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception",
            });
          }
        });
        await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        if (scenario.onDocumentStart) {
          // Runs at document start of EVERY document in this scenario, so page
          // scripts (including the app's own hydration bundle) see it.
          await client.send("Page.addScriptToEvaluateOnNewDocument", { source: scenario.onDocumentStart }, sessionId);
        }
        if (scenario.beforeLoad) {
          const blankLoaded = new Promise((resolve) => client.on(sessionId, (message) => message.method === "Page.loadEventFired" && resolve()));
          await client.send("Page.navigate", { url: `${origin}/blank.html` }, sessionId);
          await blankLoaded;
          await client.send("Runtime.evaluate", { expression: scenario.beforeLoad, awaitPromise: true }, sessionId);
        }
        const loaded = new Promise((resolve) => client.on(sessionId, (message) => message.method === "Page.loadEventFired" && resolve()));
        await client.send("Page.navigate", { url: `${origin}/page-${index}.html` }, sessionId);
        await loaded;
        const measurement = await client.send(
          "Runtime.evaluate",
          {
            returnByValue: true,
            awaitPromise: true,
            expression: `(async () => {
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              // Let finite entry animations (the shell's fade-in) finish so a
              // screenshot shows the settled surface; looping animations are
              // ignored because they never end.
              const finite = (document.getAnimations?.() ?? []).filter((animation) => {
                const iterations = animation.effect?.getTiming?.().iterations;
                return iterations !== Infinity && animation.playState !== "finished";
              });
              await Promise.race([
                Promise.all(finite.map((animation) => animation.finished.catch(() => {}))),
                new Promise((resolve) => setTimeout(resolve, 1200)),
              ]);
              const overflowing = [...document.querySelectorAll("body *")]
                .filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width > 0 && rect.right > window.innerWidth + 1;
                })
                .map((element) => ({
                  tag: element.tagName.toLowerCase(),
                  className: typeof element.className === "string" ? element.className.trim().split(/\\s+/).slice(0, 4).join(".") : "",
                  right: Math.round(element.getBoundingClientRect().right),
                  width: Math.round(element.getBoundingClientRect().width),
                  text: (element.textContent ?? "").trim().slice(0, 80),
                }));
              return {
                innerWidth: window.innerWidth,
                bodyScrollWidth: document.body.scrollWidth,
                documentScrollWidth: document.documentElement.scrollWidth,
                overflowing: overflowing.slice(0, 12),
                overflowingCount: overflowing.length,
                theme: document.documentElement.dataset.theme ?? null,
                themeAttribute: document.documentElement.getAttribute("data-theme"),
                background: getComputedStyle(document.body).backgroundColor,
                textColor: getComputedStyle(document.body).color,
                bodyText: (document.body.innerText ?? "").slice(0, 6000),
                evaluate: ${scenario.evaluate ? `await (async () => (${scenario.evaluate}))()` : "null"},
              };
            })()`,
          },
          sessionId,
        );
        if (scenario.screenshot) {
          const shot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
          writeFileSync(scenario.screenshot, Buffer.from(shot.data, "base64"));
        }
        const evaluateError = measurement.exceptionDetails
          ? measurement.exceptionDetails.exception?.description ?? measurement.exceptionDetails.text
          : null;
        results.push({ name: scenario.name ?? null, ...measurement.result.value, evaluateError, consoleMessages });
      } finally {
        await client.send("Target.closeTarget", { targetId }).catch(() => {});
        await client.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
      }
    }
    return results;
  } finally {
    launched?.child.kill("SIGKILL");
    server.close();
  }
}

/** Single-scenario convenience wrapper. */
export async function measureRenderedPage(scenario) {
  const [result] = await measureRenderedPages([scenario]);
  return result;
}

/**
 * Wraps server-rendered markup in a document with the project's real compiled
 * stylesheet. Markup from the real root layout already contains `<html>`/`<body>`,
 * so the stylesheet is injected into it; any other markup is wrapped in the same
 * document shell the root layout produces.
 */
export async function documentFrom(markup) {
  const css = await appCss();
  if (markup.trimStart().startsWith("<html")) {
    // Function replacement: the stylesheet and markup contain `$` sequences
    // that a string replacement would interpret as replacement patterns.
    return `<!doctype html>${markup.replace(/<html([^>]*)>/, (_match, attributes) => `<html${attributes}><head><meta charset="utf-8"><style>${css}</style></head>`)}`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="min-h-full flex flex-col bg-bg text-text font-sans">${markup}</body></html>`;
}

/** Injects a client bundle (tests/helpers/client-bundle.mjs) before `</body>`. */
export function withClientBundle(documentHtml, bundle) {
  return documentHtml.replace("</body>", () => `<script>${bundle}</script></body>`);
}

export async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}
