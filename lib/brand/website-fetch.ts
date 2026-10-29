import "server-only";

/**
 * Brand Kit v2, slice 7: the website text fetch, with every guard.
 *
 * Every host is resolved and every address checked against `isPublicAddress`
 * before a request is sent, and again on every redirect (three at most, same
 * host only). Each request has a 10 s cap and the body is cut at 2 MB. Only
 * HTML is read. A plain Voom user agent, no cookies, no JavaScript.
 * robots.txt is obeyed; an unreachable robots file counts as allowed.
 *
 * `fetch` and the DNS lookup are injected so the Node suite drives this with
 * fakes. Known limit, recorded in DECISIONS: a host could change its DNS
 * answer between our check and the connection itself.
 */
import { lookup } from "node:dns/promises";
import {
  checkWebsiteUrl, extractPage, isPublicAddress, pickFollowUpLinks, robotsAllows, WEBSITE_READ_LIMITS, WEBSITE_USER_AGENT,
  websiteSnapshotText, type WebsitePage, type WebsiteReadStatus, type WebsiteSnapshot,
} from "./website";

export interface WebsiteFetchDeps {
  fetch: typeof fetch;
  /** Every address the host resolves to. */
  resolve: (host: string) => Promise<string[]>;
  now: () => Date;
}

export class WebsiteReadError extends Error {
  constructor(public readonly status: Exclude<WebsiteReadStatus, "ready" | "empty">) {
    super(status);
    this.name = "WebsiteReadError";
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((record) => record.address);
}

const DEFAULT_DEPS: WebsiteFetchDeps = { fetch: (input, init) => fetch(input, init), resolve: defaultResolve, now: () => new Date() };

/** Refuses any host that resolves to a non-public address (or to nothing). */
async function assertPublicHost(host: string, deps: WebsiteFetchDeps): Promise<void> {
  let addresses: string[];
  try { addresses = await deps.resolve(host); } catch { throw new WebsiteReadError("unreachable"); }
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new WebsiteReadError("refused");
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < WEBSITE_READ_LIMITS.bodyBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = WEBSITE_READ_LIMITS.bodyBytes - total;
    const kept = value.byteLength > room ? value.subarray(0, room) : value;
    chunks.push(kept);
    total += kept.byteLength;
  }
  try { await reader.cancel(); } catch { /* already done */ }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/**
 * One guarded GET: public host, manual redirects re-checked and limited to
 * the same host, time and size caps. Returns the final URL and the body for
 * an HTML page; throws WebsiteReadError otherwise.
 */
export async function fetchGuarded(start: URL, deps: WebsiteFetchDeps, accept: "html" | "text" = "html"): Promise<{ url: URL; body: string; status: number }> {
  let url = start;
  for (let hop = 0; hop <= WEBSITE_READ_LIMITS.redirects; hop++) {
    await assertPublicHost(url.hostname, deps);
    let response: Response;
    try {
      response = await deps.fetch(url.href, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": WEBSITE_USER_AGENT, Accept: accept === "html" ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" : "text/plain,*/*;q=0.1" },
        signal: AbortSignal.timeout(WEBSITE_READ_LIMITS.requestMs),
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new WebsiteReadError("unreachable");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop === WEBSITE_READ_LIMITS.redirects) throw new WebsiteReadError("unreachable");
      let next: URL;
      try { next = new URL(location, url); } catch { throw new WebsiteReadError("unreachable"); }
      const check = checkWebsiteUrl(next.href);
      if (!check.ok || check.url.hostname !== start.hostname) throw new WebsiteReadError("refused");
      url = check.url;
      continue;
    }
    if (!response.ok) throw new WebsiteReadError("unreachable");
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (accept === "html" && !type.includes("text/html") && !type.includes("application/xhtml")) throw new WebsiteReadError("not_html");
    return { url, body: await readBody(response), status: response.status };
  }
  throw new WebsiteReadError("unreachable");
}

/** robots.txt for the host, or "" when there is none / it cannot be read (= allowed). */
async function loadRobots(home: URL, deps: WebsiteFetchDeps): Promise<string> {
  try {
    const { body } = await fetchGuarded(new URL("/robots.txt", home.origin), deps, "text");
    return body.slice(0, 200_000);
  } catch {
    return "";
  }
}

/**
 * Reads the homepage and up to four follow-up pages. Never throws: the
 * snapshot's status says what happened, and "ready" means `text` is usable.
 */
export async function readWebsite(rawUrl: string, overrides: Partial<WebsiteFetchDeps> = {}): Promise<WebsiteSnapshot> {
  const deps: WebsiteFetchDeps = { ...DEFAULT_DEPS, ...overrides };
  const fetchedAt = deps.now().toISOString();
  const check = checkWebsiteUrl(rawUrl);
  const base = { url: rawUrl.trim(), finalUrl: rawUrl.trim(), fetchedAt, pages: [] as WebsitePage[], text: "" };
  if (!check.ok) return { ...base, status: "refused" };
  const home = check.url;
  base.url = home.href;
  base.finalUrl = home.href;
  try {
    const robots = await loadRobots(home, deps);
    if (!robotsAllows(robots, home.pathname || "/")) return { ...base, status: "blocked_by_robots" };
    const homepage = await fetchGuarded(home, deps);
    const pages: WebsitePage[] = [extractPage(homepage.body, homepage.url.href)];
    const finalHome = homepage.url;
    for (const href of pickFollowUpLinks(pages[0].links, finalHome)) {
      if (pages.length >= WEBSITE_READ_LIMITS.pages) break;
      let next: URL;
      try { next = new URL(href); } catch { continue; }
      if (!robotsAllows(robots, next.pathname)) continue;
      try {
        const page = await fetchGuarded(next, deps);
        pages.push(extractPage(page.body, page.url.href));
      } catch {
        // A follow-up that fails is simply skipped; the homepage is what matters.
      }
    }
    const text = websiteSnapshotText(pages);
    return { ...base, finalUrl: finalHome.href, pages, text, status: text.trim() ? "ready" : "empty" };
  } catch (error) {
    const status = error instanceof WebsiteReadError ? error.status : "unreachable";
    return { ...base, status };
  }
}
