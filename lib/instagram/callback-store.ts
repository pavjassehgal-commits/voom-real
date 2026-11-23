import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LifecycleEvent, LifecycleReceipt } from "./lifecycle";

/** Durable receipt + disconnect in one database transaction (0078 accept_instagram_callback). */
export async function acceptInstagramCallback(db: SupabaseClient, event: LifecycleEvent): Promise<LifecycleReceipt> {
  const { data, error } = await db.rpc("accept_instagram_callback", {
    p_app_id: event.appId, p_subject_id: event.subjectId, p_kind: event.kind,
    p_issued_at: event.issuedAt === null ? null : new Date(event.issuedAt * 1000).toISOString(), p_event_key: event.eventKey,
  });
  if (error || typeof data !== "string") throw new Error("instagram_callback_unavailable");
  return { confirmation_code: data };
}

export type DeletionStatus = { status: string; receivedAt: string; completedAt: string | null; backupsClearBy: string | null };

export async function readInstagramDeletionStatus(db: SupabaseClient, code: string): Promise<DeletionStatus | null> {
  const { data, error } = await db.rpc("instagram_deletion_status", { p_confirmation_code: code }).maybeSingle();
  if (error) throw new Error("instagram_deletion_status_unavailable");
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return { status: String(row.status), receivedAt: String(row.received_at),
    completedAt: row.completed_at ? String(row.completed_at) : null, backupsClearBy: row.backups_clear_by ? String(row.backups_clear_by) : null };
}
