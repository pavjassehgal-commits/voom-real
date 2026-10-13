import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  summarizeEmailCampaignResults,
  type AccountUnsubscribes,
  type EmailCampaignResults,
  type EmailResultEvent,
  type EmailResultSend,
} from "./email-results";

/**
 * Owner-scoped read of one email campaign's results. The caller must already
 * have confirmed, with the signed-in user's own session, that the campaign
 * belongs to `ownerId` (app/api/voom/campaigns/[id]/results). Every query here
 * is ALSO filtered by owner, and events are read only for this campaign's own
 * send ids, so no other business's data can be counted even with the
 * service-role client that campaign_delivery_events requires.
 *
 * Only counts leave this module — never recipient addresses or message ids.
 */

/** Far above any real campaign (sends are capped per run); keeps reads bounded. */
const MAX_SENDS = 5000;
const EVENT_ID_CHUNK = 100;

export interface EmailCampaignResultsView {
  results: EmailCampaignResults;
  unsubscribes: AccountUnsubscribes | null;
}

export async function readEmailCampaignResults(
  admin: SupabaseClient,
  ownerId: string,
  campaignId: string,
): Promise<EmailCampaignResultsView> {
  const { data: sendRows, error: sendError } = await admin.from("campaign_sends")
    .select("id,internal_status,accepted_at,delivered_at")
    .eq("owner_user_id", ownerId)
    .eq("campaign_id", campaignId)
    .eq("channel", "email")
    .limit(MAX_SENDS);
  if (sendError) throw new Error("campaign_results_unavailable");
  const sends: EmailResultSend[] = (sendRows ?? []).map((row) => ({
    id: String(row.id),
    internal_status: String(row.internal_status ?? ""),
    accepted_at: row.accepted_at ? String(row.accepted_at) : null,
    delivered_at: row.delivered_at ? String(row.delivered_at) : null,
  }));

  const events: EmailResultEvent[] = [];
  const ids = sends.map((send) => send.id);
  for (let index = 0; index < ids.length; index += EVENT_ID_CHUNK) {
    const chunk = ids.slice(index, index + EVENT_ID_CHUNK);
    const { data, error } = await admin.from("campaign_delivery_events")
      .select("send_id,event_type")
      .eq("owner_user_id", ownerId)
      .in("send_id", chunk);
    if (error) throw new Error("campaign_results_unavailable");
    for (const row of data ?? []) events.push({ send_id: String(row.send_id), event_type: String(row.event_type ?? "") });
  }

  // Account-wide: unsubscribes are recorded per address, not per campaign.
  let unsubscribes: AccountUnsubscribes | null = null;
  const { count, error: unsubscribeError } = await admin.from("voom_email_unsubscribes")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", ownerId);
  if (!unsubscribeError && typeof count === "number") unsubscribes = { total: count };

  return { results: summarizeEmailCampaignResults(sends, events), unsubscribes };
}
