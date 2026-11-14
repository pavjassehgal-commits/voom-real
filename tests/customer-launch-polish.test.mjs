import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importApp, react, renderToStaticMarkup } from "./helpers/rendered-surface.mjs";
import { createFakeClients, Trace } from "./perf/fake-supabase.mjs";

const { calendarByDate, calendarSummary } = await importApp("lib/voom/calendar-events.ts");
const { loadApprovalFeed } = await importApp("lib/voom/approval-feed.ts");
const { readSocialChannelReadiness } = await importApp("lib/social/readiness.ts");
const { planItemActions } = await importApp("lib/voom/workflow/next-actions.ts");
const { loadScheduledPosts, loadTodayScheduledItems } = await importApp("lib/voom/today-schedule.ts");
const { Providers } = await importApp("app/app/Providers.tsx");
const { businessRecord } = await importApp("tests/helpers/shell-surface.tsx");
const { default: Pricing } = await importApp("app/app/(shell)/pricing/page.tsx");
const { getPlanConfig } = await importApp("lib/billing/plans.ts");
const h = react.createElement;

function db(tables) {
  return createFakeClients({ store: new Map(Object.entries(tables)), claims: {}, trace: new Trace({ rttMs: 0 }) }).admin;
}

for (const plan of ["free", "pro", "max"]) {
  test(`pricing displays the assigned ${plan} plan and the configured allowances`, () => {
    const html = renderToStaticMarkup(h(Providers, { initialBusiness: businessRecord({ plan }) }, h(Pricing)));
    assert.ok(html.includes(`Your workspace is on the <b>${getPlanConfig(plan).name}</b> plan`));
    for (const id of ["pro", "max"]) assert.ok(html.includes(`${getPlanConfig(id).monthlyCredits} AI media credits per month`));
    assert.match(html, /No payment is taken today/);
    assert.match(html, /email campaigns/);
    assert.doesNotMatch(html, /Email marketing \(soon\)/i);
  });
}

test("a post held for review in Autopilot explains the required human decision", () => {
  const result = planItemActions({ contentType: "post", stage: "needs_approval", mode: "autopilot", hasMedia: true });
  assert.match(result.explanation.approval, /your review and approval/);
  assert.match(result.explanation.autoPublish, /waiting for your approval/);
});

test("Calendar counts only eligible jobs, once per draft, on the execution date and within the chosen format", () => {
  const november = "2026-11-30", december = "2026-12-01";
  const item = (draftId, localDate, status, contentTypeLabel = "Instagram Post") => ({
    draftId, localDate, status, contentTypeLabel, publishAt: localDate + "T10:00:00Z",
  });
  const planned = [
    item("rescheduled", november, "scheduled"), item("held", november, "needs_approval"),
    item("ready", november, "ready_for_review"), item("history", november, "published"),
  ];
  const social = [{ ...item("video", december, "scheduled", "YouTube Short"), queueStatus: "scheduled", scheduledAt: december + "T11:00:00Z" }];
  const jobs = [item("rescheduled", december, "scheduled"), item("standalone", december, "scheduled"), social[0]];
  const dates = calendarByDate(planned, social, jobs, "All");
  assert.deepEqual(calendarSummary(dates.get(november)), { total: 3, scheduled: 0, approval: 1 });
  assert.deepEqual(calendarSummary(dates.get(december)), { total: 3, scheduled: 3, approval: 0 });
  assert.equal(dates.get(december).find(event => event.item.draftId === "rescheduled").type, "workflow");
  assert.deepEqual(calendarSummary(calendarByDate(planned, social, jobs, "YouTube Short").get(december)), { total: 1, scheduled: 1, approval: 0 });
  assert.deepEqual(calendarSummary([]), { total: 0, scheduled: 0, approval: 0 });
});

test("pending approvals survive paginated reads and newer history, scoped to the owner", async () => {
  const actions = Array.from({ length: 311 }, (_, i) => ({
    id: String(i).padStart(4, "0"), created_at: new Date(i * 1000).toISOString(), owner_user_id: "owner",
    status: i < 260 ? "pending" : i === 260 ? "failed" : "confirmed",
  }));
  const feed = await loadApprovalFeed(db({ mara_pending_actions: [...actions, { ...actions[0], id: "foreign", owner_user_id: "other" }] }), "owner");
  assert.equal(feed.filter(action => action.status === "pending").length, 260);
  assert.equal(feed.filter(action => action.status === "failed").length, 1);
  assert.deepEqual(feed.map(action => action.id), actions.reverse().map(action => action.id));
});

test("Calendar and the seven-day summary share approval, timezone, expiry and missed-job rules", async () => {
  const now = new Date("2026-11-30T06:00:00Z");
  const owner = "owner";
  const jobs = ["2026-11-30T03:00:00Z", "2026-12-06T19:59:00Z", "2026-12-06T20:00:00Z"].map((scheduled_at, i) => ({
    id: "job" + i, owner_user_id: owner, draft_id: "draft" + i, status: "scheduled", scheduled_at,
  }));
  const connection = { status: "connected", scopes: ["instagram_business_content_publish"], owner_user_id: owner, token_expires_at: "2099-01-01T00:00:00Z" };
  const admin = db({
    instagram_publish_queue: jobs, instagram_connections: [connection],
    mara_drafts: jobs.map(job => ({ id: job.draft_id, owner_user_id: owner, status: "approved", kind: "story", title: "Story", content_version: 2, approved_content_version: 2 })),
    post_draft_assets: jobs.map(job => ({ draft_id: job.draft_id, owner_user_id: owner, status: "uploaded", storage_path: owner + "/story.jpg" })),
  });
  const week = () => loadTodayScheduledItems(admin, owner, "2026-11-30", "Asia/Dubai", now);
  assert.deepEqual((await week()).map(post => post.draftId), ["draft1"]);
  assert.deepEqual((await loadScheduledPosts(admin, owner, "Asia/Dubai", now)).map(post => [post.localDate, post.contentTypeLabel]),
    [["2026-12-06", "Instagram Story"], ["2026-12-07", "Instagram Story"]]);
  const instagram = async () => (await readSocialChannelReadiness(admin, owner)).find(entry => entry.channel === "instagram");
  assert.equal((await instagram()).connected, true);
  connection.token_expires_at = "2000-01-01T00:00:00Z";
  assert.equal((await instagram()).connected, false);
  assert.deepEqual(await week(), []);
});

test("the launch-polish review branch never auto-deploys a Preview that shares Production credentials", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vercel.git.deploymentEnabled["codex/customer-launch-polish-v2"], false);
  assert.equal(vercel.git.deploymentEnabled.main, undefined, "Production main deployments are unchanged");
});
