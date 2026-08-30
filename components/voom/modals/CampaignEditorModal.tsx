"use client";

import { useState } from "react";
import { useModal } from "@/lib/voom/modal";
import type { CampaignRecord, CampaignStatus } from "@/lib/voom/types";
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
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const smsLength = content.length;

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
      const body = payload();
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
      setStatus("draft");
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
    } catch {
      setError("Voom couldn't update that campaign. Please retry.");
    } finally {
      setBusy(false);
    }
  }

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
          {status === "approved" && (
            <Tag tone="t-blue">
              <Icon name="info" size={12} /> Ready to send — provider connection required
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
          <Field label="Message" hint={`${smsLength} characters · ${Math.max(1, Math.ceil(smsLength / 160))} SMS segment${Math.ceil(smsLength / 160) === 1 ? "" : "s"} (cost depends on the connected provider)`}>
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

        <Card className="border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="mt-0.5 flex-none text-amber" />
            <p className="text-[13px] leading-[1.55] text-text-2">
              No {em ? "email" : "SMS"} provider is connected. Saving and approving here only prepares the campaign inside Voom.
              Voom will never mark it <b>Sent</b> until a provider confirms real delivery. Nothing leaves Voom.
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
            <Btn variant="outline" disabled title="A sending provider must be connected before anything can be sent">
              <Icon name="send" size={14} /> Ready to send — provider required
            </Btn>
          ) : (
            <Btn variant="outline" disabled={busy} onClick={() => void markStatus("approve")}>
              Approve for send
            </Btn>
          )}
          <Btn variant="primary" disabled={busy} onClick={() => void saveDraft()}>
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
  if (status === "approved") return "Approved — ready for provider";
  if (status === "rejected") return "Not approved";
  return "Draft";
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
