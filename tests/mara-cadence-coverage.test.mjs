/**
 * Cadence coverage rules for the Automation Coordinator: what counts toward a
 * 7-day window, what does not, and that nothing is counted twice. Pure engine
 * evaluation; no I/O.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const { identifyCalendarGaps } = await import("../lib/coordinator/engine.ts");

const TODAY = "2026-09-16";

function state(cadence, commitments, overrides = {}) {
  return {
    ownerId: "owner", businessId: "biz",
    business: { mainGoal: "Grow awareness" },
    timezone: "Asia/Dubai",
    now: "2026-09-16T02:00:00.000Z", // 06:00 Dubai: today's usual slot is still ahead
    todayLocalDate: TODAY,
    cadenceAnchorDate: TODAY,
    horizonStart: TODAY, horizonEnd: "2026-09-22",
    cadence, mode: "assisted",
    commitments,
    performance: { hasSufficientData: false, confidence: "none", sampleSize: 0 },
    ...overrides,
  };
}

let sequence = 0;
function commitment(localDate, status, channel = "instagram_post") {
  return {
    id: `c-${++sequence}`, source: "draft", sourceId: `s-${sequence}`, channel, format: "post",
    title: "Existing", publishAt: `${localDate}T14:30:00.000Z`, localDate, localTime: "18:30", status,
  };
}

test("scheduled, approved, queued, publishing and published work all count toward the cadence", () => {
  for (const status of ["proposed", "needs_approval", "approved", "scheduled", "waiting_for_media", "publishing", "published"]) {
    assert.deepEqual(identifyCalendarGaps(state("weekly", [commitment("2026-09-19", status)])), [], status);
  }
});

test("several records for one post on one date (draft + calendar + queue) count once, not three times", () => {
  const sameDate = [
    commitment("2026-09-19", "approved"),
    commitment("2026-09-19", "scheduled"),
    commitment("2026-09-19", "scheduled", "tiktok_video"),
  ];
  const gaps = identifyCalendarGaps(state("3x_week", sameDate));
  assert.equal(gaps.length, 2, "one covered date leaves two of three weekly slots");
  assert.ok(gaps.every((gap) => gap.date !== "2026-09-19"));
});

test("rejected/failed work and email never satisfy social coverage", () => {
  const notCoverage = [
    commitment(TODAY, "failed"),
    commitment("2026-09-18", "failed", "tiktok_video"),
    commitment("2026-09-21", "scheduled", "email"),
  ];
  const gaps = identifyCalendarGaps(state("3x_week", notCoverage));
  assert.deepEqual(gaps.map((gap) => gap.date), [TODAY, "2026-09-18", "2026-09-21"]);
});

test("work outside the 7-day window does not use up this window's cadence", () => {
  const outside = [commitment("2026-09-15", "published"), commitment("2026-09-23", "scheduled")];
  assert.equal(identifyCalendarGaps(state("3x_week", outside)).length, 3);
});

test("a window that already meets its cadence on off-pattern dates gets nothing more", () => {
  const offPattern = [commitment("2026-09-17", "approved"), commitment("2026-09-20", "proposed"), commitment("2026-09-22", "scheduled")];
  assert.deepEqual(identifyCalendarGaps(state("3x_week", offPattern)), []);
});
