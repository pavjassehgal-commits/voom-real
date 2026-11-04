/**
 * VOOM independent YouTube deletion register — Cloudflare Worker + D1.
 *
 * Implements the receiving side of the 0069 outbox contract
 * (lib/youtube/deletion-delivery.ts):
 *   POST /v1/events   intent + active-erasure completion (journal token)
 *   POST /v1/alerts   failure alerts, emailed through Resend (alert token)
 *   POST /v1/heartbeat, GET /v1/health   VOOM <-> watchdog cross-checks (journal token)
 *   POST /v1/export, POST /v1/lookup     restore replay / reconciliation (replay token, operator only)
 * and an hourly scheduled watchdog.
 *
 * A success response ({eventId, payloadSha256, durable: true, receiptId}) is
 * returned ONLY after the record is committed in D1. Every failure is a
 * non-2xx response, which VOOM treats as "not recorded" and retries with the
 * same event id. No Google tokens, channel/video IDs or contact details are
 * accepted or stored. Self-contained types: no Workers type package needed.
 */

export interface D1Result<T = Record<string, unknown>> { results: T[]; success: boolean }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export interface Env {
  DB: D1Database;
  JOURNAL_TOKEN?: string;
  JOURNAL_TOKEN_NEXT?: string;
  ALERT_TOKEN?: string;
  ALERT_TOKEN_NEXT?: string;
  REPLAY_TOKEN?: string;
  REPLAY_TOKEN_NEXT?: string;
  RESEND_API_KEY?: string;
  ALERT_FROM?: string;
  ALERT_TO?: string;
  ALERT_ESCALATE_TO?: string;
  /** Non-production label shown in the alert subject (e.g. "STAGING"); empty in Production. */
  ALERT_ENVIRONMENT?: string;
  /** Approved retention in whole days. Unset = keep everything (no purge). */
  RETENTION_DAYS?: string;
  /** Daily D1 rows-written allowance to warn against (Free plan: 100000). */
  DAILY_WRITE_BUDGET?: string;
  /** "true" once VOOM Production sends heartbeats; before that, absence is expected. */
  REQUIRE_VOOM_HEARTBEAT?: string;
}
interface ScheduledEventLike { scheduledTime: number }

const MAX_BODY = 4096;
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const VOOM_ALERT_CODES = ["destination_unavailable", "capture_failed", "erasure_failed", "delivery_unconfirmed"] as const;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (status: number, code: string): never => { throw new HttpError(status, code); };

function hex(buffer: ArrayBuffer) { return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
export async function sha256(text: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))); }

/** Constant-time comparison of SHA-256 digests; accepts the current and the staged next token. */
async function authorized(header: string | null, ...tokens: (string | undefined)[]) {
  const presented = /^Bearer (\S{32,512})$/.exec(header ?? "")?.[1];
  if (!presented) return false;
  const given = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(presented)));
  let ok = false;
  for (const token of tokens) {
    if (!token || token.length < 32) continue;
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
    ok = ok || diff === 0;
  }
  return ok;
}

/** Bounded body read: rejects missing/oversized bodies without buffering more than the cap. */
async function readBody(request: Request) {
  if (!/^application\/json(;|$)/i.test(request.headers.get("content-type") ?? "")) fail(415, "json_required");
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > MAX_BODY) fail(413, "body_too_large");
  if (!request.body) fail(400, "body_required");
  const reader = request.body!.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); fail(413, "body_too_large"); }
    try { text += decoder.decode(part.value, { stream: true }); } catch { fail(400, "invalid_utf8"); }
  }
  text += decoder.decode();
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail(400, "invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_body");
  return { text, value: value as Record<string, unknown> };
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort().join(",");
  if (actual !== [...keys].sort().join(",")) fail(422, "unexpected_fields");
}
function iso(value: unknown, field: string) {
  if (typeof value !== "string" || !ISO.test(value) || new Date(value).toISOString() !== value) fail(422, `invalid_${field}`);
  return value as string;
}
function uuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID.test(value)) fail(422, `invalid_${field}`);
  return value as string;
}

const INTENT_KEYS = ["version", "eventId", "ownerId", "scope", "receivedAt", "deadlineAt", "cutoffAt"];
interface Envelope { eventId: string; ownerId: string; scope: "erase" | "retention"; receivedAt: string; deadlineAt: string | null; cutoffAt: string | null }

/** Mirrors journalEnvelope() in lib/youtube/deletion-delivery.ts exactly. */
function envelope(body: Record<string, unknown>, now: number): Envelope {
  if (body.version !== 1) fail(422, "invalid_version");
  const ownerId = uuid(body.ownerId, "owner");
  const scope = body.scope;
  if (scope !== "erase" && scope !== "retention") fail(422, "invalid_scope");
  const receivedAt = iso(body.receivedAt, "received_at");
  if (Date.parse(receivedAt) > now + 5 * 60_000) fail(422, "received_at_in_future");
  let deadlineAt: string | null = null, cutoffAt: string | null = null;
  if (scope === "erase") {
    deadlineAt = iso(body.deadlineAt, "deadline_at");
    if (Date.parse(deadlineAt) !== Date.parse(receivedAt) + 7 * DAY) fail(422, "deadline_mismatch");
    if (body.cutoffAt !== null) fail(422, "unexpected_cutoff");
  } else {
    if (body.deadlineAt !== null) fail(422, "unexpected_deadline");
    cutoffAt = iso(body.cutoffAt, "cutoff_at");
  }
  return { eventId: String(body.eventId), ownerId, scope: scope as Envelope["scope"], receivedAt, deadlineAt, cutoffAt };
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const usage = (db: D1Database, now: number) =>
  db.prepare("insert into register_usage (day, writes) values (?1, 1) on conflict (day) do update set writes = writes + 1").bind(today(now));

/** Deterministic receipt: the same record + fingerprint always yields the same receipt. */
async function receiptFor(recordId: string, fingerprint: string) { return "vdr_" + (await sha256(recordId + "\n" + fingerprint)).slice(0, 40); }

async function storeRecord(env: Env, request: Request, now: number) {
  if (!(await authorized(request.headers.get("authorization"), env.JOURNAL_TOKEN, env.JOURNAL_TOKEN_NEXT))) fail(401, "unauthorized");
  const { text, value } = await readBody(request);
  const fingerprint = await sha256(text);
  const stamp = new Date(now).toISOString();
  let recordId: string, statement: D1PreparedStatement;
  if ("stage" in value) {
    exactKeys(value, [...INTENT_KEYS, "requestId", "stage", "appliedAt"]);
    const requestId = uuid(value.requestId, "request_id");
    if (value.stage !== "active_erasure" || value.eventId !== `${requestId}:active-erasure`) fail(422, "invalid_completion");
    const env0 = envelope({ ...value, eventId: requestId }, now);
    const appliedAt = iso(value.appliedAt, "applied_at");
    recordId = `${requestId}:active-erasure`;
    // Completion is accepted only for a matching recorded intent (same owner, scope, receipt time, cutoff).
    statement = env.DB.prepare(`insert into register_records
        (record_id, kind, request_id, owner_id, scope, received_at, deadline_at, cutoff_at, applied_at, payload_sha256, receipt_id, stored_at)
      select ?1, 'completion', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 from register_records
      where record_id = ?2 and kind = 'intent' and owner_id = ?3 and scope = ?4 and received_at = ?5 and cutoff_at is ?7
      on conflict (record_id) do nothing`)
      .bind(recordId, requestId, env0.ownerId, env0.scope, env0.receivedAt, env0.deadlineAt, env0.cutoffAt, appliedAt, fingerprint, await receiptFor(recordId, fingerprint), stamp);
  } else {
    exactKeys(value, INTENT_KEYS);
    const env0 = envelope(value, now);
    recordId = uuid(value.eventId, "event_id");
    statement = env.DB.prepare(`insert into register_records
        (record_id, kind, request_id, owner_id, scope, received_at, deadline_at, cutoff_at, applied_at, payload_sha256, receipt_id, stored_at)
      values (?1, 'intent', ?1, ?2, ?3, ?4, ?5, ?6, null, ?7, ?8, ?9) on conflict (record_id) do nothing`)
      .bind(recordId, env0.ownerId, env0.scope, env0.receivedAt, env0.deadlineAt, env0.cutoffAt, fingerprint, await receiptFor(recordId, fingerprint), stamp);
  }
  if (request.headers.get("idempotency-key") !== recordId) fail(422, "idempotency_key_mismatch");
  // One D1 batch = one transaction: insert-or-keep, count usage, read back what is durably stored.
  const [, , stored] = await persist(env.DB, [statement, usage(env.DB, now),
    env.DB.prepare("select payload_sha256, receipt_id from register_records where record_id = ?1").bind(recordId)]);
  const row = stored.results[0] as { payload_sha256: string; receipt_id: string } | undefined;
  if (!row) fail(409, "intent_not_recorded");
  if (row!.payload_sha256 !== fingerprint) fail(409, "conflicting_payload");
  return reply(200, { eventId: recordId, payloadSha256: fingerprint, durable: true, receiptId: row!.receipt_id });
}

async function persist(db: D1Database, statements: D1PreparedStatement[]) {
  try { return await db.batch(statements); }
  catch { throw new HttpError(503, "register_unavailable"); } // Never acknowledge an unconfirmed write.
}

interface AlertRow { alert_id: string; request_id: string; code: string; source: string; received_at: string | null; urgent: number;
  payload_sha256: string; receipt_id: string; email_status: string; email_attempts: number }

async function storeAlert(env: Env, request: Request, now: number) {
  if (!(await authorized(request.headers.get("authorization"), env.ALERT_TOKEN, env.ALERT_TOKEN_NEXT))) fail(401, "unauthorized");
  const { text, value } = await readBody(request);
  exactKeys(value, ["version", "eventId", "requestId", "code", "receivedAt"]);
  if (value.version !== 1) fail(422, "invalid_version");
  const requestId = uuid(value.requestId, "request_id");
  if (!VOOM_ALERT_CODES.includes(value.code as typeof VOOM_ALERT_CODES[number])) fail(422, "invalid_code");
  const alertId = `${requestId}:${value.code}`;
  if (value.eventId !== alertId || request.headers.get("idempotency-key") !== alertId) fail(422, "idempotency_key_mismatch");
  const receivedAt = iso(value.receivedAt, "received_at");
  const fingerprint = await sha256(text);
  const row = await recordAlert(env, { alertId, requestId, code: String(value.code), source: "voom", receivedAt, urgent: false, fingerprint }, now);
  if (row.payload_sha256 !== fingerprint) fail(409, "conflicting_payload");
  // The alert is durably recorded; acknowledge only once a human notification has been accepted.
  if (row.email_status !== "sent" && !(await emailAlert(env, row, now))) fail(503, "alert_email_pending");
  return reply(200, { eventId: alertId, payloadSha256: fingerprint, durable: true, receiptId: row.receipt_id });
}

async function recordAlert(env: Env, a: { alertId: string; requestId: string; code: string; source: "voom" | "watchdog"; receivedAt: string | null; urgent: boolean; fingerprint: string }, now: number) {
  const stamp = new Date(now).toISOString();
  const [, , stored] = await persist(env.DB, [
    env.DB.prepare(`insert into register_alerts (alert_id, request_id, code, source, received_at, urgent, payload_sha256, receipt_id, stored_at, next_email_at)
      values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) on conflict (alert_id) do nothing`)
      .bind(a.alertId, a.requestId, a.code, a.source, a.receivedAt, a.urgent ? 1 : 0, a.fingerprint, await receiptFor(a.alertId, a.fingerprint), stamp),
    usage(env.DB, now),
    env.DB.prepare("select * from register_alerts where alert_id = ?1").bind(a.alertId),
  ]);
  return stored.results[0] as unknown as AlertRow;
}

const ALERT_TEXT: Record<string, string> = {
  destination_unavailable: "VOOM could not reach the deletion register. The user's YouTube access is blocked; erasure waits for a recorded intent.",
  capture_failed: "The deletion register did not durably confirm a record. Erasure waits; VOOM retries with the same event id.",
  erasure_failed: "VOOM recorded the request but the database erasure failed and rolled back. Maintenance retries; check the runbook.",
  delivery_unconfirmed: "VOOM could not confirm its own outbox update after delivery. Verify the event in VOOM and in the register.",
  deadline_day3: "An erase request has no completion after 3 days (deadline: 7 days). Act today.",
  deadline_day5: "URGENT: an erase request has no completion after 5 days (deadline: 7 days). Escalate now.",
  retention_stalled: "A retention purge has no completion after 2 days.",
  heartbeat_missing: "VOOM Production has not checked in for over 26 hours. Its deletion maintenance may be stopped.",
  usage_warning: "The register is approaching its daily Cloudflare Free write allowance.",
};

/** Resend send with the alert id as idempotency key; returns true only on acceptance. */
async function emailAlert(env: Env, row: AlertRow, now: number) {
  const to = (env.ALERT_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const escalate = row.urgent ? (env.ALERT_ESCALATE_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const label = (env.ALERT_ENVIRONMENT ?? "").replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 20);
  let accepted = false;
  if (env.RESEND_API_KEY && env.ALERT_FROM && to.length) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `vdr-alert-${await sha256(row.alert_id)}` },
        body: JSON.stringify({
          from: env.ALERT_FROM, to: [...new Set([...to, ...escalate])],
          subject: `${row.urgent ? "URGENT " : ""}[VOOM YouTube deletion${label ? ` · ${label}` : ""}] ${row.code}`,
          text: [ALERT_TEXT[row.code] ?? "Deletion register alert.", "", `Alert: ${row.alert_id}`, `Request: ${row.request_id}`,
            `Original receipt: ${row.received_at ?? "n/a"}`, "", "Follow docs/youtube-deletion-register-runbook.md. Look up the request in the register (D1) — this email intentionally contains no personal data."].join("\n"),
        }),
      });
      accepted = response.ok;
      await response.body?.cancel();
    } catch { accepted = false; }
  }
  const stamp = new Date(now).toISOString();
  const retry = new Date(now + Math.min(3600_000, 60_000 * 2 ** Math.min(row.email_attempts, 6))).toISOString();
  await env.DB.prepare(`update register_alerts set email_attempts = email_attempts + 1,
      email_status = case when ?2 then 'sent' else email_status end, email_sent_at = case when ?2 then ?3 else email_sent_at end,
      next_email_at = case when ?2 then next_email_at else ?4 end where alert_id = ?1`)
    .bind(row.alert_id, accepted ? 1 : 0, stamp, retry).run().catch(() => undefined);
  return accepted;
}

async function heartbeat(env: Env, request: Request, now: number) {
  if (!(await authorized(request.headers.get("authorization"), env.JOURNAL_TOKEN, env.JOURNAL_TOKEN_NEXT))) fail(401, "unauthorized");
  const { value } = await readBody(request);
  exactKeys(value, ["version", "source"]);
  if (value.version !== 1 || value.source !== "voom") fail(422, "invalid_heartbeat");
  await persist(env.DB, [env.DB.prepare("insert into register_heartbeats (source, last_seen_at) values ('voom', ?1) on conflict (source) do update set last_seen_at = ?1")
    .bind(new Date(now).toISOString())]);
  return reply(200, { ok: true });
}

async function health(env: Env, request: Request) {
  if (!(await authorized(request.headers.get("authorization"), env.JOURNAL_TOKEN, env.JOURNAL_TOKEN_NEXT))) fail(401, "unauthorized");
  const [beats, pending] = await persist(env.DB, [
    env.DB.prepare("select source, last_seen_at from register_heartbeats"),
    env.DB.prepare("select count(*) as n from register_alerts where email_status = 'pending'"),
  ]);
  const seen = Object.fromEntries((beats.results as { source: string; last_seen_at: string }[]).map((r) => [r.source, r.last_seen_at]));
  return reply(200, { watchdogLastRunAt: seen.watchdog ?? null, voomLastHeartbeatAt: seen.voom ?? null,
    pendingAlertEmails: Number((pending.results[0] as { n: number }).n) });
}

/** Operator-only: intents/completions received at or after `since`, keyset-paginated. */
async function exportRecords(env: Env, request: Request) {
  if (!(await authorized(request.headers.get("authorization"), env.REPLAY_TOKEN, env.REPLAY_TOKEN_NEXT))) fail(401, "unauthorized");
  const { value } = await readBody(request);
  exactKeys(value, ["since", "after", "limit"]);
  const since = iso(value.since, "since");
  const after = value.after === null ? "" : String(value.after);
  const limit = Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail(422, "invalid_limit");
  const [result] = await persist(env.DB, [env.DB.prepare(`select record_id, kind, request_id, owner_id, scope, received_at, cutoff_at, applied_at, receipt_id
      from register_records where received_at >= ?1 and record_id > ?2 order by record_id limit ?3`).bind(since, after, limit)]);
  const records = result.results as Record<string, unknown>[];
  return reply(200, { records, next: records.length === limit ? records[records.length - 1].record_id : null });
}

async function lookup(env: Env, request: Request) {
  if (!(await authorized(request.headers.get("authorization"), env.REPLAY_TOKEN, env.REPLAY_TOKEN_NEXT))) fail(401, "unauthorized");
  const { value } = await readBody(request);
  exactKeys(value, ["recordIds"]);
  const ids = value.recordIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}(:active-erasure)?$/.test(id))) fail(422, "invalid_record_ids");
  const [result] = await persist(env.DB, [env.DB.prepare(`select record_id, payload_sha256, receipt_id from register_records
      where record_id in (select value from json_each(?1))`).bind(JSON.stringify(ids))]);
  return reply(200, { found: Object.fromEntries((result.results as { record_id: string; payload_sha256: string; receipt_id: string }[])
    .map((r) => [r.record_id, { payloadSha256: r.payload_sha256, receiptId: r.receipt_id }])) });
}

export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  try {
    const { pathname } = new URL(request.url);
    const routes: Record<string, [string, (env: Env, request: Request, now: number) => Promise<Response>]> = {
      "/v1/events": ["POST", storeRecord], "/v1/alerts": ["POST", storeAlert], "/v1/heartbeat": ["POST", heartbeat],
      "/v1/health": ["GET", (e, r) => health(e, r)], "/v1/export": ["POST", (e, r) => exportRecords(e, r)], "/v1/lookup": ["POST", (e, r) => lookup(e, r)],
    };
    const route = routes[pathname];
    if (!route) return reply(404, { error: "not_found" });
    if (request.method !== route[0]) return reply(405, { error: "method_not_allowed" });
    return await route[1](env, request, now);
  } catch (reason) {
    // Never echo request content, SQL or provider errors.
    return reason instanceof HttpError ? reply(reason.status, { error: reason.code }) : reply(503, { error: "register_unavailable" });
  }
}

/** Hourly watchdog. Bounded to stay within Free-plan query/subrequest limits per invocation. */
export async function watchdog(env: Env, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const report = { created: 0, emailed: 0, purged: 0 };
  await env.DB.prepare("insert into register_heartbeats (source, last_seen_at) values ('watchdog', ?1) on conflict (source) do update set last_seen_at = ?1").bind(stamp).run();
  const open = await env.DB.prepare(`select i.request_id, i.scope, i.received_at from register_records i
      where i.kind = 'intent' and i.received_at <= ?1
        and not exists (select 1 from register_records c where c.request_id = i.request_id and c.kind = 'completion')
      order by i.received_at limit 20`).bind(new Date(now - 2 * DAY).toISOString()).all<{ request_id: string; scope: string; received_at: string }>();
  const pending: { key: string; requestId: string; code: string; urgent: boolean; receivedAt: string | null }[] = [];
  for (const r of open.results) {
    const age = now - Date.parse(r.received_at);
    if (r.scope === "retention") pending.push({ key: `${r.request_id}:retention_stalled`, requestId: r.request_id, code: "retention_stalled", urgent: false, receivedAt: r.received_at });
    else if (age >= 5 * DAY) pending.push({ key: `${r.request_id}:deadline_day5`, requestId: r.request_id, code: "deadline_day5", urgent: true, receivedAt: r.received_at });
    else if (age >= 3 * DAY) pending.push({ key: `${r.request_id}:deadline_day3`, requestId: r.request_id, code: "deadline_day3", urgent: false, receivedAt: r.received_at });
  }
  if (env.REQUIRE_VOOM_HEARTBEAT === "true") {
    const beat = await env.DB.prepare("select last_seen_at from register_heartbeats where source = 'voom'").first<{ last_seen_at: string }>();
    if (!beat || now - Date.parse(beat.last_seen_at) > 26 * 3600_000) pending.push({ key: `heartbeat_missing:${today(now)}`, requestId: "voom-heartbeat", code: "heartbeat_missing", urgent: true, receivedAt: beat?.last_seen_at ?? null });
  }
  const budget = Number(env.DAILY_WRITE_BUDGET ?? "100000");
  const used = (await env.DB.prepare("select writes from register_usage where day = ?1").bind(today(now)).first<{ writes: number }>())?.writes ?? 0;
  for (const pct of [80, 50]) if (budget > 0 && used >= (budget * pct) / 100) { pending.push({ key: `usage_warning:${today(now)}:${pct}`, requestId: "register-usage", code: "usage_warning", urgent: pct >= 80, receivedAt: null }); break; }
  for (const p of pending.slice(0, 12)) {
    const before = await env.DB.prepare("select 1 as present from register_alerts where alert_id = ?1").bind(p.key).first();
    await recordAlert(env, { alertId: p.key, requestId: p.requestId, code: p.code, source: "watchdog", receivedAt: p.receivedAt, urgent: p.urgent,
      fingerprint: await sha256(JSON.stringify({ alertId: p.key, code: p.code, requestId: p.requestId })) }, now);
    if (!before) report.created++;
  }
  const due = await env.DB.prepare("select * from register_alerts where email_status = 'pending' and next_email_at <= ?1 order by next_email_at limit 8").bind(stamp).all<AlertRow>();
  for (const row of due.results) if (await emailAlert(env, row, now)) report.emailed++;
  const days = env.RETENTION_DAYS?.trim();
  if (days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 30) throw new Error("invalid_retention_days");
    // Purge a whole request only after it completed and its completion is older than the approved period.
    const cutoff = new Date(now - n * DAY).toISOString();
    const [, gone] = await env.DB.batch([
      env.DB.prepare("update register_control set purge_open = 1 where id = 1"),
      env.DB.prepare(`delete from register_records where request_id in (select request_id from register_records
          where kind = 'completion' and stored_at < ?1 limit 200)`).bind(cutoff),
      env.DB.prepare("delete from register_alerts where stored_at < ?1 and email_status = 'sent'").bind(cutoff),
      env.DB.prepare("update register_control set purge_open = 0 where id = 1"),
    ]);
    report.purged = Number((gone as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0);
  }
  return report;
}

const worker = {
  fetch: (request: Request, env: Env) => handle(request, env),
  // Awaited (not waitUntil) so a failure is recorded as a failed cron invocation.
  scheduled: async (event: ScheduledEventLike, env: Env) => { await watchdog(env, event.scheduledTime); },
};
export default worker;
