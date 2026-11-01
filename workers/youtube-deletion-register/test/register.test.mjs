import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { DAY, alert, compiledPath, completion, intent, sha256, startRegister } from "./harness.mjs";

let r;
before(async () => { r = await startRegister(); });
after(() => r?.dispose());
const rows = async (sql, ...args) => (await r.db.prepare(sql).bind(...args).all()).results;
const json = async (res) => ({ status: res.status, body: await res.json() });

test("an intent is acknowledged only with a durable receipt bound to the exact payload", async () => {
  const body = intent();
  const res = await json(await r.post("/v1/events", body));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["durable", "eventId", "payloadSha256", "receiptId"]);
  assert.equal(res.body.durable, true);
  assert.equal(res.body.eventId, body.eventId);
  assert.equal(res.body.payloadSha256, sha256(JSON.stringify(body)));
  const [row] = await rows("select * from register_records where record_id = ?1", body.eventId);
  assert.equal(row.kind, "intent"); assert.equal(row.receipt_id, res.body.receiptId); assert.equal(row.deadline_at, body.deadlineAt);
});

test("lost responses and replays are idempotent: same receipt, one row", async () => {
  const body = intent();
  const first = await json(await r.post("/v1/events", body));
  for (let i = 0; i < 3; i++) assert.deepEqual(await json(await r.post("/v1/events", body)), first);
  assert.equal((await rows("select count(*) n from register_records where request_id = ?1", body.eventId))[0].n, 1);
});

test("a different payload under an existing event id is rejected and never overwrites", async () => {
  const body = intent();
  const ok = await json(await r.post("/v1/events", body));
  const altered = { ...body, ownerId: crypto.randomUUID() };
  assert.deepEqual(await json(await r.post("/v1/events", altered)), { status: 409, body: { error: "conflicting_payload" } });
  assert.equal((await rows("select receipt_id from register_records where record_id = ?1", body.eventId))[0].receipt_id, ok.body.receiptId);
});

test("concurrent identical deliveries store exactly one record and share one receipt", async () => {
  const body = intent();
  const results = await Promise.all(Array.from({ length: 20 }, () => r.post("/v1/events", body).then(json)));
  assert.ok(results.every((x) => x.status === 200));
  assert.equal(new Set(results.map((x) => x.body.receiptId)).size, 1);
  assert.equal((await rows("select count(*) n from register_records where record_id = ?1", body.eventId))[0].n, 1);
});

test("concurrent conflicting deliveries: exactly one payload wins, every other is refused", async () => {
  const base = intent();
  const variants = Array.from({ length: 6 }, (_, i) => ({ ...base, receivedAt: new Date(Date.parse(base.receivedAt) - i * 1000).toISOString(),
    deadlineAt: new Date(Date.parse(base.receivedAt) - i * 1000 + 7 * DAY).toISOString() }));
  const results = await Promise.all(variants.map((v) => r.post("/v1/events", v).then(json)));
  const winners = results.filter((x) => x.status === 200);
  assert.equal(winners.length, 1);
  assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 409));
  const [row] = await rows("select payload_sha256 from register_records where record_id = ?1", base.eventId);
  assert.equal(row.payload_sha256, winners[0].body.payloadSha256);
});

test("authentication: missing, wrong, short and cross-purpose tokens are refused; the staged next token works", async () => {
  const body = intent();
  for (const token of ["", "x".repeat(40), r.secrets.ALERT_TOKEN, r.secrets.REPLAY_TOKEN, "short"]) {
    assert.equal((await r.post("/v1/events", body, { token })).status, 401);
  }
  assert.equal((await r.post("/v1/events", body, { token: r.secrets.JOURNAL_TOKEN_NEXT })).status, 200);
  assert.equal((await r.post("/v1/alerts", alert(body.eventId), { token: r.secrets.JOURNAL_TOKEN })).status, 401);
  assert.equal((await r.post("/v1/export", { since: new Date(0).toISOString(), after: null, limit: 10 }, { token: r.secrets.JOURNAL_TOKEN })).status, 401);
  assert.equal((await r.post("/v1/lookup", { recordIds: [body.eventId] }, { token: r.secrets.ALERT_TOKEN })).status, 401);
  assert.equal(((await r.mf.dispatchFetch("https://x.example.com/v1/health")).status), 401);
});

test("strict validation: unexpected fields (e.g. Google identifiers), bad dates and mismatched keys are rejected", async () => {
  const body = intent();
  const cases = [
    [{ ...body, channelId: "UCsomething" }, "unexpected_fields"],
    [{ ...body, refreshToken: "1//token" }, "unexpected_fields"],
    [{ ...body, deadlineAt: new Date(Date.parse(body.receivedAt) + 6 * DAY).toISOString() }, "deadline_mismatch"],
    [{ ...body, receivedAt: "2026-11-01 10:00:00" }, "invalid_received_at"],
    [{ ...body, receivedAt: new Date(Date.now() + 3600_000).toISOString(), deadlineAt: new Date(Date.now() + 3600_000 + 7 * DAY).toISOString() }, "received_at_in_future"],
    [{ ...body, ownerId: "not-a-uuid" }, "invalid_owner"],
    [{ ...body, scope: "everything" }, "invalid_scope"],
    [{ ...body, version: 2 }, "invalid_version"],
  ];
  for (const [payload, code] of cases) assert.deepEqual(await json(await r.post("/v1/events", payload, { key: body.eventId })), { status: 422, body: { error: code } }, code);
  assert.deepEqual(await json(await r.post("/v1/events", body, { key: crypto.randomUUID() })), { status: 422, body: { error: "idempotency_key_mismatch" } });
  assert.equal((await r.post("/v1/events", null, { raw: "{not json", key: body.eventId })).status, 400);
  assert.equal((await r.post("/v1/events", null, { raw: JSON.stringify(body), headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await r.post("/v1/events", null, { raw: JSON.stringify({ ...body, pad: "x".repeat(5000) }) })).status, 413);
  assert.equal((await r.mf.dispatchFetch("https://x.example.com/v1/events")).status, 405);
  assert.equal((await r.mf.dispatchFetch("https://x.example.com/admin")).status, 404);
  assert.equal((await rows("select count(*) n from register_records where record_id = ?1", body.eventId))[0].n, 0);
});

test("completions require the matching recorded intent and are idempotent", async () => {
  const body = intent();
  assert.deepEqual(await json(await r.post("/v1/events", completion(body))), { status: 409, body: { error: "intent_not_recorded" } });
  await r.post("/v1/events", body);
  assert.equal((await r.post("/v1/events", completion({ ...body, ownerId: crypto.randomUUID() }))).status, 409, "owner must match the intent");
  const done = completion(body);
  const first = await json(await r.post("/v1/events", done));
  assert.equal(first.status, 200);
  assert.deepEqual(await json(await r.post("/v1/events", done)), first);
  const retention = intent({ scope: "retention" });
  await r.post("/v1/events", retention);
  assert.equal((await r.post("/v1/events", completion(retention))).status, 200);
});

test("records are append-only: direct UPDATE/DELETE fail inside the database itself", async () => {
  const body = intent();
  await r.post("/v1/events", body);
  await assert.rejects(r.db.prepare("update register_records set owner_id = 'x' where record_id = ?1").bind(body.eventId).run(), /register_append_only/);
  await assert.rejects(r.db.prepare("delete from register_records where record_id = ?1").bind(body.eventId).run(), /register_append_only/);
  assert.equal((await r.post("/v1/alerts", alert(body.eventId), { token: r.secrets.ALERT_TOKEN })).status, 200);
  await assert.rejects(r.db.prepare("update register_alerts set code = 'x' where request_id = ?1").bind(body.eventId).run(), /register_alert_immutable/);
  await assert.rejects(r.db.prepare("update register_alerts set email_status = 'pending' where request_id = ?1").bind(body.eventId).run(), /register_alert_immutable/);
  await assert.rejects(r.db.prepare("delete from register_alerts where request_id = ?1").bind(body.eventId).run(), /register_append_only/);
});

test("alerts: recorded first, acknowledged only after Resend accepts; duplicates never re-email", async () => {
  const id = crypto.randomUUID();
  const body = alert(id, "capture_failed");
  r.emails.length = 0;
  const ok = await json(await r.post("/v1/alerts", body, { token: r.secrets.ALERT_TOKEN }));
  assert.equal(ok.status, 200); assert.equal(ok.body.durable, true);
  assert.equal(r.emails.length, 1);
  const mail = JSON.stringify(r.emails[0].body);
  assert.match(mail, /capture_failed/); assert.doesNotMatch(mail, /operator@example.com.*operator@example.com/);
  assert.deepEqual(await json(await r.post("/v1/alerts", body, { token: r.secrets.ALERT_TOKEN })), ok);
  assert.equal(r.emails.length, 1, "a delivered alert is not emailed twice");
  assert.equal((await r.post("/v1/alerts", { ...body, code: "nonsense", eventId: `${id}:nonsense` }, { token: r.secrets.ALERT_TOKEN })).status, 422);
});

test("alert email outage: VOOM is told 503 (keeps retrying), the alert stays pending, the watchdog delivers it later", async () => {
  const body = alert(crypto.randomUUID(), "erasure_failed");
  r.resend.mode = "down"; r.emails.length = 0;
  assert.deepEqual(await json(await r.post("/v1/alerts", body, { token: r.secrets.ALERT_TOKEN })), { status: 503, body: { error: "alert_email_pending" } });
  const [row] = await rows("select email_status, email_attempts from register_alerts where alert_id = ?1", body.eventId);
  assert.equal(row.email_status, "pending"); assert.equal(row.email_attempts, 1);
  r.resend.mode = "ok";
  await r.scheduled(Date.now() + 10 * 60_000);
  assert.equal((await rows("select email_status from register_alerts where alert_id = ?1", body.eventId))[0].email_status, "sent");
  assert.ok(r.emails.some((e) => JSON.stringify(e.body).includes(body.eventId)));
  assert.equal((await r.post("/v1/alerts", body, { token: r.secrets.ALERT_TOKEN })).status, 200);
});

test("watchdog: day-3 and urgent day-5 deadline alerts, escalation recipients, no duplicates, completed requests ignored", async () => {
  const w = await startRegister();
  try {
    const day3 = intent({ receivedAt: new Date(Date.now() - 3.5 * DAY).toISOString() });
    const day5 = intent({ receivedAt: new Date(Date.now() - 5.5 * DAY).toISOString() });
    const done = intent({ receivedAt: new Date(Date.now() - 6 * DAY).toISOString() });
    const fresh = intent();
    for (const b of [day3, day5, done, fresh]) await w.post("/v1/events", b);
    await w.post("/v1/events", completion(done));
    await w.scheduled(Date.now()); await w.scheduled(Date.now() + 60_000);
    const alerts = (await w.db.prepare("select alert_id, code, urgent, email_status from register_alerts").all()).results;
    assert.deepEqual(alerts.map((a) => a.alert_id).sort(), [`${day3.eventId}:deadline_day3`, `${day5.eventId}:deadline_day5`].sort());
    assert.ok(alerts.every((a) => a.email_status === "sent"));
    const urgent = w.emails.find((e) => e.body.subject.startsWith("URGENT"));
    assert.deepEqual(urgent.body.to.sort(), ["deputy@example.com", "operator@example.com"]);
    assert.equal(w.emails.length, 2, "two runs, still exactly one email per alert");
    for (const e of w.emails) assert.doesNotMatch(JSON.stringify(e.body), new RegExp(day3.ownerId + "|" + day5.ownerId), "emails carry no owner id");
    const beat = (await w.db.prepare("select last_seen_at from register_heartbeats where source = 'watchdog'").first());
    assert.ok(beat);
  } finally { await w.dispose(); }
});

test("watchdog: missing VOOM heartbeat alerts once per day; a fresh heartbeat clears it", async () => {
  const w = await startRegister({ REQUIRE_VOOM_HEARTBEAT: "true" });
  try {
    await w.scheduled(Date.now()); await w.scheduled(Date.now() + 1000);
    assert.equal((await w.db.prepare("select count(*) n from register_alerts where code = 'heartbeat_missing'").first()).n, 1);
    assert.equal((await w.post("/v1/heartbeat", { version: 1, source: "voom" }, { key: null })).status, 200);
    const health = await (await w.mf.dispatchFetch("https://x.example.com/v1/health", { headers: { Authorization: `Bearer ${w.secrets.JOURNAL_TOKEN}` } })).json();
    assert.ok(health.voomLastHeartbeatAt && health.watchdogLastRunAt);
    await w.scheduled(Date.now() + 2 * DAY - 3600_000);
    assert.equal((await w.db.prepare("select count(*) n from register_alerts where code = 'heartbeat_missing'").first()).n, 2, "a new UTC day after >26h of silence alerts again");
  } finally { await w.dispose(); }
});

test("free-tier capacity: usage warnings at 50% and 80% of the configured daily write budget", async () => {
  const w = await startRegister({ DAILY_WRITE_BUDGET: "6" });
  try {
    for (let i = 0; i < 3; i++) await w.post("/v1/events", intent());
    await w.scheduled(Date.now());
    let codes = (await w.db.prepare("select alert_id from register_alerts where code = 'usage_warning'").all()).results.map((x) => x.alert_id);
    assert.equal(codes.length, 1); assert.match(codes[0], /:50$/);
    for (let i = 0; i < 3; i++) await w.post("/v1/events", intent());
    await w.scheduled(Date.now() + 1000);
    codes = (await w.db.prepare("select alert_id from register_alerts where code = 'usage_warning'").all()).results.map((x) => x.alert_id);
    assert.ok(codes.some((c) => /:80$/.test(c)));
  } finally { await w.dispose(); }
});

test("retention: nothing is purged without an approved period; approved purge is exact at the boundary and spares open requests", async () => {
  const keep = await startRegister();
  try {
    const b = intent(); await keep.post("/v1/events", b); await keep.post("/v1/events", completion(b));
    await keep.scheduled(Date.now() + 5000 * DAY);
    assert.equal((await keep.db.prepare("select count(*) n from register_records").first()).n, 2);
  } finally { await keep.dispose(); }
  const w = await startRegister({ RETENTION_DAYS: "400" });
  try {
    const doneReq = intent(); const openReq = intent();
    await w.post("/v1/events", doneReq); await w.post("/v1/events", completion(doneReq)); await w.post("/v1/events", openReq);
    await w.scheduled(Date.now() + 400 * DAY - 3600_000);
    assert.equal((await w.db.prepare("select count(*) n from register_records").first()).n, 3, "not yet past the approved period");
    await w.scheduled(Date.now() + 400 * DAY + 3600_000);
    const left = (await w.db.prepare("select record_id from register_records").all()).results.map((x) => x.record_id);
    assert.deepEqual(left, [openReq.eventId], "the completed request is purged; the open one never is");
    assert.equal((await w.db.prepare("select purge_open from register_control").first()).purge_open, 0, "the purge gate is closed again");
    await assert.rejects(w.db.prepare("delete from register_records").run(), /register_append_only/);
  } finally { await w.dispose(); }
  const bad = await startRegister({ RETENTION_DAYS: "7" });
  try {
    const b = intent(); await bad.post("/v1/events", b); await bad.post("/v1/events", completion(b));
    assert.equal((await bad.scheduled(Date.now() + 30 * DAY)).outcome, "exception", "the cron run fails visibly");
    assert.equal((await bad.db.prepare("select count(*) n from register_records").first()).n, 2, "an unapproved short period purges nothing");
  } finally { await bad.dispose(); }
});

test("operator export/lookup: replay token only, paginated, minimal fields", async () => {
  const w = await startRegister();
  try {
    const items = Array.from({ length: 5 }, () => intent());
    for (const b of items) await w.post("/v1/events", b);
    const token = w.secrets.REPLAY_TOKEN;
    const seen = []; let after = null;
    do {
      const page = await (await w.post("/v1/export", { since: new Date(Date.now() - DAY).toISOString(), after, limit: 2 }, { token, key: null })).json();
      seen.push(...page.records); after = page.next;
    } while (after);
    assert.equal(seen.length, 5);
    assert.deepEqual(Object.keys(seen[0]).sort(), ["applied_at", "cutoff_at", "kind", "owner_id", "receipt_id", "received_at", "record_id", "request_id", "scope"]);
    const found = await (await w.post("/v1/lookup", { recordIds: [items[0].eventId, crypto.randomUUID()] }, { token, key: null })).json();
    assert.deepEqual(Object.keys(found.found), [items[0].eventId]);
  } finally { await w.dispose(); }
});

test("database outage or exhausted D1 daily limit: never a success acknowledgement", async () => {
  const mod = await import(compiledPath);
  const token = "t".repeat(48);
  const broken = { prepare: () => ({ bind() { return this; }, run: async () => { throw new Error("D1_ERROR: daily limit exceeded"); },
    all: async () => { throw new Error("D1_ERROR"); }, first: async () => { throw new Error("D1_ERROR"); } }),
    batch: async () => { throw new Error("D1_ERROR: Exceeded maximum daily rows written"); } };
  const body = intent();
  const res = await mod.handle(new Request("https://x.example.com/v1/events", { method: "POST", body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": body.eventId } }), { DB: broken, JOURNAL_TOKEN: token });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "register_unavailable" }, "no internal error text is echoed");
  const a = alert(crypto.randomUUID());
  const res2 = await mod.handle(new Request("https://x.example.com/v1/alerts", { method: "POST", body: JSON.stringify(a),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": a.eventId } }), { DB: broken, ALERT_TOKEN: token });
  assert.equal(res2.status, 503);
});
