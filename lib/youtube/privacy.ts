import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptYouTubeToken, type YouTubeKeyInput } from "./crypto.ts";
import { YouTubeApiError, YouTubeClient } from "./client.ts";
import { readYouTubeConfig, youTubeKeyRing, type YouTubeConfig } from "./config.ts";
import { deletionDeliveryBacklog, deliverDeletionEvents } from "./deletion-delivery.ts";
import { createDeletionTransport } from "./deletion-transport.ts";
import { checkDeletionRegister, sendFallbackDeletionAlert } from "./deletion-register.ts";

type Revocation = { id: string; claim: string; encrypted_token: string; iv: string; auth_tag: string; expires_at: string };

/** A generic 403/app configuration failure is NOT proof of withdrawn consent. */
export function confirmedYouTubeAuthorizationLoss(reason: unknown): boolean {
  if (!(reason instanceof YouTubeApiError) || reason.kind !== "auth") return false;
  return reason.httpStatus === 401 || ["invalid_grant","insufficientPermissions","authError","invalidCredentials","authorization_revoked"].includes(reason.reason ?? "");
}

/** Ciphertext-only, leased outbox. Failure never restores local authorization. */
export async function retryYouTubeRevocations(db: SupabaseClient, key: YouTubeKeyInput, client: Pick<YouTubeClient,"revokeToken">, owner?: string, limit = 2) {
  const claimed = await db.rpc("claim_youtube_revocation_tasks", { p_limit: limit, p_owner: owner ?? null });
  if (claimed.error) throw new Error("youtube_revocation_claim_failed");
  let completed = 0;
  for (const task of (claimed.data ?? []) as Revocation[]) {
    let success = false;
    try {
      // The SQL lease can arrive just before the six-day expiry. Recheck
      // immediately before decrypting/using it; missing dates fail closed.
      if (Date.parse(task.expires_at) > Date.now()) {
        const token = decryptYouTubeToken({ encryptedToken: task.encrypted_token, iv: task.iv, authTag: task.auth_tag }, key);
        success = await client.revokeToken(token);
      }
    } catch { /* A temporary outage or key problem is retried from durable state. */ }
    const result = await db.rpc("finish_youtube_revocation", { p_id: task.id, p_claim: task.claim, p_success: success });
    if (result.error || result.data !== true) throw new Error("youtube_revocation_receipt_failed");
    if (success) completed++;
  }
  return { attempted: (claimed.data ?? []).length, completed };
}

export async function eraseYouTubeData(db: SupabaseClient, owner: string, revoke = true, epoch?: string) {
  const expected = epoch ? {p_expected_epoch:epoch} : {};
  const requested = await db.rpc("request_youtube_erasure", { p_owner_user_id: owner, ...expected });
  if (requested.error || requested.data !== true) throw new Error("youtube_erasure_request_failed");
  // Request/block committed first. A missing independent receipt cannot authorize erasure.
  await deliverDeletionEvents(db, owner, createDeletionTransport());
  const control = await db.from("youtube_privacy_controls").select("deletion_event_id").eq("owner_user_id", owner).maybeSingle();
  if (control.error || !control.data?.deletion_event_id) throw new Error("youtube_deletion_capture_pending");
  const eventId = control.data.deletion_event_id;
  const captured = await db.from("youtube_deletion_events").select("recorded_at").eq("id", eventId).eq("owner_user_id", owner).maybeSingle();
  if (captured.error || !captured.data?.recorded_at) throw new Error("youtube_deletion_capture_pending");
  const { data, error } = await db.rpc("erase_youtube_data", { p_owner_user_id: owner, p_revoke: revoke, ...expected });
  if (error || !data?.erased) {
    // Persist an actionable failure without ever copying SQL/provider error text.
    const flagged = await db.rpc("flag_youtube_deletion_failure", { p_owner: owner });
    if (flagged.error) throw new Error("youtube_erasure_failure_record_failed");
    await deliverDeletionEvents(db, owner, createDeletionTransport());
    throw new Error("youtube_erasure_failed");
  }
  await deliverDeletionEvents(db, owner, createDeletionTransport());
  const completed = await db.from("youtube_deletion_events").select("completion_receipt").eq("id", eventId).eq("owner_user_id", owner).maybeSingle();
  if (completed.error || !completed.data?.completion_receipt) throw new Error("youtube_deletion_delivery_pending");
  return { erased: true as const, revocationPending: data.revocationPending === true };
}

/** Fail closed on stale credentials or a grant replaced during an async run. */
export async function assertYouTubeGrant(db: SupabaseClient, owner: string, epoch?: string) {
  const privacy = await db.from("youtube_privacy_controls").select("blocked").eq("owner_user_id",owner).maybeSingle();
  if (privacy.error || privacy.data?.blocked) throw new YouTubeApiError("auth","token_refresh","authorization_revoked");
  const { data, error } = await db.from("youtube_connections").select("id,authorization_epoch,status").eq("owner_user_id",owner).maybeSingle();
  const current = data ? `${data.id}:${data.authorization_epoch}` : null;
  if (error || data?.status !== "connected" || (epoch && current !== epoch)) {
    throw new YouTubeApiError("auth", "token_refresh", "authorization_revoked");
  }
  return current!;
}

/** A check before EACH provider method, including later chunks/polls. No token logging. */
export function guardYouTubeClient(client: YouTubeClient, db: SupabaseClient, owner: string, epoch: string): YouTubeClient {
  return new Proxy(client, { get(target, property) {
    const value = Reflect.get(target,property);
    if (typeof value !== "function") return value;
    return async (...args: unknown[]) => {
      await assertYouTubeGrant(db,owner,epoch);
      let result;
      try { result = await value.apply(target,args); }
      catch (reason) {
        if (confirmedYouTubeAuthorizationLoss(reason)) {
          await eraseYouTubeData(db,owner,false,epoch);
        }
        throw reason;
      }
      await assertYouTubeGrant(db,owner,epoch);
      return result;
    };
  } });
}

/** Reuses /api/cron/youtube-reconcile: no new scheduled job or publishing call. */
export async function runYouTubePrivacyMaintenance(input: {
  db?: SupabaseClient; config?: YouTubeConfig | null; client?: YouTubeClient; now?: Date;
} = {}) {
  const db = input.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  const config = input.config === undefined ? readYouTubeConfig() : input.config;
  const now = input.now ?? new Date();
  const prepared = await db.rpc("prepare_youtube_deletion_events", { p_limit: 25 });
  if (prepared.error) throw new Error("youtube_deletion_prepare_failed");
  await deliverDeletionEvents(db, undefined, createDeletionTransport());
  // Only independently recorded intents may erase; credential expiry still runs.
  const pruned = await db.rpc("prune_youtube_api_data", { p_limit: 25 });
  if (pruned.error) throw new Error("youtube_retention_failed");
  const delivery = await deliverDeletionEvents(db, undefined, createDeletionTransport());
  const backlog = await db.rpc("youtube_privacy_backlog");
  if (backlog.error) throw new Error("youtube_privacy_backlog_unavailable");
  let operatorAttention = delivery.pending > 0 || delivery.unalerted > 0
    || Number(backlog.data?.overdueErasures)>0 || Number(backlog.data?.expiredRevocations)>0;
  // Cross-heartbeat with the independent register; a broken register or alert
  // path is escalated through VOOM's own email provider. Inert until approved.
  const registerProblem = await checkDeletionRegister()
    ?? (delivery.unalerted > 0 ? "deletion_alert_undelivered" : null);
  if (registerProblem) { operatorAttention = true; await sendFallbackDeletionAlert(registerProblem); }
  // A single owner's pending revocation must not stall everyone else's reconciliation.
  if (!config) return { erased: Number(pruned.data ?? 0), verified: 0, revocations: null, operatorAttention };
  const client = input.client ?? new YouTubeClient(config);
  const key = youTubeKeyRing(config);
  const revocations = await retryYouTubeRevocations(db,key,client);
  const due = await db.from("youtube_connections").select("owner_user_id,id,authorization_epoch,authorization_checked_at")
    .eq("status","connected").or(`authorization_checked_at.is.null,authorization_checked_at.lt.${new Date(now.getTime()-86400_000).toISOString()}`)
    .order("authorization_checked_at",{ascending:true}).limit(2);
  if (due.error) throw new Error("youtube_authorization_scan_failed");
  let verified = 0;
  // Dynamically imported to keep the credential layer's dependency acyclic.
  const { getYouTubeServerCredentials } = await import("./data.ts");
  for (const row of due.data ?? []) {
    try {
      const credentials = await getYouTubeServerCredentials(db,String(row.owner_user_id),key,client);
      const guarded = guardYouTubeClient(client,db,String(row.owner_user_id),credentials.authorizationEpoch);
      const channel = await guarded.getMyChannel(credentials.accessToken);
      if (channel.channelId !== credentials.channelId) { await eraseYouTubeData(db,String(row.owner_user_id),false,credentials.authorizationEpoch); continue; }
      const result = await db.from("youtube_connections").update({ authorization_checked_at: now.toISOString(),
        channel_title: channel.title, channel_handle: channel.handle, thumbnail_url: channel.thumbnailUrl })
        .eq("owner_user_id",row.owner_user_id).eq("id",row.id).eq("authorization_epoch",row.authorization_epoch).select("id").maybeSingle();
      if (result.error) throw new Error("youtube_authorization_record_failed");
      if (result.data) verified++;
    } catch (reason) {
      // Missing channels/401 are authorization failures; 429/5xx/network are NOT.
      if (reason instanceof YouTubeApiError && reason.reason === "no_channel") {
        try { await eraseYouTubeData(db,String(row.owner_user_id),false,`${row.id}:${row.authorization_epoch}`); }
        catch { operatorAttention = true; } // Retain the block/request; retry, never claim completion.
      }
      // Do not advance the date on uncertain reads. The 28-day fail-closed TTL remains.
    }
  }
  // Authorization checks above may themselves discover a new erasure request.
  // Report its delivery failure now, not only on the next natural cron run.
  const finalDelivery = await deletionDeliveryBacklog(db);
  return { erased: Number(pruned.data ?? 0), verified, revocations,
    operatorAttention: operatorAttention || finalDelivery.pending > 0 || finalDelivery.unalerted > 0 };
}
