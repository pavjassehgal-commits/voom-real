import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDeletionTransport, journalEnvelope, type DeletionEvent, type DeletionTransport } from "./deletion-delivery.ts";

/**
 * VOOM's side of the independent deletion register (workers/youtube-deletion-register):
 * cross-heartbeats, a direct fallback alert path, post-restore replay and
 * register reconciliation. Everything is inert unless delivery is approved.
 */
type Env = NodeJS.ProcessEnv;
const WATCHDOG_STALE_MS = 2 * 3600_000;

function registerOrigin(env: Env) {
  if (env.YOUTUBE_DELETION_DELIVERY_APPROVED !== "true") return null;
  try {
    const url = new URL(env.YOUTUBE_DELETION_JOURNAL_URL ?? "");
    return url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}

async function call(request: typeof fetch, url: string, token: string, method: "GET" | "POST", body?: unknown) {
  const response = await request(url, {
    method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("youtube_register_request_failed"); }
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Reports VOOM liveness to the register and checks the register's own watchdog
 * ran recently ("who watches the watchdog"). Returns a problem code or null.
 */
export async function checkDeletionRegister(env: Env = process.env, request: typeof fetch = fetch, now = Date.now()) {
  const origin = registerOrigin(env);
  if (!origin) return null;
  const token = env.YOUTUBE_DELETION_JOURNAL_TOKEN ?? "";
  try {
    await call(request, `${origin}/v1/heartbeat`, token, "POST", { version: 1, source: "voom" });
    const health = await call(request, `${origin}/v1/health`, token, "GET");
    const ran = Date.parse(String(health.watchdogLastRunAt ?? ""));
    if (!Number.isFinite(ran) || now - ran > WATCHDOG_STALE_MS) return "register_watchdog_stale";
    if (Number(health.pendingAlertEmails) > 0) return "register_alert_email_pending";
    return null;
  } catch { return "register_unreachable"; }
}

/**
 * Independent alert path when the register (or its alert email) is not working.
 * Uses VOOM's existing Resend account; at most one email per code per hour
 * (Resend idempotency key). Contains no personal data. Returns true if accepted.
 */
export async function sendFallbackDeletionAlert(code: string, env: Env = process.env, request: typeof fetch = fetch, now = Date.now()) {
  const to = (env.YOUTUBE_DELETION_FALLBACK_ALERT_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const key = env.EMAIL_PROVIDER_API_KEY, from = env.EMAIL_FROM_ADDRESS;
  if (!registerOrigin(env) || !to.length || !key || !from || !/^[a-z_]{3,40}$/.test(code)) return false;
  const hour = new Date(now).toISOString().slice(0, 13);
  try {
    const response = await request("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `voom-ydr-fallback-${code}-${hour}` },
      body: JSON.stringify({
        from: env.EMAIL_FROM_NAME ? `${env.EMAIL_FROM_NAME} <${from}>` : from, to,
        subject: `URGENT [VOOM YouTube deletion] ${code}`,
        text: `VOOM's YouTube deletion maintenance reported "${code}" at ${new Date(now).toISOString()}.\n`
          + "Deletion requests stay blocked (never falsely completed) until this is resolved.\n"
          + "Follow docs/youtube-deletion-register-runbook.md. This email contains no personal data.",
      }),
    });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

type RegisterRecord = { record_id: string; kind: "intent" | "completion"; request_id: string; owner_id: string; scope: "erase" | "retention";
  received_at: string; cutoff_at: string | null; applied_at: string | null; receipt_id: string };

/** Operator-only reader (replay token is never configured on Vercel). */
export function deletionRegisterReader(env: Env = process.env, request: typeof fetch = fetch) {
  const origin = registerOrigin(env);
  const token = env.YOUTUBE_DELETION_REPLAY_TOKEN ?? "";
  if (!origin || token.length < 32) throw new Error("youtube_register_reader_not_configured");
  return {
    async export(since: string, after: string | null, limit = 500) {
      const value = await call(request, `${origin}/v1/export`, token, "POST", { since, after, limit });
      return value as { records: RegisterRecord[]; next: string | null };
    },
    async lookup(recordIds: string[]) {
      const value = await call(request, `${origin}/v1/lookup`, token, "POST", { recordIds });
      return (value.found ?? {}) as Record<string, { payloadSha256: string; receiptId: string }>;
    },
  };
}
export type DeletionRegisterReader = ReturnType<typeof deletionRegisterReader>;

type MainEvent = { id: string; owner_user_id: string; scope: "erase" | "retention"; requested_at: string; cutoff_at: string | null;
  journal_receipt: string | null; recorded_at: string | null; applied_at: string | null; completion_receipt: string | null };
const asDeletionEvent = (row: MainEvent): DeletionEvent => ({ ...row, failure_code: null, failed_at: null, alerted_at: null, claim: "" });
const fingerprint = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

/**
 * Register-side loss (e.g. a D1 Time Travel restore): re-sends every VOOM-recorded
 * intent/completion the register no longer holds, with the SAME event ids.
 * A record present with a different fingerprint is reported, never overwritten.
 */
export async function reconcileDeletionRegister(db: SupabaseClient, reader: DeletionRegisterReader,
  transport: DeletionTransport = createDeletionTransport()) {
  const report = { checked: 0, intentsResent: 0, completionsResent: 0, conflicts: [] as string[], failures: [] as string[] };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await db.from("youtube_deletion_events")
      .select("id,owner_user_id,scope,requested_at,cutoff_at,journal_receipt,recorded_at,applied_at,completion_receipt")
      .gte("recorded_at", "1970-01-01T00:00:00Z").gt("id", after).order("id").limit(25); // recorded only
    if (page.error) throw new Error("youtube_register_reconcile_read_failed");
    const rows = (page.data ?? []) as MainEvent[];
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const ids = rows.flatMap((r) => r.completion_receipt ? [r.id, `${r.id}:active-erasure`] : [r.id]);
    const found = await reader.lookup(ids);
    for (const row of rows) {
      report.checked++;
      const event = asDeletionEvent(row);
      const intent = found[row.id];
      try {
        if (!intent) { await transport.journal(event); report.intentsResent++; }
        else if (intent.payloadSha256 !== fingerprint(journalEnvelope(event))) report.conflicts.push(row.id);
        if (row.completion_receipt && !found[`${row.id}:active-erasure`]) { await transport.complete(event); report.completionsResent++; }
      } catch { report.failures.push(row.id); }
    }
  }
  return report;
}

/**
 * Main-database restore: before YouTube workers resume, re-applies every erase
 * intent the register received after (restore point - 24h) that the restored
 * database does not already show as applied. Retention intents are re-derived
 * by the next maintenance run from their fixed 28-day rule.
 */
export async function replayDeletionRegisterAfterRestore(db: SupabaseClient, reader: DeletionRegisterReader, input: {
  restorePoint: Date;
  erase: (db: SupabaseClient, owner: string) => Promise<unknown>;
}) {
  const since = new Date(input.restorePoint.getTime() - 86_400_000).toISOString();
  const report = { intents: 0, alreadyApplied: 0, replayed: 0, retentionDeferred: 0, failed: [] as string[] };
  const owners = new Map<string, string>();
  let after: string | null = null;
  do {
    const page = await reader.export(since, after);
    for (const record of page.records) {
      if (record.kind !== "intent") continue;
      report.intents++;
      const local = await db.from("youtube_deletion_events").select("applied_at").eq("id", record.record_id).maybeSingle();
      if (local.error) throw new Error("youtube_register_replay_read_failed");
      if (local.data?.applied_at) { report.alreadyApplied++; continue; }
      if (record.scope === "retention") { report.retentionDeferred++; continue; }
      // An erasure completed (e.g. by an earlier replay) after this intent already satisfies it.
      const control = await db.from("youtube_privacy_controls").select("blocked,completed_at")
        .eq("owner_user_id", record.owner_id).maybeSingle();
      if (control.error) throw new Error("youtube_register_replay_read_failed");
      if (control.data?.blocked && control.data.completed_at && Date.parse(control.data.completed_at) >= Date.parse(record.received_at)) {
        report.alreadyApplied++; continue;
      }
      owners.set(record.owner_id, record.record_id);
    }
    after = page.next;
  } while (after);
  for (const [owner, requestId] of owners) {
    try { await input.erase(db, owner); report.replayed++; } catch { report.failed.push(requestId); }
  }
  return report;
}
