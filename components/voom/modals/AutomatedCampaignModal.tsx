"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useModal } from "@/lib/voom/modal";
import { ACTION_CHANNEL_LABELS, CAMPAIGN_GOAL_LABELS, type AutomatedCampaignView, type CampaignActionView } from "@/lib/campaign/types";
import { actionStateTone } from "@/lib/campaign/status";
import type { CampaignDeliveryView } from "@/lib/voom/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, Tag, Textarea } from "../ui/primitives";

/**
 * The campaign workspace: ONE timeline containing every planned email and
 * Instagram action, with derived status and per-action approvals. It never
 * edits the generated structure itself, and it can never auto-send — emails
 * keep the explicit send action, Instagram items link into Create Content
 * for the visual + schedule.
 */
export function AutomatedCampaignModal({ campaignId, initial }: { campaignId: string; initial?: AutomatedCampaignView }) {
  const { close } = useModal();
  const [view, setView] = useState<AutomatedCampaignView | null>(initial ?? null);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}`, { cache: "no-store" });
      const data = await response.json() as { automated?: AutomatedCampaignView; error?: string };
      if (!response.ok || !data.automated) { setError(data.error ?? "That campaign couldn't load."); return; }
      setView(data.automated);
      setError("");
    } catch {
      setError("That campaign couldn't load.");
    }
  }, [campaignId]);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}`, { cache: "no-store" });
        const data = await response.json() as { automated?: AutomatedCampaignView; error?: string };
        if (cancelled) return;
        if (!response.ok || !data.automated) { setError(data.error ?? "That campaign couldn't load."); return; }
        setView(data.automated);
        setError("");
      } catch {
        if (!cancelled) setError("That campaign couldn't load.");
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, initial]);

  async function decide(action: CampaignActionView, decision: "approve" | "reject") {
    setBusyAction(action.id);
    setError("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}/actions/${encodeURIComponent(action.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: decision }),
      });
      const data = await response.json() as { automated?: AutomatedCampaignView; error?: string; message?: string };
      if (data.automated) setView(data.automated);
      else if (response.ok) await load();
      if (!response.ok) setError(data.error ?? "That action couldn't be updated.");
      window.dispatchEvent(new Event("voom:data-changed"));
    } catch {
      setError("That action couldn't be updated.");
    } finally {
      setBusyAction(null);
    }
  }

  if (!view) {
    return (
      <ModalShell wide>
        <ModalBody><p className="py-8 text-center text-sm text-text-3">Loading campaign…</p></ModalBody>
      </ModalShell>
    );
  }

  const { campaign } = view;

  return (
    <ModalShell wide>
      <ModalHead
        title={campaign.name}
        sub={`${campaign.goal ? CAMPAIGN_GOAL_LABELS[campaign.goal] : "Campaign"} · ${dateRange(campaign.start_at, campaign.end_at)}`}
        onClose={close}
      />
      <ModalBody>
        {error && <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Tag tone={lifecycleTone(view.lifecycle)}>{view.lifecycleLabel}</Tag>
          <Tag tone="t-grey">{view.counts.instagram} Instagram</Tag>
          <Tag tone="t-grey">{view.counts.email} email{view.counts.email === 1 ? "" : "s"}</Tag>
          {view.counts.needingApproval > 0 && <Tag tone="t-amber">{view.counts.needingApproval} need your review</Tag>}
          {view.counts.executed > 0 && <Tag tone="t-green">{view.counts.executed} done</Tag>}
        </div>

        {campaign.generated_summary && (
          <Card className="mb-4 border-line-2 bg-surface-2 p-3.5">
            <div className="flex items-start gap-2.5">
              <Icon name="spark" size={16} className="mt-0.5 flex-none text-brand" />
              <p className="text-[13px] leading-[1.6] text-text-2">{campaign.generated_summary}</p>
            </div>
          </Card>
        )}

        {campaign.offer_details && (
          <p className="mb-3 text-[12.5px] text-text-3">Offer on file: <b className="text-text-2">{campaign.offer_details}</b></p>
        )}

        <ol className="relative space-y-3 border-l border-line pl-4">
          {view.actions.map((action) => (
            <TimelineRow key={action.id} action={action} busy={busyAction === action.id} onDecide={decide} onChanged={() => void load()} />
          ))}
        </ol>

        <Card className="mt-4 border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="mt-0.5 flex-none text-amber" size={16} />
            <p className="text-[12.5px] leading-[1.6] text-text-2">
              Building approved drafts only. Email still sends through an explicit Send action below, and Instagram
              items need a visual and schedule in Create Content before they can publish. Nothing is sent or
              published automatically from this screen.
            </p>
          </div>
        </Card>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>Close</Btn>
      </ModalFoot>
    </ModalShell>
  );
}

function TimelineRow({ action, busy, onDecide, onChanged }: {
  action: CampaignActionView;
  busy: boolean;
  onDecide: (action: CampaignActionView, decision: "approve" | "reject") => void;
  onChanged: () => void;
}) {
  const when = new Date(action.scheduled_for);
  const isEmail = action.channel === "email";
  const pending = action.executionState === "proposed" || action.executionState === "needs_approval";
  const [showDetails, setShowDetails] = useState(false);

  return (
    <li className="relative">
      <span className="absolute -left-[22px] top-4 grid h-3 w-3 place-items-center rounded-full border-2 border-brand bg-bg" />
      <Card className="p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface-2 text-brand">
            <Icon name={isEmail ? "mail" : action.channel === "instagram_reel" ? "film" : "ig"} size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[13.5px]">{when.toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", weekday: "short", month: "short", day: "numeric" })}</b>
              <span className="text-[11.5px] text-text-3">{when.toLocaleTimeString("en-AE", { timeZone: "Asia/Dubai", hour: "numeric", minute: "2-digit" })}</span>
              <Tag tone="t-grey">{ACTION_CHANNEL_LABELS[action.channel]}</Tag>
            </div>
            <b className="mt-0.5 block truncate text-[13.5px]">{action.title}</b>
          </div>
          <Tag tone={actionStateTone(action.executionState)}>{action.executionLabel}</Tag>
        </div>
        <p className="mt-1.5 text-[12px] leading-[1.55] text-text-3">{action.purpose}</p>

        {action.safety_blockers?.length > 0 && action.executionState === "needs_approval" && (
          <p className="mt-2 text-[11.5px] text-amber">MARA held this for your review: {action.safety_blockers.join(", ")}.</p>
        )}

        <div className="mt-2.5 flex flex-wrap gap-2">
          <Btn size="sm" variant="plain" onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? "Hide details" : "Review content"}
          </Btn>
          {pending && !isEmail && (
            <Link href="/app/studio" className="ml-auto inline-flex items-center gap-1 self-center text-[12px] font-semibold text-brand hover:underline">
              Open in Create Content →
            </Link>
          )}
          {pending && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Btn size="sm" variant="outline" disabled={busy} onClick={() => onDecide(action, "reject")}>Reject</Btn>
              <Btn size="sm" variant="primary" disabled={busy} onClick={() => onDecide(action, "approve")}>
                {busy ? "Working…" : isEmail ? "Approve email" : "Approve"}
              </Btn>
            </div>
          )}
        </div>

        {showDetails && (
          <div className="mt-3">
            {action.email ? <EmailDetails action={action} onChanged={onChanged} /> : <InstagramDetails action={action} />}
          </div>
        )}
      </Card>
    </li>
  );
}

function InstagramDetails({ action }: { action: CampaignActionView }) {
  const ig = action.instagram;
  if (!ig) return null;
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={ig.draftStatus === "approved" ? "t-green" : ig.draftStatus === "rejected" ? "t-red" : "t-amber"}>Draft {ig.draftStatus}</Tag>
        {ig.queueStatus ? <Tag tone="t-blue">Queue: {ig.queueStatus}</Tag> : null}
        {ig.needsVisual ? <Tag tone="t-amber">Needs a visual before publishing</Tag> : null}
      </div>
      <p className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-text-2">{ig.caption}</p>
      <p className="text-[11.5px] text-text-3">Add the visual and schedule it in <Link href="/app/studio" className="font-semibold text-brand hover:underline">Create Content</Link>. Nothing publishes without that.</p>
    </div>
  );
}

function EmailDetails({ action, onChanged }: { action: CampaignActionView; onChanged: () => void }) {
  const email = action.email;
  const childId = email?.childCampaignId;
  const [delivery, setDelivery] = useState<CampaignDeliveryView | null>(null);
  const [contact, setContact] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const refreshDelivery = useCallback(async () => {
    if (!childId) return;
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, { cache: "no-store" });
      const data = await response.json() as { delivery?: CampaignDeliveryView };
      if (response.ok && data.delivery) {
        setDelivery(data.delivery);
        setContact(data.delivery.recipient?.contact ?? "");
        setName(data.delivery.recipient?.contact_name ?? "");
      }
    } catch {
      // Delivery detail is optional in the timeline.
    }
  }, [childId]);

  useEffect(() => {
    if (!childId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, { cache: "no-store" });
        const data = await response.json() as { delivery?: CampaignDeliveryView };
        if (!cancelled && response.ok && data.delivery) {
          setDelivery(data.delivery);
          setContact(data.delivery.recipient?.contact ?? "");
          setName(data.delivery.recipient?.contact_name ?? "");
        }
      } catch {
        // Delivery detail is optional in the timeline.
      }
    })();
    return () => { cancelled = true; };
  }, [childId]);

  async function sendToContact() {
    if (!childId || !contact.trim()) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: contact.trim(), contactName: name.trim() }),
      });
      const data = await response.json() as { delivery?: CampaignDeliveryView; message?: string; error?: string };
      if (data.delivery) setDelivery(data.delivery);
      if (!response.ok) setErr(data.error ?? "The email couldn't be sent.");
      else { setNote(data.message ?? "Email accepted by the provider."); onChanged(); window.dispatchEvent(new Event("voom:data-changed")); }
      await refreshDelivery();
    } catch {
      setErr("The email couldn't be sent safely.");
    } finally {
      setBusy(false);
    }
  }

  async function sendToAudience() {
    if (!childId) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audienceSend: true }),
      });
      const data = await response.json() as { delivery?: CampaignDeliveryView; message?: string; error?: string };
      if (data.delivery) setDelivery(data.delivery);
      if (!response.ok) setErr(data.error ?? "The audience send couldn't run.");
      else { setNote(data.message ?? "The audience send finished."); onChanged(); window.dispatchEvent(new Event("voom:data-changed")); }
      await refreshDelivery();
    } catch {
      setErr("The audience send couldn't run safely.");
    } finally {
      setBusy(false);
    }
  }

  if (!email) return null;
  const sendState = delivery?.state;

  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={email.childStatus === "approved" ? "t-green" : email.childStatus === "rejected" ? "t-red" : "t-amber"}>
          {email.childStatus === "approved" ? "Approved" : email.childStatus === "rejected" ? "Rejected" : "Draft"}
        </Tag>
        {sendState && <Tag tone={sendState === "delivered" ? "t-green" : sendState === "failed" ? "t-red" : "t-blue"}>{deliveryStateLabel(sendState)}</Tag>}
      </div>
      <Field label="Subject"><Input value={email.subject ?? ""} readOnly /></Field>
      {email.previewText ? <Field label="Preview text"><Input value={email.previewText} readOnly /></Field> : null}
      <Field label="Body">
        <Textarea rows={6} value={email.body} readOnly />
      </Field>
      {email.cta ? <p className="text-[12px] font-semibold text-text-2">CTA: {email.cta}</p> : null}
      <p className="text-[11.5px] text-text-3">
        Proposed send time: {new Date(action.scheduled_for).toLocaleString("en-AE", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })}
      </p>

      {email.childStatus === "approved" && (
        <div className="rounded-xl border border-line bg-bg p-3">
          <p className="mb-2 text-[12.5px] font-semibold text-text-2">Send this approved email</p>
          {delivery?.audience ? (
            <>
              <p className="mb-2 text-[12px] leading-[1.55] text-text-2">{delivery.note}</p>
              <Btn size="sm" variant="primary" disabled={busy || !delivery.canSend} onClick={() => void sendToAudience()}>
                <Icon name="send" size={13} /> {busy ? "Sending…" : "Send to audience now"}
              </Btn>
            </>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Recipient email">
                  <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="customer@example.com" />
                </Field>
                <Field label="Recipient name (optional)">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sara" />
                </Field>
              </div>
              <Btn size="sm" variant="primary" disabled={busy || !contact.trim() || !delivery?.canSend} onClick={() => void sendToContact()}>
                <Icon name="send" size={13} /> {busy ? "Sending…" : "Send now"}
              </Btn>
            </>
          )}
          {delivery && !delivery.provider.configured && (
            <p className="mt-2 text-[11.5px] text-amber">{delivery.provider.label} is not configured on the server yet.</p>
          )}
        </div>
      )}

      {note && <p role="status" className="text-[12px] text-green">{note}</p>}
      {err && <p role="alert" className="text-[12px] text-red">{err}</p>}
    </div>
  );
}

function lifecycleTone(status: string) {
  if (status === "completed") return "t-green";
  if (status === "active" || status === "scheduled") return "t-blue";
  if (status === "needs_attention") return "t-red";
  if (status === "needs_approval") return "t-amber";
  if (status === "building") return "t-brand";
  return "t-grey";
}

function deliveryStateLabel(state: string) {
  if (state === "delivered") return "Delivered";
  if (state === "accepted") return "Accepted";
  if (state === "sending") return "Sending";
  if (state === "failed") return "Failed";
  return "Ready to send";
}

function dateRange(start: string | null, end: string | null) {
  if (!start || !end) return "";
  const fmt = (value: string) => new Date(value).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}
