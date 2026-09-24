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
  const [page, dashboard] = await Promise.all([
    readFile(new URL("../app/app/(shell)/today/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/voom/today/TodayDashboard.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /loadPerformanceReport/);
  assert.match(page, /buildTodayView\(data\.snapshot, data\.summary, data\.coordinator\)/);
  assert.match(dashboard, /Performance is learning/);
  assert.doesNotMatch(page + dashboard, /0 generating|0 waiting for media|0 missed|Stat label=/i);
  assert.doesNotMatch(page + dashboard, /Ask MARA|input.*MARA/i);
});

test("mobile priority is coverage, Needs You, Next Up, week, performance, then MARA", async () => {
  const dashboard = await readFile(new URL("../components/voom/today/TodayDashboard.tsx", import.meta.url), "utf8");
  const order = ["view.coverage.title", "<AttentionCard", "<NextUpCard", "<CoverageCard", "<PerformanceCard", "<MaraInsightCard"];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(dashboard.indexOf(order[index - 1]) < dashboard.indexOf(order[index]), `${order[index - 1]} must precede ${order[index]}`);
  }
});

test("Today V2 has zero horizontal overflow at all required mobile widths", async (t) => {
  const component = await importApp("components/voom/today/TodayDashboard.tsx");
  const workflow = item();
  const props = {
    firstName: "Alexandria", greeting: "Good morning", automationMode: "manual",
    view: buildTodayView(
      { today: "2026-09-24", planValidUntil: "2026-09-30", items: [workflow] },
      summary({ next: workflow }),
      { gaps: [], needs: [] },
    ),
    performance: { headline: null, measuredItems: 0, trend: null },
  };
  const html = await documentFrom(renderToStaticMarkup(h("div", { className: "min-h-screen bg-bg p-3 text-text" }, h(component.TodayDashboard, props))));
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
