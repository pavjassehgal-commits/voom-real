import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_YOUTUBE_PUBLISH_ATTEMPTS,
  YOUTUBE_STALE_CLAIM_MINUTES,
} from "./publishing.ts";
import type { YouTubeQueueRow } from "./types.ts";

export type { YouTubeQueueRow } from "./types.ts";

export const YOUTUBE_PUBLISH_QUEUE_TABLE = "youtube_publish_queue";

export const YOUTUBE_QUEUE_COLUMNS =
  "id,owner_user_id,draft_id,calendar_item_id,youtube_format,title,description,privacy_status,made_for_kids,category_id,scheduled_at,status,idempotency_key,upload_session_url,upload_content_length,upload_bytes_sent,youtube_video_id,provider_upload_status,provider_privacy_status,provider_rejection_reason,provider_note,last_provider_check_at,attempts,last_attempt_at,claimed_at,failure_code,failure_message,published_at";

/**
 * Enqueues (or reschedules) one approved+scheduled YouTube draft. Idempotent:
 * ONE row per (owner, draft) forever, enforced by the database. Rows the
 * provider already owns (uploading / processing / published) are returned
 * untouched — a re-approval can never rewrite provider evidence.
 *
 * `privacyStatus`/`madeForKids` may be null: the row then parks in
 * `needs_declaration` instead of guessing policy-sensitive metadata.
 */
export async function enqueueYouTubePublishItem(
  db: SupabaseClient,
  input: {
    ownerId: string;
    draftId: string;
    calendarItemId: string | null;
    youtubeFormat: "short" | "video";
    title: string;
    description: string;
    privacyStatus: string | null;
    madeForKids: boolean | null;
    categoryId?: string | null;
    scheduledAt: string;
    waitingForMedia?: boolean;
  },
): Promise<YouTubeQueueRow | null> {
  const { data, error } = await db.rpc("upsert_youtube_publish_queue_item", {
    p_owner_user_id: input.ownerId,
    p_draft_id: input.draftId,
    p_calendar_item_id: input.calendarItemId,
    p_youtube_format: input.youtubeFormat,
    p_title: input.title,
    p_description: input.description,
    p_privacy_status: input.privacyStatus,
    p_made_for_kids: input.madeForKids,
    p_category_id: input.categoryId ?? "22",
    p_scheduled_at: input.scheduledAt,
    p_waiting_for_media: input.waitingForMedia === true,
  });
  if (error) throw new Error("youtube_publish_enqueue_failed");
  return normalizeRow(data);
}

/** Cancels a queued item. Provider-owned rows are never cancelled. */
export async function cancelYouTubePublishItem(db: SupabaseClient, ownerId: string, draftId: string): Promise<boolean> {
  const { data, error } = await db.rpc("cancel_youtube_publish_queue_item", {
    p_owner_user_id: ownerId,
    p_draft_id: draftId,
  });
  if (error) throw new Error("youtube_publish_cancel_failed");
  return Boolean(data);
}

/**
 * Atomically claims due UPLOAD-phase items (`for update skip locked`), so a
 * second concurrent cron invocation receives an empty set for anything
 * already claimed — the duplicate-upload guarantee starts here.
 */
export async function claimDueYouTubeUploads(db: SupabaseClient, limit = 5, now = new Date()): Promise<YouTubeQueueRow[]> {
  const { data, error } = await db.rpc("claim_due_youtube_upload_jobs", {
    p_limit: limit,
    p_now: now.toISOString(),
    p_max_attempts: MAX_YOUTUBE_PUBLISH_ATTEMPTS,
    p_stale_after: `${YOUTUBE_STALE_CLAIM_MINUTES} minutes`,
  });
  if (error) throw new Error("youtube_publish_claim_failed");
  return rowsOf(data);
}

/**
 * Atomically claims RECONCILIATION work: `provider_processing` rows to poll
 * (no attempt consumed — waiting for YouTube is not a failure) and stale
 * `uploading` rows to resume through their persisted session.
 */
export async function claimYouTubeReconcileJobs(db: SupabaseClient, limit = 10, now = new Date()): Promise<YouTubeQueueRow[]> {
  const { data, error } = await db.rpc("claim_youtube_reconcile_jobs", {
    p_limit: limit,
    p_now: now.toISOString(),
    p_max_attempts: MAX_YOUTUBE_PUBLISH_ATTEMPTS,
    p_stale_after: `${YOUTUBE_STALE_CLAIM_MINUTES} minutes`,
  });
  if (error) throw new Error("youtube_reconcile_claim_failed");
  return rowsOf(data);
}

/** Persists the resumable session BEFORE the first byte is sent. */
export async function recordYouTubeUploadSession(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  sessionUrl: string,
  contentLength: number,
): Promise<void> {
  const { error } = await db.rpc("record_youtube_upload_session", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_session_url: sessionUrl,
    p_content_length: contentLength,
  });
  if (error) throw new Error("youtube_upload_session_record_failed");
}

export async function recordYouTubeUploadProgress(db: SupabaseClient, id: string, ownerId: string, bytesSent: number): Promise<void> {
  const { error } = await db.rpc("record_youtube_upload_progress", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_bytes_sent: bytesSent,
  });
  // Progress bookkeeping must never kill an in-flight upload.
  if (error) throw new Error("youtube_upload_progress_record_failed");
}

/** Provider acceptance: a real video id, still NOT published. */
export async function recordYouTubeVideoId(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  videoId: string,
  uploadStatus: string | null,
  privacyStatus: string | null,
): Promise<void> {
  const { error } = await db.rpc("record_youtube_video_id", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_youtube_video_id: videoId,
    p_provider_upload_status: uploadStatus ?? "uploaded",
    p_provider_privacy_status: privacyStatus,
  });
  if (error) throw new Error("youtube_video_id_record_failed");
}

/**
 * Truthful completion: only ever called with YouTube's own uploadStatus
 * 'processed' for a row that already carries a real video id. The RPC also
 * stamps mara_drafts.provider_ref — provider evidence, provider reference.
 */
export async function completeYouTubePublishJob(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  input: { privacyStatus: string | null; providerNote?: string | null },
): Promise<void> {
  const { error } = await db.rpc("complete_youtube_publish_job", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_provider_upload_status: "processed",
    p_provider_privacy_status: input.privacyStatus,
    p_provider_note: input.providerNote ?? null,
  });
  if (error) throw new Error("youtube_publish_complete_failed");
}

export async function failYouTubePublishJob(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  input: { code: string; message: string; status: string; retryAt?: string | null; resetAttempts?: boolean },
): Promise<void> {
  const { error } = await db.rpc("fail_youtube_publish_job", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_failure_code: input.code,
    p_failure_message: input.message,
    p_status: input.status,
    p_retry_at: input.retryAt ?? null,
    p_reset_attempts: input.resetAttempts === true,
  });
  if (error) throw new Error("youtube_publish_fail_record_failed");
}

/** Provider bookkeeping legal even on a published row (reconciliation). */
export async function recordYouTubeProviderStatus(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  input: { uploadStatus?: string | null; privacyStatus?: string | null; note?: string | null; checkedAt: string },
): Promise<void> {
  const { error } = await db.rpc("record_youtube_provider_status", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_provider_upload_status: input.uploadStatus ?? null,
    p_provider_privacy_status: input.privacyStatus ?? null,
    p_provider_note: input.note ?? null,
    p_last_provider_check_at: input.checkedAt,
  });
  if (error) throw new Error("youtube_provider_status_record_failed");
}

/** Published rows whose provider evidence is due for a periodic re-check. */
export async function listPublishedForVerification(db: SupabaseClient, limit = 25, now = new Date()): Promise<YouTubeQueueRow[]> {
  const { data, error } = await db.rpc("list_youtube_published_for_verification", {
    p_limit: limit,
    p_now: now.toISOString(),
    p_min_age: "24 hours",
  });
  if (error) throw new Error("youtube_verification_list_failed");
  return rowsOf(data);
}

/** Owner-scoped read of the whole queue, used by the /app/youtube hub. */
export async function listYouTubePublishQueue(db: SupabaseClient, ownerId: string, limit = 100): Promise<YouTubeQueueRow[]> {
  const { data, error } = await db.from(YOUTUBE_PUBLISH_QUEUE_TABLE).select(YOUTUBE_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).order("scheduled_at", { ascending: false }).limit(limit);
  if (error) throw new Error("youtube_publish_queue_read_failed");
  return rowsOf(data);
}

export async function getYouTubeQueueItemForDraft(db: SupabaseClient, ownerId: string, draftId: string): Promise<YouTubeQueueRow | null> {
  const { data } = await db.from(YOUTUBE_PUBLISH_QUEUE_TABLE).select(YOUTUBE_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  return normalizeRow(data);
}

export async function getYouTubeQueueItemsForDrafts(db: SupabaseClient, ownerId: string, draftIds: string[]): Promise<Map<string, YouTubeQueueRow>> {
  if (!draftIds.length) return new Map();
  const { data } = await db.from(YOUTUBE_PUBLISH_QUEUE_TABLE).select(YOUTUBE_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).in("draft_id", draftIds);
  const map = new Map<string, YouTubeQueueRow>();
  for (const row of rowsOf(data)) map.set(row.draft_id, row);
  return map;
}

function rowsOf(data: unknown): YouTubeQueueRow[] {
  return Array.isArray(data)
    ? (data as unknown[]).map((row) => normalizeRow(row)).filter((row): row is YouTubeQueueRow => Boolean(row))
    : [];
}

function normalizeRow(value: unknown): YouTubeQueueRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as YouTubeQueueRow;
}
