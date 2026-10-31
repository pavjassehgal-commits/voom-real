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

test("work just before and after the horizon counts in every rolling window that contains it", () => {
  // Published yesterday (15th) and scheduled for the 23rd: the window 15–21
  // already holds one item, so only two of 16/18/21 may be added.
  const around = [commitment("2026-09-15", "published"), commitment("2026-09-23", "scheduled")];
  const gaps = identifyCalendarGaps(state("3x_week", around)).map((gap) => gap.date);
  assert.deepEqual(gaps, [TODAY, "2026-09-18"]);
  assertEveryWindow([...around.map((c) => c.localDate), ...gaps], 3);
  // Work 7+ days away touches no window that contains a horizon date.
  const far = [commitment("2026-09-09", "published"), commitment("2026-09-29", "scheduled")];
  assert.equal(identifyCalendarGaps(state("3x_week", far)).length, 3);
});

test("Codex 16–23 September: an earlier post plus new gaps never put four items in one 3x window", () => {
  // Plan started Sat 12 Sep (3x pattern 12, 14, 17, 19, 21, 24 …). Published
  // on the 14th and an owner Studio post on the 16th; the run is on the 17th.
  const published = [commitment("2026-09-14", "published"), commitment("2026-09-16", "published", "tiktok_video")];
  const gaps = identifyCalendarGaps(state("3x_week", published, {
    todayLocalDate: "2026-09-17", cadenceAnchorDate: "2026-09-12", now: "2026-09-17T02:00:00.000Z",
    horizonStart: "2026-09-17", horizonEnd: "2026-09-23",
  })).map((gap) => gap.date);
  assert.deepEqual(gaps, ["2026-09-17", "2026-09-21"], "the 19th would make 16–22 hold four");
  assertEveryWindow([...published.map((c) => c.localDate), ...gaps], 3);
});

test("a later scheduled post blocks a weekly slot whose window would hold two", () => {
  const later = [commitment("2026-09-21", "scheduled")];
  assert.deepEqual(identifyCalendarGaps(state("weekly", later)), [], "16–22 already has its one weekly item");
});

test("a failed provider publish is neither coverage nor an automatic gap", async () => {
  const { failedPublishDates } = await import("../lib/coordinator/engine.ts");
  const failedPublish = { ...commitment("2026-09-18", "failed"), publishFailed: true };
  const st = state("3x_week", [failedPublish]);
  const gaps = identifyCalendarGaps(st).map((gap) => gap.date);
  assert.ok(!gaps.includes("2026-09-18"), "never silently re-planned on the failed date");
  assert.deepEqual(gaps, [TODAY, "2026-09-21"], "the failed item does not use up the window");
  assert.deepEqual([...failedPublishDates(st)], ["2026-09-18"]);
  // A rejected idea (failed, not a publish failure) is a normal gap.
  assert.ok(identifyCalendarGaps(state("3x_week", [commitment("2026-09-18", "failed")])).some((gap) => gap.date === "2026-09-18"));
});

test("an unexecuted proposal on a deselected channel does not fill a date; approved work on it does", () => {
  const selected = { business: { mainGoal: "Grow awareness", preferredChannels: ["Instagram"] } };
  const proposal = commitment("2026-09-18", "proposed", "tiktok_video");
  assert.ok(identifyCalendarGaps(state("3x_week", [proposal], selected)).some((gap) => gap.date === "2026-09-18"));
  const approved = commitment("2026-09-18", "approved", "tiktok_video");
  assert.ok(!identifyCalendarGaps(state("3x_week", [approved], selected)).some((gap) => gap.date === "2026-09-18"));
});

function assertEveryWindow(dates, cap) {
  const unique = [...new Set(dates)].sort();
  for (const start of unique) {
    for (let back = 0; back < 7; back += 1) {
      const from = new Date(Date.parse(`${start}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.parse(`${from}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
      const inWindow = unique.filter((date) => date >= from && date <= to).length;
      assert.ok(inWindow <= cap, `window ${from}..${to} holds ${inWindow} > ${cap}`);
    }
  }
}

test("a window that already meets its cadence on off-pattern dates gets nothing more", () => {
  const offPattern = [commitment("2026-09-17", "approved"), commitment("2026-09-20", "proposed"), commitment("2026-09-22", "scheduled")];
  assert.deepEqual(identifyCalendarGaps(state("3x_week", offPattern)), []);
});

test("this branch never auto-deploys a Preview (Previews share the Production database)", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.git.deploymentEnabled["fix/mara-automation-launch"], false);
});
