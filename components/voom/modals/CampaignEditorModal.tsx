"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import type { CampaignDeliveryState, CampaignDeliveryView, CampaignRecord, CampaignStatus } from "@/lib/voom/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, Tag, Textarea } from "../ui/primitives";

export function CampaignEditorModal({ kind, campaign }: { kind: "email" | "sms"; campaign?: CampaignRecord | null }) {
  const { close } = useModal();
  const em = kind === "email";
  const [id, setId] = useState<string | null>(campaign?.id ?? null);
  const [name, setName] = useState(campaign?.name ?? (em ? "Untitled email" : "Untitled SMS"));
  const [objective, setObjective] = useState(campaign?.objective ?? "");
  const [audience, setAudience] = useState(campaign?.audience ?? "");
  const [subject, setSubject] = useState(campaign?.subject ?? "");
  const [previewText, setPreviewText] = useState(campaign?.preview_text ?? "");
  const [content, setContent] = useState(campaign?.content ?? "");
  const [sendDate, setSendDate] = useState(campaign?.proposed_send_at ? toDateInput(campaign.proposed_send_at) : "");
  const [sendTime, setSendTime] = useState(campaign?.proposed_send_at ? toTimeInput(campaign.proposed_send_at) : "");
  const [status, setStatus] = useState<CampaignStatus>(campaign?.status ?? "draft");
  const [busy, setBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recipientContact, setRecipientContact] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [delivery, setDelivery] = useState<CampaignDeliveryView | null>(null);

  const smsLength = content.length;

  const loadDelivery = useCallback(async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}/delivery`, { cache: "no-store" });
      const data = await response.json() as { delivery?: CampaignDeliveryView; error?: string };
      if (!response.ok || !data.delivery) return;
      setDelivery(data.delivery);
      setRecipientContact(data.delivery.recipient?.contact ?? "");
      setRecipientName(data.delivery.recipient?.contact_name ?? "");
    } catch {
      setDelivery(null);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}/delivery`, { cache: "no-store" });
        const data = await response.json() as { delivery?: CampaignDeliveryView };
        if (cancelled || !response.ok || !data.delivery) return;
        setDelivery(data.delivery);
        setRecipientContact(data.delivery.recipient?.contact ?? "");
        setRecipientName(data.delivery.recipient?.contact_name ?? "");
      } catch {
        if (!cancelled) setDelivery(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  function payload() {
    return {
      name: name.trim() || (em ? "Untitled email" : "Untitled SMS"),
      objective: objective.trim(),
      audience: audience.trim(),
      subject: em ? subject.trim() || null : null,
      previewText: em ? previewText.trim() || null : null,
      content: content.trim(),
      proposedSendAt: composeSendAt(sendDate, sendTime),
    };
  }

  async function saveDraft() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // The campaign kind is fixed at creation. PATCH only edits draft content,
      // so it must not send kind (PATCH rejects unknown keys); POST still needs it.
      const body = id ? payload() : { kind, ...payload() };
      const headers = { "Content-Type": "application/json" };
      const response = id
        ? await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(body) })
        : await fetch("/api/voom/campaigns", { method: "POST", headers, body: JSON.stringify(body) });
      const data = await response.json() as { campaign?: CampaignRecord; error?: string };
      if (!response.ok || !data.campaign) {
        setError(data.error ?? "Voom couldn't save that draft. Please retry.");
        return;
      }
      setId(data.campaign.id);
      setStatus(data.campaign.status);
      if (data.campaign.status !== "approved") {
        setDelivery(null);
      } else {
        await loadDelivery();
      }
      setMessage("Draft saved in Voom. Nothing has been sent.");
      window.dispatchEvent(new Event("voom:data-changed"));
    } catch {
      setError("Voom couldn't save that draft. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function markStatus(action: "approve" | "reject") {
    if (!id) {
      setError("Save the draft before approving or rejecting it.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json() as { campaign?: CampaignRecord; message?: string; error?: string };
      if (!response.ok || !data.campaign) {
        setError(data.error ?? "Voom couldn't update that campaign. Please retry.");
        return;
      }
      setStatus(data.campaign.status);
      setMessage(data.message ?? (action === "approve" ? "Campaign approved. Nothing has been sent." : "Campaign marked not approved."));
      window.dispatchEvent(new Event("voom:data-changed"));
      await loadDelivery();
    } catch {
      setError("Voom couldn't update that campaign. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function sendApprovedCampaign() {
    if (!id) {
      setError("Save and approve the campaign before sending it.");
      return;
    }
    setSendBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}/delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: recipientContact, contactName: recipientName }),
      });
      const data = await response.json() as { delivery?: CampaignDeliveryView; message?: string; error?: string };
      if (data.delivery) setDelivery(data.delivery);
      if (!response.ok) {
        setError(data.error ?? "Voom couldn't send that campaign safely.");
        return;
      }
      setMessage(data.message ?? `${em ? "Email" : "SMS"} accepted by the provider.`);
      window.dispatchEvent(new Event("voom:data-changed"));
      await loadDelivery();
    } catch {
      setError("Voom couldn't send that campaign safely. Nothing was simulated.");
    } finally {
      setSendBusy(false);
    }
  }

  const deliveryState = delivery?.state ?? (status === "approved" ? "ready" : null);

  return (
    <ModalShell wide>
      <ModalHead
        title={em ? "Email campaign" : "SMS campaign"}
        sub={id ? "Saved in Voom · refresh-safe" : "New draft — saved in Voom"}
        onClose={close}
      />
      <ModalBody>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Tag tone={statusTone(status)}>{statusLabel(status)}</Tag>
          {status === "approved" && deliveryState && (
            <Tag tone={deliveryTone(deliveryState)}>
              <Icon name="send" size={12} /> {deliveryLabel(deliveryState)}
            </Tag>
          )}
        </div>

        {message && <div role="status" className="mb-3.5 rounded-xl border border-green/35 bg-green/10 px-3.5 py-2.5 text-sm text-green">{message}</div>}
        {error && <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

        <Field label="Campaign name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder={em ? "e.g. Tuesday newsletter" : "e.g. Restock heads-up"} />
        </Field>
        <Field label={em ? "Objective" : "Purpose"} hint="Why Voom prepared this for you.">
          <Textarea rows={2} maxLength={1000} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder={em ? "Re-engage cold subscribers before the weekend." : "Tell regulars about the restock in one short message."} />
        </Field>
        <Field label="Audience">
          <Input value={audience} onChange={(e) => setAudience(e.target.value)} maxLength={1000} placeholder="e.g. All subscribers · segment not connected" />
        </Field>

        {em ? (
          <>
            <Field label="Subject line">
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} placeholder="What shows up in the inbox" />
            </Field>
            <Field label="Preview text">
              <Input value={previewText} onChange={(e) => setPreviewText(e.target.value)} maxLength={500} placeholder="The line under the subject" />
            </Field>
            <Field label="Body / content">
              <Textarea rows={7} maxLength={12000} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Write the email content here, or review what MARA's weekly plan prepared." />
            </Field>
          </>
        ) : (
          <Field label="Message" hint={`${smsLength} characters · ${Math.max(1, Math.ceil(Math.max(1, smsLength) / 160))} SMS segment${Math.ceil(Math.max(1, smsLength) / 160) === 1 ? "" : "s"} (cost depends on the connected provider)`}>
            <Textarea rows={6} maxLength={12000} value={content} onChange={(e) => setContent(e.target.value)} placeholder="One short, useful message." />
          </Field>
        )}

        <div className="flex flex-wrap gap-2.5">
          <div className="min-w-[180px] flex-1">
            <Field label="Proposed date">
              <Input type="date" value={sendDate} onChange={(e) => setSendDate(e.target.value)} />
            </Field>
          </div>
          <div className="min-w-[150px] flex-1">
            <Field label="Proposed time">
              <Input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} />
            </Field>
          </div>
        </div>

        {status === "approved" && (
          <Card className="mb-3.5 border-line-2 bg-surface-2 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone={deliveryState ? deliveryTone(deliveryState) : "t-grey"}>{deliveryState ? deliveryLabel(deliveryState) : "Ready"}</Tag>
              <Tag tone={delivery?.provider.configured ? "t-green" : "t-amber"}>{delivery?.provider.label ?? (em ? "Resend" : "Twilio")}</Tag>
            </div>
            <p className="mt-2 text-[13px] leading-[1.55] text-text-2">
              {delivery?.note ?? "This approved campaign can send to one real recipient when the provider is configured."}
            </p>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <Field label={em ? "Recipient email" : "Recipient phone number"} hint={em ? "One recipient for this MVP." : "Use E.164 format like +971501234567. One recipient for this MVP."}>
                <Input value={recipientContact} onChange={(e) => setRecipientContact(e.target.value)} placeholder={em ? "customer@example.com" : "+971501234567"} />
              </Field>
              <Field label="Recipient name (optional)">
                <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} maxLength={200} placeholder="e.g. Sara" />
              </Field>
            </div>
            {delivery?.send?.provider_message_id ? (
              <p className="mt-2 text-xs text-text-3">Provider message ID: {delivery.send.provider_message_id}</p>
            ) : null}
            {delivery?.send?.last_error_message ? (
              <p className="mt-2 text-xs text-red">Last provider error: {delivery.send.last_error_message}</p>
            ) : null}
          </Card>
        )}

        <Card className="border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="mt-0.5 flex-none text-amber" />
            <p className="text-[13px] leading-[1.55] text-text-2">
              Saving and approving stay inside Voom. Only the explicit Send action can contact a real recipient.
              Voom will never mark it <b>Delivered</b> until a verified provider callback confirms real delivery.
            </p>
          </div>
        </Card>
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <div className="flex flex-wrap gap-2.5">
          {status === "approved" ? (
            <Btn
              variant="outline"
              disabled={busy || sendBusy || !id || !recipientContact.trim() || !delivery?.canSend}
              onClick={() => void sendApprovedCampaign()}
              title={!delivery?.provider.configured ? `${delivery?.provider.label ?? (em ? "Resend" : "Twilio")} is not configured on the server yet` : undefined}
            >
              <Icon name="send" size={14} /> {sendBusy ? "Sending…" : delivery?.send?.internal_status === "failed" ? `Retry ${em ? "email" : "SMS"}` : `Send approved ${em ? "email" : "SMS"}`}
            </Btn>
          ) : (
            <Btn variant="outline" disabled={busy} onClick={() => void markStatus("approve")}>
              Approve for send
            </Btn>
          )}
          <Btn variant="primary" disabled={busy || sendBusy} onClick={() => void saveDraft()}>
            <Icon name="edit" size={14} /> {busy ? "Saving…" : "Save draft"}
          </Btn>
        </div>
      </ModalFoot>
    </ModalShell>
  );
}

function statusTone(status: CampaignStatus) {
  return status === "approved" ? "t-green" : status === "rejected" ? "t-red" : "t-grey";
}

function statusLabel(status: CampaignStatus) {
  if (status === "approved") return "Approved — ready to send";
  if (status === "rejected") return "Not approved";
  return "Draft";
}

function deliveryTone(status: CampaignDeliveryState) {
  return status === "delivered" ? "t-green" : status === "accepted" ? "t-blue" : status === "failed" ? "t-red" : status === "sending" ? "t-amber" : "t-grey";
}

function deliveryLabel(status: CampaignDeliveryState) {
  if (status === "delivered") return "Delivered";
  if (status === "accepted") return "Accepted by provider";
  if (status === "failed") return "Failed";
  if (status === "sending") return "Sending";
  return "Ready";
}

function toDateInput(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInput(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function composeSendAt(date: string, time: string): string | null {
  if (!date) return null;
  const value = new Date(time ? `${date}T${time}` : `${date}T00:00`);
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}
