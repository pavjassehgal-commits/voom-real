import "server-only";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface DeletionEvent {
  id: string;
  owner_user_id: string;
  scope: "erase" | "retention";
  requested_at: string;
  cutoff_at: string | null;
  journal_receipt: string | null;
  failure_code: string | null;
  failed_at: string | null;
  alerted_at: string | null;
  claim: string;
  applied_at: string | null;
  completion_receipt: string | null;
}
export interface DeletionTransport {
  journal(event: DeletionEvent): Promise<string>;
  alert(event: DeletionEvent, code: string): Promise<void>;
  complete(event: DeletionEvent): Promise<string>;
}
class DeliveryError extends Error {
  readonly code: "destination_unavailable" | "capture_failed";
  constructor(code: "destination_unavailable" | "capture_failed") { super("youtube_deletion_" + code); this.code = code; }
}
type Endpoint = { url: string; token: string };

function endpoint(url: string | undefined, token: string | undefined): Endpoint | null {
  try {
    const parsed = new URL(url ?? "");
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || parsed.port && parsed.port !== "443" || parsed.username || parsed.password
      || parsed.search || parsed.hash || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".")
      || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || !token || token.length < 32 || /[\r\n]/.test(token)) return null;
    return { url: parsed.toString(), token };
  } catch { return null; }
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function timestamp(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new DeliveryError("capture_failed");
  return new Date(time).toISOString();
}
/** Minimal immutable restore intent, NOT tokens, provider IDs, titles or media. */
export function journalEnvelope(event: DeletionEvent) {
  if (!/^[a-f0-9-]{36}$/i.test(event.id) || !/^[a-f0-9-]{36}$/i.test(event.owner_user_id)
    || !["erase", "retention"].includes(event.scope) || (event.scope === "retention") !== Boolean(event.cutoff_at)) throw new DeliveryError("capture_failed");
  return {
    version: 1, eventId: event.id, ownerId: event.owner_user_id, scope: event.scope,
    receivedAt: timestamp(event.requested_at),
    deadlineAt: event.scope === "erase" ? new Date(Date.parse(event.requested_at) + 7 * 86400_000).toISOString() : null,
    cutoffAt: event.cutoff_at ? timestamp(event.cutoff_at) : null,
  };
}

async function send(target: Endpoint, id: string, body: unknown, request: typeof fetch): Promise<string> {
  const serialized = JSON.stringify(body), hash = digest(serialized);
  try {
    const response = await request(target.url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000), cache: "no-store",
      headers: { Authorization: "Bearer " + target.token, "Content-Type": "application/json", "Idempotency-Key": id },
      body: serialized,
    });
    // A 2xx/202 alone is NOT an independent durable write acknowledgment.
    if (!response.ok || response.status === 202 || !response.body) {
      await response.body?.cancel();
      throw new DeliveryError("capture_failed");
    }
    const reader = response.body.getReader(); let size = 0, text = "";
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new DeliveryError("capture_failed"); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const receipt = JSON.parse(text);
    if (receipt.eventId !== id || receipt.payloadSha256 !== hash || receipt.durable !== true
      || typeof receipt.receiptId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(receipt.receiptId)) throw new DeliveryError("capture_failed");
    return receipt.receiptId;
  } catch { throw new DeliveryError("capture_failed"); } // Never echo URLs, bodies, tokens or provider messages.
}

/** No default endpoint, no secret creation, no sends without explicit approval flag. */
export function createDeletionTransport(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): DeletionTransport {
  const approved = env.YOUTUBE_DELETION_DELIVERY_APPROVED === "true";
  const journal = endpoint(env.YOUTUBE_DELETION_JOURNAL_URL, env.YOUTUBE_DELETION_JOURNAL_TOKEN);
  const alert = endpoint(env.YOUTUBE_DELETION_ALERT_URL, env.YOUTUBE_DELETION_ALERT_TOKEN);
  return {
    async journal(event) {
      if (!approved || !journal || !alert) throw new DeliveryError("destination_unavailable");
      return send(journal, event.id, journalEnvelope(event), request);
    },
    async alert(event, code) {
      if (!approved || !alert) throw new DeliveryError("destination_unavailable");
      const id = event.id + ":" + code;
      // Stable across a lost response and retry; failure time is separately held locally.
      await send(alert, id, { version: 1, eventId: id, requestId: event.id, code, receivedAt: timestamp(event.requested_at) }, request);
    },
    async complete(event) {
      if (!approved || !journal || !alert || !event.applied_at) throw new DeliveryError("destination_unavailable");
      const id = event.id + ":active-erasure";
      return send(journal, id, { ...journalEnvelope(event), eventId: id, requestId: event.id,
        stage: "active_erasure", appliedAt: timestamp(event.applied_at),
        // This receipt never asserts Google revocation or backup-copy erasure.
      }, request);
    },
  };
}

/** Existing reconcile cadence retries the SAME event IDs; no new job/schedule. */
export async function deliverDeletionEvents(db: SupabaseClient, owner?: string, transport: DeletionTransport = createDeletionTransport()) {
  const claim = await db.rpc("claim_youtube_deletion_events", { p_limit: 5, p_owner: owner ?? null });
  if (claim.error) throw new Error("youtube_deletion_claim_failed");
  let recorded = 0, blocked = 0, alertsPending = 0;
  for (const event of (claim.data ?? []) as DeletionEvent[]) {
    let receipt: string | null = null, completion: string | null = null, failure: string | null = null, alerted = Boolean(event.alerted_at);
    if (!event.journal_receipt) {
      try { receipt = await transport.journal(event); recorded++; }
      catch (reason) { failure = reason instanceof DeliveryError ? reason.code : "capture_failed"; blocked++; }
    }
    if (event.applied_at && !event.completion_receipt && event.journal_receipt) {
      try { completion = await transport.complete(event); recorded++; }
      catch (reason) { failure = reason instanceof DeliveryError ? reason.code : "capture_failed"; blocked++; }
    }
    const code = failure ?? event.failure_code;
    if (failure && failure !== event.failure_code) alerted = false;
    if (code && !alerted) {
      try { await transport.alert(event, code); alerted = true; }
      catch { alertsPending++; }
    }
    const result = await db.rpc("finish_youtube_deletion_event", {
      p_id: event.id, p_owner: event.owner_user_id, p_claim: event.claim,
      p_receipt: receipt, p_completion: completion, p_alerted: alerted, p_failure: failure,
    });
    if (result.error || result.data !== true) {
      // DB acknowledgment loss must not silently look successful. The external
      // receiver deduplicates this alert even if its response is also lost.
      try { await transport.alert(event, "delivery_unconfirmed"); } catch { /* Health stays failed; independent monitoring is mandatory. */ }
      throw new Error("youtube_deletion_delivery_unconfirmed");
    }
  }
  return { recorded, blocked, alertsPending, ...await deletionDeliveryBacklog(db, owner) };
}

export async function deletionDeliveryBacklog(db: SupabaseClient, owner?: string) {
  let pendingQuery = db.from("youtube_deletion_events").select("id", { count: "exact", head: true })
    .is("completion_receipt", null);
  let alertsQuery = db.from("youtube_deletion_events").select("id", { count: "exact", head: true })
    .is("alerted_at", null).in("failure_code", ["destination_unavailable", "capture_failed", "erasure_failed"]);
  if (owner) { pendingQuery = pendingQuery.eq("owner_user_id", owner); alertsQuery = alertsQuery.eq("owner_user_id", owner); }
  const [pending, alerts] = await Promise.all([pendingQuery, alertsQuery]);
  if (pending.error || alerts.error) throw new Error("youtube_deletion_backlog_unavailable");
  return { pending: pending.count ?? 0, unalerted: alerts.count ?? 0 };
}
