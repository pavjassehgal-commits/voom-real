import "server-only";

/**
 * Brand Kit v2, slice 7: one screenshot of the top of the homepage, for the
 * vision model to describe the site's look (colours, mood, style). The
 * screenshot is the fallback for sites built in JavaScript, whose text the
 * plain fetch cannot read.
 *
 * The browser is headless Chromium through puppeteer-core: the Chrome on the
 * developer's machine locally, the packaged `@sparticuz/chromium` in
 * production. EVERY request the page makes is intercepted and its host
 * resolved and checked against the same public-address rule as the text
 * fetch, so the page's own scripts cannot reach inside the server. 15 s cap,
 * a 1280 x 800 window, a JPEG of the first screen only. Nothing is stored.
 */
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { checkWebsiteUrl, isPublicAddress, WEBSITE_READ_LIMITS, WEBSITE_USER_AGENT } from "./website";

const LOCAL_CHROME_CANDIDATES = [
  process.env.VOOM_CHROMIUM_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;

/** Which Chromium to run: a local Chrome when one is installed, else the packaged one. */
export async function resolveBrowser(): Promise<{ executablePath: string; args: string[] }> {
  for (const candidate of LOCAL_CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return { executablePath: candidate, args: ["--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--no-first-run"] };
  }
  const chromium = (await import("@sparticuz/chromium")).default;
  return { executablePath: await chromium.executablePath(), args: chromium.args };
}

export type Resolver = (host: string) => Promise<string[]>;

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((record) => record.address);
}

/**
 * Whether one request the page makes may go out: http(s) on default ports to
 * a host that resolves only to public addresses. Inline data: and blob: URLs
 * never leave the browser and are allowed. One lookup per host per page.
 */
export async function allowBrowserRequest(url: string, resolve: Resolver, cache: Map<string, boolean>): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "about:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  const cached = cache.get(host);
  if (cached !== undefined) return cached;
  let allowed = false;
  try {
    const addresses = await resolve(host);
    allowed = addresses.length > 0 && addresses.every(isPublicAddress);
  } catch {
    allowed = false;
  }
  cache.set(host, allowed);
  return allowed;
}

/** A JPEG of the top of the homepage, or null when the page could not be shown. Never throws. */
export async function screenshotWebsite(rawUrl: string, resolve: Resolver = defaultResolve): Promise<Uint8Array | null> {
  const check = checkWebsiteUrl(rawUrl);
  if (!check.ok) return null;
  const puppeteer = (await import("puppeteer-core")).default;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    const { executablePath, args } = await resolveBrowser();
    browser = await puppeteer.launch({ executablePath, args, headless: true, timeout: 20_000 });
    const page = await browser.newPage();
    await page.setUserAgent(WEBSITE_USER_AGENT);
    await page.setViewport({ ...BROWSER_VIEWPORT });
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => null); });
    const cache = new Map<string, boolean>();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      // Video and audio never matter for the look and can hold a page open for a long time.
      if (request.resourceType() === "media") { request.abort("blockedbyclient").catch(() => null); return; }
      allowBrowserRequest(request.url(), resolve, cache)
        .then((ok) => (ok ? request.continue() : request.abort("blockedbyclient")))
        .catch(() => request.abort("failed").catch(() => null));
    });
    // The document and its first paint are enough for the look. Busy sites keep
    // loading scripts and trackers for a long time; waiting for all of that
    // timed out two tries in three on a real shop (2026-10-29), so the capture
    // goes ahead after the document is in, with a short settle for images.
    let response: Awaited<ReturnType<typeof page.goto>> = null;
    let timedOut = false;
    try {
      response = await page.goto(check.url.href, { waitUntil: "domcontentloaded", timeout: WEBSITE_READ_LIMITS.screenshotMs });
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
      timedOut = true;
    }
    if (response && !response.ok()) return null;
    if (!response && !timedOut) return null;
    await page.waitForNetworkIdle({ idleTime: 500, timeout: WEBSITE_READ_LIMITS.screenshotSettleMs }).catch(() => null);
    const jpeg = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
    return new Uint8Array(jpeg);
  } catch (error) {
    console.error("[brand-website] screenshot failed", { message: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    if (browser) await browser.close().catch(() => null);
  }
}
