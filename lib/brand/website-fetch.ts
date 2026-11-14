import "server-only";

/**
 * Brand Kit v2, slice 7: the website text fetch, with every guard.
 *
 * Every host is resolved and every address checked against `isPublicAddress`
 * before a request is sent, and again on every redirect (three at most, same
 * host only). The connection then goes to one of the addresses that passed
 * the check, never to a fresh lookup (`pinnedFetch`), so a host cannot change
 * its DNS answer between our check and the connection ("DNS rebinding";
 * closed 2026-11-07 after the Codex review of PR #111). Each request has a
 * 10 s cap and the body is cut at 2 MB. Only HTML is read. A plain Voom user
 * agent, no cookies, no JavaScript. robots.txt is obeyed; an unreachable
 * robots file counts as allowed.
 *
 * The fetch and the DNS lookup are injected so the Node suite drives this
 * with fakes; `pinnedFetch` itself is tested against a local server.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  checkWebsiteUrl, extractPage, isPublicAddress, pickFollowUpLinks, robotsAllows, WEBSITE_READ_LIMITS, WEBSITE_USER_AGENT,
  websiteSnapshotText, type WebsitePage, type WebsiteReadStatus, type WebsiteSnapshot,
} from "./website";

/** What one guarded GET asks for; the shape `fetch` takes, so a test's fake can be a plain `fetch`. */
export interface GuardedRequestInit {
  method: "GET";
  redirect: "manual";
  headers: Record<string, string>;
  signal: AbortSignal;
  credentials: "omit";
  cache: "no-store";
}

export interface WebsiteFetchDeps {
  /**
   * One GET to `url`, connecting only to one of `addresses` (the ones that
   * passed the public check). The Host header and the TLS name stay the URL's
   * hostname, so the site answers as itself.
   */
  fetch: (url: string, init: GuardedRequestInit, addresses: string[]) => Promise<Response>;
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

/**
 * A DNS lookup that answers only with the addresses we already checked. Node
 * calls it in two shapes: `{ all: true }` wants every address (the default
 * "try both families" connect), otherwise one address and its family.
 */
export function pinnedLookup(addresses: string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  return (_hostname, options, callback) => {
    if (!entries.length) { callback(Object.assign(new Error("no pinned address"), { code: "ENOTFOUND" }), "", 4); return; }
    if (options.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  };
}

function responseFrom(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (value !== undefined) headers.set(name, value);
  }
  // `Response` refuses a body on 204/205/304 and any status outside 200-599; a
  // site answering oddly must become a plain failure, never a thrown error.
  const status = message.statusCode ?? 0;
  if (status < 200 || status > 599) throw new WebsiteReadError("unreachable");
  const body = status === 204 || status === 205 || status === 304 ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>);
  return new Response(body, { status, statusText: message.statusMessage ?? "", headers });
}

/**
 * The default fetch: Node's own http/https request with the lookup pinned to
 * `addresses`. Redirects are never followed here (the caller re-checks them),
 * no cookies exist, and `init.signal` ends the request on the time cap. Each
 * request opens its own connection (`agent: false`): no kept-alive socket from
 * an earlier request is ever reused, so every connection went through the pin.
 */
export function pinnedFetch(url: string, init: GuardedRequestInit, addresses: string[]): Promise<Response> {
  const target = new URL(url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = request(target, { method: init.method, headers: init.headers, lookup: pinnedLookup(addresses), signal: init.signal, agent: false }, (message) => {
      try { resolve(responseFrom(message)); } catch (error) { message.resume(); reject(error); }
    });
    req.on("error", reject);
    req.end();
  });
}

const DEFAULT_DEPS: WebsiteFetchDeps = { fetch: pinnedFetch, resolve: defaultResolve, now: () => new Date() };

/** Refuses any host that resolves to a non-public address (or to nothing); returns the checked addresses. */
async function assertPublicHost(host: string, deps: WebsiteFetchDeps): Promise<string[]> {
  let addresses: string[];
  try { addresses = await deps.resolve(host); } catch { throw new WebsiteReadError("unreachable"); }
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new WebsiteReadError("refused");
  return addresses;
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
 * One guarded GET: public host, the connection pinned to the checked
 * addresses, manual redirects re-checked and limited to the same host, time
 * and size caps. Returns the final URL and the body for an HTML page; throws
 * WebsiteReadError otherwise.
 */
export async function fetchGuarded(start: URL, deps: WebsiteFetchDeps, accept: "html" | "text" = "html"): Promise<{ url: URL; body: string; status: number }> {
  let url = start;
  for (let hop = 0; hop <= WEBSITE_READ_LIMITS.redirects; hop++) {
    const addresses = await assertPublicHost(url.hostname, deps);
    let response: Response;
    try {
      response = await deps.fetch(url.href, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": WEBSITE_USER_AGENT, Accept: accept === "html" ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" : "text/plain,*/*;q=0.1" },
        signal: AbortSignal.timeout(WEBSITE_READ_LIMITS.requestMs),
        credentials: "omit",
        cache: "no-store",
      }, addresses);
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
