/**
 * Branded Email Engine v1 — sender resolution backed by the database.
 *
 * Loads the owner's business row + verified domain store, then delegates to the
 * pure `resolveSenderIdentity`. Verification status is therefore always
 * provider-backed (stored rows) or truthfully `not_configured`.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveSenderIdentity,
  managedSenderConfig,
  type BusinessSenderRecord,
  type ResolvedSender,
} from "./sender";

export interface SenderDeps {
  /** Test seam: the managed env config. */
  config?: { fromName: string; fromAddress: string } | null;
}

export async function loadResolvedSender(
  db: SupabaseClient,
  ownerId: string,
  input: {
    businessName: string | null | undefined;
    senderAddress?: string | null;
    senderName?: string | null;
    replyTo?: string | null;
  },
  deps: SenderDeps = {},
): Promise<ResolvedSender> {
  const [business, rows] = await Promise.all([
    db.from("businesses")
      .select("brand_name,email_sender_address,email_sender_name,email_reply_to")
      .eq("owner_user_id", ownerId)
      .maybeSingle(),
    loadSenderRows(db, ownerId),
  ]);

  const row = (business?.data ?? {}) as Record<string, unknown>;

  const senderAddress = nonEmpty(input.senderAddress)
    ?? nonEmpty(String(row.email_sender_address ?? ""));
  const senderName = nonEmpty(input.senderName)
    ?? nonEmpty(String(row.email_sender_name ?? ""));
  const replyTo = nonEmpty(input.replyTo)
    ?? nonEmpty(String(row.email_reply_to ?? ""));
  const businessName = nonEmpty(input.businessName)
    ?? nonEmpty(String(row.brand_name ?? ""));

  return resolveSenderIdentity(
    { businessName, senderAddress, senderName, replyTo, senderRows: rows },
    deps.config !== undefined ? deps.config : managedSenderConfig(),
  );
}

async function loadSenderRows(db: SupabaseClient, ownerId: string): Promise<BusinessSenderRecord[]> {
  try {
    const { data, error } = await db.from("business_email_sender_domains")
      .select("id,owner_user_id,domain,business_id,status")
      .eq("owner_user_id", ownerId);
    if (error || !data) return [];
    return (data as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id ?? ""),
      ownerId: String(row.owner_user_id ?? ownerId),
      domain: String(row.domain ?? ""),
      address: String(row.domain ?? ""),
      status: (row.status as BusinessSenderRecord["status"]) ?? "not_configured",
    }));
  } catch {
    return [];
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
