import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  RenderedSurfaceUnavailable,
  documentFrom,
  importApp,
  measureRenderedPages,
  react,
  renderToStaticMarkup,
} from "./helpers/rendered-surface.mjs";

const { createElement: h } = react;
const { buildTodayView } = await import("../lib/voom/today-view.ts");

const item = (overrides = {}) => ({
  draftId: "draft-1", slotDate: "2026-09-24", localDate: "2026-09-24", status: "scheduled",
  channelLabel: "Instagram", contentTypeLabel: "Reel", concept: "A real scheduled Reel", localTime: "6:30 PM",
  dayLabel: "Today", mediaPreviewUrl: null, statusLabel: "Scheduled", ...overrides,
});

const summary = (overrides = {}) => ({
  needsApproval: [], waitingForMedia: [], failed: [], missed: [], next: item(), ...overrides,
});

test("Today coverage is projected from the existing seven-day workflow and coordinator gaps", () => {
  const items = [0, 2, 4, 6].map((offset) => item({
    draftId: `draft-${offset}`,
    slotDate: `2026-09-${24 + offset}`,
    localDate: `2026-09-${24 + offset}`,
    channelLabel: offset % 4 ? "TikTok" : "YouTube",
  }));
  const view = buildTodayView(
    { today: "2026-09-24", planValidUntil: "2026-09-30", items },
    summary(),
    { gaps: [], needs: [] },
  );
  assert.equal(view.coverage.state, "covered");
  assert.match(view.coverage.title, /covered through 30 September/);
  assert.equal(view.days.length, 7);
  assert.deepEqual(view.days.filter((day) => day.covered).map((day) => day.date), ["2026-09-24", "2026-09-26", "2026-09-28", "2026-09-30"]);
  assert.deepEqual(view.days.filter((day) => day.covered).map((day) => day.items[0].channelLabel), ["YouTube", "TikTok", "YouTube", "TikTok"]);
});

test("Today never claims coverage when the authoritative coordinator reports gaps", () => {
  const view = buildTodayView(
    { today: "2026-09-24", planValidUntil: "2026-09-30", items: [item()] },
    summary(),
    { gaps: [{ date: "2026-09-28" }], needs: [] },
  );
  assert.equal(view.coverage.state, "gaps");
  assert.match(view.coverage.title, /1 marketing slot needs coverage/);
});

test("weekly coverage includes existing cross-channel coordinator commitments without duplicating plan drafts", () => {
  const planItem = item({ draftId: "shared", slotDate: "2026-09-24", localDate: "2026-09-24" });
  const view = buildTodayView(
    { today: "2026-09-24", planValidUntil: "2026-09-30", items: [planItem] },
    summary({ next: null }),
    {
      gaps: [], needs: [],
      state: { commitments: [
        { id: "same", sourceId: "shared", channel: "instagram_reel", title: "Same plan item", localDate: "2026-09-24", localTime: "6:30 PM", status: "scheduled" },
        { id: "tt", sourceId: "standalone-tiktok", channel: "tiktok_video", title: "TikTok launch", localDate: "2026-09-26", localTime: "7:15 PM", status: "scheduled" },
      ] },
    },
  );
  assert.equal(view.days[0].items.length, 1, "the same plan commitment is never counted twice");
  assert.equal(view.days[2].items[0].channelLabel, "TikTok");
  assert.equal(view.next?.concept, "TikTok launch", "standalone scheduled work can truthfully become Next Up");
});

test("Next Up and Needs You use existing workflow status without invented work", () => {
  const next = item({ concept: "Provider-owned next item", channelLabel: "YouTube", contentTypeLabel: "Short" });
  const actionable = buildTodayView(
    { today: "2026-09-24", planValidUntil: null, items: [next] },
    summary({ next, needsApproval: [item({ status: "needs_approval" })] }),
    null,
  );
  assert.equal(actionable.next, next);
  assert.equal(actionable.attention.state, "action");
  assert.match(actionable.attention.title, /1 item needs your approval/);

  const clear = buildTodayView(
    { today: "2026-09-24", planValidUntil: null, items: [next] }, summary({ next }), null,
  );
  assert.equal(clear.attention.state, "clear");
  assert.equal(clear.attention.title, "You’re all caught up.");
});

test("MARA insight is real coordinator output or a neutral empty state", () => {
  const real = buildTodayView(
    { today: "2026-09-24", planValidUntil: null, items: [] }, summary({ next: null }),
    { gaps: [], needs: [{ type: "performance_learning_available", title: "Measured pattern", description: "Reels performed better." }] },
  );
  assert.equal(real.coordinatorInsight?.title, "Measured pattern");
  const empty = buildTodayView({ today: "2026-09-24", planValidUntil: null, items: [] }, summary({ next: null }), null);
  assert.equal(empty.coordinatorInsight, null);
});

test("Today V2 uses real performance state and removes the operational counter graveyard", async () => {
  const [page, dashboard, operatingData] = await Promise.all([
    readFile(new URL("../app/app/(shell)/today/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/voom/today/TodayDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/voom/operating-data.ts", import.meta.url), "utf8"),
  ]);
  // The real performance read model backs Today: loaded once per request by
  // the shared operating read and awaited by the page.
  assert.match(operatingData, /loadPerformanceReport/);
  assert.match(page, /await data\.performance/);
  assert.match(page, /buildTodayView\(data\.snapshot, data\.summary, data\.coordinator\)/);
  assert.match(dashboard, /Performance is learning/);
  assert.doesNotMatch(page + dashboard, /0 generating|0 waiting for media|0 missed|Stat label=/i);
  assert.doesNotMatch(page + dashboard, /Ask MARA|input.*MARA/i);
});

test("Today server rendering never calls a helper across a client-module boundary", async () => {
  const [dashboard, primitives, serverSafeCx] = await Promise.all([
    readFile(new URL("../components/voom/today/TodayDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/voom/ui/primitives.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/voom/cx.ts", import.meta.url), "utf8"),
  ]);

  assert.match(primitives, /^"use client";/, "shared UI primitives remain a client module");
  assert.doesNotMatch(
    dashboard,
    /import\s*\{[^}]*\bcx\b[^}]*\}\s*from\s*["']@\/components\/voom\/ui\/primitives["']/s,
    "a server-rendered Today component must not invoke cx through Next's client proxy",
  );
  assert.match(dashboard, /import\s*\{\s*cx\s*\}\s*from\s*["']@\/lib\/voom\/cx["']/);
  assert.doesNotMatch(serverSafeCx, /["']use client["']/);
});

test("mobile priority is notices, Next Up, week, engagement, performance, then MARA", async () => {
  const dashboard = await readFile(new URL("../components/voom/today/TodayDashboard.tsx", import.meta.url), "utf8");
  // Notices (coverage + Needs You) render above the card grid.
  assert.ok(dashboard.indexOf("<Notices view={view} />") < dashboard.indexOf("<NextUpCard"), "coverage/attention notices come first");
  // Inside the grid the reference's desktop columns are kept in source order;
  // the single-column (mobile) priority is set explicitly with `order-*`.
  const orderOf = (component) => {
    const match = dashboard.match(new RegExp(`order-(\\d)[^"]*"><${component}`));
    assert.ok(match, `${component} has an explicit mobile order`);
    return Number(match[1]);
  };
  const order = ["NextUpCard", "WeekCard", "EngagementCard", "PerformanceCard", "MaraCard", "ChannelsCard", "RecentCard"];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(orderOf(order[index - 1]) < orderOf(order[index]), `${order[index - 1]} must precede ${order[index]} on mobile`);
  }
});

test("Today V2 has zero horizontal overflow at all required mobile widths", async (t) => {
  const component = await importApp("components/voom/today/TodayDashboard.tsx");
  const { buildTodayMetrics } = await import("../lib/voom/today-metrics.ts");
  const workflow = item({ caption: "A long caption that wraps across several lines to prove the Next Up card stays inside narrow mobile widths #launch #voom" });
  const now = new Date("2026-09-24T12:00:00Z");
  const props = {
    firstName: "Alexandria", greeting: "Good morning", dateLabel: "Thursday, 24 Sept 2026", weekNumber: 39,
    view: buildTodayView(
      { today: "2026-09-24", planValidUntil: "2026-09-30", items: [workflow, item({ draftId: "draft-2", concept: "Second item with a much longer concept title", channelLabel: "TikTok" })] },
      summary({ next: workflow, needsApproval: [item({ status: "needs_approval" })] }),
      { gaps: [{ date: "2026-09-27" }], needs: [] },
    ),
    performance: { headline: null, measuredItems: 0, trend: null },
    metrics: buildTodayMetrics([
      { draftId: "draft-1", publishedAt: "2026-09-23T10:00:00Z", interactions: 18400, metrics: { reach: 24100, views: 31000 } },
      { draftId: null, publishedAt: "2026-09-15T10:00:00Z", interactions: 14300, metrics: { reach: 19000 } },
    ], now, "Asia/Dubai"),
    ideas: [{ draftId: "draft-9", concept: "Customer story carousel with a long working title", contentType: "post", channel: "instagram" }],
    ideaCount: 1,
    channels: [
      { id: "instagram", name: "Instagram", href: "/app/instagram", state: "connected" },
      { id: "tiktok", name: "TikTok", href: "/app/tiktok", state: "not_connected" },
      { id: "youtube", name: "YouTube", href: "/app/youtube", state: "unavailable" },
      { id: "email", name: "Email", href: "/app/connections", state: "ready" },
    ],
    automationMode: "manual",
    recent: [{ draftId: "draft-1", concept: "A real scheduled Reel with a long name", channel: "instagram", channelLabel: "Instagram", contentTypeLabel: "Reel", when: "Today, 6:30 PM", status: "published", statusLabel: "Published", mediaPreviewUrl: null, stats: { likes: 2400, comments: 120, shares: 24 } }],
  };
  // Quick create opens the real Create modal, so Today renders inside the real
  // app providers exactly as it does under the shell.
  const { Providers } = await importApp("app/app/Providers.tsx");
  const { businessRecord } = await importApp("tests/helpers/shell-surface.tsx");
  const html = await documentFrom(renderToStaticMarkup(h(Providers, { initialDisplayName: "Alexandria", initialEmail: "alex@example.com", initialBusiness: businessRecord() },
    h("div", { className: "voom-shell min-h-screen bg-bg p-3 text-text" }, h(component.TodayDashboard, props)))));
  let results;
  try {
    results = await measureRenderedPages([320, 354, 390, 430].map((width) => ({ name: `${width}px`, width, height: 920, html })));
  } catch (error) {
    if (error instanceof RenderedSurfaceUnavailable) return t.skip("no Chromium available for rendered Today V2 layout measurement");
    throw error;
  }
  for (const result of results) {
    assert.ok(result.bodyScrollWidth <= result.innerWidth, `${result.name} body overflowed: ${result.bodyScrollWidth} > ${result.innerWidth}`);
    assert.ok(result.documentScrollWidth <= result.innerWidth, `${result.name} document overflowed`);
    const contentOverflow = result.overflowing.filter((entry) => !/today-(spectrum|aurora|insight-glow)/.test(entry.className));
    assert.deepEqual(contentOverflow, [], `${result.name} content overflowed: ${JSON.stringify(contentOverflow)}`);
  }
});

test("Today engagement figures are sums of real measurements, never estimates", async () => {
  const { buildTodayMetrics, compactNumber } = await import("../lib/voom/today-metrics.ts");
  const now = new Date("2026-09-24T12:00:00Z");
  const metrics = buildTodayMetrics([
    { draftId: "a", publishedAt: "2026-09-23T10:00:00Z", interactions: 1000, metrics: { reach: 4000 } },
    { draftId: "b", publishedAt: "2026-09-21T10:00:00Z", interactions: 500, metrics: {} },
    { draftId: "c", publishedAt: "2026-09-20T10:00:00Z", interactions: null, metrics: { reach: 100 } },
    { draftId: "d", publishedAt: "2026-09-14T10:00:00Z", interactions: 1200, metrics: { reach: 9000 } },
    { draftId: "e", publishedAt: "2026-09-01T10:00:00Z", interactions: 9999, metrics: {} },
  ], now, "Asia/Dubai");
  assert.equal(metrics.engagement, 1500, "only posts published in the last 7 days, unmeasured posts excluded");
  assert.equal(metrics.reach, 4100);
  assert.equal(metrics.views, null, "a metric nobody measured is null, not zero");
  assert.equal(metrics.measuredPosts, 2);
  assert.equal(metrics.engagementChangePct, 25, "same definition vs the previous 7 days");
  assert.equal(metrics.daily.length, 7);
  assert.equal(metrics.daily.reduce((sum, day) => sum + day.value, 0), 1500);

  const empty = buildTodayMetrics([], now, "Asia/Dubai");
  assert.equal(empty.engagement, null);
  assert.equal(empty.engagementChangePct, null, "no comparison without measured posts in both periods");
  assert.equal(compactNumber(18400), "18.4K");
  assert.equal(compactNumber(24000), "24K");
  assert.equal(compactNumber(950), "950");
});
