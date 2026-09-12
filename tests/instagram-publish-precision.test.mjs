/**
 * Regression suite for the production Instagram scheduling-precision incident.
 *
 * WHAT ACTUALLY HAPPENED
 *   scheduled 22:15:00 -> cron 22:15:00.164 -> claimed 22:15:02.413
 *   Meta container created and polled, initial polling budget expired
 *   retry eligibility written as 22:20:02.413   <-- now + 5 minutes
 *   cron ran at 22:20:00.171 -> the row was 2.242s short of due -> skipped
 *   next claim 22:25:00.493 -> published 22:25:19.801
 *
 * A two-second miss became a five-minute delay because the retry timestamp was
 * derived from the attempt clock instead of the worker's own cron cadence.
 *
 * This suite pins the corrected behaviour: retries land on the next cron
 * boundary, polling stays bounded by both an attempt budget and a shared
 * invocation deadline, the container is reused, nothing publishes twice, and
 * the existing 20-minute missed-schedule policy still wins.
 *
 * No Meta call is made anywhere: every provider interaction is a fake port.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const pub = await import("../lib/instagram/publishing.ts");
const { runPublishFlow } = await import("../lib/instagram/publish-flow.ts");
const { buildPublishTimelineRecord, PUBLISH_TIMELINE_PREFIX } = await import("../lib/instagram/publish-timeline.ts");
const workflow = await import("../lib/voom/workflow/state.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

// The production timeline, verbatim.
const DAY = "2026-09-11";
const SCHEDULED_AT = `${DAY}T22:15:00.000Z`;
const CRON_2215 = `${DAY}T22:15:00.164Z`;
const CLAIM_AT = `${DAY}T22:15:02.413Z`;
const CRON_2220 = `${DAY}T22:20:00.171Z`;
const CRON_2225 = `${DAY}T22:25:00.493Z`;
/** What the old `now + 5 * attempts minutes` formula wrote in production. */
const LEGACY_RETRY_AT = `${DAY}T22:20:02.413Z`;
/** Each Meta poll costs something; 300ms keeps the arithmetic realistic. */
const POLL_LATENCY_MS = 300;

// ---------------------------------------------------------------------------
// Harness: a virtual clock that the fake ports actually advance.
// ---------------------------------------------------------------------------

function harness(overrides = {}) {
  const start = overrides.startAt ? Date.parse(overrides.startAt) : Date.parse(CLAIM_AT);
  let clock = start;
  const events = [];
  const calls = { containers: [], publishes: [], published: [], failed: [], sleeps: [], signed: [] };
  const statuses = overrides.statuses ?? (() => "IN_PROGRESS");
  let pollCount = 0;

  const ports = {
    calls,
    events,
    now: () => clock,
    async loadDraft() { return { status: "approved", content: "Synrapay caption" }; },
    async loadConnection() {
      return { status: "connected", scopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: null };
    },
    async loadCredentials() { return { igUserId: "178414", accessToken: "SECRET-ACCESS-TOKEN" }; },
    async loadAsset() {
      return overrides.asset ?? { storagePath: `${OWNER}/post-assets/abc.jpg`, mimeType: "image/jpeg", status: "uploaded" };
    },
    async signMediaUrl(path) {
      calls.signed.push(path);
      return `https://storage.example/${path}?token=SIGNED-SECRET&expires=999`;
    },
    async createContainer(input) {
      events.push("createContainer");
      calls.containers.push(input);
      return `container-${calls.containers.length}`;
    },
    async containerStatus() {
      events.push("containerStatus");
      clock += POLL_LATENCY_MS;
      pollCount += 1;
      return statuses(pollCount);
    },
    async publishContainer(input) {
      events.push("publishContainer");
      calls.publishes.push(input);
      return "17999999";
    },
    async findPublishedMediaId() { return null; },
    async persistContainerId(item, containerId) {
      events.push("persistContainerId");
      item.containerId = containerId;
    },
    async markPublished(item, mediaId, containerId) {
      events.push("markPublished");
      calls.published.push({ mediaId, containerId });
      item.instagramMediaId = mediaId;
    },
    async markFailed(item, input) {
      events.push("markFailed");
      calls.failed.push(input);
    },
    async sleep(ms) {
      events.push("sleep");
      calls.sleeps.push(ms);
      clock += ms;
    },
    ...overrides.ports,
  };
  // The worker's real formula, driven by the same virtual clock the fake
  // provider calls advance: one deadline for the invocation, measured in
  // wall-clock time.
  if (overrides.budgetMs !== undefined) {
    const deadlineAt = start + overrides.budgetMs;
    ports.remainingBudgetMs = () => deadlineAt - clock;
  }
  return { ports, calls, events, now: () => clock, start };
}

const imageItem = (over = {}) => ({
  id: ITEM, ownerUserId: OWNER, draftId: DRAFT, mediaKind: "image",
  caption: "Synrapay caption", attempts: 1, containerId: null, instagramMediaId: null, ...over,
});

/** The queue row exactly as PostgreSQL holds it after a parked retry. */
const storedRow = (retryAtIso, attempts = 1) => ({
  status: "scheduled", scheduledAt: retryAtIso, draftStatus: "approved",
  attempts, instagramMediaId: null,
});

// ---------------------------------------------------------------------------
// 1. THE EXACT PRODUCTION FAILURE
// ---------------------------------------------------------------------------

test("PRODUCTION REGRESSION: a retry after a missed poll is claimable by the 22:20 cron, not 2.242s after it", async () => {
  const { ports, calls } = harness({ startAt: CLAIM_AT });
  const item = imageItem();

  // Meta never reports FINISHED inside this attempt's polling window.
  const outcome = await runPublishFlow(item, ports);
  assert.equal(outcome.outcome, "retrying");
  assert.equal(outcome.code, "container_timeout");
  assert.equal(calls.publishes.length, 0, "nothing may publish while Meta is still processing");

  const retryAtIso = calls.failed[0].retryAt;
  assert.ok(retryAtIso, "a retry time must be persisted");
  const attemptEndedAt = ports.now();
  assert.ok(attemptEndedAt > Date.parse(CLAIM_AT), "the attempt consumed real polling time");

  // The retry is on the 22:20 boundary (minus the one-second claim-skew margin),
  // NOT `attempt end + 5 minutes`.
  assert.equal(retryAtIso, `${DAY}T22:19:59.000Z`);
  assert.equal(pub.nextCronBoundaryAfter(Date.parse(retryAtIso)), Date.parse(`${DAY}T22:20:00.000Z`));

  // The cron run at 22:20:00.171 MUST claim it. This is the assertion that
  // failed in production.
  assert.equal(
    pub.isDueForPublishing(storedRow(retryAtIso), Date.parse(CRON_2220)),
    true,
    "the 22:20 cron must be able to claim the retried item",
  );

  // And the value production actually wrote would NOT have been claimable.
  assert.equal(
    pub.isDueForPublishing(storedRow(LEGACY_RETRY_AT), Date.parse(CRON_2220)),
    false,
    "the legacy `now + 5 minutes` timestamp is what made the 22:20 run skip the item",
  );
  // The old formula, applied to this very attempt, misses the tick even harder.
  const legacyFormula = new Date(attemptEndedAt + 5 * 60_000).toISOString();
  assert.equal(pub.isDueForPublishing(storedRow(legacyFormula), Date.parse(CRON_2220)), false);
});

test("PRODUCTION REGRESSION: the retry is not eligible before its own window, so it cannot loop", async () => {
  const { ports, calls } = harness({ startAt: CLAIM_AT });
  await runPublishFlow(imageItem(), ports);
  const retryAtIso = calls.failed[0].retryAt;
  const retryAtMs = Date.parse(retryAtIso);

  // The tick that already claimed this attempt must not see it as due again.
  assert.equal(pub.isDueForPublishing(storedRow(retryAtIso), Date.parse(CRON_2215)), false);
  // Nor anything between the attempt and the boundary.
  assert.equal(pub.isDueForPublishing(storedRow(retryAtIso), Date.parse(`${DAY}T22:16:00.000Z`)), false);
  assert.equal(pub.isDueForPublishing(storedRow(retryAtIso), retryAtMs - 1), false);
  assert.equal(pub.isDueForPublishing(storedRow(retryAtIso), retryAtMs), true);
});

// ---------------------------------------------------------------------------
// 2. THE HELPER, ON ITS OWN
// ---------------------------------------------------------------------------

test("cron boundaries are computed from absolute epoch time, not from a timezone", () => {
  assert.equal(pub.PUBLISH_WORKER_PERIOD_MS, 5 * 60_000);
  assert.equal(pub.nextCronBoundaryAfter(Date.parse(`${DAY}T22:15:17.000Z`)), Date.parse(`${DAY}T22:20:00.000Z`));
  assert.equal(pub.cronBoundaryAt(Date.parse(`${DAY}T22:20:00.000Z`)), Date.parse(`${DAY}T22:20:00.000Z`));
  // Every boundary is an exact multiple of the cadence since the epoch, which
  // is what makes the arithmetic correct in any timezone without reading one.
  for (const boundary of ["22:15:00", "22:20:00", "00:00:00", "13:05:00"]) {
    assert.equal(Date.parse(`${DAY}T${boundary}.000Z`) % pub.PUBLISH_WORKER_PERIOD_MS, 0);
  }
});

test("an attempt ending at 22:19:59 retries on the 22:20 boundary", () => {
  const now = Date.parse(`${DAY}T22:19:59.000Z`);
  const at = Date.parse(pub.retryAt(now));
  assert.equal(pub.nextCronBoundaryAfter(now), Date.parse(`${DAY}T22:20:00.000Z`));
  assert.equal(at, Date.parse(`${DAY}T22:20:00.000Z`), "inside the margin it takes the boundary itself");
  assert.equal(pub.isDueForPublishing(storedRow(pub.retryAt(now)), Date.parse(CRON_2220)), true);
});

test("an attempt ending exactly on a boundary retries on the NEXT boundary", () => {
  const now = Date.parse(`${DAY}T22:20:00.000Z`);
  const at = pub.retryAt(now);
  assert.equal(at, `${DAY}T22:24:59.000Z`);
  assert.equal(pub.isDueForPublishing(storedRow(at), Date.parse(CRON_2220)), false, "that tick is already gone");
  assert.equal(pub.isDueForPublishing(storedRow(at), Date.parse(CRON_2225)), true);
});

test("retry alignment survives UTC date, month, leap-day and year rollover", () => {
  const cases = [
    // [attempt ends, next boundary, retry becomes eligible]
    [`${DAY}T23:54:30.000Z`, `${DAY}T23:55:00.000Z`, `${DAY}T23:54:59.000Z`],
    [`${DAY}T23:56:30.000Z`, "2026-09-12T00:00:00.000Z", `${DAY}T23:59:59.000Z`],
    [`${DAY}T23:59:30.000Z`, "2026-09-12T00:00:00.000Z", `${DAY}T23:59:59.000Z`],
    ["2026-09-30T23:58:00.000Z", "2026-10-01T00:00:00.000Z", "2026-09-30T23:59:59.000Z"],
    ["2026-12-31T23:56:00.000Z", "2027-01-01T00:00:00.000Z", "2026-12-31T23:59:59.000Z"],
    ["2028-02-28T23:58:00.000Z", "2028-02-29T00:00:00.000Z", "2028-02-28T23:59:59.000Z"],
    // 19:57 UTC is 23:57 in Dubai: the same arithmetic, a different wall clock.
    [`${DAY}T19:57:00.000Z`, `${DAY}T20:00:00.000Z`, `${DAY}T19:59:59.000Z`],
  ];
  for (const [nowIso, boundaryIso, retryIso] of cases) {
    assert.equal(pub.nextCronBoundaryAfter(Date.parse(nowIso)), Date.parse(boundaryIso), `boundary after ${nowIso}`);
    assert.equal(pub.retryAt(Date.parse(nowIso)), retryIso, `retry after ${nowIso}`);
    assert.equal(pub.isDueForPublishing(storedRow(retryIso), Date.parse(boundaryIso) + 200), true, `claimable at the ${boundaryIso} tick`);
    assert.equal(pub.isDueForPublishing(storedRow(retryIso), Date.parse(boundaryIso) - 5_000), false, `not before it`);
  }
});

test("the same schedule yields the same boundaries in Dubai as in UTC", () => {
  // 22:15 in Asia/Dubai (+04:00, no DST) is 18:15 UTC.
  const dubaiNow = Date.parse("2026-09-11T18:15:17.000Z");
  const retryIso = pub.retryAt(dubaiNow);
  assert.equal(retryIso, "2026-09-11T18:19:59.000Z");
  const dubai = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai", hour12: false, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  assert.equal(dubai.format(new Date(retryIso)), "11/09/2026, 22:19:59");
  // A half-hour offset shifts the wall clock but never a 5-minute boundary.
  const kolkata = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });
  assert.equal(kolkata.format(new Date(retryIso)), "23:49");
  assert.equal(Date.parse(retryIso) % pub.PUBLISH_WORKER_PERIOD_MS, pub.PUBLISH_WORKER_PERIOD_MS - 1_000);
});

test("no retry is ever in the past, and none is ever more than one cadence away", () => {
  // Sweep every millisecond offset across two full cadences, including the
  // margin window either side of a boundary.
  const base = Date.parse(SCHEDULED_AT);
  for (let offset = 0; offset <= 2 * pub.PUBLISH_WORKER_PERIOD_MS; offset += 7) {
    const now = base + offset;
    const at = Date.parse(pub.retryAt(now));
    const boundary = pub.nextCronBoundaryAfter(now);
    assert.ok(at > now, `retry must be strictly after now (offset ${offset})`);
    assert.ok(at <= boundary, `retry must never pass its own boundary (offset ${offset})`);
    assert.ok(boundary - at <= pub.PUBLISH_RETRY_SAFETY_MARGIN_MS, "the margin is at most one second");
  }
});

test("the safety margin cannot eat a whole cadence, however small the period", () => {
  assert.equal(pub.retrySafetyMarginMs(), pub.PUBLISH_RETRY_SAFETY_MARGIN_MS);
  assert.equal(pub.retrySafetyMarginMs(1_000), 500);
  // A nonsensical period falls back to the worker cadence instead of dividing by zero.
  assert.equal(pub.cronBoundaryAt(Date.parse(CLAIM_AT), 0), pub.cronBoundaryAt(Date.parse(CLAIM_AT)));
});

// ---------------------------------------------------------------------------
// 3. BOUNDED IN-INVOCATION POLLING (audited against the real runtime ceiling)
// ---------------------------------------------------------------------------

test("the polling budget is derived from the cron route's real maxDuration", async () => {
  const route = await read("app/api/cron/instagram-publish/route.ts");
  const declared = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
  assert.ok(Number.isFinite(declared), "maxDuration must stay declared on the cron route");
  assert.equal(pub.PUBLISH_WORKER_MAX_DURATION_MS, declared * 1_000, "the budget constant must match the route");
  assert.equal(pub.PUBLISH_WORKER_SAFETY_BUFFER_MS, 60_000);
  assert.equal(
    pub.PUBLISH_POLLING_BUDGET_MS,
    pub.PUBLISH_WORKER_MAX_DURATION_MS - pub.PUBLISH_WORKER_SAFETY_BUFFER_MS,
  );
  assert.ok(pub.PUBLISH_POLLING_BUDGET_MS > 0);
});

test("one attempt's polling plus its worst-case final call fits inside the shared budget", () => {
  for (const video of [false, true]) {
    const plan = pub.pollingPlanFor(video);
    const worstCase = pub.pollingSleepBudgetMs(plan) + pub.PUBLISH_POLL_CALL_ALLOWANCE_MS;
    assert.ok(
      worstCase <= pub.PUBLISH_POLLING_BUDGET_MS,
      `${video ? "video" : "image"} worst case ${worstCase}ms must fit the ${pub.PUBLISH_POLLING_BUDGET_MS}ms budget`,
    );
    // The final poll is never followed by a sleep, so the sleep budget is
    // (attempts - 1) intervals, not `attempts`.
    assert.equal(pub.pollingSleepBudgetMs(plan), (plan.attempts - 1) * plan.intervalMs);
  }
  assert.ok(pub.REEL_POLL_ATTEMPTS > pub.IMAGE_POLL_ATTEMPTS);
});

test("polling was widened but only inside a hard, tested ceiling", () => {
  // Image Posts: 5 x 3s -> 10 x 3s. Reels and video Stories: 20 x 6s -> 28 x 6s.
  assert.equal(pub.IMAGE_POLL_ATTEMPTS, 10);
  assert.equal(pub.IMAGE_POLL_INTERVAL_MS, 3_000);
  assert.equal(pub.REEL_POLL_ATTEMPTS, 28);
  assert.equal(pub.REEL_POLL_INTERVAL_MS, 6_000);
  assert.equal(pub.pollingSleepBudgetMs(pub.pollingPlanFor(false)), 27_000);
  assert.equal(pub.pollingSleepBudgetMs(pub.pollingPlanFor(true)), 162_000);
});

test("polling stops when the shared invocation budget runs out, and never loops unbounded", async () => {
  // A budget too small for even one Instagram call: polling never starts.
  const starved = harness({ budgetMs: 5_000 });
  const starvedOutcome = await runPublishFlow(imageItem(), starved.ports);
  assert.equal(starvedOutcome.outcome, "retrying");
  assert.equal(starved.ports.events.filter((event) => event === "containerStatus").length, 0);
  assert.equal(starved.calls.sleeps.length, 0, "it must not start a wait it cannot finish");
  assert.ok(starved.calls.failed[0].retryAt, "and it still parks a cron-aligned retry");

  // A budget that runs out mid-attempt: polling stops well before the plan ends.
  const partial = harness({ budgetMs: 20_000 });
  await runPublishFlow(imageItem(), partial.ports);
  const partialPolls = partial.ports.events.filter((event) => event === "containerStatus").length;
  assert.equal(partialPolls, 2, `expected polling to stop at 2 polls, saw ${partialPolls}`);
  assert.ok(partialPolls < pub.IMAGE_POLL_ATTEMPTS, "the deadline, not the plan, ended the loop");

  // With no deadline the attempt's own plan is the only bound — and it holds.
  const roomy = harness();
  await runPublishFlow(imageItem(), roomy.ports);
  assert.equal(
    roomy.ports.events.filter((event) => event === "containerStatus").length,
    pub.IMAGE_POLL_ATTEMPTS,
  );
  assert.equal(roomy.calls.sleeps.length, pub.IMAGE_POLL_ATTEMPTS - 1, "no trailing sleep after the last poll");

  // And a Reel is bounded by its own plan too.
  const reel = harness({ asset: { storagePath: "reel.mp4", mimeType: "video/mp4", status: "uploaded" } });
  await runPublishFlow(imageItem({ mediaKind: "reel" }), reel.ports);
  assert.equal(reel.ports.events.filter((event) => event === "containerStatus").length, pub.REEL_POLL_ATTEMPTS);
  assert.equal(reel.calls.sleeps.length, pub.REEL_POLL_ATTEMPTS - 1);
});

test("the worker shares ONE deadline across the whole claimed batch", async () => {
  // publish-worker.ts pulls in lib/instagram/client.ts, whose TypeScript
  // parameter properties Node's strip-only loader cannot parse — the same
  // reason the existing publishing suites assert on worker source. The
  // deadline's *effect* on polling is proven behaviourally in the flow above.
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /const budgetMs = deps\.pollingBudgetMs \?\? PUBLISH_POLLING_BUDGET_MS/);
  assert.match(worker, /const deadlineAt = startedAt \+ budgetMs/);
  assert.match(worker, /const remainingBudgetMs = \(\) => deadlineAt - Date\.now\(\)/);
  // ONE deadline, computed once before the loop and passed to every item.
  assert.match(worker, /buildPorts\(db, client, config, sleep, \{ remainingBudgetMs, timeline \}\)/);
  assert.match(worker, /\.\.\.\(options\.remainingBudgetMs \? \{ remainingBudgetMs: options\.remainingBudgetMs \} : \{\}\)/);
  // The deadline is computed before claiming, so the claim itself is inside it.
  assert.ok(
    worker.indexOf("const deadlineAt") < worker.indexOf("await claimDueItems"),
    "the deadline must exist before any item is claimed",
  );
  assert.match(worker, /timeline\("claimed"/);
  assert.match(worker, /timeline\("run_started"/);
  assert.match(worker, /import \{\s*logPublishTimeline,/);
});

// ---------------------------------------------------------------------------
// 4. CONTAINER REUSE, NO DUPLICATE PUBLISH, PUBLISHED IS TERMINAL
// ---------------------------------------------------------------------------

test("a retried attempt reuses the persisted container and never creates a second one", async () => {
  const first = harness({ startAt: CLAIM_AT });
  const item = imageItem();
  const run1 = await runPublishFlow(item, first.ports);
  assert.equal(run1.outcome, "retrying");
  assert.equal(item.containerId, "container-1");
  assert.equal(first.calls.containers.length, 1);

  // The next cron tick: the row comes back with its container still attached.
  const second = harness({
    startAt: CRON_2220,
    statuses: () => "FINISHED",
  });
  const run2 = await runPublishFlow({ ...item, attempts: 2 }, second.ports);
  assert.equal(run2.outcome, "published");
  assert.equal(second.calls.containers.length, 0, "the container is resumed, never re-created");
  assert.equal(second.calls.publishes.length, 1);
  assert.equal(second.calls.publishes[0].containerId, "container-1");
  assert.equal(second.ports.events.includes("createContainer"), false);
});

test("the same media is never published twice, on retry or on a duplicate run", async () => {
  // `row` is the queue row as PostgreSQL holds it; the flow mutates it through
  // the same RPC ports production uses, so each attempt sees the persisted state.
  const row = imageItem();

  // Attempt 1 at 22:15: Meta still processing -> retry, nothing published.
  const first = harness({ startAt: CLAIM_AT });
  await runPublishFlow(row, first.ports);
  assert.equal(first.calls.publishes.length, 0);
  assert.equal(first.calls.published.length, 0);
  assert.equal(row.instagramMediaId, null);
  assert.equal(row.containerId, "container-1");

  // Attempt 2 at 22:20: the claim increments attempts, the container survives.
  row.attempts = 2;
  const second = harness({ startAt: CRON_2220, statuses: () => "FINISHED" });
  await runPublishFlow(row, second.ports);
  assert.equal(second.calls.publishes.length, 1);
  assert.equal(row.instagramMediaId, "17999999", "the media id Meta returned is persisted");

  // A third invocation would not even claim the row: the claim predicate
  // excludes anything that already has an Instagram media id.
  assert.equal(
    pub.isDueForPublishing(
      { ...storedRow(`${DAY}T22:19:59.000Z`, 2), instagramMediaId: row.instagramMediaId },
      Date.parse(CRON_2225),
    ),
    false,
    "a published row is never due again",
  );

  // And if one somehow ran anyway, the flow still publishes nothing.
  const third = harness({ startAt: CRON_2225, statuses: () => "FINISHED" });
  const run3 = await runPublishFlow(row, third.ports);
  assert.equal(run3.outcome, "published");
  assert.equal(
    first.calls.publishes.length + second.calls.publishes.length + third.calls.publishes.length,
    1,
    "media_publish runs exactly once, ever",
  );
  assert.equal(third.calls.containers.length + third.calls.published.length, 0);
});

test("published stays terminal: a published row is never re-claimed or re-published", async () => {
  const published = { ...imageItem(), instagramMediaId: "17999999" };
  assert.equal(pub.isDueForPublishing({ ...storedRow(SCHEDULED_AT), status: "published", instagramMediaId: "17999999" }, Date.parse(CRON_2220)), false);

  const { ports, calls, events } = harness({ startAt: CRON_2220 });
  const outcome = await runPublishFlow(published, ports);
  assert.equal(outcome.outcome, "published");
  assert.equal(outcome.mediaId, "17999999");
  assert.equal(calls.containers.length + calls.publishes.length + calls.published.length + calls.failed.length, 0);
  assert.deepEqual(events, [], "a published item touches nothing");

  // The database guard that backs this is still in place.
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /instagram_publish_already_published/);
  assert.match(sql, /if v_row\.status = 'published' then\s+return v_row;/);
});

// ---------------------------------------------------------------------------
// 5. PUBLISHING STAYS IMMEDIATE ON READINESS
// ---------------------------------------------------------------------------

test("media_publish fires in the same invocation the container becomes ready", async () => {
  const { ports, calls, events } = harness({
    startAt: CLAIM_AT,
    statuses: (poll) => (poll < 3 ? "IN_PROGRESS" : "FINISHED"),
  });
  const outcome = await runPublishFlow(imageItem(), ports);

  assert.equal(outcome.outcome, "published");
  assert.equal(outcome.mediaId, "17999999");
  assert.equal(calls.published.length, 1);
  assert.equal(calls.failed.length, 0, "no retry is parked once Meta confirms");
  // Ready on poll 3: two waits, then publish with no wait in between.
  assert.equal(calls.sleeps.length, 2);
  const readyIndex = events.lastIndexOf("containerStatus");
  assert.deepEqual(
    events.slice(readyIndex),
    ["containerStatus", "publishContainer", "markPublished"],
    "nothing may sit between readiness and media_publish",
  );
});

// ---------------------------------------------------------------------------
// 6. THE 20-MINUTE MISSED-SCHEDULE POLICY STILL WINS
// ---------------------------------------------------------------------------

test("the 20-minute late-media policy is untouched by the precision change", async () => {
  assert.equal(workflow.MISSED_GRACE_MINUTES, 20);
  const state = await read("lib/voom/workflow/state.ts");
  assert.match(state, /export const MISSED_GRACE_MINUTES = 20;/);
  const serverData = await read("lib/post/server-data.ts");
  assert.match(serverData, /value < Date\.now\(\) - 20 \* 60_000/);
  assert.match(serverData, /if \(isLateSchedule\(view\.scheduledAt\)\) \{\s+await cancelPublishItem/);
});

test("materially late content still derives Missed / Needs attention, never a silent late publish", () => {
  const late = new Date(Date.parse(SCHEDULED_AT) + 21 * 60_000);
  const facts = {
    draftStatus: "approved",
    hasMedia: true,
    mediaStatus: "completed",
    publishStatus: "scheduled",
    awaitingApproval: false,
    publishAt: SCHEDULED_AT,
    now: late,
  };
  assert.equal(workflow.deriveWorkflowStatus(facts), "missed");
  assert.equal(workflow.WORKFLOW_STATUS_LABELS.missed, "Missed scheduled time");
  assert.equal(workflow.WORKFLOW_STATUS_LABELS.failed, "Needs attention");
  assert.match(workflow.missedReason(facts), /schedule passed but publishing did not run/);
  // A withdrawn queue row on a late schedule is equally missed.
  assert.equal(workflow.deriveWorkflowStatus({ ...facts, publishStatus: "cancelled" }), "missed");
  // And 19 minutes late is still "late but live", so a retry can land.
  assert.equal(
    workflow.deriveWorkflowStatus({ ...facts, now: new Date(Date.parse(SCHEDULED_AT) + 19 * 60_000) }),
    "scheduled",
  );
});

test("the missed derivation reads the schedule, not the queue's retry timestamp", async () => {
  // publishAt is mara_drafts.proposed_publish_at. The retry timestamp written
  // into instagram_publish_queue.scheduled_at never moves the missed clock, so
  // aligning retries cannot quietly re-open an hours-late publish.
  const readModel = await read("lib/voom/workflow/read.ts");
  assert.match(readModel, /const publishAt = String\(row\.proposed_publish_at \?\? ""\)/);
  const late = new Date(Date.parse(SCHEDULED_AT) + 6 * 60 * 60_000);
  assert.equal(
    workflow.deriveWorkflowStatus({
      draftStatus: "approved", hasMedia: true, mediaStatus: "completed",
      publishStatus: "scheduled", awaitingApproval: false,
      publishAt: SCHEDULED_AT, now: late,
    }),
    "missed",
    "six hours later this is Missed even though the queue row has a fresh retry time",
  );
});

test("the aligned retry chain fits inside the 20-minute policy; the old backoff did not", () => {
  const scheduledAt = Date.parse(SCHEDULED_AT);
  const tickOffset = 171; // cron fires fractionally after the boundary
  // The tick that claims a parked retry is the first boundary at or after it.
  const claimTick = (retryMs) =>
    Math.ceil(retryMs / pub.PUBLISH_WORKER_PERIOD_MS) * pub.PUBLISH_WORKER_PERIOD_MS + tickOffset;

  // New: exactly one cadence per attempt, five attempts.
  let aligned = scheduledAt + tickOffset;
  for (let attempt = 1; attempt < pub.MAX_PUBLISH_ATTEMPTS; attempt++) {
    aligned = claimTick(Date.parse(pub.retryAt(aligned)));
  }
  const alignedSpan = aligned - scheduledAt;
  assert.equal(aligned - (scheduledAt + tickOffset), 4 * pub.PUBLISH_WORKER_PERIOD_MS, "four cadences, no more");
  assert.ok(
    Math.abs(alignedSpan - workflow.MISSED_GRACE_MINUTES * 60_000) <= 1_000,
    `the final attempt lands on the 20-minute boundary, got +${alignedSpan}ms`,
  );

  // Old: `now + 5 * attempts minutes`, which is what production ran.
  const legacyRetry = (attempts, now) => now + Math.min(60, 5 * Math.max(attempts, 1)) * 60_000;
  let legacy = scheduledAt + tickOffset;
  for (let attempt = 1; attempt < pub.MAX_PUBLISH_ATTEMPTS; attempt++) {
    legacy = legacyRetry(attempt, legacy) + tickOffset;
  }
  assert.ok(
    legacy - scheduledAt > workflow.MISSED_GRACE_MINUTES * 60_000,
    "the old backoff kept retrying long after the item should have shown as missed",
  );
});

// ---------------------------------------------------------------------------
// 7. TIMELINE DIAGNOSTICS
// ---------------------------------------------------------------------------

function captureTimeline() {
  const lines = [];
  const original = console.info;
  console.info = (...args) => lines.push(args);
  return {
    lines,
    restore: () => { console.info = original; },
    records: () => lines.map((line) => line[1]),
  };
}

test("the worker logs the timeline events needed to reconstruct an incident", async () => {
  const captured = captureTimeline();
  const { logPublishTimeline } = await import("../lib/instagram/publish-timeline.ts");
  try {
    const events = [];
    const harnessPorts = harness({
      startAt: CLAIM_AT,
      statuses: (poll) => (poll < 2 ? "IN_PROGRESS" : "FINISHED"),
      ports: { timeline: (event, input) => { events.push(event); logPublishTimeline(event, input); } },
    });
    await runPublishFlow(imageItem(), harnessPorts.ports);

    for (const event of ["container_created", "poll", "container_ready", "publish_requested", "media_id_received", "marked_published"]) {
      assert.ok(events.includes(event), `missing timeline event: ${event}`);
    }
    assert.equal(events.filter((event) => event === "poll").length, 2, "one poll line per readiness cycle");
    assert.ok(captured.lines.every((line) => line[0] === PUBLISH_TIMELINE_PREFIX));
    const published = captured.records().find((record) => record.event === "marked_published");
    assert.equal(published.mediaId, "17999999");
    assert.equal(published.itemId, ITEM);
  } finally {
    captured.restore();
  }
});

test("polling exhaustion and the parked retry are both logged", async () => {
  const events = [];
  const { ports } = harness({
    startAt: CLAIM_AT,
    ports: { timeline: (event, input) => events.push([event, input]) },
  });
  await runPublishFlow(imageItem(), ports);

  const names = events.map(([event]) => event);
  assert.ok(names.includes("polling_exhausted"));
  const retry = events.find(([event]) => event === "retry_scheduled");
  assert.ok(retry, "a parked retry must be logged");
  assert.equal(retry[1].retryAt, `${DAY}T22:19:59.000Z`, "the log line carries the exact retry instant");
  assert.equal(retry[1].code, "container_timeout");
  const exhausted = events.find(([event]) => event === "polling_exhausted");
  assert.equal(exhausted[1].polls, pub.IMAGE_POLL_ATTEMPTS);
});

test("timeline records cannot carry a secret, a signed URL, a caption or a storage path", () => {
  const hostile = {
    itemId: ITEM, ownerUserId: OWNER, draftId: DRAFT, mediaKind: "image", attempt: 1,
    containerId: "container-1", instagramMediaId: "17999999",
    // None of these have a field, so none of them may survive.
    accessToken: "SECRET-ACCESS-TOKEN",
    signedUrl: "https://storage.example/secret.jpg?token=SIGNED-SECRET",
    mediaUrl: "https://storage.example/secret.jpg?token=SIGNED-SECRET",
    storagePath: `${OWNER}/post-assets/abc.jpg`,
    caption: "Synrapay caption",
    authorization: "Bearer SECRET-ACCESS-TOKEN",
  };
  const serialized = JSON.stringify(buildPublishTimelineRecord("marked_published", hostile, Date.parse(CLAIM_AT)));
  for (const forbidden of ["SECRET-ACCESS-TOKEN", "SIGNED-SECRET", "https://", "storage.example", "post-assets", "Synrapay", "Bearer"]) {
    assert.ok(!serialized.includes(forbidden), `timeline record leaked ${forbidden}: ${serialized}`);
  }
  const record = buildPublishTimelineRecord("marked_published", hostile, Date.parse(CLAIM_AT));
  assert.equal(record.event, "marked_published");
  assert.equal(record.mediaId, "17999999");
  assert.equal(Object.keys(record).length, 16);
});

test("malformed diagnostic fields are dropped rather than logged", () => {
  const record = buildPublishTimelineRecord("poll", {
    itemId: "not-a-uuid",
    ownerUserId: OWNER,
    containerId: "https://evil.example/x?token=1",
    containerStatus: "IN_PROGRESS",
    mediaKind: "not-a-kind",
    poll: -3,
    elapsedMs: Number.NaN,
    budgetMs: 12_000.6,
    retryAt: "yesterday",
    code: "container_timeout",
  }, Date.parse(CLAIM_AT));
  assert.equal(record.itemId, null);
  assert.equal(record.containerId, null, "a URL is never a container id");
  assert.equal(record.mediaKind, null);
  assert.equal(record.poll, null);
  assert.equal(record.elapsedMs, null);
  assert.equal(record.retryAt, null);
  assert.equal(record.ownerUserId, OWNER);
  assert.equal(record.containerStatus, "IN_PROGRESS");
  assert.equal(record.budgetMs, 12_001);
  assert.equal(record.code, "container_timeout");
  assert.equal(record.at, CLAIM_AT);
});

test("diagnostics are application logs, not permanent database rows", async () => {
  const timeline = await read("lib/instagram/publish-timeline.ts");
  assert.match(timeline, /console\.info\(PUBLISH_TIMELINE_PREFIX/);
  assert.doesNotMatch(timeline, /\.from\(|\.rpc\(|\.insert\(|import "server-only"/);
  // Every poll is bounded by the attempt's poll plan, so the log cannot grow
  // without bound in one invocation.
  assert.match(timeline, /REEL_POLL_ATTEMPTS poll events/);
  // No new table, column or migration was introduced for diagnostics.
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /logPublishTimeline/);
  assert.doesNotMatch(worker, /publish_timeline|timeline_events/);
});
