import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_TIKTOK_PUBLISH_ATTEMPTS,
  TIKTOK_STALE_CLAIM_MINUTES,
} from "./publishing.ts";
import type { TikTokQueueRow } from "./types.ts";

export type { TikTokQueueRow } from "./types.ts";

export const TIKTOK_PUBLISH_QUEUE_TABLE = "tiktok_publish_queue";

export const TIKTOK_QUEUE_COLUMNS =
  "id,owner_user_id,draft_id,calendar_item_id,title,privacy_level,disable_comment,disable_duet,disable_stitch,brand_content_toggle,brand_organic_toggle,is_aigc,scheduled_at,status,idempotency_key,tiktok_publish_id,upload_url,upload_content_length,upload_bytes_sent,provider_status,provider_post_id,provider_fail_reason,provider_note,last_provider_check_at,attempts,last_attempt_at,claimed_at,failure_code,failure_message,published_at";

/**
 * Enqueues (or reschedules) one approved+scheduled TikTok draft. Idempotent:
 * ONE row per (owner, draft) forever, enforced by the database. Rows the
 * provider already owns (posting / processing / published) are returned
 * untouched — a re-approval can never rewrite provider evidence.
 *
 * `privacyLevel` may be null: the row then parks in `needs_declaration`
 * instead of guessing — TikTok has no default privacy level.
 */
export async function enqueueTikTokPublishItem(
  db: SupabaseClient,
  input: {
    ownerId: string;
    draftId: string;
    calendarItemId: string | null;
    title: string;
    privacyLevel: string | null;
    disableComment?: boolean | null;
    disableDuet?: boolean | null;
    disableStitch?: boolean | null;
    brandContentToggle?: boolean | null;
    brandOrganicToggle?: boolean | null;
    isAigc?: boolean | null;
    scheduledAt: string;
    waitingForMedia?: boolean;
  },
): Promise<TikTokQueueRow | null> {
  const { data, error } = await db.rpc("upsert_tiktok_publish_queue_item", {
    p_owner_user_id: input.ownerId,
    p_draft_id: input.draftId,
    p_calendar_item_id: input.calendarItemId,
    p_title: input.title,
    p_privacy_level: input.privacyLevel,
    p_disable_comment: input.disableComment ?? null,
    p_disable_duet: input.disableDuet ?? null,
    p_disable_stitch: input.disableStitch ?? null,
    p_brand_content_toggle: input.brandContentToggle ?? null,
    p_brand_organic_toggle: input.brandOrganicToggle ?? null,
    p_is_aigc: input.isAigc ?? null,
    p_scheduled_at: input.scheduledAt,
    p_waiting_for_media: input.waitingForMedia === true,
  });
  if (error) throw new Error("tiktok_publish_enqueue_failed");
  return normalizeRow(data);
}

/** Cancels a queued item. Provider-owned rows are never cancelled. */
export async function cancelTikTokPublishItem(db: SupabaseClient, ownerId: string, draftId: string): Promise<boolean> {
  const { data, error } = await db.rpc("cancel_tiktok_publish_queue_item", {
    p_owner_user_id: ownerId,
    p_draft_id: draftId,
  });
  if (error) throw new Error("tiktok_publish_cancel_failed");
  return Boolean(data);
}

/**
 * Atomically claims due POSTING-phase items (`for update skip locked`), so a
 * second concurrent cron invocation receives an empty set for anything
 * already claimed — the duplicate-post guarantee starts here. Rows that
 * already carry a publish id are never claimed here: the provider owns them.
 */
export async function claimDueTikTokPosts(db: SupabaseClient, limit = 5, now = new Date()): Promise<TikTokQueueRow[]> {
  const { data, error } = await db.rpc("claim_due_tiktok_post_jobs", {
    p_limit: limit,
    p_now: now.toISOString(),
    p_max_attempts: MAX_TIKTOK_PUBLISH_ATTEMPTS,
    p_stale_after: `${TIKTOK_STALE_CLAIM_MINUTES} minutes`,
  });
  if (error) throw new Error("tiktok_publish_claim_failed");
  return rowsOf(data);
}

/**
 * Atomically claims RECONCILIATION work: `provider_processing` rows to poll
 * (no attempt consumed — waiting for TikTok is not a failure) and stale
 * `posting` rows to resume through their persisted publish id + progress.
 */
export async function claimTikTokReconcileJobs(db: SupabaseClient, limit = 10, now = new Date()): Promise<TikTokQueueRow[]> {
  const { data, error } = await db.rpc("claim_tiktok_reconcile_jobs", {
    p_limit: limit,
    p_now: now.toISOString(),
    p_max_attempts: MAX_TIKTOK_PUBLISH_ATTEMPTS,
    p_stale_after: `${TIKTOK_STALE_CLAIM_MINUTES} minutes`,
  });
  if (error) throw new Error("tiktok_reconcile_claim_failed");
  return rowsOf(data);
}

/** Persists the Direct Post publish id + upload URL BEFORE the first byte. */
export async function recordTikTokPublish(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  publishId: string,
  uploadUrl: string,
  contentLength: number,
): Promise<void> {
  const { error } = await db.rpc("record_tiktok_publish", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_publish_id: publishId,
    p_upload_url: uploadUrl,
    p_content_length: contentLength,
  });
  if (error) throw new Error("tiktok_publish_record_failed");
}

/** All bytes are with TikTok: the row moves to provider-owned processing. */
/**
 * Guarded re-arm after the official status endpoint said the persisted
 * publish id does not exist (invalid_publish_id): the provider attested the
 * post is gone, so a fresh init cannot duplicate it. No-op for anything
 * else (the RPC refuses).
 */
export async function resetTikTokPublishForResubmit(db: SupabaseClient, id: string, ownerId: string): Promise<void> {
  const { error } = await db.rpc("reset_tiktok_publish_for_resubmit", {
    p_id: id,
    p_owner_user_id: ownerId,
  });
  if (error) throw new Error("tiktok_publish_resubmit_reset_failed");
}

export async function setTikTokProviderProcessing(db: SupabaseClient, id: string, ownerId: string): Promise<void> {
  const { error } = await db.rpc("set_tiktok_provider_processing", {
    p_id: id,
    p_owner_user_id: ownerId,
  });
  if (error) throw new Error("tiktok_provider_processing_record_failed");
}

export async function recordTikTokUploadProgress(db: SupabaseClient, id: string, ownerId: string, bytesSent: number): Promise<void> {
  const { error } = await db.rpc("record_tiktok_upload_progress", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_bytes_sent: bytesSent,
  });
  // Progress bookkeeping must never kill an in-flight upload.
  if (error) throw new Error("tiktok_upload_progress_record_failed");
}

/** Truthful completion: only ever called with TikTok's PUBLISH_COMPLETE. */
export async function completeTikTokPublishJob(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  input: { providerPostId?: string | null; providerNote?: string | null },
): Promise<void> {
  const { error } = await db.rpc("complete_tiktok_publish_job", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_provider_status: "PUBLISH_COMPLETE",
    p_provider_post_id: input.providerPostId ?? null,
    p_provider_note: input.providerNote ?? null,
  });
  if (error) throw new Error("tiktok_publish_complete_failed");
}

export async function failTikTokPublishJob(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  input: { code: string; message: string; status: string; retryAt?: string | null; resetAttempts?: boolean },
): Promise<void> {
  const { error } = await db.rpc("fail_tiktok_publish_job", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_failure_code: input.code,
    p_failure_message: input.message,
    p_status: input.status,
    p_retry_at: input.retryAt ?? null,
    p_reset_attempts: input.resetAttempts === true,
  });
  if (error) throw new Error("tiktok_publish_fail_record_failed");
}

/** Provider bookkeeping legal even on a published row (reconciliation). */
export async function recordTikTokProviderStatus(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  input: {
    providerStatus?: string | null;
    providerPostId?: string | null;
    failReason?: string | null;
    note?: string | null;
    checkedAt: string;
  },
): Promise<void> {
  const { error } = await db.rpc("record_tiktok_provider_status", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_provider_status: input.providerStatus ?? null,
    p_provider_post_id: input.providerPostId ?? null,
    p_provider_fail_reason: input.failReason ?? null,
    p_provider_note: input.note ?? null,
    p_last_provider_check_at: input.checkedAt,
  });
  if (error) throw new Error("tiktok_provider_status_record_failed");
}

/** Published rows whose provider evidence is due for a periodic re-check. */
export async function listTikTokPublishedForVerification(db: SupabaseClient, limit = 25, now = new Date(), minAgeHours = 24): Promise<TikTokQueueRow[]> {
  const { data, error } = await db.rpc("list_tiktok_published_for_verification", {
    p_limit: limit,
    p_now: now.toISOString(),
    p_min_age: `${minAgeHours} hours`,
  });
  if (error) throw new Error("tiktok_verification_list_failed");
  return rowsOf(data);
}

/** Owner-scoped read of the whole queue, used by the /app/tiktok hub. */
export async function listTikTokPublishQueue(db: SupabaseClient, ownerId: string, limit = 100): Promise<TikTokQueueRow[]> {
  const { data, error } = await db.from(TIKTOK_PUBLISH_QUEUE_TABLE).select(TIKTOK_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).order("scheduled_at", { ascending: false }).limit(limit);
  if (error) throw new Error("tiktok_publish_queue_read_failed");
  return rowsOf(data);
}

export async function getTikTokQueueItemForDraft(db: SupabaseClient, ownerId: string, draftId: string): Promise<TikTokQueueRow | null> {
  const { data, error } = await db.from(TIKTOK_PUBLISH_QUEUE_TABLE).select(TIKTOK_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  if (error) throw new Error("tiktok_publish_queue_read_failed");
  return normalizeRow(data);
}

export async function getTikTokQueueItemsForDrafts(db: SupabaseClient, ownerId: string, draftIds: string[]): Promise<Map<string, TikTokQueueRow>> {
  if (!draftIds.length) return new Map();
  const { data, error } = await db.from(TIKTOK_PUBLISH_QUEUE_TABLE).select(TIKTOK_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).in("draft_id", draftIds);
  if (error) throw new Error("tiktok_publish_queue_read_failed");
  const map = new Map<string, TikTokQueueRow>();
  for (const row of rowsOf(data)) map.set(row.draft_id, row);
  return map;
}

function rowsOf(data: unknown): TikTokQueueRow[] {
  return Array.isArray(data)
    ? (data as unknown[]).map((row) => normalizeRow(row)).filter((row): row is TikTokQueueRow => Boolean(row))
    : [];
}

function normalizeRow(value: unknown): TikTokQueueRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as TikTokQueueRow;
}
