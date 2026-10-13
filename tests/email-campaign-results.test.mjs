/**
 * Email campaign results: truthful counts from recorded sends and verified
 * Resend events, the delayed-delivery fix, and owner isolation — against the
 * repository's real migrations in PGlite. No network, no real email.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const results = await import("../lib/voom/email-results.ts");
const server = await import("../lib/voom/email-results-server.ts");
const resend = await import("../lib/email/providers/resend.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "99999999-9999-4999-8999-999999999999";

/* ── Pure summary ─────────────────────────────────────────────────── */

const send = (id, internal_status, extra = {}) => ({ id, internal_status, accepted_at: null, delivered_at: null, ...extra });
const ev = (send_id, event_type) => ({ send_id, event_type });
const AT = "2026-10-13T10:00:00.000Z";

test("every category is counted from real sends and events, separately, with no rates", () => {
  const r = results.summarizeEmailCampaignResults(
    [
      send("d1", "delivered", { accepted_at: AT, delivered_at: AT }),
      send("d2", "delivered", { accepted_at: AT, delivered_at: AT }),
      send("b1", "failed", { accepted_at: AT }),
      send("c1", "delivered", { accepted_at: AT, delivered_at: AT }),
      send("f1", "failed"),                                  // refused by Resend at send time (e.g. HTTP 403)
      send("f2", "failed", { accepted_at: AT }),             // Resend reported a failure
      send("a1", "accepted", { accepted_at: AT }),           // no report yet
      send("q1", "queued"),
      send("s1", "sending"),
      send("k1", "skipped"),
    ],
    [
      ev("d1", "email.sent"), ev("d1", "email.delivered"),
      ev("b1", "email.sent"), ev("b1", "email.bounced"),
      ev("c1", "email.delivered"), ev("c1", "email.complained"),
      ev("f2", "email.failed"),
    ],
  );
  assert.deepEqual(r, {
    sent: 8, accepted: 6, delivered: 3, bounced: 1, complained: 1, failed: 2, delayed: 0,
    inProgress: 2, awaitingReport: 1, skipped: 1, opens: null, clicks: null,
  });
  assert.equal(Object.keys(r).some((key) => /rate|percent/i.test(key)), false, "no derived rates");
});

test("opens and clicks are 'Not tracked' (null) unless Resend reported them, and count distinct emails", () => {
  const sends = [send("d1", "delivered", { delivered_at: AT }), send("d2", "delivered", { delivered_at: AT })];
  const none = results.summarizeEmailCampaignResults(sends, [ev("d1", "email.delivered")]);
  assert.equal(none.opens, null);
  assert.equal(none.clicks, null);
  const tracked = results.summarizeEmailCampaignResults(sends, [
    ev("d1", "email.opened"), ev("d1", "email.opened"), ev("d2", "email.opened"), ev("d2", "email.clicked"),
  ]);
  assert.equal(tracked.opens, 2, "two emails opened, however many open events");
  assert.equal(tracked.clicks, 1);
});

test("a delay is never a failure — including sends recorded as failed before this fix", () => {
  const r = results.summarizeEmailCampaignResults(
    [
      send("legacy", "failed", { accepted_at: AT }),       // old mapping marked a delay as failed
      send("waiting", "accepted", { accepted_at: AT }),
      send("real", "failed", { accepted_at: AT }),
      send("later", "delivered", { accepted_at: AT, delivered_at: AT }),
    ],
    [
      ev("legacy", "email.delivery_delayed"),
      ev("waiting", "email.delivery_delayed"),
      ev("real", "email.delivery_delayed"), ev("real", "email.failed"),
      ev("later", "email.delivery_delayed"), ev("later", "email.delivered"),
    ],
  );
  assert.equal(r.delayed, 2);
  assert.equal(r.failed, 1, "only the send with a real failure report");
  assert.equal(r.delivered, 1);
});

test("events that don't belong to this campaign's sends are ignored", () => {
  const r = results.summarizeEmailCampaignResults([send("mine", "delivered", { delivered_at: AT })], [
    ev("someone-else", "email.bounced"), ev("someone-else", "email.opened"),
  ]);
  assert.equal(r.bounced, 0);
  assert.equal(r.opens, null);
});

/* ── Resend mapping ───────────────────────────────────────────────── */

test("Resend's delivery_delayed event normalizes to 'delayed', never 'failed'; signature verification is untouched", async () => {
  const headers = new Headers({ "svix-id": "msg_evt_1" });
  const delayed = resend.normalizeResendWebhook({ type: "email.delivery_delayed", data: { email_id: "e1" } }, headers);
  assert.equal(delayed.status, "delayed");
  assert.equal(resend.normalizeResendWebhook({ type: "email.failed", data: { email_id: "e1" } }, headers).status, "failed");
  assert.equal(resend.normalizeResendWebhook({ type: "email.bounced", data: { email_id: "e1" } }, headers).status, "bounced");
  const route = await read("app/api/webhooks/resend/route.ts");
  assert.match(route, /verifyResendWebhook\(payload, request\.headers, config\.webhookSecret\)/);
  assert.match(route, /status: 403/, "an invalid signature is refused");
});

/* ── Real SQL: recording and owner-scoped reading ─────────────────── */

let lite = null;
async function liteDb() {
  if (lite) return lite;
  const { db } = await createSupabaseLite();
  await db.query("insert into auth.users (id, email) values ($1, 'a@voom.test'), ($2, 'b@voom.test')", [OWNER_A, OWNER_B]);
  lite = { db, admin: miniAdmin(db) };
  return lite;
}

/** Just the query shapes readEmailCampaignResults uses (select/eq/in/limit, count head). */
function miniAdmin(db) {
  return {
    from(table) {
      const where = [];
      const params = [];
      let columns = "*";
      let countHead = false;
      let limit = null;
      const builder = {
        select(cols, options) { columns = cols; countHead = Boolean(options?.head); return builder; },
        eq(column, value) { params.push(value); where.push(`"${column}" = $${params.length}`); return builder; },
        in(column, values) {
          const holders = values.map((value) => { params.push(value); return `$${params.length}`; });
          where.push(values.length ? `"${column}" in (${holders.join(",")})` : "false");
          return builder;
        },
        limit(value) { limit = value; return builder; },
        then(resolve, reject) {
          const clause = where.length ? ` where ${where.join(" and ")}` : "";
          const run = countHead
            ? db.query(`select count(*)::int as n from public.${table}${clause}`, params).then((res) => ({ data: null, count: res.rows[0].n, error: null }))
            : db.query(`select ${columns.split(",").map((c) => `"${c.trim()}"`).join(",")} from public.${table}${clause}${limit ? ` limit ${limit}` : ""}`, params)
              .then((res) => ({ data: res.rows, error: null }));
          return run.catch((error) => ({ data: null, error })).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

async function seedCampaign(ownerId, name) {
  const { db } = await liteDb();
  const campaign = (await db.query(
    "insert into public.voom_campaigns (owner_user_id, kind, name, status) values ($1, 'email', $2, 'approved') returning id",
    [ownerId, name],
  )).rows[0].id;
  return campaign;
}

async function seedSend(ownerId, campaignId, contact, { status = "accepted", messageId = null } = {}) {
  const { db } = await liteDb();
  const recipient = (await db.query(
    `insert into public.campaign_recipients (owner_user_id, campaign_id, kind, contact, consent_at, consent_source)
     values ($1, $2, 'email', $3, now(), 'test') returning id`,
    [ownerId, campaignId, contact],
  )).rows[0].id;
  return (await db.query(
    `insert into public.campaign_sends (owner_user_id, campaign_id, recipient_id, channel, provider, provider_message_id, internal_status, idempotency_key, claimed_at, accepted_at)
     values ($1, $2, $3, 'email', 'resend', $4, $5, $6, now(), case when $5 in ('accepted', 'delivered') then now() end) returning id`,
    [ownerId, campaignId, recipient, messageId, status, `test-key-${crypto.randomUUID()}`],
  )).rows[0].id;
}

async function recordEvent(ownerId, sendId, eventId, eventType, providerStatus) {
  const { db } = await liteDb();
  await db.query("select public.record_campaign_delivery_event($1, $2, 'resend', $3, $4, now(), $5)", [ownerId, sendId, eventId, eventType, providerStatus]);
}

test("through the real delivery SQL: a delayed event leaves the send accepted, deduplication holds, and later delivery completes it", async () => {
  const { db, admin } = await liteDb();
  const campaign = await seedCampaign(OWNER_A, "Autumn menu");
  const sendId = await seedSend(OWNER_A, campaign, "guest@example.com", { messageId: "re_msg_1" });

  // The webhook passes the normalized status; "delayed" is not a failure status in SQL.
  await recordEvent(OWNER_A, sendId, "evt_delay_1", "email.delivery_delayed", "delayed");
  await recordEvent(OWNER_A, sendId, "evt_delay_1", "email.delivery_delayed", "delayed"); // a redelivered webhook
  let row = (await db.query("select internal_status from public.campaign_sends where id = $1", [sendId])).rows[0];
  assert.equal(row.internal_status, "accepted", "a delay does not fail the send");
  const stored = (await db.query("select count(*)::int n from public.campaign_delivery_events where send_id = $1", [sendId])).rows[0].n;
  assert.equal(stored, 1, "the same provider event is stored once");

  let view = await server.readEmailCampaignResults(admin, OWNER_A, campaign);
  assert.equal(view.results.delayed, 1);
  assert.equal(view.results.failed, 0);

  await recordEvent(OWNER_A, sendId, "evt_delivered_1", "email.delivered", "delivered");
  await recordEvent(OWNER_A, sendId, "evt_open_1", "email.opened", "opened");
  row = (await db.query("select internal_status from public.campaign_sends where id = $1", [sendId])).rows[0];
  assert.equal(row.internal_status, "delivered");
  view = await server.readEmailCampaignResults(admin, OWNER_A, campaign);
  assert.equal(view.results.delivered, 1);
  assert.equal(view.results.delayed, 0);
  assert.equal(view.results.opens, 1, "a genuine open event is shown");
});

test("one business never sees another's results, and unsubscribes are counted per account only", async () => {
  const { db, admin } = await liteDb();
  const mine = await seedCampaign(OWNER_A, "Mine");
  const theirs = await seedCampaign(OWNER_B, "Theirs");
  const mySend = await seedSend(OWNER_A, mine, "one@example.com", { messageId: "re_a_1" });
  const theirSend = await seedSend(OWNER_B, theirs, "two@example.com", { messageId: "re_b_1" });
  await recordEvent(OWNER_A, mySend, "evt_a_bounce", "email.bounced", "bounced");
  await recordEvent(OWNER_B, theirSend, "evt_b_click", "email.clicked", "clicked");
  await db.query("insert into public.voom_email_unsubscribes (owner_user_id, email) values ($1, 'gone1@example.com'), ($1, 'gone2@example.com'), ($2, 'other@example.com')", [OWNER_A, OWNER_B]);

  const own = await server.readEmailCampaignResults(admin, OWNER_A, mine);
  assert.equal(own.results.sent, 1);
  assert.equal(own.results.bounced, 1);
  assert.equal(own.results.clicks, null, "the other business's click is not counted");
  assert.equal(own.unsubscribes.total, 2, "only this account's unsubscribes");

  // Asking for another business's campaign with your own owner id finds nothing.
  const cross = await server.readEmailCampaignResults(admin, OWNER_A, theirs);
  assert.equal(cross.results.sent, 0);
  assert.equal(cross.results.clicks, null);
  assert.equal(JSON.stringify(cross).includes("two@example.com"), false);
  assert.equal(JSON.stringify(own).includes("one@example.com"), false, "no recipient address is ever returned");
});

test("the results route checks ownership with the user's own session before reading, and returns counts only", async () => {
  const route = await read("app/api/voom/campaigns/[id]/results/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /status: 401/);
  assert.match(route, /getCampaign\(await createClient\(\), user\.id, id\)/, "RLS-scoped ownership check first");
  assert.ok(route.indexOf("getCampaign(") < route.indexOf("readEmailCampaignResults("), "ownership before any service-role read");
  assert.match(route, /campaign\.kind !== "email"/);
  const reader = await read("lib/voom/email-results-server.ts");
  assert.equal((reader.match(/\.eq\("owner_user_id", ownerId\)/g) ?? []).length, 3, "every query is owner-filtered");
  const selected = (reader.match(/\.select\("[^"]*"/g) ?? []).join(" ");
  assert.doesNotMatch(selected, /contact|provider_message_id|recipient/i, "no addresses or message ids are read");
});

test("the panel uses plain language, shows 'Not tracked' and labels unsubscribes as account-wide", async () => {
  // Comments are stripped: only what the customer can see is checked.
  const panel = (await read("components/voom/campaigns/EmailResultsPanel.tsx")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  for (const label of ["Sent", "Accepted", "Delivered", "Bounced", "Spam complaints", "Failed", "Opens", "Clicks", "Unsubscribes"]) {
    assert.match(panel, new RegExp(`label="${label}"`), label);
  }
  assert.match(panel, /Not tracked/);
  assert.match(panel, /Whole account, from all emails — not just this campaign/);
  assert.doesNotMatch(panel, /%|rate/i, "no percentages or rates");
  const editor = await read("components/voom/modals/CampaignEditorModal.tsx");
  assert.match(editor, /<EmailResultsPanel campaignId=\{id\}/);
});
