/**
 * Production-readiness gates for the demo/placeholder purge and the
 * scheduling/date-time guardrails.
 *
 *  1. Scheduling guard (executed, not asserted): past-date rejection,
 *     same-day past-time rejection, business-timezone correctness, and the
 *     absolute instants it produces — the exact same module the client
 *     editor and the API routes run.
 *  2. Server enforcement: both scheduling endpoints run the shared guard.
 *  3. Client enforcement: the editor wires min attributes, validates before
 *     submit, and reads/writes schedule fields in the business timezone.
 *  4. Calendar: opens on the real current month from the server snapshot,
 *     highlights today, no hardcoded month anywhere.
 *  5. No demo/stale content: production components contain no demo/sample
 *     strings, no hardcoded August/September 2026 dates, and the demo files
 *     are actually gone.
 *  6. Unfinished features are hidden, not faked: nav excludes the removed
 *     surfaces, the temporary planning preview is dev-flag gated.
 *
 * No network, no Supabase, no provider calls. Nothing is generated or
 * published by this suite.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const exists = async (path) => {
  try { await access(new URL(path, root)); return true; } catch { return false; }
};

const guard = await import("../lib/voom/schedule-guard.ts");
const tz = await import("../lib/voom/timezone.ts");

// A deterministic instant: 2026-09-12 09:00:00 Asia/Dubai (= 05:00 UTC).
const NOW = new Date("2026-09-12T05:00:00.000Z");
const TZ = "Asia/Dubai";

// ---------------------------------------------------------------------------
// 1. The shared scheduling guard
// ---------------------------------------------------------------------------

test("scheduling rejects past local dates", () => {
  const result = guard.checkSchedule({ date: "2026-09-11", time: "23:59", now: NOW, timeZone: TZ });
  assert.equal(result.ok, false);
  assert.equal(result.field, "date");
  assert.match(result.error, /already passed/i);
});

test("scheduling rejects a same-day time earlier than the current local time", () => {
  const before = guard.checkSchedule({ date: "2026-09-12", time: "08:59", now: NOW, timeZone: TZ });
  assert.equal(before.ok, false);
  assert.equal(before.field, "time");
  assert.match(before.error, /already passed today/i);
  // Exactly now is also rejected (a 1-minute lead absorbs submit latency).
  const exact = guard.checkSchedule({ date: "2026-09-12", time: "09:00", now: NOW, timeZone: TZ });
  assert.equal(exact.ok, false);
});

test("scheduling accepts a same-day time later than now and any future time", () => {
  const later = guard.checkSchedule({ date: "2026-09-12", time: "09:01", now: NOW, timeZone: TZ });
  assert.equal(later.ok, true);
  const evening = guard.checkSchedule({ date: "2026-09-12", time: "19:10", now: NOW, timeZone: TZ });
  assert.equal(evening.ok, true);
  const tomorrow = guard.checkSchedule({ date: "2026-09-13", time: "00:05", now: NOW, timeZone: TZ });
  assert.equal(tomorrow.ok, true);
});

test("scheduling validates against the business timezone, not UTC or the device zone", () => {
  // 2026-09-12 00:30 Dubai = 2026-09-11 20:30 UTC. A UTC-based guard would
  // call 2026-09-12 00:30 "tomorrow" and accept a time that already passed
  // locally; the business-timezone guard must reject it.
  const now = new Date("2026-09-11T20:30:00.000Z");
  const result = guard.checkSchedule({ date: "2026-09-12", time: "00:30", now, timeZone: TZ });
  assert.equal(result.ok, false);
  assert.equal(result.field, "time");
  // And the same wall-clock on the next local day is fine.
  assert.equal(guard.checkSchedule({ date: "2026-09-13", time: "00:30", now, timeZone: TZ }).ok, true);
});

test("scheduling produces the correct absolute UTC instant", () => {
  const result = guard.checkSchedule({ date: "2026-09-12", time: "19:10", now: NOW, timeZone: TZ });
  assert.equal(result.ok, true);
  assert.equal(result.publishAt, "2026-09-12T15:10:00.000Z");
  assert.equal(tz.isoToLocalDate(result.publishAt, TZ), "2026-09-12");
  assert.equal(guard.checkScheduleInstant(result.publishAt, NOW, TZ).ok, true);
});

test("scheduling rejects malformed dates and times with actionable messages", () => {
  for (const bad of ["2026-13-01", "not-a-date", "2026-02-30", ""]) {
    const result = guard.checkSchedule({ date: bad, time: "10:00", now: NOW, timeZone: TZ });
    assert.equal(result.ok, false, bad);
    assert.match(result.error, /valid calendar date|not valid/i);
  }
  for (const bad of ["9", "25:00", "10:5", "", "10:60"]) {
    const result = guard.checkSchedule({ date: "2026-09-13", time: bad, now: NOW, timeZone: TZ });
    assert.equal(result.ok, false, bad);
    assert.match(result.error, /time/i);
  }
});

test("min attributes derive from the real current local date", () => {
  assert.equal(guard.minScheduleDate(NOW, TZ), "2026-09-12");
  assert.equal(guard.minScheduleTime("2026-09-12", NOW, TZ), "09:01");
  assert.equal(guard.minScheduleTime("2026-09-13", NOW, TZ), undefined);
});

test("past instants are detected for truthful past-due display", () => {
  assert.equal(guard.isPastInstant("2026-09-12T05:00:00.000Z", NOW), false); // 1h tolerance margin
  assert.equal(guard.isPastInstant("2026-09-12T04:58:00.000Z", NOW), true);
  assert.equal(guard.isPastInstant(null, NOW), false);
  assert.equal(guard.isPastInstant("garbage", NOW), false);
});

// ---------------------------------------------------------------------------
// 2. Server enforcement through the shared guard
// ---------------------------------------------------------------------------

test("both scheduling endpoints enforce the shared business-timezone guard", async () => {
  const [postsRoute, calendarRoute] = await Promise.all([
    read("app/api/posts/[id]/route.ts"),
    read("app/api/voom/calendar/route.ts"),
  ]);
  assert.match(postsRoute, /checkScheduleInstant/);
  assert.doesNotMatch(postsRoute, /Date\.now\(\) - 5 \* 60_000/);
  assert.match(calendarRoute, /checkScheduleInstant/);
  assert.doesNotMatch(calendarRoute, /Date\.now\(\) - 5 \* 60_000/);
});

test("the post editor guards on the client too — never just HTML min attributes", async () => {
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /minScheduleDate\(\)/);
  assert.match(editor, /minScheduleTime\(date\)/);
  assert.match(editor, /checkSchedule\(\{ date, time \}\)/);
  // The stored instant comes from the guard, not a browser-local Date.
  assert.doesNotMatch(editor, /new Date\`\$\{date\}T\$\{time|new Date\(\`\$\{date\}/);
  // Schedule fields are read in the business timezone.
  assert.match(editor, /isoToLocalDate\(.*DEFAULT_TIMEZONE\)/);
});

test("the approval edit dialog validates the edited schedule too", async () => {
  const board = await read("components/voom/operating/ApprovalsBoard.tsx");
  assert.match(board, /Choose a time that has not already passed/);
  assert.match(board, /Caption cannot be empty/);
});

// ---------------------------------------------------------------------------
// 3. Calendar defaults and past-due truthfulness
// ---------------------------------------------------------------------------

test("the calendar opens on the real current month and highlights today from the snapshot", async () => {
  const page = await read("app/app/(shell)/calendar/page.tsx");
  assert.match(page, /monthOf\(body\.snapshot!\.today\)/);
  assert.match(page, /current \? current :? ?monthOf|current \?\? monthOf|current ?? monthOf/);
  assert.match(page, /isToday .*=.*date === snapshot!\.today/);
  assert.match(page, /onClick=\{\(\) => snapshot && setCursor\(monthOf\(snapshot\.today\)\)\}/);
  // No hardcoded month or year may leak back in.
  assert.doesNotMatch(page, /\b(202[4-9])-([01]\d)\b/);
  assert.doesNotMatch(page, /month: 7, year: 2026|August 2026|September 2026/);
});

test("scheduled-but-past items surface as past due instead of pretending to be upcoming", async () => {
  const [queue, detail, calendar] = await Promise.all([
    read("components/voom/PublishingQueue.tsx"),
    read("components/voom/modals/SavedCalendarDetailModal.tsx"),
    read("app/app/(shell)/calendar/page.tsx"),
  ]);
  for (const source of [queue, detail, calendar]) {
    assert.match(source, /isPastInstant/);
    assert.match(source, /[Pp]ast (its scheduled time|due)/);
  }
  assert.match(queue, /never dropped or published twice/);
});

// ---------------------------------------------------------------------------
// 4. No demo / stale content in production UI
// ---------------------------------------------------------------------------

test("no demo, sample or placeholder strings remain in production components", async () => {
  const files = [
    "app/app/(shell)/today/page.tsx",
    "app/app/(shell)/approvals/page.tsx",
    "app/app/(shell)/plan/page.tsx",
    "app/app/(shell)/calendar/page.tsx",
    "app/app/(shell)/studio/page.tsx",
    "app/app/(shell)/campaigns/page.tsx",
    "app/app/(shell)/ads/page.tsx",
    "app/app/(shell)/automations/page.tsx",
    "app/app/(shell)/performance/page.tsx",
    "app/app/(shell)/connections/page.tsx",
    "app/app/(shell)/contacts/page.tsx",
    "app/app/(shell)/instagram/page.tsx",
    "app/app/(shell)/pricing/page.tsx",
    "app/app/(shell)/settings/page.tsx",
    "components/voom/shell/Topbar.tsx",
    "components/voom/shell/Sidebar.tsx",
    "components/voom/shell/BottomBar.tsx",
    "components/voom/PublishingQueue.tsx",
    "components/voom/modals/NotificationsModal.tsx",
    "components/voom/modals/CreateContentModal.tsx",
    "components/voom/modals/PostEditorModal.tsx",
    "components/voom/modals/SavedCalendarDetailModal.tsx",
    "components/voom/modals/CampaignEditorModal.tsx",
    "components/voom/modals/DisconnectInstagramModal.tsx",
    "lib/voom/store.tsx",
  ];
  const banned = /Demo data|demo dataset|Sample:|sample subscribers|sample open rate|Sample workspace|sample workspace|illustration-only|Prototype demonstration|placeholder=."Search|lorem ipsum/i;
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, banned, `${file} still contains demo/placeholder copy`);
  }
});

test("the dead demo components are actually gone from the tree", async () => {
  for (const gone of [
    "components/voom/modals/ComposeModal.tsx",
    "components/voom/modals/PostDetailModal.tsx",
    "components/voom/modals/MaraMenuModal.tsx",
    "components/voom/modals/KpiDetailModal.tsx",
    "components/voom/modals/MaxRequiredModal.tsx",
    "components/voom/modals/ApproveAdsModal.tsx",
    "components/voom/modals/DeclineAdsModal.tsx",
    "components/voom/modals/ConnectInstagramFirstModal.tsx",
    "components/voom/modals/UpgradeModal.tsx",
    "components/voom/modals/DowngradeModal.tsx",
    "components/voom/mara/LegacyMaraChat.tsx",
    "components/voom/ads/Donut.tsx",
  ]) {
    assert.equal(await exists(gone), false, `${gone} should be deleted`);
  }
});

test("no hardcoded August/September 2026 dates remain in production UI or client state", async () => {
  const files = [
    "app/app/(shell)/calendar/page.tsx",
    "app/app/(shell)/today/page.tsx",
    "app/app/(shell)/plan/page.tsx",
    "components/voom/PublishingQueue.tsx",
    "lib/voom/store.tsx",
    "components/voom/modals/CreateContentModal.tsx",
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /Aug 25|Aug 28|September sprint|Sept sprint/, `${file} pins a stale date`);
  }
});

// ---------------------------------------------------------------------------
// 5. Honest controls: search, notifications, create, pricing, test flags
// ---------------------------------------------------------------------------

test("the top-bar search is a real owner-scoped search over existing data", async () => {
  const [route, topbar] = await Promise.all([
    read("app/api/search/route.ts"),
    read("components/voom/shell/Topbar.tsx"),
  ]);
  assert.match(route, /getCurrentUser/);
  assert.match(route, /eq\("owner_user_id", user\.id\)/);
  assert.match(route, /eq\("owner_id", user\.id\)/);
  // User input is a literal, never a LIKE pattern.
  assert.match(route, /replace\(\/\[%_/);
  for (const table of ["mara_drafts", "content_calendar_items", "campaigns", "contacts", "audiences"]) {
    assert.match(route, new RegExp(table));
  }
  assert.match(topbar, /api\/search/);
  assert.doesNotMatch(topbar, /isn't available in this version/);
  assert.match(topbar, /placeholder="Search content, campaigns, contacts…"/);
  // No dead "read-only" search input remains.
  assert.equal(/readOnly/.test(topbar), false);
});

test("notifications render real workflow facts with a truthful empty state", async () => {
  const [modal, topbar] = await Promise.all([
    read("components/voom/modals/NotificationsModal.tsx"),
    read("components/voom/shell/Topbar.tsx"),
  ]);
  assert.match(modal, /\/api\/voom\/workflow/);
  assert.match(modal, /You’re all caught up/);
  assert.doesNotMatch(modal, /Sample:/);
  // The badge is derived from real data, not a hardcoded count.
  assert.doesNotMatch(topbar, /notif: 3/);
  assert.match(topbar, /needs_approval|failed/);
});

test("creation always goes through the real persisted create flow", async () => {
  const [calendar, topbar, create] = await Promise.all([
    read("app/app/(shell)/calendar/page.tsx"),
    read("components/voom/shell/Topbar.tsx"),
    read("components/voom/modals/CreateContentModal.tsx"),
  ]);
  assert.match(create, /fetch\("\/api\/posts"/);
  assert.match(create, /busy/);
  // Duplicate-click protection while the draft is being created.
  assert.match(create, /disabled=\{busy\}/);
  assert.doesNotMatch(calendar, /ComposeModal/);
  assert.match(topbar, /CreateContentModal/);
});

test("pricing never simulates a checkout and billing is labelled offline", async () => {
  const pricing = await read("app/app/(shell)/pricing/page.tsx");
  assert.match(pricing, /No payment is taken today/);
  assert.match(pricing, /disabled/);
  let missing = false;
  try { await read("components/voom/modals/UpgradeModal.tsx"); } catch { missing = true; }
  assert.equal(missing, true, "simulated upgrade modal must be gone");
  assert.doesNotMatch(pricing, /simulates a checkout|Upgrading here simulates/i);
});

test("duplicate submits are guarded on the remaining mutation surfaces", async () => {
  const [editor, board, contacts] = await Promise.all([
    read("components/voom/modals/PostEditorModal.tsx"),
    read("components/voom/operating/ApprovalsBoard.tsx"),
    read("components/voom/contacts/Modals.tsx"),
  ]);
  assert.match(editor, /disabled=\{busy !== null\}/);
  assert.match(board, /setBusy\(id\)/);
  assert.match(contacts, /disabled=\{busy\}/);
});

// ---------------------------------------------------------------------------
// 6. Unfinished features are hidden, not faked
// ---------------------------------------------------------------------------

test("navigation contains only implemented features", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  // Voom 2.0: primary nav must not include unimplemented surfaces as NAV items
  // (ads/reels routes still resolve but are not primary navigation)
  assert.doesNotMatch(nav, /id:\s*"reels"/);
  assert.doesNotMatch(nav, /id:\s*"ads"/);
  for (const kept of ["today", "approvals", "plan", "studio", "calendar", "campaigns", "automations", "performance", "connections", "contacts", "settings"]) {
    assert.match(nav, new RegExp(`id: "${kept}"`));
  }
  // Voom 2.0 primary hierarchy must be present
  for (const primary of ["today", "plan", "studio", "calendar", "performance"]) {
    assert.match(nav, new RegExp(`id: "${primary}"`), `Primary nav must include ${primary}`);
  }
  for (const secondary of ["campaigns", "contacts", "connections"]) {
    assert.match(nav, new RegExp(`id: "${secondary}"`), `Secondary nav must include ${secondary}`);
  }
  assert.match(nav, /id: "settings"/, "Utility nav must include settings");
  const bottom = await read("components/voom/shell/BottomBar.tsx");
  assert.doesNotMatch(bottom, /"reels"/);
  // The removed routes still resolve: no dead links.
  const [reelsRoute, adsPage] = await Promise.all([
    read("app/app/(shell)/reels/page.tsx"),
    read("app/app/(shell)/ads/page.tsx"),
  ]);
  assert.match(reelsRoute, /redirect\("\/app\/studio"\)/);
  assert.match(adsPage, /isn’t set up for your business yet/);
  assert.match(adsPage, /no ad account is connected/);
});

test("the temporary planning preview control is dev-flag gated", async () => {
  const [workspace, preview] = await Promise.all([
    read("components/voom/operating/PlanWorkspace.tsx"),
    read("components/voom/operating/PlanningOnlyPreview.tsx"),
  ]);
  assert.match(workspace, /NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW === "1"/);
  assert.match(workspace, /SHOW_PLANNING_PREVIEW && <PlanningOnlyPreviewCard/);
  // The control itself keeps its honest temporary-test-control labelling.
  assert.match(preview, /temporary test control/);
});

test("the paid-advertising page invents no numbers", async () => {
  const ads = await read("app/app/(shell)/ads/page.tsx");
  assert.doesNotMatch(ads, /AED \d|ROAS|roas|1,200|Allocation/);
  assert.match(ads, /Your Voom subscription pays for the software/);
});
