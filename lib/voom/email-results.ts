/**
 * Email campaign results — pure, dependency-free and browser-safe.
 *
 * Turns a campaign's recorded sends (campaign_sends) and the verified Resend
 * events stored for them (campaign_delivery_events) into counts a business
 * owner can read. Every number is a count of real recorded sends; nothing is
 * estimated and no rate or percentage is derived.
 *
 *   sent        Voom handed the email to Resend (any send that left the queue
 *               and was not skipped).
 *   accepted    Resend accepted it for delivery (it returned a message id).
 *   delivered   Resend reported the recipient's mail server accepted it.
 *   bounced     Resend reported a bounce.
 *   complained  Resend reported the recipient marked it as spam (this can
 *               happen after delivery, so it is counted alongside delivered).
 *   failed      Resend refused it, or reported a failure other than a bounce
 *               or complaint.
 *   delayed     Resend reported a temporary delay and nothing final yet.
 *   opens/clicks  Distinct emails with at least one opened / clicked event.
 *               null ("Not tracked") when no such event exists, because
 *               Resend only reports them when tracking is switched on.
 *
 * A send recorded as failed before the delayed-delivery fix, whose only
 * provider evidence is a delay, is counted as delayed — not failed.
 */

export interface EmailResultSend {
  id: string;
  internal_status: string;
  accepted_at: string | null;
  delivered_at: string | null;
}

export interface EmailResultEvent {
  send_id: string;
  event_type: string;
}

export interface EmailCampaignResults {
  sent: number;
  accepted: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  delayed: number;
  /** Waiting to send or sending right now. */
  inProgress: number;
  /** Accepted by Resend, no delivery report yet. */
  awaitingReport: number;
  /** Not sent (consent, suppression or a missing address). */
  skipped: number;
  opens: number | null;
  clicks: number | null;
}

export interface AccountUnsubscribes {
  /** Every unsubscribe recorded for this account, from any email. */
  total: number;
}

const BOUNCED = new Set(["email.bounced", "bounced"]);
const COMPLAINED = new Set(["email.complained", "complained"]);
const FAILED = new Set(["email.failed", "failed", "email.canceled", "canceled", "undelivered"]);
const DELAYED = new Set(["email.delivery_delayed", "delivery_delayed", "delayed"]);
const OPENED = new Set(["email.opened", "opened"]);
const CLICKED = new Set(["email.clicked", "clicked"]);

export function summarizeEmailCampaignResults(
  sends: readonly EmailResultSend[],
  events: readonly EmailResultEvent[],
): EmailCampaignResults {
  const ids = new Set(sends.map((send) => send.id));
  const eventsBySend = new Map<string, Set<string>>();
  for (const event of events) {
    // Only events that belong to this campaign's own sends are counted.
    if (!ids.has(event.send_id)) continue;
    const type = String(event.event_type ?? "").trim().toLowerCase();
    if (!type) continue;
    const set = eventsBySend.get(event.send_id) ?? new Set<string>();
    set.add(type);
    eventsBySend.set(event.send_id, set);
  }
  const has = (sendId: string, kinds: Set<string>) => {
    const set = eventsBySend.get(sendId);
    if (!set) return false;
    for (const type of set) if (kinds.has(type)) return true;
    return false;
  };

  const results: EmailCampaignResults = {
    sent: 0, accepted: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, delayed: 0,
    inProgress: 0, awaitingReport: 0, skipped: 0, opens: 0, clicks: 0,
  };
  let opens = 0;
  let clicks = 0;
  for (const send of sends) {
    const status = send.internal_status;
    if (status === "skipped") { results.skipped += 1; continue; }
    if (status === "queued") { results.inProgress += 1; continue; }
    results.sent += 1;
    if (status === "sending") { results.inProgress += 1; continue; }

    const isDelivered = status === "delivered" || Boolean(send.delivered_at);
    const bounced = has(send.id, BOUNCED);
    const complained = has(send.id, COMPLAINED);
    if (send.accepted_at || status === "accepted" || isDelivered) results.accepted += 1;
    if (isDelivered) results.delivered += 1;
    if (bounced) results.bounced += 1;
    if (complained) results.complained += 1;

    if (status === "failed" && !isDelivered && !bounced && !complained) {
      const providerFailure = has(send.id, FAILED);
      const onlyDelayed = !providerFailure && has(send.id, DELAYED);
      if (onlyDelayed) results.delayed += 1;
      else results.failed += 1;
    } else if (status === "accepted" && !isDelivered && !bounced && !complained) {
      if (has(send.id, DELAYED)) results.delayed += 1;
      else results.awaitingReport += 1;
    }

    if (has(send.id, OPENED)) opens += 1;
    if (has(send.id, CLICKED)) clicks += 1;
  }
  results.opens = opens > 0 ? opens : null;
  results.clicks = clicks > 0 ? clicks : null;
  return results;
}
