import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_PUBLISH_ATTEMPTS,
  STALE_CLAIM_MINUTES,
  type PublishMediaKind,
  type PublishState,
} from "./publishing";

export const PUBLISH_QUEUE_TABLE = "instagram_publish_queue";

export interface PublishQueueRow {
  id: string;
  owner_user_id: string;
  draft_id: string;
  calendar_item_id: string | null;
  media_kind: PublishMediaKind;
  caption: string;
  scheduled_at: string;
  status: PublishState;
  idempotency_key: string;
  container_id: string | null;
  instagram_media_id: string | null;
  attempts: number;
  last_attempt_at: string | null;
  claimed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  published_at: string | null;
}

export const PUBLISH_QUEUE_COLUMNS =
  "id,owner_user_id,draft_id,calendar_item_id,media_kind,caption,scheduled_at,status,idempotency_key,container_id,instagram_media_id,attempts,last_attempt_at,claimed_at,failure_code,failure_message,published_at";

/**
 * Enqueues (or reschedules) one approved+scheduled draft. Idempotent: one row
 * per (owner, draft) forever, so re-approving or re-saving never duplicates a
 * publish identity. Published/publishing rows are left untouched.
 *
 * `waitingForMedia` holds the row in the truthful 'waiting_for_media' state
 * while the visual is still generating, instead of pretending the schedule is
 * ready. The claim predicate already re-claims those rows when due, so a
 * visual that arrives late still publishes; a visual that never arrives keeps
 * the item visible as waiting/missed instead of silently dead.
 */
export async function enqueuePublishItem(
  db: SupabaseClient,
  input: {
    ownerId: string;
    draftId: string;
    calendarItemId: string | null;
    mediaKind: PublishMediaKind;
    caption: string;
    scheduledAt: string;
    waitingForMedia?: boolean;
  },
): Promise<PublishQueueRow | null> {
  const { data, error } = await db.rpc("upsert_instagram_publish_queue_item", {
    p_owner_user_id: input.ownerId,
    p_draft_id: input.draftId,
    p_calendar_item_id: input.calendarItemId,
    p_media_kind: input.mediaKind,
    p_caption: input.caption,
    p_scheduled_at: input.scheduledAt,
    p_waiting_for_media: input.waitingForMedia === true,
  });
  if (error) throw new Error("instagram_publish_enqueue_failed");
  return normalizeRow(data);
}

/** Cancels a queued item. Published or in-flight items are never cancelled. */
export async function cancelPublishItem(db: SupabaseClient, ownerId: string, draftId: string): Promise<boolean> {
  const { data, error } = await db.rpc("cancel_instagram_publish_queue_item", {
    p_owner_user_id: ownerId,
    p_draft_id: draftId,
  });
  if (error) throw new Error("instagram_publish_cancel_failed");
  return Boolean(data);
}

/**
 * Atomically claims due items. The SQL uses `for update skip locked`, so a
 * second concurrent cron invocation receives an empty set for anything already
 * claimed — the duplicate-publish guarantee starts here.
 */
export async function claimDueItems(db: SupabaseClient, limit = 10, now = new Date()): Promise<PublishQueueRow[]> {
  const { data, error } = await db.rpc("claim_due_instagram_publish_jobs", {
    p_limit: limit,
    p_now: now.toISOString(),
    p_max_attempts: MAX_PUBLISH_ATTEMPTS,
    p_stale_after: `${STALE_CLAIM_MINUTES} minutes`,
  });
  if (error) throw new Error("instagram_publish_claim_failed");
  return Array.isArray(data) ? data.map((row) => normalizeRow(row)).filter((row): row is PublishQueueRow => Boolean(row)) : [];
}

export async function recordContainerId(db: SupabaseClient, id: string, ownerId: string, containerId: string) {
  const { error } = await db.rpc("record_instagram_publish_container", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_container_id: containerId,
  });
  if (error) throw new Error("instagram_publish_container_record_failed");
}

/** Truthful success. Only ever called with a media id Meta returned. */
export async function completePublishItem(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  instagramMediaId: string,
  containerId: string | null,
) {
  const { error } = await db.rpc("complete_instagram_publish_job", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_instagram_media_id: instagramMediaId,
    p_container_id: containerId,
  });
  if (error) throw new Error("instagram_publish_complete_failed");
}

export async function failPublishItem(
  db: SupabaseClient,
  id: string,
  ownerId: string,
  input: { code: string; message: string; status: PublishState; retryAt?: string | null },
) {
  const { error } = await db.rpc("fail_instagram_publish_job", {
    p_id: id,
    p_owner_user_id: ownerId,
    p_failure_code: input.code,
    p_failure_message: input.message,
    p_status: input.status,
    p_retry_at: input.retryAt ?? null,
  });
  if (error) throw new Error("instagram_publish_fail_record_failed");
}

/** Owner-scoped read of the whole queue, used by the Content Calendar. */
export async function listPublishQueue(db: SupabaseClient, ownerId: string, limit = 100): Promise<PublishQueueRow[]> {
  const { data, error } = await db.from(PUBLISH_QUEUE_TABLE).select(PUBLISH_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).order("scheduled_at", { ascending: true }).limit(limit);
  if (error) throw new Error("instagram_publish_queue_read_failed");
  return ((data ?? []) as unknown[]).map((row) => normalizeRow(row)).filter((row): row is PublishQueueRow => Boolean(row));
}

export async function getQueueItemForDraft(db: SupabaseClient, ownerId: string, draftId: string) {
  const { data } = await db.from(PUBLISH_QUEUE_TABLE).select(PUBLISH_QUEUE_COLUMNS)
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  return normalizeRow(data);
}

function normalizeRow(value: unknown): PublishQueueRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as PublishQueueRow;
}
